import { describe, expect, it } from 'vitest';

import { MESSAGES } from '../src/config/messages.js';
import type { ChatEvent } from '../src/contract.js';
import { readChatEvents, type AnswerSpend } from '../src/openrouter/chunks.js';
import { DONE, chunk, contentChunk, streamOf } from './helpers.js';

async function events(parts: readonly string[]): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of readChatEvents(streamOf(parts), () => undefined)) out.push(event);
  return out;
}

const finalChunks = [
  chunk({ choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }] }),
  chunk({
    choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.0001 },
  }),
  DONE,
];

describe('readChatEvents, the spend of an answer', () => {
  it('reports the cost of the last chunk before done', async () => {
    const spends: AnswerSpend[] = [];
    const last = chunk({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 3, cost: 0.0012 },
    });
    for await (const event of readChatEvents(
      streamOf([contentChunk('Hi'), last, DONE]),
      (spend) => {
        spends.push(spend);
      },
    )) {
      if (event.type === 'done') expect(spends).toHaveLength(1);
    }
    expect(spends).toEqual([
      { usage: { inputTokens: 7, outputTokens: 3 }, costUsd: 0.0012, webSearches: 0 },
    ]);
  });

  it('reports nothing for an answer that broke', async () => {
    const spends: AnswerSpend[] = [];
    for await (const event of readChatEvents(streamOf([contentChunk('Hal')]), (spend) => {
      spends.push(spend);
    })) {
      expect(event.type).not.toBe('done');
    }
    expect(spends).toEqual([]);
  });
});

describe('readChatEvents', () => {
  it('maps content, keep-alive comments, and the final usage chunk', async () => {
    const parts = [
      ': OPENROUTER PROCESSING\n\n',
      contentChunk('Hel'),
      contentChunk('lo'),
      ...finalChunks,
    ];
    expect(await events(parts)).toEqual([
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
      { type: 'done', finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 3 } },
    ]);
  });

  it('reads reasoning once when both reasoning and reasoning_details carry it', async () => {
    const reasoning = chunk({
      choices: [
        {
          delta: {
            reasoning: 'Thinking',
            reasoning_details: [{ type: 'reasoning.text', text: 'Thinking' }],
          },
        },
      ],
    });
    expect(await events([reasoning, ...finalChunks])).toEqual([
      { type: 'reasoning', text: 'Thinking' },
      { type: 'done', finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 3 } },
    ]);
  });

  it('falls back to reasoning_details when reasoning is absent', async () => {
    const reasoning = chunk({
      choices: [{ delta: { reasoning_details: [{ type: 'reasoning.summary', summary: 'Plan' }] } }],
    });
    expect((await events([reasoning, DONE]))[0]).toEqual({ type: 'reasoning', text: 'Plan' });
  });

  it('ends with an error event when the provider fails mid-stream', async () => {
    const failure = chunk({
      error: { code: 'server_error', message: 'Provider disconnected unexpectedly' },
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
    });
    expect(await events([contentChunk('Hi'), failure, DONE])).toEqual([
      { type: 'delta', text: 'Hi' },
      { type: 'error', code: 'upstream_error', message: MESSAGES.upstreamStopped },
    ]);
  });

  it('reports data it cannot read', async () => {
    expect(await events(['data: {not json}\n\n'])).toEqual([
      { type: 'error', code: 'upstream_error', message: MESSAGES.upstreamUnreadable },
    ]);
  });

  it('reports a stream that ends before the answer finished', async () => {
    expect(await events([contentChunk('Hi')])).toEqual([
      { type: 'delta', text: 'Hi' },
      { type: 'error', code: 'upstream_error', message: MESSAGES.upstreamEndedEarly },
    ]);
  });

  it('finishes when the stream ends after a finish reason but without [DONE]', async () => {
    const last = finalChunks.slice(0, 2);
    expect((await events([contentChunk('Hi'), ...last])).at(-1)).toEqual({
      type: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 3 },
    });
  });
});

describe('readChatEvents, web search (29 Oct 2026)', () => {
  /** One result of a search as OpenRouter streams it: a citation with the excerpts of the page. */
  function citation(url: string, title?: string): unknown {
    return {
      type: 'url_citation',
      url_citation: { url, start_index: 0, end_index: 0, content: 'An excerpt.', title },
    };
  }

  const found = chunk({
    choices: [
      {
        delta: {
          content: '',
          annotations: [
            citation('https://nodejs.org/en/blog/release', 'Node.js'),
            citation('http://example.com/news'),
            citation('javascript:alert(1)', 'Not a page'),
            { type: 'file_citation', url_citation: null },
          ],
        },
      },
    ],
  });

  const searchedTwice = chunk({
    choices: [{ delta: { content: '' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 10_843,
      completion_tokens: 451,
      cost: 0.015580725,
      server_tool_use_details: { web_search_requests: 2, tool_calls_executed: 2 },
    },
  });

  it('names each page of the web that a search found, without its excerpts', async () => {
    expect(await events([found, contentChunk('Hi'), ...finalChunks])).toEqual([
      { type: 'source', url: 'https://nodejs.org/en/blog/release', title: 'Node.js' },
      { type: 'source', url: 'http://example.com/news', title: '' },
      { type: 'delta', text: 'Hi' },
      { type: 'done', finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 3 } },
    ]);
  });

  it('tells how often the answer searched before done, and reports the searches', async () => {
    const spends: AnswerSpend[] = [];
    const out: ChatEvent[] = [];
    for await (const event of readChatEvents(
      streamOf([found, contentChunk('Hi'), searchedTwice, DONE]),
      (spend) => {
        spends.push(spend);
      },
    )) {
      out.push(event);
    }
    expect(out.slice(-2)).toEqual([
      { type: 'searched', count: 2 },
      { type: 'done', finishReason: 'stop', usage: { inputTokens: 10_843, outputTokens: 451 } },
    ]);
    expect(spends).toEqual([
      {
        usage: { inputTokens: 10_843, outputTokens: 451 },
        costUsd: 0.015580725,
        webSearches: 2,
      },
    ]);
  });

  it('starts a new paragraph after pages that a search found between two texts', async () => {
    const parts = [
      contentChunk('I will search.'),
      found,
      contentChunk('Node.js'),
      contentChunk(' 24.'),
    ];
    const texts = (await events([...parts, ...finalChunks])).flatMap((event) =>
      event.type === 'delta' ? [event.text] : [],
    );
    expect(texts).toEqual(['I will search.', '\n\nNode.js', ' 24.']);
  });

  it('adds no break where the text already breaks after the search', async () => {
    const parts = [contentChunk('I will search.\n'), found, contentChunk('Node.js')];
    const texts = (await events([...parts, ...finalChunks])).flatMap((event) =>
      event.type === 'delta' ? [event.text] : [],
    );
    expect(texts).toEqual(['I will search.\n', 'Node.js']);
  });

  it('tells nothing of searches for an answer that ran none', async () => {
    const types = (await events([contentChunk('Hi'), ...finalChunks])).map((event) => event.type);
    expect(types).not.toContain('searched');
  });
});
