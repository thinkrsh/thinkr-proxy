// A sourced video (decision 216, 26 Oct 2026): what a request picks, checked against the tools of
// its model in config/sourcedTools.ts; what it costs at the provider, about; and the body of its job
// at OpenRouter. The source video or voice goes as an HTTPS link to the proxy itself, the only way
// OpenRouter takes them; the photo of a talking photo goes as a data URL, as the photos of the
// Image page do. Format read on 26 Oct 2026 from
// openrouter.ai/docs/api/api-reference/video-generation/submit-a-video-generation-request.md
// (`input_references`, `upscale_factor`, `creativity`).
import { MESSAGES } from '../config/messages.js';
import type { SourcedSettings } from '../config/models.js';
import { SOURCED, type SourcedTools } from '../config/sourcedTools.js';
import { ProxyError } from '../lib/errors.js';
import type { HeldSource } from './sources.js';

/** What a request of a sourced video brings and picks. */
export interface SourcedPicks {
  readonly prompt: string;
  readonly video: HeldSource | null;
  readonly voice: HeldSource | null;
  /** The photo of a talking photo, as a data URL. */
  readonly image: string | null;
  readonly factor?: number | undefined;
  readonly creative?: boolean | undefined;
  readonly aspectRatio?: string | undefined;
  readonly resolution?: string | undefined;
}

/** One sourced video as its request picked it, with its cost at the provider, about. */
export interface ChosenSourced {
  readonly prompt: string;
  /** The factor of an upscale; null for every other mode. */
  readonly factor: number | null;
  readonly creative: boolean;
  /** The shape and the resolution of a talking photo; null for every other mode. */
  readonly aspectRatio: string | null;
  readonly resolution: string | null;
  readonly costUsd: number;
}

/** How far past its longest a source may run, for a length that rounds up in its file. */
const SECONDS_TOLERANCE = 0.05;

/** One sourced video at the picks of its request, or throws when they do not fit its model. */
export function chosenSourced(
  settings: SourcedSettings,
  tools: SourcedTools,
  picks: SourcedPicks,
): ChosenSourced {
  const prompt = picks.prompt.trim();
  if (tools.promptRequired && prompt === '') throw invalid(MESSAGES.sourcedPromptEmpty);
  const source = sourceOf(settings, picks);
  if (source.seconds < tools.minSeconds) throw invalid(MESSAGES.sourceTooShort(tools.minSeconds));
  if (source.seconds > tools.maxSeconds + SECONDS_TOLERANCE) {
    throw invalid(MESSAGES.sourceTooLong(tools.maxSeconds));
  }
  const pixels = (source.width ?? 0) * (source.height ?? 0);
  if (tools.maxSourcePixels !== null && pixels > tools.maxSourcePixels) {
    throw invalid(MESSAGES.sourceTooBig);
  }
  const factor = pickFrom(tools.factors, picks.factor, MESSAGES.factorUnavailable);
  if (picks.creative === true && settings.rate.creativeUsd === null) {
    throw invalid(MESSAGES.creativeUnavailable);
  }
  const creative = picks.creative === true;
  const aspectRatio = pickFrom(tools.aspectRatios, picks.aspectRatio, MESSAGES.shapeUnavailable);
  const resolution = pickFrom(tools.resolutions, picks.resolution, MESSAGES.sizeUnavailable);
  return {
    prompt: settings.mode === 'talk' && prompt === '' ? SOURCED.talkPrompt : prompt,
    factor,
    creative,
    aspectRatio,
    resolution,
    costUsd: sourcedCostUsd(settings, tools, { ...source, factor, creative }),
  };
}

/**
 * What a sourced video costs at the provider, about: each second of its source at the rate of its
 * model, or for an upscale each megapixel of each second that comes out, but never less than the
 * least of the provider.
 */
export function sourcedCostUsd(
  settings: Pick<SourcedSettings, 'rate' | 'minUsd'>,
  tools: Pick<SourcedTools, 'maxOutputPixels'>,
  source: {
    readonly seconds: number;
    readonly width: number | null;
    readonly height: number | null;
    readonly factor: number | null;
    readonly creative: boolean;
  },
): number {
  const { rate } = settings;
  const perUnit = source.creative ? (rate.creativeUsd ?? rate.usd) : rate.usd;
  let units = source.seconds;
  if (rate.per === 'megapixelSecond') {
    const factor = source.factor ?? 1;
    const pixels = (source.width ?? 0) * (source.height ?? 0) * factor * factor;
    units = (Math.min(pixels, tools.maxOutputPixels ?? pixels) / MEGAPIXEL) * source.seconds;
  }
  return Math.max(units * perUnit, settings.minUsd);
}

const MEGAPIXEL = 1_000_000;

/** One reference of a job: the source video or voice as a link, or the photo as a data URL. */
type Reference =
  | { type: 'video_url'; video_url: { url: string } }
  | { type: 'audio_url'; audio_url: { url: string } }
  | { type: 'image_url'; image_url: { url: string } };

/** The JSON body of a sourced video job. It names no user and no app. */
export interface SourcedUpstreamBody {
  model: string;
  prompt?: string;
  input_references: Reference[];
  upscale_factor?: number;
  /** 0 for the precise mode of an upscale, 1 for the creative one. */
  creativity?: 0 | 1;
  aspect_ratio?: string;
  resolution?: string;
}

/** The links that a job names: the source at the proxy, and the photo of a talking photo. */
export interface SourcedLinks {
  readonly video: string | null;
  readonly voice: string | null;
  readonly image: string | null;
}

export function sourcedUpstreamBody(
  slug: string,
  settings: Pick<SourcedSettings, 'mode'>,
  chosen: ChosenSourced,
  links: SourcedLinks,
): SourcedUpstreamBody {
  const references: Reference[] = [];
  if (links.image !== null) references.push({ type: 'image_url', image_url: { url: links.image } });
  if (links.video !== null) references.push({ type: 'video_url', video_url: { url: links.video } });
  if (links.voice !== null) references.push({ type: 'audio_url', audio_url: { url: links.voice } });
  const body: SourcedUpstreamBody = {
    model: slug,
    ...(chosen.prompt === '' ? {} : { prompt: chosen.prompt }),
    input_references: references,
  };
  if (settings.mode === 'upscale' && chosen.factor !== null) {
    return { ...body, upscale_factor: chosen.factor, creativity: chosen.creative ? 1 : 0 };
  }
  if (settings.mode === 'talk') {
    return {
      ...body,
      ...(chosen.aspectRatio === null ? {} : { aspect_ratio: chosen.aspectRatio }),
      ...(chosen.resolution === null ? {} : { resolution: chosen.resolution }),
    };
  }
  return body;
}

/** The source that the mode of the model needs, of the right kind, or throws. */
function sourceOf(settings: Pick<SourcedSettings, 'mode'>, picks: SourcedPicks): HeldSource {
  if (settings.mode === 'talk') {
    if (picks.voice === null || picks.image === null) throw invalid(MESSAGES.sourceVoiceNeeded);
    if (picks.video !== null || picks.voice.type !== SOURCED.voiceType) {
      throw invalid(MESSAGES.sourceWrongKind);
    }
    return picks.voice;
  }
  if (picks.video === null) throw invalid(MESSAGES.sourceVideoNeeded);
  const videoTypes: readonly string[] = SOURCED.videoTypes;
  if (picks.voice !== null || picks.image !== null || !videoTypes.includes(picks.video.type)) {
    throw invalid(MESSAGES.sourceWrongKind);
  }
  return picks.video;
}

/** The option picked, or the default (the first); null for a model with no options of the kind. */
function pickFrom<T>(options: readonly T[], picked: T | undefined, message: string): T | null {
  if (options.length === 0) {
    if (picked !== undefined) throw invalid(message);
    return null;
  }
  if (picked === undefined) return options[0] ?? null;
  if (!options.includes(picked)) throw invalid(message);
  return picked;
}

function invalid(message: string): ProxyError {
  return new ProxyError('invalid_request', message);
}
