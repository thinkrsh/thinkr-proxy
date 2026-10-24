import { describe, expect, it } from 'vitest';

import { dataValue, readSseData, splitLines } from '../src/lib/sse.js';
import { streamOf } from './helpers.js';

async function collect(parts: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const data of readSseData(streamOf(parts))) out.push(data);
  return out;
}

describe('splitLines', () => {
  it('splits on LF, CRLF, and CR', () => {
    expect(splitLines('a\nb\r\nc\rd')).toEqual({ lines: ['a', 'b', 'c'], rest: 'd' });
  });

  it('keeps a trailing CR in the rest, as it may start a CRLF', () => {
    expect(splitLines('a\r')).toEqual({ lines: [], rest: 'a\r' });
  });
});

describe('dataValue', () => {
  it('reads data fields with and without the leading space', () => {
    expect(dataValue('data: x')).toBe('x');
    expect(dataValue('data:x')).toBe('x');
    expect(dataValue('data')).toBe('');
  });

  it('ignores other fields', () => {
    expect(dataValue('event: ping')).toBeNull();
    expect(dataValue('database: x')).toBeNull();
  });
});

describe('readSseData', () => {
  it('yields one value per event and skips comments', () => {
    const parts = [': OPENROUTER PROCESSING\n\n', 'data: one\n\n', 'data: two\n\n'];
    return expect(collect(parts)).resolves.toEqual(['one', 'two']);
  });

  it('joins events split across chunks, also inside a CRLF', () => {
    const parts = ['da', 'ta: {"a"', ':1}\r', '\n\r\n'];
    return expect(collect(parts)).resolves.toEqual(['{"a":1}']);
  });

  it('joins multi-line data with LF', () => {
    return expect(collect(['data: a\ndata: b\n\n'])).resolves.toEqual(['a\nb']);
  });

  it('discards an event that the stream does not finish', () => {
    return expect(collect(['data: one\n\n', 'data: two'])).resolves.toEqual(['one']);
  });
});
