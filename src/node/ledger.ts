// The ledger in one SQLite file, with node:sqlite of Node 22. Each change is one transaction, so a
// crash never leaves a voucher spent without its credit. Until 24 Oct 2026 the file also held the
// payments and the THKR of the issuer, which then moved to the ledger of the issuer
// (apps/issuer/).
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  CreditUse,
  HolderTotals,
  Ledger,
  MergeResult,
  RedeemResult,
} from '../credit/ledger.js';

const IN_MEMORY = ':memory:';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS spent_vouchers (
    voucher_hash TEXT PRIMARY KEY
  ) STRICT;
  CREATE TABLE IF NOT EXISTS balances (
    balance_hash TEXT PRIMARY KEY,
    micros INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS settled_jobs (
    job_hash TEXT PRIMARY KEY
  ) STRICT;
  CREATE TABLE IF NOT EXISTS holder_balances (
    balance_hash TEXT PRIMARY KEY,
    micros INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS holder_redeemed (
    month TEXT PRIMARY KEY,
    vouchers INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS holder_spent (
    month TEXT NOT NULL,
    use TEXT NOT NULL CHECK (use IN ('chat', 'image', 'video')),
    micros INTEGER NOT NULL,
    PRIMARY KEY (month, use)
  ) STRICT;
`;

/** Opens the ledger in `file`, or in memory for ':memory:', and makes its tables when missing. */
export function openLedger(file: string): Ledger {
  if (file !== IN_MEMORY) mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  db.exec(SCHEMA);

  const insertSpent = db.prepare('INSERT OR IGNORE INTO spent_vouchers (voucher_hash) VALUES (?)');
  const selectBalance = db.prepare('SELECT micros FROM balances WHERE balance_hash = ?');
  const fillBalance = db.prepare(
    'INSERT INTO balances (balance_hash, micros) VALUES (?, ?) ' +
      'ON CONFLICT (balance_hash) DO UPDATE SET micros = micros + excluded.micros',
  );
  const chargeBalance = db.prepare(
    'UPDATE balances SET micros = micros - ? WHERE balance_hash = ?',
  );
  const closeBalance = db.prepare('DELETE FROM balances WHERE balance_hash = ?');
  const insertSettledJob = db.prepare('INSERT OR IGNORE INTO settled_jobs (job_hash) VALUES (?)');
  const selectHolder = db.prepare('SELECT micros FROM holder_balances WHERE balance_hash = ?');
  const fillHolder = db.prepare(
    'INSERT INTO holder_balances (balance_hash, micros) VALUES (?, ?) ' +
      'ON CONFLICT (balance_hash) DO UPDATE SET micros = micros + excluded.micros',
  );
  const closeHolder = db.prepare('DELETE FROM holder_balances WHERE balance_hash = ?');
  const countRedeemed = db.prepare(
    'INSERT INTO holder_redeemed (month, vouchers) VALUES (?, 1) ' +
      'ON CONFLICT (month) DO UPDATE SET vouchers = vouchers + 1',
  );
  const countSpent = db.prepare(
    'INSERT INTO holder_spent (month, use, micros) VALUES (?, ?, ?) ' +
      'ON CONFLICT (month, use) DO UPDATE SET micros = micros + excluded.micros',
  );
  const selectRedeemed = db.prepare('SELECT month, vouchers FROM holder_redeemed ORDER BY month');
  const selectSpent = db.prepare('SELECT month, use, micros FROM holder_spent ORDER BY month, use');

  const transaction = <T>(work: () => T, keep: (result: T) => boolean): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec(keep(result) ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  const balance = (balanceHash: string): number | null => {
    const value = selectBalance.get(balanceHash)?.micros;
    return typeof value === 'number' ? value : null;
  };

  /** Takes a price from a balance, the credit of holder vouchers first, and counts that part. */
  const take = (balanceHash: string, micros: number, use: CreditUse, at: number): void => {
    chargeBalance.run(micros, balanceHash);
    const holder = selectHolder.get(balanceHash)?.micros;
    const fromHolder = typeof holder === 'number' ? Math.min(Math.max(holder, 0), micros) : 0;
    if (fromHolder <= 0) return;
    fillHolder.run(balanceHash, -fromHolder);
    countSpent.run(monthOf(at), use, fromHolder);
  };

  return {
    redeem(voucherHash, balanceHash, micros, holderMonth): RedeemResult {
      return transaction(
        (): RedeemResult => {
          if (insertSpent.run(voucherHash).changes === 0) return 'spent';
          fillBalance.run(balanceHash, micros);
          if (holderMonth !== null) {
            fillHolder.run(balanceHash, micros);
            countRedeemed.run(holderMonth);
          }
          return 'ok';
        },
        (result) => result === 'ok',
      );
    },
    balance,
    holderBalance(balanceHash) {
      const total = balance(balanceHash);
      if (total === null) return null;
      const holder = selectHolder.get(balanceHash)?.micros;
      // A balance in debt has no holder credit left, whatever its holder part says.
      return typeof holder === 'number' ? Math.min(holder, total) : 0;
    },
    charge(balanceHash, micros, use, at) {
      transaction(
        () => {
          take(balanceHash, micros, use, at);
        },
        () => true,
      );
    },
    mergeBalance(fromHash, intoHash): MergeResult {
      return transaction(
        (): MergeResult => {
          const micros = balance(fromHash);
          if (micros === null) return 'unknown';
          fillBalance.run(intoHash, micros);
          closeBalance.run(fromHash);
          const holder = selectHolder.get(fromHash)?.micros;
          if (typeof holder === 'number') {
            fillHolder.run(intoHash, holder);
            closeHolder.run(fromHash);
          }
          return 'ok';
        },
        (result) => result === 'ok',
      );
    },
    settleJob(jobHash, balanceHash, refundMicros, at): boolean {
      return transaction(
        () => {
          if (insertSettledJob.run(jobHash).changes === 0) return false;
          if (balanceHash === null || refundMicros === 0) return true;
          // A refund goes back as plain credit, so the totals keep the video as paid ahead.
          if (refundMicros > 0) chargeBalance.run(-refundMicros, balanceHash);
          else take(balanceHash, -refundMicros, 'video', at);
          return true;
        },
        (settled) => settled,
      );
    },
    holderTotals(): HolderTotals {
      return {
        redeemed: selectRedeemed.all().map((row) => ({
          month: String(row.month),
          vouchers: Number(row.vouchers),
        })),
        spent: selectSpent.all().map((row) => ({
          month: String(row.month),
          use: useOf(row.use),
          micros: Number(row.micros),
        })),
      };
    },
  };
}

/** The month of UTC of a time, as "2026-10". */
function monthOf(at: number): string {
  return new Date(at).toISOString().slice(0, 'YYYY-MM'.length);
}

function useOf(value: unknown): CreditUse {
  if (value === 'chat' || value === 'image' || value === 'video') return value;
  throw new Error('The ledger holds a use of credit it does not know.');
}
