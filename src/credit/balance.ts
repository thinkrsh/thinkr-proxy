// The arithmetic of a balance: its secret, the hashes that the ledger keeps, and the price of a
// chat: its tokens at the price of its model (decision 132), or else its cost plus 25% (decision 52).
import { CREDIT } from '../config/credit.js';
import type { CatalogModel, MediaSettings } from '../config/models.js';
import { WEB_SEARCH_TOOL } from '../config/webSearch.js';
import type { Lane, ModelPricing } from '../contract.js';
import { fromBase64Url, randomBytes, sha256, toBase64Url } from '../lib/bytes.js';
import { tokensUsd, type ChatSpend } from '../lib/cost.js';

const BALANCE_SECRET_PATTERN = /^[A-Za-z0-9_-]+$/;
const BALANCE_SECRET_CHARS = Math.ceil((CREDIT.balanceSecretBytes * 4) / 3);

export function newBalanceSecret(): string {
  return toBase64Url(randomBytes(CREDIT.balanceSecretBytes));
}

/** True for text with the shape of a balance secret. */
export function isBalanceSecret(text: string): boolean {
  return text.length === BALANCE_SECRET_CHARS && BALANCE_SECRET_PATTERN.test(text);
}

/** The ledger keeps this hash, so that a copy of the ledger cannot spend a balance. */
export async function balanceHash(secret: string): Promise<string> {
  return toBase64Url(await sha256(fromBase64Url(secret)));
}

export async function noteHash(nonce: Uint8Array): Promise<string> {
  return toBase64Url(await sha256(nonce));
}

/** The ledger keeps this hash of a settled video job, never the id that OpenRouter gave it. */
export async function jobHash(jobId: string): Promise<string> {
  return toBase64Url(await sha256(new TextEncoder().encode(jobId)));
}

export function usdToMicros(usd: number): number {
  return Math.ceil(usd * CREDIT.microsPerUsd);
}

export function microsToUsd(micros: number): number {
  return micros / CREDIT.microsPerUsd;
}

/**
 * What a million tokens of a model cost the user, as the app shows it: the price of the model
 * (decision 132), or else its cost plus 25% (decision 52). Null for a model with neither.
 */
export function userPricing(model: Pick<CatalogModel, 'cost' | 'price'>): ModelPricing | null {
  if (model.price !== null) return model.price;
  if (model.cost === null) return null;
  return {
    inputUsdPerMTok: model.cost.inputUsdPerMTok * CREDIT.markup,
    outputUsdPerMTok: model.cost.outputUsdPerMTok * CREDIT.markup,
  };
}

/**
 * What a chat costs the user: its tokens at the price of its model (decision 132), whatever the
 * provider charged, and its searches of the web; or else what its answer cost at the provider,
 * searches included, plus 25% (decision 52).
 */
export function chatPriceMicros(
  model: Pick<CatalogModel, 'price' | 'info'>,
  spend: ChatSpend,
): number {
  if (model.price === null) return usdToMicros(spend.costUsd * CREDIT.markup);
  const search = searchPriceUsd(model.info.lane, spend.webSearches);
  return usdToMicros(tokensUsd(spend.usage, model.price) + search);
}

/**
 * What the searches of the web of one answer cost the user: in the private lane, the price once
 * when the answer searched, however often (decision 142); in the open lane, the price of each
 * search (29 Oct 2026).
 */
export function searchPriceUsd(lane: Lane, searches: number): number {
  if (lane === 'open') return searches * CREDIT.openWebSearchUsd;
  return searches > 0 ? CREDIT.webSearchUsd : 0;
}

/** The most that the searches of one answer can cost: in the open lane, all that it may run. */
function searchReserveUsd(lane: Lane): number {
  return searchPriceUsd(lane, lane === 'open' ? WEB_SEARCH_TOOL.parameters.max_uses : 1);
}

/**
 * The price of a Premium request: a fixed price, and the share of the cost that the enclave reports
 * which the balance pays when that comes to more.
 */
export interface PremiumPrice {
  readonly fixedUsd: number;
  readonly costShare: number;
}

/**
 * What a Premium request costs a balance: its fixed price, or its share of the cost that the
 * enclave reports when that is more, such as a sealed body that named a costlier model than the
 * app does.
 */
export function premiumPriceMicros(price: PremiumPrice, reportedCostUsd: number | null): number {
  return usdToMicros(Math.max(price.fixedUsd, (reportedCostUsd ?? 0) * price.costShare));
}

/**
 * What one image or one video costs the user, about (the owner, 23 Oct 2026): its estimated cost
 * at the provider plus 25% (decision 52), to the nearest millionth of a dollar.
 */
export function mediaPriceUsd(media: Pick<MediaSettings, 'costUsd'>): number {
  return Math.round(media.costUsd * CREDIT.markup * CREDIT.microsPerUsd) / CREDIT.microsPerUsd;
}

/**
 * What a finished video costs a balance: the cost that OpenRouter reported plus 25% (decision 52),
 * or what the balance paid ahead when no cost came.
 */
export function videoPriceMicros(reportedCostUsd: number | null, paidMicros: number): number {
  return reportedCostUsd === null ? paidMicros : usdToMicros(reportedCostUsd * CREDIT.markup);
}

/**
 * The least a balance must hold before a chat starts: its input, estimated from the size of the
 * chat (or of the sealed body, which the proxy cannot read) but never past the context of the
 * model, a reserve for the answer, and the most that its searches of the web can cost when web
 * search is on, at the price that the user pays. Before an image or a video: its price, about.
 */
export function reserveMicros(
  model: Pick<CatalogModel, 'cost' | 'price' | 'info' | 'media'>,
  inputUnits: number,
  webSearch = false,
): number {
  if (model.media !== undefined) return usdToMicros(mediaPriceUsd(model.media));
  const pricing = userPricing(model);
  if (pricing === null) return 0;
  // Photos weigh far more bytes than the tokens they take, so the context bounds the estimate.
  const inputTokens = Math.min(
    Math.ceil(inputUnits / CREDIT.charsPerToken),
    model.info.contextTokens,
  );
  const tokens = tokensUsd({ inputTokens, outputTokens: CREDIT.reserveOutputTokens }, pricing);
  return usdToMicros(tokens + (webSearch ? searchReserveUsd(model.info.lane) : 0));
}
