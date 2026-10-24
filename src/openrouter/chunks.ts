// Maps the chat completion stream of OpenRouter to the ChatEvent values of the contract.
// Stream format read on 20 Oct 2026: openrouter.ai/docs/api_reference/streaming.md (keep-alive
// comments, the final usage chunk, errors mid-stream) and
// openrouter.ai/docs/guides/best-practices/reasoning-tokens.md (delta.reasoning, delta.reasoning_details).
// The usage of the last chunk carries the cost of the answer in credits, which are USD
// (openrouter.ai/docs/use-cases/usage-accounting, read 20 Oct 2026).
import { z } from 'zod';

import { MESSAGES } from '../config/messages.js';
import { OPENROUTER } from '../config/openrouter.js';
import type { ChatEvent, ChatUsage } from '../contract.js';
import { readSseData } from '../lib/sse.js';

const reasoningDetailSchema = z.object({
  type: z.string().nullish(),
  text: z.string().nullish(),
  summary: z.string().nullish(),
});

const deltaSchema = z.object({
  content: z.string().nullish(),
  reasoning: z.string().nullish(),
  reasoning_details: z.array(reasoningDetailSchema).nullish(),
});

const chunkSchema = z.object({
  error: z.unknown().optional(),
  choices: z
    .array(z.object({ delta: deltaSchema.nullish(), finish_reason: z.string().nullish() }))
    .nullish(),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      cost: z.number().nonnegative().nullish(),
    })
    .nullish(),
});

type UpstreamChunk = z.infer<typeof chunkSchema>;
type UpstreamDelta = z.infer<typeof deltaSchema>;

/** What one finished answer used, for the daily budget of the free trial (decision 67). */
export interface AnswerSpend {
  readonly usage: ChatUsage | null;
  /** The cost that OpenRouter reported, in USD, or null without one. */
  readonly costUsd: number | null;
}

interface StreamProgress {
  finishReason: string | null;
  usage: ChatUsage | null;
  costUsd: number | null;
}

/**
 * Yields the events of one answer. The last event is always 'done' or 'error'. Before 'done',
 * `onSpend` gets what the answer used.
 */
export async function* readChatEvents(
  body: ReadableStream<Uint8Array>,
  onSpend: (spend: AnswerSpend) => void,
): AsyncGenerator<ChatEvent> {
  const progress: StreamProgress = { finishReason: null, usage: null, costUsd: null };
  for await (const data of readSseData(body)) {
    if (data === OPENROUTER.streamDoneData) {
      yield finish(progress, onSpend);
      return;
    }
    const chunk = parseChunk(data);
    if (chunk === null) {
      yield upstreamError(MESSAGES.upstreamUnreadable);
      return;
    }
    if (chunk.error !== undefined && chunk.error !== null) {
      yield upstreamError(MESSAGES.upstreamStopped);
      return;
    }
    yield* textEvents(chunk);
    recordProgress(progress, chunk);
  }
  yield progress.finishReason === null
    ? upstreamError(MESSAGES.upstreamEndedEarly)
    : finish(progress, onSpend);
}

function finish(progress: StreamProgress, onSpend: (spend: AnswerSpend) => void): ChatEvent {
  onSpend({ usage: progress.usage, costUsd: progress.costUsd });
  return doneEvent(progress);
}

function parseChunk(data: string): UpstreamChunk | null {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const result = chunkSchema.safeParse(json);
  return result.success ? result.data : null;
}

function* textEvents(chunk: UpstreamChunk): Generator<ChatEvent> {
  const delta = chunk.choices?.[0]?.delta;
  if (delta === undefined || delta === null) return;
  const reasoning = reasoningText(delta);
  if (reasoning !== '') yield { type: 'reasoning', text: reasoning };
  const content = delta.content ?? '';
  if (content !== '') yield { type: 'delta', text: content };
}

/** delta.reasoning carries the plain text; reasoning_details repeats it, so it is the fallback. */
function reasoningText(delta: UpstreamDelta): string {
  if (delta.reasoning !== undefined && delta.reasoning !== null && delta.reasoning !== '') {
    return delta.reasoning;
  }
  return (delta.reasoning_details ?? [])
    .map((detail) => detail.text ?? detail.summary ?? '')
    .join('');
}

function recordProgress(progress: StreamProgress, chunk: UpstreamChunk): void {
  const finishReason = chunk.choices?.[0]?.finish_reason;
  if (finishReason !== undefined && finishReason !== null) progress.finishReason = finishReason;
  if (chunk.usage !== undefined && chunk.usage !== null) {
    progress.usage = {
      inputTokens: chunk.usage.prompt_tokens,
      outputTokens: chunk.usage.completion_tokens,
    };
    progress.costUsd = chunk.usage.cost ?? null;
  }
}

function doneEvent(progress: StreamProgress): ChatEvent {
  return { type: 'done', finishReason: progress.finishReason, usage: progress.usage };
}

function upstreamError(message: string): ChatEvent {
  return { type: 'error', code: 'upstream_error', message };
}
