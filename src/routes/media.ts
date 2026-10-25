// Images and video of the open lane (the owner, 23 Oct 2026). POST /api/images makes one image
// and answers with it whole; an image counts as one chat of the free trial, and a balance pays its
// cost plus 25% (decision 52). POST /api/videos starts a video job, which only a balance pays,
// ahead, and answers with the ticket of the job; GET /api/videos/status follows the job and settles
// what the balance paid once it ends; GET /api/videos/content passes its video on. The ticket goes
// in the job header, so the log never holds it.
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { Gate } from '../access/gate.js';
import { findModel } from '../catalog.js';
import { MEDIA } from '../config/media.js';
import { MESSAGES } from '../config/messages.js';
import type { CatalogModel, ImageSettings, VideoSettings } from '../config/models.js';
import { SERVER } from '../config/server.js';
import {
  mediaRequestSchema,
  type ImageResponse,
  type MediaRequest,
  type VideoJobResponse,
  type VideoStatusResponse,
} from '../contract.js';
import { mediaPriceUsd, usdToMicros, videoPriceMicros } from '../credit/balance.js';
import { parseBody, readJson } from '../lib/body.js';
import { answerSpend } from '../lib/cost.js';
import { ProxyError, errorBody } from '../lib/errors.js';
import type { RateLimiter } from '../lib/rate-limit.js';
import { chosenImage, chosenVideo } from '../media/choice.js';
import { generateImage, type ImageResult } from '../media/image.js';
import { createTicketSealer, type JobClaims, type TicketSealer } from '../media/ticket.js';
import type { MediaPrompt } from '../media/upstream.js';
import { checkVideo, fetchVideo, submitVideo } from '../media/video.js';
import type { UpstreamDeps } from '../openrouter/stream.js';

export interface MediaRouteDeps extends UpstreamDeps {
  readonly now: () => number;
  /** The key of the visitor, for the rate limits and the free trial. Never the address itself. */
  readonly clientKey: (c: Context) => string;
  /** The limit of chats, shared with both lanes: a new image or video counts against it. */
  readonly limiter: RateLimiter;
  /** The limit of the checks of video jobs and of their downloads. */
  readonly checkLimiter: RateLimiter;
  /** Who pays: a balance, or the free trial. */
  readonly gate: Gate;
  /** The secret that seals the tickets of video jobs, `MEDIA.ticket.keyBytes` long. */
  readonly ticketKey: Uint8Array;
}

interface MediaModel<S> {
  readonly model: CatalogModel;
  readonly slug: string;
  readonly settings: S;
}

export function createMediaRoute(deps: MediaRouteDeps): Hono {
  const tickets = createTicketSealer(deps.ticketKey);
  const tooLarge = bodyLimit({
    maxSize: SERVER.maxMediaBodyBytes,
    onError: (c) => c.json(errorBody('invalid_request', MESSAGES.tooLarge), 413),
  });

  return new Hono()
    .post(MEDIA.imagesPath, tooLarge, async (c) => c.json<ImageResponse>(await makeImage(deps, c)))
    .post(MEDIA.videosPath, tooLarge, async (c) =>
      c.json<VideoJobResponse>(await startVideo(deps, tickets, c), 202),
    )
    .get(MEDIA.videoStatusPath, async (c) =>
      c.json<VideoStatusResponse>(await followVideo(deps, tickets, c)),
    )
    .get(MEDIA.videoContentPath, (c) => passVideo(deps, tickets, c));
}

async function makeImage(deps: MediaRouteDeps, c: Context): Promise<ImageResponse> {
  const visitor = take(deps.limiter, deps, c);
  const request = parseBody(mediaRequestSchema, await readJson(c));
  const servable = servableImageModel(request.modelId);
  const { model, slug } = servable;
  const settings = chosenImage(servable.settings, request);
  const balance = await deps.gate.balanceOf(c);
  const ticket = deps.gate.admit({ visitor, balance }, model, request.prompt.length);
  let result: ImageResult;
  try {
    result = await generateImage(
      deps,
      { slug, privacy: model.info.privacy, settings },
      promptOf(request),
      c.req.raw.signal,
    );
  } catch (error) {
    ticket.refund();
    throw error;
  }
  const drew = result.dataUrls.length > 0;
  if (!drew && result.text.trim() === '') {
    ticket.refund();
    throw new ProxyError('upstream_error', MESSAGES.noImage, MEDIA.upstreamFailureStatus);
  }
  // Without a reported cost, an image costs its estimate; an answer of text alone, nothing.
  const fallbackUsd = drew ? settings.costUsd : 0;
  ticket.charge(answerSpend(result.costUsd ?? fallbackUsd, result.usage, null));
  return { images: result.dataUrls.map((dataUrl) => ({ dataUrl })), text: result.text };
}

async function startVideo(
  deps: MediaRouteDeps,
  tickets: TicketSealer,
  c: Context,
): Promise<VideoJobResponse> {
  const visitor = take(deps.limiter, deps, c);
  const request = parseBody(mediaRequestSchema, await readJson(c));
  const servable = servableVideoModel(request.modelId);
  const { model, slug } = servable;
  const settings = chosenVideo(servable.settings, request);
  const balance = await deps.gate.balanceOf(c);
  const admitted = deps.gate.admitPrepaid(
    { visitor, balance },
    usdToMicros(mediaPriceUsd(settings)),
  );
  const jobId = await submitVideo(deps, { slug, settings }, promptOf(request), c.req.raw.signal);
  const prepayment = admitted.pay();
  return { ticket: await tickets.seal({ jobId, modelId: model.info.id, prepayment }) };
}

async function followVideo(
  deps: MediaRouteDeps,
  tickets: TicketSealer,
  c: Context,
): Promise<VideoStatusResponse> {
  take(deps.checkLimiter, deps, c);
  const claims = await claimsOf(tickets, c);
  const state = await checkVideo(deps, claims.jobId, c.req.raw.signal);
  if (state.status === 'pending') return { status: 'pending', message: null };
  const paid = claims.prepayment;
  // A failed job gives back all it paid; a finished one pays its cost plus 25% (decision 52).
  const finalMicros = state.status === 'failed' ? 0 : videoPriceMicros(state.costUsd, paid.micros);
  await deps.gate.settleJob(claims.jobId, paid, finalMicros);
  return { status: state.status, message: state.reason };
}

async function passVideo(
  deps: MediaRouteDeps,
  tickets: TicketSealer,
  c: Context,
): Promise<Response> {
  take(deps.checkLimiter, deps, c);
  const claims = await claimsOf(tickets, c);
  const upstream = await fetchVideo(deps, claims.jobId, c.req.raw.signal);
  const headers = new Headers({
    'Content-Type': upstream.headers.get('Content-Type') ?? MEDIA.videoContentType,
  });
  const length = upstream.headers.get('Content-Length');
  if (length !== null) headers.set('Content-Length', length);
  return new Response(upstream.body, { status: 200, headers });
}

/** The prompt of a request and its photo. */
function promptOf(request: MediaRequest): MediaPrompt {
  return { text: request.prompt, image: request.image ?? null };
}

/** Counts one request of the visitor against a limit, or throws; returns the key of the visitor. */
function take(limiter: RateLimiter, deps: MediaRouteDeps, c: Context): string {
  const visitor = deps.clientKey(c);
  if (!limiter.take(visitor, deps.now())) {
    throw new ProxyError('rate_limited', MESSAGES.rateLimited);
  }
  return visitor;
}

async function claimsOf(tickets: TicketSealer, c: Context): Promise<JobClaims> {
  const ticket = c.req.header(MEDIA.ticketHeader);
  if (ticket === undefined || ticket === '') {
    throw new ProxyError('invalid_request', MESSAGES.ticketMissing);
  }
  return tickets.open(ticket);
}

function servableImageModel(modelId: string): MediaModel<ImageSettings> {
  const { model, slug } = servableMediaModel(modelId);
  if (model.media?.kind !== 'image') {
    throw new ProxyError('invalid_request', MESSAGES.notImageModel);
  }
  return { model, slug, settings: model.media };
}

function servableVideoModel(modelId: string): MediaModel<VideoSettings> {
  const { model, slug } = servableMediaModel(modelId);
  if (model.media?.kind !== 'video') {
    throw new ProxyError('invalid_request', MESSAGES.notVideoModel);
  }
  return { model, slug, settings: model.media };
}

function servableMediaModel(modelId: string): { model: CatalogModel; slug: string } {
  const model = findModel(modelId);
  if (model === undefined) throw new ProxyError('unknown_model', MESSAGES.unknownModel);
  if (!model.info.available || model.openRouterSlug === null) {
    throw new ProxyError('model_unavailable', MESSAGES.modelUnavailable);
  }
  return { model, slug: model.openRouterSlug };
}
