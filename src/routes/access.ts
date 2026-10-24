// GET /api/access: what the visitor may still do today, and the credit of the balance that the
// request names, so that the app can show the chats left or the credit.
import { Hono, type Context } from 'hono';

import type { Access } from '../access/access.js';
import type { Gate } from '../access/gate.js';
import type { AccessResponse } from '../contract.js';
import { microsToUsd } from '../credit/balance.js';

export interface AccessRouteDeps {
  readonly access: Access;
  readonly gate: Gate;
  readonly now: () => number;
  readonly clientKey: (c: Context) => string;
}

export function createAccessRoute(deps: AccessRouteDeps): Hono {
  return new Hono().get('/access', async (c) => {
    const balance = await deps.gate.balanceOf(c);
    const status = deps.access.status(deps.clientKey(c), deps.now());
    const credit = balance === null ? null : { usd: microsToUsd(balance.micros) };
    return c.json<AccessResponse>({ ...status, credit });
  });
}
