// A chat of the modes ZDR and Open through the API (the owner, 1 Nov 2026: "ok gas bikin buat ZDR sama
// Open"). These models run outside a TEE, so a chat comes as plain JSON, which the proxy reads and
// sends to OpenRouter, as POST /api/chat does. The private lane stays encrypted only (decision 289).
//
// OpenRouter, read on 1 Nov 2026 (openrouter.ai/docs/api/reference/streaming.md and
// errors-and-debugging.md): it bills the complete answer of a chat with no stream, and of a stream
// at a provider that cannot cancel, however early the connection ends. So a chat runs to its end
// whether or not its caller stays, and pays what it spent. Measured the same day: a max_tokens above
// the limit of a model answers normally, a chat with no stream sends its headers before the model
// answers, and a failure after that comes as a 200 with only `error` in its body.
import { z } from 'zod';

import type { Balance, ChatTicket, Gate, Payer } from '../access/gate.js';
import { CREDIT } from '../config/credit.js';
import { INFERENCE } from '../config/inference.js';
import { MESSAGES } from '../config/messages.js';
import { OPENROUTER, providerPreferencesFor } from '../config/openrouter.js';
import { affordableOutputTokens, inputTokenEstimate } from '../credit/balance.js';
import { parseBody } from '../lib/body.js';
import { answerSpend } from '../lib/cost.js';
import { ProxyError, errorBody, upstreamStatusError } from '../lib/errors.js';
import type { LogLine } from '../lib/log.js';
import { dataValue, splitLines } from '../lib/sse.js';
import { UpstreamLifetime } from '../lib/upstream-lifetime.js';
import { spendOfUsage, usageSchema, type AnswerSpend } from '../openrouter/chunks.js';
import { postChatCompletion, type UpstreamDeps } from '../openrouter/stream.js';
import { plainChatRequestSchema, type PlainChatRequest } from './contract.js';
import { findPlainModel, isPrivateModelId, type PlainModel } from './models.js';

/** What Cloudflare passes on with its body, unlike a 502 or a 504: an error a caller can read. */
const UPSTREAM_FAILED_STATUS = 503;

/** A chat that OpenRouter refused for what it asks: what it says helps the caller, so it passes on. */
const REFUSED_FOR_THE_REQUEST: ReadonlySet<number> = new Set([400, 404, 413, 422]);

const RATE_LIMITED = 429;

const answerPartSchema = z.object({
  content: z.string().nullish(),
  reasoning: z.string().nullish(),
  tool_calls: z
    .array(z.object({ function: z.object({ arguments: z.string().nullish() }).nullish() }))
    .nullish(),
});

/**
 * What an answer of OpenRouter tells about what it spent. Each part stands alone, so that a choice in
 * a shape of its own never hides the usage beside it.
 */
const answerSchema = z.object({
  choices: z
    .array(z.object({ delta: answerPartSchema.nullish(), message: answerPartSchema.nullish() }))
    .nullish()
    .catch(null),
  usage: usageSchema.nullish().catch(null),
});

export interface PlainChatDeps extends UpstreamDeps {
  readonly gate: Gate;
  readonly log: LogLine;
  /** The chats running on each key. */
  readonly openChats: OpenChats;
}

/** Counts the chats running on each key. */
export interface OpenChats {
  /** Takes a place for one chat, or throws. The function that it returns gives the place back. */
  readonly enter: (balanceHash: string) => () => void;
}

export function createOpenChats(): OpenChats {
  const running = new Map<string, number>();
  return {
    enter(balanceHash) {
      const count = running.get(balanceHash) ?? 0;
      if (count >= INFERENCE.maxOpenChatsPerKey) {
        throw new ProxyError(
          'rate_limited',
          INFERENCE.messages.tooManyOpen(INFERENCE.maxOpenChatsPerKey),
        );
      }
      running.set(balanceHash, count + 1);
      return () => {
        const left = (running.get(balanceHash) ?? 1) - 1;
        if (left > 0) running.set(balanceHash, left);
        else running.delete(balanceHash);
      };
    },
  };
}

/** What a key pays for one chat, once the answer is over. */
interface AnswerMeter {
  readonly observe: (answer: unknown) => void;
  readonly settle: () => void;
}

/** One chat under way: where its answer comes from, and what follows it. */
interface OpenAnswer {
  readonly deps: PlainChatDeps;
  readonly body: ReadableStream<Uint8Array>;
  readonly meter: AnswerMeter;
  readonly lifetime: UpstreamLifetime;
  /** The id of the model that the caller named, which its answer names too. */
  readonly modelId: string;
}

/** The end of a chat with no stream: what the caller gets, or why the chat failed. */
type WholeOutcome =
  | { readonly ok: true; readonly answer: Record<string, unknown> }
  | { readonly ok: false; readonly error: ProxyError };

/**
 * One chat with a model of ZDR or Open, paid from the key of its caller. A chat whose answer never
 * started costs nothing. Every other chat pays what its usage reports, or else, for a usage that
 * never came, what it passed on, by the estimate of a reserve.
 */
export async function startPlainChat(
  deps: PlainChatDeps,
  caller: Payer & { readonly balance: Balance },
  body: unknown,
): Promise<Response> {
  const request = parseBody(plainChatRequestSchema, body);
  const served = servablePlainModel(request.model);
  assertVision(request, served);
  const inputUnits = JSON.stringify(body).length;
  const ticket = deps.gate.admit(caller, served.model, inputUnits);
  const upstreamBody = plainUpstreamBody(request, served, inputUnits, caller.balance.micros);
  const leave = deps.openChats.enter(caller.balance.hash);
  // No signal of the caller: leaving does not stop a chat, as the top of this file says.
  const lifetime = new UpstreamLifetime(new AbortController().signal, {
    firstByteMs: OPENROUTER.firstByteTimeoutMs,
    streamMs: OPENROUTER.streamTimeoutMs,
  });
  let answerBody: ReadableStream<Uint8Array>;
  try {
    answerBody = await openAnswer(deps, lifetime, upstreamBody);
  } catch (error) {
    lifetime.dispose();
    ticket.refund();
    leave();
    throw error;
  }
  const meter = answerMeter(deps.log, ticket, served, inputUnits, () => {
    lifetime.dispose();
    leave();
  });
  const answer: OpenAnswer = { deps, body: answerBody, meter, lifetime, modelId: served.id };
  return request.stream === true ? streamedResponse(answer) : wholeResponse(answer);
}

function servablePlainModel(id: string): PlainModel {
  if (isPrivateModelId(id)) {
    throw new ProxyError('invalid_request', INFERENCE.messages.privateEncrypted);
  }
  const served = findPlainModel(id);
  if (served === undefined) throw new ProxyError('unknown_model', INFERENCE.messages.modelUnknown);
  return served;
}

function assertVision(request: PlainChatRequest, { model }: PlainModel): void {
  if (model.info.vision) return;
  const hasImage = request.messages.some(
    ({ content }) => Array.isArray(content) && content.some((part) => part.type === 'image_url'),
  );
  if (hasImage) throw new ProxyError('invalid_request', MESSAGES.noVision);
}

/**
 * What goes to OpenRouter: the model and the privacy of the catalog, whatever the caller sent, the
 * fields of INFERENCE.plainChatFields, and an answer no longer than the credit of the key pays.
 */
function plainUpstreamBody(
  request: PlainChatRequest,
  { model, slug }: PlainModel,
  inputUnits: number,
  creditMicros: number,
): Record<string, unknown> {
  const fields = INFERENCE.plainChatFields.flatMap((name) =>
    request[name] === undefined ? [] : [[name, request[name]] as const],
  );
  return {
    ...Object.fromEntries(fields),
    model: slug,
    messages: request.messages,
    stream: request.stream === true,
    provider: providerPreferencesFor(model.info.privacy),
    tools: request.tools ?? undefined,
    max_tokens: longestAnswer(request, model, inputUnits, creditMicros) ?? undefined,
  };
}

/**
 * The longest answer: what the caller asks for, within what the credit of the key pays. A cap at the
 * context of the model or above changes nothing, so it stays out of the request.
 */
function longestAnswer(
  request: PlainChatRequest,
  model: PlainModel['model'],
  inputUnits: number,
  creditMicros: number,
): number | null {
  const asked = request.max_completion_tokens ?? request.max_tokens ?? null;
  const affordable = affordableOutputTokens(model, inputUnits, creditMicros);
  const cap = affordable !== null && affordable < model.info.contextTokens ? affordable : null;
  if (asked === null) return cap;
  return cap === null ? asked : Math.min(asked, cap);
}

/** Sends the chat. Throws an error for the caller when OpenRouter refuses it or cannot be reached. */
async function openAnswer(
  deps: PlainChatDeps,
  lifetime: UpstreamLifetime,
  body: Record<string, unknown>,
): Promise<ReadableStream<Uint8Array>> {
  try {
    const response = await lifetime.withFirstByteDeadline(() =>
      postChatCompletion(deps, body, lifetime.signal),
    );
    if (!response.ok) throw refusalOf(response.status, await upstreamMessage(response));
    if (response.body === null) throw new ProxyError('upstream_error', MESSAGES.upstreamUnreadable);
    return response.body;
  } catch (error) {
    throw readableByCaller(lifetime.errorFor(error));
  }
}

/** The message in the error body of OpenRouter, or null. Its other fields stay out. */
async function upstreamMessage(response: Response): Promise<string | null> {
  return messageOf(parseRecord(await response.text())?.error);
}

function messageOf(error: unknown): string | null {
  if (!isRecord(error) || typeof error.message !== 'string') return null;
  return error.message.slice(0, INFERENCE.maxUpstreamMessageChars);
}

/**
 * The error for a chat that OpenRouter refused. Its 401, 402, and 403 are about the key and the
 * credit of Thinkr, never about the caller, so their text stays out.
 */
function refusalOf(status: number, message: string | null): ProxyError {
  if (REFUSED_FOR_THE_REQUEST.has(status) && message !== null) {
    return new ProxyError('invalid_request', message);
  }
  if (status === RATE_LIMITED) return new ProxyError('rate_limited', MESSAGES.upstreamBusy);
  return upstreamStatusError(status);
}

/** An error of the upstream goes out with a status that Cloudflare leaves as it is. */
function readableByCaller(error: ProxyError): ProxyError {
  return error.status >= 500
    ? new ProxyError(error.code, error.message, UPSTREAM_FAILED_STATUS)
    : error;
}

/** What stopped an answer that had begun. */
function failureOf(lifetime: UpstreamLifetime): ProxyError {
  return lifetime.cause === 'stream-timeout'
    ? new ProxyError('upstream_timeout', MESSAGES.upstreamTimeout)
    : new ProxyError('upstream_error', MESSAGES.upstreamBroken);
}

function answerMeter(
  log: LogLine,
  ticket: ChatTicket,
  { model }: PlainModel,
  inputUnits: number,
  onSettled: () => void,
): AnswerMeter {
  let reported: AnswerSpend | null = null;
  let outputChars = 0;
  let settled = false;
  const pay = (): void => {
    if (reported !== null) {
      ticket.charge(answerSpend(reported.costUsd, reported.usage, model.cost));
    } else if (outputChars > 0) {
      const usage = {
        inputTokens: inputTokenEstimate(model, inputUnits),
        outputTokens: Math.ceil(outputChars / CREDIT.charsPerToken),
      };
      ticket.charge(answerSpend(null, usage, model.cost));
    } else {
      ticket.refund();
    }
  };
  return {
    observe(answer) {
      const parsed = answerSchema.safeParse(answer);
      if (!parsed.success) return;
      if (parsed.data.usage !== undefined && parsed.data.usage !== null) {
        reported = spendOfUsage(parsed.data.usage);
      }
      for (const choice of parsed.data.choices ?? []) {
        outputChars += partChars(choice.delta) + partChars(choice.message);
      }
    },
    settle() {
      if (settled) return;
      settled = true;
      try {
        pay();
      } catch (error) {
        log(`Internal error: ${errorName(error)}`);
      } finally {
        onSettled();
      }
    },
  };
}

function partChars(part: z.infer<typeof answerPartSchema> | null | undefined): number {
  if (part === undefined || part === null) return 0;
  const calls = part.tool_calls ?? [];
  return (
    (part.content?.length ?? 0) +
    (part.reasoning?.length ?? 0) +
    calls.reduce((sum, call) => sum + (call.function?.arguments?.length ?? 0), 0)
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/** An answer as the caller gets it: the id that it named, and only the fields of the API. */
function publicAnswer(answer: Record<string, unknown>, modelId: string): Record<string, unknown> {
  const kept: Record<string, unknown> = { ...pick(answer, INFERENCE.answerFields), model: modelId };
  if (isRecord(answer.usage)) kept.usage = pick(answer.usage, INFERENCE.usageFields);
  if (isRecord(answer.error)) kept.error = pick(answer.error, ['code', 'message']);
  return kept;
}

function pick(from: Record<string, unknown>, names: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(names.flatMap((name) => (name in from ? [[name, from[name]]] : [])));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON object in some text, or null for text of another shape. */
function parseRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * A stream whose text a task writes. It goes on when the caller leaves, and what it writes then goes
 * nowhere. An answer is small, so the stream can hold what a slow caller has not read yet.
 */
function writtenStream(
  log: LogLine,
  task: (write: (text: string) => void) => Promise<void>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let open = true;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string): void => {
        if (open) controller.enqueue(encoder.encode(text));
      };
      void task(write)
        .catch((error: unknown) => {
          log(`Internal error: ${errorName(error)}`);
        })
        .finally(() => {
          if (open) controller.close();
          open = false;
        });
    },
    cancel() {
      open = false;
    },
  });
}

/** Passes the events of an answer on as they come, comments and the end of the stream included. */
function streamedResponse(answer: OpenAnswer): Response {
  const { deps, meter, lifetime } = answer;
  const body = writtenStream(deps.log, async (write) => {
    try {
      await writeEvents(answer, write);
    } catch {
      const failure = failureOf(lifetime);
      deps.log(`Upstream failed: ${failure.message}`);
      write(`data: ${JSON.stringify(errorBody(failure.code, failure.message))}\n\n`);
    } finally {
      meter.settle();
    }
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

async function writeEvents(answer: OpenAnswer, write: (text: string) => void): Promise<void> {
  const reader = answer.body.pipeThrough(new TextDecoderStream()).getReader();
  let rest = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    const split = splitLines(rest + value);
    rest = split.rest;
    if (split.lines.length > 0) {
      write(split.lines.map((line) => `${publicLine(line, answer)}\n`).join(''));
    }
  }
}

/** A line of the stream as the caller gets it. Only a data line with a JSON object changes. */
function publicLine(line: string, { meter, modelId }: OpenAnswer): string {
  const data = dataValue(line);
  if (data === null || data === OPENROUTER.streamDoneData) return line;
  const parsed = parseRecord(data);
  if (parsed === null) return line;
  meter.observe(parsed);
  return `data: ${JSON.stringify(publicAnswer(parsed, modelId))}`;
}

/**
 * The answer of a chat with no stream. One that comes soon goes out with the status of its outcome.
 * Past that, the caller gets a 200 and spaces until the answer comes, and a failure then has only
 * `error` in its body, as OpenRouter does itself.
 */
async function wholeResponse(answer: OpenAnswer): Promise<Response> {
  const outcome = readWholeAnswer(answer);
  const soon = await soonOf(outcome);
  if (soon === null) return waitingResponse(answer.deps.log, outcome);
  if (soon.ok) return Response.json(soon.answer);
  throw soon.error;
}

/** Reads the whole answer and pays it. It never rejects. */
async function readWholeAnswer(answer: OpenAnswer): Promise<WholeOutcome> {
  const { meter, lifetime, modelId } = answer;
  try {
    const parsed = parseRecord(await new Response(answer.body).text());
    if (parsed === null) {
      const error = new ProxyError('upstream_error', MESSAGES.upstreamUnreadable);
      return { ok: false, error: readableByCaller(error) };
    }
    meter.observe(parsed);
    if (parsed.error === undefined || parsed.error === null) {
      return { ok: true, answer: publicAnswer(parsed, modelId) };
    }
    return { ok: false, error: readableByCaller(failureOfBody(parsed.error)) };
  } catch {
    return { ok: false, error: readableByCaller(failureOf(lifetime)) };
  } finally {
    meter.settle();
  }
}

/** The error for a body that says that its chat failed: a status, or a name of the provider's. */
function failureOfBody(error: unknown): ProxyError {
  const status = isRecord(error) ? error.code : null;
  return typeof status === 'number'
    ? refusalOf(status, messageOf(error))
    : new ProxyError('upstream_error', MESSAGES.upstreamStopped);
}

/** The outcome if it comes before the first space is due, or else null. */
async function soonOf(outcome: Promise<WholeOutcome>): Promise<WholeOutcome | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const due = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, INFERENCE.heartbeatMs);
  });
  try {
    return await Promise.race([outcome, due]);
  } finally {
    clearTimeout(timer);
  }
}

function waitingResponse(log: LogLine, outcome: Promise<WholeOutcome>): Response {
  const body = writtenStream(log, async (write) => {
    write(INFERENCE.heartbeat);
    const heartbeat = setInterval(() => {
      write(INFERENCE.heartbeat);
    }, INFERENCE.heartbeatMs);
    try {
      const end = await outcome;
      write(JSON.stringify(end.ok ? end.answer : errorBody(end.error.code, end.error.message)));
    } finally {
      clearInterval(heartbeat);
    }
  });
  return new Response(body, { headers: { 'Content-Type': 'application/json' } });
}
