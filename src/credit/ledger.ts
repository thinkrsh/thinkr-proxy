// What the proxy must remember for credit: the vouchers spent, the balances, and the video jobs
// settled. It holds hashes only, and no address, no wallet, and no time of a chat, so that a
// payment does not link to a chat (decision 37). The payments live in the issuer (apps/issuer/),
// which never sees a voucher. The Node entry keeps it in SQLite (node/ledger.ts).

export type RedeemResult = 'ok' | 'spent';

/** 'unknown': the balance to close does not exist, so nothing moved. */
export type MergeResult = 'ok' | 'unknown';

export interface Ledger {
  /**
   * Spends a voucher into a balance in one step, and opens the balance when it is new. Nothing
   * changes unless both parts succeed.
   */
  redeem: (voucherHash: string, balanceHash: string, micros: number) => RedeemResult;
  /** What is left on a balance, in millionths of a dollar, or null when there is no such balance. */
  balance: (balanceHash: string) => number | null;
  /** Takes the price of a chat from a balance. The balance may end below zero by that one chat. */
  charge: (balanceHash: string, micros: number) => void;
  /**
   * Moves what is left on one balance onto another, which opens when it is new, and closes the
   * first, in one step. A balance below zero moves its debt along.
   */
  mergeBalance: (fromHash: string, intoHash: string) => MergeResult;
  /**
   * Settles a video job that a balance paid ahead (the owner, 23 Oct 2026), once: records the hash
   * of the job, and gives `refundMicros` back to the balance (less than zero takes more). False when
   * the job was settled before, so nothing changes. It keeps no balance, no time, and no prompt
   * beside the hash.
   */
  settleJob: (jobHash: string, balanceHash: string | null, refundMicros: number) => boolean;
}
