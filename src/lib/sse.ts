// Reads a server-sent event stream (html.spec.whatwg.org, section "Server-sent events").
// Only the data field matters to the proxy; comments and other fields are skipped.

interface SplitLines {
  readonly lines: string[];
  readonly rest: string;
}

/** Splits complete lines off the buffer. A trailing CR waits for the next chunk, as it may start CRLF. */
export function splitLines(buffer: string): SplitLines {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const char = buffer[index];
    if (char === '\n') {
      lines.push(buffer.slice(start, index));
      start = index + 1;
    } else if (char === '\r') {
      if (index + 1 === buffer.length) break;
      lines.push(buffer.slice(start, index));
      if (buffer[index + 1] === '\n') index += 1;
      start = index + 1;
    }
  }
  return { lines, rest: buffer.slice(start) };
}

/** The value of a data line, or null for any other line. */
export function dataValue(line: string): string | null {
  if (!line.startsWith('data')) return null;
  const rest = line.slice('data'.length);
  if (rest === '') return '';
  if (!rest.startsWith(':')) return null;
  return rest.startsWith(': ') ? rest.slice(2) : rest.slice(1);
}

/** Yields the data of each complete event. Data still pending when the stream ends is discarded. */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let open = true;
  let buffer = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        open = false;
        return;
      }
      const split = splitLines(buffer + value);
      buffer = split.rest;
      for (const line of split.lines) {
        if (line === '') {
          if (data.length > 0) yield data.join('\n');
          data = [];
          continue;
        }
        const field = dataValue(line);
        if (field !== null) data.push(field);
      }
    }
  } catch (error) {
    open = false;
    throw error;
  } finally {
    if (open) await reader.cancel();
    else reader.releaseLock();
  }
}
