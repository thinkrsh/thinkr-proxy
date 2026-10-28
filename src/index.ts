// The Node entry of the proxy. Run it with the env files of secret/ and env/ (see package.json).
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

import { createApp } from './app.js';
import { readEnv } from './config/env.js';
import { MEDIA } from './config/media.js';
import { MESSAGES } from './config/messages.js';
import { SERVER } from './config/server.js';
import { SYNC } from './config/sync.js';
import { fromBase64Url } from './lib/bytes.js';
import { ProxyError } from './lib/errors.js';
import { writeLogLine } from './lib/log.js';
import { nodeForward } from './node/forward.js';
import { openLedger } from './node/ledger.js';
import { openSyncStore } from './node/sync-store.js';
import { noteKeysOf } from './credit/note-key.js';
import { holderKeysFromJson, noteKeyFromPublicPem } from './node/note-key.js';

const env = readEnv(process.env);
const noteKeys = noteKeysOf(
  noteKeyFromPublicPem(readFileSync(env.notePublicKeyFile, 'utf8')),
  holderKeysFromJson(readFileSync(env.holderPublicKeysFile, 'utf8')),
);
const ticketKey = readTicketKey(env.ticketKeyFile);
const ledger = openLedger(env.databaseFile);
const syncStore = openSyncStore(join(dirname(env.databaseFile), SYNC.databaseFileName));

/** The secret that seals the tickets of video jobs, from its file. Stops on a key of the wrong size. */
function readTicketKey(file: string): Uint8Array {
  const key = fromBase64Url(readFileSync(file, 'utf8').trim());
  if (key.length !== MEDIA.ticket.keyBytes) {
    throw new Error(
      `TICKET_KEY_FILE must hold ${String(MEDIA.ticket.keyBytes)} bytes in base64url.`,
    );
  }
  return key;
}

/** A secret of this process: the keys of visitors cannot be traced back to their addresses. */
const VISITOR_KEY_SECRET = randomBytes(SERVER.visitorKeySecretBytes);

/** The address of the visitor: from the header of Cloudflare in front, or from the socket. */
function clientAddress(c: Context): string {
  if (env.clientAddressHeader !== null) {
    const forwarded = c.req.header(env.clientAddressHeader);
    if (forwarded === undefined || forwarded === '') {
      throw new ProxyError('invalid_request', MESSAGES.noClientAddress);
    }
    return forwarded;
  }
  const address = getConnInfo(c).remote.address;
  if (address === undefined) throw new Error('The socket has no remote address.');
  return address;
}

function visitorKey(c: Context): string {
  return createHmac('sha256', VISITOR_KEY_SECRET).update(clientAddress(c)).digest('base64url');
}

const app = createApp({
  env,
  fetch: globalThis.fetch,
  forward: nodeForward,
  now: () => Date.now(),
  clientKey: visitorKey,
  log: writeLogLine,
  ledger,
  noteKeys,
  ticketKey,
  syncStore,
});

const server = serve({ fetch: app.fetch, hostname: SERVER.host, port: SERVER.port }, (info) => {
  writeLogLine(
    `Proxy listening on http://${info.address}:${String(info.port)}${SERVER.basePath}, ` +
      `access ${env.accessMode}, note key ${noteKeys.topUp.keyId}`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close();
  });
}
