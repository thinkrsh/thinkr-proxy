import { describe, expect, it, vi } from 'vitest';

import { LIMITS } from '../src/config/limits.js';
import { MESSAGES } from '../src/config/messages.js';
import { MODEL_CATALOG } from '../src/config/models.js';
import { OPENROUTER } from '../src/config/openrouter.js';
import { SERVER } from '../src/config/server.js';
import { REASONING } from '../src/config/thinking.js';
import { WEB_SEARCH_TOOL } from '../src/config/webSearch.js';
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

describe('POST /api/chat, Think (28 Oct 2026)', () => {
  /** Thinks by itself at the effort of its maker, and may stop. */
  const THINKS_BY_ITSELF = 'open/deepseek-v4.1-flash';
  /** Names no default, so Think asks it. */
  const NO_DEFAULT = 'open/claude-haiku-4.5';
  /** Always thinks. */
  const ALWAYS = VALID_CHAT.modelId;

  async function reasoningSent(modelId: string, think?: boolean): Promise<unknown> {
    const { app, fetchMock } = appAnswering();
    const chat =
      think === undefined ? { ...VALID_CHAT, modelId } : { ...VALID_CHAT, modelId, think };
    await readEvents(await postChat(app, chat));
    const { init } = upstreamCall(fetchMock);
    if (typeof init.body !== 'string') throw new Error('The upstream body is not a JSON string.');
    return (JSON.parse(init.body) as UpstreamBody).reasoning;
  }

  it('stops a model that thinks by itself when Think is off, and leaves it when on', async () => {
    expect(await reasoningSent(THINKS_BY_ITSELF, false)).toEqual(REASONING.off);
    expect(await reasoningSent(THINKS_BY_ITSELF, true)).toBeUndefined();
  });

  it('asks a model that names no default to think when Think is on, and stops it when off', async () => {
    expect(await reasoningSent(NO_DEFAULT, true)).toEqual(REASONING.on);
    expect(await reasoningSent(NO_DEFAULT, false)).toEqual(REASONING.off);
  });

  it('makes a model that always thinks think less when Think is off, never stop', async () => {
    expect(await reasoningSent(ALWAYS, false)).toEqual(REASONING.least);
    expect(await reasoningSent(ALWAYS, true)).toBeUndefined();
  });

  it('asks nothing of a model that always thinks and has no lesser effort', async () => {
    expect(await reasoningSent('open/gpt-5.5-pro', false)).toBeUndefined();
  });

  it('asks nothing of a model that cannot think', async () => {
    const plain = MODEL_CATALOG.find(
      ({ info }) =>
        info.lane === 'open' && info.kind === 'text' && info.available && !info.reasoning,
    );
    if (plain === undefined) throw new Error('The catalog has no model of text that cannot think.');
    expect(await reasoningSent(plain.info.id, true)).toBeUndefined();
    expect(await reasoningSent(plain.info.id, false)).toBeUndefined();
  });

  it('leaves every model as it is for an app from before Think', async () => {
    expect(await reasoningSent(THINKS_BY_ITSELF)).toBeUndefined();
    expect(await reasoningSent(NO_DEFAULT)).toBeUndefined();
  });

  it('answers 400 for a Think that is not true or false', async () => {
    const { app, fetchMock } = appAnswering();
    const response = await postChat(app, { ...VALID_CHAT, think: 'yes' });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/chat, web search (29 Oct 2026)', () => {
  const SEARCHER = 'open/claude-haiku-5.5';

  async function toolsSent(webSearch?: boolean): Promise<unknown> {
    const { app, fetchMock } = appAnswering();
    const chat =
      webSearch === undefined
        ? { ...VALID_CHAT, modelId: SEARCHER }
        : { ...VALID_CHAT, modelId: SEARCHER, webSearch };
    await readEvents(await postChat(app, chat));
    const { init } = upstreamCall(fetchMock);
    if (typeof init.body !== 'string') throw new Error('The upstream body is not a JSON string.');
    return (JSON.parse(init.body) as UpstreamBody).tools;
  }

  it('adds the search of Exa while web search is on, and nothing otherwise', async () => {
    expect(await toolsSent(true)).toEqual([WEB_SEARCH_TOOL]);
    expect(await toolsSent(false)).toBeUndefined();
    expect(await toolsSent()).toBeUndefined();
  });

  it('streams the pages found and how often the answer searched', async () => {
    const searched = [
      chunk({
        choices: [
          {
            delta: {
              content: '',
              annotations: [
                {
                  type: 'url_citation',
                  url_citation: { url: 'https://nodejs.org/', title: 'Node.js', content: 'Text.' },
                },
              ],
            },
          },
        ],
      }),
      contentChunk('Hi'),
      chunk({
        choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 2,
          server_tool_use_details: { web_search_requests: 1 },
        },
      }),
      DONE,
    ];
    const { app } = appAnswering(searched);
    const response = await postChat(app, { ...VALID_CHAT, modelId: SEARCHER, webSearch: true });
    expect(await readEvents(response)).toEqual([
      { type: 'source', url: 'https://nodejs.org/', title: 'Node.js' },
      { type: 'delta', text: 'Hi' },
      { type: 'searched', count: 1 },
      { type: 'done', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 2 } },
    ]);
  });

  it('answers 400 for a model that cannot search, without calling upstream', async () => {
    const { app, fetchMock } = appAnswering();
    const chat = { ...VALID_CHAT, modelId: 'open/mistral-large-3', webSearch: true };
    const response = await postChat(app, chat);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toEqual({
      code: 'invalid_request',
      message: MESSAGES.noWebSearch,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 400 for a web search that is not true or false', async () => {
    const { app, fetchMock } = appAnswering();
    const response = await postChat(app, { ...VALID_CHAT, webSearch: 'yes' });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
