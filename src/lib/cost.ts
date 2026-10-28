// What one answer spent: its cost in USD, as the provider reported it or else its tokens at the
// cost of the model, and its tokens.
import { TRIAL } from '../config/trial.js';
import type { ChatUsage, ModelPricing } from '../contract.js';

const TOKENS_PER_PRICE_UNIT = 1_000_000;

/** What one answer spent: its cost at the provider, its tokens, and its searches of the web. */
export interface ChatSpend {
  readonly costUsd: number;
  readonly usage: ChatUsage;
  /** Searches of the web in the answer (decision 142; the open lane since 29 Oct 2026). */
  readonly webSearches: number;
}

/** The USD of some tokens at a price for a million tokens. */
export function tokensUsd(usage: ChatUsage, pricing: ModelPricing): number {
  const input = usage.inputTokens * pricing.inputUsdPerMTok;
  const output = usage.outputTokens * pricing.outputUsdPerMTok;
  return (input + output) / TOKENS_PER_PRICE_UNIT;
}

/**
 * The reported cost when there is one, otherwise the tokens at the cost of the model. When even
 * the tokens are unknown, the answer counts as one typical chat, so that no answer goes uncounted.
 */
export function answerSpend(
  reportedUsd: number | null,
  usage: ChatUsage | null,
  cost: ModelPricing | null,
  webSearches = 0,
): ChatSpend {
  const tokens = usage ?? TRIAL.fallbackUsage;
  const costUsd = reportedUsd ?? (cost === null ? 0 : tokensUsd(tokens, cost));
  return { costUsd, usage: tokens, webSearches };
}
