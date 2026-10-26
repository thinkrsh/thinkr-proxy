import { describe, expect, it, vi } from 'vitest';

import { audioToolsProblems, findModel } from '../src/catalog.js';
import { AUDIO, AUDIO_TOOLS } from '../src/config/audioTools.js';
import { CREDIT } from '../src/config/credit.js';
import { MEDIA } from '../src/config/media.js';
import { MESSAGES } from '../src/config/messages.js';
import { MODEL_CATALOG, type AudioSettings } from '../src/config/models.js';
import { OPENROUTER } from '../src/config/openrouter.js';
import { TRIAL } from '../src/config/trial.js';
import type { AccessResponse, AudioResponse, ErrorBody, ModelsResponse } from '../src/contract.js';
import { balanceHash, usdToMicros } from '../src/credit/balance.js';
import { lyricsOf, type MusicBody, type SpeechBody } from '../src/media/audio.js';
import { audioTypeOf, mp3Seconds, pcmFormatOf, wavOf } from '../src/media/audioFile.js';
import { fromBase64, toBase64 } from '../src/lib/bytes.js';
import {
  balanceHeader,
  createTestApp,
  fundedBalance,
  upstreamCall,
  type FetchMock,
  type TestApp,
} from './helpers.js';

const VOICE = 'open/eleven-v4';
const PCM_VOICE = 'open/gemini-3.8-flash-tts';
const OWN_VOICE = 'open/fish-audio-s2.1-pro';
const OPEN_VOICE = 'open/minimax-speech-2.8-hd';
const SOUND = 'open/seed-audio-1.0';
const MUSIC = 'open/lyria-3-pro';
const IMAGE = 'open/nano-banana-2';

/** MPEG-1 layer III at 128 kbps and 44.1 kHz, no padding: 417 bytes and 1,152 samples a frame. */
const FRAME_HEADER = [0xff, 0xfb, 0x90, 0x00];
const FRAME_BYTES = 417;
const FRAME_SECONDS = 1_152 / 44_100;

/** An MP3 of `frames` silent frames, behind an ID3v2 tag of `tagBytes`. */
function mp3Of(frames: number, tagBytes = 0): Uint8Array {
  const tag = tagBytes === 0 ? [] : [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, tagBytes];
  const file = new Uint8Array(tag.length + tagBytes + frames * FRAME_BYTES);
  file.set(tag, 0);
  for (let index = 0; index < frames; index += 1) {
    file.set(FRAME_HEADER, tag.length + tagBytes + index * FRAME_BYTES);
  }
  return file;
}

function audioBytes(bytes: Uint8Array, contentType: string): Response {
  return new Response(bytes, { status: 200, headers: { 'Content-Type': contentType } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The stream of a song as Lyria sends it: the text, then the whole audio in one chunk. */
function musicStream(options: { audio?: string; text?: string; cost?: number } = {}): Response {
  const { audio, text = '<instrumental>', cost = 0.08 } = options;
  const events = [
    { choices: [{ delta: { role: 'assistant', content: text } }] },
    ...(audio === undefined ? [] : [{ choices: [{ delta: { audio: { data: audio } } }] }]),
    { choices: [{ delta: { content: '' }, finish_reason: 'stop' }], usage: { cost } },
  ];
  const body = [
    ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
    ': OPENROUTER PROCESSING\n\n',
    'data: [DONE]\n\n',
  ].join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function post(testApp: TestApp, body: unknown, headers = {}): Promise<Response> {
  return Promise.resolve(
    testApp.app.request(`/api${MEDIA.audioPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function bodyOf(fetchMock: FetchMock): unknown {
  const { init } = upstreamCall(fetchMock);
  if (typeof init.body !== 'string') throw new Error('The upstream body is not JSON.');
  return JSON.parse(init.body) as unknown;
}

async function errorOf(response: Response): Promise<ErrorBody['error']> {
  return ((await response.json()) as ErrorBody).error;
}

async function balanceOf(testApp: TestApp, secret: string): Promise<number | null> {
  return testApp.ledger.balance(await balanceHash(secret));
}

async function openChatsLeft(testApp: TestApp): Promise<number> {
  const access = (await (await testApp.app.request('/api/access')).json()) as AccessResponse;
  if (access.mode !== 'trial') throw new Error('The app is not on the trial.');
  return access.lanes.open.chatsLeft;
}

function settingsOf(modelId: string): AudioSettings {
  const media = findModel(modelId)?.media;
  if (media?.kind !== 'audio') throw new Error(`${modelId} makes no audio.`);
  return media;
}

/** What a balance pays for audio that cost `costUsd` at the provider: plus 25% (decision 52). */
function paid(costUsd: number): number {
  return usdToMicros(costUsd * CREDIT.markup);
}

describe('GET /api/models, audio', () => {
  it('lists audio only to an app that asks for it, with its voices and its price', async () => {
    const testApp = createTestApp();
    const older = (await (
      await testApp.app.request('/api/models?kinds=text,image,video')
    ).json()) as ModelsResponse;
    expect(older.models.some((model) => model.kind === 'audio')).toBe(false);
    const { models } = (await (
      await testApp.app.request('/api/models?kinds=audio')
    ).json()) as ModelsResponse;
    expect(models.every((model) => model.kind === 'audio' && model.media === null)).toBe(true);
    const voice = models.find((model) => model.id === VOICE);
    expect(voice?.audio).toEqual({
      mode: 'voice',
      voices: AUDIO_TOOLS[VOICE]?.voices,
      maxChars: 4_000,
      price: { per: 'character', usd: 0.0001 },
    });
    expect(models.find((model) => model.id === MUSIC)?.audio?.price).toEqual({
      per: 'piece',
      usd: 0.1,
    });
    expect(
      models.filter((model) => model.audio?.mode === 'sound').map((model) => model.id),
    ).toEqual([SOUND]);
  });

  it('opens audio on the free trial, each model under the dearest price of an image', async () => {
    const testApp = createTestApp(undefined, { accessMode: 'trial' });
    const { models } = (await (
      await testApp.app.request('/api/models?kinds=audio')
    ).json()) as ModelsResponse;
    expect(models.length).toBe(16);
    expect(models.every((model) => model.lockReason === null)).toBe(true);
  });
});

describe('POST /api/audio, a voice', () => {
  it('asks the speech API for an MP3 in the default voice, under zero data retention', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(audioBytes(mp3Of(3, 6), 'audio/mpeg')),
    );
    const testApp = createTestApp(fetchMock);
    const response = await post(testApp, { modelId: VOICE, prompt: 'Hello there.' });
    expect(response.status).toBe(200);
    expect(upstreamCall(fetchMock).url).toBe(`${OPENROUTER.baseUrl}${OPENROUTER.speechPath}`);
    expect(bodyOf(fetchMock) as SpeechBody).toEqual({
      model: 'elevenlabs/eleven-v4',
      input: 'Hello there.',
      voice: 'jessica',
      response_format: 'mp3',
      provider: { zdr: true, data_collection: 'deny' },
    });
    const answer = (await response.json()) as AudioResponse;
    expect(answer.text).toBe('');
    expect(answer.audio.dataUrl).toBe(`data:audio/mpeg;base64,${toBase64(mp3Of(3, 6))}`);
  });

  it('reads with the voice picked, and asks a model of the level Open with no ZDR', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(audioBytes(mp3Of(1), 'audio/mpeg')),
    );
    const testApp = createTestApp(fetchMock);
    await post(testApp, { modelId: OPEN_VOICE, prompt: 'Hi.', voice: 'English_CalmWoman' });
    expect(bodyOf(fetchMock)).toMatchObject({
      voice: 'English_CalmWoman',
      provider: { data_collection: 'deny' },
    });
    expect((bodyOf(fetchMock) as SpeechBody).provider).not.toHaveProperty('zdr');
  });

  it('names no voice for a model with a voice of its own, and refuses a voice it lacks', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(audioBytes(mp3Of(1), 'audio/mpeg')),
    );
    const testApp = createTestApp(fetchMock);
    await post(testApp, { modelId: OWN_VOICE, prompt: 'Hi.' });
    expect(bodyOf(fetchMock)).not.toHaveProperty('voice');
    const response = await post(testApp, { modelId: VOICE, prompt: 'Hi.', voice: 'nobody' });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toEqual({
      code: 'invalid_request',
      message: MESSAGES.voiceUnavailable,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('charges a balance each character read, plus 25%', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(audioBytes(mp3Of(1), 'audio/mpeg')),
    );
    const testApp = createTestApp(fetchMock, { accessMode: 'trial' });
    const secret = await fundedBalance(testApp.ledger, 1);
    const text = 'Twelve chars';
    await post(testApp, { modelId: VOICE, prompt: text }, balanceHeader(secret));
    expect(await balanceOf(testApp, secret)).toBe(
      usdToMicros(1) - paid(text.length * settingsOf(VOICE).rate.usd),
    );
  });

  it('wraps raw PCM as WAV and charges its seconds', async () => {
    const pcm = new Uint8Array(48_000 * 3);
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(audioBytes(pcm, 'audio/pcm;rate=24000;channels=1')),
    );
    const testApp = createTestApp(fetchMock, { accessMode: 'trial' });
    const secret = await fundedBalance(testApp.ledger, 1);
    const response = await post(
      testApp,
      { modelId: PCM_VOICE, prompt: 'Hello there.', voice: 'Puck' },
      balanceHeader(secret),
    );
    expect(bodyOf(fetchMock)).toMatchObject({ voice: 'Puck', response_format: 'pcm' });
    const { audio } = (await response.json()) as AudioResponse;
    expect(audio.dataUrl).toBe(
      `data:audio/wav;base64,${toBase64(wavOf(pcm, { rate: 24_000, channels: 1 }))}`,
    );
    expect(await balanceOf(testApp, secret)).toBe(
      usdToMicros(1) - paid(3 * settingsOf(PCM_VOICE).rate.usd),
    );
  });

  it('takes a long text from a balance only on the free trial', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(audioBytes(mp3Of(1), 'audio/mpeg')),
    );
    const testApp = createTestApp(fetchMock, { accessMode: 'trial' });
    const long = 'a'.repeat(AUDIO.trialChars + 1);
    const refused = await post(testApp, { modelId: VOICE, prompt: long });
    expect(refused.status).toBe(403);
    expect(await errorOf(refused)).toEqual({
      code: 'model_unavailable',
      message: MESSAGES.voiceCreditOnly(AUDIO.trialChars),
    });
    const secret = await fundedBalance(testApp.ledger, 1);
    expect(
      (await post(testApp, { modelId: VOICE, prompt: long }, balanceHeader(secret))).status,
    ).toBe(200);
  });

  it('refuses a text past the longest of the model, before calling OpenRouter', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const testApp = createTestApp(fetchMock);
    const response = await post(testApp, { modelId: SOUND, prompt: 'a'.repeat(3_001) });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toEqual({
      code: 'invalid_request',
      message: MESSAGES.audioTooLong(3_000),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/audio, a sound', () => {
  it('charges the seconds of its MP3, from its frames', async () => {
    const frames = 383;
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(audioBytes(mp3Of(frames, 20), 'audio/mpeg')),
    );
    const testApp = createTestApp(fetchMock, { accessMode: 'trial' });
    const secret = await fundedBalance(testApp.ledger, 1);
    await post(testApp, { modelId: SOUND, prompt: 'Rain on a tin roof' }, balanceHeader(secret));
    expect(bodyOf(fetchMock)).toEqual({
      model: 'bytedance-seed/seed-audio-1-0',
      input: 'Rain on a tin roof',
      response_format: 'mp3',
      provider: { zdr: true, data_collection: 'deny' },
    });
    expect(await balanceOf(testApp, secret)).toBe(
      usdToMicros(1) - paid(frames * FRAME_SECONDS * settingsOf(SOUND).rate.usd),
    );
  });

  it('needs a balance that covers its longest sound', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const testApp = createTestApp(fetchMock, { accessMode: 'trial' });
    const secret = await fundedBalance(testApp.ledger, 0.1);
    const response = await post(testApp, { modelId: SOUND, prompt: 'Rain' }, balanceHeader(secret));
    expect(response.status).toBe(402);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/audio, music', () => {
  it('streams a chat completion that asks for audio first, and passes on the song', async () => {
    const song = mp3Of(2, 6);
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        musicStream({ audio: toBase64(song), text: '[[A0]]\n[:] One line\n[[B1]]\n[:] Two' }),
      ),
    );
    const testApp = createTestApp(fetchMock);
    const response = await post(testApp, { modelId: MUSIC, prompt: 'A song about rain' });
    expect(upstreamCall(fetchMock).url).toBe(
      `${OPENROUTER.baseUrl}${OPENROUTER.chatCompletionsPath}`,
    );
    expect(bodyOf(fetchMock) as MusicBody).toEqual({
      model: 'google/lyria-3-pro-preview',
      messages: [{ role: 'user', content: 'A song about rain' }],
      modalities: ['audio', 'text'],
      stream: true,
      provider: { data_collection: 'deny' },
    });
    expect((await response.json()) as AudioResponse).toEqual({
      audio: { dataUrl: `data:audio/mpeg;base64,${toBase64(song)}` },
      text: 'One line\n\nTwo',
    });
  });

  it('joins a song sent in parts', async () => {
    const song = mp3Of(2);
    const events = [song.subarray(0, 500), song.subarray(500)].map(
      (part) =>
        `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: toBase64(part) } } }] })}\n\n`,
    );
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(`${events.join('')}data: [DONE]\n\n`, { status: 200 })),
    );
    const response = await post(createTestApp(fetchMock), { modelId: MUSIC, prompt: 'Rain' });
    const { audio } = (await response.json()) as AudioResponse;
    expect(fromBase64(audio.dataUrl.split(',')[1] ?? '')).toEqual(song);
  });

  it('charges a balance the cost that the stream reports, plus 25%', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(musicStream({ audio: toBase64(mp3Of(1)), cost: 0.04 })),
    );
    const testApp = createTestApp(fetchMock, { accessMode: 'trial' });
    const secret = await fundedBalance(testApp.ledger, 1);
    await post(testApp, { modelId: MUSIC, prompt: 'Rain' }, balanceHeader(secret));
    expect(await balanceOf(testApp, secret)).toBe(usdToMicros(1) - paid(0.04));
  });

  it('counts one chat of the open lane on the free trial, and gives it back with no audio', async () => {
    const answers = [
      musicStream({ audio: toBase64(mp3Of(1)) }),
      ...Array.from({ length: AUDIO.musicAttempts }, () => musicStream({ cost: 0 })),
    ];
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(answers.shift() ?? json({}, 500)));
    const testApp = createTestApp(fetchMock, { accessMode: 'trial' });
    await post(testApp, { modelId: MUSIC, prompt: 'Rain' });
    expect(await openChatsLeft(testApp)).toBe(TRIAL.chatsPerDay.open - 1);
    const empty = await post(testApp, { modelId: MUSIC, prompt: 'Rain' });
    expect(empty.status).toBe(MEDIA.upstreamFailureStatus);
    expect(await errorOf(empty)).toEqual({ code: 'upstream_error', message: MESSAGES.noAudio });
    expect(fetchMock).toHaveBeenCalledTimes(1 + AUDIO.musicAttempts);
    expect(await openChatsLeft(testApp)).toBe(TRIAL.chatsPerDay.open - 1);
  });

  it('asks Lyria again when a stream ends with no audio, and charges the song alone', async () => {
    const answers = [
      musicStream({ cost: 0 }),
      musicStream({ audio: toBase64(mp3Of(1)), cost: 0.04 }),
    ];
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(answers.shift() ?? json({}, 500)));
    const testApp = createTestApp(fetchMock, { accessMode: 'trial' });
    const secret = await fundedBalance(testApp.ledger, 1);
    const response = await post(testApp, { modelId: MUSIC, prompt: 'Rain' }, balanceHeader(secret));
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await balanceOf(testApp, secret)).toBe(usdToMicros(1) - paid(0.04));
  });

  it('asks again when the stream breaks before its end', async () => {
    const broken = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"'));
          controller.error(new TypeError('terminated'));
        },
      }),
      { status: 200 },
    );
    const answers = [broken, musicStream({ audio: toBase64(mp3Of(1)) })];
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(answers.shift() ?? json({}, 500)));
    const response = await post(createTestApp(fetchMock), { modelId: MUSIC, prompt: 'Rain' });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/audio, refusals', () => {
  it('refuses the tools of pictures, a model of another kind, and a voice on an image', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const testApp = createTestApp(fetchMock);
    const shaped = await post(testApp, { modelId: VOICE, prompt: 'Hi.', aspectRatio: '16:9' });
    expect(await errorOf(shaped)).toEqual({
      code: 'invalid_request',
      message: MESSAGES.audioToolsOnly,
    });
    const image = await post(testApp, { modelId: IMAGE, prompt: 'Hi.' });
    expect(await errorOf(image)).toEqual({
      code: 'invalid_request',
      message: MESSAGES.notAudioModel,
    });
    const voiced = await Promise.resolve(
      testApp.app.request(`/api${MEDIA.imagesPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: IMAGE, prompt: 'A fox', voice: 'jessica' }),
      }),
    );
    expect(await errorOf(voiced)).toEqual({
      code: 'invalid_request',
      message: MESSAGES.voiceAudioOnly,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 424 with a readable error when the speech API sends no audio', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(audioBytes(new Uint8Array([1, 2, 3, 4]), 'application/octet-stream')),
    );
    const response = await post(createTestApp(fetchMock), { modelId: VOICE, prompt: 'Hi.' });
    expect(response.status).toBe(MEDIA.upstreamFailureStatus);
    expect(await errorOf(response)).toEqual({
      code: 'upstream_error',
      message: MESSAGES.upstreamUnreadable,
    });
  });
});

describe('the files of audio', () => {
  it('reads the format of raw PCM from its content type', () => {
    expect(pcmFormatOf('audio/pcm;rate=24000;channels=2')).toEqual({ rate: 24_000, channels: 2 });
    expect(pcmFormatOf('audio/pcm; rate=16000')).toEqual({ rate: 16_000, channels: 1 });
    expect(pcmFormatOf('audio/pcm')).toBeNull();
    expect(pcmFormatOf('audio/mpeg')).toBeNull();
  });

  it('writes a WAV header for 16-bit PCM', () => {
    const wav = wavOf(new Uint8Array(8), { rate: 24_000, channels: 2 });
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + 8);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint32(28, true)).toBe(96_000);
    expect(view.getUint32(40, true)).toBe(8);
    expect(audioTypeOf(wav)).toBe('audio/wav');
  });

  it('counts the seconds of an MP3 past its tag, and stops at a byte that starts no frame', () => {
    expect(mp3Seconds(mp3Of(10, 30))).toBeCloseTo(10 * FRAME_SECONDS, 6);
    const tail = new Uint8Array([...mp3Of(4), 0x54, 0x41, 0x47, 0]);
    expect(mp3Seconds(tail)).toBeCloseTo(4 * FRAME_SECONDS, 6);
    expect(mp3Seconds(new Uint8Array(0))).toBe(0);
  });

  it('tells the type of audio from its first bytes', () => {
    expect(audioTypeOf(mp3Of(1, 4))).toBe('audio/mpeg');
    expect(audioTypeOf(mp3Of(1))).toBe('audio/mpeg');
    expect(audioTypeOf(new TextEncoder().encode('OggS....'))).toBe('audio/ogg');
    expect(audioTypeOf(new TextEncoder().encode('<html>'))).toBeNull();
  });

  it('turns the text of Lyria into plain lyrics', () => {
    expect(lyricsOf('<instrumental>')).toBe('');
    expect(lyricsOf('[[A0]]\n[[B1]]\n[:] Golden light.\n[:] Rolling past.\n[[C2]]\n[:] Run!')).toBe(
      'Golden light.\nRolling past.\n\nRun!',
    );
    // Lyria 3 Clip puts the times of each line in front of it, sometimes without an end.
    expect(
      lyricsOf('[0.0:2.4] Woke up this morning\n[2.4:4.8] The sky is blue\n[4.8:] Sunlight'),
    ).toBe('Woke up this morning\nThe sky is blue\nSunlight');
  });
});

describe('the audio tools of the catalog', () => {
  it('holds every rule today', () => {
    expect(audioToolsProblems(MODEL_CATALOG, AUDIO_TOOLS)).toEqual([]);
  });

  it('finds a model without tools, tools without a model, and a voice on music', () => {
    const rest = Object.fromEntries(Object.entries(AUDIO_TOOLS).filter(([id]) => id !== VOICE));
    const music = AUDIO_TOOLS[MUSIC];
    if (music === undefined) throw new Error('Lyria has no tools.');
    const problems = audioToolsProblems(MODEL_CATALOG, {
      ...rest,
      [MUSIC]: { ...music, voices: [{ id: 'x', name: 'X' }] },
      'open/nothing': music,
    });
    expect(problems).toEqual([
      `${MUSIC}: only a model of the mode voice has voices`,
      `${VOICE}: a model of audio needs its audio tools`,
      'open/nothing: audio tools for a model that makes no audio',
    ]);
  });
});
