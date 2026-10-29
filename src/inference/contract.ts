// What the routes of Thinkr Inference take and answer (29 Oct 2026). The SDK (apps/sdk/) and the
// pages of API keys of the app (apps/app/, since 30 Oct 2026) and of the dashboard (apps/dash/) read
// these shapes: change them together. Names follow the OpenAI API, in snake case, where it has one.
import { z } from 'zod';

import { INFERENCE } from '../config/inference.js';
import { redeemRequestSchema } from '../contract.js';

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
  /** The holder credit on the key now, in USD. */
  usd: number;
  /** The vouchers that this call spent into the key. */
  redeemed: number;
  /** The vouchers of this call that were spent before, which it skipped. */
  spent: number;
}

/** GET /api/inference/v1/balance: the holder credit left on the key of the request, in USD. */
export interface KeyBalanceResponse {
  usd: number;
}

/** What a million tokens of a model cost, in USD. */
export interface InferencePricing {
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
}

/** One model of GET /api/inference/v1/models: the shape of the OpenAI API and the fields of Thinkr. */
export interface InferenceModel {
  /** What the body of a chat names as `model`. */
  id: string;
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
