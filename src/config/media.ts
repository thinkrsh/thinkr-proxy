// Images, video, and audio of the open lane (the owner, 23 and 26 Oct 2026): the routes of the
// proxy, the header and the ticket of a video job, and the states of a job at OpenRouter. Change
// them here only.
import type { VideoStatus } from '../contract.js';

export const MEDIA = {
  /** POST: one image from a prompt. */
  imagesPath: '/images',
  /** POST: one piece of audio from a prompt or a text (26 Oct 2026): music, a voice, or a sound. */
  audioPath: '/audio',
  /** POST: a video job from a prompt, which answers with its ticket. */
  videosPath: '/videos',
  /** GET: where the job of the ticket stands. */
  videoStatusPath: '/videos/status',
  /** GET: the video of the job of the ticket, once it is done. */
  videoContentPath: '/videos/content',
  /** The request header that carries the ticket of a job: never the path, which the log keeps. */
  ticketHeader: 'X-Thinkr-Job',
  ticket: {
    /**
     * Bytes of the secret that seals the tickets (AES-GCM, 256 bits), in TICKET_KEY_FILE. Until
     * 24 Oct 2026 it came from the voucher key; the file holds the same secret, so tickets sealed
     * before stay valid.
     */
    keyBytes: 32,
    /** Bytes of the random nonce of AES-GCM in front of each ticket. */
    ivBytes: 12,
    /** The version of what a ticket holds. */
    version: 1,
  },
  /**
   * The states of a video job at OpenRouter by what they mean to the app
   * (openrouter.ai/docs/guides/overview/multimodal/video-generation.md, read 23 Oct 2026). A state
   * not listed counts as pending.
   */
  jobStates: {
    completed: ['completed'],
    failed: ['failed', 'cancelled', 'expired'],
  } satisfies Partial<Record<VideoStatus, readonly string[]>>,
  /** The type of a video that comes without one. */
  videoContentType: 'video/mp4',
  /** The longest reason of a failed job that passes on to the app. */
  maxReasonChars: 300,
  /**
   * The status of an error of the provider behind an image or a video: Cloudflare in front of the
   * proxy puts its own page over a 502 or a 504, so the app could not read why (23 Oct 2026).
   */
  upstreamFailureStatus: 424,
  /** The status of a video that the provider no longer holds. */
  goneStatus: 410,
} as const;
