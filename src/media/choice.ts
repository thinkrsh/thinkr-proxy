// The shape and the length that a request picks for an image or a video (the owner, 25 Oct 2026),
// checked against the options of the model in config/models.ts. A request that picks none gets
// the defaults of the catalog.
import { MESSAGES } from '../config/messages.js';
import type { ImageSettings, VideoSettings } from '../config/models.js';
import { ProxyError } from '../lib/errors.js';

/** What a request may pick; a length counts for a video only. */
export interface MediaChoice {
  readonly aspectRatio?: string | undefined;
  readonly seconds?: number | undefined;
}

/** The settings of one image at the shape that the request picked. */
export function chosenImage(settings: ImageSettings, choice: MediaChoice): ImageSettings {
  return { ...settings, aspectRatio: chosenShape(settings, choice.aspectRatio) };
}

/** The settings of one video at the shape and the length that the request picked, and its cost. */
export function chosenVideo(settings: VideoSettings, choice: MediaChoice): VideoSettings {
  const seconds = choice.seconds ?? settings.seconds;
  if (!settings.durations.includes(seconds)) {
    throw new ProxyError('invalid_request', MESSAGES.lengthUnavailable);
  }
  return {
    ...settings,
    aspectRatio: chosenShape(settings, choice.aspectRatio),
    seconds,
    costUsd: videoCostUsd(settings, seconds),
  };
}

/** What a video of `seconds` costs at the provider, about: the same for each second. */
export function videoCostUsd(
  settings: Pick<VideoSettings, 'costUsd' | 'seconds'>,
  seconds: number,
): number {
  return (settings.costUsd / settings.seconds) * seconds;
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
