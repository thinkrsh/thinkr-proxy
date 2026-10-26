// Images and video of the open lane (the owner, 23 Oct 2026). POST /api/images makes one image
// and answers with it whole; an image counts as one chat of the free trial, and a balance pays its
// cost plus 25% (decision 52). POST /api/videos starts a video job, which only a balance pays,
// ahead, and answers with the ticket of the job; GET /api/videos/status follows the job and settles
// what the balance paid once it ends; GET /api/videos/content passes its video on. The ticket goes
// in the job header, so the log never holds it. POST /api/audio (26 Oct 2026) makes one piece of
// music, a voice that reads a text, or a sound, and answers with it whole, paid as an image is.
// A sourced video (decision 216, 26 Oct 2026) starts in two steps: POST /api/videos/sources holds
// its source, a video or a voice, for a few minutes; POST /api/videos/sourced starts its job, which
// a provider fetches the source for at GET /api/videos/sources/<name>, and follows as a video does.
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { Gate } from '../access/gate.js';
import {
  findAudioTools,
  findImageTools,
  findModel,
  findSourcedTools,
  findVideoTools,
} from '../catalog.js';
import { AUDIO } from '../config/audioTools.js';
import { MEDIA } from '../config/media.js';
import { MESSAGES } from '../config/messages.js';
import type {
  AudioSettings,
  CatalogModel,
  ImageSettings,
  SourcedSettings,
  VideoSettings,
} from '../config/models.js';
import { SERVER } from '../config/server.js';
import { SOURCED } from '../config/sourcedTools.js';
import {
  mediaRequestSchema,
  sourcedRequestSchema,
  type AudioResponse,
  type ImageResponse,
  type MediaRequest,
  type SourceResponse,
  type VideoJobResponse,
  type VideoStatusResponse,
} from '../contract.js';
import { mediaPriceUsd, usdToMicros, videoPriceMicros } from '../credit/balance.js';
import { parseBody, readJson } from '../lib/body.js';
import { answerSpend } from '../lib/cost.js';
import { ProxyError, errorBody } from '../lib/errors.js';
import type { RateLimiter } from '../lib/rate-limit.js';
import { chosenAudio, generateAudio, type AudioResult } from '../media/audio.js';
import { chosenImage, chosenVideo } from '../media/choice.js';
import { generateImage, type ImageResult } from '../media/image.js';
import { measureVideo, measureWav } from '../media/measure.js';
import { chosenSourced, sourcedUpstreamBody } from '../media/sourced.js';
import {
  createSourceStore,
  laterByTimer,
  type HeldSource,
  type SourceStore,
} from '../media/sources.js';
import { createTicketSealer, type JobClaims, type TicketSealer } from '../media/ticket.js';
import type { MediaPrompt } from '../media/upstream.js';
import { checkVideo, fetchVideo, submitVideo, submitVideoJob } from '../media/video.js';
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
  /**
   * The public HTTPS address of the proxy, where a provider fetches the source of a sourced video;
   * null on the laptop, where no sourced video starts.
   */
  readonly publicOrigin: string | null;
}

interface MediaModel<S> {
  readonly model: CatalogModel;
  readonly slug: string;
  readonly settings: S;
}

export function createMediaRoute(deps: MediaRouteDeps): Hono {
  const tickets = createTicketSealer(deps.ticketKey);
  const sources = createSourceStore({ now: deps.now, later: laterByTimer });
  const tooLarge = bodyLimit({
    maxSize: SERVER.maxMediaBodyBytes,
    onError: (c) => c.json(errorBody('invalid_request', MESSAGES.tooLarge), 413),
  });
  const sourceTooLarge = bodyLimit({
    maxSize: SOURCED.maxSourceBytes,
    onError: (c) => c.json(errorBody('invalid_request', MESSAGES.sourceTooLarge), 413),
  });

  return new Hono()
    .post(MEDIA.imagesPath, tooLarge, async (c) => c.json<ImageResponse>(await makeImage(deps, c)))
    .post(MEDIA.audioPath, tooLarge, async (c) => c.json<AudioResponse>(await makeAudio(deps, c)))
    .post(MEDIA.videosPath, tooLarge, async (c) =>
      c.json<VideoJobResponse>(await startVideo(deps, tickets, c), 202),
    )
    .get(MEDIA.videoStatusPath, async (c) =>
      c.json<VideoStatusResponse>(await followVideo(deps, tickets, sources, c)),
    )
    .get(MEDIA.videoContentPath, (c) => passVideo(deps, tickets, c))
    .post(SOURCED.sourcesPath, sourceTooLarge, async (c) =>
      c.json<SourceResponse>(await holdSource(deps, sources, c), 201),
    )
    .get(`${SOURCED.sourcesPath}/:name`, (c) => passSource(sources, c))
    .post(SOURCED.sourcedPath, tooLarge, async (c) =>
      c.json<VideoJobResponse>(await startSourced(deps, tickets, sources, c), 202),
    );
}

async function makeImage(deps: MediaRouteDeps, c: Context): Promise<ImageResponse> {
  const visitor = take(deps.limiter, deps, c);
  const request = parseBody(mediaRequestSchema, await readJson(c));
  if (asksVideoTools(request)) throw new ProxyError('invalid_request', MESSAGES.videoToolsOnly);
  if (request.voice !== undefined) throw new ProxyError('invalid_request', MESSAGES.voiceAudioOnly);
  const servable = servableImageModel(request.modelId);
  const { model, slug } = servable;
  const photos = photosOf(request);
  const chosen = chosenImage(servable.settings, findImageTools(model.info.id), {
    ...request,
    photoCount: photos.length,
  });
  const { settings, options } = chosen;
  const balance = await deps.gate.balanceOf(c);
  // A balance holds the price of the size and the photos picked, not that of the defaults.
  const ticket = deps.gate.admit(
    { visitor, balance },
    { ...model, media: settings },
    request.prompt.length,
    { webSearch: false, creditOnly: chosen.creditOnly },
  );
  let result: ImageResult;
  try {
    result = await generateImage(
      deps,
      { slug, privacy: model.info.privacy, settings, options },
      { text: request.prompt, photos },
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

async function makeAudio(deps: MediaRouteDeps, c: Context): Promise<AudioResponse> {
  const visitor = take(deps.limiter, deps, c);
  const request = parseBody(mediaRequestSchema, await readJson(c));
  if (asksPictureTools(request)) throw new ProxyError('invalid_request', MESSAGES.audioToolsOnly);
  const { model, slug, settings } = servableAudioModel(request.modelId);
  const tools = findAudioTools(model.info.id);
  const chosen = chosenAudio(settings, tools, { text: request.prompt, voice: request.voice });
  const balance = await deps.gate.balanceOf(c);
  // A balance holds the most that this request may cost: its text, or its longest audio.
  const ticket = deps.gate.admit(
    { visitor, balance },
    { ...model, media: chosen.settings },
    request.prompt.length,
    {
      webSearch: false,
      creditOnly: chosen.creditOnly,
      creditOnlyMessage: MESSAGES.voiceCreditOnly(AUDIO.trialChars),
    },
  );
  let result: AudioResult;
  try {
    result = await generateAudio(
      deps,
      { slug, privacy: model.info.privacy, settings, tools, voice: chosen.voice },
      request.prompt,
      c.req.raw.signal,
    );
  } catch (error) {
    ticket.refund();
    throw error;
  }
  ticket.charge(answerSpend(result.costUsd, null, null));
  return { audio: { dataUrl: result.dataUrl }, text: result.text };
}

async function startVideo(
  deps: MediaRouteDeps,
  tickets: TicketSealer,
  c: Context,
): Promise<VideoJobResponse> {
  const visitor = take(deps.limiter, deps, c);
  const request = parseBody(mediaRequestSchema, await readJson(c));
  if (asksImageTools(request)) throw new ProxyError('invalid_request', MESSAGES.imageToolsOnly);
  if (request.voice !== undefined) throw new ProxyError('invalid_request', MESSAGES.voiceAudioOnly);
  if (request.lastImage !== undefined && request.image === undefined) {
    throw new ProxyError('invalid_request', MESSAGES.lastFrameAlone);
  }
  const servable = servableVideoModel(request.modelId);
  const { model, slug } = servable;
  const settings = chosenVideo(servable.settings, findVideoTools(model.info.id), {
    ...request,
    lastFrame: request.lastImage !== undefined,
  });
  const balance = await deps.gate.balanceOf(c);
  const admitted = deps.gate.admitPrepaid(
    { visitor, balance },
    usdToMicros(mediaPriceUsd(settings)),
  );
  const jobId = await submitVideo(deps, { slug, settings }, promptOf(request), c.req.raw.signal);
  const prepayment = admitted.pay();
  return { ticket: await tickets.seal({ jobId, modelId: model.info.id, prepayment, held: [] }) };
}

/**
 * Holds the source of a sourced video, its raw bytes, once the proxy has read its length and its
 * frame. Only a balance holds one, or the laptop: a sourced video takes credit (decision 216).
 */
async function holdSource(
  deps: MediaRouteDeps,
  sources: SourceStore,
  c: Context,
): Promise<SourceResponse> {
  const visitor = take(deps.checkLimiter, deps, c);
  const balance = await deps.gate.balanceOf(c);
  // A price of nothing: this only refuses the free trial; the job pays when it starts.
  deps.gate.admitPrepaid({ visitor, balance }, 0, MESSAGES.sourcedCreditOnly);
  const type = (c.req.header('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const videoTypes: readonly string[] = SOURCED.videoTypes;
  const voice = type === SOURCED.voiceType;
  if (!voice && !videoTypes.includes(type)) {
    throw new ProxyError('invalid_request', MESSAGES.sourceType);
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const measured = voice ? measureWav(bytes) : measureVideo(bytes);
  if (measured === null) throw new ProxyError('invalid_request', MESSAGES.sourceUnreadable);
  const source = sources.hold({ ...measured, bytes, type });
  return { source, ...measured };
}

/** A source to the provider that fetches it, while the proxy holds it. */
function passSource(sources: SourceStore, c: Context): Response {
  const source = sources.get(c.req.param('name') ?? '');
  if (source === undefined) {
    return c.json(errorBody('invalid_request', MESSAGES.sourceGone), MEDIA.goneStatus);
  }
  return new Response(source.bytes, {
    status: 200,
    headers: {
      'Content-Type': source.type,
      'Content-Length': String(source.bytes.byteLength),
    },
  });
}

/**
 * Starts a sourced video job, which only a balance pays, ahead, at the estimate of its source, and
 * answers with the ticket of the job; the ticket names the sources, which go once the job ends.
 */
async function startSourced(
  deps: MediaRouteDeps,
  tickets: TicketSealer,
  sources: SourceStore,
  c: Context,
): Promise<VideoJobResponse> {
  const visitor = take(deps.limiter, deps, c);
  const request = parseBody(sourcedRequestSchema, await readJson(c));
  const { model, slug, settings } = servableSourcedModel(request.modelId);
  const origin = deps.publicOrigin;
  if (origin === null) throw new ProxyError('model_unavailable', MESSAGES.sourcedNoLink);
  const chosen = chosenSourced(settings, findSourcedTools(model.info.id), {
    ...request,
    video: heldSource(sources, request.video),
    voice: heldSource(sources, request.voice),
    image: request.image ?? null,
  });
  const balance = await deps.gate.balanceOf(c);
  const admitted = deps.gate.admitPrepaid(
    { visitor, balance },
    usdToMicros(mediaPriceUsd(chosen)),
    MESSAGES.sourcedCreditOnly,
  );
  const linkOf = (name: string | undefined): string | null =>
    name === undefined ? null : `${origin}${SERVER.basePath}${SOURCED.sourcesPath}/${name}`;
  const body = sourcedUpstreamBody(slug, settings, chosen, {
    video: linkOf(request.video),
    voice: linkOf(request.voice),
    image: request.image ?? null,
  });
  const jobId = await submitVideoJob(deps, body, c.req.raw.signal);
  const prepayment = admitted.pay();
  const held = [request.video, request.voice].filter((name) => name !== undefined);
  return { ticket: await tickets.seal({ jobId, modelId: model.info.id, prepayment, held }) };
}

/** The source of a name while the proxy holds it; null for a request that names none. */
function heldSource(sources: SourceStore, name: string | undefined): HeldSource | null {
  if (name === undefined) return null;
  const source = sources.get(name);
  if (source === undefined) throw new ProxyError('invalid_request', MESSAGES.sourceGone);
  return source;
}

async function followVideo(
  deps: MediaRouteDeps,
  tickets: TicketSealer,
  sources: SourceStore,
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
  // The provider has what it needed: the sources of a sourced video go now.
  for (const name of claims.held) sources.drop(name);
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

/** The prompt of a request of a video and its frames. */
function promptOf(request: MediaRequest): MediaPrompt {
  return {
    text: request.prompt,
    image: request.image ?? null,
    lastImage: request.lastImage ?? null,
  };
}

/** True when a request names a tool of the Image or the Video page, which audio takes none of. */
function asksPictureTools(request: MediaRequest): boolean {
  return (
    asksImageTools(request) ||
    asksVideoTools(request) ||
    [request.image, request.aspectRatio, request.seconds, request.resolution].some(
      (value) => value !== undefined,
    )
  );
}

/** True when a request names a tool of the Image page that a video takes none of. */
function asksImageTools(request: MediaRequest): boolean {
  return [request.images, request.seed, request.transparent].some((value) => value !== undefined);
}

/** True when a request names a tool of the Video page, which an image takes none of. */
function asksVideoTools(request: MediaRequest): boolean {
  return [request.lastImage, request.silent].some((value) => value !== undefined);
}

/** The photos of a request of an image: several, one, or none. */
function photosOf(request: MediaRequest): string[] {
  if (request.images !== undefined) return request.images;
  return request.image === undefined ? [] : [request.image];
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

function servableSourcedModel(modelId: string): MediaModel<SourcedSettings> {
  const { model, slug } = servableMediaModel(modelId);
  if (model.media?.kind !== 'sourcedVideo') {
    throw new ProxyError('invalid_request', MESSAGES.notSourcedModel);
  }
  return { model, slug, settings: model.media };
}

function servableAudioModel(modelId: string): MediaModel<AudioSettings> {
  const { model, slug } = servableMediaModel(modelId);
  if (model.media?.kind !== 'audio') {
    throw new ProxyError('invalid_request', MESSAGES.notAudioModel);
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
