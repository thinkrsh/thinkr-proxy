// The tools of the Audio page (the owner, 26 Oct 2026): the voices that each model of audio reads
// with, the longest text it takes, and the format it answers in. Read on 26 Oct 2026 from GET
// https://openrouter.ai/api/v1/models?output_modalities=speech (`supported_voices`, the English
// ones; `context_length`) and openrouter.ai/docs/guides/overview/multimodal/tts.md, "Request
// Parameters"; each model answered one test request that day. Change them here only.
import type { VoiceOption } from '../contract.js';
import { LIMITS } from './limits.js';

export interface AudioTools {
  /**
   * The voices that the user may pick, the default first; empty for a model that reads with a
   * voice of its own (Fish Audio), and for music and sound.
   */
  readonly voices: readonly VoiceOption[];
  /** The longest prompt or text, in characters, never more than LIMITS.maxPromptChars. */
  readonly maxChars: number;
  /**
   * What to ask the speech API for: MP3, or raw PCM from a model that gives nothing else (Gemini
   * TTS: "only supports response_format=pcm"), which the proxy wraps as WAV. Null for music, whose
   * chat completion answers in a format of its own (MP3 from Lyria).
   */
  readonly format: 'mp3' | 'pcm' | null;
  /**
   * The longest audio of one request, in seconds, for a model that charges by the second: what a
   * balance must hold before it starts. Null for the others.
   */
  readonly maxSeconds: number | null;
}

export const AUDIO = {
  /**
   * The longest text that the free trial reads in the mode voice (the plan of 26 Oct 2026): at the
   * dearest voice, MiniMax Speech 2.8 HD, it costs about $0.10, so ten requests of a visitor cannot
   * spend the budget of the open lane. A longer text takes credit.
   */
  trialChars: 1_000,
  /**
   * The outputs to ask of Lyria, audio first: three requests that named text first came back with
   * a line of text and no audio, and three that named audio first each brought their song (26 Oct
   * 2026).
   */
  musicModalities: ['audio', 'text'],
  /**
   * How many times to ask Lyria for one song. Lyria 3 Clip often ends its stream with the text
   * "<instrumental>" and no audio, at a cost of 0 (two of three requests on 26 Oct 2026), and a
   * stream can break before the audio; the next request usually brings the song.
   */
  musicAttempts: 3,
  /**
   * No new request of a song after this long, so that the answer reaches the app before Cloudflare
   * gives up on the request (about 100 seconds): a song of Lyria 3 Pro takes about 35 seconds.
   */
  musicRetryWithinMs: 45_000,
  /**
   * The audio tokens of one second of speech from Gemini TTS, which charges them as output: 75
   * tokens for 3.0 seconds on 26 Oct 2026 (GET /api/v1/generation of the test request).
   */
  geminiTokensPerSecond: 25,
} as const;

/**
 * The longest text to read, and the longest prompt of music: the limit of every prompt. Each model
 * takes as much (ElevenLabs 10,000 characters; Voxtral and Kokoro a context of 4,096).
 */
const READ_CHARS = LIMITS.maxPromptChars;

/** Seed Audio 1.0: "input is limited to 3000 characters", "capped at 120 seconds per request". */
const SEED_AUDIO_CHARS = 3_000;
const SEED_AUDIO_SECONDS = 120;

/**
 * The longest speech of Gemini TTS that a text of READ_CHARS makes, at about 15 characters a
 * second of the test of 26 Oct 2026 (35 characters in 3.0 seconds), with room to spare.
 */
const GEMINI_SECONDS = 300;

function voicesOf(entries: readonly (readonly [id: string, name: string])[]): VoiceOption[] {
  return entries.map(([id, name]) => ({ id, name }));
}

/** Jessica first: the voice of ElevenLabs that the owner picked for the videos of Thinkr. */
const ELEVENLABS_VOICES = voicesOf([
  ['jessica', 'Jessica'],
  ['adam', 'Adam'],
  ['alice', 'Alice'],
  ['bella', 'Bella'],
  ['bill', 'Bill'],
  ['brian', 'Brian'],
  ['callum', 'Callum'],
  ['charlie', 'Charlie'],
  ['chris', 'Chris'],
  ['daniel', 'Daniel'],
  ['eric', 'Eric'],
  ['george', 'George'],
  ['harry', 'Harry'],
  ['laura', 'Laura'],
  ['liam', 'Liam'],
  ['lily', 'Lily'],
  ['matilda', 'Matilda'],
  ['river', 'River'],
  ['roger', 'Roger'],
  ['sarah', 'Sarah'],
  ['will', 'Will'],
]);

const GEMINI_VOICES = voicesOf(
  [
    'Kore',
    'Zephyr',
    'Puck',
    'Charon',
    'Fenrir',
    'Leda',
    'Orus',
    'Aoede',
    'Callirrhoe',
    'Autonoe',
    'Enceladus',
    'Iapetus',
    'Umbriel',
    'Algieba',
    'Despina',
    'Erinome',
    'Algenib',
    'Rasalgethi',
    'Laomedeia',
    'Achernar',
    'Alnilam',
    'Schedar',
    'Gacrux',
    'Pulcherrima',
    'Achird',
    'Zubenelgenubi',
    'Vindemiatrix',
    'Sadachbia',
    'Sadaltager',
    'Sulafat',
  ].map((name) => [name, name] as const),
);

/** The English voices of MAI-Voice 2.1, whose ids end with the name of the model. */
const MAI_VOICES: readonly (readonly [locale: string, name: string])[] = [
  ['en-US-Harper', 'Harper'],
  ['en-US-Ethan', 'Ethan'],
  ['en-US-Grant', 'Grant'],
  ['en-US-Iris', 'Iris'],
  ['en-US-Jasper', 'Jasper'],
  ['en-US-Olivia', 'Olivia'],
  ['en-US-Sage', 'Sage'],
  ['en-GB-Emily', 'Emily (British)'],
  ['en-GB-Harry', 'Harry (British)'],
  ['en-AU-Isla', 'Isla (Australian)'],
  ['en-IN-Dhruv', 'Dhruv (Indian)'],
  ['en-IN-Priya', 'Priya (Indian)'],
];

function maiVoices(model: string): VoiceOption[] {
  return voicesOf(MAI_VOICES.map(([locale, name]) => [`${locale}:${model}`, name] as const));
}

const MINIMAX_VOICES = voicesOf([
  ['English_expressive_narrator', 'Expressive narrator'],
  ['English_CalmWoman', 'Calm woman'],
  ['English_Trustworth_Man', 'Trustworthy man'],
  ['English_Graceful_Lady', 'Graceful lady'],
  ['English_Upbeat_Woman', 'Upbeat woman'],
  ['English_ManWithDeepVoice', 'Deep voice'],
  ['English_FriendlyPerson', 'Friendly person'],
  ['English_CaptivatingStoryteller', 'Storyteller'],
  ['English_Gentle-voiced_man', 'Gentle man'],
  ['English_Soft-spokenGirl', 'Soft-spoken girl'],
  ['English_Whispering_girl', 'Whispering girl'],
  ['English_Aussie_Bloke', 'Aussie bloke'],
  ['English_WiseScholar', 'Wise scholar'],
  ['English_Comedian', 'Comedian'],
]);

const GROK_VOICES = voicesOf([
  ['eve', 'Eve'],
  ['ara', 'Ara'],
  ['rex', 'Rex'],
  ['sal', 'Sal'],
  ['leo', 'Leo'],
]);

const VOXTRAL_VOICES = voicesOf([
  ['en_paul_neutral', 'Paul, neutral'],
  ['en_paul_cheerful', 'Paul, cheerful'],
  ['en_paul_confident', 'Paul, confident'],
  ['en_paul_excited', 'Paul, excited'],
  ['en_paul_sad', 'Paul, sad'],
  ['gb_oliver_neutral', 'Oliver (British), neutral'],
  ['gb_oliver_cheerful', 'Oliver (British), cheerful'],
  ['gb_oliver_curious', 'Oliver (British), curious'],
  ['gb_oliver_confident', 'Oliver (British), confident'],
  ['gb_jane_neutral', 'Jane (British), neutral'],
  ['gb_jane_confident', 'Jane (British), confident'],
  ['gb_jane_curious', 'Jane (British), curious'],
  ['gb_jane_sarcasm', 'Jane (British), sarcastic'],
]);

const KOKORO_VOICES = voicesOf([
  ['af_heart', 'Heart'],
  ['af_alloy', 'Alloy'],
  ['af_aoede', 'Aoede'],
  ['af_bella', 'Bella'],
  ['af_jessica', 'Jessica'],
  ['af_kore', 'Kore'],
  ['af_nicole', 'Nicole'],
  ['af_nova', 'Nova'],
  ['af_river', 'River'],
  ['af_sarah', 'Sarah'],
  ['af_sky', 'Sky'],
  ['am_adam', 'Adam'],
  ['am_echo', 'Echo'],
  ['am_eric', 'Eric'],
  ['am_fenrir', 'Fenrir'],
  ['am_liam', 'Liam'],
  ['am_michael', 'Michael'],
  ['am_onyx', 'Onyx'],
  ['am_puck', 'Puck'],
  ['bf_alice', 'Alice (British)'],
  ['bf_emma', 'Emma (British)'],
  ['bf_isabella', 'Isabella (British)'],
  ['bf_lily', 'Lily (British)'],
  ['bm_daniel', 'Daniel (British)'],
  ['bm_fable', 'Fable (British)'],
  ['bm_george', 'George (British)'],
  ['bm_lewis', 'Lewis (British)'],
]);

const MUSIC: AudioTools = { voices: [], maxChars: READ_CHARS, format: null, maxSeconds: null };

function reader(voices: readonly VoiceOption[], format: 'mp3' | 'pcm' = 'mp3'): AudioTools {
  return { voices, maxChars: READ_CHARS, format, maxSeconds: null };
}

/** The tools of each model of audio of the catalog, by its id. */
export const AUDIO_TOOLS: Readonly<Record<string, AudioTools>> = {
  'open/lyria-3-pro': MUSIC,
  'open/lyria-3-clip': MUSIC,
  'open/eleven-v4': reader(ELEVENLABS_VOICES),
  'open/eleven-v4-turbo': reader(ELEVENLABS_VOICES),
  'open/gemini-3.8-flash-tts': { ...reader(GEMINI_VOICES, 'pcm'), maxSeconds: GEMINI_SECONDS },
  'open/gemini-3.8-flash-lite-tts': {
    ...reader(GEMINI_VOICES, 'pcm'),
    maxSeconds: GEMINI_SECONDS,
  },
  'open/mai-voice-2.1': reader(maiVoices('MAI-Voice-2.1')),
  'open/mai-voice-2.1-flash': reader(maiVoices('MAI-Voice-2.1-Flash')),
  'open/fish-audio-s2.1-pro': reader([]),
  'open/fish-audio-drama-3': reader([]),
  'open/minimax-speech-2.8-hd': reader(MINIMAX_VOICES),
  'open/minimax-speech-2.8-turbo': reader(MINIMAX_VOICES),
  'open/grok-voice-tts-1.0': reader(GROK_VOICES),
  'open/voxtral-mini-tts-3.0': reader(VOXTRAL_VOICES),
  'open/kokoro-82m': reader(KOKORO_VOICES),
  'open/seed-audio-1.0': {
    voices: [],
    maxChars: SEED_AUDIO_CHARS,
    format: 'mp3',
    maxSeconds: SEED_AUDIO_SECONDS,
  },
};
