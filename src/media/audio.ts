// Audio from OpenRouter (the owner, 26 Oct 2026). A voice that reads a text, or a sound, comes from
// the speech API as the bytes of the file; music comes from a chat completion whose stream carries
// the audio as base64, with its lyrics as text. Each answer is read whole, and the proxy counts what
// it cost: the characters read, the seconds made, or the piece that the stream reports. Formats read
// on 26 Oct 2026: openrouter.ai/docs/guides/overview/multimodal/tts.md ("Request Parameters",
// "Response Format") and .../multimodal/audio.md ("Audio output requires streaming").
import { z } from 'zod';

import { AUDIO, type AudioTools } from '../config/audioTools.js';
import { MESSAGES } from '../config/messages.js';
import type { AudioSettings } from '../config/models.js';
import {
  OPENROUTER,
  providerPreferencesFor,
  type ProviderPreferences,
} from '../config/openrouter.js';
import type { PrivacyLevel } from '../contract.js';
import { concatBytes, fromBase64, toBase64 } from '../lib/bytes.js';
import { ProxyError } from '../lib/errors.js';
import type { UpstreamDeps } from '../openrouter/stream.js';
import { audioTypeOf, mp3Seconds, pcmFormatOf, pcmSeconds, wavOf } from './audioFile.js';
import { callOpenRouter, mediaUpstreamError } from './upstream.js';

/** The model of a piece of audio, as OpenRouter knows it, and the voice that the request picked. */
export interface AudioTarget {
  readonly slug: string;
  readonly privacy: PrivacyLevel;
  readonly settings: AudioSettings;
  readonly tools: AudioTools;
  /** The voice to read with; null for the voice of the model, or for music and sound. */
  readonly voice: string | null;
}

/** What one request made: the audio as a data URL, any text, and its cost at the provider. */
export interface AudioResult {
  readonly dataUrl: string;
  /** The lyrics of a song; empty for an instrumental, a voice, or a sound. */
  readonly text: string;
  readonly costUsd: number;
}

/** What a request of audio picks on the Audio page (26 Oct 2026). */
export interface AudioPicks {
  readonly text: string;
  readonly voice?: string | undefined;
}

/** One request of audio as the request picked it. */
export interface ChosenAudio {
  /** The settings with the cost of this request at most, about: what a balance must hold. */
  readonly settings: AudioSettings;
  readonly voice: string | null;
  /** A text longer than the free trial reads, which only credit pays. */
  readonly creditOnly: boolean;
}

/** The JSON body of the speech API. It names no user and no app. */
export interface SpeechBody {
  model: string;
  input: string;
  voice?: string;
  response_format: 'mp3' | 'pcm';
  provider: ProviderPreferences;
}

/** The JSON body of a chat completion that asks for music. It names no user and no app. */
export interface MusicBody {
  model: string;
  messages: { role: 'user'; content: string }[];
  modalities: readonly ('audio' | 'text')[];
  stream: true;
  provider: ProviderPreferences;
}

/** The characters of a text as the providers count them: one for each code point. */
export function charCount(text: string): number {
  return Array.from(text).length;
}

/** One request of audio at the voice and the length of text that the request picked, or throws. */
export function chosenAudio(
  settings: AudioSettings,
  tools: AudioTools,
  picks: AudioPicks,
): ChosenAudio {
  const chars = charCount(picks.text);
  if (chars > tools.maxChars) {
    throw new ProxyError('invalid_request', MESSAGES.audioTooLong(tools.maxChars));
  }
  return {
    settings: { ...settings, costUsd: mostCostUsd(settings, tools, chars) },
    voice: chosenVoice(tools, picks.voice),
    creditOnly: settings.mode === 'voice' && chars > AUDIO.trialChars,
  };
}

/** The voice that the request named, one of the model's, or else its default. */
function chosenVoice(tools: AudioTools, picked: string | undefined): string | null {
  if (picked === undefined) return tools.voices[0]?.id ?? null;
  if (!tools.voices.some((voice) => voice.id === picked)) {
    throw new ProxyError('invalid_request', MESSAGES.voiceUnavailable);
  }
  return picked;
}

/** The most that one request may cost at the provider: by its text, its longest audio, or its piece. */
function mostCostUsd(settings: AudioSettings, tools: AudioTools, chars: number): number {
  const { per, usd } = settings.rate;
  if (per === 'character') return chars * usd;
  if (per === 'second') return (tools.maxSeconds ?? 0) * usd;
  return usd;
}

export function speechBody(target: AudioTarget, text: string): SpeechBody {
  if (target.tools.format === null) throw new Error(`${target.slug} has no format of speech.`);
  return {
    model: target.slug,
    input: text,
    ...(target.voice === null ? {} : { voice: target.voice }),
    response_format: target.tools.format,
    provider: providerPreferencesFor(target.privacy),
  };
}

export function musicBody(target: AudioTarget, text: string): MusicBody {
  return {
    model: target.slug,
    messages: [{ role: 'user', content: text }],
    modalities: AUDIO.musicModalities,
    stream: true,
    provider: providerPreferencesFor(target.privacy),
  };
}

/** Makes one piece of audio, or throws a ProxyError when OpenRouter fails or the app goes away. */
export function generateAudio(
  deps: UpstreamDeps,
  target: AudioTarget,
  text: string,
  clientSignal: AbortSignal,
): Promise<AudioResult> {
  return target.settings.api === 'chat'
    ? makeMusic(deps, target, text, clientSignal)
    : makeSpeech(deps, target, text, clientSignal);
}

async function makeSpeech(
  deps: UpstreamDeps,
  target: AudioTarget,
  text: string,
  clientSignal: AbortSignal,
): Promise<AudioResult> {
  const answer = await callOpenRouter(
    deps,
    {
      path: OPENROUTER.speechPath,
      method: 'POST',
      body: speechBody(target, text),
      timeoutMs: OPENROUTER.audioTimeoutMs,
      read: async (response) => ({
        type: response.headers.get('Content-Type') ?? '',
        bytes: new Uint8Array(await response.arrayBuffer()),
      }),
    },
    clientSignal,
  );
  const file = speechFile(answer.type, answer.bytes);
  const { per, usd } = target.settings.rate;
  const units = per === 'character' ? charCount(text) : per === 'second' ? file.seconds() : 1;
  return { dataUrl: dataUrlOf(file.type, file.bytes), text: '', costUsd: units * usd };
}

/** The file of an answer of the speech API, and its seconds, which only some models need. */
interface SpeechFile {
  readonly type: string;
  readonly bytes: Uint8Array;
  readonly seconds: () => number;
}

/** Raw PCM becomes WAV; an MP3 stays as it came. */
function speechFile(contentType: string, bytes: Uint8Array): SpeechFile {
  if (bytes.length === 0) throw mediaUpstreamError(MESSAGES.noAudio);
  const pcm = pcmFormatOf(contentType);
  if (pcm !== null) {
    return {
      type: 'audio/wav',
      bytes: wavOf(bytes, pcm),
      seconds: () => pcmSeconds(bytes.length, pcm),
    };
  }
  const type = audioTypeOf(bytes);
  if (type === null) throw mediaUpstreamError(MESSAGES.upstreamUnreadable);
  return { type, bytes, seconds: () => mp3Seconds(bytes) };
}

const musicChunkSchema = z.object({
  error: z.unknown().optional(),
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            audio: z.object({ data: z.string().nullish() }).nullish(),
          })
          .nullish(),
      }),
    )
    .nullish(),
  usage: z.object({ cost: z.number().nonnegative().nullish() }).nullish(),
});

/** What the stream of a song carried. */
interface MusicStream {
  readonly parts: readonly string[];
  readonly text: string;
  readonly costUsd: number | null;
}

async function makeMusic(
  deps: UpstreamDeps,
  target: AudioTarget,
  text: string,
  clientSignal: AbortSignal,
): Promise<AudioResult> {
  const stream = await callOpenRouter(
    deps,
    {
      path: OPENROUTER.chatCompletionsPath,
      method: 'POST',
      body: musicBody(target, text),
      timeoutMs: OPENROUTER.audioTimeoutMs,
      // The answer is read whole: one line of the stream holds the whole song, megabytes long.
      read: async (response) => musicStreamOf(await response.text()),
    },
    clientSignal,
  );
  if (stream.parts.length === 0) throw mediaUpstreamError(MESSAGES.noAudio);
  const bytes = stream.parts.length === 1 ? null : concatBytes(stream.parts.map(fromBase64));
  const head = bytes ?? fromBase64(headOf(stream.parts[0] ?? ''));
  const type = audioTypeOf(head);
  if (type === null) throw mediaUpstreamError(MESSAGES.upstreamUnreadable);
  return {
    dataUrl: `data:${type};base64,${bytes === null ? (stream.parts[0] ?? '') : toBase64(bytes)}`,
    text: lyricsOf(stream.text),
    costUsd: stream.costUsd ?? target.settings.rate.usd,
  };
}

/** Characters of base64 that hold the first bytes of a file, enough to tell its type. */
const HEAD_BASE64_CHARS = 16;

function headOf(base64: string): string {
  return base64.slice(0, HEAD_BASE64_CHARS);
}

/** The parts of the audio, the text, and the reported cost of the events of a stream. */
export function musicStreamOf(body: string): MusicStream {
  const parts: string[] = [];
  let text = '';
  let costUsd: number | null = null;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice('data:'.length).trim();
    if (data === OPENROUTER.streamDoneData) continue;
    const chunk = musicChunkSchema.safeParse(JSON.parse(data));
    if (!chunk.success) throw mediaUpstreamError(MESSAGES.upstreamUnreadable);
    if (chunk.data.error !== undefined && chunk.data.error !== null) {
      throw mediaUpstreamError(MESSAGES.upstreamStopped);
    }
    for (const choice of chunk.data.choices ?? []) {
      const audio = choice.delta?.audio?.data;
      if (audio !== undefined && audio !== null && audio !== '') parts.push(audio);
      text += choice.delta?.content ?? '';
    }
    costUsd = chunk.data.usage?.cost ?? costUsd;
  }
  return { parts, text, costUsd };
}

/** The line of Lyria that opens a section of a song, such as '[[A0]]'. */
const SECTION_MARK = /^\[\[[^\]]*\]\]$/;

/** The mark of Lyria in front of each sung line. */
const SUNG_MARK = /^\[:\]\s*/;

/** The whole text of Lyria for a song with no words. */
const INSTRUMENTAL = '<instrumental>';

/**
 * The lyrics of a song in plain lines, a blank line between its sections (Lyria, 26 Oct 2026); empty
 * for an instrumental.
 */
export function lyricsOf(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== INSTRUMENTAL)
    .map((line) => (SECTION_MARK.test(line) ? '' : line.replace(SUNG_MARK, '')))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function dataUrlOf(type: string, bytes: Uint8Array): string {
  return `data:${type};base64,${toBase64(bytes)}`;
}
