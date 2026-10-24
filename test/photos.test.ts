import { describe, expect, it, vi } from 'vitest';

import { LIMITS } from '../src/config/limits.js';
import { MEDIA } from '../src/config/media.js';
import { MESSAGES } from '../src/config/messages.js';
import type { ErrorBody } from '../src/contract.js';
import type { ImageChatBody, ImagesApiBody } from '../src/media/image.js';
import type { VideoUpstreamBody } from '../src/media/video.js';
import type { UpstreamBody } from '../src/openrouter/stream.js';
import {
  DONE,
  contentChunk,
  createTestApp,
  postChat,
  readEvents,
  upstreamCall,
  upstreamResponse,
  type FetchMock,
} from './helpers.js';

// Photos of the open lane (23 Oct 2026): with a chat of a model that sees them, and as the image
// that an image model changes or the first frame of a video.
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const SEES = 'open/claude-haiku-5.5';
const BLIND = 'open/qwen3.8-2.4t';

function chatApp(): { app: ReturnType<typeof createTestApp>['app']; fetchMock: FetchMock } {
  const fetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(upstreamResponse([contentChunk('A cat.'), DONE])),
  );
  return { app: createTestApp(fetchMock).app, fetchMock };
}

function bodyOf(fetchMock: FetchMock): unknown {
  const { init } = upstreamCall(fetchMock);
  if (typeof init.body !== 'string') throw new Error('The upstream body is not JSON.');
  return JSON.parse(init.body) as unknown;
}

async function errorOf(response: Response): Promise<ErrorBody['error']> {
  return ((await response.json()) as ErrorBody).error;
}

function postMedia(
  app: ReturnType<typeof createTestApp>['app'],
  path: string,
  body: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.request(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/chat with photos', () => {
  it('sends the text and the photos of a message as parts, to a model that sees', async () => {
    const { app, fetchMock } = chatApp();
    const response = await postChat(app, {
      modelId: SEES,
      messages: [{ role: 'user', content: 'What is this?', images: [PHOTO] }],
    });
    await readEvents(response);
    expect((bodyOf(fetchMock) as UpstreamBody).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: PHOTO } },
        ],
      },
    ]);
  });

  it('takes a message of photos alone', async () => {
    const { app, fetchMock } = chatApp();
    await readEvents(
      await postChat(app, {
        modelId: SEES,
        messages: [{ role: 'user', content: '', images: [PHOTO] }],
      }),
    );
    expect((bodyOf(fetchMock) as UpstreamBody).messages[0]?.content).toEqual([
      { type: 'image_url', image_url: { url: PHOTO } },
    ]);
  });

  it('refuses photos for a model that cannot see them, before calling OpenRouter', async () => {
    const { app, fetchMock } = chatApp();
    const response = await postChat(app, {
      modelId: BLIND,
      messages: [{ role: 'user', content: 'What is this?', images: [PHOTO] }],
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toBe(MESSAGES.noVision);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses photos of an answer, too many photos, and a photo that is no image', async () => {
    const { app } = chatApp();
    const fromAnswer = await postChat(app, {
      modelId: SEES,
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello', images: [PHOTO] },
        { role: 'user', content: 'Hi' },
      ],
    });
    expect((await errorOf(fromAnswer)).message).toBe(
      `messages.1.images: ${MESSAGES.imagesFromUserOnly}`,
    );
    const many = Array.from({ length: LIMITS.maxImagesPerMessage + 1 }, () => PHOTO);
    const tooMany = await postChat(app, {
      modelId: SEES,
      messages: [{ role: 'user', content: 'Hi', images: many }],
    });
    expect((await errorOf(tooMany)).message).toBe(`messages.0.images: ${MESSAGES.tooManyImages}`);
    const notImage = await postChat(app, {
      modelId: SEES,
      messages: [{ role: 'user', content: 'Hi', images: ['data:text/html;base64,PGI+'] }],
    });
    expect((await errorOf(notImage)).message).toBe(`messages.0.images.0: ${MESSAGES.imageInvalid}`);
  });
});

describe('images and video from a photo', () => {
  function mediaApp(answer: () => Response): {
    app: ReturnType<typeof createTestApp>['app'];
    fetchMock: FetchMock;
  } {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(answer()));
    return { app: createTestApp(fetchMock).app, fetchMock };
  }

  const imageAnswer = (): Response =>
    Response.json({
      choices: [{ message: { content: '', images: [{ image_url: { url: PHOTO } }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.05 },
    });

  it('gives a model of ZDR the photo to change beside the prompt', async () => {
    const { app, fetchMock } = mediaApp(imageAnswer);
    await postMedia(app, MEDIA.imagesPath, {
      modelId: 'open/nano-banana-2',
      prompt: 'Make it night',
      image: PHOTO,
    });
    expect((bodyOf(fetchMock) as ImageChatBody).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Make it night' },
          { type: 'image_url', image_url: { url: PHOTO } },
        ],
      },
    ]);
  });

  it('gives a model of the Images API the photo as its reference', async () => {
    const { app, fetchMock } = mediaApp(() =>
      Response.json({ data: [{ b64_json: '/9j/4AAQSkZJRg==', media_type: 'image/jpeg' }] }),
    );
    await postMedia(app, MEDIA.imagesPath, {
      modelId: 'open/flux-3',
      prompt: 'Make it night',
      image: PHOTO,
    });
    expect((bodyOf(fetchMock) as ImagesApiBody).input_references).toEqual([
      { type: 'image_url', image_url: { url: PHOTO } },
    ]);
  });

  it('starts a video from the photo as its first frame', async () => {
    const { app, fetchMock } = mediaApp(() => Response.json({ id: 'job', status: 'pending' }));
    await postMedia(app, MEDIA.videosPath, {
      modelId: 'open/wan-3.0',
      prompt: 'Waves roll in',
      image: PHOTO,
    });
    expect((bodyOf(fetchMock) as VideoUpstreamBody).frame_images).toEqual([
      { type: 'image_url', image_url: { url: PHOTO }, frame_type: 'first_frame' },
    ]);
  });

  it('sends no reference when the prompt has no photo', async () => {
    const { app, fetchMock } = mediaApp(() => Response.json({ id: 'job', status: 'pending' }));
    await postMedia(app, MEDIA.videosPath, { modelId: 'open/wan-3.0', prompt: 'Waves roll in' });
    expect(bodyOf(fetchMock) as VideoUpstreamBody).not.toHaveProperty('frame_images');
  });
});
