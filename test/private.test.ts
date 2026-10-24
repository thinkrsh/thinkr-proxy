import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LIMITS } from '../src/config/limits.js';
import { MESSAGES } from '../src/config/messages.js';
import { SERVER } from '../src/config/server.js';
import { TINFOIL } from '../src/config/tinfoil.js';
import type { ErrorBody } from '../src/contract.js';
import {
  TEST_TINFOIL_KEY,
  createTestApp,
  postChat,
  streamOf,
  upstreamCall,
  type TestApp,
} from './helpers.js';

const ENCLAVE = 'https://inference.tinfoil.sh';
const SEALED_KEY = 'ab'.repeat(32);
const RESPONSE_NONCE = 'cd'.repeat(32);
const SEALED_BODY = new Uint8Array([0, 0, 0, 3, 7, 8, 9]);
const SEALED_ROUTE = '/api/private/v1/chat/completions';

const SEALED_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json',
  [TINFOIL.headers.encapsulatedKey]: SEALED_KEY,
  [TINFOIL.headers.model]: 'gpt-oss-120b',
  [TINFOIL.headers.enclaveUrl]: ENCLAVE,
};

function postSealed(
  app: TestApp['app'],
  headers: Record<string, string> = {},
  init: RequestInit = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(SEALED_ROUTE, {
      method: 'POST',
      headers: { ...SEALED_HEADERS, ...headers },
      body: SEALED_BODY,
      ...init,
    }),
  );
}

function withoutHeader(name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(SEALED_HEADERS).filter(([key]) => key !== name));
}

/** A sealed answer of the enclave: opaque bytes, a nonce, and a header the proxy must not pass. */
function sealedAnswer(): Response {
  return new Response(streamOf(['sealed-1', 'sealed-2']), {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      [TINFOIL.headers.responseNonce]: RESPONSE_NONCE,
      'X-Internal': 'not for the browser',
    },
  });
}

function appAnswering(response: () => Response = sealedAnswer): TestApp {
  return createTestApp(vi.fn<typeof fetch>(() => Promise.resolve(response())));
}

async function errorOf(response: Response): Promise<ErrorBody['error']> {
  return ((await response.json()) as ErrorBody).error;
}

function upstreamHeaders(testApp: TestApp): Headers {
  return new Headers(upstreamCall(testApp.fetchMock).init.headers);
}

describe('GET /api/private/attestation', () => {
  const bundle = JSON.stringify({ domain: 'inference.tinfoil.sh', digest: 'abc' });

  it('passes the bundle of the router on, with only the headers of the SDK', async () => {
    const testApp = createTestApp(
      vi.fn<typeof fetch>(() => Promise.resolve(new Response(bundle, { status: 200 }))),
    );
    const response = await testApp.app.request('/api/private/attestation', {
      headers: {
        'Tinfoil-SDK': 'tinfoil-js',
        'Tinfoil-SDK-Version': '1.2.2',
        Cookie: 'session=1',
        'User-Agent': 'Browser',
        'X-Forwarded-For': '203.0.113.9',
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toBe(bundle);
    const { url, init } = upstreamCall(testApp.fetchMock);
    expect(url).toBe(TINFOIL.attestationUrl);
    expect([...new Headers(init.headers).keys()].sort()).toEqual([
      'tinfoil-sdk',
      'tinfoil-sdk-version',
    ]);
  });

  it.each([
    ['answers with an error', () => Promise.resolve(new Response('no', { status: 500 }))],
    ['cannot be reached', () => Promise.reject(new TypeError('fetch failed'))],
    [
      'sends a bundle over the size limit',
      () =>
        Promise.resolve(
          new Response('{}', {
            headers: { 'Content-Length': String(TINFOIL.maxAttestationBytes + 1) },
          }),
        ),
    ],
  ])('answers 502 when the attestation service %s', async (_name, answer) => {
    const { app } = createTestApp(vi.fn<typeof fetch>(answer));
    const response = await app.request('/api/private/attestation');
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toEqual({
      code: 'upstream_error',
      message: MESSAGES.attestationUnreachable,
    });
  });
});

describe('POST /api/private/v1/chat/completions, the forward', () => {
  it('sends the sealed body unchanged to the enclave, with the key of Thinkr', async () => {
    const testApp = appAnswering();
    await postSealed(testApp.app);
    const { url, init } = upstreamCall(testApp.fetchMock);
    expect(url).toBe(`${ENCLAVE}${TINFOIL.chatCompletionsPath}`);
    expect(init.method).toBe('POST');
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(SEALED_BODY);
    const headers = upstreamHeaders(testApp);
    expect(headers.get('Authorization')).toBe(`Bearer ${TEST_TINFOIL_KEY}`);
    expect(headers.get(TINFOIL.headers.encapsulatedKey)).toBe(SEALED_KEY);
    expect(headers.get(TINFOIL.headers.model)).toBe('gpt-oss-120b');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('passes the events of web search on to the enclave (decision 142)', async () => {
    const testApp = appAnswering();
    await postSealed(testApp.app, { [TINFOIL.headers.events]: TINFOIL.webSearchEvents });
    expect(upstreamHeaders(testApp).get(TINFOIL.headers.events)).toBe(TINFOIL.webSearchEvents);
  });

  it('asks for no events when the app asks for none', async () => {
    const testApp = appAnswering();
    await postSealed(testApp.app);
    expect(upstreamHeaders(testApp).has(TINFOIL.headers.events)).toBe(false);
  });

  it('sends nothing that names the user', async () => {
    const testApp = appAnswering();
    await postSealed(testApp.app, {
      Authorization: 'Bearer user-token',
      Cookie: 'session=1',
      'User-Agent': 'Browser',
      'X-Forwarded-For': '203.0.113.9',
    });
    expect([...upstreamHeaders(testApp).keys()].sort()).toEqual([
      'authorization',
      'content-type',
      TINFOIL.headers.encapsulatedKey.toLowerCase(),
      TINFOIL.headers.model.toLowerCase(),
      TINFOIL.headers.requestUsage.toLowerCase(),
    ]);
    expect(upstreamHeaders(testApp).get('Authorization')).toBe(`Bearer ${TEST_TINFOIL_KEY}`);
  });

  it('streams the sealed answer back with its nonce and media type only', async () => {
    const response = await postSealed(appAnswering().app);
    expect(response.status).toBe(200);
    expect(response.headers.get(TINFOIL.headers.responseNonce)).toBe(RESPONSE_NONCE);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.headers.get('X-Internal')).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toBe('sealed-1sealed-2');
  });

  it('passes an EHBP problem on, so that the SDK can renew the key', async () => {
    const problem = JSON.stringify({ type: 'urn:ietf:params:ehbp:error:key-config' });
    const response = await postSealed(
      appAnswering(
        () =>
          new Response(problem, {
            status: 422,
            headers: { 'Content-Type': `${TINFOIL.problemMediaType}; charset=utf-8` },
          }),
      ).app,
    );
    expect(response.status).toBe(422);
    expect(await response.text()).toBe(problem);
  });

  it.each([
    [401, MESSAGES.upstreamStatus(401)],
    [429, MESSAGES.upstreamBusy],
  ])('maps a plain HTTP %i of the provider to 502 JSON', async (status, message) => {
    const response = await postSealed(
      appAnswering(() => new Response('{"error":"no"}', { status })).app,
    );
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toEqual({ code: 'upstream_error', message });
  });

  it('refuses an answer that is not sealed', async () => {
    const response = await postSealed(
      appAnswering(() => new Response('{"choices":[]}', { status: 200 })).app,
    );
    expect(response.status).toBe(502);
    expect((await errorOf(response)).message).toBe(MESSAGES.upstreamUnreadable);
  });

  it('maps a network failure to 502 JSON', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed')));
    const response = await postSealed(createTestApp(fetchMock).app);
    expect(response.status).toBe(502);
    expect((await errorOf(response)).message).toBe(MESSAGES.upstreamUnreachable);
  });

  it.each(['https://tinfoil.sh', 'https://router-1.inf6.tinfoil.sh'])(
    'forwards to the enclave %s',
    async (enclave) => {
      const testApp = appAnswering();
      const response = await postSealed(testApp.app, { [TINFOIL.headers.enclaveUrl]: enclave });
      expect(response.status).toBe(200);
      expect(upstreamCall(testApp.fetchMock).url).toBe(`${enclave}${TINFOIL.chatCompletionsPath}`);
    },
  );
});

describe('POST /api/private/v1/chat/completions, refused before any forward', () => {
  async function expectRefused(
    response: Response,
    testApp: TestApp,
    status: number,
    error: ErrorBody['error'],
  ): Promise<void> {
    expect(response.status).toBe(status);
    expect(await errorOf(response)).toEqual(error);
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  }

  it.each([
    ['no seal', withoutHeader(TINFOIL.headers.encapsulatedKey)],
    ['a seal that is not hex', { [TINFOIL.headers.encapsulatedKey]: 'not-a-key' }],
  ])('answers 400 for a request with %s', async (_name, headers) => {
    const testApp = appAnswering();
    const response = await Promise.resolve(
      testApp.app.request(SEALED_ROUTE, {
        method: 'POST',
        headers: { ...withoutHeader(TINFOIL.headers.encapsulatedKey), ...headers },
        body: SEALED_BODY,
      }),
    );
    await expectRefused(response, testApp, 400, {
      code: 'invalid_request',
      message: MESSAGES.notSealed,
    });
  });

  it('answers 400 for a sealed request without a body', async () => {
    const testApp = appAnswering();
    const response = await postSealed(testApp.app, {}, { body: new Uint8Array() });
    await expectRefused(response, testApp, 400, {
      code: 'invalid_request',
      message: MESSAGES.notSealed,
    });
  });

  it('answers 400 when the request names no model', async () => {
    const testApp = appAnswering();
    const response = await Promise.resolve(
      testApp.app.request(SEALED_ROUTE, {
        method: 'POST',
        headers: withoutHeader(TINFOIL.headers.model),
        body: SEALED_BODY,
      }),
    );
    await expectRefused(response, testApp, 400, {
      code: 'invalid_request',
      message: MESSAGES.teeModelRequired,
    });
  });

  it.each(['qwen3-vl', 'private/kimi-k3', 'deepseek/deepseek-v4.1-flash'])(
    'answers 404 for the model %s, which the private lane does not serve',
    async (model) => {
      const testApp = appAnswering();
      const response = await postSealed(testApp.app, { [TINFOIL.headers.model]: model });
      await expectRefused(response, testApp, 404, {
        code: 'unknown_model',
        message: MESSAGES.unknownModel,
      });
    },
  );

  it.each([
    'http://inference.tinfoil.sh',
    'https://example.com',
    'https://tinfoil.sh.example.com',
    'https://eviltinfoil.sh',
    'https://user:secret@inference.tinfoil.sh',
    'https://inference.tinfoil.sh:8443',
    'https://inference.tinfoil.sh/v1',
    'https://inference.tinfoil.sh/?to=elsewhere',
    'not a url',
  ])('answers 400 for the enclave %s', async (enclave) => {
    const testApp = appAnswering();
    const response = await postSealed(testApp.app, { [TINFOIL.headers.enclaveUrl]: enclave });
    await expectRefused(response, testApp, 400, {
      code: 'invalid_request',
      message: MESSAGES.enclaveNotAllowed,
    });
  });

  it('answers 400 when the request names no enclave', async () => {
    const testApp = appAnswering();
    const response = await Promise.resolve(
      testApp.app.request(SEALED_ROUTE, {
        method: 'POST',
        headers: withoutHeader(TINFOIL.headers.enclaveUrl),
        body: SEALED_BODY,
      }),
    );
    await expectRefused(response, testApp, 400, {
      code: 'invalid_request',
      message: MESSAGES.enclaveNotAllowed,
    });
  });

  it('answers 400 for events other than those of web search', async () => {
    const testApp = appAnswering();
    const response = await postSealed(testApp.app, { [TINFOIL.headers.events]: 'code_execution' });
    await expectRefused(response, testApp, 400, {
      code: 'invalid_request',
      message: MESSAGES.eventsNotAllowed,
    });
  });

  it('answers 413 for a body over the size limit', async () => {
    const testApp = appAnswering();
    const body = new Uint8Array(SERVER.maxSealedChatBytes + 1);
    const response = await postSealed(testApp.app, {}, { body });
    await expectRefused(response, testApp, 413, {
      code: 'invalid_request',
      message: MESSAGES.tooLarge,
    });
  });

  it('counts sealed and open chats against one rate limit', async () => {
    const testApp = appAnswering();
    for (let index = 0; index < LIMITS.chatRequestsPerWindow; index += 1) {
      if (index % 2 === 0) await postChat(testApp.app, {});
      else await postSealed(testApp.app, { [TINFOIL.headers.encapsulatedKey]: 'not-a-key' });
    }
    expect((await postSealed(testApp.app)).status).toBe(429);
    expect((await postChat(testApp.app, {})).status).toBe(429);
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/private/v1/chat/completions, deadlines and leaving', () => {
  /** An enclave that never answers until its request is aborted. */
  function silentEnclave(seen: AbortSignal[]): typeof fetch {
    return (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) throw new Error('The proxy sent no signal.');
        seen.push(signal);
        signal.addEventListener('abort', () => {
          reject(signal.reason as Error);
        });
      });
  }

  /** An enclave that sends one sealed chunk, then hangs until its request is aborted. */
  function hangingEnclave(seen: AbortSignal[]): typeof fetch {
    return (_input, init) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) throw new Error('The proxy sent no signal.');
      seen.push(signal);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('sealed-1'));
          signal.addEventListener('abort', () => {
            controller.error(signal.reason);
          });
        },
      });
      return Promise.resolve(
        new Response(body, { headers: { [TINFOIL.headers.responseNonce]: RESPONSE_NONCE } }),
      );
    };
  }

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('answers 504 when the enclave sends no headers in time', async () => {
      const seen: AbortSignal[] = [];
      const { app } = createTestApp(vi.fn(silentEnclave(seen)));
      const pending = postSealed(app);
      await vi.advanceTimersByTimeAsync(TINFOIL.firstByteTimeoutMs);
      const response = await pending;
      expect(response.status).toBe(504);
      expect(await errorOf(response)).toEqual({
        code: 'upstream_timeout',
        message: MESSAGES.upstreamTimeout,
      });
      expect(seen[0]?.aborted).toBe(true);
    });

    it('breaks the stream when the whole answer takes too long', async () => {
      const seen: AbortSignal[] = [];
      const { app } = createTestApp(vi.fn(hangingEnclave(seen)));
      const response = await postSealed(app);
      const reading = response.text();
      const outcome = expect(reading).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(TINFOIL.streamTimeoutMs);
      await outcome;
      expect(seen[0]?.aborted).toBe(true);
    });
  });

  it('aborts the upstream request when the client leaves before the answer starts', async () => {
    const seen: AbortSignal[] = [];
    const client = new AbortController();
    const { app } = createTestApp(vi.fn(silentEnclave(seen)));
    const pending = postSealed(app, {}, { signal: client.signal });
    await vi.waitFor(() => {
      expect(seen).toHaveLength(1);
    });
    client.abort();
    await pending;
    expect(seen[0]?.aborted).toBe(true);
  });

  it('aborts the upstream request when the client stops reading the answer', async () => {
    const seen: AbortSignal[] = [];
    const { app } = createTestApp(vi.fn(hangingEnclave(seen)));
    const response = await postSealed(app);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('The response has no body.');
    await reader.read();
    await reader.cancel();
    expect(seen[0]?.aborted).toBe(true);
  });
});

describe('POST /api/private/v1/convert/file (decision 142)', () => {
  const FILE_ROUTE = '/api/private/v1/convert/file';
  const FILE_HEADERS: Readonly<Record<string, string>> = {
    'Content-Type': 'multipart/form-data; boundary=thinkr',
    [TINFOIL.headers.encapsulatedKey]: SEALED_KEY,
    [TINFOIL.headers.enclaveUrl]: ENCLAVE,
  };

  function postFile(app: TestApp['app'], init: RequestInit = {}): Promise<Response> {
    return Promise.resolve(
      app.request(FILE_ROUTE, {
        method: 'POST',
        headers: FILE_HEADERS,
        body: SEALED_BODY,
        ...init,
      }),
    );
  }

  it('sends the sealed document to the document enclave, naming no model', async () => {
    const testApp = appAnswering();
    const response = await postFile(testApp.app);
    expect(response.status).toBe(200);
    expect(response.headers.get(TINFOIL.headers.responseNonce)).toBe(RESPONSE_NONCE);
    const { url, init } = upstreamCall(testApp.fetchMock);
    expect(url).toBe(`${ENCLAVE}${TINFOIL.convertFilePath}`);
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(SEALED_BODY);
    const headers = upstreamHeaders(testApp);
    expect(headers.get('Authorization')).toBe(`Bearer ${TEST_TINFOIL_KEY}`);
    expect(headers.get('Content-Type')).toBe(FILE_HEADERS['Content-Type']);
    expect(headers.has(TINFOIL.headers.model)).toBe(false);
    expect(headers.has(TINFOIL.headers.events)).toBe(false);
  });

  it('refuses a document that is not sealed', async () => {
    const testApp = appAnswering();
    const headers = Object.fromEntries(
      Object.entries(FILE_HEADERS).filter(([name]) => name !== TINFOIL.headers.encapsulatedKey),
    );
    const response = await postFile(testApp.app, { headers });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toEqual({
      code: 'invalid_request',
      message: MESSAGES.notSealed,
    });
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });

  it('answers 413 for a document over the size limit', async () => {
    const testApp = appAnswering();
    const response = await postFile(testApp.app, {
      body: new Uint8Array(SERVER.maxSealedFileBytes + 1),
    });
    expect(response.status).toBe(413);
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });
});
