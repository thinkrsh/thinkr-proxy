// What the proxy reads from the source of a sourced video (decision 216, 26 Oct 2026), before a
// balance pays for it: the length and the frame of an MP4 or a QuickTime video, from its boxes
// (ISO/IEC 14496-12: `moov` > `mvhd` for the length, `moov` > `trak` > `tkhd` for the frame), and
// the length of a WAV voice, from its `fmt ` and `data` chunks. It decodes no picture and no sound.

/** The length of a source, and the frame of a video. */
export interface Measured {
  readonly seconds: number;
  /** The frame of a video, in pixels; null for a voice. */
  readonly width: number | null;
  readonly height: number | null;
}

interface Box {
  readonly type: string;
  /** Where the content of the box starts, after its header. */
  readonly start: number;
  readonly end: number;
}

/** The length and the largest frame of an MP4 or a QuickTime video, or null when unreadable. */
export function measureVideo(bytes: Uint8Array): Measured | null {
  const view = viewOf(bytes);
  const movie = firstBox(view, 0, bytes.byteLength, 'moov');
  if (movie === null) return null;
  const header = firstBox(view, movie.start, movie.end, 'mvhd');
  const seconds = header === null ? null : movieSeconds(view, header);
  if (seconds === null || seconds <= 0) return null;
  let width = 0;
  let height = 0;
  for (const track of boxes(view, movie.start, movie.end)) {
    if (track.type !== 'trak') continue;
    const trackHeader = firstBox(view, track.start, track.end, 'tkhd');
    const frame = trackHeader === null ? null : trackFrame(view, trackHeader);
    // A track of sound has a frame of 0x0; the video track has the largest.
    if (frame !== null && frame.width * frame.height > width * height) ({ width, height } = frame);
  }
  return width > 0 && height > 0 ? { seconds, width, height } : null;
}

/** The length of a WAV voice, or null when unreadable. */
export function measureWav(bytes: Uint8Array): Measured | null {
  const view = viewOf(bytes);
  const end = bytes.byteLength;
  if (end < 12 || fourCc(view, 0) !== 'RIFF' || fourCc(view, 8) !== 'WAVE') return null;
  let byteRate = 0;
  let at = 12;
  while (at + 8 <= end) {
    const id = fourCc(view, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ' && size >= 16 && body + 12 <= end) byteRate = view.getUint32(body + 8, true);
    if (id === 'data') {
      // A WAV written as a stream may name a size past its end: count what came.
      const dataBytes = Math.min(size, end - body);
      return byteRate > 0 && dataBytes > 0
        ? { seconds: dataBytes / byteRate, width: null, height: null }
        : null;
    }
    // Chunks are padded to an even size.
    at = body + size + (size % 2);
  }
  return null;
}

/** The length of a movie, from the time scale and the duration of its `mvhd`. */
function movieSeconds(view: DataView, header: Box): number | null {
  const version = view.getUint8(header.start);
  // Version 1 holds its times in 64 bits, version 0 in 32, after 4 bytes of version and flags.
  const scaleAt = header.start + (version === 1 ? 20 : 12);
  const longDuration = version === 1;
  if (scaleAt + (longDuration ? 12 : 8) > header.end) return null;
  const scale = view.getUint32(scaleAt);
  const duration = longDuration
    ? Number(view.getBigUint64(scaleAt + 4))
    : view.getUint32(scaleAt + 4);
  return scale > 0 ? duration / scale : null;
}

/** The frame of a track, from the width and the height of its `tkhd`, fixed point 16.16. */
function trackFrame(view: DataView, header: Box): { width: number; height: number } | null {
  const version = view.getUint8(header.start);
  const widthAt = header.start + (version === 1 ? 88 : 76);
  if (widthAt + 8 > header.end) return null;
  return { width: view.getUint32(widthAt) >>> 16, height: view.getUint32(widthAt + 4) >>> 16 };
}

/** The boxes between two offsets, in order; stops at the first box that does not fit. */
function* boxes(view: DataView, from: number, to: number): Generator<Box> {
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    let headerBytes = 8;
    if (size === 1) {
      if (at + 16 > to) return;
      const large = view.getBigUint64(at + 8);
      if (large > BigInt(to - at)) return;
      size = Number(large);
      headerBytes = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < headerBytes || at + size > to) return;
    yield { type: fourCc(view, at + 4), start: at + headerBytes, end: at + size };
    at += size;
  }
}

function firstBox(view: DataView, from: number, to: number, type: string): Box | null {
  for (const box of boxes(view, from, to)) if (box.type === type) return box;
  return null;
}

function fourCc(view: DataView, at: number): string {
  return String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3),
  );
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
