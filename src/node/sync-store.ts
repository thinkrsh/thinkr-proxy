// The encrypted backups in one SQLite file next to the ledger, with node:sqlite of Node 22. A write
// names the tag that it replaces, so of two devices that write at once, one writes and the other
// learns that the backup changed.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { BackupHead, SyncStore } from '../sync/store.js';

const IN_MEMORY = ':memory:';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS backups (
    store_id TEXT PRIMARY KEY,
    etag TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    body TEXT NOT NULL
  ) STRICT;
`;

/** Opens the backups in `file`, or in memory for ':memory:', and makes the table when missing. */
export function openSyncStore(file: string): SyncStore {
  if (file !== IN_MEMORY) mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  db.exec(SCHEMA);

  const selectHead = db.prepare('SELECT etag, token_hash, bytes FROM backups WHERE store_id = ?');
  const selectBody = db.prepare('SELECT body FROM backups WHERE store_id = ?');
  const insertBackup = db.prepare(
    'INSERT OR IGNORE INTO backups (store_id, etag, token_hash, bytes, body) VALUES (?, ?, ?, ?, ?)',
  );
  const replaceBackup = db.prepare(
    'UPDATE backups SET etag = ?, token_hash = ?, bytes = ?, body = ? ' +
      'WHERE store_id = ? AND etag = ?',
  );
  const deleteBackup = db.prepare('DELETE FROM backups WHERE store_id = ?');
  const sumBytes = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM backups');

  return {
    head(storeId): BackupHead | undefined {
      const row = selectHead.get(storeId);
      if (row === undefined) return undefined;
      const { etag, token_hash: tokenHash, bytes } = row;
      if (typeof etag !== 'string' || typeof tokenHash !== 'string' || typeof bytes !== 'number') {
        throw new Error(`The backup ${storeId} has a row of another shape.`);
      }
      return { etag, tokenHash, bytes };
    },
    body(storeId) {
      const value = selectBody.get(storeId)?.body;
      return typeof value === 'string' ? value : undefined;
    },
    putIf(storeId, backup, expected) {
      const { etag, tokenHash, bytes, body } = backup;
      const result =
        expected === undefined
          ? insertBackup.run(storeId, etag, tokenHash, bytes, body)
          : replaceBackup.run(etag, tokenHash, bytes, body, storeId, expected);
      return result.changes === 1;
    },
    delete(storeId) {
      deleteBackup.run(storeId);
    },
    totalBytes() {
      const value = sumBytes.get()?.total;
      return typeof value === 'number' ? value : 0;
    },
  };
}
