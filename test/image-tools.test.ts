import { describe, expect, it, vi } from 'vitest';

import { findImageTools, findModel, imageToolsProblems } from '../src/catalog.js';
import { CREDIT } from '../src/config/credit.js';
import { IMAGE_TOOLS, PHOTO_LIMIT, type ImageTools } from '../src/config/imageTools.js';
import { MEDIA } from '../src/config/media.js';
import { MESSAGES } from '../src/config/messages.js';
import { MODEL_CATALOG } from '../src/config/models.js';
import type { ErrorBody, ModelsResponse } from '../src/contract.js';
import { balanceHash, mediaPriceUsd, usdToMicros } from '../src/credit/balance.js';
import type { ImageChatBody, ImagesApiBody } from '../src/media/image.js';
import {
  balanceHeader,
  createTestApp,
  fundedBalance,
  upstreamCall,
  type FetchMock,
  type TestApp,
} from './helpers.js';

// The tools of the Image page (the owner, 25 Oct 2026): sizes, several photos, a seed, and a
// transparent background, checked against config/imageTools.ts.
const SIZED = 'open/flux-3-image-klein';
const SEEDED = 'open/qwen-image-3';
const CLEAR = 'open/riverflow-v2.5-pro';
const CLEAR_NO_FORMAT = 'open/gpt-image-1';
const ONE_PHOTO = 'open/recraft-v4.1';
const ZDR_IMAGE = 'open/nano-banana-2';
const STYLED = 'open/recraft-v4-styles';
const VECTOR = 'open/recraft-v4.1-vector';
const VIDEO = 'open/wan-3.0';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** An answer of the Images API, with the cost that OpenRouter reports, or none. */
function imagesAnswer(cost?: number): Response {
  return json({
    data: [{ b64_json: 'iVBORw0KGgo=', media_type: 'image/png' }],
    usage: { prompt_tokens: 0, completion_tokens: 100, ...(cost === undefined ? {} : { cost }) },
  });
}

function chatAnswer(): Response {
  return json({
    choices: [{ message: { content: '', images: [{ image_url: { url: PNG } }] } }],
    usage: { prompt_tokens: 12, completion_tokens: 1290, cost: 0.07 },
  });
}

function post(testApp: TestApp, body: unknown, headers = {}): Promise<Response> {
  return Promise.resolve(
    testApp.app.request(`/api${MEDIA.imagesPath}`, {
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

function sizeCost(modelId: string, resolution: string): number {
  const size = findImageTools(modelId).sizes.find((option) => option.resolution === resolution);
  if (size === undefined) throw new Error(`${modelId} makes no size ${resolution}.`);
  return size.costUsd;
}

describe('the image tools of the catalog', () => {
  it('gives every image model its tools, and holds each default size at the cost of the catalog', () => {
    expect(imageToolsProblems(MODEL_CATALOG, IMAGE_TOOLS)).toEqual([]);
  });

  it('finds a missing entry, a stray one, and a default size that is not offered or costs more', () => {
    const image = findModel(SIZED);
    if (image?.media?.kind !== 'image') throw new Error(`${SIZED} is no image model.`);
    const tools = findImageTools(SIZED);
    const broken: ImageTools = { ...tools, defaultSize: '8K', maxPhotos: PHOTO_LIMIT + 1 };
    const dearer: ImageTools = {
      ...tools,
      sizes: tools.sizes.map((size) => ({ ...size, costUsd: size.costUsd + 1 })),
    };
    expect(imageToolsProblems([image], {})).toEqual([
      `${SIZED}: an image model needs its image tools`,
    ]);
    expect(imageToolsProblems([image], { [SIZED]: broken, 'open/glm-5.3-flash': tools })).toEqual([
      `${SIZED}: its photos must run from 0 to ${String(PHOTO_LIMIT)}, the fewest first`,
      `${SIZED}: its sizes must hold its default size`,
      'open/glm-5.3-flash: image tools for a model that makes no images',
    ]);
    expect(imageToolsProblems([image], { [SIZED]: dearer })).toEqual([
      `${SIZED}: its default size must cost what the catalog gives one image`,
    ]);
  });

  it('lists the tools of an image model with each price at what the user pays', async () => {
    const response = await createTestApp().app.request('/api/models?kinds=image,video');
    const { models } = (await response.json()) as ModelsResponse;
    const tools = findImageTools(SIZED);
    expect(models.find((model) => model.id === SIZED)?.media?.tools).toEqual({
      sizes: tools.sizes.map(({ resolution, costUsd }) => ({
        resolution,
        priceUsd: mediaPriceUsd({ costUsd }),
      })),
      defaultSize: '1K',
      minPhotos: 0,
      maxPhotos: tools.maxPhotos,
      photoPriceUsd: 0,
      seed: false,
      transparent: false,
    });
    expect(models.find((model) => model.id === VIDEO)?.media?.tools).toBeUndefined();
  });
});

describe('POST /api/images with the tools of the Image page', () => {
  it('names a size other than the default, and leaves the default to the provider', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(imagesAnswer(0.02)));
    const testApp = createTestApp(fetchMock);
    await post(testApp, { modelId: SIZED, prompt: 'A fox', resolution: '2K' });
    expect((bodyOf(fetchMock) as ImagesApiBody).resolution).toBe('2K');
    fetchMock.mockClear();
    await post(testApp, { modelId: SIZED, prompt: 'A fox', resolution: '1K' });
    expect(bodyOf(fetchMock) as ImagesApiBody).not.toHaveProperty('resolution');
  });

  it('refuses a size that the model does not make, before calling OpenRouter', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const response = await post(createTestApp(fetchMock), {
      modelId: ZDR_IMAGE,
      prompt: 'A fox',
      resolution: '2K',
    });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toEqual({
      code: 'invalid_request',
      message: MESSAGES.sizeUnavailable,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('holds a balance to the price of the size picked, and charges the estimate of that size', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(imagesAnswer()));
    const testApp = createTestApp(fetchMock, { accessMode: 'trial' });
    const twoK = usdToMicros(sizeCost(SIZED, '2K') * CREDIT.markup);
    const secret = await fundedBalance(testApp.ledger, sizeCost(SIZED, '1K') * CREDIT.markup);
    const refused = await post(
      testApp,
      { modelId: SIZED, prompt: 'A fox', resolution: '2K' },
      balanceHeader(secret),
    );
    expect(refused.status).toBe(402);
    expect(fetchMock).not.toHaveBeenCalled();
    const rich = await fundedBalance(testApp.ledger, 1);
    const response = await post(
      testApp,
      { modelId: SIZED, prompt: 'A fox', resolution: '2K' },
      balanceHeader(rich),
    );
    expect(response.status).toBe(200);
    expect(testApp.ledger.balance(await balanceHash(rich))).toBe(usdToMicros(1) - twoK);
  });

  it('sends several photos to the Images API and to a chat completion', async () => {
    const images = vi.fn<typeof fetch>(() => Promise.resolve(imagesAnswer(0.01)));
    await post(createTestApp(images), { modelId: SIZED, prompt: 'Both', images: [PNG, PNG] });
    expect((bodyOf(images) as ImagesApiBody).input_references).toEqual([
      { type: 'image_url', image_url: { url: PNG } },
      { type: 'image_url', image_url: { url: PNG } },
    ]);
    const chat = vi.fn<typeof fetch>(() => Promise.resolve(chatAnswer()));
    await post(createTestApp(chat), { modelId: ZDR_IMAGE, prompt: 'Both', images: [PNG, PNG] });
    expect((bodyOf(chat) as ImageChatBody).messages[0]?.content).toEqual([
      { type: 'text', text: 'Both' },
      { type: 'image_url', image_url: { url: PNG } },
      { type: 'image_url', image_url: { url: PNG } },
    ]);
  });

  it('refuses more photos than the model takes, and one photo sent both ways', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const testApp = createTestApp(fetchMock);
    const tooMany = await post(testApp, { modelId: ONE_PHOTO, prompt: 'A', images: [PNG, PNG] });
    expect(await errorOf(tooMany)).toEqual({
      code: 'invalid_request',
      message: MESSAGES.tooManyPhotos,
    });
    const overLimit = Array.from({ length: PHOTO_LIMIT + 1 }, () => PNG);
    expect((await post(testApp, { modelId: SIZED, prompt: 'A', images: overLimit })).status).toBe(
      400,
    );
    const twice = await post(testApp, {
      modelId: SIZED,
      prompt: 'A',
      image: PNG,
      images: [PNG, PNG],
    });
    expect(await errorOf(twice)).toEqual({
      code: 'invalid_request',
      message: MESSAGES.photosTwice,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a seed to a model that takes one, and refuses it elsewhere', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(imagesAnswer(0.03)));
    const testApp = createTestApp(fetchMock);
    await post(testApp, { modelId: SEEDED, prompt: 'A fox', seed: 42 });
    expect((bodyOf(fetchMock) as ImagesApiBody).seed).toBe(42);
    const refused = await post(testApp, { modelId: SIZED, prompt: 'A fox', seed: 42 });
    expect(await errorOf(refused)).toEqual({
      code: 'invalid_request',
      message: MESSAGES.seedUnavailable,
    });
  });

  it('asks for a transparent background, in PNG where the model takes a format', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(imagesAnswer(0.13)));
    const testApp = createTestApp(fetchMock);
    await post(testApp, { modelId: CLEAR, prompt: 'A cup', transparent: true });
    expect(bodyOf(fetchMock)).toMatchObject({ background: 'transparent', output_format: 'png' });
    fetchMock.mockClear();
    await post(testApp, { modelId: CLEAR_NO_FORMAT, prompt: 'A cup', transparent: true });
    const body = bodyOf(fetchMock) as ImagesApiBody;
    expect(body.background).toBe('transparent');
    expect(body).not.toHaveProperty('output_format');
    const refused = await post(testApp, { modelId: SIZED, prompt: 'A cup', transparent: true });
    expect(await errorOf(refused)).toEqual({
      code: 'invalid_request',
      message: MESSAGES.transparentUnavailable,
    });
  });

  it('keeps a larger size and several photos for credit on the free trial', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(imagesAnswer(0.01)));
    const testApp = createTestApp(fetchMock, { accessMode: 'trial' });
    for (const body of [
      { modelId: SIZED, prompt: 'A fox', resolution: '2K' },
      { modelId: SIZED, prompt: 'A fox', images: [PNG, PNG] },
    ]) {
      const response = await post(testApp, body);
      expect(response.status).toBe(403);
      expect(await errorOf(response)).toEqual({
        code: 'model_unavailable',
        message: MESSAGES.imageCreditOnly,
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    // A smaller size costs less than the default, so the trial makes it.
    expect(
      (await post(testApp, { modelId: SIZED, prompt: 'A fox', resolution: '768' })).status,
    ).toBe(200);
  });

  it('makes every size for the mode full of the laptop, which needs no credit', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(imagesAnswer(0.03)));
    const response = await post(createTestApp(fetchMock), {
      modelId: SIZED,
      prompt: 'A fox',
      resolution: '4K',
    });
    expect(response.status).toBe(200);
  });

  it('needs a style image for a model that draws in the style of one', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(imagesAnswer(0.035)));
    const testApp = createTestApp(fetchMock);
    const refused = await post(testApp, { modelId: STYLED, prompt: 'A fox' });
    expect(await errorOf(refused)).toEqual({
      code: 'invalid_request',
      message: MESSAGES.tooFewPhotos,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const made = await post(testApp, { modelId: STYLED, prompt: 'A fox', image: PNG });
    expect(made.status).toBe(200);
    expect((bodyOf(fetchMock) as ImagesApiBody).input_references).toHaveLength(1);
  });

  it('passes on an SVG drawing of a vector model as it came', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        json({
          data: [{ b64_json: 'PHN2Zz48L3N2Zz4=', media_type: 'image/svg+xml' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0.08 },
        }),
      ),
    );
    const response = await post(createTestApp(fetchMock), { modelId: VECTOR, prompt: 'A logo' });
    expect(((await response.json()) as { images: { dataUrl: string }[] }).images).toEqual([
      { dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
    ]);
  });

  it('refuses the tools of an image in a request of a video', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const response = await createTestApp(fetchMock).app.request(`/api${MEDIA.videosPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId: VIDEO, prompt: 'A fox', seed: 42 }),
    });
    expect(await errorOf(response)).toEqual({
      code: 'invalid_request',
      message: MESSAGES.imageToolsOnly,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
