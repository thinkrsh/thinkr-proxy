// Where the proxy keeps the encrypted backups of the app: one sealed blob for each store ID, with its
// tag and a hash of its write token. It holds no key, so it cannot read a backup, and it keeps no
// time and no address. The Node entry keeps it in SQLite (node/sync-store.ts).

/** What the proxy needs to answer for a backup without reading its body. */
export interface BackupHead {
  /** The tag of the backup, quoted, as the ETag header carries it. */
  readonly etag: string;
  /** The SHA-256 of the write token, as hex. */
  readonly tokenHash: string;
  readonly bytes: number;
}

export interface StoredBackup extends BackupHead {
  readonly body: string;
}

export interface SyncStore {
  head: (storeId: string) => BackupHead | undefined;
  body: (storeId: string) => string | undefined;
  /**
   * Writes a backup only while the tag of the stored one is `expected` (undefined: no backup yet),
   * in one step, and says whether it wrote.
   */
  putIf: (storeId: string, backup: StoredBackup, expected: string | undefined) => boolean;
  delete: (storeId: string) => void;
  /** The bytes of all backups together. */
  totalBytes: () => number;
}
