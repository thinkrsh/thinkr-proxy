// The models of the API (GET /api/inference/v1/models): the models of text of the catalog with a
// price, by the id that a chat names. A model of the private lane goes by the name of its enclave,
// and a model of the open lane by its mode and its name, such as `zdr/claude-sonnet-5.5`.
import { findTeeModel } from '../catalog.js';
import { INFERENCE } from '../config/inference.js';
import { MODEL_CATALOG, type CatalogModel } from '../config/models.js';
import { userPricing } from '../credit/balance.js';
import type { InferenceMode, InferenceModel } from './contract.js';

/** The catalog id of a model of the open lane starts with this, which its API id replaces. */
const OPEN_LANE_ID_PREFIX = 'open/';

/** A model of ZDR or Open that a plain chat can name. */
export interface PlainModel {
  readonly model: CatalogModel;
  readonly slug: string;
  readonly id: string;
}

export function inferenceModeOf(model: Pick<CatalogModel, 'info'>): InferenceMode {
  const { lane, privacy } = model.info;
  if (lane === 'private') return 'private';
  return privacy === 'open' ? 'open' : 'zdr';
}

/** The id of a model in the API, or null for a model that the API does not serve. */
function inferenceIdOf(model: CatalogModel): string | null {
  const { info } = model;
  if (info.kind !== 'text' || !info.available || userPricing(model) === null) return null;
  const mode = inferenceModeOf(model);
  if (mode === 'private') return info.teeModelId;
  if (model.openRouterSlug === null) return null;
  return `${INFERENCE.modelPrefix[mode]}${info.id.slice(OPEN_LANE_ID_PREFIX.length)}`;
}

const SERVED: readonly { readonly model: CatalogModel; readonly id: string }[] =
  MODEL_CATALOG.flatMap((model) => {
    const id = inferenceIdOf(model);
    return id === null ? [] : [{ model, id }];
  });

const PLAIN_MODELS: ReadonlyMap<string, PlainModel> = new Map(
  SERVED.flatMap(({ model, id }) =>
    model.openRouterSlug === null ? [] : [[id, { model, slug: model.openRouterSlug, id }] as const],
  ),
);

/** The model of ZDR or Open that a plain chat names, or undefined. */
export function findPlainModel(id: string): PlainModel | undefined {
  return PLAIN_MODELS.get(id);
}

/** True for the id of a model of the private lane, which takes no plain chat. */
export function isPrivateModelId(id: string): boolean {
  return findTeeModel(id) !== undefined;
}

export function listInferenceModels(): InferenceModel[] {
  return SERVED.map(({ model, id }) => inferenceModel(model, id));
}

function inferenceModel(model: CatalogModel, id: string): InferenceModel {
  const { info } = model;
  const pricing = userPricing(model);
  return {
    id,
    mode: inferenceModeOf(model),
    object: 'model',
    owned_by: info.maker,
    name: info.name,
    context_length: info.contextTokens,
    pricing:
      pricing === null
        ? null
        : {
            input_usd_per_mtok: pricing.inputUsdPerMTok,
            output_usd_per_mtok: pricing.outputUsdPerMTok,
          },
    vision: info.vision,
    reasoning: info.reasoning,
  };
}
