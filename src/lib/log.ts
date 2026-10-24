// The one log line per request. It never holds prompt or answer content, an IP address, or the
// store ID of a backup.
export type LogLine = (line: string) => void;

export interface RequestLogEntry {
  readonly at: Date;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
}

/** A part of a path that holds the hex of 32 bytes: the store ID of a backup (routes/sync.ts). */
const STORE_ID_SEGMENT = /\/[0-9a-f]{64}(?=\/|$)/g;

export function formatRequestLog(entry: RequestLogEntry): string {
  const { at, method, status, durationMs } = entry;
  const path = entry.path.replace(STORE_ID_SEGMENT, '/:store');
  return `${at.toISOString()} ${method} ${path} ${String(status)} ${String(durationMs)}ms`;
}

export function writeLogLine(line: string): void {
  process.stdout.write(`${line}\n`);
}
