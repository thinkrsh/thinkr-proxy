import { describe, expect, it, vi } from 'vitest';

import { MESSAGES } from '../src/config/messages.js';
import { TINFOIL } from '../src/config/tinfoil.js';
import { TRIAL } from '../src/config/trial.js';
import type { AccessResponse, ErrorBody, ModelsResponse } from '../src/contract.js';
import {
  DONE,
  chunk,
  contentChunk,
  createTestApp,
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

const HAIKU = 'open/claude-haiku-5.5';
const SEALED_ROUTE = '/api/private/v1/chat/completions';
const SEALED_HEADERS = {
  'Content-Type': 'application/json',
  [TINFOIL.headers.encapsulatedKey]: 'ab'.repeat(32),
  [TINFOIL.headers.model]: 'gpt-oss-120b',
  [TINFOIL.headers.enclaveUrl]: 'https://inference.tinfoil.sh',
};

function openAnswer(costUsd = 0.0004): Response {
  const last = chunk({
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, cost: costUsd },
  });
  return upstreamResponse([contentChunk('Hi'), last, DONE]);
}

function sealedAnswer(): Response {
  return new Response(streamOf(['sealed']), {
    status: 200,
    headers: { [TINFOIL.headers.responseNonce]: 'cd'.repeat(32) },
  });
}

function trialApp(answer: () => Response, trailers?: () => Headers): TestApp {
  const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(answer()));
  return createTestApp(fetchMock, { accessMode: 'trial', ...(trailers ? { trailers } : {}) });
}

function postSealed(app: TestApp['app'], headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(
    app.request(SEALED_ROUTE, {
      method: 'POST',
      headers: { ...SEALED_HEADERS, ...headers },
      body: new Uint8Array([0, 0, 0, 1, 9]),
    }),
  );
}

async function accessOf(app: TestApp['app'], visitor?: string): Promise<AccessResponse> {
  const init = visitor === undefined ? {} : { headers: { 'x-test-visitor': visitor } };
  return (await (await app.request('/api/access', init)).json()) as AccessResponse;
}

async function errorOf(response: Response): Promise<ErrorBody['error']> {
  return ((await response.json()) as ErrorBody).error;
}

describe('GET /api/models in each mode', () => {
  it('lists every model as open in full mode', async () => {
    const { models } = (await (
      await createTestApp().app.request('/api/models')
    ).json()) as ModelsResponse;
    expect(models.every((model) => model.available && model.lockReason === null)).toBe(true);
  });

  it('locks every model outside the trial for credit', async () => {
    const response = await trialApp(openAnswer).app.request('/api/models');
    const { models } = (await response.json()) as ModelsResponse;
    const open = models.filter((model) => model.available).map((model) => model.id);
    expect(open.sort()).toEqual([...TRIAL.modelIds].sort());
    for (const model of models.filter((item) => !item.available)) {
      expect(model.lockReason).toBe('credit');
    }
  });
});

describe('GET /api/access', () => {
  it('has no limits in full mode', async () => {
    expect(await accessOf(createTestApp().app)).toEqual({ mode: 'full', credit: null });
  });

  it('shows the free chats of today in the trial', async () => {
    expect(await accessOf(trialApp(openAnswer).app)).toEqual({
      mode: 'trial',
      lanes: {
        private: {
          chatsPerDay: TRIAL.chatsPerDay.private,
          chatsLeft: TRIAL.chatsPerDay.private,
          paused: false,
        },
        open: {
          chatsPerDay: TRIAL.chatsPerDay.open,
          chatsLeft: TRIAL.chatsPerDay.open,
          paused: false,
        },
      },
      credit: null,
    });
  });
});

describe('the trial in the open lane', () => {
  it('refuses a model outside the trial without calling upstream', async () => {
    const testApp = trialApp(openAnswer);
    const response = await postChat(testApp.app, {
      modelId: 'open/claude-opus-5.5',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toEqual({
      code: 'model_unavailable',
      message: MESSAGES.trialLocked,
    });
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });

  it('serves the chats of a day, then answers 429 for the visitor', async () => {
    const testApp = trialApp(() => openAnswer());
    const chat = { modelId: HAIKU, messages: [{ role: 'user', content: 'Hi' }] };
    for (let index = 0; index < TRIAL.chatsPerDay.open; index += 1) {
      const response = await postChat(testApp.app, chat);
      expect(response.status).toBe(200);
      await response.text();
    }
    const refused = await postChat(testApp.app, chat);
    expect(refused.status).toBe(429);
    expect((await errorOf(refused)).code).toBe('quota_exceeded');
    const other = await postChat(testApp.app, chat, { headers: { 'x-test-visitor': 'other' } });
    expect(other.status).toBe(200);
  });

  it('gives the chat back when the provider fails before the answer', async () => {
    const testApp = trialApp(() => new Response('busy', { status: 503 }));
    const response = await postChat(testApp.app, {
      modelId: HAIKU,
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(response.status).toBe(502);
    expect(await accessOf(testApp.app)).toMatchObject({
      lanes: { open: { chatsLeft: TRIAL.chatsPerDay.open } },
    });
  });

  it('pauses the lane once the answers cost its daily budget', async () => {
    const testApp = trialApp(() => openAnswer(TRIAL.dailyBudgetUsd.open));
    const chat = { modelId: HAIKU, messages: [{ role: 'user', content: 'Hi' }] };
    await (await postChat(testApp.app, chat)).text();
    const paused = await postChat(testApp.app, chat, { headers: { 'x-test-visitor': 'other' } });
    expect(paused.status).toBe(429);
    expect(await errorOf(paused)).toEqual({ code: 'trial_paused', message: MESSAGES.trialPaused });
    expect(testApp.logs.some((line) => line.startsWith('Trial paused: the open lane'))).toBe(true);
  });
});

describe('the trial in the private lane', () => {
  it('refuses a model outside the trial', async () => {
    const testApp = trialApp(sealedAnswer);
    const response = await postSealed(testApp.app, { [TINFOIL.headers.model]: 'kimi-k3' });
    expect(response.status).toBe(403);
    expect((await errorOf(response)).message).toBe(MESSAGES.trialLocked);
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });

  it('serves the sealed chats of a day, then answers 429 for the visitor', async () => {
    const testApp = trialApp(sealedAnswer);
    for (let index = 0; index < TRIAL.chatsPerDay.private; index += 1) {
      const response = await postSealed(testApp.app);
      expect(response.status).toBe(200);
      await response.text();
    }
    const refused = await postSealed(testApp.app);
    expect(refused.status).toBe(429);
    expect((await errorOf(refused)).code).toBe('quota_exceeded');
  });

  it('pays each answer from the cost in the trailer of the enclave', async () => {
    const cost = TRIAL.dailyBudgetUsd.private;
    const trailers = (): Headers =>
      new Headers({
        [TINFOIL.headers.usage]:
          `prompt=10,completion=5,model=gpt-oss-120b,cost_usd=${String(cost)}`,
      });
    const testApp = trialApp(sealedAnswer, trailers);
    await (await postSealed(testApp.app)).text();
    await vi.waitFor(async () => {
      expect(await accessOf(testApp.app)).toMatchObject({ lanes: { private: { paused: true } } });
    });
    const paused = await postSealed(testApp.app, { 'x-test-visitor': 'other' });
    expect(paused.status).toBe(429);
    expect((await errorOf(paused)).code).toBe('trial_paused');
  });

  it('gives the chat back for an EHBP problem, which carries no answer', async () => {
    const problem = (): Response =>
      new Response('{"type":"urn:ietf:params:ehbp:error:key-config"}', {
        status: 422,
        headers: { 'Content-Type': TINFOIL.problemMediaType },
      });
    const testApp = trialApp(problem);
    expect((await postSealed(testApp.app)).status).toBe(422);
    expect(await accessOf(testApp.app)).toMatchObject({
      lanes: { private: { chatsLeft: TRIAL.chatsPerDay.private } },
    });
  });
});
