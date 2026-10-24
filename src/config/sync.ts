// The encrypted backups of the app (the owner, 23 Oct 2026: "oh ok boleh pakai passkey dan kode
// pemulihan", then "Gas" for credit and chats together): the sync protocol of apps/sync, one sealed
// backup for each store ID. The proxy holds no key, so it cannot read a backup. Change the numbers
// here only.
export const SYNC = {
  /** The route of the backups, under the base path. Must match BACKUP.syncPath of the app. */
  path: '/sync',
  /** The SQLite file of the backups, in the folder of the ledger (DATABASE_FILE). */
  databaseFileName: 'backups.db',
  /**
   * The largest backup, as the reference server of apps/sync (src/config/server.ts). Must match
   * BACKUP.maxBytes of the app.
   */
  maxBackupBytes: 33_554_432,
  /** All backups together. Past it, the proxy takes no new backup and lets none grow. */
  maxTotalBytes: 5_368_709_120,
  /** A store ID and a write token: the hex of 32 bytes. Must match apps/sync/src/config/server.ts. */
  storeIdPattern: /^[0-9a-f]{64}$/,
  writeTokenPattern: /^[0-9a-f]{64}$/,
  /** The envelope of a backup. Must match FORMAT of apps/sync/src/config/format.ts. */
  formatVersion: 1,
  formatName: 'thinkr-sync-backup',
  /** Requests to the backups from one client address in one window: reads, writes, and deletes. */
  requestsPerWindow: 60,
  rateWindowMs: 600_000,
  /** New backups from one client address in one day, so that nobody fills the disk with them. */
  newBackupsPerWindow: 5,
  newBackupWindowMs: 86_400_000,
} as const;
