// The HTTP contract between the app and the proxy. The app is coded against these shapes. The
// issuer of vouchers, which the dashboard calls, has its own (apps/issuer/src/contract.ts).
import { z } from 'zod';

import { CREDIT, NOTE_SIGNATURE } from './config/credit.js';
import { PHOTO_LIMIT } from './config/imageTools.js';
import { SOURCE_NAME_CHARS } from './config/sourcedTools.js';
import { LIMITS } from './config/limits.js';
import { MESSAGES } from './config/messages.js';

export const ERROR_CODES = [
  'invalid_request',
  'unknown_model',
  'model_unavailable',
  'rate_limited',
  'upstream_error',
  'upstream_timeout',
  'internal_error',
  'quota_exceeded',
  'trial_paused',
  'key_changed',
  'voucher_invalid',
  'voucher_spent',
  'balance_unknown',
  'balance_low',
  'pass_invalid',
  'pass_spent',
  'pass_paused',
  'pass_too_long',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorBody {
  error: { code: ErrorCode; message: string };
}

export interface HealthResponse {
  ok: true;
}

export type Lane = 'private' | 'open';

/** The four privacy levels of docs/CONCEPT.md, section "Privacy levels". */
export type PrivacyLevel = 'open' | 'open-no-retention' | 'private-verified' | 'local';

export interface ModelPricing {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

/**
 * What a model makes: the answers of a chat, or an image, a video, or audio from a prompt. Images,
 * video, and audio run on the open lane only (decision 70); video at the level Open, since
 * OpenRouter routes no video job under zero data retention (openrouter.ai/docs/guides/overview/
 * multimodal/video-generation.md, read 23 Oct 2026).
 */
export const MODEL_KINDS = ['text', 'image', 'video', 'audio', 'sourcedVideo'] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

/**
 * What the Video page makes from what the user brings (decision 216, 26 Oct 2026): a video edited
 * from a prompt, a video upscaled, or a photo that talks with a voice. These models have the kind
 * 'sourcedVideo', which the chat never lists; they run at the level Open, as video does.
 */
export const SOURCED_MODES = ['edit', 'upscale', 'talk'] as const;
export type SourcedMode = (typeof SOURCED_MODES)[number];

/**
 * What a sourced video charges for: each second of the video it makes, or each megapixel of each
 * second (an upscale).
 */
export const SOURCED_UNITS = ['second', 'megapixelSecond'] as const;
export type SourcedUnit = (typeof SOURCED_UNITS)[number];

/** What the Video page may ask of a model of a sourced video, and what it costs the user. */
export interface SourcedInfo {
  mode: SourcedMode;
  /**
   * What the user pays, about: the cost at the provider plus 25% (decision 52), per unit; an
   * upscale prices its creative mode apart.
   */
  price: { per: SourcedUnit; usd: number; creativeUsd: number | null };
  /** The least that one video costs the user, about; 0 when the provider charges no least. */
  minUsd: number;
  /** The shortest and the longest source, in seconds: the video, or the voice of a photo. */
  minSeconds: number;
  maxSeconds: number;
  /** The largest source video, in pixels of one frame; null for no limit of the provider. */
  maxSourcePixels: number | null;
  /** The largest frame that comes out, in pixels, where an upscale stops; null for no limit. */
  maxOutputPixels: number | null;
  /** The factors of an upscale, the default first; empty for every other mode. */
  factors: number[];
  /** The shapes and resolutions of a talking photo, the default first; empty otherwise. */
  aspectRatios: string[];
  resolutions: string[];
  /** True when the request must carry a prompt: an edit. */
  promptRequired: boolean;
}

/**
 * What the Audio page makes (the owner, 26 Oct 2026): music, a voice that reads a text, or a sound
 * effect.
 */
export const AUDIO_MODES = ['music', 'voice', 'sound'] as const;
export type AudioMode = (typeof AUDIO_MODES)[number];

/** What a model of audio charges for: each piece it makes, each character it reads, or each second. */
export const AUDIO_UNITS = ['piece', 'character', 'second'] as const;
export type AudioUnit = (typeof AUDIO_UNITS)[number];

/** One voice that a model of the mode voice reads with. */
export interface VoiceOption {
  /** The id of the provider, such as 'george'. */
  id: string;
  name: string;
}

/** What the Audio page may ask of a model of audio, and what it costs the user (26 Oct 2026). */
export interface AudioInfo {
  mode: AudioMode;
  /** The voices that the user may pick, the default first; empty for a model with one voice. */
  voices: VoiceOption[];
  /** The longest prompt, or text to read, in characters. */
  maxChars: number;
  /** What the user pays, about: the cost at the provider plus 25% (decision 52), per unit. */
  price: { per: AudioUnit; usd: number };
}

/** One length of a video that the user may pick, and what that video costs the user, about. */
export interface DurationOption {
  seconds: number;
  priceUsd: number;
}

/** One image or one video of a model, at the settings that the proxy sends (23 Oct 2026). */
export interface MediaInfo {
  /** The shape of the frame when the user picks none, such as '16:9'. */
  aspectRatio: string;
  /** The shapes that the user may pick, the default among them (25 Oct 2026). */
  aspectRatios: string[];
  /** The lengths of a video that the user may pick, shortest first; empty for an image. */
  durations: DurationOption[];
  /** The length of a video in seconds; null for an image. */
  seconds: number | null;
  /** The resolution of a video, such as '720p'; null for an image. */
  resolution: string | null;
  /** True when a video comes with sound. */
  audio: boolean;
  /**
   * What one image or one video costs the user, about: its estimated cost at the provider plus 25%
   * (decision 52). The charge is the cost that the provider reports, plus 25%.
   */
  priceUsd: number;
  /** What the Image page may ask of an image model beyond its shape; absent for a video. */
  tools?: ImageToolsInfo;
  /** What the Video page may ask of a video model beyond its shape and length; absent for an image. */
  videoTools?: VideoToolsInfo;
}

/** One resolution of a video that the user may pick, at the price that the user pays, about. */
export interface VideoSizeOption {
  /** A resolution such as '720p' or '4K'. */
  resolution: string;
  /** One second with sound when the model makes sound. */
  secondPriceUsd: number;
  /** One second without sound, when it costs less; else null. */
  silentSecondPriceUsd: number | null;
}

/** What the Video page may ask of a video model beyond its shape and its length (25 Oct 2026). */
export interface VideoToolsInfo {
  /** The resolutions that the user may pick, smallest first; empty for the one of the model. */
  sizes: VideoSizeOption[];
  /** The model makes sound and can leave it out. */
  silent: boolean;
  /** The model takes a last frame as well as a first one. */
  lastFrame: boolean;
}

/** One size of an image that the user may pick, at the price that the user pays, about. */
export interface SizeOption {
  /** A resolution such as '1K' or '4K'. */
  resolution: string;
  priceUsd: number;
}

/** What the Image page may ask of an image model beyond its shape (the owner, 25 Oct 2026). */
export interface ImageToolsInfo {
  /** The sizes that the user may pick, smallest first; empty when the model takes no size. */
  sizes: SizeOption[];
  /** The size of a request that picks none; null when the model takes no size. */
  defaultSize: string | null;
  /** The fewest photos of one request: one for a model of style images or an editing model. */
  minPhotos: number;
  /** The most photos of one request: the image to change, or the images to combine. */
  maxPhotos: number;
  /** The photos set the style of the image, as with the styles of Recraft (28 Oct 2026). */
  stylePhotos: boolean;
  /** What each photo adds, about, at the price that the user pays. */
  photoPriceUsd: number;
  seed: boolean;
  transparent: boolean;
}

export interface ModelInfo {
  /** '<lane>/<slug>', for example 'open/glm-5.3-flash'. */
  id: string;
  name: string;
  maker: string;
  /** The key of the maker icon in the app. */
  makerSlug: string;
  kind: ModelKind;
  lane: Lane;
  privacy: PrivacyLevel;
  description: string;
  contextTokens: number;
  reasoning: boolean;
  /** The model thinks before every answer, so Think off only makes it think less (28 Oct 2026). */
  alwaysThinks: boolean;
  /** The model always thinks in full: Think off cannot make it think less (29 Oct 2026). */
  thinksInFull: boolean;
  /**
   * The model can search the web: every model of text of the private lane (decision 142), and
   * those of the open lane that take tools (29 Oct 2026).
   */
  webSearch: boolean;
  vision: boolean;
  /** False: the app shows the model locked ("Soon"). */
  available: boolean;
  /** A holder of 1M THKR chats with this model free (config/holderPass.ts, 31 Oct 2026). */
  holderFree: boolean;
  /**
   * What a million tokens cost the user: the price of the model (decision 132), or else its cost
   * at the provider plus 25% (decision 52).
   */
  pricing: ModelPricing | null;
  /**
   * The id of the model inside the TEE, which the app seals into each request of the private
   * lane and sends in the model header. Null in the open lane.
   */
  teeModelId: string | null;
  /** What one image or one video of the model is and costs; null for a model of text or audio. */
  media: MediaInfo | null;
  /** What the Audio page may ask of a model of audio; null for every other kind. */
  audio: AudioInfo | null;
  /** What the Video page may ask of a model of a sourced video; null for every other kind. */
  sourced: SourcedInfo | null;
}

/** Why the app shows a model locked: not served yet, or outside the free trial until the top-up. */
export type LockReason = 'soon' | 'credit';

/** A model as GET /api/models lists it: `available` is false exactly when `lockReason` is set. */
export interface ListedModel extends ModelInfo {
  lockReason: LockReason | null;
}

/** What the lanes charge beyond tokens, in USD (decisions 52 and 142). */
export interface ExtraPrices {
  /** Once for each answer of the private lane that searched the web. */
  webSearchUsd: number;
  /** For each search of the web in the open lane (29 Oct 2026). */
  openWebSearchUsd: number;
  /** For each document converted. */
  documentUsd: number;
  /**
   * Premium, for a balance only (the owner, 23 Oct 2026): for each recording turned into text; 0
   * when it has no price of its own and costs what the enclave reports, less 25%.
   */
  voiceInputUsd: number;
  /** For each part of an answer spoken. */
  voiceReplyUsd: number;
  /** For each message through the privacy filter. */
  privacyFilterUsd: number;
}

export interface ModelsResponse {
  defaultModelId: string;
  models: ListedModel[];
  extras: ExtraPrices;
}

/** What a visitor may still do today. 'full' has no limits; 'trial' is decision 67. */
export type AccessMode = 'full' | 'trial';

export interface LaneAccess {
  chatsPerDay: number;
  chatsLeft: number;
  /** True when the lane spent its budget of the day; it opens again at 00:00 UTC. */
  paused: boolean;
}

export type AccessStatus = { mode: 'full' } | { mode: 'trial'; lanes: Record<Lane, LaneAccess> };

/** The balance named by the balance header. Paid chats skip the limits of the free trial. */
export interface CreditStatus {
  usd: number;
}

/** GET /api/access. `credit` is null when the request names no balance. */
export type AccessResponse = AccessStatus & { credit: CreditStatus | null };

/** Base64url without padding, of exactly `bytes` bytes once decoded. */
function base64UrlOf(bytes: number): z.ZodString {
  return z
    .string()
    .length(Math.ceil((bytes * 4) / 3))
    .regex(/^[A-Za-z0-9_-]+$/);
}

const MODULUS_BYTES = NOTE_SIGNATURE.modulusBits / 8;

const keyIdSchema = z
  .string()
  .regex(new RegExp(`^[0-9a-f]{${String(NOTE_SIGNATURE.keyIdBytes * 2)}}$`));

/** GET /api/credit/key: the public key that the app blinds its vouchers with. */
export interface CreditKeyResponse {
  keyId: string;
  /** The RSA public key, SPKI DER in base64url. */
  publicKey: string;
  voucherUsd: number;
  /** The quick choices of a top-up, in vouchers. */
  packs: number[];
  /** The most vouchers of one top-up, which the user may also type. */
  maxVouchers: number;
  /**
   * How the dashboard takes payment, for the words of the app: `token` is USDG, and `tokens` every
   * token that pays, with THKR while payment in THKR is open.
   */
  payment: { network: string; token: string; tokens: string[]; testnet: boolean };
  /**
   * The keys of holder vouchers that the proxy takes, one for each month, with what one of their
   * vouchers is worth (decision 189), so that the app counts the credit of each voucher it holds.
   */
  holderKeys: { keyId: string; month: string; voucherUsd: number }[];
  /** The keys of the notes of change, with what one note is worth, for the same count. */
  changeKeys: { keyId: string; voucherUsd: number }[];
}

/** POST /api/credit/redeem: one voucher, spent into a balance. */
export const redeemRequestSchema = z.strictObject({
  keyId: keyIdSchema,
  nonce: base64UrlOf(NOTE_SIGNATURE.nonceBytes),
  signature: base64UrlOf(MODULUS_BYTES),
  /**
   * The secret of the balance to fill, made by the app: a new random secret opens a new balance.
   * The app knows the secret before it sends, so a lost answer loses no credit.
   */
  balance: base64UrlOf(CREDIT.balanceSecretBytes),
});

export type RedeemRequest = z.infer<typeof redeemRequestSchema>;

export interface RedeemResponse {
  /** What the balance holds now. */
  usd: number;
}

/**
 * POST /api/credit/merge: what is left on one balance of this person moves onto another, and the
 * first closes. Two devices that share a backup keep one balance (encrypted backup, 23 Oct 2026).
 */
export const mergeRequestSchema = z.strictObject({
  /** The secret of the balance that stays. */
  balance: base64UrlOf(CREDIT.balanceSecretBytes),
  /** The secret of the balance that closes. */
  from: base64UrlOf(CREDIT.balanceSecretBytes),
});

export type MergeRequest = z.infer<typeof mergeRequestSchema>;

/**
 * GET /api/credit/holder-totals: the holder vouchers spent into balances, by the month of their
 * key, and what their credit paid for, by the month of the payment, with no balance (decision 191).
 */
export interface HolderTotalsResponse {
  redeemed: { month: string; vouchers: number }[];
  spent: { month: string; use: 'chat' | 'image' | 'video'; usd: number }[];
  /** The free chats of holders by month, and what they cost at the provider. */
  passes: { month: string; chats: number; costUsd: number }[];
}

export interface MergeResponse {
  /** What the balance that stays holds now. */
  usd: number;
}

/** A photo that the app scaled on the device, as a data URL of base64. */
const imageDataUrlSchema = z
  .string()
  .max(LIMITS.maxImageDataUrlChars, MESSAGES.imageTooLarge)
  .regex(/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+=*$/, MESSAGES.imageInvalid);

/**
 * One message of a chat of the open lane. A message of the user may carry photos (23 Oct 2026), for
 * a model that sees them; with photos, its text may be empty.
 */
export const chatMessageSchema = z
  .strictObject({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(LIMITS.maxMessageChars, MESSAGES.messageTooLong),
    images: z
      .array(imageDataUrlSchema)
      .max(LIMITS.maxImagesPerMessage, MESSAGES.tooManyImages)
      .optional(),
  })
  .refine((message) => message.content.trim().length > 0 || (message.images?.length ?? 0) > 0, {
    message: MESSAGES.messageEmpty,
    path: ['content'],
  })
  .refine((message) => message.role === 'user' || message.images === undefined, {
    message: MESSAGES.imagesFromUserOnly,
    path: ['images'],
  });

export const chatRequestSchema = z.strictObject({
  modelId: z.string().min(1, MESSAGES.modelIdRequired),
  messages: z
    .array(chatMessageSchema)
    .min(1, MESSAGES.noMessages)
    .max(LIMITS.maxMessages, MESSAGES.tooManyMessages),
  /**
   * Think in the message box (28 Oct 2026): false asks a model that can think to answer at once. An
   * app from before Think sends none, and the model does as its maker set it.
   */
  think: z.boolean().optional(),
  /**
   * Web search (29 Oct 2026): true lets a model that can search the web do so through Exa. An app
   * from before sends none, and the model answers from what it knows.
   */
  webSearch: z.boolean().optional(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * The events of an answer. With web search on (29 Oct 2026), 'source' names a page that a search
 * found, and 'searched' tells, before 'done', how often the answer searched.
 */
export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'source'; url: string; title: string }
  | { type: 'searched'; count: number }
  | { type: 'done'; finishReason: string | null; usage: ChatUsage | null }
  | { type: 'error'; code: ErrorCode; message: string };

/** POST /api/images and POST /api/videos: one prompt for a model of that kind (23 Oct 2026). */
export const mediaRequestSchema = z
  .strictObject({
    modelId: z.string().min(1, MESSAGES.modelIdRequired),
    prompt: z
      .string()
      .max(LIMITS.maxPromptChars, MESSAGES.promptTooLong)
      .refine((prompt) => prompt.trim().length > 0, MESSAGES.promptEmpty),
    /**
     * One photo (23 Oct 2026): the image that an image model changes, or the first frame of a
     * video.
     */
    image: imageDataUrlSchema.optional(),
    /** The shape that the user picked, one of the model's (25 Oct 2026); else its default. */
    aspectRatio: z
      .string()
      .regex(/^\d{1,2}:\d{1,2}$/, MESSAGES.shapeUnavailable)
      .optional(),
    /** The length of a video in seconds that the user picked, one of the model's; else its default. */
    seconds: z.number().int().positive().optional(),
    /**
     * The tools of the Image page (the owner, 25 Oct 2026): several photos to combine, in place of
     * one; a size of the model's; a seed; and a transparent background.
     */
    images: z.array(imageDataUrlSchema).min(2).max(PHOTO_LIMIT, MESSAGES.tooManyPhotos).optional(),
    /** The size of an image, such as '2K', or the resolution of a video, such as '1080p'. */
    resolution: z
      .string()
      .regex(/^\d+(\.\d+)?[Kp]?$/, MESSAGES.sizeUnavailable)
      .optional(),
    seed: z.number().int().min(0).max(LIMITS.maxSeed).optional(),
    transparent: z.literal(true).optional(),
    /**
     * The tools of the Video page (the owner, 25 Oct 2026): the last frame, as `image` is the
     * first; and a video without sound.
     */
    lastImage: imageDataUrlSchema.optional(),
    silent: z.literal(true).optional(),
    /** The voice that reads the text on the Audio page (26 Oct 2026), one of the model's. */
    voice: z.string().min(1).max(LIMITS.maxVoiceIdChars, MESSAGES.voiceUnavailable).optional(),
  })
  .refine((request) => request.image === undefined || request.images === undefined, {
    message: MESSAGES.photosTwice,
  });

export type MediaRequest = z.infer<typeof mediaRequestSchema>;

/** The answer of POST /api/images: the images as data URLs, and any text the model wrote with them. */
export interface ImageResponse {
  images: { dataUrl: string }[];
  text: string;
}

/**
 * The answer of POST /api/audio (26 Oct 2026): the audio as a data URL, MP3 or WAV, and any text
 * the model wrote with it, such as the lyrics of a song.
 */
export interface AudioResponse {
  audio: { dataUrl: string };
  text: string;
}

/**
 * The answer of POST /api/videos: the ticket of the job. The proxy keeps no record of the job; the
 * app sends the ticket back in the job header to follow the job and to fetch its video.
 */
export interface VideoJobResponse {
  ticket: string;
}

export type VideoStatus = 'pending' | 'completed' | 'failed';

/** GET /api/videos/status: where the job stands, and why it failed. */
export interface VideoStatusResponse {
  status: VideoStatus;
  message: string | null;
}

/**
 * The answer of POST /api/videos/sources (decision 216): the source that the proxy holds for a
 * short while, and what it read from it. The app names the source in POST /api/videos/sourced.
 */
export interface SourceResponse {
  /** A random name that only the proxy and the provider ever see in a link. */
  source: string;
  /** The length of the video or the voice, in seconds. */
  seconds: number;
  /** The size of a frame of a video; null for a voice. */
  width: number | null;
  height: number | null;
}

/** The name of a source that the proxy holds: `SOURCED.tokenBytes` random bytes in base64url. */
const sourceNameSchema = z
  .string()
  .regex(new RegExp(`^[A-Za-z0-9_-]{${String(SOURCE_NAME_CHARS)}}$`), MESSAGES.sourceGone);

/**
 * POST /api/videos/sourced (decision 216): a video made from what the user brings. An edit and an
 * upscale name a source video; a talking photo names a photo and a source voice. A prompt may be
 * empty, but for an edit.
 */
export const sourcedRequestSchema = z.strictObject({
  modelId: z.string().min(1, MESSAGES.modelIdRequired),
  prompt: z.string().max(LIMITS.maxPromptChars, MESSAGES.promptTooLong),
  /** The video to edit or to upscale, held by the proxy. */
  video: sourceNameSchema.optional(),
  /** The voice that a photo speaks with, held by the proxy as WAV. */
  voice: sourceNameSchema.optional(),
  /** The photo that talks. */
  image: imageDataUrlSchema.optional(),
  /** The factor of an upscale, one of the model's; else its default. */
  factor: z.number().positive().optional(),
  /** The creative mode of an upscale, which invents fine detail; else the precise one. */
  creative: z.literal(true).optional(),
  /** The shape and the resolution of a talking photo, one of the model's; else its default. */
  aspectRatio: z
    .string()
    .regex(/^\d{1,2}:\d{1,2}$/, MESSAGES.shapeUnavailable)
    .optional(),
  resolution: z
    .string()
    .regex(/^\d+(\.\d+)?[Kp]?$/, MESSAGES.sizeUnavailable)
    .optional(),
});

export type SourcedRequest = z.infer<typeof sourcedRequestSchema>;
