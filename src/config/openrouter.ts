// How the proxy calls OpenRouter. Docs read on 20 Oct 2026:
// openrouter.ai/docs/guides/routing/provider-selection.md and openrouter.ai/docs/guides/features/zdr.md.
// Images and video, read on 23 Oct 2026: openrouter.ai/docs/guides/overview/multimodal/
// image-generation.md, video-generation.md, and api/api-reference/chat/create-a-chat-completion.md.
// Audio, read on 26 Oct 2026: openrouter.ai/docs/guides/overview/multimodal/tts.md and audio.md.
import type { PrivacyLevel } from '../contract.js';

/** Provider preferences of a request at the level Open · No retention, the lane ZDR of the app. */
const NO_RETENTION_PREFERENCES = {
  /** Routes only to endpoints with a zero data retention policy. */
  zdr: true,
  /** Skips providers that collect user data. */
  data_collection: 'deny',
} as const;

/**
 * Provider preferences of a request at the level Open, for models with no endpoint of zero data
 * retention (the owner, 23 Oct 2026: "Open"). The provider may keep the request for a while, as the
 * app says, but providers that collect user data stay out.
 */
const OPEN_PREFERENCES = {
  data_collection: 'deny',
} as const;

export type ProviderPreferences = typeof NO_RETENTION_PREFERENCES | typeof OPEN_PREFERENCES;

export const OPENROUTER = {
  baseUrl: 'https://openrouter.ai/api/v1',
  chatCompletionsPath: '/chat/completions',
  /** The provider preferences of each privacy level of the open lane. */
  providerPreferences: {
    'open-no-retention': NO_RETENTION_PREFERENCES,
    open: OPEN_PREFERENCES,
  } satisfies Partial<Record<PrivacyLevel, ProviderPreferences>>,
  /** The data of the last event of a chat completion stream. */
  streamDoneData: '[DONE]',
  /** Time allowed until OpenRouter answers with response headers. */
  firstByteTimeoutMs: 30_000,
  /** Time allowed for one whole answer, from the request to the last token. */
  streamTimeoutMs: 300_000,
  /** The Images API, for the image models that a chat completion cannot reach. */
  imagesPath: '/images',
  /**
   * Time allowed for one image, which comes whole in one answer: a large image of GPT Image 2 took
   * 94 seconds in the docs of OpenRouter.
   */
  imageTimeoutMs: 240_000,
  /** Video jobs: submitted, checked, and fetched under these paths of the base URL. */
  videosPath: '/videos',
  videoContentPath: (jobId: string): string =>
    `/videos/${encodeURIComponent(jobId)}/content?index=0`,
  videoJobPath: (jobId: string): string => `/videos/${encodeURIComponent(jobId)}`,
  /** Time allowed to submit a video job or check one. */
  videoRequestTimeoutMs: 60_000,
  /** Time allowed to pass one whole video through the proxy. */
  videoContentTimeoutMs: 300_000,
  /**
   * The speech API (26 Oct 2026): a voice that reads a text, or a sound, as the bytes of the audio
   * (openrouter.ai/docs/guides/overview/multimodal/tts.md).
   */
  speechPath: '/audio/speech',
  /**
   * Time allowed for one piece of audio, which comes whole: a song of three minutes from Lyria 3
   * Pro took 40 seconds on 26 Oct 2026. It stays under the 100 seconds after which Cloudflare, in
   * front of the proxy, gives up on an answer and puts its own page in place of the error.
   */
  audioTimeoutMs: 90_000,
} as const;

/** The provider preferences of a model of the open lane, by its privacy level. */
export function providerPreferencesFor(privacy: PrivacyLevel): ProviderPreferences {
  if (privacy === 'open') return OPENROUTER.providerPreferences.open;
  return OPENROUTER.providerPreferences['open-no-retention'];
}
