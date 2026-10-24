import { describe, expect, it } from 'vitest';

import { TRIAL } from '../src/config/trial.js';
import { answerSpend } from '../src/lib/cost.js';
import { parseUsageMetrics } from '../src/tinfoil/usage.js';

describe('parseUsageMetrics', () => {
  it('reads the trailer of the enclave by name', () => {
    expect(
      parseUsageMetrics('prompt=74,completion=32,total=106,model=gpt-oss-120b,cost_usd=0.0000303'),
    ).toEqual({
      usage: { inputTokens: 74, outputTokens: 32 },
      costUsd: 0.0000303,
      webSearchCalls: 0,
    });
  });

  it('counts the searches of the web of an answer, whose cost holds their fee', () => {
    expect(
      parseUsageMetrics(
        'prompt=1000,completion=500,total=1500,model=gpt-oss-120b,web_search_calls=2,cost_usd=0.052',
      ),
    ).toEqual({
      usage: { inputTokens: 1000, outputTokens: 500 },
      costUsd: 0.052,
      webSearchCalls: 2,
    });
  });

  it('takes the pairs in any order, and no cost when there is none', () => {
    expect(parseUsageMetrics('model=kimi-k3,completion=5, prompt=9')).toEqual({
      usage: { inputTokens: 9, outputTokens: 5 },
      costUsd: null,
      webSearchCalls: 0,
    });
  });

  it.each([null, '', 'model=x', 'prompt=abc,completion=1', 'prompt=-1,completion=1'])(
    'gives null for %s',
    (value) => {
      expect(parseUsageMetrics(value)).toBeNull();
    },
  );
});

describe('answerSpend', () => {
  const cost = { inputUsdPerMTok: 2, outputUsdPerMTok: 10 };

  it('takes the reported cost first, with the reported tokens', () => {
    const usage = { inputTokens: 1, outputTokens: 1 };
    expect(answerSpend(0.5, usage, cost)).toEqual({ costUsd: 0.5, usage, webSearches: 0 });
    expect(answerSpend(0.5, usage, cost, 2).webSearches).toBe(2);
  });

  it('prices the tokens at the cost of the model when nothing is reported', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000 };
    expect(answerSpend(null, usage, cost).costUsd).toBe(3);
  });

  it('counts one typical chat when even the tokens are unknown', () => {
    const { inputTokens, outputTokens } = TRIAL.fallbackUsage;
    const spend = answerSpend(null, null, cost);
    expect(spend.usage).toEqual(TRIAL.fallbackUsage);
    expect(spend.costUsd).toBeCloseTo((inputTokens * 2 + outputTokens * 10) / 1_000_000);
  });

  it('counts no cost for a model without one', () => {
    expect(answerSpend(null, null, null).costUsd).toBe(0);
  });
});
