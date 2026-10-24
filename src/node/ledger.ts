// The ledger in one SQLite file, with node:sqlite of Node 22. Each change is one transaction, so a
// crash never leaves a voucher spent without its credit. Until 24 Oct 2026 the file also held the
// payments and the THKR of the issuer, which then moved to the ledger of the issuer
// (apps/issuer/).
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Ledger, MergeResult, RedeemResult } from '../credit/ledger.js';

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

  return {
    redeem(voucherHash, balanceHash, micros): RedeemResult {
      return transaction(
        (): RedeemResult => {
          if (insertSpent.run(voucherHash).changes === 0) return 'spent';
          fillBalance.run(balanceHash, micros);
          return 'ok';
        },
        (result) => result === 'ok',
      );
    },
    balance,
    charge(balanceHash, micros) {
      chargeBalance.run(micros, balanceHash);
    },
    mergeBalance(fromHash, intoHash): MergeResult {
      return transaction(
        (): MergeResult => {
          const micros = balance(fromHash);
          if (micros === null) return 'unknown';
          fillBalance.run(intoHash, micros);
          closeBalance.run(fromHash);
          return 'ok';
        },
        (result) => result === 'ok',
      );
    },
    settleJob(jobHash, balanceHash, refundMicros): boolean {
      return transaction(
        () => {
          if (insertSettledJob.run(jobHash).changes === 0) return false;
          if (balanceHash !== null && refundMicros !== 0) {
            chargeBalance.run(-refundMicros, balanceHash);
          }
          return true;
        },
        (settled) => settled,
      );
    },
  };
}
