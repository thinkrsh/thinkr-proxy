// The proxy as a Hono app. It holds no Node-specific code, so a Worker entry can reuse it later.
import { Hono, type Context, type MiddlewareHandler } from 'hono';

import { createAccess } from './access/access.js';
import { createGate } from './access/gate.js';
import { createPassBudget } from './access/pass-budget.js';
import { assertCatalogIsValid } from './catalog.js';
import type { Env } from './config/env.js';
import { INFERENCE } from './config/inference.js';
import type { ErrorCode } from './contract.js';
import type { Ledger } from './credit/ledger.js';
import type { PassKeys } from './credit/pass.js';
import type { SyncStore } from './sync/store.js';
import type { NoteKeys } from './credit/note-key.js';
import { MESSAGES } from './config/messages.js';
import { SERVER } from './config/server.js';
import { SOURCED } from './config/sourcedTools.js';
import { LIMITS } from './config/limits.js';
import { ProxyError, errorBody } from './lib/errors.js';
import type { Forward } from './lib/forward.js';
import { formatRequestLog, type LogLine } from './lib/log.js';
import { createFixedWindowLimiter } from './lib/rate-limit.js';
import { createAccessRoute } from './routes/access.js';
import { createChatRoute } from './routes/chat.js';
import { createCreditRoute } from './routes/credit.js';
import { createHealthRoute } from './routes/health.js';
import { createInferenceRoute } from './routes/inference.js';
import { createMediaRoute } from './routes/media.js';
import { createModelsRoute } from './routes/models.js';
import { createPrivateRoute } from './routes/private.js';
import { createSyncRoute } from './routes/sync.js';

const UPSTREAM_CODES: ReadonlySet<ErrorCode> = new Set(['upstream_error', 'upstream_timeout']);

export interface AppDeps {
  readonly env: Env;
  readonly fetch: typeof fetch;
  /** Sends a sealed chat and keeps the trailers of its answer, where the enclave reports usage. */
  readonly forward: Forward;
  readonly now: () => number;
  /** The key of the visitor: a keyed hash of the address, so the proxy never holds the address. */
  readonly clientKey: (c: Context) => string;
  readonly log: LogLine;
  /** Notes spent, balances, and video jobs settled. */
  readonly ledger: Ledger;
  /** Check the blind notes of credit: the public keys of the issuer (apps/issuer/). */
  readonly noteKeys: NoteKeys;
  /** Check the passes of the free chats of a holder: public keys of the issuer, one for each month. */
  readonly passKeys: PassKeys;
  /** The secret that seals the tickets of video jobs. */
  readonly ticketKey: Uint8Array;
  /** The encrypted backups of the app, which the proxy cannot read. */
  readonly syncStore: SyncStore;
}

export function createApp(deps: AppDeps): Hono {
  assertCatalogIsValid();
  const app = new Hono().basePath(SERVER.basePath);
  app.use(requestLog(deps), noStore);
  const access = createAccess(deps.env.accessMode, deps.log);
  const gate = createGate({
    access,
    ledger: deps.ledger,
    now: deps.now,
    passKeys: deps.passKeys,
    passBudget: createPassBudget(deps.log),
  });
  app.route('/', createHealthRoute());
  app.route('/', createModelsRoute({ access, gate }));
  app.route('/', createAccessRoute({ ...deps, access, gate }));
  // One limit for the chats of both lanes and the credit, counted per client address.
  const limiter = createFixedWindowLimiter({
    limit: LIMITS.chatRequestsPerWindow,
    windowMs: LIMITS.rateWindowMs,
    sweepThreshold: LIMITS.rateSweepThreshold,
  });
  app.route('/', createChatRoute({ ...deps, limiter, gate, apiKey: deps.env.openRouterApiKey }));
  app.route('/', createPrivateRoute({ ...deps, limiter, gate, apiKey: deps.env.tinfoilApiKey }));
  // Images and video (23 Oct 2026): a new one counts against the limit of chats; the checks of a
  // video job, which the app makes every few seconds while it renders, against a limit of their own.
  const checkLimiter = createFixedWindowLimiter({
    limit: LIMITS.videoChecksPerWindow,
    windowMs: LIMITS.rateWindowMs,
    sweepThreshold: LIMITS.rateSweepThreshold,
  });
  app.route(
    '/',
    createMediaRoute({
      ...deps,
      limiter,
      checkLimiter,
      gate,
      apiKey: deps.env.openRouterApiKey,
      publicOrigin: deps.env.publicOrigin,
    }),
  );
  app.route('/', createCreditRoute({ ...deps, limiter }));
  app.route('/', createSyncRoute(deps));
  // Inference (29 Oct 2026): the API of the private lane, with a limit of its own per client address.
  const inferenceLimiter = createFixedWindowLimiter({
    limit: INFERENCE.requestsPerWindow,
    windowMs: LIMITS.rateWindowMs,
    sweepThreshold: LIMITS.rateSweepThreshold,
  });
  app.route(
    '/',
    createInferenceRoute({
      ...deps,
      limiter: inferenceLimiter,
      gate,
      apiKey: deps.env.tinfoilApiKey,
    }),
  );
  app.notFound((c) => c.json(errorBody('invalid_request', MESSAGES.notFound), 404));
  app.onError((error, c) => {
    if (error instanceof ProxyError) {
      // The messages of the proxy hold no content of a chat, so a failed upstream can be logged.
      if (UPSTREAM_CODES.has(error.code)) deps.log(`Upstream failed: ${error.message}`);
      return c.json(errorBody(error.code, error.message), error.status);
    }
    deps.log(`Internal error: ${error.name}`);
    return c.json(errorBody('internal_error', MESSAGES.internal), 500);
  });
  return app;
}

function requestLog(deps: Pick<AppDeps, 'now' | 'log'>): MiddlewareHandler {
  return async (c, next) => {
    const startMs = deps.now();
    await next();
    const durationMs = deps.now() - startMs;
    const entry = {
      at: new Date(startMs),
      method: c.req.method,
      path: loggedPath(c.req.path),
      durationMs,
    };
    deps.log(formatRequestLog({ ...entry, status: c.res.status }));
  };
}

/** The path of a request as the log keeps it: never the name of a source, which opens its file. */
function loggedPath(path: string): string {
  const sources = `${SERVER.basePath}${SOURCED.sourcesPath}/`;
  return path.startsWith(sources) ? `${sources}*` : path;
}

const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.res.headers.set('Cache-Control', 'no-store');
};
