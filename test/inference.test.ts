import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { findTeeModel } from '../src/catalog.js';
import { INFERENCE } from '../src/config/inference.js';
import { MESSAGES } from '../src/config/messages.js';
import { TINFOIL } from '../src/config/tinfoil.js';
import type { ErrorBody } from '../src/contract.js';
import { balanceHash, newBalanceSecret, usdToMicros, userPricing } from '../src/credit/balance.js';
import type { Ledger } from '../src/credit/ledger.js';
import type {
  EncodedChatAnswer,
  InferenceModelsResponse,
  KeyBalanceResponse,
  KeyCloseResponse,
  KeyFillResponse,
  KeyRedeemResponse,
} from '../src/inference/contract.js';
import { fromBase64Url, toBase64Url } from '../src/lib/bytes.js';
import { tokensUsd } from '../src/lib/cost.js';
import {
  TEST_HOLDER_KEY,
  TEST_HOLDER_MONTH,
  TEST_TINFOIL_KEY,
  TEST_NOTE_KEY,
  createTestApp,
  streamOf,
  upstreamCall,
  type TestApp,
} from './helpers.js';
import { signedNote } from './notes.js';

const BASE = '/api/inference';
const CHAT_ROUTE = `${BASE}${TINFOIL.chatCompletionsPath}`;
const REDEEM_ROUTE = `${BASE}${INFERENCE.redeemPath}`;
const BALANCE_ROUTE = `${BASE}${INFERENCE.balancePath}`;
const FILL_ROUTE = `${BASE}${INFERENCE.fillPath}`;
const CLOSE_ROUTE = `${BASE}${INFERENCE.closePath}`;
const MODEL = 'gpt-oss-120b';
const USAGE = { inputTokens: 1_000, outputTokens: 500 };

const SEALED_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json',
  [TINFOIL.headers.encapsulatedKey]: 'ab'.repeat(32),
  [TINFOIL.headers.model]: MODEL,
  [TINFOIL.headers.enclaveUrl]: 'https://inference.tinfoil.sh',
};

function sealedAnswer(): Response {
  return new Response(streamOf(['sealed-1', 'sealed-2']), {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      [TINFOIL.headers.responseNonce]: 'cd'.repeat(32),
    },
  });
}

/** An app whose enclave answers every sealed chat and reports the usage of `USAGE`. */
function appAnswering(answer: () => Response = sealedAnswer): TestApp {
  return createTestApp(
    vi.fn<typeof fetch>(() => Promise.resolve(answer())),
    {
      accessMode: 'trial',
      trailers: () =>
        new Headers({
          [TINFOIL.headers.usage]:
            `prompt=${String(USAGE.inputTokens)},completion=${String(USAGE.outputTokens)},model=${MODEL},cost_usd=0.0008`,
        }),
    },
  );
}

/** A new API key whose balance holds this much: from holder vouchers, or from a top-up. */
async function keyWith(ledger: Ledger, usd: number, from: 'holder' | 'top-up'): Promise<string> {
  const secret = newBalanceSecret();
  const month = from === 'holder' ? TEST_HOLDER_MONTH : null;
  ledger.redeem(randomUUID(), await balanceHash(secret), usdToMicros(usd), month);
  return `${INFERENCE.keyPrefix}${secret}`;
}

function bearer(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

function postSealed(app: TestApp['app'], headers: Record<string, string>): Promise<Response> {
  return Promise.resolve(
    app.request(CHAT_ROUTE, {
      method: 'POST',
      headers: { ...SEALED_HEADERS, ...headers },
      body: new Uint8Array([0, 0, 0, 3, 7, 8, 9]),
    }),
  );
}

async function errorOf(response: Response): Promise<ErrorBody['error']> {
  return ((await response.json()) as ErrorBody).error;
}

async function keyMicros(testApp: TestApp, key: string): Promise<number | null> {
  return testApp.ledger.balance(await balanceHash(key.slice(INFERENCE.keyPrefix.length)));
}

/** The price of one chat of `USAGE` with the model, in millionths of a dollar. */
function chatMicros(): number {
  const model = findTeeModel(MODEL);
  const pricing = model === undefined ? null : userPricing(model);
  if (pricing === null) throw new Error(`The catalog has no price for ${MODEL}.`);
  return usdToMicros(tokensUsd(USAGE, pricing));
}

async function noteFields(key: typeof TEST_HOLDER_KEY) {
  const note = await signedNote(key);
  return {
    keyId: key.keyId,
    nonce: toBase64Url(note.nonce),
    signature: toBase64Url(note.signature),
  };
}

function post(app: TestApp['app'], route: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function redeem(app: TestApp['app'], body: unknown): Promise<Response> {
  return post(app, REDEEM_ROUTE, body);
}

/** The secret of a new balance of the app that holds this much. */
async function balanceWith(
  ledger: Ledger,
  usd: number,
  from: 'holder' | 'top-up',
): Promise<string> {
  const secret = newBalanceSecret();
  const month = from === 'holder' ? TEST_HOLDER_MONTH : null;
  ledger.redeem(randomUUID(), await balanceHash(secret), usdToMicros(usd), month);
  return secret;
}

function newKey(): string {
  return `${INFERENCE.keyPrefix}${newBalanceSecret()}`;
}

describe('GET /api/inference/v1/models', () => {
  it('lists the models of the private lane that take a chat, by the name of their enclave', async () => {
    const { app } = createTestApp();
    const response = await app.request(`${BASE}${INFERENCE.modelsPath}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as InferenceModelsResponse;
    expect(body.object).toBe('list');
    const ids = body.data.map((model) => model.id);
    expect(ids).toContain(MODEL);
    expect(ids.every((id) => findTeeModel(id)?.info.lane === 'private')).toBe(true);
    const gptOss = body.data.find((model) => model.id === MODEL);
    expect(gptOss?.object).toBe('model');
    expect(gptOss?.pricing?.input_usd_per_mtok).toBeGreaterThan(0);
  });
});

describe('GET /api/inference/v1/attestation', () => {
  it('passes the bundle of the router on', async () => {
    const bundle = JSON.stringify({ domain: 'inference.tinfoil.sh', digest: 'abc' });
    const testApp = createTestApp(
      vi.fn<typeof fetch>(() => Promise.resolve(new Response(bundle, { status: 200 }))),
    );
    const response = await testApp.app.request(`${BASE}${INFERENCE.attestationPath}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(bundle);
    expect(upstreamCall(testApp.fetchMock).url).toBe(TINFOIL.attestationUrl);
  });
});

describe('POST /api/inference/v1/chat/completions', () => {
  it('forwards a sealed chat and pays it from the credit of the key', async () => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, 1, 'holder');
    const response = await postSealed(testApp.app, bearer(key));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('sealed-1sealed-2');
    const { init } = upstreamCall(testApp.fetchMock);
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${TEST_TINFOIL_KEY}`);
    expect(headers.get(TINFOIL.headers.model)).toBe(MODEL);
    await vi.waitFor(async () => {
      expect(await keyMicros(testApp, key)).toBe(usdToMicros(1) - chatMicros());
    });
  });

  it('refuses a chat without a key, and never uses the free trial', async () => {
    const testApp = appAnswering();
    const response = await postSealed(testApp.app, {});
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toEqual({
      code: 'balance_unknown',
      message: INFERENCE.messages.keyRequired,
    });
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a key that no voucher filled', async () => {
    const testApp = appAnswering();
    const response = await postSealed(testApp.app, bearer(`thkr_${newBalanceSecret()}`));
    expect(response.status).toBe(401);
    expect((await errorOf(response)).message).toBe(INFERENCE.messages.keyUnknown);
  });

  it('refuses a key of another shape, such as the bare secret of a balance', async () => {
    const testApp = appAnswering();
    const response = await postSealed(testApp.app, bearer(newBalanceSecret()));
    expect(response.status).toBe(401);
    expect((await errorOf(response)).message).toBe(INFERENCE.messages.keyRequired);
  });

  it('spends the credit of a top-up too', async () => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, 5, 'top-up');
    const response = await postSealed(testApp.app, bearer(key));
    expect(response.status).toBe(200);
    await response.text();
    await vi.waitFor(async () => {
      expect(await keyMicros(testApp, key)).toBe(usdToMicros(5) - chatMicros());
    });
  });

  it('refuses a chat once the credit of the key is gone', async () => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, 1, 'top-up');
    testApp.ledger.charge(
      await balanceHash(key.slice(INFERENCE.keyPrefix.length)),
      usdToMicros(1),
      'chat',
      Date.now(),
    );
    const response = await postSealed(testApp.app, bearer(key));
    expect(response.status).toBe(402);
    expect(await errorOf(response)).toEqual({
      code: 'balance_low',
      message: INFERENCE.messages.creditLow,
    });
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });

  it('costs nothing when the enclave fails before the answer', async () => {
    const testApp = appAnswering(() => new Response('busy', { status: 503 }));
    const key = await keyWith(testApp.ledger, 1, 'holder');
    const response = await postSealed(testApp.app, bearer(key));
    expect(response.ok).toBe(false);
    await response.text();
    expect(await keyMicros(testApp, key)).toBe(usdToMicros(1));
  });
});

describe('POST /api/inference/v1/keys/redeem', () => {
  it('fills a new key with holder vouchers, and skips them when sent again', async () => {
    const testApp = createTestApp();
    const key = `thkr_${newBalanceSecret()}`;
    const notes = [await noteFields(TEST_HOLDER_KEY), await noteFields(TEST_HOLDER_KEY)];
    const first = await redeem(testApp.app, { key, vouchers: notes });
    expect(first.status).toBe(200);
    const filled = (await first.json()) as KeyRedeemResponse;
    expect(filled.redeemed).toBe(2);
    expect(filled.spent).toBe(0);
    expect(filled.usd).toBeGreaterThan(0);
    const again = (await (
      await redeem(testApp.app, { key, vouchers: notes })
    ).json()) as KeyRedeemResponse;
    expect(again).toEqual({ usd: filled.usd, redeemed: 0, spent: 2 });
  });

  it('refuses the whole call when one voucher is of a top-up', async () => {
    const testApp = createTestApp();
    const key = `thkr_${newBalanceSecret()}`;
    const notes = [await noteFields(TEST_HOLDER_KEY), await noteFields(TEST_NOTE_KEY)];
    const response = await redeem(testApp.app, { key, vouchers: notes });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toEqual({
      code: 'voucher_invalid',
      message: INFERENCE.messages.holderOnly,
    });
    expect(await keyMicros(testApp, key)).toBeNull();
  });

  it('refuses a voucher whose signature does not hold', async () => {
    const testApp = createTestApp();
    const note = await noteFields(TEST_HOLDER_KEY);
    const forged = { ...note, nonce: (await noteFields(TEST_HOLDER_KEY)).nonce };
    const response = await redeem(testApp.app, {
      key: `thkr_${newBalanceSecret()}`,
      vouchers: [forged],
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('voucher_invalid');
  });

  it('refuses a key of another shape', async () => {
    const testApp = createTestApp();
    const response = await redeem(testApp.app, {
      key: newBalanceSecret(),
      vouchers: [await noteFields(TEST_HOLDER_KEY)],
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toBe(INFERENCE.messages.keyRequired);
  });
});

describe('an encrypted chat sent as text (30 Oct 2026)', () => {
  const FRAMES = new Uint8Array([0, 0, 0, 3, 7, 8, 9]);

  function postEncoded(
    app: TestApp['app'],
    headers: Record<string, string>,
    body: string = toBase64Url(FRAMES),
  ): Promise<Response> {
    return Promise.resolve(
      app.request(CHAT_ROUTE, {
        method: 'POST',
        headers: {
          ...SEALED_HEADERS,
          [INFERENCE.bodyEncodingHeader]: INFERENCE.bodyEncoding,
          ...headers,
        },
        body,
      }),
    );
  }

  it('sends the frames to the enclave, and answers with the whole encrypted answer', async () => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, 1, 'top-up');
    const response = await postEncoded(testApp.app, bearer(key));
    expect(response.status).toBe(200);
    const answer = (await response.json()) as EncodedChatAnswer;
    expect(answer.nonce).toBe('cd'.repeat(32));
    expect(new TextDecoder().decode(fromBase64Url(answer.ciphertext))).toBe('sealed-1sealed-2');
    const sent = upstreamCall(testApp.fetchMock).init.body as ArrayBuffer;
    expect(new Uint8Array(sent)).toEqual(FRAMES);
    await vi.waitFor(async () => {
      expect(await keyMicros(testApp, key)).toBe(usdToMicros(1) - chatMicros());
    });
  });

  it('takes spaces around the text, as a paste brings them', async () => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, 1, 'top-up');
    const response = await postEncoded(testApp.app, bearer(key), `\n${toBase64Url(FRAMES)} \n`);
    expect(response.status).toBe(200);
  });

  it.each([
    [
      'another encoding',
      { [INFERENCE.bodyEncodingHeader]: 'hex' },
      INFERENCE.messages.encodingUnknown,
    ],
    ['no key of EHBP', { [TINFOIL.headers.encapsulatedKey]: 'not hex' }, MESSAGES.notSealed],
  ])('refuses %s, and sends nothing', async (_name, headers, message) => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, 1, 'top-up');
    const response = await postEncoded(testApp.app, { ...bearer(key), ...headers });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toBe(message);
    expect(testApp.fetchMock).not.toHaveBeenCalled();
    expect(await keyMicros(testApp, key)).toBe(usdToMicros(1));
  });

  it.each(['', 'not base64!', '{"model":"gpt-oss-120b"}'])('refuses the body %j', async (body) => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, 1, 'top-up');
    const response = await postEncoded(testApp.app, bearer(key), body);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toBe(INFERENCE.messages.encodedBodyInvalid);
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });

  it('asks for a key and credit as any chat does', async () => {
    const testApp = appAnswering();
    const none = await postEncoded(testApp.app, {});
    expect(none.status).toBe(401);
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });

  it('leaves an error of the enclave as it is, and costs nothing', async () => {
    const testApp = appAnswering(() => new Response('busy', { status: 503 }));
    const key = await keyWith(testApp.ledger, 1, 'top-up');
    const response = await postEncoded(testApp.app, bearer(key));
    expect(response.ok).toBe(false);
    await response.text();
    expect(await keyMicros(testApp, key)).toBe(usdToMicros(1));
  });
});

describe('POST /api/inference/v1/keys/fill', () => {
  it('moves dollars from the balance onto a new key, top-ups included', async () => {
    const testApp = createTestApp();
    const balance = await balanceWith(testApp.ledger, 40.95, 'top-up');
    const key = newKey();
    const response = await post(testApp.app, FILL_ROUTE, {
      balance,
      key,
      usd: 5,
      fill: newBalanceSecret(),
    });
    expect(response.status).toBe(200);
    const filled = (await response.json()) as KeyFillResponse;
    expect(filled.usd).toBe(5);
    expect(filled.balance).toBeCloseTo(35.95, 6);
    expect(await keyMicros(testApp, key)).toBe(usdToMicros(5));
    expect(testApp.ledger.balance(await balanceHash(balance))).toBe(35_950_000);
  });

  it('moves nothing more when the same fill is sent again', async () => {
    const testApp = createTestApp();
    const balance = await balanceWith(testApp.ledger, 6, 'top-up');
    const key = newKey();
    const body = { balance, key, usd: 5, fill: newBalanceSecret() };
    await post(testApp.app, FILL_ROUTE, body);
    // The balance now holds too little for a second move, and the call still answers.
    const again = await post(testApp.app, FILL_ROUTE, body);
    expect(again.status).toBe(200);
    expect((await again.json()) as KeyFillResponse).toEqual({ usd: 5, balance: 1 });
  });

  it('adds to a key that holds credit', async () => {
    const testApp = createTestApp();
    const balance = await balanceWith(testApp.ledger, 10, 'top-up');
    const key = await keyWith(testApp.ledger, 1, 'holder');
    const response = await post(testApp.app, FILL_ROUTE, {
      balance,
      key,
      usd: 2.5,
      fill: newBalanceSecret(),
    });
    expect(((await response.json()) as KeyFillResponse).usd).toBe(3.5);
  });

  it('refuses more than the balance holds, and the fill can run again with less', async () => {
    const testApp = createTestApp();
    const balance = await balanceWith(testApp.ledger, 1, 'top-up');
    const key = newKey();
    const fill = newBalanceSecret();
    const response = await post(testApp.app, FILL_ROUTE, { balance, key, usd: 1.01, fill });
    expect(response.status).toBe(402);
    expect(await errorOf(response)).toEqual({
      code: 'balance_low',
      message: INFERENCE.messages.fillLow,
    });
    expect(await keyMicros(testApp, key)).toBeNull();
    expect((await post(testApp.app, FILL_ROUTE, { balance, key, usd: 1, fill })).status).toBe(200);
    expect(await keyMicros(testApp, key)).toBe(usdToMicros(1));
  });

  it('refuses a balance that does not exist', async () => {
    const testApp = createTestApp();
    const response = await post(testApp.app, FILL_ROUTE, {
      balance: newBalanceSecret(),
      key: newKey(),
      usd: 1,
      fill: newBalanceSecret(),
    });
    expect(response.status).toBe(401);
    expect((await errorOf(response)).message).toBe(INFERENCE.messages.balanceUnknown);
  });

  it('refuses a key of another shape, and a key that is the balance itself', async () => {
    const testApp = createTestApp();
    const balance = await balanceWith(testApp.ledger, 5, 'top-up');
    const fill = newBalanceSecret();
    const bare = await post(testApp.app, FILL_ROUTE, {
      balance,
      key: newBalanceSecret(),
      usd: 1,
      fill,
    });
    expect(bare.status).toBe(400);
    expect((await errorOf(bare)).message).toBe(INFERENCE.messages.keyRequired);
    const same = await post(testApp.app, FILL_ROUTE, {
      balance,
      key: `${INFERENCE.keyPrefix}${balance}`,
      usd: 1,
      fill,
    });
    expect(same.status).toBe(400);
    expect((await errorOf(same)).message).toBe(INFERENCE.messages.keyIsBalance);
    expect(testApp.ledger.balance(await balanceHash(balance))).toBe(usdToMicros(5));
  });

  it.each([0, 0.001, -1, 2_000_000])('refuses an amount of %d', async (usd) => {
    const testApp = createTestApp();
    const balance = await balanceWith(testApp.ledger, 5, 'top-up');
    const response = await post(testApp.app, FILL_ROUTE, {
      balance,
      key: newKey(),
      usd,
      fill: newBalanceSecret(),
    });
    expect(response.status).toBe(400);
    expect(testApp.ledger.balance(await balanceHash(balance))).toBe(usdToMicros(5));
  });

  it('moves the credit of holder vouchers first, as a charge takes it', async () => {
    const testApp = createTestApp();
    const { ledger } = testApp;
    const balance = await balanceWith(ledger, 2, 'top-up');
    const from = await balanceHash(balance);
    ledger.redeem(randomUUID(), from, usdToMicros(1), TEST_HOLDER_MONTH);
    const key = newKey();
    await post(testApp.app, FILL_ROUTE, { balance, key, usd: 1.5, fill: newBalanceSecret() });
    const at = Date.UTC(2026, 9, 30);
    // What stayed on the balance came from the top-up, so its use counts no holder credit.
    ledger.charge(from, usdToMicros(1), 'chat', at);
    expect(ledger.holderTotals().spent).toEqual([]);
    ledger.charge(
      await balanceHash(key.slice(INFERENCE.keyPrefix.length)),
      usdToMicros(1.5),
      'chat',
      at,
    );
    expect(ledger.holderTotals().spent).toEqual([
      { month: '2026-10', use: 'chat', micros: usdToMicros(1) },
    ]);
  });
});

describe('POST /api/inference/v1/keys/close', () => {
  it('moves what is left back to the balance, and the key stops', async () => {
    const testApp = appAnswering();
    const balance = await balanceWith(testApp.ledger, 10, 'top-up');
    const key = newKey();
    await post(testApp.app, FILL_ROUTE, { balance, key, usd: 4, fill: newBalanceSecret() });
    const response = await post(testApp.app, CLOSE_ROUTE, { balance, key });
    expect(response.status).toBe(200);
    expect(((await response.json()) as KeyCloseResponse).usd).toBe(10);
    expect(await keyMicros(testApp, key)).toBeNull();
    const chat = await postSealed(testApp.app, bearer(key));
    expect(chat.status).toBe(401);
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a key that holds nothing, and a call sent again', async () => {
    const testApp = createTestApp();
    const balance = await balanceWith(testApp.ledger, 1, 'top-up');
    const key = await keyWith(testApp.ledger, 1, 'top-up');
    expect((await post(testApp.app, CLOSE_ROUTE, { balance, key })).status).toBe(200);
    const again = await post(testApp.app, CLOSE_ROUTE, { balance, key });
    expect(again.status).toBe(401);
    expect((await errorOf(again)).message).toBe(INFERENCE.messages.keyUnknown);
    expect(testApp.ledger.balance(await balanceHash(balance))).toBe(usdToMicros(2));
  });

  it('refuses a key of another shape', async () => {
    const testApp = createTestApp();
    const balance = await balanceWith(testApp.ledger, 1, 'top-up');
    const response = await post(testApp.app, CLOSE_ROUTE, { balance, key: newBalanceSecret() });
    expect(response.status).toBe(400);
  });
});

describe('GET /api/inference/v1/balance', () => {
  it('tells the credit of a key', async () => {
    const testApp = createTestApp();
    const key = await keyWith(testApp.ledger, 1.2, 'holder');
    const response = await testApp.app.request(BALANCE_ROUTE, { headers: bearer(key) });
    expect(response.status).toBe(200);
    expect(((await response.json()) as KeyBalanceResponse).usd).toBeCloseTo(1.2, 6);
  });

  it('takes the name of the scheme in any case', async () => {
    const testApp = createTestApp();
    const key = await keyWith(testApp.ledger, 1, 'holder');
    const response = await testApp.app.request(BALANCE_ROUTE, {
      headers: { Authorization: `bearer ${key}` },
    });
    expect(response.status).toBe(200);
  });
});
