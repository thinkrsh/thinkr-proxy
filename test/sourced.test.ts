import { describe, expect, it, vi } from 'vitest';

import { MEDIA } from '../src/config/media.js';
import { MESSAGES } from '../src/config/messages.js';
import { OPENROUTER } from '../src/config/openrouter.js';
import { SOURCED } from '../src/config/sourcedTools.js';
import type {
  ErrorBody,
  ModelsResponse,
  SourceResponse,
  VideoJobResponse,
  VideoStatusResponse,
} from '../src/contract.js';
import { balanceHash, mediaPriceUsd, usdToMicros } from '../src/credit/balance.js';
import { measureVideo, measureWav } from '../src/media/measure.js';
import type { SourcedUpstreamBody } from '../src/media/sourced.js';
import {
  TEST_PUBLIC_ORIGIN,
  balanceHeader,
  createTestApp,
  fundedBalance,
  upstreamCall,
  type FetchMock,
  type TestApp,
} from './helpers.js';

const EDIT = 'open/flux-video-edit';
const ALEPH = 'open/aleph-2';
const UPSCALE = 'open/flux-video-upscale';
const TALK = 'open/avatar-iv';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JOB_ID = 'job-1';

/** One box of an MP4: its size, its type, and its content. */
function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const size = 8 + parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer).setUint32(0, size);
  bytes.set(new TextEncoder().encode(type), 4);
  let at = 8;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return bytes;
}

/** An MP4 that holds only what the proxy reads: the length of the movie and the frame of a track. */
function mp4(seconds: number, width = 1280, height = 720): Uint8Array {
  const header = new Uint8Array(100);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(12, 1000);
  headerView.setUint32(16, Math.round(seconds * 1000));
  const track = new Uint8Array(84);
  const trackView = new DataView(track.buffer);
  trackView.setUint32(76, width * 65536);
  trackView.setUint32(80, height * 65536);
  return new Uint8Array([
    ...box('ftyp', new TextEncoder().encode('isom')),
    ...box('moov', box('mvhd', header), box('trak', box('tkhd', track))),
  ]);
}

/** A silent WAV of 16-bit mono at 8 kHz. */
function wav(seconds: number): Uint8Array {
  const rate = 8000;
  const dataBytes = Math.round(seconds * rate * 2);
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string): void => {
    bytes.set(new TextEncoder().encode(value), at);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataBytes, true);
  return bytes;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** OpenRouter that takes each job and answers each check with the next state. */
function upstream(states: readonly unknown[] = [{ status: 'pending' }]): FetchMock {
  const queue = [...states];
  return vi.fn<typeof fetch>((_input, init) => {
    if (init?.method === 'POST') {
      return Promise.resolve(json({ id: JOB_ID, status: 'pending' }, 202));
    }
    const state = queue.length > 1 ? queue.shift() : queue[0];
    return Promise.resolve(json(state));
  });
}

async function holdSource(
  testApp: TestApp,
  bytes: Uint8Array,
  type: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    testApp.app.request(`/api${SOURCED.sourcesPath}`, {
      method: 'POST',
      headers: { 'Content-Type': type, ...headers },
      body: bytes,
    }),
  );
}

async function sourceName(
  testApp: TestApp,
  bytes: Uint8Array,
  type = 'video/mp4',
  headers: Record<string, string> = {},
): Promise<string> {
  const response = await holdSource(testApp, bytes, type, headers);
  expect(response.status).toBe(201);
  return ((await response.json()) as SourceResponse).source;
}

function startSourced(
  testApp: TestApp,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    testApp.app.request(`/api${SOURCED.sourcedPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function fetchSource(testApp: TestApp, name: string): Promise<Response> {
  return Promise.resolve(testApp.app.request(`/api${SOURCED.sourcesPath}/${name}`));
}

function linkOf(name: string): string {
  return `${TEST_PUBLIC_ORIGIN}/api${SOURCED.sourcesPath}/${name}`;
}

function bodyOf(fetchMock: FetchMock): SourcedUpstreamBody {
  const { init } = upstreamCall(fetchMock);
  if (typeof init.body !== 'string') throw new Error('The upstream body is not JSON.');
  return JSON.parse(init.body) as SourcedUpstreamBody;
}

async function errorOf(response: Response): Promise<ErrorBody['error']> {
  return ((await response.json()) as ErrorBody).error;
}

async function balanceOf(testApp: TestApp, secret: string): Promise<number | null> {
  return testApp.ledger.balance(await balanceHash(secret));
}

describe('measure', () => {
  it('reads the length and the frame of an MP4, and the length of a WAV', () => {
    expect(measureVideo(mp4(4.2, 640, 360))).toEqual({ seconds: 4.2, width: 640, height: 360 });
    expect(measureWav(wav(2.5))).toEqual({ seconds: 2.5, width: null, height: null });
  });

  it('reads nothing from a file of another kind', () => {
    expect(measureVideo(new TextEncoder().encode('not a video at all'))).toBeNull();
    expect(measureVideo(wav(1))).toBeNull();
    expect(measureWav(mp4(1))).toBeNull();
  });
});

describe('POST /api/videos/sources', () => {
  it('holds an MP4 and reports its length and its frame', async () => {
    const response = await holdSource(createTestApp(), mp4(4), 'video/mp4');
    expect(response.status).toBe(201);
    const body = (await response.json()) as SourceResponse;
    expect(body).toMatchObject({ seconds: 4, width: 1280, height: 720 });
    expect(body.source).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('gives the provider the source at its link, with its type', async () => {
    const testApp = createTestApp();
    const bytes = wav(1);
    const name = await sourceName(testApp, bytes, 'audio/wav');
    const response = await fetchSource(testApp, name);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('audio/wav');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it('refuses the free trial without a balance', async () => {
    const response = await holdSource(
      createTestApp(undefined, { accessMode: 'trial' }),
      mp4(4),
      'video/mp4',
    );
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toEqual({
      code: 'model_unavailable',
      message: MESSAGES.sourcedCreditOnly,
    });
  });

  it('holds a source for a balance on the free trial, and takes nothing for it', async () => {
    const testApp = createTestApp(undefined, { accessMode: 'trial' });
    const secret = await fundedBalance(testApp.ledger, 1);
    await sourceName(testApp, mp4(4), 'video/mp4', balanceHeader(secret));
    expect(await balanceOf(testApp, secret)).toBe(usdToMicros(1));
  });

  it('refuses a type other than MP4, MOV, and WAV, and a file it cannot read', async () => {
    const testApp = createTestApp();
    const png = await holdSource(testApp, mp4(4), 'image/png');
    expect(await errorOf(png)).toEqual({ code: 'invalid_request', message: MESSAGES.sourceType });
    const junk = await holdSource(testApp, new TextEncoder().encode('junk'), 'video/mp4');
    expect((await errorOf(junk)).message).toBe(MESSAGES.sourceUnreadable);
  });

  it('keeps the name of a source out of the log', async () => {
    const testApp = createTestApp();
    const name = await sourceName(testApp, mp4(4));
    await fetchSource(testApp, name);
    expect(testApp.logs.some((line) => line.includes(name))).toBe(false);
  });

  it('lets a source go once its time is up', async () => {
    let now = 1_000_000;
    const testApp = createTestApp(undefined, { now: () => now });
    const name = await sourceName(testApp, mp4(4));
    now += SOURCED.holdMs - 1;
    expect((await fetchSource(testApp, name)).status).toBe(200);
    now += 1;
    const gone = await fetchSource(testApp, name);
    expect(gone.status).toBe(MEDIA.goneStatus);
    expect((await errorOf(gone)).message).toBe(MESSAGES.sourceGone);
  });
});

describe('POST /api/videos/sourced', () => {
  it('sends an edit with its source as a link to the proxy, at the level Open', async () => {
    const fetchMock = upstream();
    const testApp = createTestApp(fetchMock);
    const name = await sourceName(testApp, mp4(4));
    const response = await startSourced(testApp, {
      modelId: EDIT,
      prompt: 'Make it snow',
      video: name,
    });
    expect(response.status).toBe(202);
    expect(upstreamCall(fetchMock).url).toBe(`${OPENROUTER.baseUrl}${OPENROUTER.videosPath}`);
    expect(bodyOf(fetchMock)).toEqual({
      model: 'black-forest-labs/flux-video-edit',
      prompt: 'Make it snow',
      input_references: [{ type: 'video_url', video_url: { url: linkOf(name) } }],
    });
  });

  it('takes ahead the price of the length of its source, and the least of the provider', async () => {
    const testApp = createTestApp(upstream(), { accessMode: 'trial' });
    const secret = await fundedBalance(testApp.ledger, 5);
    const headers = balanceHeader(secret);
    const four = await sourceName(testApp, mp4(4), 'video/mp4', headers);
    await startSourced(testApp, { modelId: EDIT, prompt: 'Make it snow', video: four }, headers);
    const edit = usdToMicros(mediaPriceUsd({ costUsd: 0.03 * 4 }));
    expect(await balanceOf(testApp, secret)).toBe(usdToMicros(5) - edit);
    // Two seconds of Aleph 2 cost $0.56, its least for one video.
    const two = await sourceName(testApp, mp4(2), 'video/mp4', headers);
    await startSourced(testApp, { modelId: ALEPH, prompt: 'Make it snow', video: two }, headers);
    const aleph = usdToMicros(mediaPriceUsd({ costUsd: 0.56 }));
    expect(await balanceOf(testApp, secret)).toBe(usdToMicros(5) - edit - aleph);
  });

  it('refuses an edit with no prompt, and a source longer than the model takes', async () => {
    const fetchMock = upstream();
    const testApp = createTestApp(fetchMock);
    const short = await sourceName(testApp, mp4(4));
    const empty = await startSourced(testApp, { modelId: EDIT, prompt: '  ', video: short });
    expect((await errorOf(empty)).message).toBe(MESSAGES.sourcedPromptEmpty);
    const long = await sourceName(testApp, mp4(16));
    const tooLong = await startSourced(testApp, { modelId: EDIT, prompt: 'Snow', video: long });
    expect((await errorOf(tooLong)).message).toBe(MESSAGES.sourceTooLong(15));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('upscales by the default factor in the precise mode, with no prompt', async () => {
    const fetchMock = upstream();
    const testApp = createTestApp(fetchMock, { accessMode: 'trial' });
    const secret = await fundedBalance(testApp.ledger, 5);
    const headers = balanceHeader(secret);
    const name = await sourceName(testApp, mp4(5, 1280, 720), 'video/mp4', headers);
    expect(
      (await startSourced(testApp, { modelId: UPSCALE, prompt: '', video: name }, headers)).status,
    ).toBe(202);
    expect(bodyOf(fetchMock)).toEqual({
      model: 'black-forest-labs/flux-video-upscale',
      input_references: [{ type: 'video_url', video_url: { url: linkOf(name) } }],
      upscale_factor: 2,
      creativity: 0,
    });
    // 2560x1440 is 3.6864 megapixels, for 5 seconds at $0.035.
    const price = usdToMicros(mediaPriceUsd({ costUsd: 3.6864 * 5 * 0.035 }));
    expect(await balanceOf(testApp, secret)).toBe(usdToMicros(5) - price);
  });

  it('upscales by a factor and a mode that the request picks, and refuses others', async () => {
    const fetchMock = upstream();
    const testApp = createTestApp(fetchMock);
    const name = await sourceName(testApp, mp4(5, 640, 360));
    const picked = await startSourced(testApp, {
      modelId: UPSCALE,
      prompt: 'Sharper leaves',
      video: name,
      factor: 1.5,
      creative: true,
    });
    expect(picked.status).toBe(202);
    expect(bodyOf(fetchMock)).toMatchObject({
      prompt: 'Sharper leaves',
      upscale_factor: 1.5,
      creativity: 1,
    });
    const factor = await startSourced(testApp, {
      modelId: UPSCALE,
      prompt: '',
      video: name,
      factor: 2.5,
    });
    expect((await errorOf(factor)).message).toBe(MESSAGES.factorUnavailable);
    const big = await sourceName(testApp, mp4(5, 3840, 2160));
    const tooBig = await startSourced(testApp, { modelId: UPSCALE, prompt: '', video: big });
    expect((await errorOf(tooBig)).message).toBe(MESSAGES.sourceTooBig);
    const creativeEdit = await startSourced(testApp, {
      modelId: EDIT,
      prompt: 'Snow',
      video: name,
      creative: true,
    });
    expect((await errorOf(creativeEdit)).message).toBe(MESSAGES.creativeUnavailable);
  });

  it('makes a photo talk with a voice, at the default shape and resolution', async () => {
    const fetchMock = upstream();
    const testApp = createTestApp(fetchMock);
    const voice = await sourceName(testApp, wav(3), 'audio/wav');
    const response = await startSourced(testApp, { modelId: TALK, prompt: '', image: PNG, voice });
    expect(response.status).toBe(202);
    expect(bodyOf(fetchMock)).toEqual({
      model: 'heygen/avatar-iv',
      prompt: SOURCED.talkPrompt,
      input_references: [
        { type: 'image_url', image_url: { url: PNG } },
        { type: 'audio_url', audio_url: { url: linkOf(voice) } },
      ],
      aspect_ratio: '16:9',
      resolution: '1080p',
    });
  });

  it('refuses a talking photo with no photo, or a video in place of the voice', async () => {
    const fetchMock = upstream();
    const testApp = createTestApp(fetchMock);
    const voice = await sourceName(testApp, wav(3), 'audio/wav');
    const noPhoto = await startSourced(testApp, { modelId: TALK, prompt: '', voice });
    expect((await errorOf(noPhoto)).message).toBe(MESSAGES.sourceVoiceNeeded);
    const video = await sourceName(testApp, mp4(3));
    const wrong = await startSourced(testApp, {
      modelId: TALK,
      prompt: '',
      image: PNG,
      voice: video,
    });
    expect((await errorOf(wrong)).message).toBe(MESSAGES.sourceWrongKind);
    const edit = await startSourced(testApp, { modelId: EDIT, prompt: 'Snow', video: voice });
    expect((await errorOf(edit)).message).toBe(MESSAGES.sourceWrongKind);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a source that the proxy does not hold', async () => {
    const response = await startSourced(createTestApp(upstream()), {
      modelId: EDIT,
      prompt: 'Snow',
      video: 'A'.repeat(43),
    });
    expect(await errorOf(response)).toEqual({
      code: 'invalid_request',
      message: MESSAGES.sourceGone,
    });
  });

  it('starts nothing on a proxy with no public address', async () => {
    const fetchMock = upstream();
    const testApp = createTestApp(fetchMock, { publicOrigin: null });
    const name = await sourceName(testApp, mp4(4));
    const response = await startSourced(testApp, { modelId: EDIT, prompt: 'Snow', video: name });
    expect(await errorOf(response)).toEqual({
      code: 'model_unavailable',
      message: MESSAGES.sourcedNoLink,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps sourced models and the models of a video apart', async () => {
    const testApp = createTestApp(upstream());
    const name = await sourceName(testApp, mp4(4));
    const create = await startSourced(testApp, {
      modelId: 'open/wan-3.0',
      prompt: 'Snow',
      video: name,
    });
    expect((await errorOf(create)).message).toBe(MESSAGES.notSourcedModel);
    const plain = await Promise.resolve(
      testApp.app.request(`/api${MEDIA.videosPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: EDIT, prompt: 'Snow' }),
      }),
    );
    expect((await errorOf(plain)).message).toBe(MESSAGES.notVideoModel);
  });

  it('lets the sources go once the job ends, and settles it as a video', async () => {
    const testApp = createTestApp(
      upstream([{ status: 'pending' }, { status: 'completed', usage: { cost: 0.12 } }]),
      { accessMode: 'trial' },
    );
    const secret = await fundedBalance(testApp.ledger, 1);
    const headers = balanceHeader(secret);
    const name = await sourceName(testApp, mp4(4), 'video/mp4', headers);
    const started = await startSourced(
      testApp,
      { modelId: EDIT, prompt: 'Snow', video: name },
      headers,
    );
    const { ticket } = (await started.json()) as VideoJobResponse;
    const status = async (): Promise<VideoStatusResponse> =>
      (await (
        await testApp.app.request(`/api${MEDIA.videoStatusPath}`, {
          headers: { [MEDIA.ticketHeader]: ticket },
        })
      ).json()) as VideoStatusResponse;
    expect((await status()).status).toBe('pending');
    expect((await fetchSource(testApp, name)).status).toBe(200);
    expect((await status()).status).toBe('completed');
    expect((await fetchSource(testApp, name)).status).toBe(MEDIA.goneStatus);
    expect(await balanceOf(testApp, secret)).toBe(usdToMicros(1) - usdToMicros(0.12 * 1.25));
  });
});

describe('GET /api/models, sourced videos', () => {
  it('lists them, with their tools and prices, only to an app that asks for them', async () => {
    const testApp = createTestApp();
    const asked = (await (
      await testApp.app.request('/api/models?kinds=sourcedVideo')
    ).json()) as ModelsResponse;
    expect(asked.models.map((model) => model.id)).toEqual([EDIT, ALEPH, UPSCALE, TALK]);
    const upscale = asked.models.find((model) => model.id === UPSCALE);
    expect(upscale?.media).toBeNull();
    expect(upscale?.sourced).toMatchObject({
      mode: 'upscale',
      price: { per: 'megapixelSecond', usd: mediaPriceUsd({ costUsd: 0.035 }) },
      factors: [2, 1.5, 3],
      promptRequired: false,
    });
    const chat = (await (
      await testApp.app.request('/api/models?kinds=text,image,video')
    ).json()) as ModelsResponse;
    expect(chat.models.some((model) => model.sourced !== null)).toBe(false);
  });
});
