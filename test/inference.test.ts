import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { findTeeModel } from '../src/catalog.js';
import { INFERENCE } from '../src/config/inference.js';
import { TINFOIL } from '../src/config/tinfoil.js';
import type { ErrorBody } from '../src/contract.js';
import { balanceHash, newBalanceSecret, usdToMicros, userPricing } from '../src/credit/balance.js';
import type { Ledger } from '../src/credit/ledger.js';
import type {
  InferenceModelsResponse,
  KeyBalanceResponse,
  KeyRedeemResponse,
} from '../src/inference/contract.js';
import { toBase64Url } from '../src/lib/bytes.js';
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

async function holderMicros(testApp: TestApp, key: string): Promise<number | null> {
  return testApp.ledger.holderBalance(await balanceHash(key.slice(INFERENCE.keyPrefix.length)));
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

function redeem(app: TestApp['app'], body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(REDEEM_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
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
  it('forwards a sealed chat and pays it from the holder credit of the key', async () => {
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
      expect(await holderMicros(testApp, key)).toBe(usdToMicros(1) - chatMicros());
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

  it('never spends the credit of a top-up', async () => {
    const testApp = appAnswering();
    const key = await keyWith(testApp.ledger, 5, 'top-up');
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
    expect(await holderMicros(testApp, key)).toBe(usdToMicros(1));
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
    expect(await holderMicros(testApp, key)).toBeNull();
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

describe('GET /api/inference/v1/balance', () => {
  it('tells the holder credit of a key', async () => {
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

describe('the holder part of a balance', () => {
  it('leaves out the credit of top-ups and a debt', async () => {
    const { ledger } = createTestApp();
    const hash = await balanceHash(newBalanceSecret());
    ledger.redeem(randomUUID(), hash, usdToMicros(2), null);
    ledger.redeem(randomUUID(), hash, usdToMicros(1), TEST_HOLDER_MONTH);
    expect(ledger.holderBalance(hash)).toBe(usdToMicros(1));
    ledger.charge(hash, usdToMicros(4), 'chat', Date.now());
    expect(ledger.holderBalance(hash)).toBe(-usdToMicros(1));
    expect(ledger.holderBalance(await balanceHash(newBalanceSecret()))).toBeNull();
  });
});
