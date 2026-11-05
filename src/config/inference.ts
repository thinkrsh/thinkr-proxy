// Thinkr Inference (decision 45): an OpenAI-compatible API. Its SDK (apps/sdk/) verifies and seals a
// chat of the private lane as the app does (decision 64). A chat of the modes ZDR and Open comes as
// plain JSON and goes to OpenRouter (the owner, 1 Nov 2026: "ok gas bikin buat ZDR sama Open"). An
// API key is a balance of its own: credit moves onto it from the balance of the app, as much as the
// user sets as its limit, holder vouchers or top-ups alike (the owner, 30 Oct 2026: "bikin aja sama
// kaya venice orbio dll").

/**
 * Where a developer makes a key and adds credit to it: the app since 30 Oct 2026 (apps/app/,
 * ROUTES.keys), in place of the dashboard.
 */
const KEYS_PAGE_URL = 'https://chat.thinkr.sh/keys';

export const INFERENCE = {
  /**
   * The routes of the API, under the base path of the proxy. api.thinkr.sh rewrites /v1/* to
   * /api/inference/v1/* (scripts/chat/chat.caddy); dash.thinkr.sh passes /api/inference/* on for
   * its page of keys (scripts/dash/dash.caddy).
   */
  basePath: '/inference',
  modelsPath: '/v1/models',
  attestationPath: '/v1/attestation',
  balancePath: '/v1/balance',
  redeemPath: '/v1/keys/redeem',
  fillPath: '/v1/keys/fill',
  closePath: '/v1/keys/close',
  /** The least and the most that one call moves onto a key, in USD: one cent up to a sanity cap. */
  minFillUsd: 0.01,
  maxFillUsd: 1_000_000,
  /** An API key is this prefix and the secret of a balance (`CREDIT.balanceSecretBytes`). */
  keyPrefix: 'thkr_',
  /** The scheme of the Authorization header that carries the key, as the OpenAI API has it. */
  authScheme: 'Bearer',
  /**
   * Requests a minute per client address, apart from the limit of the chat, since one developer's
   * code calls more often than one person types (a choice of 29 Oct 2026, not a measurement).
   */
  requestsPerWindow: 60,
  /**
   * A caller that cannot send raw bytes, such as Postman (the owner, 30 Oct 2026), names this
   * encoding on an encrypted chat. The proxy decodes the text back to the encrypted frames, and
   * answers with the encrypted answer in the same encoding; it never opens either.
   */
  bodyEncodingHeader: 'X-Thinkr-Body-Encoding',
  bodyEncoding: 'base64url',
  /**
   * What starts the id of a model of each mode of the open lane, so that an id names its mode and a
   * client can tell from the id alone that the chat goes unencrypted. A model that moves to another
   * mode changes its id, so a call never reaches a mode that its code did not name. Must match
   * API.plainModelPrefixes in apps/sdk/src/config/api.ts.
   */
  modelPrefix: { zdr: 'zdr/', open: 'open/' },
  /**
   * The fields of a plain chat that go on to OpenRouter as they come, from its list of parameters
   * (openrouter.ai/docs/api/reference/parameters.md, read on 1 Nov 2026). `model`, `messages`,
   * `stream`, `tools`, and the longest answer have rules of their own in inference/plain-chat.ts.
   * Everything else stays out, above all what would change the privacy or the price of the chat:
   * `provider`, `models`, `route`, `plugins`, `web_search_options`, `transforms`, and `user`.
   */
  plainChatFields: [
    'temperature',
    'top_p',
    'top_k',
    'frequency_penalty',
    'presence_penalty',
    'repetition_penalty',
    'min_p',
    'top_a',
    'seed',
    'stop',
    'logit_bias',
    'logprobs',
    'top_logprobs',
    'response_format',
    'structured_outputs',
    'tool_choice',
    'parallel_tool_calls',
    'reasoning',
    'reasoning_effort',
    'verbosity',
  ],
  /**
   * The fields of an answer of OpenRouter that reach the caller. `provider` and the cost in `usage`
   * stay out, since the API shows the price that the user pays, never what a provider charged.
   */
  answerFields: ['id', 'object', 'created', 'choices', 'system_fingerprint', 'service_tier'],
  usageFields: [
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'prompt_tokens_details',
    'completion_tokens_details',
  ],
  /**
   * The chats of ZDR and Open that one key may have running. A running chat is not paid yet, so this
   * bounds what a key with little credit can spend at once (a choice of 1 Nov 2026, not a measurement).
   */
  maxOpenChatsPerKey: 16,
  /**
   * A chat with no stream sends a space this often while it waits for its answer: Cloudflare gives
   * up on a silent answer after 100 seconds and a JSON parser skips the spaces. An answer sooner
   * than this comes with the status of its own outcome.
   */
  heartbeatMs: 20_000,
  heartbeat: ' ',
  /** The longest message of a provider that the API passes on. */
  maxUpstreamMessageChars: 500,
  /** The most holder vouchers that one call spends into a key; more go in several calls. */
  maxVouchersPerRedeem: 100,
  keysPageUrl: KEYS_PAGE_URL,
  messages: {
    keyRequired: 'Send your API key in the Authorization header, as Bearer thkr_….',
    keyUnknown: `This API key holds no credit yet. Add credit to it at ${KEYS_PAGE_URL}.`,
    creditLow: `This API key has too little credit left for this call. Add credit at ${KEYS_PAGE_URL}.`,
    holderOnly: 'Only holder vouchers fill an API key through this route.',
    keyIsBalance: 'An API key cannot take credit from itself.',
    balanceUnknown: 'This balance holds no credit yet.',
    fillLow: 'Your balance has too little credit for this limit.',
    encodingUnknown: 'X-Thinkr-Body-Encoding takes only base64url.',
    encodedBodyInvalid: 'The body is not valid base64url.',
    privateEncrypted:
      'Models of the private lane take only requests encrypted on your machine. Call them with the Thinkr SDK or its local bridge.',
    modelUnknown: 'The API has no such model. GET /v1/models lists its models.',
    partUnknown: 'A message takes text, or parts of the types text and image_url.',
    toolUnknown: 'The API takes tools of the type function only.',
    tooManyOpen: (limit: number): string =>
      `This API key has ${String(limit)} chats running. Wait for one of them to end.`,
  },
} as const;
