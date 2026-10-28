// Maps the chat completion stream of OpenRouter to the ChatEvent values of the contract.
// Stream format read on 20 Oct 2026: openrouter.ai/docs/api_reference/streaming.md (keep-alive
// comments, the final usage chunk, errors mid-stream) and
// openrouter.ai/docs/guides/best-practices/reasoning-tokens.md (delta.reasoning, delta.reasoning_details).
// The usage of the last chunk carries the cost of the answer in credits, which are USD
// (openrouter.ai/docs/use-cases/usage-accounting, read 20 Oct 2026). With web search (29 Oct
// 2026), the pages found come as `url_citation` annotations, and the usage counts the searches
// (config/webSearch.ts).
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

const URL_CITATION = 'url_citation';
const WEB_PROTOCOLS: readonly string[] = ['https:', 'http:'];

/** A page that a search found. Its excerpts stay out: the app shows the page, not what it says. */
const annotationSchema = z.object({
  type: z.string(),
  url_citation: z.object({ url: z.string(), title: z.string().nullish() }).nullish(),
});

const deltaSchema = z.object({
  content: z.string().nullish(),
  reasoning: z.string().nullish(),
  reasoning_details: z.array(reasoningDetailSchema).nullish(),
  annotations: z.array(annotationSchema).nullish(),
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
      server_tool_use_details: z
        .object({ web_search_requests: z.number().int().nonnegative().nullish() })
        .nullish(),
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
  /** The searches of the web that the answer ran (29 Oct 2026). */
  readonly webSearches: number;
}

interface StreamProgress {
  finishReason: string | null;
  usage: ChatUsage | null;
  costUsd: number | null;
  webSearches: number;
  /** The end of the text so far, or null before any text. */
  textEnd: string | null;
  /** The pages of a search came after some text, so the next text starts a new paragraph. */
  breakDue: boolean;
}

const PARAGRAPH_BREAK = '\n\n';

/**
 * Yields the events of one answer. The last event is always 'done' or 'error'. Before 'done',
 * `onSpend` gets what the answer used.
 */
export async function* readChatEvents(
  body: ReadableStream<Uint8Array>,
  onSpend: (spend: AnswerSpend) => void,
): AsyncGenerator<ChatEvent> {
  const progress: StreamProgress = {
    finishReason: null,
    usage: null,
    costUsd: null,
    webSearches: 0,
    textEnd: null,
    breakDue: false,
  };
  for await (const data of readSseData(body)) {
    if (data === OPENROUTER.streamDoneData) {
      yield* finish(progress, onSpend);
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
    yield* textEvents(chunk, progress);
    recordProgress(progress, chunk);
  }
  if (progress.finishReason === null) yield upstreamError(MESSAGES.upstreamEndedEarly);
  else yield* finish(progress, onSpend);
}

/** The end of a whole answer: what it used goes to `onSpend`, then how often it searched, then done. */
function* finish(
  progress: StreamProgress,
  onSpend: (spend: AnswerSpend) => void,
): Generator<ChatEvent> {
  const { usage, costUsd, webSearches } = progress;
  onSpend({ usage, costUsd, webSearches });
  if (webSearches > 0) yield { type: 'searched', count: webSearches };
  yield doneEvent(progress);
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

function* textEvents(chunk: UpstreamChunk, progress: StreamProgress): Generator<ChatEvent> {
  const delta = chunk.choices?.[0]?.delta;
  if (delta === undefined || delta === null) return;
  const reasoning = reasoningText(delta);
  if (reasoning !== '') yield { type: 'reasoning', text: reasoning };
  const content = delta.content ?? '';
  if (content !== '') yield { type: 'delta', text: afterSearch(progress, content) };
  const sources = [...sourceEvents(delta)];
  if (sources.length > 0 && progress.textEnd !== null) progress.breakDue = true;
  yield* sources;
}

/**
 * A text that follows the pages of a search starts a new paragraph (29 Oct 2026): the model writes
 * on after its search with no break, so the two texts would run together.
 */
function afterSearch(progress: StreamProgress, content: string): string {
  const joined = progress.textEnd?.endsWith('\n') === true || content.startsWith('\n');
  const text = progress.breakDue && !joined ? `${PARAGRAPH_BREAK}${content}` : content;
  progress.breakDue = false;
  progress.textEnd = content;
  return text;
}

/** The pages that the searches of an answer found, each a page of the web and nothing else. */
function* sourceEvents(delta: UpstreamDelta): Generator<ChatEvent> {
  for (const annotation of delta.annotations ?? []) {
    const citation = annotation.url_citation;
    if (annotation.type !== URL_CITATION || !citation || !isWebUrl(citation.url)) continue;
    yield { type: 'source', url: citation.url, title: citation.title ?? '' };
  }
}

function isWebUrl(url: string): boolean {
  const parsed = URL.parse(url);
  return parsed !== null && WEB_PROTOCOLS.includes(parsed.protocol);
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
    progress.webSearches = chunk.usage.server_tool_use_details?.web_search_requests ?? 0;
  }
}

function doneEvent(progress: StreamProgress): ChatEvent {
  return { type: 'done', finishReason: progress.finishReason, usage: progress.usage };
}

function upstreamError(message: string): ChatEvent {
  return { type: 'error', code: 'upstream_error', message };
}
