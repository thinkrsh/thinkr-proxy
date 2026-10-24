// GET /api/models: the catalog as this visitor sees it. A balance with credit opens every model
// that the proxy serves; without one, the free trial decides which models are open. The query
// `kinds` names the kinds of model that the app can show, such as `text,image,video`; an app that
// names none gets the models of text only.
import { Hono, type Context } from 'hono';

import type { Access } from '../access/access.js';
import type { Gate } from '../access/gate.js';
import { TEXT_ONLY, modelsResponse } from '../catalog.js';
import { MODEL_KINDS, type ModelKind, type ModelsResponse } from '../contract.js';
import { ProxyError } from '../lib/errors.js';

export interface ModelsRouteDeps {
  readonly access: Access;
  readonly gate: Gate;
}

const OPEN_TO_CREDIT: Pick<Access, 'opens'> = { opens: () => true };

/** The separator of the kinds in the query. */
const KIND_SEPARATOR = ',';

export function createModelsRoute(deps: ModelsRouteDeps): Hono {
  return new Hono().get('/models', async (c) => {
    const funded = await hasCredit(deps.gate, c);
    const kinds = kindsOf(c.req.query('kinds'));
    return c.json<ModelsResponse>(modelsResponse(funded ? OPEN_TO_CREDIT : deps.access, kinds));
  });
}

/** The kinds that the app asked for; a kind that this proxy does not know is left out. */
function kindsOf(query: string | undefined): ReadonlySet<ModelKind> {
  if (query === undefined || query === '') return TEXT_ONLY;
  const asked = new Set(query.split(KIND_SEPARATOR));
  return new Set(MODEL_KINDS.filter((kind) => asked.has(kind)));
}

/** An unknown balance only hides the models of credit here; GET /api/access reports it. */
async function hasCredit(gate: Gate, c: Context): Promise<boolean> {
  try {
    const balance = await gate.balanceOf(c);
    return balance !== null && balance.micros > 0;
  } catch (error) {
    if (error instanceof ProxyError && error.code === 'balance_unknown') return false;
    throw error;
  }
}
