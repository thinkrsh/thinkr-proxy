import { afterEach, describe, expect, it, vi } from 'vitest';

import { HOLDER_PASS } from '../src/config/holderPass.js';
import { TINFOIL } from '../src/config/tinfoil.js';
import { TRIAL } from '../src/config/trial.js';
import type { ErrorBody, HolderTotalsResponse, ModelsResponse } from '../src/contract.js';
import { toBase64Url } from '../src/lib/bytes.js';
import {
  TEST_NOTE_KEYS,
  TEST_PASS_KEY,
  createTestApp,
  issuerBlindSign,
  streamOf,
  upstreamCall,
  type TestApp,
} from './helpers.js';
import { blindNotes, finalizeNote } from './notes.js';

const NOW = Date.UTC(2026, 9, 31, 12);
const ENCLAVE = 'https://inference.tinfoil.sh';
const ROUTE = '/api/private/v1/chat/completions';
const SEALED_BODY = new Uint8Array([0, 0, 0, 3, 7, 8, 9]);
const FREE_MODEL = 'gpt-oss-120b';
const CREDIT_MODEL = 'kimi-k3';

const SEALED_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json',
  [TINFOIL.headers.encapsulatedKey]: 'ab'.repeat(32),
  [TINFOIL.headers.model]: FREE_MODEL,
  [TINFOIL.headers.enclaveUrl]: ENCLAVE,
};

function sealedAnswer(status = 200): Response {
  return new Response(status === 200 ? streamOf(['sealed']) : 'failed', {
    status,
    headers: {
      'Content-Type': 'text/event-stream',
      [TINFOIL.headers.responseNonce]: 'cd'.repeat(32),
    },
  });
}

function trialApp(
  answer: () => Response = () => sealedAnswer(),
  trailers?: () => Headers,
): TestApp {
  return createTestApp(
    vi.fn<typeof fetch>(() => Promise.resolve(answer())),
    {
      accessMode: 'trial',
      now: () => NOW,
      ...(trailers === undefined ? {} : { trailers }),
    },
  );
}

/** A pass as the app holds it, once the issuer signed it blind. */
async function newPass(key = TEST_PASS_KEY): Promise<string> {
  const [note] = await blindNotes(key, 1);
  if (note === undefined) throw new Error('No note.');
  const signed = await finalizeNote(key, note, issuerBlindSign(key, note.blinded));
  return [key.keyId, toBase64Url(signed.nonce), toBase64Url(signed.signature)].join(
    HOLDER_PASS.separator,
  );
}

function post(
  { app }: TestApp,
  headers: Record<string, string> = {},
  body: Uint8Array = SEALED_BODY,
): Promise<Response> {
  return Promise.resolve(
    app.request(ROUTE, {
      method: 'POST',
      headers: { ...SEALED_HEADERS, ...headers },
      body,
    }),
  );
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as ErrorBody).error.code;
}

async function drain(response: Response): Promise<void> {
  await response.text();
}

async function totals({ app }: TestApp): Promise<HolderTotalsResponse> {
  return (await (await app.request('/api/credit/holder-totals')).json()) as HolderTotalsResponse;
}

async function trialChatsLeft({ app }: TestApp): Promise<number> {
  const access = (await (await app.request('/api/access')).json()) as {
    lanes: { private: { chatsLeft: number } };
  };
  return access.lanes.private.chatsLeft;
}

describe('a free chat on the pass of a holder', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('goes to the enclave with no pass in its headers, and takes no chat of the trial', async () => {
    const test = trialApp();
    const response = await post(test, { [HOLDER_PASS.header]: await newPass() });
    expect(response.status).toBe(200);
    await drain(response);
    const sent = new Headers(upstreamCall(test.fetchMock).init.headers);
    expect(sent.has(HOLDER_PASS.header)).toBe(false);
    expect(await trialChatsLeft(test)).toBe(TRIAL.chatsPerDay.private);
  });

  it('counts the free chat by month, with what it cost', async () => {
    const usage = (): Headers =>
      new Headers({ [TINFOIL.headers.usage]: 'prompt=1000,completion=500' });
    const test = trialApp(() => sealedAnswer(), usage);
    await drain(await post(test, { [HOLDER_PASS.header]: await newPass() }));
    await vi.waitFor(async () => {
      const { passes } = await totals(test);
      expect(passes).toHaveLength(1);
      expect(passes[0]).toMatchObject({ month: '2026-10', chats: 1 });
    });
  });

  it('spends a pass once', async () => {
    const test = trialApp();
    const pass = await newPass();
    await drain(await post(test, { [HOLDER_PASS.header]: pass }));
    const again = await post(test, { [HOLDER_PASS.header]: pass });
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe('pass_spent');
    expect(test.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives the pass back when the enclave fails first', async () => {
    const answers = [sealedAnswer(500), sealedAnswer()];
    const test = trialApp(() => answers.shift() ?? sealedAnswer());
    const pass = await newPass();
    await drain(await post(test, { [HOLDER_PASS.header]: pass }));
    const again = await post(test, { [HOLDER_PASS.header]: pass });
    expect(again.status).toBe(200);
    await drain(again);
  });

  it('refuses a false pass, a pass of another key, and a note of credit', async () => {
    const test = trialApp();
    const forged = await newPass();
    const parts = forged.split(HOLDER_PASS.separator);
    parts[2] = toBase64Url(new Uint8Array(256));
    const refused = await post(test, { [HOLDER_PASS.header]: parts.join(HOLDER_PASS.separator) });
    expect(refused.status).toBe(400);
    expect(await errorCode(refused)).toBe('pass_invalid');

    const note = await post(test, { [HOLDER_PASS.header]: await newPass(TEST_NOTE_KEYS.topUp) });
    expect(await errorCode(note)).toBe('pass_invalid');

    const shapeless = await post(test, { [HOLDER_PASS.header]: 'not a pass' });
    expect(await errorCode(shapeless)).toBe('pass_invalid');
    expect(test.fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a pass of the month before', async () => {
    const test = createTestApp(
      vi.fn<typeof fetch>(() => Promise.resolve(sealedAnswer())),
      { accessMode: 'trial', now: () => Date.UTC(2026, 10, 1, 0, 1) },
    );
    const response = await post(test, { [HOLDER_PASS.header]: await newPass() });
    expect(await errorCode(response)).toBe('pass_invalid');
  });

  it('never fills a balance', async () => {
    const test = trialApp();
    const pass = await newPass();
    const [, nonce, signature] = pass.split(HOLDER_PASS.separator);
    const response = await test.app.request('/api/credit/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keyId: TEST_PASS_KEY.keyId,
        nonce,
        signature,
        balance: toBase64Url(new Uint8Array(32)),
      }),
    });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('key_changed');
  });

  it('takes no model outside the free chats, and no web search, and leaves the pass', async () => {
    const test = trialApp();
    const pass = await newPass();
    const dear = await post(test, {
      [HOLDER_PASS.header]: pass,
      [TINFOIL.headers.model]: CREDIT_MODEL,
    });
    expect(dear.status).toBe(403);
    expect(await errorCode(dear)).toBe('model_unavailable');
    const searching = await post(test, {
      [HOLDER_PASS.header]: pass,
      [TINFOIL.headers.events]: TINFOIL.webSearchEvents,
    });
    expect(await errorCode(searching)).toBe('model_unavailable');
    const plain = await post(test, { [HOLDER_PASS.header]: pass });
    expect(plain.status).toBe(200);
    await drain(plain);
  });

  it('leaves a chat too long for a free chat to credit, with the pass unspent', async () => {
    const test = trialApp();
    const pass = await newPass();
    const headers = {
      [HOLDER_PASS.header]: pass,
      [TINFOIL.headers.model]: 'deepseek-v4-1-flash',
    };
    const long = await post(test, headers, new Uint8Array(1_000_000));
    expect(long.status).toBe(413);
    expect(await errorCode(long)).toBe('pass_too_long');
    const short = await post(test, headers);
    expect(short.status).toBe(200);
    await drain(short);
  });

  it('marks the models of free chats in the catalog', async () => {
    const test = trialApp();
    const { models } = (await (await test.app.request('/api/models')).json()) as ModelsResponse;
    const free = models.filter((model) => model.holderFree).map((model) => model.id);
    expect(free.sort()).toEqual([...HOLDER_PASS.modelIds].sort());
  });
});

describe('the budget of free chats', () => {
  it('pauses them past the budget of the day, with the pass unspent', async () => {
    const trailers = (): Headers =>
      new Headers({
        [TINFOIL.headers.usage]:
          `prompt=1,completion=1,cost_usd=${String(HOLDER_PASS.dailyBudgetUsd)}`,
      });
    const test = trialApp(() => sealedAnswer(), trailers);
    await drain(await post(test, { [HOLDER_PASS.header]: await newPass() }));
    await vi.waitFor(async () => {
      expect((await totals(test)).passes).toHaveLength(1);
    });
    const pass = await newPass();
    const paused = await post(test, { [HOLDER_PASS.header]: pass });
    expect(paused.status).toBe(429);
    expect(await errorCode(paused)).toBe('pass_paused');
  });
});

describe('the free trial', () => {
  it('opens 3 chats a day in each lane', () => {
    expect(TRIAL.chatsPerDay).toEqual({ private: 3, open: 3 });
  });
});
