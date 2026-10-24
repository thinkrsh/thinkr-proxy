// The free trial of decision 67: what a visitor may use before the top-up exists. The day of every
// count and budget starts at 00:00 UTC. Change the numbers here only.
import type { ChatUsage, Lane } from '../contract.js';
import { MODEL_CATALOG } from './models.js';

export const TRIAL = {
  /**
   * The models open in the trial, by catalog id: every model that the proxy serves, since 22 Oct
   * 2026 ("gpp buka aja semua"), but video, which takes credit only (the owner, 23 Oct 2026): one
   * video costs more than a day of chats. An image counts as one chat of its lane. The counts and
   * budgets below still hold. To lock models for credit again, list the open ids here; every other
   * model then shows "credit".
   */
  modelIds: MODEL_CATALOG.filter(({ info }) => info.available && info.kind !== 'video').map(
    ({ info }) => info.id,
  ),
  /** Chats that one visitor may send in a day, in each lane. */
  chatsPerDay: { private: 10, open: 10 },
  /**
   * What the trial of a lane may cost in a day, in USD. Past it, the lane pauses until 00:00 UTC.
   * The hard limits sit at the providers: an OpenRouter key with $50 of credit, and $15 on Tinfoil.
   */
  dailyBudgetUsd: { private: 2, open: 5 },
  /**
   * The usage counted for an answer whose provider reported none: one chat of docs/CONCEPT.md,
   * 1,000 tokens in and 500 out, at the price of the model in the catalog.
   */
  fallbackUsage: { inputTokens: 1_000, outputTokens: 500 },
} as const satisfies {
  modelIds: readonly string[];
  chatsPerDay: Readonly<Record<Lane, number>>;
  dailyBudgetUsd: Readonly<Record<Lane, number>>;
  fallbackUsage: ChatUsage;
};
