// What the routes of Thinkr Inference take and answer (29 Oct 2026). The SDK (apps/sdk/) and the
// pages of API keys of the app (apps/app/, since 30 Oct 2026) and of the dashboard (apps/dash/) read
// these shapes: change them together. Names follow the OpenAI API, in snake case, where it has one.
import { z } from 'zod';

import { INFERENCE } from '../config/inference.js';
import { mergeRequestSchema, redeemRequestSchema } from '../contract.js';

/** One voucher, as POST /api/credit/redeem takes it, without the balance that it fills. */
const voucherSchema = redeemRequestSchema.omit({ balance: true });

/** POST /api/inference/v1/keys/redeem: holder vouchers to spend into an API key. */
export const keyRedeemRequestSchema = z.strictObject({
  /** The API key to fill: a new one opens with its first voucher. */
  key: z.string(),
  vouchers: z.array(voucherSchema).min(1).max(INFERENCE.maxVouchersPerRedeem),
});

export type KeyRedeemRequest = z.infer<typeof keyRedeemRequestSchema>;

export interface KeyRedeemResponse {
  /** The credit on the key now, in USD. */
  usd: number;
  /** The vouchers that this call spent into the key. */
  redeemed: number;
  /** The vouchers of this call that were spent before, which it skipped. */
  spent: number;
}

/** POST /api/inference/v1/keys/fill: credit to move from the balance of the app onto an API key. */
export const keyFillRequestSchema = z.strictObject({
  /** The secret of the balance that pays. */
  balance: mergeRequestSchema.shape.balance,
  /** The API key to fill: a new one opens with this move. */
  key: z.string(),
  usd: z.number().min(INFERENCE.minFillUsd).max(INFERENCE.maxFillUsd),
  /**
   * A random id of this move, in the shape of a balance secret: a second call with it moves nothing,
   * so a call whose answer was lost can be sent again.
   */
  fill: mergeRequestSchema.shape.balance,
});

export type KeyFillRequest = z.infer<typeof keyFillRequestSchema>;

export interface KeyFillResponse {
  /** The credit on the key now, in USD. */
  usd: number;
  /** What is left on the balance that paid, in USD. */
  balance: number;
}

/** POST /api/inference/v1/keys/close: an API key stops, and what is left on it moves to a balance. */
export const keyCloseRequestSchema = z.strictObject({
  /** The secret of the balance that takes what is left. */
  balance: mergeRequestSchema.shape.balance,
  key: z.string(),
});

export type KeyCloseRequest = z.infer<typeof keyCloseRequestSchema>;

export interface KeyCloseResponse {
  /** The credit on the balance now, in USD. */
  usd: number;
}

const textPartSchema = z.object({ type: z.literal('text'), text: z.string() });

const imagePartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({ url: z.string(), detail: z.enum(['auto', 'low', 'high']).optional() }),
});

/** One message of a plain chat. Whatever else a part or a message carries stays out. */
const plainMessageSchema = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: z
    .union([z.string(), z.array(z.discriminatedUnion('type', [textPartSchema, imagePartSchema]))], {
      error: INFERENCE.messages.partUnknown,
    })
    .nullish(),
  name: z.string().optional(),
  tool_calls: z.array(z.unknown()).nullish(),
  tool_call_id: z.string().optional(),
  /** What a model that thinks needs back in a chat of tool calls. */
  reasoning: z.string().nullish(),
  reasoning_details: z.array(z.unknown()).nullish(),
});

/** Only a function of the caller: a server tool of OpenRouter, such as a search, costs extra. */
const functionToolSchema = z.object({
  type: z.literal('function', { error: INFERENCE.messages.toolUnknown }),
  function: z.looseObject({ name: z.string() }),
});

const longestAnswerSchema = z.number().int().positive().nullish();

/**
 * POST /api/inference/v1/chat/completions with a model of ZDR or Open: plain JSON, in the shape of
 * the OpenAI API. Other fields stay in place here, for INFERENCE.plainChatFields to pick from.
 */
export const plainChatRequestSchema = z.looseObject({
  model: z.string(),
  messages: z.array(plainMessageSchema).min(1),
  stream: z.boolean().nullish(),
  tools: z.array(functionToolSchema).nullish(),
  max_tokens: longestAnswerSchema,
  max_completion_tokens: longestAnswerSchema,
});

export type PlainChatRequest = z.infer<typeof plainChatRequestSchema>;

/**
 * The answer to an encrypted chat sent with X-Thinkr-Body-Encoding. The caller decrypts it on its
 * own machine, as the local bridge of the SDK does.
 */
export interface EncodedChatAnswer {
  /** The response nonce of EHBP, which an answer in frames carries in a header. */
  nonce: string;
  /** The encrypted frames of the answer, in base64url. */
  ciphertext: string;
}

/** GET /api/inference/v1/balance: the credit left on the key of the request, in USD. */
export interface KeyBalanceResponse {
  usd: number;
}

/** What a million tokens of a model cost, in USD. */
export interface InferencePricing {
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
}

/**
 * How a model takes a chat, as the switch of the app names it (decision 174): `private` in an
 * enclave, encrypted on the machine of the caller; `zdr` and `open` as plain JSON that the proxy
 * reads, through OpenRouter, `zdr` only at providers under zero data retention.
 */
export type InferenceMode = 'private' | 'zdr' | 'open';

/** One model of GET /api/inference/v1/models: the shape of the OpenAI API and the fields of Thinkr. */
export interface InferenceModel {
  /** What the body of a chat names as `model`. */
  id: string;
  mode: InferenceMode;
  object: 'model';
  /** The maker of the model. */
  owned_by: string;
  name: string;
  context_length: number;
  pricing: InferencePricing | null;
  vision: boolean;
  reasoning: boolean;
}

export interface InferenceModelsResponse {
  object: 'list';
  data: InferenceModel[];
}
