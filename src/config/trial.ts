// The free trial of decision 67: what a visitor may use before the top-up exists. The day of every
// count and budget starts at 00:00 UTC. Change the numbers here only.
import type { ChatUsage, Lane } from '../contract.js';
import { MODEL_CATALOG } from './models.js';

export const TRIAL = {
  /**
   * The models open in the trial, by catalog id: every model that the proxy serves, since 22 Oct
   * 2026 ("gpp buka aja semua"), but video, which takes credit only (the owner, 23 Oct 2026): one
   * video costs more than a day of chats, and so does a sourced video (decision 216). An image, or a
   * piece of audio (26 Oct 2026), counts as one chat of its lane. The counts and budgets below still
   * hold. To lock models for credit again, list the open ids here; every other
   * model then shows "credit". The dearest models below take credit too (catalog.ts).
   */
  modelIds: MODEL_CATALOG.filter(
    ({ info }) => info.available && info.kind !== 'video' && info.kind !== 'sourcedVideo',
  ).map(({ info }) => info.id),
  /**
   * The dearest models take credit only, so that a few chats cannot spend the budget of a lane for
   * every visitor (the plan that the owner approved with the catalog of 25 Oct 2026): a chat model
   * whose chat of fallbackUsage costs more than chatUsd at the price that the user pays, and an
   * image model whose image costs more than imageUsd. On 25 Oct 2026 a chat of Claude Opus 5.5
   * cost about $0.01 and one of GPT-5.5 Pro $0.09; an image of Nano Banana Pro about $0.18 and
   * one of GPT Image 1 about $0.31.
   */
  dearest: { chatUsd: 0.02, imageUsd: 0.2 },
  /**
   * Chats that one visitor may send in a day, in each lane: 10 until the owner, 31 Oct 2026: "kurangin
   * dari trial 10x chat jadi cuman 3", as a holder of 1M THKR now chats free (config/holderPass.ts).
   * Must match `trialChatsPerDay` of apps/site-v2/src/config/pricing.ts and the docs.
   */
  chatsPerDay: { private: 3, open: 3 },
  /**
   * What the trial of a lane may cost in a day, in USD. Past it, the lane pauses until 00:00 UTC.
   * The private lane went from $2 to $5 with Voice on the trial (the owner, 26 Oct 2026: "budget
   * harian naikin jadi $5 sekarang mulai banyak pengunjung app kita takut kehabisan"), and the open
   * lane from $5 to $25 (the owner, 26 Oct 2026: "Open Router kasih $25 aja"). The hard limits
   * sit at the providers: an OpenRouter key limited to $250 (GET /api/v1/key, read 26 Oct 2026),
   * and $15 on Tinfoil.
   */
  dailyBudgetUsd: { private: 5, open: 25 },
  /**
   * Requests of Voice that one visitor may send in a day on the trial (26 Oct 2026): recordings
   * and parts of answers to speak. Each turn of Voice mode is one recording, one chat of the private
   * lane, and a few parts read aloud, so the chats of a day run out first, while one visitor cannot
   * spend the budget of the lane on speech alone (at $0.002 a part at Tinfoil, 60 parts cost $0.12).
   */
  voiceRequestsPerDay: 60,
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
  voiceRequestsPerDay: number;
  fallbackUsage: ChatUsage;
};
