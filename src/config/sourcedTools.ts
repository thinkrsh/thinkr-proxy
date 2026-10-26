// The sourced videos of the Video page (decision 216, 26 Oct 2026): a video edited from a prompt, a
// video upscaled, and a photo that talks with a voice. OpenRouter takes a source video or voice
// only as an HTTPS link ("Only HTTPS URLs are allowed", probed 25 Oct 2026), so the proxy holds each
// source in its memory at a random link that only OpenRouter and the provider see, and drops it once
// its job ends or its time runs out; nothing is written to disk. Limits read on 26 Oct 2026 from
// GET https://openrouter.ai/api/v1/videos/models (`upscale_factor`, `creativity`,
// `supported_resolutions`, `supported_aspect_ratios`, `pricing_skus`) and the listings of the
// providers: FLUX Video Edit takes up to 15 s and 50 MiB and keeps the length of its source; Runway
// Aleph 2 takes 2 to 30 s; FLUX Video Upscale takes 1 to 20 s of up to 2560x1440 and makes frames
// of up to about 14.4 megapixels. Avatar IV publishes no longest voice: 60 s here. Change them here
// only.

export const SOURCED = {
  /** POST: holds one source, a video or a voice, from its raw bytes. GET `/<name>`: the source. */
  sourcesPath: '/videos/sources',
  /** POST: a video job from what the user brings, which answers with the ticket of the job. */
  sourcedPath: '/videos/sourced',
  /** How long the proxy holds a source whose job does not end first (decision 216: 10 minutes). */
  holdMs: 600_000,
  /** Random bytes of the name of a source. */
  nameBytes: 32,
  /** The largest source: the 50 MiB of FLUX Video Edit and FLUX Video Upscale. */
  maxSourceBytes: 52_428_800,
  /** All the sources that the proxy holds at once, so that sources cannot fill its memory. */
  maxHeldBytes: 268_435_456,
  /** The types of a source video, MP4 and QuickTime, whose length and frame the proxy reads. */
  videoTypes: ['video/mp4', 'video/quicktime'],
  /** The type of a source voice: the app turns any audio into WAV first. */
  voiceType: 'audio/wav',
  /** The prompt of a talking photo that names none, since the provider needs one. */
  talkPrompt: 'The person in the photo talks naturally to the camera.',
} as const;

/** Characters of the name of a source in base64url, without padding. */
export const SOURCE_NAME_CHARS = Math.ceil((SOURCED.nameBytes * 4) / 3);

export interface SourcedTools {
  /** The shortest and the longest source, in seconds: the video, or the voice of a photo. */
  readonly minSeconds: number;
  readonly maxSeconds: number;
  /** The largest source video, in pixels of one frame; null for no limit of the provider. */
  readonly maxSourcePixels: number | null;
  /**
   * The largest frame that the provider makes, in pixels; an upscale past it comes out with a
   * smaller factor, so its estimate stops there. Null for no limit.
   */
  readonly maxOutputPixels: number | null;
  /** The factors of an upscale, the default first; empty for every other mode. */
  readonly factors: readonly number[];
  /** The shapes and resolutions of a talking photo, the default first; empty otherwise. */
  readonly aspectRatios: readonly string[];
  readonly resolutions: readonly string[];
  /** True when a request must carry a prompt: an edit. */
  readonly promptRequired: boolean;
}

/** The tools of each model of a sourced video, by its id. */
export const SOURCED_TOOLS: Readonly<Record<string, SourcedTools>> = {
  'open/flux-video-edit': {
    minSeconds: 1,
    maxSeconds: 15,
    maxSourcePixels: null,
    maxOutputPixels: null,
    factors: [],
    aspectRatios: [],
    resolutions: [],
    promptRequired: true,
  },
  'open/aleph-2': {
    minSeconds: 2,
    maxSeconds: 30,
    maxSourcePixels: null,
    maxOutputPixels: null,
    factors: [],
    aspectRatios: [],
    resolutions: [],
    promptRequired: true,
  },
  'open/flux-video-upscale': {
    minSeconds: 1,
    maxSeconds: 20,
    maxSourcePixels: 2560 * 1440,
    maxOutputPixels: 14_400_000,
    factors: [2, 1.5, 3],
    aspectRatios: [],
    resolutions: [],
    promptRequired: false,
  },
  // One price for both resolutions, so the larger comes first.
  'open/avatar-iv': {
    minSeconds: 1,
    maxSeconds: 60,
    maxSourcePixels: null,
    maxOutputPixels: null,
    factors: [],
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: ['1080p', '720p'],
    promptRequired: false,
  },
};
