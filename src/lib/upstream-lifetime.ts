// Ends one upstream request when the app goes away or a deadline passes, and remembers why.
import { MESSAGES } from '../config/messages.js';
import { ProxyError } from './errors.js';

export type StopCause = 'client' | 'first-byte-timeout' | 'stream-timeout';

export interface UpstreamDeadlines {
  /** Time allowed until the upstream answers with response headers. */
  readonly firstByteMs: number;
  /** Time allowed for the whole answer, from the request to its last byte. */
  readonly streamMs: number;
}

export class UpstreamLifetime {
  private readonly controller = new AbortController();
  private stopCause: StopCause | null = null;
  private readonly streamTimer: ReturnType<typeof setTimeout>;
  private readonly onClientAbort = (): void => {
    this.stop('client');
  };

  constructor(
    private readonly clientSignal: AbortSignal,
    private readonly deadlines: UpstreamDeadlines,
  ) {
    this.streamTimer = setTimeout(() => {
      this.stop('stream-timeout');
    }, deadlines.streamMs);
    if (clientSignal.aborted) this.stop('client');
    else clientSignal.addEventListener('abort', this.onClientAbort, { once: true });
  }

  /** The signal for the upstream fetch. It aborts on every stop. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cause(): StopCause | null {
    return this.stopCause;
  }

  /** Runs the request under the first-byte deadline; the task resolves when the headers are in. */
  async withFirstByteDeadline<T>(task: () => Promise<T>): Promise<T> {
    const timer = setTimeout(() => {
      this.stop('first-byte-timeout');
    }, this.deadlines.firstByteMs);
    try {
      return await task();
    } finally {
      clearTimeout(timer);
    }
  }

  stop(cause: StopCause): void {
    if (this.stopCause !== null) return;
    this.stopCause = cause;
    this.controller.abort(new Error(`Upstream stopped: ${cause}`));
  }

  /** The error for the app when the request failed before the answer started. */
  errorFor(error: unknown): ProxyError {
    if (error instanceof ProxyError) return error;
    if (this.stopCause === 'first-byte-timeout' || this.stopCause === 'stream-timeout') {
      return new ProxyError('upstream_timeout', MESSAGES.upstreamTimeout);
    }
    if (this.stopCause === 'client') {
      return new ProxyError('upstream_error', MESSAGES.upstreamCancelled);
    }
    return new ProxyError('upstream_error', MESSAGES.upstreamUnreachable);
  }

  /** Clears the deadline and the listener. Call it once the request is over, in every outcome. */
  dispose(): void {
    clearTimeout(this.streamTimer);
    this.clientSignal.removeEventListener('abort', this.onClientAbort);
  }
}
