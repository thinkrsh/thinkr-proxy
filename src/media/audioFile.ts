// The files of the Audio page (26 Oct 2026): raw PCM from the speech API wrapped as WAV, which a
// browser plays; the length of an MP3, from its frames, for a model that charges by the second; and
// the type of audio that a model sent, from its first bytes. Formats: the WAV header of RIFF (PCM,
// format 1), the MPEG audio frame header of ISO/IEC 11172-3 and 13818-3, layer III.

/** Raw PCM as the speech API sends it: 16-bit samples, little-endian, at a rate in hertz. */
export interface PcmFormat {
  readonly rate: number;
  readonly channels: number;
}

const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;

/**
 * The format of raw PCM from its content type, such as 'audio/pcm;rate=24000;channels=1' (Gemini
 * TTS and Seed Audio, 26 Oct 2026); null for any other type, or one that names no rate.
 */
export function pcmFormatOf(contentType: string): PcmFormat | null {
  const [type, ...params] = contentType.split(';').map((part) => part.trim().toLowerCase());
  if (type !== 'audio/pcm') return null;
  const values = new Map(
    params.map((param) => {
      const [key = '', value = ''] = param.split('=');
      return [key.trim(), Number(value.trim())] as const;
    }),
  );
  const rate = values.get('rate');
  const channels = values.get('channels') ?? 1;
  if (rate === undefined || !Number.isInteger(rate) || rate <= 0) return null;
  if (!Number.isInteger(channels) || channels <= 0) return null;
  return { rate, channels };
}

/** The seconds of raw PCM of a format. */
export function pcmSeconds(bytes: number, format: PcmFormat): number {
  return bytes / (format.rate * format.channels * BYTES_PER_SAMPLE);
}

/** Raw PCM as a WAV file. */
export function wavOf(pcm: Uint8Array, format: PcmFormat): Uint8Array {
  const file = new Uint8Array(WAV_HEADER_BYTES + pcm.length);
  const view = new DataView(file.buffer);
  const blockAlign = format.channels * BYTES_PER_SAMPLE;
  writeAscii(file, 0, 'RIFF');
  view.setUint32(4, WAV_HEADER_BYTES - 8 + pcm.length, true);
  writeAscii(file, 8, 'WAVE');
  writeAscii(file, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.rate, true);
  view.setUint32(28, format.rate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
  writeAscii(file, 36, 'data');
  view.setUint32(40, pcm.length, true);
  file.set(pcm, WAV_HEADER_BYTES);
  return file;
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    target[offset + index] = text.charCodeAt(index);
  }
}

/** Kilobits a second of layer III, by the index of the header: MPEG-1, then MPEG-2 and 2.5. */
const MPEG1_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/** Samples a second, by the version bits of the header (0: MPEG-2.5, 2: MPEG-2, 3: MPEG-1). */
const SAMPLE_RATES: Readonly<Record<number, readonly number[]>> = {
  0: [11_025, 12_000, 8_000],
  2: [22_050, 24_000, 16_000],
  3: [44_100, 48_000, 32_000],
};

const MPEG1 = 3;
const ID3_HEADER_BYTES = 10;

/** One frame of layer III: how many bytes it takes, and how many seconds it plays. */
interface Mp3Frame {
  readonly bytes: number;
  readonly seconds: number;
}

/**
 * The seconds of an MP3 file: the sum of its frames, which holds for a constant and a variable bit
 * rate alike. An ID3v2 tag in front is skipped; the walk stops at the first byte that starts no
 * frame, such as a tag at the end.
 */
export function mp3Seconds(file: Uint8Array): number {
  let offset = id3Bytes(file);
  let seconds = 0;
  for (;;) {
    const frame = mp3FrameAt(file, offset);
    if (frame === null) return seconds;
    seconds += frame.seconds;
    offset += frame.bytes;
  }
}

/** The bytes of an ID3v2 tag at the start of a file, its size being four 7-bit bytes; else 0. */
function id3Bytes(file: Uint8Array): number {
  if (file.length < ID3_HEADER_BYTES || !startsWith(file, 'ID3')) return 0;
  const size = [6, 7, 8, 9].reduce((sum, index) => sum * 128 + ((file[index] ?? 0) & 0x7f), 0);
  return ID3_HEADER_BYTES + size;
}

function mp3FrameAt(file: Uint8Array, offset: number): Mp3Frame | null {
  if (offset + 4 > file.length) return null;
  const [b0 = 0, b1 = 0, b2 = 0] = file.subarray(offset, offset + 3);
  // Eleven bits of sync, then the version, and layer III (bits 01).
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0 || (b1 & 0x06) !== 0x02) return null;
  const version = (b1 >> 3) & 0x03;
  const kbps = (version === MPEG1 ? MPEG1_KBPS : MPEG2_KBPS)[b2 >> 4];
  const rate = SAMPLE_RATES[version]?.[(b2 >> 2) & 0x03];
  if (kbps === undefined || kbps === 0 || rate === undefined) return null;
  const samples = version === MPEG1 ? 1_152 : 576;
  const padding = (b2 >> 1) & 0x01;
  const bytes = Math.floor((samples / 8) * ((kbps * 1_000) / rate)) + padding;
  return { bytes, seconds: samples / rate };
}

/** The types of audio that a browser plays, by the first bytes of their files. */
const SIGNATURES: readonly {
  readonly type: string;
  readonly test: (file: Uint8Array) => boolean;
}[] = [
  { type: 'audio/mpeg', test: (file) => startsWith(file, 'ID3') || mp3FrameAt(file, 0) !== null },
  { type: 'audio/wav', test: (file) => startsWith(file, 'RIFF') },
  { type: 'audio/ogg', test: (file) => startsWith(file, 'OggS') },
  { type: 'audio/flac', test: (file) => startsWith(file, 'fLaC') },
];

/** The type of an audio file from its first bytes, or null for one that a browser may not play. */
export function audioTypeOf(file: Uint8Array): string | null {
  return SIGNATURES.find((signature) => signature.test(file))?.type ?? null;
}

function startsWith(file: Uint8Array, text: string): boolean {
  if (file.length < text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (file[index] !== text.charCodeAt(index)) return false;
  }
  return true;
}
