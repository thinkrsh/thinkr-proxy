// One streamed chat completion on OpenRouter, with zero data retention forced at the level of the
// lane ZDR, timeouts, and cancellation when the app goes away.
import { MESSAGES } from '../config/messages.js';
import {
  OPENROUTER,
  providerPreferencesFor,
  type ProviderPreferences,
} from '../config/openrouter.js';
import type { ReasoningRequest } from '../config/thinking.js';
import type { ChatEvent, ChatMessage, PrivacyLevel } from '../contract.js';
import { ProxyError, upstreamStatusError } from '../lib/errors.js';
import { UpstreamLifetime, type StopCause } from '../lib/upstream-lifetime.js';
import { readChatEvents, type AnswerSpend } from './chunks.js';

export interface UpstreamDeps {
  readonly fetch: typeof fetch;
  readonly apiKey: string;
}

export interface UpstreamRequest {
  readonly slug: string;
  /** The privacy level of the model, which sets the provider preferences. */
  readonly privacy: PrivacyLevel;
  readonly messages: readonly ChatMessage[];
  /** What Think asks of the model (catalog.ts, `reasoningOf`); null leaves the model as it is. */
  readonly reasoning: ReasoningRequest | null;
}

/** The parts of a message with photos, in the format of chat completions. */
export type ContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

/** The JSON body sent to OpenRouter. It names no user and no app. */
export interface UpstreamBody {
  model: string;
  messages: { role: ChatMessage['role']; content: string | ContentPart[] }[];
  stream: true;
  provider: ProviderPreferences;
  reasoning?: ReasoningRequest;
}

export function upstreamBody(request: UpstreamRequest): UpstreamBody {
  return {
    model: request.slug,
    messages: request.messages.map(({ role, content, images }) => ({
      role,
      content:
        images === undefined || images.length === 0 ? content : contentParts(content, images),
    })),
    stream: true,
    provider: providerPreferencesFor(request.privacy),
    ...(request.reasoning === null ? {} : { reasoning: request.reasoning }),
  };
}

/** A text and its photos as the parts of one message: the text first, when there is one. */
export function contentParts(text: string, images: readonly string[]): ContentPart[] {
  const parts: ContentPart[] = text.trim() === '' ? [] : [{ type: 'text', text }];
  for (const url of images) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

export class UpstreamChat {
  private readonly lifetime: UpstreamLifetime;

  constructor(
    private readonly deps: UpstreamDeps,
    private readonly request: UpstreamRequest,
    clientSignal: AbortSignal,
  ) {
    this.lifetime = new UpstreamLifetime(clientSignal, {
      firstByteMs: OPENROUTER.firstByteTimeoutMs,
      streamMs: OPENROUTER.streamTimeoutMs,
    });
  }

  /** Sends the request. Throws a ProxyError when OpenRouter fails before the answer starts. */
  async open(): Promise<ReadableStream<Uint8Array>> {
    try {
      return await this.lifetime.withFirstByteDeadline(async () =>
        this.answerBody(await this.send()),
      );
    } catch (error) {
      this.lifetime.dispose();
      throw this.lifetime.errorFor(error);
    }
  }

  /**
   * Yields the events of the answer. The last event is 'done' or 'error', unless the app left.
   * A whole answer reports what it used to `onSpend` before its 'done'.
   */
  async *events(
    body: ReadableStream<Uint8Array>,
    onSpend: (spend: AnswerSpend) => void,
  ): AsyncGenerator<ChatEvent> {
    try {
      yield* readChatEvents(body, onSpend);
    } catch (error) {
      const event = this.failureEvent(error);
      if (event !== null) yield event;
    } finally {
      this.lifetime.dispose();
    }
  }

  stop(cause: StopCause): void {
    this.lifetime.stop(cause);
  }

  private send(): Promise<Response> {
    return this.deps.fetch(`${OPENROUTER.baseUrl}${OPENROUTER.chatCompletionsPath}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.deps.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(upstreamBody(this.request)),
      signal: this.lifetime.signal,
    });
  }

  private async answerBody(response: Response): Promise<ReadableStream<Uint8Array>> {
    if (!response.ok) {
      await response.body?.cancel();
      throw upstreamStatusError(response.status);
    }
    if (response.body === null) throw new ProxyError('upstream_error', MESSAGES.upstreamUnreadable);
    return response.body;
  }

  /** The event that ends a broken stream, or null when the app left and nobody is listening. */
  private failureEvent(error: unknown): ChatEvent | null {
    if (this.lifetime.cause === 'client') return null;
    if (this.lifetime.cause === 'stream-timeout') {
      return { type: 'error', code: 'upstream_timeout', message: MESSAGES.upstreamTimeout };
    }
    const message = error instanceof ProxyError ? error.message : MESSAGES.upstreamBroken;
    return { type: 'error', code: 'upstream_error', message };
  }
}
