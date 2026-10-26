// Queries over the model catalog of config/models.ts.
import type { Access } from './access/access.js';
import { AUDIO_TOOLS, type AudioTools } from './config/audioTools.js';
import { CREDIT } from './config/credit.js';
import { IMAGE_TOOLS, PHOTO_LIMIT, type ImageTools } from './config/imageTools.js';
import {
  DEFAULT_MODEL_ID,
  MODEL_CATALOG,
  type AudioSettings,
  type CatalogModel,
  type ImageSettings,
  type MediaSettings,
  type VideoSettings,
} from './config/models.js';
import { LIMITS } from './config/limits.js';
import { TRIAL } from './config/trial.js';
import { VIDEO_TOOLS, type VideoTools } from './config/videoTools.js';
import type {
  AudioInfo,
  Lane,
  ImageToolsInfo,
  ListedModel,
  MediaInfo,
  ModelKind,
  ModelsResponse,
  PrivacyLevel,
  VideoToolsInfo,
} from './contract.js';
import { mediaPriceUsd, userPricing } from './credit/balance.js';
import { tokensUsd } from './lib/cost.js';
import { defaultVideoSize, secondCostUsd, videoCostUsd } from './media/choice.js';

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
    media: mediaInfo(model.media, IMAGE_TOOLS[info.id], VIDEO_TOOLS[info.id]),
    audio: model.media?.kind === 'audio' ? audioInfo(model.media, findAudioTools(info.id)) : null,
    available: lockReason === null,
    lockReason,
  };
}

/**
 * One image or one video as the app shows it, at the price that the user pays, about, with the
 * shapes and the lengths that the user may pick, each length at its own price, and the tools of
 * an image model.
 */
function mediaInfo(
  media: MediaSettings | undefined,
  tools: ImageTools | undefined,
  videoTools: VideoTools | undefined,
): MediaInfo | null {
  if (media === undefined || media.kind === 'audio') return null;
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
      ...(tools === undefined ? {} : { tools: toolsInfo(tools) }),
    };
  }
  const { aspectRatio, seconds, resolution, audio } = media;
  const size = videoTools === undefined ? null : defaultVideoSize(media, videoTools);
  const durations = media.durations.map((length) => ({
    seconds: length,
    priceUsd: mediaPriceUsd({
      costUsd: videoCostUsd(media, size, { seconds: length, silent: false }),
    }),
  }));
  return {
    aspectRatio,
    aspectRatios,
    durations,
    seconds,
    resolution,
    audio,
    priceUsd: mediaPriceUsd({ costUsd: videoCostUsd(media, size, { seconds, silent: false }) }),
    ...(videoTools === undefined ? {} : { videoTools: videoToolsInfo(videoTools) }),
  };
}

/** A model of audio as the Audio page shows it, each unit at what the user pays, about. */
function audioInfo(media: AudioSettings, tools: AudioTools): AudioInfo {
  return {
    mode: media.mode,
    voices: tools.voices.map((voice) => ({ ...voice })),
    maxChars: tools.maxChars,
    price: { per: media.rate.per, usd: mediaPriceUsd({ costUsd: media.rate.usd }) },
  };
}

/** The tools of a video model as the app shows them, each second at what the user pays, about. */
function videoToolsInfo(tools: VideoTools): VideoToolsInfo {
  return {
    sizes: tools.sizes.map((size) => ({
      resolution: size.resolution,
      secondPriceUsd: mediaPriceUsd({ costUsd: secondCostUsd(size, false) }),
      silentSecondPriceUsd:
        size.silentSecondUsd === null ? null : mediaPriceUsd({ costUsd: size.silentSecondUsd }),
    })),
    silent: tools.silent,
    lastFrame: tools.lastFrame,
  };
}

/** The tools of an image model as the app shows them, each price at what the user pays, about. */
function toolsInfo(tools: ImageTools): ImageToolsInfo {
  return {
    sizes: tools.sizes.map(({ resolution, costUsd }) => ({
      resolution,
      priceUsd: mediaPriceUsd({ costUsd }),
    })),
    defaultSize: tools.defaultSize,
    minPhotos: tools.minPhotos,
    maxPhotos: tools.maxPhotos,
    photoPriceUsd: mediaPriceUsd({ costUsd: tools.photoCostUsd }),
    seed: tools.seed,
    transparent: tools.transparent,
  };
}

export function findModel(id: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((model) => model.info.id === id);
}

/** The tools of a video model of the catalog, which assertCatalogIsValid makes sure it has. */
export function findVideoTools(id: string): VideoTools {
  const tools = VIDEO_TOOLS[id];
  if (tools === undefined) throw new Error(`The video model ${id} has no video tools.`);
  return tools;
}

/** The tools of a model of audio of the catalog, which assertCatalogIsValid makes sure it has. */
export function findAudioTools(id: string): AudioTools {
  const tools = AUDIO_TOOLS[id];
  if (tools === undefined) throw new Error(`The audio model ${id} has no audio tools.`);
  return tools;
}

/** The tools of an image model of the catalog, which assertCatalogIsValid makes sure it has. */
export function findImageTools(id: string): ImageTools {
  const tools = IMAGE_TOOLS[id];
  if (tools === undefined) throw new Error(`The image model ${id} has no image tools.`);
  return tools;
}

/**
 * True for a model that costs more than the free trial allows (config/trial.ts, `dearest`): one
 * image or one request of audio, or one chat of the trial's fallback usage at the price that the
 * user pays.
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
 * An image, a video, or an audio model names its settings of that kind, runs on the open lane
 * (decision 70), and a video model sits at the level Open: OpenRouter routes no video job under
 * zero data retention.
 */
function mediaProblems({ info, media }: CatalogModel): string[] {
  if (info.kind === 'text') {
    return media === undefined ? [] : [`${info.id}: a text model has no media settings`];
  }
  const problems: string[] = [];
  if (media?.kind !== info.kind) {
    problems.push(`${info.id}: its media settings must be ${info.kind}`);
  }
  if (info.lane !== 'open') {
    problems.push(`${info.id}: images, video, and audio run on the open lane`);
  }
  if (info.kind === 'video' && info.privacy !== 'open') {
    problems.push(`${info.id}: video has no zero data retention, so its level is Open`);
  }
  if (media?.kind === 'image' && media.api.name !== 'chat' && info.privacy !== 'open') {
    problems.push(`${info.id}: only a chat completion forces zero data retention on an image`);
  }
  if (
    media !== undefined &&
    media.kind !== 'audio' &&
    !media.aspectRatios.includes(media.aspectRatio)
  ) {
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

/**
 * Every image model has its tools and nothing else has any; a model with sizes holds its default
 * size among them, at the cost that the catalog gives one image of it (25 Oct 2026).
 */
export function imageToolsProblems(
  catalog: readonly CatalogModel[],
  tools: Readonly<Record<string, ImageTools>>,
): string[] {
  const problems: string[] = [];
  const imageIds = new Set<string>();
  for (const model of catalog) {
    if (model.media?.kind !== 'image') continue;
    imageIds.add(model.info.id);
    problems.push(...toolProblems(model.info.id, model.media, tools[model.info.id]));
  }
  for (const id of Object.keys(tools)) {
    if (!imageIds.has(id)) problems.push(`${id}: image tools for a model that makes no images`);
  }
  return problems;
}

function toolProblems(id: string, media: ImageSettings, tools: ImageTools | undefined): string[] {
  if (tools === undefined) return [`${id}: an image model needs its image tools`];
  const problems: string[] = [];
  if (tools.minPhotos < 0 || tools.minPhotos > tools.maxPhotos || tools.maxPhotos > PHOTO_LIMIT) {
    problems.push(`${id}: its photos must run from 0 to ${String(PHOTO_LIMIT)}, the fewest first`);
  }
  if (tools.transparentFormat !== null && !tools.transparent) {
    problems.push(`${id}: a format for a transparent background needs one`);
  }
  if (tools.sizes.length === 0) {
    if (tools.defaultSize !== null) problems.push(`${id}: a default size needs sizes`);
    return problems;
  }
  const fallback = tools.sizes.find((size) => size.resolution === tools.defaultSize);
  if (fallback === undefined) {
    problems.push(`${id}: its sizes must hold its default size`);
  } else if (fallback.costUsd !== media.costUsd) {
    problems.push(`${id}: its default size must cost what the catalog gives one image`);
  }
  return problems;
}

/**
 * Every model of audio has its tools and nothing else has any; a voice of its own needs the speech
 * API, a model that charges by the second names its longest audio, and music comes as one piece
 * through a chat completion (26 Oct 2026).
 */
export function audioToolsProblems(
  catalog: readonly CatalogModel[],
  tools: Readonly<Record<string, AudioTools>>,
): string[] {
  const problems: string[] = [];
  const audioIds = new Set<string>();
  for (const model of catalog) {
    if (model.media?.kind !== 'audio') continue;
    audioIds.add(model.info.id);
    problems.push(...audioToolProblems(model.info.id, model.media, tools[model.info.id]));
  }
  for (const id of Object.keys(tools)) {
    if (!audioIds.has(id)) problems.push(`${id}: audio tools for a model that makes no audio`);
  }
  return problems;
}

function audioToolProblems(
  id: string,
  media: AudioSettings,
  tools: AudioTools | undefined,
): string[] {
  if (tools === undefined) return [`${id}: a model of audio needs its audio tools`];
  const problems: string[] = [];
  if (tools.maxChars <= 0 || tools.maxChars > LIMITS.maxPromptChars) {
    problems.push(`${id}: its longest text must fit the limit of a prompt`);
  }
  if (tools.voices.length > 0 && media.mode !== 'voice') {
    problems.push(`${id}: only a model of the mode voice has voices`);
  }
  if ((media.api === 'chat') !== (tools.format === null)) {
    problems.push(`${id}: the speech API names its format, a chat completion none`);
  }
  if ((media.api === 'chat') !== (media.rate.per === 'piece')) {
    problems.push(`${id}: music comes as one piece through a chat completion`);
  }
  if ((media.rate.per === 'second') !== (tools.maxSeconds !== null)) {
    problems.push(`${id}: a model that charges by the second names its longest audio`);
  }
  return problems;
}

/** How far the cost of the default size may stray from the estimate of the catalog, which rounds. */
const VIDEO_COST_TOLERANCE = 0.02;

/**
 * Every video model has its tools and nothing else has any; a model with sizes holds the resolution
 * of the catalog among them, at about the cost of the catalog, and only a model with sound may
 * leave it out (25 Oct 2026).
 */
export function videoToolsProblems(
  catalog: readonly CatalogModel[],
  tools: Readonly<Record<string, VideoTools>>,
): string[] {
  const problems: string[] = [];
  const videoIds = new Set<string>();
  for (const model of catalog) {
    if (model.media?.kind !== 'video') continue;
    videoIds.add(model.info.id);
    problems.push(...videoToolProblems(model.info.id, model.media, tools[model.info.id]));
  }
  for (const id of Object.keys(tools)) {
    if (!videoIds.has(id)) problems.push(`${id}: video tools for a model that makes no videos`);
  }
  return problems;
}

function videoToolProblems(
  id: string,
  media: VideoSettings,
  tools: VideoTools | undefined,
): string[] {
  if (tools === undefined) return [`${id}: a video model needs its video tools`];
  const problems: string[] = [];
  if (tools.silent && !media.audio) {
    problems.push(`${id}: a model without sound has none to leave out`);
  }
  if (tools.sizes.length === 0) return problems;
  const size = defaultVideoSize(media, tools);
  if (size === null) {
    problems.push(`${id}: its sizes must hold its resolution`);
    return problems;
  }
  const cost = videoCostUsd(media, size, { seconds: media.seconds, silent: false });
  if (Math.abs(cost - media.costUsd) > media.costUsd * VIDEO_COST_TOLERANCE) {
    problems.push(`${id}: its resolution must cost about what the catalog gives one video`);
  }
  return problems;
}

export function assertCatalogIsValid(): void {
  const problems = [
    ...catalogProblems(MODEL_CATALOG, DEFAULT_MODEL_ID),
    ...trialProblems(MODEL_CATALOG, DEFAULT_MODEL_ID, trialModelIds()),
    ...imageToolsProblems(MODEL_CATALOG, IMAGE_TOOLS),
    ...videoToolsProblems(MODEL_CATALOG, VIDEO_TOOLS),
    ...audioToolsProblems(MODEL_CATALOG, AUDIO_TOOLS),
  ];
  if (problems.length > 0) throw new Error(`Invalid model catalog: ${problems.join('; ')}.`);
}
