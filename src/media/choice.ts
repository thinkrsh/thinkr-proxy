// The shape and the length that a request picks for an image or a video (the owner, 25 Oct 2026),
// checked against the options of the model in config/models.ts; for an image the size, the photos,
// the seed, and the background of the Image page, checked against config/imageTools.ts; and for a
// video the resolution, the sound, and the last frame of the Video page, checked against
// config/videoTools.ts. A request that picks none gets the defaults of the catalog.
import type { ImageSize, ImageTools } from '../config/imageTools.js';
import { MESSAGES } from '../config/messages.js';
import type { ImageSettings, VideoSettings } from '../config/models.js';
import type { VideoSize, VideoTools } from '../config/videoTools.js';
import { ProxyError } from '../lib/errors.js';

/** What a request may pick; a length counts for a video only. */
export interface MediaChoice {
  readonly aspectRatio?: string | undefined;
  readonly seconds?: number | undefined;
}

/** What a request of an image may pick beyond its shape (the owner, 25 Oct 2026). */
export interface ImagePicks extends MediaChoice {
  readonly resolution?: string | undefined;
  readonly seed?: number | undefined;
  readonly transparent?: boolean | undefined;
  /** How many photos the request sends. */
  readonly photoCount: number;
}

/** What the proxy asks of the provider for one image, beyond its prompt, shape, and photos. */
export interface ImageOptions {
  /** The size to name; null leaves the size of the provider, which is the default of the model. */
  readonly resolution: string | null;
  readonly seed: number | null;
  /** A transparent background, with the format to ask for it in, or null for none. */
  readonly transparent: { readonly format: 'png' | null } | null;
}

/** One image as its request picked it. */
export interface ChosenImage {
  /** The settings at the shape picked, with the cost of the size and the photos, about. */
  readonly settings: ImageSettings;
  readonly options: ImageOptions;
  /** The picks cost more than the defaults of the model, which the free trial does not pay. */
  readonly creditOnly: boolean;
}

/** One image at the shape, the size, and the other tools that the request picked, or throws. */
export function chosenImage(
  settings: ImageSettings,
  tools: ImageTools,
  picks: ImagePicks,
): ChosenImage {
  if (picks.photoCount > tools.maxPhotos) {
    throw new ProxyError('invalid_request', MESSAGES.tooManyPhotos);
  }
  if (picks.photoCount < tools.minPhotos) {
    throw new ProxyError('invalid_request', MESSAGES.tooFewPhotos);
  }
  if (picks.seed !== undefined && !tools.seed) {
    throw new ProxyError('invalid_request', MESSAGES.seedUnavailable);
  }
  if (picks.transparent === true && !tools.transparent) {
    throw new ProxyError('invalid_request', MESSAGES.transparentUnavailable);
  }
  const size = chosenSize(tools, picks.resolution);
  const sizeCostUsd = size?.costUsd ?? settings.costUsd;
  return {
    settings: {
      ...settings,
      aspectRatio: chosenShape(settings, picks.aspectRatio),
      costUsd: sizeCostUsd + picks.photoCount * tools.photoCostUsd,
    },
    options: {
      resolution: size === null || size.resolution === tools.defaultSize ? null : size.resolution,
      seed: picks.seed ?? null,
      transparent: picks.transparent === true ? { format: tools.transparentFormat } : null,
    },
    creditOnly: sizeCostUsd > settings.costUsd || picks.photoCount > 1,
  };
}

/** What a request of a video may pick beyond its shape and its length (the owner, 25 Oct 2026). */
export interface VideoPicks extends MediaChoice {
  readonly resolution?: string | undefined;
  readonly silent?: boolean | undefined;
  /** The request sends a last frame. */
  readonly lastFrame: boolean;
}

/**
 * The settings of one video at the shape, the length, the resolution, and the sound that the
 * request picked, with its cost, or throws.
 */
export function chosenVideo(
  settings: VideoSettings,
  tools: VideoTools,
  picks: VideoPicks,
): VideoSettings {
  const seconds = picks.seconds ?? settings.seconds;
  if (!settings.durations.includes(seconds)) {
    throw new ProxyError('invalid_request', MESSAGES.lengthUnavailable);
  }
  if (picks.silent === true && !tools.silent) {
    throw new ProxyError('invalid_request', MESSAGES.silentUnavailable);
  }
  if (picks.lastFrame && !tools.lastFrame) {
    throw new ProxyError('invalid_request', MESSAGES.lastFrameUnavailable);
  }
  const silent = picks.silent === true;
  const size = chosenVideoSize(settings, tools, picks.resolution);
  return {
    ...settings,
    aspectRatio: chosenShape(settings, picks.aspectRatio),
    seconds,
    resolution: size?.resolution ?? settings.resolution,
    audio: settings.audio && !silent,
    costUsd: videoCostUsd(settings, size, { seconds, silent }),
  };
}

/**
 * What a video costs at the provider, about: each second at the price of its resolution, with sound
 * or without; a model with no sizes costs the same for each second as its estimate in the catalog.
 */
export function videoCostUsd(
  settings: Pick<VideoSettings, 'costUsd' | 'seconds'>,
  size: VideoSize | null,
  picks: { readonly seconds: number; readonly silent: boolean },
): number {
  if (size === null) return (settings.costUsd / settings.seconds) * picks.seconds;
  return secondCostUsd(size, picks.silent) * picks.seconds;
}

/** One second of video at a resolution, with sound or without. */
export function secondCostUsd(size: VideoSize, silent: boolean): number {
  return silent ? (size.silentSecondUsd ?? size.secondUsd) : size.secondUsd;
}

/** The resolution of the catalog among the sizes of a model; null for a model with no sizes. */
export function defaultVideoSize(
  settings: Pick<VideoSettings, 'resolution'>,
  tools: VideoTools,
): VideoSize | null {
  return tools.sizes.find((size) => size.resolution === settings.resolution) ?? null;
}

function chosenShape(
  settings: Pick<ImageSettings, 'aspectRatio' | 'aspectRatios'>,
  picked: string | undefined,
): string {
  const shape = picked ?? settings.aspectRatio;
  if (!settings.aspectRatios.includes(shape)) {
    throw new ProxyError('invalid_request', MESSAGES.shapeUnavailable);
  }
  return shape;
}

/** The resolution that the request named, or that of the catalog, among the sizes of the model. */
function chosenVideoSize(
  settings: VideoSettings,
  tools: VideoTools,
  resolution: string | undefined,
): VideoSize | null {
  if (tools.sizes.length === 0) {
    if (resolution !== undefined && resolution !== settings.resolution) {
      throw new ProxyError('invalid_request', MESSAGES.sizeUnavailable);
    }
    return null;
  }
  const wanted = resolution ?? settings.resolution;
  const size = tools.sizes.find((option) => option.resolution === wanted);
  if (size === undefined) throw new ProxyError('invalid_request', MESSAGES.sizeUnavailable);
  return size;
}

/** The size that the request named, one of the model's, or null when it named none. */
function chosenSize(tools: ImageTools, resolution: string | undefined): ImageSize | null {
  if (resolution === undefined) return null;
  const size = tools.sizes.find((option) => option.resolution === resolution);
  if (size === undefined) throw new ProxyError('invalid_request', MESSAGES.sizeUnavailable);
  return size;
}
