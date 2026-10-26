// Video jobs on OpenRouter (the owner, 23 Oct 2026): submit a job, check where it stands, and pass
// its video on. Video runs at the level Open: OpenRouter routes no video job under zero data
// retention, so the request carries no provider preferences. Format read on 23 Oct 2026:
// openrouter.ai/docs/guides/overview/multimodal/video-generation.md.
import { z } from 'zod';

import { MEDIA } from '../config/media.js';
import { MESSAGES } from '../config/messages.js';
import type { VideoSettings } from '../config/models.js';
import { OPENROUTER } from '../config/openrouter.js';
import type { VideoStatus } from '../contract.js';
import type { UpstreamDeps } from '../openrouter/stream.js';
import { callOpenRouter, mediaUpstreamError, type MediaPrompt } from './upstream.js';

/** The model of a video, as OpenRouter knows it. */
export interface VideoTarget {
  readonly slug: string;
  readonly settings: VideoSettings;
}

/** The JSON body of a new job. It names no user and no app. */
export interface VideoUpstreamBody {
  model: string;
  prompt: string;
  duration: number;
  resolution: string;
  aspect_ratio: string;
  generate_audio: boolean;
  /** The photos that the video starts from and ends on, when the user gave them. */
  frame_images?: {
    type: 'image_url';
    image_url: { url: string };
    frame_type: 'first_frame' | 'last_frame';
  }[];
}

type FrameImage = NonNullable<VideoUpstreamBody['frame_images']>[number];

/** Where a job stands, the cost that OpenRouter reported once it ended, and why it failed. */
export interface VideoJobState {
  readonly status: VideoStatus;
  readonly costUsd: number | null;
  readonly reason: string | null;
}

const submittedSchema = z.object({ id: z.string().min(1) });

const jobSchema = z.object({
  status: z.string(),
  usage: z.object({ cost: z.number().nonnegative().nullish() }).nullish(),
  error: z.string().nullish(),
});

export function videoUpstreamBody(target: VideoTarget, prompt: MediaPrompt): VideoUpstreamBody {
  const { settings } = target;
  const body: VideoUpstreamBody = {
    model: target.slug,
    prompt: prompt.text,
    duration: settings.seconds,
    resolution: settings.resolution,
    aspect_ratio: settings.aspectRatio,
    generate_audio: settings.audio,
  };
  if (prompt.image === null) return body;
  const frames: FrameImage[] = [frameOf(prompt.image, 'first_frame')];
  if (prompt.lastImage !== null) frames.push(frameOf(prompt.lastImage, 'last_frame'));
  return { ...body, frame_images: frames };
}

function frameOf(url: string, frameType: FrameImage['frame_type']): FrameImage {
  return { type: 'image_url', image_url: { url }, frame_type: frameType };
}

/** Starts a job and returns its id at OpenRouter. */
export function submitVideo(
  deps: UpstreamDeps,
  target: VideoTarget,
  prompt: MediaPrompt,
  clientSignal: AbortSignal,
): Promise<string> {
  return callOpenRouter(
    deps,
    {
      path: OPENROUTER.videosPath,
      method: 'POST',
      body: videoUpstreamBody(target, prompt),
      timeoutMs: OPENROUTER.videoRequestTimeoutMs,
      read: async (response) => {
        const job = submittedSchema.safeParse(await response.json());
        if (!job.success) throw mediaUpstreamError(MESSAGES.upstreamUnreadable);
        return job.data.id;
      },
    },
    clientSignal,
  );
}

/** Where the job stands now. */
export function checkVideo(
  deps: UpstreamDeps,
  jobId: string,
  clientSignal: AbortSignal,
): Promise<VideoJobState> {
  return callOpenRouter(
    deps,
    {
      path: OPENROUTER.videoJobPath(jobId),
      method: 'GET',
      timeoutMs: OPENROUTER.videoRequestTimeoutMs,
      goneMessage: MESSAGES.videoGone,
      read: async (response) => {
        const job = jobSchema.safeParse(await response.json());
        if (!job.success) throw mediaUpstreamError(MESSAGES.upstreamUnreadable);
        return stateOf(job.data);
      },
    },
    clientSignal,
  );
}

/** The answer of OpenRouter with the video of a finished job, to pass on as it streams. */
export function fetchVideo(
  deps: UpstreamDeps,
  jobId: string,
  clientSignal: AbortSignal,
): Promise<Response> {
  return callOpenRouter(
    deps,
    {
      path: OPENROUTER.videoContentPath(jobId),
      method: 'GET',
      timeoutMs: OPENROUTER.videoContentTimeoutMs,
      goneMessage: MESSAGES.videoGone,
      read: (response) => Promise.resolve(response),
    },
    clientSignal,
  );
}

function stateOf(job: z.infer<typeof jobSchema>): VideoJobState {
  const status = statusOf(job.status);
  return {
    status,
    costUsd: status === 'completed' ? (job.usage?.cost ?? null) : null,
    reason: status === 'failed' ? reasonOf(job.error) : null,
  };
}

function statusOf(state: string): VideoStatus {
  const { completed, failed } = MEDIA.jobStates;
  if ((completed as readonly string[]).includes(state)) return 'completed';
  if ((failed as readonly string[]).includes(state)) return 'failed';
  return 'pending';
}

/** Why a job failed, in the words of the provider when it gave any, cut to a short line. */
function reasonOf(error: string | null | undefined): string {
  const reason = error?.trim() ?? '';
  return reason === '' ? MESSAGES.videoFailed : reason.slice(0, MEDIA.maxReasonChars);
}
