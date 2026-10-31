// Who may chat, with which model, and how much (decision 67). 'full' admits every chat. 'trial'
// opens the models of config/trial.ts but the dearest, counts the chats of each visitor, and pauses
// a lane past its daily budget.
// Counts live in memory and start again at 00:00 UTC or when the proxy restarts.
import { trialModelIds } from '../catalog.js';
import { MESSAGES } from '../config/messages.js';
import { TRIAL } from '../config/trial.js';
import type { AccessMode, AccessStatus, Lane, LaneAccess } from '../contract.js';
import { ProxyError } from '../lib/errors.js';
import type { LogLine } from '../lib/log.js';

export interface Access {
  readonly mode: AccessMode;
  /** True when the model is open in this mode. */
  opens: (modelId: string) => boolean;
  /** Takes one chat of the visitor in the lane, or throws a ProxyError when none is left today. */
  admit: (visitor: string, lane: Lane, nowMs: number) => void;
  /** Gives the chat back when the provider failed before the answer started. */
  refund: (visitor: string, lane: Lane, nowMs: number) => void;
  /** Adds the cost of an answer to what its lane spent today. */
  spend: (lane: Lane, usd: number, nowMs: number) => void;
  /**
   * Takes one request of Voice of the visitor (26 Oct 2026), a recording or a part to speak, or
   * throws: when the private lane spent its budget, when the visitor sent the requests of Voice of
   * a day, or, with `needsChat`, when no chat of the private lane is left for the answer.
   */
  admitVoice: (visitor: string, needsChat: boolean, nowMs: number) => void;
  /** Gives the request of Voice back when the enclave failed. */
  refundVoice: (visitor: string, nowMs: number) => void;
  status: (visitor: string, nowMs: number) => AccessStatus;
}

export function createAccess(mode: AccessMode, log: LogLine): Access {
  return mode === 'full' ? FULL_ACCESS : createTrialAccess(log);
}

/** Throws when the model is closed in this mode, as on the free trial. */
export function assertOpen(access: Access, modelId: string): void {
  if (!access.opens(modelId)) throw new ProxyError('model_unavailable', MESSAGES.trialLocked);
}

const FULL_ACCESS: Access = {
  mode: 'full',
  opens: () => true,
  admit: () => undefined,
  refund: () => undefined,
  spend: () => undefined,
  admitVoice: () => undefined,
  refundVoice: () => undefined,
  status: () => ({ mode: 'full' }),
};

interface Day {
  readonly key: string;
  /** Chats of each visitor in each lane, keyed '<lane>:<visitor>'. */
  readonly chats: Map<string, number>;
  /** Requests of Voice of each visitor. */
  readonly voice: Map<string, number>;
  readonly spentUsd: Record<Lane, number>;
}

const TRIAL_MODELS: ReadonlySet<string> = new Set(trialModelIds());

export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 'YYYY-MM-DD'.length);
}

function newDay(key: string): Day {
  return { key, chats: new Map(), voice: new Map(), spentUsd: { private: 0, open: 0 } };
}

function createTrialAccess(log: LogLine): Access {
  let day: Day = newDay('');

  const today = (nowMs: number): Day => {
    const key = utcDay(nowMs);
    if (day.key !== key) day = newDay(key);
    return day;
  };
  const chatsOf = (current: Day, visitor: string, lane: Lane): number =>
    current.chats.get(`${lane}:${visitor}`) ?? 0;
  const paused = (current: Day, lane: Lane): boolean =>
    current.spentUsd[lane] >= TRIAL.dailyBudgetUsd[lane];
  const laneAccess = (current: Day, visitor: string, lane: Lane): LaneAccess => ({
    chatsPerDay: TRIAL.chatsPerDay[lane],
    chatsLeft: Math.max(0, TRIAL.chatsPerDay[lane] - chatsOf(current, visitor, lane)),
    paused: paused(current, lane),
  });

  return {
    mode: 'trial',
    opens: (modelId) => TRIAL_MODELS.has(modelId),
    admit(visitor, lane, nowMs) {
      const current = today(nowMs);
      if (paused(current, lane)) throw new ProxyError('trial_paused', MESSAGES.trialPaused);
      const used = chatsOf(current, visitor, lane);
      if (used >= TRIAL.chatsPerDay[lane]) {
        throw new ProxyError('quota_exceeded', MESSAGES.quotaExceeded);
      }
      current.chats.set(`${lane}:${visitor}`, used + 1);
    },
    refund(visitor, lane, nowMs) {
      const current = today(nowMs);
      const used = chatsOf(current, visitor, lane);
      if (used > 0) current.chats.set(`${lane}:${visitor}`, used - 1);
    },
    spend(lane, usd, nowMs) {
      const current = today(nowMs);
      const wasPaused = paused(current, lane);
      current.spentUsd[lane] += usd;
      if (!wasPaused && paused(current, lane)) {
        log(`Trial paused: the ${lane} lane spent its budget for ${current.key}.`);
      }
    },
    admitVoice(visitor, needsChat, nowMs) {
      const current = today(nowMs);
      if (paused(current, 'private')) throw new ProxyError('trial_paused', MESSAGES.trialPaused);
      if (needsChat && chatsOf(current, visitor, 'private') >= TRIAL.chatsPerDay.private) {
        throw new ProxyError('quota_exceeded', MESSAGES.quotaExceeded);
      }
      const used = current.voice.get(visitor) ?? 0;
      if (used >= TRIAL.voiceRequestsPerDay) {
        throw new ProxyError('quota_exceeded', MESSAGES.voiceQuotaExceeded);
      }
      current.voice.set(visitor, used + 1);
    },
    refundVoice(visitor, nowMs) {
      const current = today(nowMs);
      const used = current.voice.get(visitor) ?? 0;
      if (used > 0) current.voice.set(visitor, used - 1);
    },
    status(visitor, nowMs) {
      const current = today(nowMs);
      return {
        mode: 'trial',
        lanes: {
          private: laneAccess(current, visitor, 'private'),
          open: laneAccess(current, visitor, 'open'),
        },
      };
    },
  };
}
