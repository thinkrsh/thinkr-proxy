// POST /api/chat: the open lane. Validates the chat, then streams the answer as server-sent events.
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';

import type { Gate } from '../access/gate.js';
import { findModel, reasoningOf, searchesWeb } from '../catalog.js';
import { imageCount, parseChatRequest } from '../chat-request.js';
import type { CatalogModel } from '../config/models.js';
import { MESSAGES } from '../config/messages.js';
import { SERVER } from '../config/server.js';
import type { ChatEvent, ChatMessage } from '../contract.js';
import { readJson } from '../lib/body.js';
import { answerSpend } from '../lib/cost.js';
import { ProxyError, errorBody } from '../lib/errors.js';
import type { RateLimiter } from '../lib/rate-limit.js';
import type { AnswerSpend } from '../openrouter/chunks.js';
import { UpstreamChat, type UpstreamDeps } from '../openrouter/stream.js';

export interface ChatRouteDeps extends UpstreamDeps {
  readonly now: () => number;
  /** The key of the visitor, for the rate limit and the free trial. Never the address itself. */
  readonly clientKey: (c: Context) => string;
  /** Shared with the private lane, so both lanes count against one limit. */
  readonly limiter: RateLimiter;
  /** Who pays: a balance, or the free trial. */
  readonly gate: Gate;
}

interface OpenModel {
  readonly model: CatalogModel;
  readonly slug: string;
}

export function createChatRoute(deps: ChatRouteDeps): Hono {
  const tooLarge = bodyLimit({
    maxSize: SERVER.maxOpenChatBytes,
    onError: (c) => c.json(errorBody('invalid_request', MESSAGES.tooLarge), 413),
  });

  return new Hono().post('/chat', tooLarge, async (c) => {
    const visitor = deps.clientKey(c);
    if (!deps.limiter.take(visitor, deps.now())) {
      throw new ProxyError('rate_limited', MESSAGES.rateLimited);
    }
    const request = parseChatRequest(await readJson(c));
    const { model, slug } = servableOpenModel(request.modelId);
    if (imageCount(request.messages) > 0 && !model.info.vision) {
      throw new ProxyError('invalid_request', MESSAGES.noVision);
    }
    const webSearch = request.webSearch === true;
    if (webSearch && !searchesWeb(model.info)) {
      throw new ProxyError('invalid_request', MESSAGES.noWebSearch);
    }
    const balance = await deps.gate.balanceOf(c);
    const ticket = deps.gate.admit({ visitor, balance }, model, chatChars(request.messages), {
      webSearch,
    });
    const upstream = new UpstreamChat(
      deps,
      {
        slug,
        privacy: model.info.privacy,
        messages: request.messages,
        reasoning: reasoningOf(model, request.think),
        webSearch,
      },
      c.req.raw.signal,
    );
    let body: ReadableStream<Uint8Array>;
    try {
      body = await upstream.open();
    } catch (error) {
      ticket.refund();
      throw error;
    }
    const onSpend = (spend: AnswerSpend): void => {
      ticket.charge(answerSpend(spend.costUsd, spend.usage, model.cost, spend.webSearches));
    };
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => {
        upstream.stop('client');
      });
      for await (const event of upstream.events(body, onSpend)) await writeEvent(stream, event);
    });
  });
}

function servableOpenModel(modelId: string): OpenModel {
  const model = findModel(modelId);
  if (model === undefined) throw new ProxyError('unknown_model', MESSAGES.unknownModel);
  if (model.info.lane === 'private') throw new ProxyError('invalid_request', MESSAGES.sealedOnly);
  if (model.info.kind !== 'text') throw new ProxyError('invalid_request', MESSAGES.notChatModel);
  if (!model.info.available || model.openRouterSlug === null) {
    throw new ProxyError('model_unavailable', MESSAGES.modelUnavailable);
  }
  return { model, slug: model.openRouterSlug };
}

function chatChars(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}

function writeEvent(stream: SSEStreamingApi, event: ChatEvent): Promise<void> {
  return stream.writeSSE({ data: JSON.stringify(event) });
}
