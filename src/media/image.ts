// One image from OpenRouter (the owner, 23 Oct 2026). A model that a chat completion reaches gets
// one, so that the provider preferences of its level hold and the lane ZDR keeps zero data
// retention; a model of the level Open that only the Images API reaches gets that. Either answer
// comes whole, with the images as base64. Formats read on 23 Oct 2026:
// openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion.md (modalities, image_config,
// message.images) and openrouter.ai/docs/guides/overview/multimodal/image-generation.md.
import { z } from 'zod';

import { MESSAGES } from '../config/messages.js';
import type { ImageSettings } from '../config/models.js';
import {
  OPENROUTER,
  providerPreferencesFor,
  type ProviderPreferences,
} from '../config/openrouter.js';
import type { ChatUsage, PrivacyLevel } from '../contract.js';
import { contentParts, type ContentPart, type UpstreamDeps } from '../openrouter/stream.js';
import { callOpenRouter, mediaUpstreamError, type MediaPrompt } from './upstream.js';

/** The model of an image, as OpenRouter knows it. */
export interface ImageTarget {
  readonly slug: string;
  readonly privacy: PrivacyLevel;
  readonly settings: ImageSettings;
}

/** The JSON body of a chat completion that asks for an image. It names no user and no app. */
export interface ImageChatBody {
  model: string;
  messages: { role: 'user'; content: string | ContentPart[] }[];
  modalities: readonly ('image' | 'text')[];
  image_config: { aspect_ratio: string };
  stream: false;
  provider: ProviderPreferences;
}

/** The JSON body of the Images API. It names no user and no app. */
export interface ImagesApiBody {
  model: string;
  prompt: string;
  aspect_ratio: string;
  n: 1;
  /** The photo to change, when the user gave one. */
  input_references?: { type: 'image_url'; image_url: { url: string } }[];
}

/** What one request made: its images as data URLs, any text, and what it used. */
export interface ImageResult {
  readonly dataUrls: string[];
  readonly text: string;
  readonly usage: ChatUsage | null;
  /** The cost that OpenRouter reported, in USD, or null without one. */
  readonly costUsd: number | null;
}

const usageSchema = z
  .object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    cost: z.number().nonnegative().nullish(),
  })
  .nullish();

const chatAnswerSchema = z.object({
  error: z.unknown().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          images: z.array(z.object({ image_url: z.object({ url: z.string() }) })).nullish(),
        }),
      }),
    )
    .nullish(),
  usage: usageSchema,
});

const imagesAnswerSchema = z.object({
  data: z.array(z.object({ b64_json: z.string(), media_type: z.string().nullish() })),
  usage: usageSchema,
});

/** An image that the browser can show: base64 data of an image type. */
const IMAGE_DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i;

/** The type of an image of the Images API that names none (the docs: PNG). */
const DEFAULT_IMAGE_TYPE = 'image/png';

export function imageChatBody(target: ImageTarget, prompt: MediaPrompt): ImageChatBody {
  const { api, aspectRatio } = target.settings;
  const content = prompt.image === null ? prompt.text : contentParts(prompt.text, [prompt.image]);
  return {
    model: target.slug,
    messages: [{ role: 'user', content }],
    modalities: api.name === 'chat' ? api.modalities : ['image'],
    image_config: { aspect_ratio: aspectRatio },
    stream: false,
    provider: providerPreferencesFor(target.privacy),
  };
}

export function imagesApiBody(target: ImageTarget, prompt: MediaPrompt): ImagesApiBody {
  const body: ImagesApiBody = {
    model: target.slug,
    prompt: prompt.text,
    aspect_ratio: target.settings.aspectRatio,
    n: 1,
  };
  if (prompt.image === null) return body;
  return { ...body, input_references: [{ type: 'image_url', image_url: { url: prompt.image } }] };
}

/** Makes one image, or throws a ProxyError when OpenRouter fails or the app goes away. */
export function generateImage(
  deps: UpstreamDeps,
  target: ImageTarget,
  prompt: MediaPrompt,
  clientSignal: AbortSignal,
): Promise<ImageResult> {
  const chat = target.settings.api.name === 'chat';
  return callOpenRouter(
    deps,
    {
      path: chat ? OPENROUTER.chatCompletionsPath : OPENROUTER.imagesPath,
      method: 'POST',
      body: chat ? imageChatBody(target, prompt) : imagesApiBody(target, prompt),
      timeoutMs: OPENROUTER.imageTimeoutMs,
      read: async (response) => {
        const json: unknown = await response.json();
        return chat ? chatResultOf(json) : imagesResultOf(json);
      },
    },
    clientSignal,
  );
}

function chatResultOf(json: unknown): ImageResult {
  const answer = chatAnswerSchema.safeParse(json);
  if (!answer.success) throw mediaUpstreamError(MESSAGES.upstreamUnreadable);
  if (answer.data.error !== undefined && answer.data.error !== null) {
    throw mediaUpstreamError(MESSAGES.upstreamStopped);
  }
  const message = answer.data.choices?.[0]?.message;
  const urls = (message?.images ?? []).map((image) => image.image_url.url);
  return resultOf(urls, message?.content ?? '', answer.data.usage);
}

function imagesResultOf(json: unknown): ImageResult {
  const answer = imagesAnswerSchema.safeParse(json);
  if (!answer.success) throw mediaUpstreamError(MESSAGES.upstreamUnreadable);
  const urls = answer.data.data.map(
    (image) => `data:${image.media_type ?? DEFAULT_IMAGE_TYPE};base64,${image.b64_json}`,
  );
  return resultOf(urls, '', answer.data.usage);
}

function resultOf(
  urls: readonly string[],
  text: string,
  usage: z.infer<typeof usageSchema>,
): ImageResult {
  return {
    dataUrls: urls.filter((url) => IMAGE_DATA_URL.test(url)),
    text,
    usage:
      usage === undefined || usage === null
        ? null
        : { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens },
    costUsd: usage?.cost ?? null,
  };
}
