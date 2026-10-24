// Limits that protect the OpenRouter key and the proxy. Change them here only.
export const LIMITS = {
  /** Chat requests allowed per client address in one window. */
  chatRequestsPerWindow: 20,
  /** The length of one rate-limit window. */
  rateWindowMs: 60_000,
  /** When the limiter tracks more clients than this, it drops the expired windows. */
  rateSweepThreshold: 10_000,
  /** Messages in one chat request, user and assistant together. */
  maxMessages: 200,
  /** Characters in one message. */
  maxMessageChars: 100_000,
  /** Characters in all messages of one request. */
  maxTotalChars: 400_000,
  /** Characters in the prompt of an image or a video. */
  maxPromptChars: 4_000,
  /**
   * Photos of the open lane (23 Oct 2026): on one message, which the app holds to 5 as the private
   * lane does, and in one chat; the app scales each to a JPEG of 1,536 pixels on its longer side.
   */
  maxImagesPerMessage: 5,
  maxImagesPerChat: 20,
  /** Characters of the data URL of one photo: a scaled JPEG stays far below it. */
  maxImageDataUrlChars: 4_000_000,
  /**
   * Checks of a video job and downloads of its video allowed per client address in one window,
   * apart from the limit of chats: the app checks a job every few seconds while it renders.
   */
  videoChecksPerWindow: 60,
} as const;
