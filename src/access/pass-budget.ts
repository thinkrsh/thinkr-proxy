// What the free chats of holders may cost in a day (config/holderPass.ts). The count lives in memory
// and starts again at 00:00 UTC or when the proxy restarts, as those of the free trial do.
import { HOLDER_PASS } from '../config/holderPass.js';
import type { LogLine } from '../lib/log.js';
import { utcDay } from './access.js';

export interface PassBudget {
  /** True once free chats spent the budget of today. */
  paused: (nowMs: number) => boolean;
  /** Adds the cost of a free chat to what they spent today. */
  spend: (usd: number, nowMs: number) => void;
}

export function createPassBudget(log: LogLine): PassBudget {
  let day = '';
  let spentUsd = 0;
  const spentToday = (nowMs: number): number => {
    const key = utcDay(nowMs);
    if (day !== key) {
      day = key;
      spentUsd = 0;
    }
    return spentUsd;
  };
  return {
    paused: (nowMs) => spentToday(nowMs) >= HOLDER_PASS.dailyBudgetUsd,
    spend(usd, nowMs) {
      const before = spentToday(nowMs);
      spentUsd = before + usd;
      if (before < HOLDER_PASS.dailyBudgetUsd && spentUsd >= HOLDER_PASS.dailyBudgetUsd) {
        log(`Free chats paused: they spent their budget for ${day}.`);
      }
    },
  };
}
