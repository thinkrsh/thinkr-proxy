// Web search of the open lane (the owner, 29 Oct 2026: "ok web search di open lane"): the server
// tool `openrouter:web_search` of OpenRouter, run by Exa for every model, as the router of the
// private lane runs it with Exa too (docs.tinfoil.sh/guides/web-search.md). Read on 29 Oct 2026:
// openrouter.ai/docs/guides/features/server-tools/web-search.md, server-tools.md, and zdr.md. Zero
// data retention covers the model only: the searches go to Exa under its own data policy.
//
// A test call of 29 Oct 2026 (Claude Haiku 5.5 under ZDR, two searches) streamed one citation of
// each result as `delta.annotations` before the text, counted the searches in
// `usage.server_tool_use_details.web_search_requests`, and put $0.014 of searches into `usage.cost`.

/** The server tool that the proxy adds to a chat of the open lane while web search is on. */
export const WEB_SEARCH_TOOL = {
  type: 'openrouter:web_search',
  parameters: {
    /** Exa for every model, never the search of a provider, whose data policies differ. */
    engine: 'exa',
    /** Results of each search: the default of OpenRouter; Exa charges the same up to 10. */
    max_results: 5,
    /** The most searches of one answer, which bounds what an answer spends on them. */
    max_uses: 3,
  },
} as const;

/** What one search costs at Exa through OpenRouter in the mode `auto` (pricing table, 29 Oct 2026). */
export const WEB_SEARCH_COST_USD = 0.007;

/**
 * The models of text of the open lane that cannot search: no endpoint of theirs at their level
 * takes tools (`supported_parameters` of GET https://openrouter.ai/api/v1/models and of
 * /api/v1/endpoints/zdr, 29 Oct 2026).
 */
export const NO_WEB_SEARCH: ReadonlySet<string> = new Set([
  'open/grok-4.20-multi-agent',
  'open/minimax-m2-her',
  'open/mistral-large-3',
  'open/mistral-small-3',
]);
