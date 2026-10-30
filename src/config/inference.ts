// Thinkr Inference (decision 45): an OpenAI-compatible API for the models of the private lane, which
// its SDK (apps/sdk/) verifies and seals as the app does (decision 64). An API key is a balance of
// its own: credit moves onto it from the balance of the app, as much as the user sets as its limit,
// holder vouchers or top-ups alike (the owner, 30 Oct 2026: "bikin aja sama kaya venice orbio dll").

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
  },
} as const;
