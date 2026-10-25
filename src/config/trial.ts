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
   * model then shows "credit". The dearest models below take credit too (catalog.ts).
   */
  modelIds: MODEL_CATALOG.filter(({ info }) => info.available && info.kind !== 'video').map(
    ({ info }) => info.id,
  ),
  /**
   * The dearest models take credit only, so that a few chats cannot spend the budget of a lane for
   * every visitor (the plan that the owner approved with the catalog of 25 Oct 2026): a chat model
   * whose chat of fallbackUsage costs more than chatUsd at the price that the user pays, and an
   * image model whose image costs more than imageUsd. On 25 Oct 2026 a chat of Claude Opus 5.5
   * cost about $0.01 and one of GPT-5.5 Pro $0.09; an image of Nano Banana Pro about $0.18 and
   * one of GPT Image 1 about $0.31.
   */
  dearest: { chatUsd: 0.02, imageUsd: 0.2 },
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
  dearest: { chatUsd: number; imageUsd: number };
  chatsPerDay: Readonly<Record<Lane, number>>;
  dailyBudgetUsd: Readonly<Record<Lane, number>>;
  fallbackUsage: ChatUsage;
};
