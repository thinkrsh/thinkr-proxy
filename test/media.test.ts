import { describe, expect, it, vi } from 'vitest';

import { findModel } from '../src/catalog.js';
import { CREDIT } from '../src/config/credit.js';
import { MEDIA } from '../src/config/media.js';
import { MESSAGES } from '../src/config/messages.js';
import { OPENROUTER } from '../src/config/openrouter.js';
import { TRIAL } from '../src/config/trial.js';
import type {
  AccessResponse,
  ErrorBody,
  ImageResponse,
  ModelsResponse,
  VideoJobResponse,
  VideoStatusResponse,
} from '../src/contract.js';
import { balanceHash, mediaPriceUsd, usdToMicros } from '../src/credit/balance.js';
import type { ImageChatBody, ImagesApiBody } from '../src/media/image.js';
import type { VideoUpstreamBody } from '../src/media/video.js';
import {
  balanceHeader,
  createTestApp,
  fundedBalance,
  upstreamCall,
  type FetchMock,
  type TestApp,
} from './helpers.js';

const ZDR_IMAGE = 'open/nano-banana-2';
const OPEN_IMAGE = 'open/gpt-image-2';
const VIDEO = 'open/wan-3.0';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JOB_ID = 'job-1';
const VIDEO_BYTES = 'not really an mp4';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function imageAnswer(options: { cost?: number; images?: string[]; text?: string } = {}): Response {
  const { cost, images = [PNG], text = '' } = options;
  return json({
    choices: [
      {
        message: {
          role: 'assistant',
          content: text,
          images: images.map((url) => ({ type: 'image_url', image_url: { url } })),
        },
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 1290, ...(cost === undefined ? {} : { cost }) },
  });
}

function settingsOf(modelId: string): { costUsd: number } {
  const media = findModel(modelId)?.media;
  if (media === undefined) throw new Error(`${modelId} makes no media.`);
  return media;
}

/** What a balance pays for media that cost `costUsd` at the provider: plus 25% (decision 52). */
function paid(costUsd: number): number {
  return usdToMicros(costUsd * CREDIT.markup);
}

function post(testApp: TestApp, path: string, body: unknown, headers = {}): Promise<Response> {
  return Promise.resolve(
    testApp.app.request(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function get(testApp: TestApp, path: string, headers: Record<string, string>): Promise<Response> {
  return Promise.resolve(testApp.app.request(`/api${path}`, { headers }));
}

async function errorOf(response: Response): Promise<ErrorBody['error']> {
  return ((await response.json()) as ErrorBody).error;
}

async function balanceOf(testApp: TestApp, secret: string): Promise<number | null> {
  return testApp.ledger.balance(await balanceHash(secret));
}

function bodyOf(fetchMock: FetchMock, index = 0): unknown {
  const { init } = upstreamCall(fetchMock, index);
  if (typeof init.body !== 'string') throw new Error('The upstream body is not JSON.');
  return JSON.parse(init.body) as unknown;
}

/** The address of a request that the fake OpenRouter got. */
function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

describe('GET /api/models, the kinds', () => {
  it('lists text models only to an app that names no kinds', async () => {
    const response = await createTestApp().app.request('/api/models');
    const { models } = (await response.json()) as ModelsResponse;
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.kind === 'text' && model.media === null)).toBe(true);
  });

  it('lists images and video with their price, about, when the app asks for them', async () => {
    const response = await createTestApp().app.request('/api/models?kinds=text,image,video');
    const { models } = (await response.json()) as ModelsResponse;
    const video = models.find((model) => model.id === VIDEO);
    expect(video?.media).toEqual({
      aspectRatio: '16:9',
      seconds: 2,
      resolution: '720p',
      audio: true,
      priceUsd: mediaPriceUsd(settingsOf(VIDEO)),
    });
    expect(models.find((model) => model.id === ZDR_IMAGE)?.media?.seconds).toBeNull();
    expect(models.some((model) => model.kind === 'text')).toBe(true);
  });

  it('locks video for credit on the free trial and opens images', async () => {
    const testApp = createTestApp(undefined, { accessMode: 'trial' });
    const response = await testApp.app.request('/api/models?kinds=image,video');
    const { models } = (await response.json()) as ModelsResponse;
    expect(models.find((model) => model.id === VIDEO)?.lockReason).toBe('credit');
    expect(models.find((model) => model.id === ZDR_IMAGE)?.lockReason).toBeNull();
    expect(models.some((model) => model.kind === 'text')).toBe(false);
  });
});

describe('POST /api/images', () => {
  it('asks OpenRouter for an image under zero data retention at the level ZDR', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(imageAnswer({ cost: 0.06 })));
    const testApp = createTestApp(fetchMock);
    const response = await post(testApp, MEDIA.imagesPath, { modelId: ZDR_IMAGE, prompt: 'A fox' });
    expect(response.status).toBe(200);
    expect(upstreamCall(fetchMock).url).toBe(
      `${OPENROUTER.baseUrl}${OPENROUTER.chatCompletionsPath}`,
    );
    expect(bodyOf(fetchMock) as ImageChatBody).toEqual({
      model: 'google/gemini-3.1-flash-image',
      messages: [{ role: 'user', content: 'A fox' }],
      modalities: ['image', 'text'],
      image_config: { aspect_ratio: '16:9' },
      stream: false,
      provider: { zdr: true, data_collection: 'deny' },
    });
  });

  it('asks the Images API at the level Open, with no data policy', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        json({
          data: [{ b64_json: 'iVBORw0KGgo=', media_type: 'image/png' }],
          usage: { prompt_tokens: 0, completion_tokens: 4175, cost: 0.1 },
        }),
      ),
    );
    const testApp = createTestApp(fetchMock);
    const response = await post(testApp, MEDIA.imagesPath, {
      modelId: OPEN_IMAGE,
      prompt: 'A fox',
    });
    expect(upstreamCall(fetchMock).url).toBe(`${OPENROUTER.baseUrl}${OPENROUTER.imagesPath}`);
    expect(bodyOf(fetchMock) as ImagesApiBody).toEqual({
      model: 'openai/gpt-image-2',
      prompt: 'A fox',
      aspect_ratio: '16:9',
      n: 1,
    });
    expect(((await response.json()) as ImageResponse).images).toEqual([{ dataUrl: PNG }]);
  });

  it('answers with the images as data URLs and the text, and drops any other link', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        imageAnswer({ images: [PNG, 'https://example.com/a.png'], text: 'Here it is.' }),
      ),
    );
    const response = await post(createTestApp(fetchMock), MEDIA.imagesPath, {
      modelId: ZDR_IMAGE,
      prompt: 'A fox',
    });
    expect((await response.json()) as ImageResponse).toEqual({
      images: [{ dataUrl: PNG }],
      text: 'Here it is.',
    });
  });

  it('charges a balance the reported cost plus 25%', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(imageAnswer({ cost: 0.067 })));
    const testApp = createTestApp(fetchMock, { accessMode: 'trial' });
    const secret = await fundedBalance(testApp.ledger, 1);
    await post(
      testApp,
      MEDIA.imagesPath,
      { modelId: ZDR_IMAGE, prompt: 'A fox' },
      balanceHeader(secret),
    );
    expect(await balanceOf(testApp, secret)).toBe(usdToMicros(1) - paid(0.067));
  });

  it('charges the estimate when no cost came with an image, and nothing for text alone', async () => {
    const answers = [imageAnswer(), imageAnswer({ images: [], text: 'I cannot draw that.' })];
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(answers.shift() ?? json({}, 500)));
    const testApp = createTestApp(fetchMock, { accessMode: 'trial' });
    const secret = await fundedBalance(testApp.ledger, 1);
    const request = { modelId: ZDR_IMAGE, prompt: 'A fox' };
    await post(testApp, MEDIA.imagesPath, request, balanceHeader(secret));
    const afterImage = usdToMicros(1) - paid(settingsOf(ZDR_IMAGE).costUsd);
    expect(await balanceOf(testApp, secret)).toBe(afterImage);
    const response = await post(testApp, MEDIA.imagesPath, request, balanceHeader(secret));
    expect(((await response.json()) as ImageResponse).images).toEqual([]);
    expect(await balanceOf(testApp, secret)).toBe(afterImage);
  });

  it('refuses a balance that cannot cover the image, before calling OpenRouter', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const testApp = createTestApp(fetchMock, { accessMode: 'trial' });
    const secret = await fundedBalance(testApp.ledger, 0.01);
    const response = await post(
      testApp,
      MEDIA.imagesPath,
      { modelId: ZDR_IMAGE, prompt: 'A fox' },
      balanceHeader(secret),
    );
    expect(response.status).toBe(402);
    expect((await errorOf(response)).code).toBe('balance_low');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('counts an image as one chat of the open lane on the free trial', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(imageAnswer({ cost: 0.06 })));
    const testApp = createTestApp(fetchMock, { accessMode: 'trial' });
    await post(testApp, MEDIA.imagesPath, { modelId: ZDR_IMAGE, prompt: 'A fox' });
    const access = (await (await testApp.app.request('/api/access')).json()) as AccessResponse;
    if (access.mode !== 'trial') throw new Error('The app is not on the trial.');
    expect(access.lanes.open.chatsLeft).toBe(TRIAL.chatsPerDay.open - 1);
  });

  it('gives the chat back and answers 424 when the provider fails', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(json({ error: {} }, 503)));
    const testApp = createTestApp(fetchMock, { accessMode: 'trial' });
    const response = await post(testApp, MEDIA.imagesPath, { modelId: ZDR_IMAGE, prompt: 'A fox' });
    expect(response.status).toBe(MEDIA.upstreamFailureStatus);
    expect(await errorOf(response)).toEqual({
      code: 'upstream_error',
      message: MESSAGES.upstreamNoProvider,
    });
    const access = (await (await testApp.app.request('/api/access')).json()) as AccessResponse;
    if (access.mode !== 'trial') throw new Error('The app is not on the trial.');
    expect(access.lanes.open.chatsLeft).toBe(TRIAL.chatsPerDay.open);
  });

  it('refuses a model of text or of video, and an empty prompt', async () => {
    const testApp = createTestApp();
    const text = await post(testApp, MEDIA.imagesPath, {
      modelId: 'open/glm-5.3-flash',
      prompt: 'x',
    });
    expect((await errorOf(text)).message).toBe(MESSAGES.notImageModel);
    const video = await post(testApp, MEDIA.imagesPath, { modelId: VIDEO, prompt: 'x' });
    expect((await errorOf(video)).message).toBe(MESSAGES.notImageModel);
    const empty = await post(testApp, MEDIA.imagesPath, { modelId: ZDR_IMAGE, prompt: '  ' });
    expect((await errorOf(empty)).message).toBe(`prompt: ${MESSAGES.promptEmpty}`);
  });

  it('keeps an image model out of the chat route', async () => {
    const response = await post(createTestApp(), '/chat', {
      modelId: ZDR_IMAGE,
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect((await errorOf(response)).message).toBe(MESSAGES.notChatModel);
  });
});

/** A fake OpenRouter for one video job: the job states come one per check, then stay. */
function videoUpstream(states: readonly unknown[]): FetchMock {
  const queue = [...states];
  return vi.fn<typeof fetch>((input, init) => {
    const url = urlOf(input);
    if (init?.method === 'POST') {
      return Promise.resolve(json({ id: JOB_ID, polling_url: url, status: 'pending' }, 202));
    }
    if (url.endsWith(OPENROUTER.videoContentPath(JOB_ID))) {
      return Promise.resolve(
        new Response(VIDEO_BYTES, { headers: { 'Content-Type': 'video/mp4' } }),
      );
    }
    const state = queue.length > 1 ? queue.shift() : queue[0];
    return Promise.resolve(json(state));
  });
}

async function startJob(testApp: TestApp, headers = {}): Promise<Response> {
  return post(testApp, MEDIA.videosPath, { modelId: VIDEO, prompt: 'Waves at dusk' }, headers);
}

async function ticketOf(response: Response): Promise<Record<string, string>> {
  const { ticket } = (await response.json()) as VideoJobResponse;
  return { [MEDIA.ticketHeader]: ticket };
}

async function statusOf(testApp: TestApp, ticket: Record<string, string>) {
  return (await (await get(testApp, MEDIA.videoStatusPath, ticket)).json()) as VideoStatusResponse;
}

describe('POST /api/videos', () => {
  it('refuses the free trial, before calling OpenRouter', async () => {
    const fetchMock = videoUpstream([{ status: 'pending' }]);
    const response = await startJob(createTestApp(fetchMock, { accessMode: 'trial' }));
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toEqual({
      code: 'model_unavailable',
      message: MESSAGES.videoCreditOnly,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the settings of the model, with no provider preferences', async () => {
    const fetchMock = videoUpstream([{ status: 'pending' }]);
    const response = await startJob(createTestApp(fetchMock));
    expect(response.status).toBe(202);
    expect(upstreamCall(fetchMock).url).toBe(`${OPENROUTER.baseUrl}${OPENROUTER.videosPath}`);
    expect(bodyOf(fetchMock) as VideoUpstreamBody).toEqual({
      model: 'alibaba/wan-3.0',
      prompt: 'Waves at dusk',
      duration: 2,
      resolution: '720p',
      aspect_ratio: '16:9',
      generate_audio: true,
    });
  });

  it('takes the price, about, from the balance once the job starts', async () => {
    const testApp = createTestApp(videoUpstream([{ status: 'pending' }]), { accessMode: 'trial' });
    const secret = await fundedBalance(testApp.ledger, 1);
    const response = await startJob(testApp, balanceHeader(secret));
    expect(response.status).toBe(202);
    expect(await balanceOf(testApp, secret)).toBe(
      usdToMicros(1) - usdToMicros(mediaPriceUsd(settingsOf(VIDEO))),
    );
  });

  it('gives a ticket that does not show the job, the model, or the balance', async () => {
    const testApp = createTestApp(videoUpstream([{ status: 'pending' }]), { accessMode: 'trial' });
    const secret = await fundedBalance(testApp.ledger, 1);
    const { ticket } = (await (
      await startJob(testApp, balanceHeader(secret))
    ).json()) as VideoJobResponse;
    const decoded = Buffer.from(ticket, 'base64url').toString('latin1');
    expect(decoded).not.toContain(JOB_ID);
    expect(decoded).not.toContain(VIDEO);
    expect(decoded).not.toContain(await balanceHash(secret));
  });

  it('refuses a balance that cannot pay ahead, before calling OpenRouter', async () => {
    const fetchMock = videoUpstream([{ status: 'pending' }]);
    const testApp = createTestApp(fetchMock, { accessMode: 'trial' });
    const secret = await fundedBalance(testApp.ledger, 0.1);
    const response = await startJob(testApp, balanceHeader(secret));
    expect((await errorOf(response)).code).toBe('balance_low');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await balanceOf(testApp, secret)).toBe(usdToMicros(0.1));
  });

  it('takes nothing when OpenRouter refuses the job', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(json({ error: {} }, 400)));
    const testApp = createTestApp(fetchMock, { accessMode: 'trial' });
    const secret = await fundedBalance(testApp.ledger, 1);
    const response = await startJob(testApp, balanceHeader(secret));
    expect(response.status).toBe(MEDIA.upstreamFailureStatus);
    expect(await balanceOf(testApp, secret)).toBe(usdToMicros(1));
  });
});

describe('GET /api/videos/status', () => {
  it('reports a pending job and moves no credit', async () => {
    const testApp = createTestApp(videoUpstream([{ status: 'in_progress' }]), {
      accessMode: 'trial',
    });
    const secret = await fundedBalance(testApp.ledger, 1);
    const ticket = await ticketOf(await startJob(testApp, balanceHeader(secret)));
    const before = await balanceOf(testApp, secret);
    expect(await statusOf(testApp, ticket)).toEqual({ status: 'pending', message: null });
    expect(await balanceOf(testApp, secret)).toBe(before);
  });

  it('settles a finished job at its cost plus 25%, once', async () => {
    const testApp = createTestApp(
      videoUpstream([{ status: 'pending' }, { status: 'completed', usage: { cost: 0.18 } }]),
      { accessMode: 'trial' },
    );
    const secret = await fundedBalance(testApp.ledger, 1);
    const ticket = await ticketOf(await startJob(testApp, balanceHeader(secret)));
    expect((await statusOf(testApp, ticket)).status).toBe('pending');
    expect(await statusOf(testApp, ticket)).toEqual({ status: 'completed', message: null });
    expect(await balanceOf(testApp, secret)).toBe(usdToMicros(1) - paid(0.18));
    await statusOf(testApp, ticket);
    expect(await balanceOf(testApp, secret)).toBe(usdToMicros(1) - paid(0.18));
  });

  it('gives back all that a failed job paid, once, with the reason of the provider', async () => {
    const testApp = createTestApp(
      videoUpstream([{ status: 'failed', error: 'Content policy violation' }]),
      { accessMode: 'trial' },
    );
    const secret = await fundedBalance(testApp.ledger, 1);
    const ticket = await ticketOf(await startJob(testApp, balanceHeader(secret)));
    expect(await statusOf(testApp, ticket)).toEqual({
      status: 'failed',
      message: 'Content policy violation',
    });
    await statusOf(testApp, ticket);
    expect(await balanceOf(testApp, secret)).toBe(usdToMicros(1));
  });

  it('refuses a changed ticket and a request without one', async () => {
    const testApp = createTestApp(videoUpstream([{ status: 'completed' }]));
    const ticket = await ticketOf(await startJob(testApp));
    const sealed = ticket[MEDIA.ticketHeader] ?? '';
    const flipped = `${sealed.slice(0, -2)}${sealed.endsWith('AA') ? 'AB' : 'AA'}`;
    const changed = await get(testApp, MEDIA.videoStatusPath, { [MEDIA.ticketHeader]: flipped });
    expect(changed.status).toBe(400);
    expect((await errorOf(changed)).message).toBe(MESSAGES.ticketInvalid);
    const missing = await get(testApp, MEDIA.videoStatusPath, {});
    expect((await errorOf(missing)).message).toBe(MESSAGES.ticketMissing);
  });

  it('keeps the ticket out of the log', async () => {
    const testApp = createTestApp(videoUpstream([{ status: 'pending' }]));
    const ticket = await ticketOf(await startJob(testApp));
    await statusOf(testApp, ticket);
    const sealed = ticket[MEDIA.ticketHeader] ?? '';
    expect(testApp.logs.some((line) => line.includes(sealed))).toBe(false);
  });
});

describe('GET /api/videos/content', () => {
  it('passes the video on with its type', async () => {
    const testApp = createTestApp(videoUpstream([{ status: 'completed' }]));
    const ticket = await ticketOf(await startJob(testApp));
    const response = await get(testApp, MEDIA.videoContentPath, ticket);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(await response.text()).toBe(VIDEO_BYTES);
  });

  it('answers 410 for a video that OpenRouter no longer holds', async () => {
    const fetchMock = vi.fn<typeof fetch>((input, init) =>
      Promise.resolve(
        init?.method === 'POST'
          ? json({ id: JOB_ID, polling_url: urlOf(input), status: 'pending' }, 202)
          : json({ error: 'Not found' }, 404),
      ),
    );
    const testApp = createTestApp(fetchMock);
    const ticket = await ticketOf(await startJob(testApp));
    const response = await get(testApp, MEDIA.videoContentPath, ticket);
    expect(response.status).toBe(MEDIA.goneStatus);
    expect((await errorOf(response)).message).toBe(MESSAGES.videoGone);
  });
});
