import { describe, expect, it, vi } from 'vitest';

import { LIMITS } from '../src/config/limits.js';
import { MESSAGES } from '../src/config/messages.js';
import { OPENROUTER } from '../src/config/openrouter.js';
import { SERVER } from '../src/config/server.js';
import type { ErrorBody } from '../src/contract.js';
import type { UpstreamBody } from '../src/openrouter/stream.js';
import {
  DONE,
  TEST_API_KEY,
  VALID_CHAT,
  chunk,
  contentChunk,
  createTestApp,
  postChat,
  readEvents,
  upstreamCall,
  upstreamResponse,
} from './helpers.js';

const answer = [
  ': OPENROUTER PROCESSING\n\n',
  contentChunk('Hi'),
  contentChunk(' there'),
  chunk({
    choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  }),
  DONE,
];

function appAnswering(parts: readonly string[] = answer): ReturnType<typeof createTestApp> {
  const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(upstreamResponse(parts)));
  return createTestApp(fetchMock);
}

async function errorOf(response: Response): Promise<ErrorBody['error']> {
  return ((await response.json()) as ErrorBody).error;
}

describe('POST /api/chat, the upstream request', () => {
  it('forces zero data retention and denies data collection', async () => {
    const { app, fetchMock } = appAnswering();
    await readEvents(await postChat(app, VALID_CHAT));
    const { url, init } = upstreamCall(fetchMock);
    if (typeof init.body !== 'string') throw new Error('The upstream body is not a JSON string.');
    const body = JSON.parse(init.body) as UpstreamBody;
    expect(url).toBe(`${OPENROUTER.baseUrl}${OPENROUTER.chatCompletionsPath}`);
    expect(body.provider).toEqual({ zdr: true, data_collection: 'deny' });
    expect(body).toEqual({
      model: 'z-ai/glm-5.3-flash',
      messages: VALID_CHAT.messages,
      stream: true,
      provider: { zdr: true, data_collection: 'deny' },
    });
  });

  it('sends the key and no attribution headers', async () => {
    const { app, fetchMock } = appAnswering();
    await readEvents(await postChat(app, VALID_CHAT));
    const headers = new Headers(upstreamCall(fetchMock).init.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${TEST_API_KEY}`);
    expect(headers.has('HTTP-Referer')).toBe(false);
    expect(headers.has('X-Title')).toBe(false);
  });
});

describe('POST /api/chat, the answer', () => {
  it('streams delta events and ends with done', async () => {
    const response = await postChat(appAnswering().app, VALID_CHAT);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await readEvents(response)).toEqual([
      { type: 'delta', text: 'Hi' },
      { type: 'delta', text: ' there' },
      { type: 'done', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 2 } },
    ]);
  });

  it('writes each event as one data line and a blank line', async () => {
    const text = await (await postChat(appAnswering().app, VALID_CHAT)).text();
    expect(text.startsWith('data: {"type":"delta","text":"Hi"}\n\n')).toBe(true);
  });

  it('ends with an error event when the provider fails mid-stream', async () => {
    const failure = chunk({ error: { code: 502, message: 'gone' }, choices: [] });
    const events = await readEvents(
      await postChat(appAnswering([contentChunk('Hi'), failure]).app, VALID_CHAT),
    );
    expect(events).toEqual([
      { type: 'delta', text: 'Hi' },
      { type: 'error', code: 'upstream_error', message: MESSAGES.upstreamStopped },
    ]);
  });
});

describe('POST /api/chat, errors before the stream', () => {
  it('maps an upstream HTTP error to 502 JSON', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('{"error":{"code":503}}', { status: 503 })),
    );
    const response = await postChat(createTestApp(fetchMock).app, VALID_CHAT);
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toEqual({
      code: 'upstream_error',
      message: MESSAGES.upstreamNoProvider,
    });
  });

  it('maps a network failure to 502 JSON', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed')));
    const response = await postChat(createTestApp(fetchMock).app, VALID_CHAT);
    expect(response.status).toBe(502);
    expect((await errorOf(response)).message).toBe(MESSAGES.upstreamUnreachable);
  });

  it('answers 404 for an unknown model, without calling upstream', async () => {
    const { app, fetchMock } = appAnswering();
    const response = await postChat(app, { ...VALID_CHAT, modelId: 'open/nothing' });
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('unknown_model');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 400 for a model of the private lane, which takes only sealed requests', async () => {
    const { app, fetchMock } = appAnswering();
    const response = await postChat(app, { ...VALID_CHAT, modelId: 'private/kimi-k3' });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toEqual({
      code: 'invalid_request',
      message: MESSAGES.sealedOnly,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a body that is not JSON', '{oops', MESSAGES.notJson],
    ['an unknown field', { ...VALID_CHAT, user: 'x' }, 'Unrecognized key: "user"'],
    ['no messages', { ...VALID_CHAT, messages: [] }, `messages: ${MESSAGES.noMessages}`],
    [
      'an empty message',
      { ...VALID_CHAT, messages: [{ role: 'user', content: '  ' }] },
      `messages.0.content: ${MESSAGES.messageEmpty}`,
    ],
    [
      'a chat that starts with the assistant',
      {
        ...VALID_CHAT,
        messages: [
          { role: 'assistant', content: 'a' },
          { role: 'user', content: 'b' },
        ],
      },
      MESSAGES.firstMessage,
    ],
    [
      'a chat that ends with the assistant',
      {
        ...VALID_CHAT,
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
        ],
      },
      MESSAGES.lastMessage,
    ],
    [
      'two user messages in a row',
      {
        ...VALID_CHAT,
        messages: [
          { role: 'user', content: 'a' },
          { role: 'user', content: 'b' },
        ],
      },
      MESSAGES.alternation,
    ],
    [
      'a system message',
      { ...VALID_CHAT, messages: [{ role: 'system', content: 'a' }] },
      'messages.0.role',
    ],
  ])('answers 400 for %s', async (_name, body, message) => {
    const response = await postChat(appAnswering().app, body);
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain(message);
  });

  it('answers 400 when all messages together are too long', async () => {
    const long = 'x'.repeat(LIMITS.maxMessageChars);
    const turns = Math.ceil(LIMITS.maxTotalChars / LIMITS.maxMessageChars) + 1;
    const messages = Array.from({ length: turns * 2 - 1 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: long,
    }));
    const response = await postChat(appAnswering().app, { ...VALID_CHAT, messages });
    expect((await errorOf(response)).message).toBe(MESSAGES.chatTooLong);
  });

  it('answers 413 for a body over the size limit', async () => {
    const huge = 'x'.repeat(SERVER.maxOpenChatBytes + 1);
    const response = await postChat(appAnswering().app, {
      ...VALID_CHAT,
      messages: [{ role: 'user', content: huge }],
    });
    expect(response.status).toBe(413);
    expect(await errorOf(response)).toEqual({
      code: 'invalid_request',
      message: MESSAGES.tooLarge,
    });
  });

  it('answers 429 after the rate limit of one window', async () => {
    const { app } = appAnswering();
    const statuses: number[] = [];
    for (let index = 0; index <= LIMITS.chatRequestsPerWindow; index += 1) {
      statuses.push((await postChat(app, {})).status);
    }
    expect(statuses.at(-2)).toBe(400);
    expect(statuses.at(-1)).toBe(429);
  });
});
