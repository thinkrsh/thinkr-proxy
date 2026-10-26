// One request of an image or a video to OpenRouter (the owner, 23 Oct 2026): the key, a deadline,
// the signal of the app, and errors with a status that Cloudflare passes on, so the app reads why.
import { MEDIA } from '../config/media.js';
import { MESSAGES } from '../config/messages.js';
import { OPENROUTER } from '../config/openrouter.js';
import { ProxyError, upstreamStatusError } from '../lib/errors.js';
import type { UpstreamDeps } from '../openrouter/stream.js';

/** The prompt of a video, and the frames that the user gave with it (23 and 25 Oct 2026). */
export interface MediaPrompt {
  readonly text: string;
  /** A data URL: the first frame. */
  readonly image: string | null;
  /** A data URL: the last frame, which needs a first one. */
  readonly lastImage: string | null;
}

export interface MediaCall<T> {
  /** The path under the base URL of OpenRouter. */
  readonly path: string;
  readonly method: 'GET' | 'POST';
  /** Sent as JSON. */
  readonly body?: unknown;
  /** Time allowed for the request and for `read`. */
  readonly timeoutMs: number;
  /** The message when OpenRouter answers 404 or 410, such as a video it no longer holds. */
  readonly goneMessage?: string;
  /** Reads a good answer, under the same deadline. */
  readonly read: (response: Response) => Promise<T>;
}

const GONE_STATUSES: ReadonlySet<number> = new Set([404, 410]);

/** Sends one request, or throws a ProxyError when OpenRouter fails or the app goes away. */
export async function callOpenRouter<T>(
  deps: UpstreamDeps,
  call: MediaCall<T>,
  clientSignal: AbortSignal,
): Promise<T> {
  const deadline = AbortSignal.timeout(call.timeoutMs);
  const signal = AbortSignal.any([clientSignal, deadline]);
  const json = call.body !== undefined;
  try {
    const response = await deps.fetch(`${OPENROUTER.baseUrl}${call.path}`, {
      method: call.method,
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        ...(json ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(json ? { body: JSON.stringify(call.body) } : {}),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw statusError(response.status, call.goneMessage);
    }
    return await call.read(response);
  } catch (error) {
    throw requestError(error, clientSignal, deadline);
  }
}

/** An error of the provider, with a status that Cloudflare passes on. */
export function mediaUpstreamError(message: string): ProxyError {
  return new ProxyError('upstream_error', message, MEDIA.upstreamFailureStatus);
}

function statusError(status: number, goneMessage: string | undefined): ProxyError {
  if (goneMessage !== undefined && GONE_STATUSES.has(status)) {
    return new ProxyError('invalid_request', goneMessage, MEDIA.goneStatus);
  }
  return mediaUpstreamError(upstreamStatusError(status).message);
}

/** The error for the app: what the provider said, a timeout, the app gone, or the network down. */
function requestError(
  error: unknown,
  clientSignal: AbortSignal,
  deadline: AbortSignal,
): ProxyError {
  if (error instanceof ProxyError) return error;
  if (deadline.aborted) {
    return new ProxyError(
      'upstream_timeout',
      MESSAGES.upstreamTimeout,
      MEDIA.upstreamFailureStatus,
    );
  }
  if (clientSignal.aborted) return mediaUpstreamError(MESSAGES.upstreamCancelled);
  if (error instanceof SyntaxError) return mediaUpstreamError(MESSAGES.upstreamUnreadable);
  return mediaUpstreamError(MESSAGES.upstreamUnreachable);
}
