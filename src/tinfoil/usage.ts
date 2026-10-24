// Reads the usage that the enclave reports in a trailer of the sealed answer, such as
// "prompt=74,completion=32,total=106,model=gpt-oss-120b,cost_usd=0.0000303" (seen on 20 Oct 2026).
// An answer that searched the web adds "web_search_calls=2", and its cost_usd holds the fee of the
// search (docs.tinfoil.sh/guides/web-search.md, read 22 Oct 2026).
// The proxy asks for it with a request header; the pairs come in any order, so they are read by name.
import type { ChatUsage } from '../contract.js';

export interface UsageMetrics {
  readonly usage: ChatUsage;
  /** The cost at the published prices of Tinfoil, when the enclave reports one. */
  readonly costUsd: number | null;
  /** The searches and page fetches of the web in the answer; 0 when it did not search. */
  readonly webSearchCalls: number;
}

export function parseUsageMetrics(value: string | null): UsageMetrics | null {
  if (value === null) return null;
  const fields = new Map(
    value.split(',').map((pair) => {
      const equals = pair.indexOf('=');
      return [pair.slice(0, equals).trim(), pair.slice(equals + 1).trim()] as const;
    }),
  );
  const inputTokens = numberField(fields, 'prompt');
  const outputTokens = numberField(fields, 'completion');
  if (inputTokens === null || outputTokens === null) return null;
  return {
    usage: { inputTokens, outputTokens },
    costUsd: numberField(fields, 'cost_usd'),
    webSearchCalls: numberField(fields, 'web_search_calls') ?? 0,
  };
}

function numberField(fields: ReadonlyMap<string, string>, name: string): number | null {
  const raw = fields.get(name);
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
