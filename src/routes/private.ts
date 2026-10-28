// The private lane: GET /api/private/attestation passes the proof of the router to the browser,
// and POST the proof of the privacy filter; POST /api/private/v1/chat/completions forwards a sealed
// chat to its enclave (decision 64), and POST /api/private/v1/convert/file a sealed document to the
// document enclave (decision 142). Premium (the owner, 23 Oct 2026): POST
// /api/private/v1/audio/transcriptions and /api/private/v1/audio/speech forward a sealed recording
// or text to the audio models of the router, which a balance or, since 26 Oct 2026, the free trial
// pays, and POST /api/private/filter/redact a sealed message to the enclave of the privacy filter,
// which only a balance pays. Inference (routes/inference.ts) forwards its sealed chats through
// forwardSealedChat too, paid by the holder credit of an API key.
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { Fee, Gate, Payer, TrialTerms } from '../access/gate.js';
import type { PremiumPrice } from '../credit/balance.js';
import { findTeeModel } from '../catalog.js';
import { CREDIT } from '../config/credit.js';
import type { CatalogModel } from '../config/models.js';
import { MESSAGES } from '../config/messages.js';
import { SERVER } from '../config/server.js';
import { TINFOIL } from '../config/tinfoil.js';
import { readJson } from '../lib/body.js';
import { answerSpend } from '../lib/cost.js';
import { ProxyError, errorBody } from '../lib/errors.js';
import type { RateLimiter } from '../lib/rate-limit.js';
import { fetchAttestation, type AttestationDeps } from '../tinfoil/attestation.js';
import {
  CHAT_ROUTE,
  CONVERT_ROUTE,
  FILTER_ROUTE,
  SPEECH_ROUTE,
  TRANSCRIPTION_ROUTE,
  forwardSealed,
  parseEnclaveUrl,
  parseEncapsulatedKey,
  type SealedDeps,
  type SealedRequest,
  type SealedRoute,
} from '../tinfoil/sealed.js';
import type { UsageMetrics } from '../tinfoil/usage.js';

/** One document for the document enclave: its price for a balance, and its cost at Tinfoil. */
const DOCUMENT_FEE: Fee = {
  lane: 'private',
  priceUsd: CREDIT.documentUsd,
  costUsd: TINFOIL.fees.documentUsd,
};

/** A recording turned into text: what Tinfoil reports, less 25%, with no fixed price. */
const VOICE_INPUT_PRICE: PremiumPrice = {
  fixedUsd: CREDIT.voiceInputUsd,
  costShare: CREDIT.voiceInputCostShare,
};

/** A fixed price, or the reported cost plus 25% when that is more (decision 52). */
function fixedPremium(fixedUsd: number): PremiumPrice {
  return { fixedUsd, costShare: CREDIT.markup };
}

/**
 * Voice on the free trial (the owner, 26 Oct 2026): a recording needs a chat of the private lane
 * left for its answer, and a part to speak follows an answer that took its chat. Without a report
 * of the enclave, each counts the fee of Tinfoil against the budget of the lane.
 */
const VOICE_INPUT_TRIAL: TrialTerms = { costUsd: TINFOIL.fees.transcriptionUsd, needsChat: true };
const VOICE_REPLY_TRIAL: TrialTerms = { costUsd: TINFOIL.fees.speechUsd, needsChat: false };

export interface PrivateRouteDeps extends SealedDeps, AttestationDeps {
  readonly now: () => number;
  /** The key of the visitor, for the rate limit and the free trial. Never the address itself. */
  readonly clientKey: (c: Context) => string;
  /** Shared with POST /api/chat, so both lanes count against one limit. */
  readonly limiter: RateLimiter;
  /** Who pays: a balance, or the free trial. */
  readonly gate: Gate;
}

export function createPrivateRoute(deps: PrivateRouteDeps): Hono {
  return new Hono()
    .basePath(SERVER.privateLanePath)
    .get('/attestation', (c) => fetchAttestation(deps, c.req.raw.headers, c.req.raw.signal))
    .post('/attestation', sizeLimit(SERVER.maxBodyBytes), async (c) =>
      fetchAttestation(deps, c.req.raw.headers, c.req.raw.signal, await readJson(c)),
    )
    .post(TINFOIL.chatCompletionsPath, sealedChatLimit(), (c) =>
      forwardSealedChat(deps, c, async (visitor) => ({
        visitor,
        balance: await deps.gate.balanceOf(c),
      })),
    )
    .post(TINFOIL.convertFilePath, sizeLimit(SERVER.maxSealedFileBytes), async (c) => {
      const visitor = deps.clientKey(c);
      takeRequest(deps, visitor);
      const request = await readSealed(c, CONVERT_ROUTE, null);
      const balance = await deps.gate.balanceOf(c);
      const ticket = deps.gate.admitFee({ visitor, balance }, DOCUMENT_FEE);
      // The document is paid once its Markdown has passed whole to the browser.
      let converted = false;
      let response: Response;
      try {
        response = await forwardSealed(deps, request, c.req.raw.signal, () => {
          if (converted) ticket.charge();
        });
      } catch (error) {
        ticket.refund();
        throw error;
      }
      if (response.ok) converted = true;
      else ticket.refund();
      return response;
    })
    .post(TINFOIL.transcriptionPath, sizeLimit(SERVER.maxSealedAudioBytes), (c) =>
      forwardPremium(deps, c, TRANSCRIPTION_ROUTE, VOICE_INPUT_PRICE, VOICE_INPUT_TRIAL),
    )
    .post(TINFOIL.speechPath, sizeLimit(SERVER.maxBodyBytes), (c) =>
      forwardPremium(deps, c, SPEECH_ROUTE, fixedPremium(CREDIT.voiceReplyUsd), VOICE_REPLY_TRIAL),
    )
    .post(
      `${SERVER.privacyFilterPath}${TINFOIL.privacyFilter.redactPath}`,
      sizeLimit(SERVER.maxSealedFilterBytes),
      (c) =>
        forwardPremium(
          deps,
          c,
          FILTER_ROUTE,
          fixedPremium(CREDIT.privacyFilterUsd),
          undefined,
          TINFOIL.privacyFilter.enclaveUrl,
        ),
    );
}

/**
 * Who pays for one sealed chat, once its headers have passed: in the private lane, the balance that
 * the request names or else the free trial; in Inference, the holder credit of an API key.
 */
export type SealedChatPayer = (visitor: string) => Promise<Payer>;

/** The size limit of a sealed chat, which carries the photos and documents of the chat. */
export function sealedChatLimit(): ReturnType<typeof bodyLimit> {
  return sizeLimit(SERVER.maxSealedChatBytes);
}

/**
 * Forwards one sealed chat to its enclave (decision 64). Its payer pays once the answer has passed
 * whole, at the usage that the enclave reports, and pays nothing when the enclave fails first.
 */
export async function forwardSealedChat(
  deps: PrivateRouteDeps,
  c: Context,
  payerOf: SealedChatPayer,
): Promise<Response> {
  const visitor = deps.clientKey(c);
  takeRequest(deps, visitor);
  const { request, model } = await readSealedChat(c);
  const payer = await payerOf(visitor);
  const ticket = deps.gate.admit(payer, model, request.body.byteLength, {
    webSearch: request.events !== null,
  });
  // The usage comes once the sealed body has passed, after the status below is known.
  let answered = false;
  const onUsage = (metrics: UsageMetrics | null): void => {
    if (!answered) return;
    ticket.charge(
      answerSpend(
        metrics?.costUsd ?? null,
        metrics?.usage ?? null,
        model.cost,
        metrics?.webSearchCalls ?? 0,
      ),
    );
  };
  let response: Response;
  try {
    response = await forwardSealed(deps, request, c.req.raw.signal, onUsage);
  } catch (error) {
    ticket.refund();
    throw error;
  }
  // An EHBP problem, such as a rotated key, carries no answer: the SDK renews and asks again.
  if (response.ok) answered = true;
  else ticket.refund();
  return response;
}

/**
 * Forwards one Premium request, which a balance pays once its answer has passed whole: the price
 * of the route, or more when the enclave reports a higher cost. The free trial takes a request
 * with `trial` terms and is refused any other before the body is read. `enclave` names the one
 * enclave of a route that has its own.
 */
async function forwardPremium(
  deps: PrivateRouteDeps,
  c: Context,
  route: SealedRoute,
  price: PremiumPrice,
  trial?: TrialTerms,
  enclave?: string,
): Promise<Response> {
  const visitor = deps.clientKey(c);
  takeRequest(deps, visitor);
  const balance = await deps.gate.balanceOf(c);
  const ticket = deps.gate.admitPremium({ visitor, balance }, price, trial);
  let request: SealedRequest;
  try {
    request = await readSealed(c, route, null, enclave);
  } catch (error) {
    ticket.refund();
    throw error;
  }
  let answered = false;
  let response: Response;
  try {
    response = await forwardSealed(deps, request, c.req.raw.signal, (metrics) => {
      if (answered) ticket.charge(metrics?.costUsd ?? null);
    });
  } catch (error) {
    ticket.refund();
    throw error;
  }
  if (response.ok) answered = true;
  else ticket.refund();
  return response;
}

function sizeLimit(maxSize: number): ReturnType<typeof bodyLimit> {
  return bodyLimit({
    maxSize,
    onError: (c) => c.json(errorBody('invalid_request', MESSAGES.tooLarge), 413),
  });
}

/** Every route counts against the one rate limit of the lanes. */
function takeRequest(deps: PrivateRouteDeps, visitor: string): void {
  if (!deps.limiter.take(visitor, deps.now())) {
    throw new ProxyError('rate_limited', MESSAGES.rateLimited);
  }
}

async function readSealedChat(
  c: Context,
): Promise<{ request: SealedRequest; model: CatalogModel }> {
  const model = servableTeeModel(c.req.header(TINFOIL.headers.model));
  const request = await readSealed(c, CHAT_ROUTE, model.info.teeModelId ?? '');
  return {
    request: { ...request, events: parseEvents(c.req.header(TINFOIL.headers.events)) },
    model,
  };
}

async function readSealed(
  c: Context,
  route: SealedRoute,
  teeModelId: string | null,
  onlyEnclave?: string,
): Promise<SealedRequest> {
  const encapsulatedKey = parseEncapsulatedKey(c.req.header(TINFOIL.headers.encapsulatedKey));
  const enclave = parseEnclaveUrl(c.req.header(TINFOIL.headers.enclaveUrl), onlyEnclave);
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) throw new ProxyError('invalid_request', MESSAGES.notSealed);
  const contentType = c.req.header('Content-Type') ?? null;
  return { route, enclave, teeModelId, events: null, encapsulatedKey, contentType, body };
}

/** Only the events of web search go on: the progress of its searches inside the sealed answer. */
function parseEvents(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (value !== TINFOIL.webSearchEvents) {
    throw new ProxyError('invalid_request', MESSAGES.eventsNotAllowed);
  }
  return value;
}

function servableTeeModel(teeModelId: string | undefined): CatalogModel {
  if (teeModelId === undefined || teeModelId === '') {
    throw new ProxyError('invalid_request', MESSAGES.teeModelRequired);
  }
  const model = findTeeModel(teeModelId);
  if (model === undefined) throw new ProxyError('unknown_model', MESSAGES.unknownModel);
  if (!model.info.available) throw new ProxyError('model_unavailable', MESSAGES.modelUnavailable);
  return model;
}
