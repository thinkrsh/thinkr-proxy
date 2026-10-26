// Who pays for a chat: a balance that the request names in the balance header (decision 48), or
// else the free trial of the visitor (decision 67). A paid chat skips the limits and the locks of
// the trial, and its balance must cover the input and a reserve for the answer before it starts.
import type { Context } from 'hono';

import { CREDIT } from '../config/credit.js';
import type { CatalogModel } from '../config/models.js';
import { MESSAGES } from '../config/messages.js';
import {
  balanceHash,
  chatPriceMicros,
  isBalanceSecret,
  jobHash,
  premiumPriceMicros,
  reserveMicros,
  usdToMicros,
  type PremiumPrice,
} from '../credit/balance.js';
import type { Ledger } from '../credit/ledger.js';
import type { Lane } from '../contract.js';
import type { ChatSpend } from '../lib/cost.js';
import { ProxyError } from '../lib/errors.js';
import { assertOpen, type Access } from './access.js';

/** A balance that a request names, with what was left on it when the request came in. */
export interface Balance {
  readonly hash: string;
  readonly micros: number;
}

export interface Payer {
  /** The key of the visitor, for the free trial. Never the address itself. */
  readonly visitor: string;
  readonly balance: Balance | null;
}

/** One admitted chat. */
export interface ChatTicket {
  /** The provider failed before the answer started, so the chat costs nothing. */
  refund: () => void;
  /** The answer is over; it spent this much at the provider. */
  charge: (spend: ChatSpend) => void;
}

/** What a chat asks for beyond its tokens. */
export interface ChatOptions {
  /** Web search is on (decision 142): the reserve of a balance holds its price. */
  readonly webSearch: boolean;
  /**
   * The request costs more than the defaults of its model, such as an image of a larger size or
   * of several photos (25 Oct 2026), or a long text to read (26 Oct 2026): only a balance pays, as
   * for a model locked for credit.
   */
  readonly creditOnly?: boolean;
  /** What the free trial hears when it asks for more than it pays; else that of an image. */
  readonly creditOnlyMessage?: string;
}

const PLAIN_CHAT: ChatOptions = { webSearch: false };

/** A request at a fixed price in a lane, such as one document to convert (decision 142). */
export interface Fee {
  readonly lane: Lane;
  /** What a balance pays. */
  readonly priceUsd: number;
  /** What the provider charges, which the free trial counts against its budget of the day. */
  readonly costUsd: number;
}

/** One admitted request at a fixed price. */
export interface FeeTicket {
  /** The provider failed, so the request costs nothing. */
  refund: () => void;
  /** The request went through, so its payer pays. */
  charge: () => void;
}

/** One admitted Premium request: a balance pays it, or the free trial for Voice. */
export interface PremiumTicket {
  /** The enclave failed, so the request costs nothing. */
  refund: () => void;
  /** The request went through; the enclave reported this cost, or null without a report. */
  charge: (reportedCostUsd: number | null) => void;
}

/**
 * How the free trial takes a request of Voice (the owner, 26 Oct 2026: Voice opens without a
 * top-up). Its cost counts against the budget of the private lane, and each turn of Voice mode
 * still takes one chat of the private lane through its answer.
 */
export interface TrialTerms {
  /** What the request costs at the enclave when the enclave reports nothing. */
  readonly costUsd: number;
  /** A recording needs a chat of the private lane left for its answer; a part to speak does not. */
  readonly needsChat: boolean;
}

const FREE_PREMIUM: PremiumTicket = { refund: () => undefined, charge: () => undefined };

/**
 * What a balance paid ahead for a video job (the owner, 23 Oct 2026). The ticket of the job carries
 * it, so that the proxy keeps no record of the job until it settles.
 */
export interface Prepayment {
  /** The hash of the balance that paid, or null when nobody paid, as in the mode 'full'. */
  readonly balanceHash: string | null;
  readonly micros: number;
}

/** One admitted video job, which only a balance pays, ahead. */
export interface PrepaidTicket {
  /** The provider took the job, so the balance pays its price now. */
  pay: () => Prepayment;
}

const FREE_PREPAID: PrepaidTicket = { pay: () => ({ balanceHash: null, micros: 0 }) };

export interface Gate {
  /** The balance named by the request, or null. Throws `balance_unknown` for one that is not. */
  balanceOf: (c: Context) => Promise<Balance | null>;
  /**
   * Admits a chat with a model whose lane and availability were checked, or throws. `inputUnits`
   * is the size of the chat: its characters, or the bytes of a sealed body.
   */
  admit: (
    payer: Payer,
    model: CatalogModel,
    inputUnits: number,
    options?: ChatOptions,
  ) => ChatTicket;
  /**
   * Admits a request at a fixed price (decision 142), or throws. On the free trial it counts as one
   * chat of the visitor in its lane, and its cost counts against the budget of the lane.
   */
  admitFee: (payer: Payer, fee: Fee) => FeeTicket;
  /**
   * Admits a Premium request at its price: voice and the privacy filter of the private lane (the
   * owner, 23 Oct 2026). A balance pays it. The free trial takes a request that comes with `trial`
   * terms, Voice since 26 Oct 2026, and gets `model_unavailable` for any other, as for a model
   * locked for credit. The mode 'full' of the laptop admits it free, as it does every chat.
   */
  admitPremium: (payer: Payer, price: PremiumPrice, trial?: TrialTerms) => PremiumTicket;
  /**
   * Admits a video job at its price, about, which the balance pays once the provider takes the
   * job (the owner, 23 Oct 2026). Only a balance pays; the free trial gets `model_unavailable`, with
   * `creditOnlyMessage` when given. The mode 'full' of the laptop admits it free.
   */
  admitPrepaid: (payer: Payer, priceMicros: number, creditOnlyMessage?: string) => PrepaidTicket;
  /**
   * Settles a video job, once: the balance gets back what it paid ahead beyond `finalMicros`, or
   * pays the rest when the job cost more. A second settlement of the same job changes nothing.
   */
  settleJob: (jobId: string, prepayment: Prepayment, finalMicros: number) => Promise<void>;
}

export interface GateDeps {
  readonly access: Access;
  readonly ledger: Ledger;
  readonly now: () => number;
}

export function createGate(deps: GateDeps): Gate {
  return {
    async balanceOf(c) {
      const secret = c.req.header(CREDIT.balanceHeader);
      if (secret === undefined) return null;
      if (!isBalanceSecret(secret)) {
        throw new ProxyError('balance_unknown', MESSAGES.balanceUnknown);
      }
      const hash = await balanceHash(secret);
      const micros = deps.ledger.balance(hash);
      if (micros === null) throw new ProxyError('balance_unknown', MESSAGES.balanceUnknown);
      return { hash, micros };
    },
    admit(payer, model, inputUnits, options = PLAIN_CHAT) {
      const { balance } = payer;
      if (balance === null) {
        if (options.creditOnly === true && deps.access.mode !== 'full') {
          throw new ProxyError(
            'model_unavailable',
            options.creditOnlyMessage ?? MESSAGES.imageCreditOnly,
          );
        }
        return admitOnTrial(deps, payer.visitor, model);
      }
      if (balance.micros < reserveMicros(model, inputUnits, options.webSearch)) {
        throw new ProxyError('balance_low', MESSAGES.balanceLow);
      }
      return {
        refund: () => undefined,
        charge: (spend) => {
          // The totals of decision 191 count chat, image, and video; audio counts as chat, as the
          // voice of the private lane does.
          const use = model.info.kind === 'image' ? 'image' : 'chat';
          deps.ledger.charge(balance.hash, chatPriceMicros(model, spend), use, deps.now());
        },
      };
    },
    admitFee(payer, fee) {
      const { balance } = payer;
      if (balance === null) return admitFeeOnTrial(deps, payer.visitor, fee);
      const price = usdToMicros(fee.priceUsd);
      if (balance.micros < price) throw new ProxyError('balance_low', MESSAGES.balanceLow);
      return {
        refund: () => undefined,
        charge: () => {
          deps.ledger.charge(balance.hash, price, 'chat', deps.now());
        },
      };
    },
    admitPremium(payer, price, trial) {
      const { balance } = payer;
      if (balance === null) {
        if (deps.access.mode === 'full') return FREE_PREMIUM;
        if (trial === undefined) throw new ProxyError('model_unavailable', MESSAGES.premiumOnly);
        return admitVoiceOnTrial(deps, payer.visitor, trial);
      }
      // A request with no fixed price still needs credit left, as its cost comes after.
      if (balance.micros <= 0 || balance.micros < usdToMicros(price.fixedUsd)) {
        throw new ProxyError('balance_low', MESSAGES.balanceLow);
      }
      return {
        refund: () => undefined,
        charge: (reportedCostUsd) => {
          const micros = premiumPriceMicros(price, reportedCostUsd);
          deps.ledger.charge(balance.hash, micros, 'chat', deps.now());
        },
      };
    },
    admitPrepaid(payer, priceMicros, creditOnlyMessage = MESSAGES.videoCreditOnly) {
      const { balance } = payer;
      if (balance === null) {
        if (deps.access.mode === 'full') return FREE_PREPAID;
        throw new ProxyError('model_unavailable', creditOnlyMessage);
      }
      if (balance.micros < priceMicros) throw new ProxyError('balance_low', MESSAGES.balanceLow);
      return {
        pay: () => {
          deps.ledger.charge(balance.hash, priceMicros, 'video', deps.now());
          return { balanceHash: balance.hash, micros: priceMicros };
        },
      };
    },
    async settleJob(jobId, prepayment, finalMicros) {
      deps.ledger.settleJob(
        await jobHash(jobId),
        prepayment.balanceHash,
        prepayment.micros - finalMicros,
        deps.now(),
      );
    },
  };
}

/**
 * The free trial pays the fees of web search and documents too ("gpp kena $0.05 juga", 22 Oct
 * 2026): a document takes one chat of the visitor, and its cost goes into the budget of the lane.
 */
function admitFeeOnTrial(deps: GateDeps, visitor: string, fee: Fee): FeeTicket {
  deps.access.admit(visitor, fee.lane, deps.now());
  return {
    refund: () => {
      deps.access.refund(visitor, fee.lane, deps.now());
    },
    charge: () => {
      deps.access.spend(fee.lane, fee.costUsd, deps.now());
    },
  };
}

/** A request of Voice on the free trial: counted for the visitor, paid from the private lane. */
function admitVoiceOnTrial(deps: GateDeps, visitor: string, trial: TrialTerms): PremiumTicket {
  deps.access.admitVoice(visitor, trial.needsChat, deps.now());
  return {
    refund: () => {
      deps.access.refundVoice(visitor, deps.now());
    },
    charge: (reportedCostUsd) => {
      deps.access.spend('private', reportedCostUsd ?? trial.costUsd, deps.now());
    },
  };
}

function admitOnTrial(deps: GateDeps, visitor: string, model: CatalogModel): ChatTicket {
  const lane = model.info.lane;
  assertOpen(deps.access, model.info.id);
  deps.access.admit(visitor, lane, deps.now());
  return {
    refund: () => {
      deps.access.refund(visitor, lane, deps.now());
    },
    charge: (spend) => {
      deps.access.spend(lane, spend.costUsd, deps.now());
    },
  };
}
