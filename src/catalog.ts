// Queries over the model catalog of config/models.ts.
import type { Access } from './access/access.js';
import { CREDIT } from './config/credit.js';
import {
  DEFAULT_MODEL_ID,
  MODEL_CATALOG,
  type CatalogModel,
  type MediaSettings,
  type VideoSettings,
} from './config/models.js';
import { TRIAL } from './config/trial.js';
import type {
  Lane,
  ListedModel,
  MediaInfo,
  ModelKind,
  ModelsResponse,
  PrivacyLevel,
} from './contract.js';
import { mediaPriceUsd, userPricing } from './credit/balance.js';
import { tokensUsd } from './lib/cost.js';
import { videoCostUsd } from './media/choice.js';

const PRIVACY_BY_LANE: Readonly<Record<Lane, readonly PrivacyLevel[]>> = {
  open: ['open', 'open-no-retention'],
  private: ['private-verified', 'local'],
};

/** What an app that names no kinds gets: one from before images and video reads text models only. */
export const TEXT_ONLY: ReadonlySet<ModelKind> = new Set(['text']);

/**
 * The catalog as a visitor sees it: in the free trial, models outside it are locked for credit.
 * Each model carries the price that the user pays, never its cost at the provider. Only the kinds
 * that the app asks for are listed.
 */
export function modelsResponse(
  access: Pick<Access, 'opens'>,
  kinds: ReadonlySet<ModelKind> = TEXT_ONLY,
): ModelsResponse {
  return {
    defaultModelId: DEFAULT_MODEL_ID,
    models: MODEL_CATALOG.filter((model) => kinds.has(model.info.kind)).map((model) =>
      listedModel(model, access),
    ),
    extras: {
      webSearchUsd: CREDIT.webSearchUsd,
      documentUsd: CREDIT.documentUsd,
      voiceInputUsd: CREDIT.voiceInputUsd,
      voiceReplyUsd: CREDIT.voiceReplyUsd,
      privacyFilterUsd: CREDIT.privacyFilterUsd,
    },
  };
}

function listedModel(model: CatalogModel, access: Pick<Access, 'opens'>): ListedModel {
  const { info } = model;
  const lockReason = !info.available ? 'soon' : access.opens(info.id) ? null : 'credit';
  return {
    ...info,
    pricing: userPricing(model),
    media: mediaInfo(model.media),
    available: lockReason === null,
    lockReason,
  };
}

/**
 * One image or one video as the app shows it, at the price that the user pays, about, with the
 * shapes and the lengths that the user may pick, each length at its own price.
 */
function mediaInfo(media: MediaSettings | undefined): MediaInfo | null {
  if (media === undefined) return null;
  const priceUsd = mediaPriceUsd(media);
  const aspectRatios = [...media.aspectRatios];
  if (media.kind === 'image') {
    return {
      aspectRatio: media.aspectRatio,
      aspectRatios,
      durations: [],
      seconds: null,
      resolution: null,
      audio: false,
      priceUsd,
    };
  }
  const { aspectRatio, seconds, resolution, audio } = media;
  const durations = media.durations.map((length) => ({
    seconds: length,
    priceUsd: mediaPriceUsd({ costUsd: videoCostUsd(media, length) }),
  }));
  return { aspectRatio, aspectRatios, durations, seconds, resolution, audio, priceUsd };
}

export function findModel(id: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((model) => model.info.id === id);
}

/**
 * True for a model that costs more than the free trial allows (config/trial.ts, `dearest`): one
 * image, or one chat of the trial's fallback usage at the price that the user pays.
 */
export function isDearest(model: Pick<CatalogModel, 'cost' | 'price' | 'media'>): boolean {
  if (model.media !== undefined) return mediaPriceUsd(model.media) > TRIAL.dearest.imageUsd;
  const pricing = userPricing(model);
  return pricing !== null && tokensUsd(TRIAL.fallbackUsage, pricing) > TRIAL.dearest.chatUsd;
}

/** The models that the free trial opens: those of config/trial.ts but the dearest. */
export function trialModelIds(): string[] {
  return TRIAL.modelIds.filter((id) => {
    const model = findModel(id);
    return model !== undefined && !isDearest(model);
  });
}

/** The model of the private lane that a sealed request names in its model header. */
export function findTeeModel(teeModelId: string): CatalogModel | undefined {
  return MODEL_CATALOG.find(
    (model) => model.info.lane === 'private' && model.info.teeModelId === teeModelId,
  );
}

/** True when the proxy has a route to the model: OpenRouter for the open lane, a TEE for the private one. */
function hasUpstream({ info, openRouterSlug }: CatalogModel): boolean {
  return info.lane === 'private' ? info.teeModelId !== null : openRouterSlug !== null;
}

/** Lists every rule of the catalog that the given entries break. An empty list means valid. */
export function catalogProblems(
  catalog: readonly CatalogModel[],
  defaultModelId: string,
): string[] {
  const ids = catalog.map((model) => model.info.id);
  const teeIds = catalog.flatMap((model) => model.info.teeModelId ?? []);
  const problems = [
    ...catalog.flatMap(modelProblems),
    ...duplicates('ids', ids),
    ...duplicates('TEE model ids', teeIds),
  ];
  const fallback = catalog.find((model) => model.info.id === defaultModelId);
  if (fallback === undefined) {
    problems.push(`the default model ${defaultModelId} is not in the catalog`);
  } else if (!hasUpstream(fallback) || !fallback.info.available) {
    problems.push(`the default model ${defaultModelId} cannot be served`);
  }
  return problems;
}

function duplicates(label: string, values: readonly string[]): string[] {
  const repeated = values.filter((value, index) => values.indexOf(value) !== index);
  return repeated.length > 0 ? [`duplicate ${label}: ${repeated.join(', ')}`] : [];
}

function modelProblems(model: CatalogModel): string[] {
  const { info, openRouterSlug } = model;
  const problems: string[] = [];
  if (!info.id.startsWith(`${info.lane}/`)) {
    problems.push(`${info.id}: the id must start with its lane`);
  }
  if (!PRIVACY_BY_LANE[info.lane].includes(info.privacy)) {
    problems.push(`${info.id}: privacy ${info.privacy} does not fit the ${info.lane} lane`);
  }
  if (info.available && !hasUpstream(model)) {
    problems.push(`${info.id}: available but no upstream`);
  }
  if (info.lane === 'private' && openRouterSlug !== null) {
    problems.push(`${info.id}: the private lane never goes through OpenRouter`);
  }
  if (info.lane === 'open' && info.teeModelId !== null) {
    problems.push(`${info.id}: the open lane has no TEE model`);
  }
  return [...problems, ...mediaProblems(model)];
}

/**
 * An image or a video model names its settings of that kind, runs on the open lane (decision 70),
 * and a video model sits at the level Open: OpenRouter routes no video job under zero data
 * retention.
 */
function mediaProblems({ info, media }: CatalogModel): string[] {
  if (info.kind === 'text') {
    return media === undefined ? [] : [`${info.id}: a text model has no media settings`];
  }
  const problems: string[] = [];
  if (media?.kind !== info.kind) {
    problems.push(`${info.id}: its media settings must be ${info.kind}`);
  }
  if (info.lane !== 'open') problems.push(`${info.id}: images and video run on the open lane`);
  if (info.kind === 'video' && info.privacy !== 'open') {
    problems.push(`${info.id}: video has no zero data retention, so its level is Open`);
  }
  if (media?.kind === 'image' && media.api.name !== 'chat' && info.privacy !== 'open') {
    problems.push(`${info.id}: only a chat completion forces zero data retention on an image`);
  }
  if (media !== undefined && !media.aspectRatios.includes(media.aspectRatio)) {
    problems.push(`${info.id}: its shapes must hold its default shape`);
  }
  if (media?.kind === 'video') problems.push(...durationProblems(info.id, media));
  return problems;
}

/** A video offers its default length, and its lengths run from the shortest up. */
function durationProblems(id: string, media: VideoSettings): string[] {
  const { durations, seconds } = media;
  const problems: string[] = [];
  if (!durations.includes(seconds)) {
    problems.push(`${id}: its lengths must hold its default length`);
  }
  if (durations.some((length, index) => index > 0 && length <= (durations[index - 1] ?? 0))) {
    problems.push(`${id}: its lengths must run from the shortest up`);
  }
  return problems;
}

/** The free trial must open models that the proxy serves, the default among them. */
export function trialProblems(
  catalog: readonly CatalogModel[],
  defaultModelId: string,
  trialModelIds: readonly string[],
): string[] {
  const problems = trialModelIds.flatMap((id) => {
    const model = catalog.find((candidate) => candidate.info.id === id);
    return model?.info.available ? [] : [`trial model ${id} cannot be served`];
  });
  if (!trialModelIds.includes(defaultModelId)) {
    problems.push(`the default model ${defaultModelId} is not in the trial`);
  }
  return problems;
}

export function assertCatalogIsValid(): void {
  const problems = [
    ...catalogProblems(MODEL_CATALOG, DEFAULT_MODEL_ID),
    ...trialProblems(MODEL_CATALOG, DEFAULT_MODEL_ID, trialModelIds()),
  ];
  if (problems.length > 0) throw new Error(`Invalid model catalog: ${problems.join('; ')}.`);
}
