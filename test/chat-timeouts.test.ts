import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MESSAGES } from '../src/config/messages.js';
import { OPENROUTER } from '../src/config/openrouter.js';
import type { ErrorBody } from '../src/contract.js';
import { VALID_CHAT, contentChunk, createTestApp, postChat, readEvents } from './helpers.js';

/** An upstream that never answers until its request is aborted. */
function silentUpstream(seen: AbortSignal[]): typeof fetch {
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

/** An upstream that sends one delta, then hangs until its request is aborted. */
function hangingUpstream(seen: AbortSignal[]): typeof fetch {
  return (_input, init) => {
    const signal = init?.signal;
    if (signal === undefined || signal === null) throw new Error('The proxy sent no signal.');
    seen.push(signal);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(contentChunk('Hi')));
        signal.addEventListener('abort', () => {
          controller.error(signal.reason);
        });
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };
}

describe('POST /api/chat, timeouts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers 504 when OpenRouter sends no headers in time', async () => {
    const seen: AbortSignal[] = [];
    const { app } = createTestApp(vi.fn(silentUpstream(seen)));
    const pending = postChat(app, VALID_CHAT);
    await vi.advanceTimersByTimeAsync(OPENROUTER.firstByteTimeoutMs);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(((await response.json()) as ErrorBody).error).toEqual({
      code: 'upstream_timeout',
      message: MESSAGES.upstreamTimeout,
    });
    expect(seen[0]?.aborted).toBe(true);
  });

  it('ends with an upstream_timeout event when the whole answer takes too long', async () => {
    const seen: AbortSignal[] = [];
    const { app } = createTestApp(vi.fn(hangingUpstream(seen)));
    const response = await postChat(app, VALID_CHAT);
    const reading = readEvents(response);
    await vi.advanceTimersByTimeAsync(OPENROUTER.streamTimeoutMs);
    expect(await reading).toEqual([
      { type: 'delta', text: 'Hi' },
      { type: 'error', code: 'upstream_timeout', message: MESSAGES.upstreamTimeout },
    ]);
    expect(seen[0]?.aborted).toBe(true);
  });
});

describe('POST /api/chat, the app goes away', () => {
  it('aborts the upstream request when the client leaves before the answer starts', async () => {
    const seen: AbortSignal[] = [];
    const client = new AbortController();
    const { app } = createTestApp(vi.fn(silentUpstream(seen)));
    const pending = postChat(app, VALID_CHAT, { signal: client.signal });
    await vi.waitFor(() => {
      expect(seen).toHaveLength(1);
    });
    client.abort();
    await pending;
    expect(seen[0]?.aborted).toBe(true);
  });

  it('aborts the upstream request when the client stops reading the stream', async () => {
    const seen: AbortSignal[] = [];
    const { app } = createTestApp(vi.fn(hangingUpstream(seen)));
    const response = await postChat(app, VALID_CHAT);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('The response has no body.');
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => {
      expect(seen[0]?.aborted).toBe(true);
    });
  });
});
