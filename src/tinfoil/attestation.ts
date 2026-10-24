// Fetches the attestation bundle of the router for the browser, so that the browser talks only to
// Thinkr (decision 41), and that of the privacy filter, which runs in an enclave of its own. The
// browser verifies each bundle itself; the proxy only passes it on.
import { z } from 'zod';

import { MESSAGES } from '../config/messages.js';
import { TINFOIL } from '../config/tinfoil.js';
import { ProxyError } from '../lib/errors.js';
import { UpstreamLifetime } from '../lib/upstream-lifetime.js';

export interface AttestationDeps {
  readonly fetch: typeof fetch;
}

/**
 * What the SDK posts to ask for the bundle of an enclave other than the router. The proxy asks
 * only for the privacy filter.
 */
const enclaveRequestSchema = z.strictObject({
  enclaveUrl: z.literal(TINFOIL.privacyFilter.enclaveUrl),
  repo: z.literal(TINFOIL.privacyFilter.configRepo),
});

/** The bundle of the router (no body) or of the privacy filter (its body as the SDK posts it). */
export async function fetchAttestation(
  deps: AttestationDeps,
  clientHeaders: Headers,
  clientSignal: AbortSignal,
  enclaveRequest: unknown = null,
): Promise<Response> {
  const body = enclaveRequest === null ? null : enclaveBody(enclaveRequest);
  const lifetime = new UpstreamLifetime(clientSignal, {
    firstByteMs: TINFOIL.attestationTimeoutMs,
    streamMs: TINFOIL.attestationTimeoutMs,
  });
  try {
    const headers = sdkHeaders(clientHeaders);
    if (body !== null) headers.set('Content-Type', 'application/json');
    const upstream = await lifetime.withFirstByteDeadline(() =>
      deps.fetch(TINFOIL.attestationUrl, {
        ...(body === null ? {} : { method: 'POST', body }),
        headers,
        signal: lifetime.signal,
      }),
    );
    const bundle = await readBundle(upstream);
    return new Response(bundle, { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    const proxyError = lifetime.errorFor(error);
    throw proxyError.code === 'upstream_error'
      ? new ProxyError('upstream_error', MESSAGES.attestationUnreachable)
      : proxyError;
  } finally {
    lifetime.dispose();
  }
}

/** The request of the SDK for the privacy filter, as JSON again; anything else stops here. */
function enclaveBody(request: unknown): string {
  const parsed = enclaveRequestSchema.safeParse(request);
  if (!parsed.success) throw new ProxyError('invalid_request', MESSAGES.attestationNotAllowed);
  return JSON.stringify(parsed.data);
}

/** Only the headers that name the SDK and its version go on; nothing that names the user. */
function sdkHeaders(clientHeaders: Headers): Headers {
  const headers = new Headers();
  for (const name of TINFOIL.sdkHeaders) {
    const value = clientHeaders.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

async function readBundle(upstream: Response): Promise<ArrayBuffer> {
  const declaredBytes = Number(upstream.headers.get('Content-Length') ?? 0);
  if (!upstream.ok || declaredBytes > TINFOIL.maxAttestationBytes) {
    await upstream.body?.cancel();
    throw new ProxyError('upstream_error', MESSAGES.attestationUnreachable);
  }
  const bundle = await upstream.arrayBuffer();
  if (bundle.byteLength === 0 || bundle.byteLength > TINFOIL.maxAttestationBytes) {
    throw new ProxyError('upstream_error', MESSAGES.attestationUnreachable);
  }
  return bundle;
}
