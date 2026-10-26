// What the Video page may ask of each video model beyond its shape and its length (the owner, 25
// Oct 2026: the Video page with more tools). Read on 25 Oct 2026 from GET
// https://openrouter.ai/api/v1/videos/models: `supported_resolutions`, `supported_frame_images`,
// `generate_audio`, and `pricing_skus`.
// - Sizes: only for a model whose SKUs price each second at each resolution; the cost of a second
//   with sound, and without sound where a SKU names that price. A model priced by video tokens
//   (the Seedance family) gets no sizes, since tokens per second are not published, and keeps the
//   one resolution and the estimate of config/models.ts.
// - Sound: every model that makes sound may leave it out (`generate_audio: false`), at the price of
//   its silent SKU, else at the same price.
// - Last frame: the models whose `supported_frame_images` hold `last_frame`.
// The default size of each model is the resolution of config/models.ts.

/** One resolution that the user may pick, and what one second of video costs at it. */
export interface VideoSize {
  /** A resolution of OpenRouter, such as '720p' or '4K'. */
  readonly resolution: string;
  /** One second with sound when the model makes sound, else one silent second. */
  readonly secondUsd: number;
  /** One second without sound, when a SKU prices it apart; else null. */
  readonly silentSecondUsd: number | null;
}

export interface VideoTools {
  /** The sizes that the user may pick, smallest first; empty for the size of the catalog only. */
  readonly sizes: readonly VideoSize[];
  /** The model makes sound and can leave it out. */
  readonly silent: boolean;
  /** The model takes a last frame as well as a first one. */
  readonly lastFrame: boolean;
}

function size(
  resolution: string,
  secondUsd: number,
  silentSecondUsd: number | null = null,
): VideoSize {
  return { resolution, secondUsd, silentSecondUsd };
}

/** The tools of each video model of the catalog, by its id. */
export const VIDEO_TOOLS: Readonly<Record<string, VideoTools>> = {
  // duration_seconds_with_audio 0.40 and _4k 0.60; without audio 0.20 and _4k 0.40.
  'open/veo-3.1': {
    sizes: [size('720p', 0.4, 0.2), size('1080p', 0.4, 0.2), size('4K', 0.6, 0.4)],
    silent: true,
    lastFrame: true,
  },
  // with audio: _720p 0.10, 0.12, _4k 0.30; without: _720p 0.08, 0.10, _4k 0.25.
  'open/veo-3.1-fast': {
    sizes: [size('720p', 0.1, 0.08), size('1080p', 0.12, 0.1), size('4K', 0.3, 0.25)],
    silent: true,
    lastFrame: true,
  },
  // with audio: _720p 0.05, 0.08; without: _720p 0.03, 0.05.
  'open/veo-3.1-lite': {
    sizes: [size('720p', 0.05, 0.03), size('1080p', 0.08, 0.05)],
    silent: true,
    lastFrame: true,
  },
  // Video tokens; video_tokens_without_audio at the same price.
  'open/seedance-2.0': { sizes: [], silent: true, lastFrame: true },
  // 720p only: duration_seconds_with_audio 0.168, duration_seconds 0.112.
  'open/kling-3.0-pro': { sizes: [size('720p', 0.168, 0.112)], silent: true, lastFrame: true },
  // duration_seconds_480p 0.05, _720p 0.10, _1080p 0.20, sound included.
  'open/wan-3.0': {
    sizes: [size('480p', 0.05), size('720p', 0.1), size('1080p', 0.2)],
    silent: true,
    lastFrame: true,
  },
  // cents_per_video_output_second_480p 2, _720p 3, _1080p 14; no sound.
  'open/grok-imagine-video-1.5-lite': {
    sizes: [size('480p', 0.02), size('720p', 0.03), size('1080p', 0.14)],
    silent: false,
    lastFrame: false,
  },
  // cents_per_video_output_second_480p 8, _720p 14, _1080p 25; no sound.
  'open/grok-imagine-video-1.5': {
    sizes: [size('480p', 0.08), size('720p', 0.14), size('1080p', 0.25)],
    silent: false,
    lastFrame: false,
  },
  // cents_per_video_output_second_480p 5, _720p 7; no sound.
  'open/grok-imagine-video': {
    sizes: [size('480p', 0.05), size('720p', 0.07)],
    silent: false,
    lastFrame: false,
  },
  // duration_seconds_480p 0.05, _768p 0.08; no sound.
  'open/hailuo-3-max': {
    sizes: [size('480p', 0.05), size('768p', 0.08)],
    silent: false,
    lastFrame: true,
  },
  // 2K only, duration_seconds 0.13, sound included.
  'open/hailuo-3': { sizes: [], silent: true, lastFrame: true },
  // 1080p only, duration_seconds 0.0817; no sound.
  'open/hailuo-2.3': { sizes: [], silent: false, lastFrame: false },
  // Video tokens; without audio at the same price.
  'open/seedance-2.0-mini': { sizes: [], silent: true, lastFrame: true },
  'open/seedance-2.5': { sizes: [], silent: true, lastFrame: true },
  'open/seedance-2.0-fast': { sizes: [], silent: true, lastFrame: true },
  // Video tokens: video_tokens_without_audio half of video_tokens, which the charge on the
  // reported cost settles; the estimate stays that with sound.
  'open/seedance-1.5-pro': { sizes: [], silent: true, lastFrame: true },
  // cents_per_second_output_720p 17, _1080p 29, _2k 28, _4k 41, sound included.
  'open/flux-3-video': {
    sizes: [size('720p', 0.17), size('1080p', 0.29), size('2K', 0.28), size('4K', 0.41)],
    silent: true,
    lastFrame: true,
  },
  // 720p only: duration_seconds_with_audio 0.126, duration_seconds 0.084.
  'open/kling-3.0-standard': {
    sizes: [size('720p', 0.126, 0.084)],
    silent: true,
    lastFrame: true,
  },
  // 720p only, duration_seconds 0.112, sound at the same price.
  'open/kling-o1': { sizes: [], silent: true, lastFrame: true },
  // duration_seconds_480p 0.068, _720p 0.14, _1080p 0.28, sound included.
  'open/wan-3.0-prime': {
    sizes: [size('480p', 0.068), size('720p', 0.14), size('1080p', 0.28)],
    silent: true,
    lastFrame: true,
  },
  // duration_seconds_720p 0.0988, _1080p 0.1278; no sound.
  'open/happyhorse-1.1': {
    sizes: [size('720p', 0.0988), size('1080p', 0.1278)],
    silent: false,
    lastFrame: false,
  },
  // duration_seconds_720p 0.0988, _1080p 0.1694; no sound.
  'open/happyhorse-1.0': {
    sizes: [size('720p', 0.0988), size('1080p', 0.1694)],
    silent: false,
    lastFrame: false,
  },
  // duration_seconds 0.10 at 720p and 1080p, sound included.
  'open/wan-2.7': {
    sizes: [size('720p', 0.1), size('1080p', 0.1)],
    silent: true,
    lastFrame: true,
  },
  // 720p only, cents_per_second_output 12; no sound.
  'open/gen-4.5': { sizes: [], silent: false, lastFrame: false },
  // duration_seconds_480p 0.02, _768p 0.036, _2k 0.10; no sound.
  'open/heygen-video': {
    sizes: [size('480p', 0.02), size('768p', 0.036), size('2K', 0.1)],
    silent: false,
    lastFrame: false,
  },
};
