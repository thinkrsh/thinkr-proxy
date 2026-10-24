// The model catalog: what the app lists, and how the proxy reaches each model.
//
// Sources, read on 20 Oct 2026:
// - ZDR endpoints and prices: GET https://openrouter.ai/api/v1/endpoints/zdr. Each price is the
//   cheapest healthy ZDR endpoint (status 0, uptime over the last day of 90% or more, no priority or
//   flex tier) for one chat of 1,000 input and 500 output tokens (docs/CONCEPT.md). OpenRouter may
//   route a request to a pricier ZDR endpoint, so the price is a lower bound ("from").
// - Context windows: GET https://openrouter.ai/api/v1/models.
// - Private lane (decisions 49 and 64): the models of Tinfoil, which the app seals on the device and
//   the proxy forwards (routes/private.ts). Prices, context windows, and capabilities: GET
//   https://api.tinfoil.sh/api/config/models; the context of a chat is its chatConfig value where
//   that is smaller. Model ids: GET https://inference.tinfoil.sh/v1/models.
// - The treasury of THKR in the issuer sells only the model cost of the credit it bought: the share
//   of the priciest model of the private lane, TOKEN_TREASURY.costShareBps in
//   apps/issuer/src/config/token.ts (13,637 on 24 Oct 2026). Change it with these prices.
// - The prices of decisions 132 and 134, from the public price lists of Tinfoil (above) and Venice
//   (GET https://api.venice.ai/api/v1/models?type=text), read on 22 Oct 2026. The same prices
//   stand on thinkr.sh/pricing (apps/site/src/config/pricing.ts), next to the priciest of the two,
//   which the page does not name.
// - Images and video (the owner, 23 Oct 2026), read on 23 Oct 2026: the image models with a ZDR
//   endpoint from GET https://openrouter.ai/api/v1/endpoints/zdr and GET
//   https://openrouter.ai/api/v1/models?output_modalities=image; the image models with none at the
//   level Open; video at the level Open only, since OpenRouter routes no video job under zero data
//   retention; durations, resolutions, sound, and prices of video from GET
//   https://openrouter.ai/api/v1/videos/models. Each estimate of a cost is for the settings below.
import type { ModelInfo, ModelPricing } from '../contract.js';

/** What the catalog knows of a model. The proxy adds the price that the user pays. */
export type CatalogInfo = Omit<ModelInfo, 'pricing' | 'media'>;

/**
 * How OpenRouter takes an image request: a chat completion, which can force zero data retention,
 * with what the model answers with (Gemini writes a line of text beside its image, others only
 * draw); or the Images API, which some models need ("cannot be used with the chat/completions
 * endpoint", FLUX 3, 23 Oct 2026) and which takes no data policy, so the level Open only.
 */
export type ImageApi =
  | { readonly name: 'chat'; readonly modalities: readonly ('image' | 'text')[] }
  | { readonly name: 'images' };

/** What the proxy asks of an image model, and what one image costs Thinkr, about. */
export interface ImageSettings {
  readonly kind: 'image';
  /** The shape of the image. */
  readonly aspectRatio: string;
  readonly api: ImageApi;
  /**
   * One image at the provider, about: the price that the app shows and the least a balance must
   * hold. A paid image costs the cost that OpenRouter reports, plus 25% (decision 52).
   */
  readonly costUsd: number;
}

/** What the proxy asks of a video model (16:9, 720p, the shortest length), and its cost, about. */
export interface VideoSettings {
  readonly kind: 'video';
  readonly aspectRatio: string;
  readonly seconds: number;
  readonly resolution: string;
  /** Sound with the video, for the models that make it. */
  readonly audio: boolean;
  /**
   * One video at the provider, about: plus 25%, what a balance pays ahead. Once the job ends, the
   * balance pays the cost that OpenRouter reports, plus 25% (decision 52), and gets the rest back.
   */
  readonly costUsd: number;
}

export type MediaSettings = ImageSettings | VideoSettings;

export interface CatalogModel {
  readonly info: CatalogInfo;
  /** The OpenRouter model slug. Null in the private lane, which never goes through OpenRouter. */
  readonly openRouterSlug: string | null;
  /** What the provider charges Thinkr for a million tokens. */
  readonly cost: ModelPricing | null;
  /**
   * The price of decision 134 for a million tokens: 25% under the priciest of Tinfoil and Venice
   * for a chat of 1,000 tokens in and 500 out, input and output apart, rounded down to the cent;
   * under both, and under the cost on most models, on purpose ("gpp rugi kita bakar uang dulu buat
   * narik user", decision 132). A paid chat costs its tokens at this price, whatever the provider
   * charged. Null: a paid chat costs what its answer cost, plus 25% (decision 52).
   */
  readonly price: ModelPricing | null;
  /** An image or a video model: what the proxy asks of it. Absent for a model of text. */
  readonly media?: MediaSettings;
}

// The default (decision 64): GPT-OSS 120B in the private lane, the model of Free (decision 52).
export const DEFAULT_MODEL_ID = 'private/gpt-oss-120b';

export const MODEL_CATALOG: readonly CatalogModel[] = [
  // The private lane comes first: it is the default (decision 10).
  {
    openRouterSlug: null,
    cost: { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.6 },
    price: { inputUsdPerMTok: 0.09, outputUsdPerMTok: 0.48 },
    info: {
      id: 'private/gpt-oss-120b',
      name: 'GPT-OSS 120B',
      maker: 'OpenAI',
      makerSlug: 'openai',
      kind: 'text',
      lane: 'private',
      privacy: 'private-verified',
      description: "OpenAI's open-weight reasoning model, quick and light.",
      contextTokens: 131_072,
      reasoning: true,
      vision: false,
      available: true,
      teeModelId: 'gpt-oss-120b',
    },
  },
  {
    openRouterSlug: null,
    cost: { inputUsdPerMTok: 0.65, outputUsdPerMTok: 1.45 },
    price: { inputUsdPerMTok: 0.48, outputUsdPerMTok: 1.08 },
    info: {
      id: 'private/deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      maker: 'DeepSeek',
      makerSlug: 'deepseek',
      kind: 'text',
      lane: 'private',
      privacy: 'private-verified',
      description: "DeepSeek's fast open-weight model, with a long context and image input.",
      contextTokens: 524_288,
      reasoning: true,
      vision: true,
      available: true,
      teeModelId: 'deepseek-v4-1-flash',
    },
  },
  {
    openRouterSlug: null,
    cost: { inputUsdPerMTok: 4, outputUsdPerMTok: 20 },
    price: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
    info: {
      id: 'private/kimi-k3',
      name: 'Kimi K3',
      maker: 'Moonshot AI',
      makerSlug: 'moonshot',
      kind: 'text',
      lane: 'private',
      privacy: 'private-verified',
      description:
        "Moonshot AI's largest open-weight model, for hard reasoning, code, and long tasks.",
      contextTokens: 262_144,
      reasoning: true,
      vision: true,
      available: true,
      teeModelId: 'kimi-k3',
    },
  },
  {
    openRouterSlug: null,
    cost: { inputUsdPerMTok: 1.8, outputUsdPerMTok: 5.75 },
    price: { inputUsdPerMTok: 1.35, outputUsdPerMTok: 4.31 },
    info: {
      id: 'private/glm-5.3',
      name: 'GLM-5.3',
      maker: 'Z.ai',
      makerSlug: 'zai',
      kind: 'text',
      lane: 'private',
      privacy: 'private-verified',
      description: "Z.ai's open-weight flagship for coding and long, multi-step work.",
      contextTokens: 524_288,
      reasoning: true,
      vision: false,
      available: true,
      teeModelId: 'glm-5-3',
    },
  },
  {
    openRouterSlug: null,
    cost: { inputUsdPerMTok: 0.4, outputUsdPerMTok: 1 },
    price: { inputUsdPerMTok: 0.3, outputUsdPerMTok: 0.75 },
    info: {
      id: 'private/gemma-4-31b',
      name: 'Gemma 4 31B',
      maker: 'Google',
      makerSlug: 'google',
      kind: 'text',
      lane: 'private',
      privacy: 'private-verified',
      description: "Google's open-weight model for everyday tasks, with image input.",
      contextTokens: 262_144,
      reasoning: true,
      vision: true,
      available: true,
      teeModelId: 'gemma4-31b',
    },
  },
  {
    openRouterSlug: null,
    cost: { inputUsdPerMTok: 1.75, outputUsdPerMTok: 2.75 },
    price: { inputUsdPerMTok: 1.31, outputUsdPerMTok: 2.06 },
    info: {
      id: 'private/llama-3.3-70b',
      name: 'Llama 3.3 70B',
      maker: 'Meta',
      makerSlug: 'meta',
      kind: 'text',
      lane: 'private',
      privacy: 'private-verified',
      description: "Meta's open-weight model for fast chat in many languages.",
      contextTokens: 131_072,
      reasoning: false,
      vision: false,
      available: true,
      teeModelId: 'llama3-3-70b',
    },
  },
  // The open lane, level 2: every request forces zero data retention.
  {
    // ZDR: Amazon Bedrock, Google Vertex. Price: amazon-bedrock.
    openRouterSlug: 'anthropic/claude-opus-5.5',
    cost: { inputUsdPerMTok: 4, outputUsdPerMTok: 20 },
    price: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
    info: {
      id: 'open/claude-opus-5.5',
      name: 'Claude Opus 5.5',
      maker: 'Anthropic',
      makerSlug: 'anthropic',
      kind: 'text',
      lane: 'open',
      privacy: 'open-no-retention',
      description:
        "Anthropic's flagship model for hard reasoning, coding, and long, multi-step work.",
      contextTokens: 1_000_000,
      reasoning: true,
      vision: true,
      available: true,
      teeModelId: null,
    },
  },
  {
    // ZDR: Google Vertex, Amazon Bedrock. Price: google-vertex/global.
    openRouterSlug: 'anthropic/claude-sonnet-5.5',
    cost: { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
    price: null,
    info: {
      id: 'open/claude-sonnet-5.5',
      name: 'Claude Sonnet 5.5',
      maker: 'Anthropic',
      makerSlug: 'anthropic',
      kind: 'text',
      lane: 'open',
      privacy: 'open-no-retention',
      description: "Anthropic's balanced model for everyday writing, analysis, and code.",
      contextTokens: 1_000_000,
      reasoning: true,
      vision: true,
      available: true,
      teeModelId: null,
    },
  },
  {
    // ZDR: Google Vertex, Amazon Bedrock. Price: google-vertex/global.
    openRouterSlug: 'anthropic/claude-haiku-5.5',
    cost: { inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 },
    price: { inputUsdPerMTok: 0.07, outputUsdPerMTok: 0.37 },
    info: {
      id: 'open/claude-haiku-5.5',
      name: 'Claude Haiku 5.5',
      maker: 'Anthropic',
      makerSlug: 'anthropic',
      kind: 'text',
      lane: 'open',
      privacy: 'open-no-retention',
      description: "Anthropic's small, fast model for quick answers and summaries.",
      contextTokens: 1_000_000,
      reasoning: true,
      vision: true,
      available: true,
      teeModelId: null,
    },
  },
  {
    // ZDR: Azure. Price: azure/eu, the only healthy Azure endpoint on the day.
    openRouterSlug: 'openai/gpt-6.1-sol',
    cost: { inputUsdPerMTok: 2.2, outputUsdPerMTok: 11 },
    price: { inputUsdPerMTok: 1.5, outputUsdPerMTok: 7.5 },
    info: {
      id: 'open/gpt-6.1-sol',
      name: 'GPT-6.1 Sol',
      maker: 'OpenAI',
      makerSlug: 'openai',
      kind: 'text',
      lane: 'open',
      privacy: 'open-no-retention',
      description: "OpenAI's upgrade to GPT-6 Sol for analysis, documents, and code.",
      contextTokens: 1_050_000,
      reasoning: true,
      vision: true,
      available: true,
      teeModelId: null,
    },
  },
  {
    // ZDR: Azure. Price: azure.
    openRouterSlug: 'openai/gpt-6-luna',
    cost: { inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 },
    price: { inputUsdPerMTok: 0.07, outputUsdPerMTok: 0.37 },
    info: {
      id: 'open/gpt-6-luna',
      name: 'GPT-6 Luna',
      maker: 'OpenAI',
      makerSlug: 'openai',
      kind: 'text',
      lane: 'open',
      privacy: 'open-no-retention',
      description: "OpenAI's fast, low-cost GPT-6 model for everyday chat.",
      contextTokens: 1_050_000,
      reasoning: true,
      vision: true,
      available: true,
      teeModelId: null,
    },
  },
  {
    // ZDR: Google Vertex. Price: google-vertex/us.
    openRouterSlug: 'google/gemini-3.8-flash',
    cost: { inputUsdPerMTok: 0.825, outputUsdPerMTok: 4.125 },
    price: { inputUsdPerMTok: 0.7, outputUsdPerMTok: 3.51 },
    info: {
      id: 'open/gemini-3.8-flash',
      name: 'Gemini 3.8 Flash',
      maker: 'Google',
      makerSlug: 'google',
      kind: 'text',
      lane: 'open',
      privacy: 'open-no-retention',
      description: "Google's fast Flash model with strong reasoning and coding.",
      contextTokens: 1_048_576,
      reasoning: true,
      vision: true,
      available: true,
      teeModelId: null,
    },
  },
  {
    // ZDR: xAI, through its ZDR endpoint. Price: xai/zdr.
    openRouterSlug: 'x-ai/grok-4.7',
    cost: { inputUsdPerMTok: 2, outputUsdPerMTok: 6 },
    price: { inputUsdPerMTok: 1.7, outputUsdPerMTok: 5.1 },
    info: {
      id: 'open/grok-4.7',
      name: 'Grok 4.7',
      maker: 'SpaceXAI',
      makerSlug: 'xai',
      kind: 'text',
      lane: 'open',
      privacy: 'open-no-retention',
      description: "SpaceXAI's flagship Grok model for coding and knowledge work.",
      contextTokens: 500_000,
      reasoning: true,
      vision: true,
      available: true,
      teeModelId: null,
    },
  },
  {
    // ZDR: 24 providers, among them DeepInfra, Fireworks, Together, and Nebius.
    // Price: open-inference/fp4.
    openRouterSlug: 'deepseek/deepseek-v4.1-flash',
    cost: { inputUsdPerMTok: 0.032, outputUsdPerMTok: 0.08 },
    price: null,
    info: {
      id: 'open/deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      maker: 'DeepSeek',
      makerSlug: 'deepseek',
      kind: 'text',
      lane: 'open',
      privacy: 'open-no-retention',
      description: "DeepSeek's fast, low-cost model with a context of one million tokens.",
      contextTokens: 1_048_576,
      reasoning: true,
      vision: true,
      available: true,
      teeModelId: null,
    },
  },
  {
    // ZDR: 26 providers, among them Fireworks, Together, Z.AI, and Near AI.
    // Price: open-inference/fp4.
    openRouterSlug: 'z-ai/glm-5.3-flash',
    cost: { inputUsdPerMTok: 0.048, outputUsdPerMTok: 0.16 },
    price: null,
    info: {
      id: 'open/glm-5.3-flash',
      name: 'GLM 5.3 Flash',
      maker: 'Z.ai',
      makerSlug: 'zai',
      kind: 'text',
      lane: 'open',
      privacy: 'open-no-retention',
      description: "Z.ai's fast multimodal model for coding and long tasks.",
      contextTokens: 1_048_576,
      reasoning: true,
      vision: true,
      available: true,
      teeModelId: null,
    },
  },
  {
    // ZDR: 18 providers, among them Fireworks, Together, Amazon Bedrock, and Moonshot AI.
    // Price: relace/fp4.
    openRouterSlug: 'moonshotai/kimi-k3',
    cost: { inputUsdPerMTok: 0.8, outputUsdPerMTok: 3 },
    price: null,
    info: {
      id: 'open/kimi-k3',
      name: 'Kimi K3',
      maker: 'Moonshot AI',
      makerSlug: 'moonshot',
      kind: 'text',
      lane: 'open',
      privacy: 'open-no-retention',
      description: "Moonshot AI's open-weight reasoning model for complex, long work.",
      contextTokens: 1_048_576,
      reasoning: true,
      vision: true,
      available: true,
      teeModelId: null,
    },
  },
  {
    // ZDR: Novita, SiliconFlow, Venice, Together. Price: novita.
    openRouterSlug: 'qwen/qwen3.8-2.4t-a95b',
    cost: { inputUsdPerMTok: 2, outputUsdPerMTok: 6 },
    price: null,
    info: {
      id: 'open/qwen3.8-2.4t',
      name: 'Qwen3.8 2.4T',
      maker: 'Qwen',
      makerSlug: 'qwen',
      kind: 'text',
      lane: 'open',
      privacy: 'open-no-retention',
      description: "Qwen's largest open-weight model, for hard reasoning and code.",
      contextTokens: 1_048_576,
      reasoning: true,
      vision: false,
      available: true,
      teeModelId: null,
    },
  },
  {
    // ZDR: 10 providers, 4 of them healthy on the day, among them CoreWeave, Venice, and Parasail.
    // Price: coreweave/fp4.
    openRouterSlug: 'google/gemma-4-31b-it',
    cost: { inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.34 },
    price: null,
    info: {
      id: 'open/gemma-4-31b',
      name: 'Gemma 4 31B',
      maker: 'Google',
      makerSlug: 'google',
      kind: 'text',
      lane: 'open',
      privacy: 'open-no-retention',
      description: "Google's open-weight 31B model, with image input.",
      contextTokens: 262_144,
      reasoning: true,
      vision: true,
      available: true,
      teeModelId: null,
    },
  },
  // Images of the lane ZDR: models with an endpoint of zero data retention.
  {
    // ZDR: Google Vertex (google-vertex/global). Cost: an image of 1,120 tokens at $120 a million
    // output tokens, with the prompt, about $0.14.
    openRouterSlug: 'google/gemini-3-pro-image',
    cost: null,
    price: null,
    media: {
      kind: 'image',
      aspectRatio: '16:9',
      api: { name: 'chat', modalities: ['image', 'text'] },
      costUsd: 0.14,
    },
    info: {
      id: 'open/nano-banana-pro',
      name: 'Nano Banana Pro',
      maker: 'Google',
      makerSlug: 'google',
      kind: 'image',
      lane: 'open',
      privacy: 'open-no-retention',
      description: "Google's most advanced image model, built on Gemini 3 Pro.",
      contextTokens: 0,
      reasoning: false,
      vision: false,
      available: true,
      teeModelId: null,
    },
  },
  {
    // ZDR: Google Vertex (google-vertex/global and us). Cost: an image of 1,120 tokens at $60 a
    // million output tokens, with the prompt, about $0.07.
    openRouterSlug: 'google/gemini-3.1-flash-image',
    cost: null,
    price: null,
    media: {
      kind: 'image',
      aspectRatio: '16:9',
      api: { name: 'chat', modalities: ['image', 'text'] },
      costUsd: 0.07,
    },
    info: {
      id: 'open/nano-banana-2',
      name: 'Nano Banana 2',
      maker: 'Google',
      makerSlug: 'google',
      kind: 'image',
      lane: 'open',
      privacy: 'open-no-retention',
      description: "Google's fast image model, built on Gemini 3.1 Flash.",
      contextTokens: 0,
      reasoning: false,
      vision: false,
      available: true,
      teeModelId: null,
    },
  },
  {
    // ZDR: Seed. Cost: an image of about 4,175 tokens at $10.78 a million, about $0.05.
    openRouterSlug: 'bytedance-seed/seedream-5-0-pro',
    cost: null,
    price: null,
    media: {
      kind: 'image',
      aspectRatio: '16:9',
      api: { name: 'chat', modalities: ['image'] },
      costUsd: 0.05,
    },
    info: {
      id: 'open/seedream-5.0-pro',
      name: 'Seedream 5.0 Pro',
      maker: 'ByteDance Seed',
      makerSlug: 'bytedance',
      kind: 'image',
      lane: 'open',
      privacy: 'open-no-retention',
      description: "ByteDance's image model for lifelike scenes and natural light.",
      contextTokens: 0,
      reasoning: false,
      vision: false,
      available: true,
      teeModelId: null,
    },
  },
  {
    // ZDR: Azure. Cost: an image of 1,024 tokens at $38 a million, $0.039 on a test of 23 Oct
    // 2026, about $0.04.
    openRouterSlug: 'microsoft/mai-image-2.6',
    cost: null,
    price: null,
    media: {
      kind: 'image',
      aspectRatio: '16:9',
      api: { name: 'chat', modalities: ['image'] },
      costUsd: 0.04,
    },
    info: {
      id: 'open/mai-image-2.6',
      name: 'MAI-Image-2.6',
      maker: 'Microsoft AI',
      makerSlug: 'microsoft',
      kind: 'image',
      lane: 'open',
      privacy: 'open-no-retention',
      description: "Microsoft's image model for detailed, design-ready pictures.",
      contextTokens: 0,
      reasoning: false,
      vision: false,
      available: true,
      teeModelId: null,
    },
  },
  // Images of the level Open: no endpoint of zero data retention, so the provider may keep them.
  {
    // No ZDR endpoint. Cost: a picture of 16:9 at high quality was $0.13 in the docs of OpenRouter.
    openRouterSlug: 'openai/gpt-image-2',
    cost: null,
    price: null,
    media: { kind: 'image', aspectRatio: '16:9', api: { name: 'images' }, costUsd: 0.13 },
    info: {
      id: 'open/gpt-image-2',
      name: 'GPT Image 2',
      maker: 'OpenAI',
      makerSlug: 'openai',
      kind: 'image',
      lane: 'open',
      privacy: 'open',
      description: "OpenAI's latest image model.",
      contextTokens: 0,
      reasoning: false,
      vision: false,
      available: true,
      teeModelId: null,
    },
  },
  {
    // No ZDR endpoint. Cost: an image of about 4,175 tokens at $9.82 a million, about $0.04.
    openRouterSlug: 'black-forest-labs/flux-3-image',
    cost: null,
    price: null,
    media: { kind: 'image', aspectRatio: '16:9', api: { name: 'images' }, costUsd: 0.04 },
    info: {
      id: 'open/flux-3',
      name: 'FLUX 3',
      maker: 'Black Forest Labs',
      makerSlug: 'bfl',
      kind: 'image',
      lane: 'open',
      privacy: 'open',
      description: "Black Forest Labs' flagship image model.",
      contextTokens: 0,
      reasoning: false,
      vision: false,
      available: true,
      teeModelId: null,
    },
  },
  {
    // No ZDR endpoint. Cost: $0.01 an image and about 4,175 tokens at $9.58 a million, about $0.05.
    openRouterSlug: 'x-ai/grok-imagine-image-2.0',
    cost: null,
    price: null,
    media: { kind: 'image', aspectRatio: '16:9', api: { name: 'images' }, costUsd: 0.05 },
    info: {
      id: 'open/grok-imagine-2',
      name: 'Grok Imagine',
      maker: 'SpaceXAI',
      makerSlug: 'xai',
      kind: 'image',
      lane: 'open',
      privacy: 'open',
      description: "SpaceXAI's image model, Grok Imagine Image 2.0.",
      contextTokens: 0,
      reasoning: false,
      vision: false,
      available: true,
      teeModelId: null,
    },
  },
  // Video, at the level Open only: OpenRouter routes no video job under zero data retention.
  {
    // Cost: $0.40 a second with sound, 4 seconds, $1.60.
    openRouterSlug: 'google/veo-3.1',
    cost: null,
    price: null,
    media: {
      kind: 'video',
      aspectRatio: '16:9',
      seconds: 4,
      resolution: '720p',
      audio: true,
      costUsd: 1.6,
    },
    info: {
      id: 'open/veo-3.1',
      name: 'Veo 3.1',
      maker: 'Google',
      makerSlug: 'google',
      kind: 'video',
      lane: 'open',
      privacy: 'open',
      description: "Google's video model, with sound made with the picture.",
      contextTokens: 0,
      reasoning: false,
      vision: false,
      available: true,
      teeModelId: null,
    },
  },
  {
    // Cost: $7 a million video tokens; 4 seconds of 1280 by 720 at 24 frames make about 86,400
    // tokens, about $0.61.
    openRouterSlug: 'bytedance/seedance-2.0',
    cost: null,
    price: null,
    media: {
      kind: 'video',
      aspectRatio: '16:9',
      seconds: 4,
      resolution: '720p',
      audio: true,
      costUsd: 0.61,
    },
    info: {
      id: 'open/seedance-2.0',
      name: 'Seedance 2.0',
      maker: 'ByteDance Seed',
      makerSlug: 'bytedance',
      kind: 'video',
      lane: 'open',
      privacy: 'open',
      description: "ByteDance's video model, strong at keeping a character the same in every shot.",
      contextTokens: 0,
      reasoning: false,
      vision: false,
      available: true,
      teeModelId: null,
    },
  },
  {
    // Cost: $0.168 a second with sound, 3 seconds, about $0.50.
    openRouterSlug: 'kwaivgi/kling-v3.0-pro',
    cost: null,
    price: null,
    media: {
      kind: 'video',
      aspectRatio: '16:9',
      seconds: 3,
      resolution: '720p',
      audio: true,
      costUsd: 0.5,
    },
    info: {
      id: 'open/kling-3.0-pro',
      name: 'Kling 3.0 Pro',
      maker: 'Kuaishou',
      makerSlug: 'kling',
      kind: 'video',
      lane: 'open',
      privacy: 'open',
      description: "Kuaishou's premium video model, Kling Video 3.0 Pro.",
      contextTokens: 0,
      reasoning: false,
      vision: false,
      available: true,
      teeModelId: null,
    },
  },
  {
    // Cost: $0.10 a second at 720p, 2 seconds, $0.20.
    openRouterSlug: 'alibaba/wan-3.0',
    cost: null,
    price: null,
    media: {
      kind: 'video',
      aspectRatio: '16:9',
      seconds: 2,
      resolution: '720p',
      audio: true,
      costUsd: 0.2,
    },
    info: {
      id: 'open/wan-3.0',
      name: 'Wan 3.0',
      maker: 'Alibaba',
      makerSlug: 'alibaba',
      kind: 'video',
      lane: 'open',
      privacy: 'open',
      description: "Alibaba's video model, with sound.",
      contextTokens: 0,
      reasoning: false,
      vision: false,
      available: true,
      teeModelId: null,
    },
  },
];
