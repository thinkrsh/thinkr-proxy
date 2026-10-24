// The encrypted backups of the app: the sync protocol of apps/sync (its README, "The sync protocol").
// GET /api/sync/<store ID> gives a backup, PUT keeps one, DELETE removes it. The bodies hold
// ciphertext only; the proxy checks the shape of a backup, its write token, and its tag, and answers
// with bare statuses, as the client of apps/sync reads them. The log shows no store ID (lib/log.ts).
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import { LIMITS } from '../config/limits.js';
import { SYNC } from '../config/sync.js';
import { sha256, toHex } from '../lib/bytes.js';
import { createFixedWindowLimiter } from '../lib/rate-limit.js';
import type { SyncStore } from '../sync/store.js';

export interface SyncRouteDeps {
  readonly now: () => number;
  readonly clientKey: (c: Context) => string;
  readonly syncStore: SyncStore;
}

const STATUS = {
  ok: 200,
  created: 201,
  noContent: 204,
  notModified: 304,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  preconditionFailed: 412,
  payloadTooLarge: 413,
  preconditionRequired: 428,
  tooManyRequests: 429,
} as const;

/** A key that a passkey wrapped, readable in each backup. Must match apps/sync/src/wrap.ts. */
const wrappedKeySchema = z.object({
  v: z.literal(SYNC.formatVersion),
  kind: z.literal('passkey'),
  credentialId: z.string().min(1),
  prfSalt: z.string().min(1),
  nonce: z.string().min(1),
  ciphertext: z.string().min(1),
});

/** The envelope of a backup. Must match parseBackup of apps/sync/src/backup.ts. */
const backupSchema = z.object({
  v: z.literal(SYNC.formatVersion),
  format: z.literal(SYNC.formatName),
  keys: z.array(wrappedKeySchema),
  nonce: z.string(),
  ciphertext: z.string(),
});

export function createSyncRoute(deps: SyncRouteDeps): Hono {
  const store = deps.syncStore;
  const requests = createFixedWindowLimiter({
    limit: SYNC.requestsPerWindow,
    windowMs: SYNC.rateWindowMs,
    sweepThreshold: LIMITS.rateSweepThreshold,
  });
  const newBackups = createFixedWindowLimiter({
    limit: SYNC.newBackupsPerWindow,
    windowMs: SYNC.newBackupWindowMs,
    sweepThreshold: LIMITS.rateSweepThreshold,
  });

  /** Every request names a store ID, and counts against the limit of its client address. */
  const guard: MiddlewareHandler = async (c, next) => {
    if (!SYNC.storeIdPattern.test(c.req.param('storeId') ?? '')) {
      return c.body(null, STATUS.notFound);
    }
    if (!requests.take(deps.clientKey(c), deps.now())) {
      return c.body(null, STATUS.tooManyRequests);
    }
    await next();
    return undefined;
  };

  return new Hono()
    .basePath(SYNC.path)
    .use('/:storeId', guard)
    .get('/:storeId', (c) => {
      const storeId = c.req.param('storeId');
      const head = store.head(storeId);
      if (head === undefined) return c.body(null, STATUS.notFound);
      if (sameTag(c.req.header('If-None-Match'), head.etag)) {
        return c.body(null, STATUS.notModified, { ETag: head.etag });
      }
      const body = store.body(storeId);
      if (body === undefined) return c.body(null, STATUS.notFound);
      return c.body(body, STATUS.ok, { 'Content-Type': 'application/json', ETag: head.etag });
    })
    .put(
      '/:storeId',
      bodyLimit({
        maxSize: SYNC.maxBackupBytes,
        onError: (c) => c.body(null, STATUS.payloadTooLarge),
      }),
      async (c) => {
        const storeId = c.req.param('storeId');
        const tokenHash = await writeTokenHash(c);
        if (tokenHash === undefined) return c.body(null, STATUS.unauthorized);
        const raw = new Uint8Array(await c.req.arrayBuffer());
        const body = new TextDecoder().decode(raw);
        if (!isBackup(body)) return c.body(null, STATUS.badRequest);
        const current = store.head(storeId);
        if (current !== undefined && !sameHash(current.tokenHash, tokenHash)) {
          return c.body(null, STATUS.forbidden);
        }
        const expected = c.req.header('If-Match');
        const createOnly = c.req.header('If-None-Match') === '*';
        if (current !== undefined && expected === undefined) {
          return c.body(null, createOnly ? STATUS.preconditionFailed : STATUS.preconditionRequired);
        }
        if (current === undefined ? expected !== undefined : !sameTag(expected, current.etag)) {
          return c.body(null, STATUS.preconditionFailed);
        }
        if (store.totalBytes() - (current?.bytes ?? 0) + raw.length > SYNC.maxTotalBytes) {
          return c.body(null, STATUS.payloadTooLarge);
        }
        if (current === undefined && !newBackups.take(deps.clientKey(c), deps.now())) {
          return c.body(null, STATUS.tooManyRequests);
        }
        const etag = `"${toHex(await sha256(raw))}"`;
        const backup = { etag, tokenHash, bytes: raw.length, body };
        // The write names the stored tag, so a backup that changed since the check is not lost.
        if (!store.putIf(storeId, backup, current?.etag)) {
          return c.body(null, STATUS.preconditionFailed);
        }
        return c.body(null, current === undefined ? STATUS.created : STATUS.ok, { ETag: etag });
      },
    )
    .delete('/:storeId', async (c) => {
      const storeId = c.req.param('storeId');
      const tokenHash = await writeTokenHash(c);
      if (tokenHash === undefined) return c.body(null, STATUS.unauthorized);
      const current = store.head(storeId);
      if (current === undefined) return c.body(null, STATUS.notFound);
      if (!sameHash(current.tokenHash, tokenHash)) return c.body(null, STATUS.forbidden);
      store.delete(storeId);
      return c.body(null, STATUS.noContent);
    });
}

/** The SHA-256 of the bearer token as hex, or undefined when the request carries none of its shape. */
async function writeTokenHash(c: Context): Promise<string | undefined> {
  const token = /^Bearer (\S+)$/.exec(c.req.header('Authorization') ?? '')?.[1];
  if (token === undefined || !SYNC.writeTokenPattern.test(token)) return undefined;
  return toHex(await sha256(new TextEncoder().encode(token)));
}

/**
 * Whether a tag that a device sends names the stored backup. Cloudflare and Caddy may change the tag
 * of an answer they compress, to W/"<hash>" or "<hash>-zstd", so only the hash inside counts.
 */
function sameTag(sent: string | undefined, stored: string): boolean {
  const hash = (tag: string): string | undefined => /[0-9a-f]{64}/.exec(tag)?.[0];
  const sentHash = sent === undefined ? undefined : hash(sent);
  return sentHash !== undefined && sentHash === hash(stored);
}

/** Compares two hashes in time that does not depend on where they differ. */
function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function isBackup(body: string): boolean {
  try {
    return backupSchema.safeParse(JSON.parse(body)).success;
  } catch {
    // Text that is not JSON is no backup; the caller answers 400.
    return false;
  }
}
