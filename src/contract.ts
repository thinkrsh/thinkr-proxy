// The HTTP contract between the app and the proxy. The app is coded against these shapes. The
// issuer of vouchers, which the dashboard calls, has its own (apps/issuer/src/contract.ts).
import { z } from 'zod';

import { CREDIT, VOUCHER_SIGNATURE } from './config/credit.js';
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
 * What a model makes: the answers of a chat, or an image or a video from a prompt. Images and video
 * run on the open lane only (decision 70); video at the level Open, since OpenRouter routes no
 * video job under zero data retention (openrouter.ai/docs/guides/overview/multimodal/
 * video-generation.md, read 23 Oct 2026).
 */
export const MODEL_KINDS = ['text', 'image', 'video'] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

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
  vision: boolean;
  /** False: the app shows the model locked ("Soon"). */
  available: boolean;
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
  /** What one image or one video of the model is and costs; null for a model of text. */
  media: MediaInfo | null;
}

/** Why the app shows a model locked: not served yet, or outside the free trial until the top-up. */
export type LockReason = 'soon' | 'credit';

/** A model as GET /api/models lists it: `available` is false exactly when `lockReason` is set. */
export interface ListedModel extends ModelInfo {
  lockReason: LockReason | null;
}

/** What the private lane charges beyond tokens, in USD (decisions 52 and 142). */
export interface ExtraPrices {
  /** Once for each answer that searched the web. */
  webSearchUsd: number;
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

const MODULUS_BYTES = VOUCHER_SIGNATURE.modulusBits / 8;

const keyIdSchema = z
  .string()
  .regex(new RegExp(`^[0-9a-f]{${String(VOUCHER_SIGNATURE.keyIdBytes * 2)}}$`));

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
}

/** POST /api/credit/redeem: one voucher, spent into a balance. */
export const redeemRequestSchema = z.strictObject({
  keyId: keyIdSchema,
  nonce: base64UrlOf(VOUCHER_SIGNATURE.nonceBytes),
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
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'done'; finishReason: string | null; usage: ChatUsage | null }
  | { type: 'error'; code: ErrorCode; message: string };

/** POST /api/images and POST /api/videos: one prompt for a model of that kind (23 Oct 2026). */
export const mediaRequestSchema = z.strictObject({
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
});

export type MediaRequest = z.infer<typeof mediaRequestSchema>;

/** The answer of POST /api/images: the images as data URLs, and any text the model wrote with them. */
export interface ImageResponse {
  images: { dataUrl: string }[];
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
