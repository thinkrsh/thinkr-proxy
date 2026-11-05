// The chats of the modes ZDR and Open through the API (the owner, 1 Nov 2026): what goes to OpenRouter,
// what comes back to the caller, and what a key pays.
import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { findModel } from '../src/catalog.js';
import { CREDIT } from '../src/config/credit.js';
import { INFERENCE } from '../src/config/inference.js';
import { MESSAGES } from '../src/config/messages.js';
import { MODEL_CATALOG } from '../src/config/models.js';
import { OPENROUTER } from '../src/config/openrouter.js';
import { TINFOIL } from '../src/config/tinfoil.js';
import type { ErrorBody } from '../src/contract.js';
import {
  affordableOutputTokens,
  balanceHash,
  chatPriceMicros,
  newBalanceSecret,
  usdToMicros,
} from '../src/credit/balance.js';
import type { Ledger } from '../src/credit/ledger.js';
import type { InferenceModelsResponse } from '../src/inference/contract.js';
import { answerSpend } from '../src/lib/cost.js';
import {
  DONE,
  TEST_API_KEY,
  chunk,
  contentChunk,
  createTestApp,
  streamOf,
  upstreamCall,
  type FetchMock,
  type TestApp,
} from './helpers.js';

const CHAT_ROUTE = `/api/inference${TINFOIL.chatCompletionsPath}`;
const MODELS_ROUTE = `/api/inference${INFERENCE.modelsPath}`;

/** A model with a price of its own, and one at its cost plus 25%, both under zero data retention. */
const PRICED_ID = 'zdr/claude-haiku-5.5';
const PRICED = requireModel('open/claude-haiku-5.5');
const AT_COST_ID = 'zdr/claude-sonnet-5.5';
const AT_COST = requireModel('open/claude-sonnet-5.5');
/** A model of the level Open, with no endpoint under zero data retention. */
const OPEN_LEVEL = requireOpenLevel();
const OPEN_LEVEL_ID = OPEN_LEVEL.info.id;
const NO_VISION = requireNoVision();
const NO_VISION_ID = NO_VISION.info.id.replace('open/', INFERENCE.modelPrefix.zdr);

const MESSAGES_OF_A_CHAT = [{ role: 'user', content: 'Hello' }];
const USAGE = { prompt_tokens: 1_000, completion_tokens: 500, total_tokens: 1_500 };
const ANSWER = {
  id: 'gen-1',
  object: 'chat.completion',
  created: 1,
  model: 'anthropic/claude-haiku-5.5',
  provider: 'Google',
  system_fingerprint: null,
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hi.' }, finish_reason: 'stop' }],
  usage: {
    ...USAGE,
    cost: 0.002,
    is_byok: false,
    cost_details: { upstream_inference_cost: 0.002 },
  },
};

function requireModel(id: string): NonNullable<ReturnType<typeof findModel>> {
  const model = findModel(id);
  if (model === undefined) throw new Error(`The catalog has no ${id}.`);
  return model;
}

function requireOpenLevel(): (typeof MODEL_CATALOG)[number] {
  const model = MODEL_CATALOG.find(
    ({ info }) => info.kind === 'text' && info.lane === 'open' && info.privacy === 'open',
  );
  if (model === undefined) throw new Error('The catalog has no model of text at the level Open.');
  return model;
}

function requireNoVision(): (typeof MODEL_CATALOG)[number] {
  const model = MODEL_CATALOG.find(
    ({ info }) => info.kind === 'text' && info.privacy === 'open-no-retention' && !info.vision,
  );
  if (model === undefined) throw new Error('The catalog has no ZDR model that cannot see.');
  return model;
}

function jsonAnswer(body: unknown = ANSWER, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function appAnswering(answer: () => Response = jsonAnswer): TestApp {
  return createTestApp(
    vi.fn<typeof fetch>(() => Promise.resolve(answer())),
    { accessMode: 'trial' },
  );
}

async function keyWith(ledger: Ledger, usd: number): Promise<string> {
  const secret = newBalanceSecret();
  ledger.redeem(randomUUID(), await balanceHash(secret), usdToMicros(usd), null);
  return `${INFERENCE.keyPrefix}${secret}`;
}

async function keyMicros(testApp: TestApp, key: string): Promise<number | null> {
  return testApp.ledger.balance(await balanceHash(key.slice(INFERENCE.keyPrefix.length)));
}

function postChat(testApp: TestApp, key: string | null, body: unknown): Promise<Response> {
  return Promise.resolve(
    testApp.app.request(CHAT_ROUTE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key === null ? {} : { Authorization: `Bearer ${key}` }),
      },
      body: JSON.stringify(body),
    }),
  );
}

function chatOf(model: string, more: Record<string, unknown> = {}): Record<string, unknown> {
  return { model, messages: MESSAGES_OF_A_CHAT, ...more };
}

function sentBody(fetchMock: FetchMock): Record<string, unknown> {
  const { init } = upstreamCall(fetchMock);
  if (typeof init.body !== 'string') throw new Error('The upstream body is not JSON text.');
  return JSON.parse(init.body) as Record<string, unknown>;
}

async function errorOf(response: Response): Promise<ErrorBody['error']> {
  return ((await response.json()) as ErrorBody).error;
}

/** What a chat of `USAGE` that reported `ANSWER`'s cost takes from a key. */
function chargedMicros(model: typeof PRICED): number {
  const spend = answerSpend(0.002, { inputTokens: 1_000, outputTokens: 500 }, model.cost);
  return chatPriceMicros(model, spend);
}

describe('GET /api/inference/v1/models', () => {
  it('lists every mode, and each id names its mode', async () => {
    const { app } = createTestApp();
    const { data } = (await (await app.request(MODELS_ROUTE)).json()) as InferenceModelsResponse;
    const modeOf = (id: string): string | undefined => data.find((m) => m.id === id)?.mode;
    expect(modeOf('gpt-oss-120b')).toBe('private');
    expect(modeOf(PRICED_ID)).toBe('zdr');
    expect(modeOf(OPEN_LEVEL_ID)).toBe('open');
    for (const model of data) {
      if (model.mode === 'private') expect(model.id).not.toContain('/');
      else expect(model.id.startsWith(`${model.mode}/`)).toBe(true);
    }
  });

  it('lists only models of text, each with a price', async () => {
    const { app } = createTestApp();
    const { data } = (await (await app.request(MODELS_ROUTE)).json()) as InferenceModelsResponse;
    expect(data.some((model) => model.id.includes('flux'))).toBe(false);
    expect(data.every((model) => model.pricing !== null)).toBe(true);
    expect(new Set(data.map((model) => model.id)).size).toBe(data.length);
  });
});

describe('what a plain chat sends to OpenRouter', () => {
  it('forces zero data retention in ZDR, with the key of Thinkr', async () => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, 5);
    const response = await postChat(testApp, key, chatOf(PRICED_ID));
    expect(response.status).toBe(200);
    const { url, init } = upstreamCall(testApp.fetchMock);
    expect(url).toBe(`${OPENROUTER.baseUrl}${OPENROUTER.chatCompletionsPath}`);
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${TEST_API_KEY}`);
    const sent = sentBody(testApp.fetchMock);
    expect(sent.model).toBe(PRICED.openRouterSlug);
    expect(sent.provider).toEqual(OPENROUTER.providerPreferences['open-no-retention']);
    expect(sent.stream).toBe(false);
  });

  it('refuses only the providers that collect data at the level Open', async () => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, 5);
    await postChat(testApp, key, chatOf(OPEN_LEVEL_ID));
    expect(sentBody(testApp.fetchMock).provider).toEqual(OPENROUTER.providerPreferences.open);
  });

  it('lets no caller change the privacy, the model, or the price', async () => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, 5);
    await postChat(
      testApp,
      key,
      chatOf(PRICED_ID, {
        provider: { zdr: false, data_collection: 'allow', order: ['Somebody'] },
        models: ['openai/gpt-6.1-sol'],
        route: 'fallback',
        plugins: [{ id: 'web' }],
        web_search_options: { search_context_size: 'high' },
        transforms: ['middle-out'],
        usage: { include: false },
        user: 'someone',
        n: 4,
        store: true,
        metadata: { name: 'someone' },
      }),
    );
    const sent = sentBody(testApp.fetchMock);
    expect(sent.provider).toEqual(OPENROUTER.providerPreferences['open-no-retention']);
    expect(sent.model).toBe(PRICED.openRouterSlug);
    for (const field of [
      'models',
      'route',
      'plugins',
      'web_search_options',
      'transforms',
      'usage',
      'user',
      'n',
      'store',
      'metadata',
    ]) {
      expect(sent).not.toHaveProperty(field);
    }
  });

  it('keeps the fields of the OpenAI API that a chat tunes', async () => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, 500);
    const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }];
    await postChat(
      testApp,
      key,
      chatOf(PRICED_ID, {
        temperature: 0.2,
        stop: ['x'],
        response_format: { type: 'json_object' },
        tools,
        tool_choice: 'auto',
        reasoning_effort: 'low',
      }),
    );
    expect(sentBody(testApp.fetchMock)).toMatchObject({
      temperature: 0.2,
      stop: ['x'],
      response_format: { type: 'json_object' },
      tools,
      tool_choice: 'auto',
      reasoning_effort: 'low',
    });
  });

  it('drops what a part of a message carries beyond its type', async () => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, 5);
    await postChat(testApp, key, {
      model: PRICED_ID,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Hi', cache_control: { type: 'x' } }] },
      ],
    });
    expect(sentBody(testApp.fetchMock).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    ]);
  });
});

describe('the longest answer', () => {
  /** Enough credit for the reserve of a chat and no more than a short answer on top. */
  const SMALL_USD = 0.002;

  it('stays out of a request when the credit pays more than the model can write', async () => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, 1_000);
    await postChat(testApp, key, chatOf(PRICED_ID));
    expect(sentBody(testApp.fetchMock)).not.toHaveProperty('max_tokens');
  });

  it('stops at what the credit of the key pays', async () => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, SMALL_USD);
    const body = chatOf(PRICED_ID);
    await postChat(testApp, key, body);
    const units = JSON.stringify(body).length;
    const affordable = affordableOutputTokens(PRICED, units, usdToMicros(SMALL_USD));
    expect(affordable).not.toBeNull();
    expect(affordable).toBeGreaterThanOrEqual(CREDIT.reserveOutputTokens);
    expect(sentBody(testApp.fetchMock).max_tokens).toBe(affordable);
  });

  it('takes what the caller asks for when it is less, under either name', async () => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, SMALL_USD);
    await postChat(testApp, key, chatOf(PRICED_ID, { max_completion_tokens: 12 }));
    const sent = sentBody(testApp.fetchMock);
    expect(sent.max_tokens).toBe(12);
    expect(sent).not.toHaveProperty('max_completion_tokens');
  });

  it('never goes past the credit when the caller asks for more', async () => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, SMALL_USD);
    const body = chatOf(PRICED_ID, { max_tokens: 10_000_000 });
    await postChat(testApp, key, body);
    const units = JSON.stringify(body).length;
    expect(sentBody(testApp.fetchMock).max_tokens).toBe(
      affordableOutputTokens(PRICED, units, usdToMicros(SMALL_USD)),
    );
  });

  it('passes on what the caller asks for when the credit covers it', async () => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, 1_000);
    await postChat(testApp, key, chatOf(PRICED_ID, { max_tokens: 77 }));
    expect(sentBody(testApp.fetchMock).max_tokens).toBe(77);
  });
});

describe('refusals before anything goes to OpenRouter', () => {
  const REFUSED: readonly [string, unknown, number, string][] = [
    [
      'a model of the private lane',
      chatOf('gpt-oss-120b'),
      400,
      INFERENCE.messages.privateEncrypted,
    ],
    ['an unknown model', chatOf('zdr/no-such-model'), 404, INFERENCE.messages.modelUnknown],
    [
      'a model named at the wrong mode',
      chatOf('open/claude-haiku-5.5'),
      404,
      INFERENCE.messages.modelUnknown,
    ],
    ['a model that makes images', chatOf('open/flux-3'), 404, INFERENCE.messages.modelUnknown],
    [
      'a photo for a model that cannot see',
      {
        model: NO_VISION_ID,
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }],
          },
        ],
      },
      400,
      MESSAGES.noVision,
    ],
    [
      'a server tool, which costs extra',
      chatOf(PRICED_ID, { tools: [{ type: 'openrouter:web_search' }] }),
      400,
      `tools.0.type: ${INFERENCE.messages.toolUnknown}`,
    ],
    [
      'a part with a file, which may cost extra',
      {
        model: PRICED_ID,
        messages: [{ role: 'user', content: [{ type: 'file', file: { file_data: 'x' } }] }],
      },
      400,
      `messages.0.content: ${INFERENCE.messages.partUnknown}`,
    ],
  ];

  it.each(REFUSED)('refuses %s', async (_name, body, status, message) => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, 5);
    const response = await postChat(testApp, key, body);
    expect(response.status).toBe(status);
    expect((await errorOf(response)).message).toBe(message);
    expect(testApp.fetchMock).not.toHaveBeenCalled();
    expect(await keyMicros(testApp, key)).toBe(usdToMicros(5));
  });

  it('refuses a chat with no key, and never uses the free trial', async () => {
    const testApp = appAnswering();
    const response = await postChat(testApp, null, chatOf(PRICED_ID));
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toEqual({
      code: 'balance_unknown',
      message: INFERENCE.messages.keyRequired,
    });
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a key with too little credit for the reserve of the chat', async () => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, 0.00001);
    const response = await postChat(testApp, key, chatOf(PRICED_ID));
    expect(response.status).toBe(402);
    expect(await errorOf(response)).toEqual({
      code: 'balance_low',
      message: INFERENCE.messages.creditLow,
    });
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });

  it('keeps refusing a sealed request that names a model of ZDR, as the older SDK sends it', async () => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, 5);
    const response = await testApp.app.request(CHAT_ROUTE, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        [TINFOIL.headers.encapsulatedKey]: 'ab'.repeat(32),
        [TINFOIL.headers.model]: PRICED_ID,
        [TINFOIL.headers.enclaveUrl]: 'https://inference.tinfoil.sh',
      },
      body: new Uint8Array([0, 0, 0, 3, 7, 8, 9]),
    });
    expect(response.status).toBe(404);
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });
});

describe('a chat with no stream', () => {
  it('names the id that the caller sent, and shows no cost of a provider', async () => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, 5);
    const response = await postChat(testApp, key, chatOf(PRICED_ID));
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.model).toBe(PRICED_ID);
    expect(body).not.toHaveProperty('provider');
    expect(body.usage).toEqual(USAGE);
    expect(body.choices).toEqual(ANSWER.choices);
  });

  it('pays at the price of the model, and leaves the rest on the key', async () => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, 5);
    await postChat(testApp, key, chatOf(PRICED_ID));
    expect(await keyMicros(testApp, key)).toBe(usdToMicros(5) - chargedMicros(PRICED));
  });

  it('pays the reported cost plus 25% for a model with no price of its own', async () => {
    expect(AT_COST.price).toBeNull();
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, 5);
    await postChat(testApp, key, chatOf(AT_COST_ID));
    const expected = usdToMicros(0.002 * CREDIT.markup);
    expect(await keyMicros(testApp, key)).toBe(usdToMicros(5) - expected);
  });

  it('gives a failure inside a 200 its own status, and costs nothing', async () => {
    const testApp = appAnswering(() =>
      jsonAnswer({ error: { code: 400, message: 'Too long for this model.' } }),
    );
    const key = await keyWith(testApp.ledger, 5);
    const response = await postChat(testApp, key, chatOf(PRICED_ID));
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toBe('Too long for this model.');
    expect(await keyMicros(testApp, key)).toBe(usdToMicros(5));
  });

  it('answers 503 for a failure with the name of the provider, and costs nothing', async () => {
    const testApp = appAnswering(() =>
      jsonAnswer({ error: { code: 'server_error', message: 'Provider disconnected' } }),
    );
    const key = await keyWith(testApp.ledger, 5);
    const response = await postChat(testApp, key, chatOf(PRICED_ID));
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toEqual({
      code: 'upstream_error',
      message: MESSAGES.upstreamStopped,
    });
    expect(await keyMicros(testApp, key)).toBe(usdToMicros(5));
  });

  it('pays by the estimate for an answer with no usage', async () => {
    const text = 'x'.repeat(3_000);
    const testApp = appAnswering(() =>
      jsonAnswer({ id: 'gen-1', choices: [{ message: { role: 'assistant', content: text } }] }),
    );
    const key = await keyWith(testApp.ledger, 5);
    const body = chatOf(PRICED_ID);
    await postChat(testApp, key, body);
    const inputTokens = Math.ceil(JSON.stringify(body).length / CREDIT.charsPerToken);
    const usage = { inputTokens, outputTokens: 1_000 };
    const expected = chatPriceMicros(PRICED, answerSpend(null, usage, PRICED.cost));
    expect(await keyMicros(testApp, key)).toBe(usdToMicros(5) - expected);
  });

  it('sends spaces past the first wait, then the answer, which still parses', async () => {
    // Only the timers: the hash of a key and the streams need the real event loop.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      let release = (): void => undefined;
      const later = new Promise<void>((resolve) => {
        release = resolve;
      });
      const slow = new ReadableStream<Uint8Array>({
        async start(controller) {
          await later;
          controller.enqueue(new TextEncoder().encode(JSON.stringify(ANSWER)));
          controller.close();
        },
      });
      const testApp = appAnswering(() => new Response(slow));
      const key = await keyWith(testApp.ledger, 5);
      let response: Response | undefined;
      void postChat(testApp, key, chatOf(PRICED_ID)).then((answered) => {
        response = answered;
      });
      while (response === undefined) {
        await vi.advanceTimersByTimeAsync(INFERENCE.heartbeatMs);
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(response.status).toBe(200);
      release();
      const text = await response.text();
      expect(text.startsWith(INFERENCE.heartbeat)).toBe(true);
      expect((JSON.parse(text) as { model: string }).model).toBe(PRICED_ID);
      expect(await keyMicros(testApp, key)).toBe(usdToMicros(5) - chargedMicros(PRICED));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a streamed chat', () => {
  const USAGE_CHUNK = chunk({
    id: 'gen-1',
    model: 'anthropic/claude-haiku-5.5',
    provider: 'Google',
    choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
    usage: { ...USAGE, cost: 0.002, is_byok: false, cost_details: {} },
  });

  function events(text: string): Record<string, unknown>[] {
    return text
      .split('\n')
      .filter((line) => line.startsWith('data: ') && !line.includes(OPENROUTER.streamDoneData))
      .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
  }

  function streamingApp(parts: readonly string[]): TestApp {
    return appAnswering(
      () =>
        new Response(streamOf(parts), {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    );
  }

  it('passes the events on, each without the cost and the provider', async () => {
    const testApp = streamingApp([
      ': OPENROUTER PROCESSING\n\n',
      contentChunk('Hi'),
      contentChunk(' there'),
      USAGE_CHUNK,
      DONE,
    ]);
    const key = await keyWith(testApp.ledger, 5);
    const response = await postChat(testApp, key, chatOf(PRICED_ID, { stream: true }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/event-stream');
    const text = await response.text();
    expect(text).toContain(': OPENROUTER PROCESSING');
    expect(text.trimEnd().endsWith(DONE.trim())).toBe(true);
    const parsed = events(text);
    expect(parsed.map((event) => event.model)).toEqual([PRICED_ID, PRICED_ID, PRICED_ID]);
    expect(text).not.toContain('Google');
    expect(text).not.toContain('cost');
    expect(parsed.at(-1)?.usage).toEqual(USAGE);
    expect(sentBody(testApp.fetchMock).stream).toBe(true);
  });

  it('pays at the end of the answer, at the usage of its last chunk', async () => {
    const testApp = streamingApp([contentChunk('Hi'), USAGE_CHUNK, DONE]);
    const key = await keyWith(testApp.ledger, 5);
    const response = await postChat(testApp, key, chatOf(PRICED_ID, { stream: true }));
    await response.text();
    await vi.waitFor(async () => {
      expect(await keyMicros(testApp, key)).toBe(usdToMicros(5) - chargedMicros(PRICED));
    });
  });

  it('reads a line that comes in two pieces', async () => {
    const whole = contentChunk('Hi');
    const testApp = streamingApp([whole.slice(0, 10), whole.slice(10), USAGE_CHUNK, DONE]);
    const key = await keyWith(testApp.ledger, 5);
    const response = await postChat(testApp, key, chatOf(PRICED_ID, { stream: true }));
    const parsed = events(await response.text());
    expect(parsed[0]?.choices).toMatchObject([{ delta: { content: 'Hi' } }]);
  });

  it('pays in full when the caller leaves, since the chat runs to its end', async () => {
    let release = (): void => undefined;
    const later = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(contentChunk('Hi')));
        await later;
        controller.enqueue(encoder.encode(USAGE_CHUNK));
        controller.enqueue(encoder.encode(DONE));
        controller.close();
      },
    });
    const testApp = appAnswering(() => new Response(body));
    const key = await keyWith(testApp.ledger, 5);
    const response = await postChat(testApp, key, chatOf(PRICED_ID, { stream: true }));
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    const { init } = upstreamCall(testApp.fetchMock);
    expect(init.signal?.aborted).toBe(false);
    expect(await keyMicros(testApp, key)).toBe(usdToMicros(5));
    release();
    await vi.waitFor(async () => {
      expect(await keyMicros(testApp, key)).toBe(usdToMicros(5) - chargedMicros(PRICED));
    });
  });

  it('pays at the usage even when the choices beside it have a shape of their own', async () => {
    const odd = chunk({
      choices: [{ delta: { content: [{ type: 'text', text: 'Hi' }] } }],
      usage: { ...USAGE, cost: 0.002 },
    });
    const testApp = streamingApp([contentChunk('Hi'), odd, DONE]);
    const key = await keyWith(testApp.ledger, 5);
    const response = await postChat(testApp, key, chatOf(PRICED_ID, { stream: true }));
    await response.text();
    await vi.waitFor(async () => {
      expect(await keyMicros(testApp, key)).toBe(usdToMicros(5) - chargedMicros(PRICED));
    });
  });

  it('pays by the estimate for a stream that ends with no usage', async () => {
    const text = 'x'.repeat(3_000);
    const testApp = streamingApp([contentChunk(text), DONE]);
    const key = await keyWith(testApp.ledger, 5);
    const body = chatOf(PRICED_ID, { stream: true });
    const response = await postChat(testApp, key, body);
    await response.text();
    const inputTokens = Math.ceil(JSON.stringify(body).length / CREDIT.charsPerToken);
    const usage = { inputTokens, outputTokens: 1_000 };
    const expected = chatPriceMicros(PRICED, answerSpend(null, usage, PRICED.cost));
    await vi.waitFor(async () => {
      expect(await keyMicros(testApp, key)).toBe(usdToMicros(5) - expected);
    });
  });

  it('costs nothing when the stream fails before any text', async () => {
    const testApp = streamingApp([
      chunk({
        error: { code: 'server_error', message: 'Provider down', metadata: { raw: 'x' } },
        choices: [{ delta: { content: '' }, finish_reason: 'error' }],
      }),
    ]);
    const key = await keyWith(testApp.ledger, 5);
    const response = await postChat(testApp, key, chatOf(PRICED_ID, { stream: true }));
    const parsed = events(await response.text());
    expect(parsed[0]?.error).toEqual({ code: 'server_error', message: 'Provider down' });
    await vi.waitFor(async () => {
      expect(await keyMicros(testApp, key)).toBe(usdToMicros(5));
    });
  });

  it('ends with an error event when the connection to OpenRouter breaks', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(contentChunk('Hi')));
        controller.error(new Error('broken'));
      },
    });
    const testApp = appAnswering(() => new Response(body));
    const key = await keyWith(testApp.ledger, 5);
    const response = await postChat(testApp, key, chatOf(PRICED_ID, { stream: true }));
    const parsed = events(await response.text());
    expect(parsed.at(-1)?.error).toEqual({
      code: 'upstream_error',
      message: MESSAGES.upstreamBroken,
    });
  });
});

describe('errors of OpenRouter', () => {
  const REFUSALS: readonly [number, string, number, string][] = [
    [400, 'temperature: Invalid input', 400, 'temperature: Invalid input'],
    [
      404,
      'No endpoints found that support tool use.',
      400,
      'No endpoints found that support tool use.',
    ],
    [429, 'Rate limited upstream', 429, MESSAGES.upstreamBusy],
    [503, 'No provider', 503, MESSAGES.upstreamNoProvider],
    [502, 'Model down', 503, MESSAGES.upstreamStatus(502)],
    // About the key and the credit of Thinkr, whose text the caller never sees.
    [401, 'Secret detail of the key', 503, MESSAGES.upstreamStatus(401)],
    [402, 'Your account has insufficient credits', 503, MESSAGES.upstreamStatus(402)],
    [403, 'Key limit exceeded', 503, MESSAGES.upstreamStatus(403)],
  ];

  it.each(REFUSALS)(
    'answers %i as a status and a text a caller can read',
    async (status, text, want, message) => {
      const testApp = appAnswering(() =>
        jsonAnswer(
          { error: { code: status, message: text, metadata: { x: 1 } }, user_id: 'u' },
          status,
        ),
      );
      const key = await keyWith(testApp.ledger, 5);
      const response = await postChat(testApp, key, chatOf(PRICED_ID));
      expect(response.status).toBe(want);
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({ error: { message } });
      expect(body).not.toContain('user_id');
      expect(body).not.toContain('metadata');
      expect(await keyMicros(testApp, key)).toBe(usdToMicros(5));
    },
  );

  it('answers 503 and costs nothing when OpenRouter cannot be reached', async () => {
    const testApp = createTestApp(
      vi.fn<typeof fetch>(() => Promise.reject(new Error('unreachable'))),
      { accessMode: 'trial' },
    );
    const key = await keyWith(testApp.ledger, 5);
    const response = await postChat(testApp, key, chatOf(PRICED_ID));
    expect(response.status).toBe(503);
    expect((await errorOf(response)).message).toBe(MESSAGES.upstreamUnreachable);
    expect(await keyMicros(testApp, key)).toBe(usdToMicros(5));
  });
});

describe('the chats that run on one key', () => {
  function neverAnswers(): Promise<Response> {
    return new Promise<Response>(() => undefined);
  }

  it('refuses one past the limit, and a failed chat gives its place back', async () => {
    const pending: Promise<Response>[] = [];
    const fetchMock = vi.fn<typeof fetch>(neverAnswers);
    const testApp = createTestApp(fetchMock, { accessMode: 'trial' });
    const key = await keyWith(testApp.ledger, 500);
    for (let index = 0; index < INFERENCE.maxOpenChatsPerKey; index += 1) {
      pending.push(postChat(testApp, key, chatOf(PRICED_ID)));
    }
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(INFERENCE.maxOpenChatsPerKey);
    });
    const refused = await postChat(testApp, key, chatOf(PRICED_ID));
    expect(refused.status).toBe(429);
    expect((await errorOf(refused)).message).toBe(
      INFERENCE.messages.tooManyOpen(INFERENCE.maxOpenChatsPerKey),
    );
    // Another key has places of its own.
    const other = await keyWith(testApp.ledger, 5);
    fetchMock.mockImplementationOnce(() => Promise.resolve(jsonAnswer()));
    expect((await postChat(testApp, other, chatOf(PRICED_ID))).status).toBe(200);
  });

  it('gives the place back when a chat ends', async () => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, 500);
    for (let index = 0; index < INFERENCE.maxOpenChatsPerKey + 2; index += 1) {
      const response = await postChat(testApp, key, chatOf(PRICED_ID));
      expect(response.status).toBe(200);
    }
  });
});
