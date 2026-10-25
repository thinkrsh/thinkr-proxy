// What the proxy must remember for credit: the vouchers spent, the balances, and the video jobs
// settled. It holds hashes only, and no address, no wallet, and no time of a chat, so that a
// payment does not link to a chat (decision 37). The payments live in the issuer (apps/issuer/),
// which never sees a voucher. The Node entry keeps it in SQLite (node/ledger.ts).
//
// Holder vouchers (decisions 189 and 191) fill a balance like any voucher. The ledger also keeps
// how much of each balance came from them, spends that part first, and counts, by month, the
// holder vouchers spent into balances and what their credit paid for, with no balance in the
// totals.

/** What credit pays for, in the totals of holder vouchers (decision 191). */
export type CreditUse = 'chat' | 'image' | 'video';

/** The totals of holder vouchers, by month of UTC, with no balance. */
export interface HolderTotals {
  /** Holder vouchers spent into balances, by the month of their key. */
  readonly redeemed: readonly { readonly month: string; readonly vouchers: number }[];
  /** Their credit paid for each use, in millionths of a dollar, by the month of the payment. */
  readonly spent: readonly {
    readonly month: string;
    readonly use: CreditUse;
    readonly micros: number;
  }[];
}

export type RedeemResult = 'ok' | 'spent';

/** 'unknown': the balance to close does not exist, so nothing moved. */
export type MergeResult = 'ok' | 'unknown';

export interface Ledger {
  /**
   * Spends a voucher into a balance in one step, and opens the balance when it is new. Nothing
   * changes unless both parts succeed. `holderMonth` names the month of the key of a holder
   * voucher, or is null for the voucher of a top-up.
   */
  redeem: (
    voucherHash: string,
    balanceHash: string,
    micros: number,
    holderMonth: string | null,
  ) => RedeemResult;
  /** What is left on a balance, in millionths of a dollar, or null when there is no such balance. */
  balance: (balanceHash: string) => number | null;
  /**
   * Takes the price of a chat, an image, or a video from a balance, at `at`. The balance may end
   * below zero by that one request. The credit of holder vouchers goes first.
   */
  charge: (balanceHash: string, micros: number, use: CreditUse, at: number) => void;
  /**
   * Moves what is left on one balance onto another, which opens when it is new, and closes the
   * first, in one step. A balance below zero moves its debt along.
   */
  mergeBalance: (fromHash: string, intoHash: string) => MergeResult;
  /**
   * Settles a video job that a balance paid ahead (the owner, 23 Oct 2026), once: records the hash
   * of the job, and gives `refundMicros` back to the balance (less than zero takes more). False when
   * the job was settled before, so nothing changes. It keeps no balance, no time, and no prompt
   * beside the hash. A refund goes back as plain credit; more to pay counts as video at `at`.
   */
  settleJob: (
    jobHash: string,
    balanceHash: string | null,
    refundMicros: number,
    at: number,
  ) => boolean;
  holderTotals: () => HolderTotals;
}
