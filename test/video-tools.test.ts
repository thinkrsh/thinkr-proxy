import { describe, expect, it, vi } from 'vitest';

import { findModel, findVideoTools, videoToolsProblems } from '../src/catalog.js';
import { MEDIA } from '../src/config/media.js';
import { MESSAGES } from '../src/config/messages.js';
import { MODEL_CATALOG } from '../src/config/models.js';
import { VIDEO_TOOLS, type VideoTools } from '../src/config/videoTools.js';
import type { ErrorBody, ModelsResponse } from '../src/contract.js';
import { balanceHash, mediaPriceUsd, usdToMicros } from '../src/credit/balance.js';
import type { VideoUpstreamBody } from '../src/media/video.js';
import {
  balanceHeader,
  createTestApp,
  fundedBalance,
  upstreamCall,
  type FetchMock,
  type TestApp,
} from './helpers.js';

// The tools of the Video page (the owner, 25 Oct 2026): a resolution of the model's at its price
// for each second, a video without sound, and a last frame, checked against config/videoTools.ts.
const SIZED = 'open/wan-3.0';
const VEO = 'open/veo-3.1';
const SILENT_ONLY = 'open/grok-imagine-video-1.5';
const SIZELESS = 'open/seedance-2.0';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQ';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fake OpenRouter that takes every job. */
function upstream(): FetchMock {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(json({ id: 'job-1', polling_url: 'x', status: 'pending' }, 202)),
  );
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

function bodyOf(fetchMock: FetchMock): VideoUpstreamBody {
  const { init } = upstreamCall(fetchMock);
  if (typeof init.body !== 'string') throw new Error('The upstream body is not JSON.');
  return JSON.parse(init.body) as VideoUpstreamBody;
}

async function errorOf(response: Response): Promise<ErrorBody['error']> {
  return ((await response.json()) as ErrorBody).error;
}

describe('the video tools of the catalog', () => {
  it('gives every video model its tools, each resolution of the catalog at about its cost', () => {
    expect(videoToolsProblems(MODEL_CATALOG, VIDEO_TOOLS)).toEqual([]);
  });

  it('finds a missing entry, a stray one, a missing resolution, a dearer one, and sound to drop', () => {
    const video = findModel(SIZED);
    const silentVideo = findModel(SILENT_ONLY);
    if (video === undefined || silentVideo === undefined) throw new Error('No such models.');
    const tools = findVideoTools(SIZED);
    const noDefault: VideoTools = {
      ...tools,
      sizes: tools.sizes.filter((s) => s.resolution !== '720p'),
    };
    const dearer: VideoTools = {
      ...tools,
      sizes: tools.sizes.map((s) => ({ ...s, secondUsd: s.secondUsd * 2 })),
    };
    expect(videoToolsProblems([video], {})).toEqual([
      `${SIZED}: a video model needs its video tools`,
    ]);
    expect(
      videoToolsProblems([video], { [SIZED]: noDefault, 'open/glm-5.3-flash': tools }),
    ).toEqual([
      `${SIZED}: its sizes must hold its resolution`,
      'open/glm-5.3-flash: video tools for a model that makes no videos',
    ]);
    expect(videoToolsProblems([video], { [SIZED]: dearer })).toEqual([
      `${SIZED}: its resolution must cost about what the catalog gives one video`,
    ]);
    expect(
      videoToolsProblems([silentVideo], {
        [SILENT_ONLY]: { ...findVideoTools(SILENT_ONLY), silent: true },
      }),
    ).toEqual([`${SILENT_ONLY}: a model without sound has none to leave out`]);
  });

  it('lists the tools of a video model with each second at what the user pays', async () => {
    const response = await createTestApp().app.request('/api/models?kinds=video');
    const { models } = (await response.json()) as ModelsResponse;
    expect(models.find((model) => model.id === VEO)?.media?.videoTools).toEqual({
      sizes: findVideoTools(VEO).sizes.map((size) => ({
        resolution: size.resolution,
        secondPriceUsd: mediaPriceUsd({ costUsd: size.secondUsd }),
        silentSecondPriceUsd:
          size.silentSecondUsd === null ? null : mediaPriceUsd({ costUsd: size.silentSecondUsd }),
      })),
      silent: true,
      lastFrame: true,
    });
  });
});

describe('POST /api/videos with the tools of the Video page', () => {
  it('sends the resolution picked and takes its price for each second ahead', async () => {
    const fetchMock = upstream();
    const testApp = createTestApp(fetchMock, { accessMode: 'trial' });
    const secret = await fundedBalance(testApp.ledger, 5);
    const response = await post(
      testApp,
      MEDIA.videosPath,
      { modelId: SIZED, prompt: 'Waves', resolution: '1080p', seconds: 5 },
      balanceHeader(secret),
    );
    expect(response.status).toBe(202);
    expect(bodyOf(fetchMock)).toMatchObject({ resolution: '1080p', duration: 5 });
    const paid = usdToMicros(mediaPriceUsd({ costUsd: 0.2 * 5 }));
    expect(testApp.ledger.balance(await balanceHash(secret))).toBe(usdToMicros(5) - paid);
  });

  it('leaves the sound out at its silent price', async () => {
    const fetchMock = upstream();
    const testApp = createTestApp(fetchMock, { accessMode: 'trial' });
    const secret = await fundedBalance(testApp.ledger, 5);
    await post(
      testApp,
      MEDIA.videosPath,
      { modelId: VEO, prompt: 'Waves', silent: true },
      balanceHeader(secret),
    );
    expect(bodyOf(fetchMock).generate_audio).toBe(false);
    const paid = usdToMicros(mediaPriceUsd({ costUsd: 0.2 * 4 }));
    expect(testApp.ledger.balance(await balanceHash(secret))).toBe(usdToMicros(5) - paid);
  });

  it('sends a first and a last frame to a model that takes both', async () => {
    const fetchMock = upstream();
    await post(createTestApp(fetchMock), MEDIA.videosPath, {
      modelId: VEO,
      prompt: 'From one to the other',
      image: PNG,
      lastImage: JPEG,
    });
    expect(bodyOf(fetchMock).frame_images).toEqual([
      { type: 'image_url', image_url: { url: PNG }, frame_type: 'first_frame' },
      { type: 'image_url', image_url: { url: JPEG }, frame_type: 'last_frame' },
    ]);
  });

  it('refuses what the model does not take, before calling OpenRouter', async () => {
    const fetchMock = upstream();
    const testApp = createTestApp(fetchMock);
    const cases: [unknown, string][] = [
      [{ modelId: SILENT_ONLY, prompt: 'A', silent: true }, MESSAGES.silentUnavailable],
      [
        { modelId: SILENT_ONLY, prompt: 'A', image: PNG, lastImage: PNG },
        MESSAGES.lastFrameUnavailable,
      ],
      [{ modelId: VEO, prompt: 'A', lastImage: PNG }, MESSAGES.lastFrameAlone],
      [{ modelId: VEO, prompt: 'A', resolution: '480p' }, MESSAGES.sizeUnavailable],
      [{ modelId: SIZELESS, prompt: 'A', resolution: '1080p' }, MESSAGES.sizeUnavailable],
    ];
    for (const [body, message] of cases) {
      const response = await post(testApp, MEDIA.videosPath, body);
      expect(await errorOf(response)).toEqual({ code: 'invalid_request', message });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('takes the one resolution of a model with no sizes', async () => {
    const fetchMock = upstream();
    const response = await post(createTestApp(fetchMock), MEDIA.videosPath, {
      modelId: SIZELESS,
      prompt: 'A',
      resolution: '720p',
    });
    expect(response.status).toBe(202);
  });

  it('refuses the tools of a video in a request of an image', async () => {
    const fetchMock = upstream();
    const response = await post(createTestApp(fetchMock), MEDIA.imagesPath, {
      modelId: 'open/flux-3-image-klein',
      prompt: 'A',
      silent: true,
    });
    expect(await errorOf(response)).toEqual({
      code: 'invalid_request',
      message: MESSAGES.videoToolsOnly,
    });
  });
});
