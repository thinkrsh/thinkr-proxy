// Forwards one sealed request of the private lane to its enclave and streams the sealed answer
// back. The proxy never opens a body: it checks the headers, adds the key, and moves bytes.
import { MESSAGES } from '../config/messages.js';
import { TINFOIL } from '../config/tinfoil.js';
import { ProxyError, upstreamStatusError } from '../lib/errors.js';
import type { Forward, ForwardResponse } from '../lib/forward.js';
import { UpstreamLifetime } from '../lib/upstream-lifetime.js';
import { parseUsageMetrics, type UsageMetrics } from './usage.js';

export interface SealedDeps {
  readonly forward: Forward;
  readonly apiKey: string;
}

/** Where a sealed request goes on the enclave, and how long it may take. */
export interface SealedRoute {
  readonly path: string;
  /** Time allowed until the enclave answers with response headers. */
  readonly firstByteMs: number;
  /** Time allowed for the whole answer. */
  readonly streamMs: number;
}

/** A chat, which streams its answer. */
export const CHAT_ROUTE: SealedRoute = {
  path: TINFOIL.chatCompletionsPath,
  firstByteMs: TINFOIL.firstByteTimeoutMs,
  streamMs: TINFOIL.streamTimeoutMs,
};

/** A document for the document enclave, which answers once the whole file is converted. */
export const CONVERT_ROUTE: SealedRoute = {
  path: TINFOIL.convertFilePath,
  firstByteMs: TINFOIL.convertTimeoutMs,
  streamMs: TINFOIL.convertTimeoutMs,
};

/** A recording for the speech model on the router, which answers once with its text. */
export const TRANSCRIPTION_ROUTE: SealedRoute = {
  path: TINFOIL.transcriptionPath,
  firstByteMs: TINFOIL.audioTimeoutMs,
  streamMs: TINFOIL.audioTimeoutMs,
};

/** A part of an answer for the voice on the router, which answers once with its WAV. */
export const SPEECH_ROUTE: SealedRoute = {
  path: TINFOIL.speechPath,
  firstByteMs: TINFOIL.audioTimeoutMs,
  streamMs: TINFOIL.audioTimeoutMs,
};

/** A message for the enclave of the privacy filter, which answers once with its spans. */
export const FILTER_ROUTE: SealedRoute = {
  path: TINFOIL.privacyFilter.redactPath,
  firstByteMs: TINFOIL.privacyFilterTimeoutMs,
  streamMs: TINFOIL.privacyFilterTimeoutMs,
};

/** A sealed request whose headers the proxy has checked. */
export interface SealedRequest {
  readonly route: SealedRoute;
  readonly enclave: URL;
  /** The model of a chat; null for a document, which names none. */
  readonly teeModelId: string | null;
  /** The events that a chat asks for, such as the progress of web search; null for none. */
  readonly events: string | null;
  readonly encapsulatedKey: string;
  readonly contentType: string | null;
  readonly body: ArrayBuffer;
}

const HEX = /^[0-9a-f]+$/i;

/** The HPKE key of a sealed body. Without it the body would be plain text, so the proxy stops. */
export function parseEncapsulatedKey(value: string | undefined): string {
  if (value === undefined || !HEX.test(value)) {
    throw new ProxyError('invalid_request', MESSAGES.notSealed);
  }
  return value;
}

/**
 * The enclave named by the SDK, when it is a bare HTTPS origin on the host of Tinfoil, and the
 * origin `only` when the route has one enclave of its own.
 */
export function parseEnclaveUrl(value: string | undefined, only?: string): URL {
  const url = value === undefined ? null : URL.parse(value);
  const allowed = url !== null && isAllowedEnclave(url);
  if (!allowed || (only !== undefined && url.origin !== new URL(only).origin)) {
    throw new ProxyError('invalid_request', MESSAGES.enclaveNotAllowed);
  }
  return url;
}

function isAllowedEnclave(url: URL): boolean {
  const host = url.hostname;
  const onTinfoil = host === TINFOIL.enclaveHost || host.endsWith(`.${TINFOIL.enclaveHost}`);
  const bareOrigin =
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '';
  return url.protocol === 'https:' && onTinfoil && bareOrigin;
}

/**
 * Sends the request and returns the response for the browser, whose body is still sealed. Once the
 * answer has ended, `onUsage` gets the usage that the enclave reported, or null without one.
 */
export async function forwardSealed(
  deps: SealedDeps,
  request: SealedRequest,
  clientSignal: AbortSignal,
  onUsage: (metrics: UsageMetrics | null) => void,
): Promise<Response> {
  const lifetime = new UpstreamLifetime(clientSignal, {
    firstByteMs: request.route.firstByteMs,
    streamMs: request.route.streamMs,
  });
  let upstream: ForwardResponse;
  try {
    upstream = await lifetime.withFirstByteDeadline(() =>
      deps.forward(new URL(request.route.path, request.enclave), {
        method: 'POST',
        headers: upstreamHeaders(deps.apiKey, request),
        body: request.body,
        signal: lifetime.signal,
      }),
    );
  } catch (error) {
    lifetime.dispose();
    throw lifetime.errorFor(error);
  }
  if (!opensInBrowser(upstream)) {
    lifetime.dispose();
    await upstream.body.cancel();
    throw isOk(upstream.status)
      ? new ProxyError('upstream_error', MESSAGES.upstreamUnreadable)
      : upstreamStatusError(upstream.status);
  }
  // A streamed answer reports its usage in a trailer; an answer sent at once, such as speech, in
  // a header (seen on 23 Oct 2026).
  const reportUsage = (): void => {
    void upstream.trailers.then((trailers) => {
      const usage =
        trailers.get(TINFOIL.headers.usage) ?? upstream.headers.get(TINFOIL.headers.usage);
      onUsage(parseUsageMetrics(usage));
    });
  };
  return new Response(passThrough(upstream.body, lifetime, reportUsage), {
    status: upstream.status,
    headers: answerHeaders(upstream.headers),
  });
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * The key of Thinkr, the seal, the model, the events, the media type, and the ask for the usage.
 * Nothing that names the user.
 */
function upstreamHeaders(apiKey: string, request: SealedRequest): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${apiKey}`,
    [TINFOIL.headers.encapsulatedKey]: request.encapsulatedKey,
    [TINFOIL.headers.requestUsage]: 'true',
  });
  if (request.teeModelId !== null) headers.set(TINFOIL.headers.model, request.teeModelId);
  if (request.events !== null) headers.set(TINFOIL.headers.events, request.events);
  if (request.contentType !== null) headers.set('Content-Type', request.contentType);
  return headers;
}

/**
 * A sealed answer carries its nonce. An EHBP problem, such as a rotated key, is plain JSON that
 * the SDK reads to recover. Anything else would put plain text through the proxy, so it stops.
 */
function opensInBrowser(upstream: ForwardResponse): boolean {
  if (upstream.headers.has(TINFOIL.headers.responseNonce)) return true;
  const mediaType = upstream.headers.get('Content-Type')?.split(';')[0]?.trim();
  return !isOk(upstream.status) && mediaType === TINFOIL.problemMediaType;
}

function answerHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const name of ['Content-Type', TINFOIL.headers.responseNonce]) {
    const value = upstream.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

/**
 * Passes the bytes on, and ends the request when the answer ends, breaks, or the app leaves. Only
 * an answer that ended whole calls `onEnd`.
 */
function passThrough(
  body: ReadableStream<Uint8Array>,
  lifetime: UpstreamLifetime,
  onEnd: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          lifetime.dispose();
          controller.close();
          onEnd();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        lifetime.dispose();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        lifetime.stop('client');
        lifetime.dispose();
      }
    },
  });
}
