import { describe, expect, it, vi } from 'vitest';

import { findModel } from '../src/catalog.js';
import { CREDIT } from '../src/config/credit.js';
import { TINFOIL } from '../src/config/tinfoil.js';
import { TRIAL } from '../src/config/trial.js';
import { WEB_SEARCH_COST_USD, WEB_SEARCH_TOOL } from '../src/config/webSearch.js';
import type { AccessResponse, ErrorBody, ModelPricing, ModelsResponse } from '../src/contract.js';
import {
  balanceHash,
  microsToUsd,
  reserveMicros,
  searchPriceUsd,
  usdToMicros,
} from '../src/credit/balance.js';
import { tokensUsd } from '../src/lib/cost.js';
import {
  DONE,
  VALID_CHAT,
  balanceHeader,
  chunk,
  contentChunk,
  createTestApp,
  fundedBalance,
  postChat,
  streamOf,
  upstreamResponse,
  type TestApp,
} from './helpers.js';

// The live trial opens every model. These tests run the narrower trial of narrow-trial.ts, so that
// a model outside the trial exists.
vi.mock('../src/config/trial.js', async (importOriginal) => {
  const { narrowTrial } = await import('./narrow-trial.js');
  return narrowTrial(importOriginal);
});

// A model outside the free trial: locked for visitors, open to credit.
const CREDIT_MODEL = VALID_CHAT.modelId;
const SEALED_HEADERS = {
  'Content-Type': 'application/json',
  [TINFOIL.headers.encapsulatedKey]: 'ab'.repeat(32),
  [TINFOIL.headers.model]: 'gpt-oss-120b',
  [TINFOIL.headers.enclaveUrl]: 'https://inference.tinfoil.sh',
};

// The tokens of the answer of openAnswer.
const OPEN_USAGE = { inputTokens: 10, outputTokens: 2 };

function openAnswer(costUsd: number): Response {
  const last = chunk({
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: OPEN_USAGE.inputTokens,
      completion_tokens: OPEN_USAGE.outputTokens,
      cost: costUsd,
    },
  });
  return upstreamResponse([contentChunk('Hi'), last, DONE]);
}

/** The price of decision 132 of a model of the catalog. */
function priceOf(modelId: string): ModelPricing {
  const price = findModel(modelId)?.price;
  if (!price) throw new Error(`${modelId} has no price of its own.`);
  return price;
}

function trialApp(answer: () => Response, trailers?: () => Headers): TestApp {
  const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(answer()));
  return createTestApp(fetchMock, { accessMode: 'trial', ...(trailers ? { trailers } : {}) });
}

async function micros(testApp: TestApp, secret: string): Promise<number | null> {
  return testApp.ledger.balance(await balanceHash(secret));
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as ErrorBody).error.code;
}

describe('a chat paid from a balance', () => {
  it('opens a model outside the trial and costs the answer plus 25%', async () => {
    const testApp = trialApp(() => openAnswer(0.0004));
    const secret = await fundedBalance(testApp.ledger, 1);
    const response = await postChat(testApp.app, VALID_CHAT, { headers: balanceHeader(secret) });
    expect(response.status).toBe(200);
    await response.text();
    expect(await micros(testApp, secret)).toBe(
      usdToMicros(1) - usdToMicros(0.0004 * CREDIT.markup),
    );
  });

  it('costs a model with a price its tokens at that price, whatever the provider charged', async () => {
    const testApp = trialApp(() => openAnswer(0.0004));
    const secret = await fundedBalance(testApp.ledger, 1);
    const haiku = { ...VALID_CHAT, modelId: 'open/claude-haiku-5.5' };
    await (await postChat(testApp.app, haiku, { headers: balanceHeader(secret) })).text();
    expect(await micros(testApp, secret)).toBe(
      usdToMicros(1) - usdToMicros(tokensUsd(OPEN_USAGE, priceOf(haiku.modelId))),
    );
  });

  it('leaves the free chats of the visitor alone', async () => {
    const testApp = trialApp(() => openAnswer(0.0004));
    const secret = await fundedBalance(testApp.ledger, 1);
    const haiku = { ...VALID_CHAT, modelId: 'open/claude-haiku-5.5' };
    await (await postChat(testApp.app, haiku, { headers: balanceHeader(secret) })).text();
    const access = (await (
      await testApp.app.request('/api/access', { headers: balanceHeader(secret) })
    ).json()) as AccessResponse;
    expect(access.mode === 'trial' && access.lanes.open.chatsLeft).toBe(TRIAL.chatsPerDay.open);
    const charged = usdToMicros(tokensUsd(OPEN_USAGE, priceOf(haiku.modelId)));
    expect(access.credit?.usd).toBeCloseTo(1 - microsToUsd(charged), 6);
  });

  it('pays a sealed chat by the tokens in the trailer of the enclave, at the price of its model', async () => {
    const trailers = (): Headers =>
      new Headers({
        [TINFOIL.headers.usage]: 'prompt=10,completion=5,model=gpt-oss-120b,cost_usd=0.0008',
      });
    const sealed = (): Response =>
      new Response(streamOf(['sealed']), {
        status: 200,
        headers: { [TINFOIL.headers.responseNonce]: 'cd'.repeat(32) },
      });
    const testApp = trialApp(sealed, trailers);
    const secret = await fundedBalance(testApp.ledger, 1);
    const response = await testApp.app.request('/api/private/v1/chat/completions', {
      method: 'POST',
      headers: { ...SEALED_HEADERS, ...balanceHeader(secret) },
      body: new Uint8Array([0, 0, 0, 1, 9]),
    });
    await response.text();
    const usage = { inputTokens: 10, outputTokens: 5 };
    await vi.waitFor(async () => {
      expect(await micros(testApp, secret)).toBe(
        usdToMicros(1) - usdToMicros(tokensUsd(usage, priceOf('private/gpt-oss-120b'))),
      );
    });
  });

  it('refuses a chat that the balance cannot cover', async () => {
    const testApp = trialApp(() => openAnswer(0.0004));
    const secret = await fundedBalance(testApp.ledger, 0.000001);
    const response = await postChat(testApp.app, VALID_CHAT, { headers: balanceHeader(secret) });
    expect(response.status).toBe(402);
    expect(await errorCode(response)).toBe('balance_low');
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a balance that does not exist', async () => {
    const testApp = trialApp(() => openAnswer(0.0004));
    const response = await postChat(testApp.app, VALID_CHAT, {
      headers: balanceHeader('B'.repeat(43)),
    });
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('balance_unknown');
  });

  it('costs nothing when the provider fails before the answer', async () => {
    const testApp = trialApp(() => new Response('busy', { status: 503 }));
    const secret = await fundedBalance(testApp.ledger, 1);
    const response = await postChat(testApp.app, VALID_CHAT, { headers: balanceHeader(secret) });
    expect(response.status).toBe(502);
    expect(await micros(testApp, secret)).toBe(usdToMicros(1));
  });
});

describe('GET /api/models with a balance', () => {
  async function lockedModels(testApp: TestApp, headers: Record<string, string>) {
    const response = await testApp.app.request('/api/models', { headers });
    const { models } = (await response.json()) as ModelsResponse;
    return models.filter((model) => model.lockReason === 'credit').map((model) => model.id);
  }

  it('opens the models of credit while the balance has credit', async () => {
    const testApp = trialApp(() => openAnswer(0.0004));
    const secret = await fundedBalance(testApp.ledger, 1);
    expect(await lockedModels(testApp, {})).toContain(CREDIT_MODEL);
    expect(await lockedModels(testApp, balanceHeader(secret))).toEqual([]);
  });

  it('keeps them locked for an empty or unknown balance', async () => {
    const testApp = trialApp(() => openAnswer(0.0004));
    const empty = await fundedBalance(testApp.ledger, 0);
    expect(await lockedModels(testApp, balanceHeader(empty))).toContain(CREDIT_MODEL);
    expect(await lockedModels(testApp, balanceHeader('C'.repeat(43)))).toContain(CREDIT_MODEL);
  });
});

describe('web search and documents in the private lane (decision 142)', () => {
  const NONCE = { [TINFOIL.headers.responseNonce]: 'cd'.repeat(32) };
  const SEARCH = { [TINFOIL.headers.events]: TINFOIL.webSearchEvents };
  const SEARCHED_TWICE =
    'prompt=10,completion=5,model=gpt-oss-120b,web_search_calls=2,cost_usd=0.0508';
  const usage = { inputTokens: 10, outputTokens: 5 };
  const tokens = (): number => usdToMicros(tokensUsd(usage, priceOf('private/gpt-oss-120b')));

  function sealedApp(trailer: string, answer = (): Response => sealedOk()): TestApp {
    return trialApp(answer, () => new Headers({ [TINFOIL.headers.usage]: trailer }));
  }

  function sealedOk(): Response {
    return new Response(streamOf(['sealed']), { status: 200, headers: NONCE });
  }

  function postSealedChat(testApp: TestApp, headers: Record<string, string>): Promise<Response> {
    return Promise.resolve(
      testApp.app.request('/api/private/v1/chat/completions', {
        method: 'POST',
        headers: { ...SEALED_HEADERS, ...headers },
        body: new Uint8Array([0, 0, 0, 1, 9]),
      }),
    );
  }

  function postDocument(testApp: TestApp, headers: Record<string, string>): Promise<Response> {
    return Promise.resolve(
      testApp.app.request('/api/private/v1/convert/file', {
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=thinkr',
          [TINFOIL.headers.encapsulatedKey]: 'ab'.repeat(32),
          [TINFOIL.headers.enclaveUrl]: 'https://inference.tinfoil.sh',
          ...headers,
        },
        body: new Uint8Array([0, 0, 0, 1, 9]),
      }),
    );
  }

  it('prices both at the fees of Tinfoil plus 25%', () => {
    expect(CREDIT.webSearchUsd).toBeCloseTo(TINFOIL.fees.webSearchUsd * CREDIT.markup, 10);
    expect(CREDIT.documentUsd).toBeCloseTo(TINFOIL.fees.documentUsd * CREDIT.markup, 10);
  });

  it('adds the price of web search once to an answer that searched, however often', async () => {
    const testApp = sealedApp(SEARCHED_TWICE);
    const secret = await fundedBalance(testApp.ledger, 1);
    await (await postSealedChat(testApp, { ...SEARCH, ...balanceHeader(secret) })).text();
    await vi.waitFor(async () => {
      expect(await micros(testApp, secret)).toBe(
        usdToMicros(1) -
          usdToMicros(tokensUsd(usage, priceOf('private/gpt-oss-120b')) + CREDIT.webSearchUsd),
      );
    });
  });

  it('charges no search when the answer did not search', async () => {
    const testApp = sealedApp('prompt=10,completion=5,model=gpt-oss-120b,cost_usd=0.0008');
    const secret = await fundedBalance(testApp.ledger, 1);
    await (await postSealedChat(testApp, { ...SEARCH, ...balanceHeader(secret) })).text();
    await vi.waitFor(async () => {
      expect(await micros(testApp, secret)).toBe(usdToMicros(1) - tokens());
    });
  });

  it('holds the price of web search in the reserve before the chat starts', async () => {
    const model = findModel('private/gpt-oss-120b');
    if (!model) throw new Error('The catalog lost GPT-OSS 120B.');
    const plain = reserveMicros(model, 5);
    expect(reserveMicros(model, 5, true)).toBe(plain + usdToMicros(CREDIT.webSearchUsd));
    const testApp = sealedApp(SEARCHED_TWICE);
    const secret = await fundedBalance(testApp.ledger, microsToUsd(plain));
    const response = await postSealedChat(testApp, { ...SEARCH, ...balanceHeader(secret) });
    expect(response.status).toBe(402);
    expect(testApp.fetchMock).not.toHaveBeenCalled();
    expect((await postSealedChat(testApp, balanceHeader(secret))).status).toBe(200);
  });

  it('never holds more input than the context of the model, whatever the photos weigh', () => {
    const model = findModel('private/kimi-k3');
    if (!model) throw new Error('The catalog lost Kimi K3.');
    const contextBytes = model.info.contextTokens * CREDIT.charsPerToken;
    expect(reserveMicros(model, contextBytes * 10)).toBe(reserveMicros(model, contextBytes));
  });

  async function privateLane(testApp: TestApp) {
    const access = (await (await testApp.app.request('/api/access')).json()) as AccessResponse;
    if (access.mode !== 'trial') throw new Error('The test app runs the free trial.');
    return access.lanes.private;
  }

  it('lets the free trial search the web, with the fee in the budget of the lane', async () => {
    const pricey = `prompt=10,completion=5,web_search_calls=1,cost_usd=${String(TRIAL.dailyBudgetUsd.private + 0.01)}`;
    const testApp = sealedApp(pricey);
    const response = await postSealedChat(testApp, SEARCH);
    expect(response.status).toBe(200);
    await response.text();
    await vi.waitFor(async () => {
      expect((await privateLane(testApp)).paused).toBe(true);
    });
    expect(testApp.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('charges a document once it is converted', async () => {
    const testApp = sealedApp('');
    const secret = await fundedBalance(testApp.ledger, 1);
    const response = await postDocument(testApp, balanceHeader(secret));
    expect(response.status).toBe(200);
    await response.text();
    await vi.waitFor(async () => {
      expect(await micros(testApp, secret)).toBe(usdToMicros(1) - usdToMicros(CREDIT.documentUsd));
    });
  });

  it('charges nothing for a document that fails', async () => {
    const testApp = sealedApp('', () => new Response('busy', { status: 503 }));
    const secret = await fundedBalance(testApp.ledger, 1);
    const response = await postDocument(testApp, balanceHeader(secret));
    expect(response.status).toBe(502);
    expect(await micros(testApp, secret)).toBe(usdToMicros(1));
  });

  it('counts a document of the free trial as one of its chats', async () => {
    const testApp = sealedApp('');
    const response = await postDocument(testApp, {});
    expect(response.status).toBe(200);
    await response.text();
    expect((await privateLane(testApp)).chatsLeft).toBe(TRIAL.chatsPerDay.private - 1);
  });

  it('gives the chat back when a document of the free trial fails', async () => {
    const testApp = sealedApp('', () => new Response('busy', { status: 503 }));
    expect((await postDocument(testApp, {})).status).toBe(502);
    expect((await privateLane(testApp)).chatsLeft).toBe(TRIAL.chatsPerDay.private);
  });

  it('refuses a document that the balance cannot cover', async () => {
    const testApp = sealedApp('');
    const poor = await fundedBalance(testApp.ledger, CREDIT.documentUsd / 2);
    expect((await postDocument(testApp, balanceHeader(poor))).status).toBe(402);
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });
});

describe('web search in the open lane (29 Oct 2026)', () => {
  const HAIKU_SEARCH = { ...VALID_CHAT, modelId: 'open/claude-haiku-5.5', webSearch: true };

  function searchedAnswer(costUsd: number, searches: number): Response {
    const last = chunk({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: OPEN_USAGE.inputTokens,
        completion_tokens: OPEN_USAGE.outputTokens,
        cost: costUsd,
        server_tool_use_details: { web_search_requests: searches },
      },
    });
    return upstreamResponse([contentChunk('Hi'), last, DONE]);
  }

  async function openLane(testApp: TestApp) {
    const access = (await (await testApp.app.request('/api/access')).json()) as AccessResponse;
    if (access.mode !== 'trial') throw new Error('The test app runs the free trial.');
    return access.lanes.open;
  }

  it('prices a search at the fee of Exa plus 25% (decision 134)', () => {
    expect(CREDIT.openWebSearchUsd).toBeCloseTo(WEB_SEARCH_COST_USD * CREDIT.markup, 10);
  });

  it('prices each search of the open lane, and the private lane once an answer', () => {
    expect(searchPriceUsd('open', 0)).toBe(0);
    expect(searchPriceUsd('open', 3)).toBe(3 * CREDIT.openWebSearchUsd);
    expect(searchPriceUsd('private', 0)).toBe(0);
    expect(searchPriceUsd('private', 2)).toBe(CREDIT.webSearchUsd);
  });

  it('adds the price of each search to the tokens of a model with a price', async () => {
    const testApp = trialApp(() => searchedAnswer(0.0144, 2));
    const secret = await fundedBalance(testApp.ledger, 1);
    await (await postChat(testApp.app, HAIKU_SEARCH, { headers: balanceHeader(secret) })).text();
    const tokens = tokensUsd(OPEN_USAGE, priceOf(HAIKU_SEARCH.modelId));
    expect(await micros(testApp, secret)).toBe(
      usdToMicros(1) - usdToMicros(tokens + 2 * CREDIT.openWebSearchUsd),
    );
  });

  it('charges a model with no price what the answer cost, searches included, plus 25%', async () => {
    const testApp = trialApp(() => searchedAnswer(0.0144, 2));
    const secret = await fundedBalance(testApp.ledger, 1);
    const chat = { ...VALID_CHAT, webSearch: true };
    await (await postChat(testApp.app, chat, { headers: balanceHeader(secret) })).text();
    expect(await micros(testApp, secret)).toBe(
      usdToMicros(1) - usdToMicros(0.0144 * CREDIT.markup),
    );
  });

  it('holds the most that the searches of an answer can cost in the reserve', async () => {
    const model = findModel(HAIKU_SEARCH.modelId);
    if (!model) throw new Error('The catalog lost Claude Haiku 5.5.');
    const plain = reserveMicros(model, VALID_CHAT.messages[0]?.content.length ?? 0);
    const most = searchPriceUsd('open', WEB_SEARCH_TOOL.parameters.max_uses);
    const withSearch = reserveMicros(model, VALID_CHAT.messages[0]?.content.length ?? 0, true);
    expect(microsToUsd(withSearch - plain)).toBeCloseTo(most, 5);
    const testApp = trialApp(() => searchedAnswer(0.0144, 2));
    const secret = await fundedBalance(testApp.ledger, microsToUsd(plain));
    const searching = await postChat(testApp.app, HAIKU_SEARCH, { headers: balanceHeader(secret) });
    expect(searching.status).toBe(402);
    expect(testApp.fetchMock).not.toHaveBeenCalled();
    const plainChat = { ...HAIKU_SEARCH, webSearch: false };
    const answered = await postChat(testApp.app, plainChat, { headers: balanceHeader(secret) });
    expect(answered.status).toBe(200);
  });

  it('lets the free trial search the web, with the cost in the budget of the lane', async () => {
    const testApp = trialApp(() => searchedAnswer(TRIAL.dailyBudgetUsd.open + 0.01, 1));
    const response = await postChat(testApp.app, HAIKU_SEARCH);
    expect(response.status).toBe(200);
    await response.text();
    await vi.waitFor(async () => {
      expect((await openLane(testApp)).paused).toBe(true);
    });
    expect(testApp.fetchMock).toHaveBeenCalledTimes(1);
  });
});
