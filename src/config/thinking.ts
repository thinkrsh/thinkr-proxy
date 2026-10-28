// Think in the message box of the app (28 Oct 2026; the owner: "by default thinking button nya harus
// ada", "default nyala"): a model of text that can think does so before it answers, unless the user
// turns Think off. Read on 28 Oct 2026: openrouter.ai/docs/guides/best-practices/reasoning-tokens.md,
// the `reasoning` of each model in GET https://openrouter.ai/api/v1/models, and
// `chatConfig.reasoningConfig` of each model in GET https://api.tinfoil.sh/api/config/models.

/** What OpenRouter takes to make a model think, or to stop it. */
export const REASONING = {
  /** Thinking at the effort that OpenRouter calls medium. */
  on: { enabled: true },
  /**
   * No thinking. A model of `ALWAYS_THINKING` refuses it: "Reasoning is mandatory for this endpoint
   * and cannot be disabled." (GLM 5.3 Flash, a test call of 28 Oct 2026).
   */
  off: { effort: 'none' },
  /**
   * Think off for a model of `ALWAYS_THINKING` ("bukan berarti engga bisa di toogle on / off", the
   * owner, 29 Oct 2026): it thinks as little as it takes. On 29 Oct 2026 GLM 5.3 Flash thought 7
   * tokens in place of 23, and MiniMax M2.7, which names no efforts, 76 in place of 166.
   */
  least: { effort: 'low' },
} as const;

export type ReasoningRequest = (typeof REASONING)[keyof typeof REASONING];

/**
 * The models that think before every answer, so Think off only makes them think less: in the open
 * lane those whose `reasoning.mandatory` is true, and in the private lane those whose
 * `reasoningConfig` takes no `disable`.
 */
export const ALWAYS_THINKING: ReadonlySet<string> = new Set([
  'open/aion-3.0',
  'open/aion-3.0-mini',
  'open/aion-3.5',
  'open/aion-3.5-mini',
  'open/claude-fable-5',
  'open/claude-fable-5.1',
  'open/claude-opus-5.5',
  'open/claude-sonnet-5.5',
  'open/gemini-2.5-pro',
  'open/gemini-3.1-pro-preview',
  'open/gemini-3.5-flash-lite',
  'open/gemini-3.7-flash',
  'open/gemini-3.8-flash',
  'open/gemini-4-argon',
  'open/glm-5.3',
  'open/glm-5.3-flash',
  'open/glm-5.3-flashx',
  'open/glm-5.3-prime',
  'open/gpt-5-mini',
  'open/gpt-5-nano',
  'open/gpt-5.1-codex-max',
  'open/gpt-5.1-codex-mini',
  'open/gpt-5.2-codex',
  'open/gpt-5.4-pro',
  'open/gpt-5.5-pro',
  'open/gpt-6-astra',
  'open/gpt-6-astra-pro',
  'open/gpt-6.1-sol',
  'open/gpt-6.1-sol-pro',
  'open/grok-4.20-multi-agent',
  'open/grok-4.6',
  'open/grok-4.7',
  'open/grok-build-0.1',
  'open/kimi-k2-thinking',
  'open/kimi-k2.7-code',
  'open/minimax-m2.7',
  'open/minimax-m3.1-flash',
  'open/muse-glimmer-30b',
  'open/muse-spark-1.2',
  'open/muse-spark-1.3',
  'open/muse-spark-open',
  'open/muse-wonder',
  'open/qwen3.8-2.4t',
  'open/qwen3.8-max',
  'open/qwen3.8-max-prime',
  'private/glm-5.3',
  'private/gpt-oss-120b',
  'private/kimi-k3',
]);

/**
 * The models of `ALWAYS_THINKING` that take no effort under the one they use by default, so Think off
 * asks them nothing and the app keeps Think on for them (29 Oct 2026): GPT-5.4 Pro and GPT-5.5 Pro
 * (`supported_efforts`: xhigh, high, medium; by default medium), and Kimi K3 of the private lane,
 * whose `reasoningConfig` takes no effort.
 */
export const NO_LESS_THINKING: ReadonlySet<string> = new Set([
  'open/gpt-5.4-pro',
  'open/gpt-5.5-pro',
  'private/kimi-k3',
]);

/**
 * The models of the open lane whose `reasoning` names no default, neither a `default_effort` nor
 * `default_enabled: true`, so Think asks them to think. Some think by themselves and some do not: on
 * 28 Oct 2026 Qwen3.5 9B thought when not asked, and Claude Haiku 4.5 and DeepSeek V3.2 did not.
 * Every other model that can think does so by itself, at the effort of its maker, and Think on leaves
 * that effort as it is.
 */
export const NO_DEFAULT_THINKING: ReadonlySet<string> = new Set([
  'open/claude-haiku-4.5',
  'open/deepseek-v3.1',
  'open/deepseek-v3.2',
  'open/gemma-4-26b-a4b',
  'open/gemma-4-31b',
  'open/glm-4.6v',
  'open/mimo-v2.5',
  'open/mimo-v2.5-pro',
  'open/mimo-v2.6-flash',
  'open/mimo-v2.6-pro',
  'open/mimo-v2.6-pro-ultraspeed',
  'open/minimax-m3',
  'open/nemotron-3-nano-30b-a3b',
  'open/nemotron-3.5-lightning',
  'open/nemotron-3.5-super-vl',
  'open/qwen3.5-122b-a10b',
  'open/qwen3.5-35b-a3b',
  'open/qwen3.5-397b-a17b',
  'open/qwen3.5-9b',
  'open/qwen3.5-plus',
  'open/seed-1.6',
  'open/seed-1.6-flash',
  'open/seed-2.1-turbo',
]);
