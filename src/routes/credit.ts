// The credit of the app (decision 48): GET /api/credit/key gives the public key that the app blinds
// its vouchers with, and POST /api/credit/redeem spends one voucher into a balance. The proxy sees
// a valid voucher, never who bought it. POST /api/credit/merge moves one balance onto another, for
// two devices of one person that share an encrypted backup.
import { Hono, type Context } from 'hono';

import { CREDIT, MAX_TOP_UP_VOUCHERS } from '../config/credit.js';
import { MESSAGES } from '../config/messages.js';
import { PAYMENT_WORDS } from '../config/payments.js';
import {
  mergeRequestSchema,
  redeemRequestSchema,
  type CreditKeyResponse,
  type MergeResponse,
  type RedeemResponse,
} from '../contract.js';
import { balanceHash, microsToUsd, usdToMicros, voucherHash } from '../credit/balance.js';
import type { Ledger } from '../credit/ledger.js';
import type { VoucherKey } from '../credit/voucher-key.js';
import { parseBody, readJson } from '../lib/body.js';
import { fromBase64Url, toBase64Url } from '../lib/bytes.js';
import { ProxyError } from '../lib/errors.js';
import type { RateLimiter } from '../lib/rate-limit.js';

export interface CreditRouteDeps {
  readonly now: () => number;
  readonly clientKey: (c: Context) => string;
  readonly limiter: RateLimiter;
  readonly ledger: Ledger;
  /** The public key of the issuer, which checks the vouchers that the app spends. */
  readonly voucherKey: VoucherKey;
}

export function createCreditRoute(deps: CreditRouteDeps): Hono {
  const key: CreditKeyResponse = {
    keyId: deps.voucherKey.keyId,
    publicKey: toBase64Url(deps.voucherKey.publicKey),
    voucherUsd: CREDIT.voucherUsd,
    packs: [...CREDIT.packs],
    maxVouchers: MAX_TOP_UP_VOUCHERS,
    payment: { ...PAYMENT_WORDS, tokens: [...PAYMENT_WORDS.tokens] },
  };

  return new Hono()
    .basePath('/credit')
    .get('/key', (c) => c.json<CreditKeyResponse>(key))
    .post('/redeem', async (c) => {
      if (!deps.limiter.take(deps.clientKey(c), deps.now())) {
        throw new ProxyError('rate_limited', MESSAGES.rateLimited);
      }
      const request = parseBody(redeemRequestSchema, await readJson(c));
      if (request.keyId !== deps.voucherKey.keyId) {
        throw new ProxyError('key_changed', MESSAGES.keyChanged);
      }
      const nonce = fromBase64Url(request.nonce);
      if (!deps.voucherKey.verify(nonce, fromBase64Url(request.signature))) {
        throw new ProxyError('voucher_invalid', MESSAGES.voucherInvalid);
      }
      const hash = await balanceHash(request.balance);
      const voucher = await voucherHash(nonce);
      if (deps.ledger.redeem(voucher, hash, usdToMicros(CREDIT.voucherUsd)) === 'spent') {
        throw new ProxyError('voucher_spent', MESSAGES.voucherSpent);
      }
      return c.json<RedeemResponse>({ usd: microsToUsd(deps.ledger.balance(hash) ?? 0) });
    })
    .post('/merge', async (c) => {
      if (!deps.limiter.take(deps.clientKey(c), deps.now())) {
        throw new ProxyError('rate_limited', MESSAGES.rateLimited);
      }
      const request = parseBody(mergeRequestSchema, await readJson(c));
      if (request.from === request.balance) {
        throw new ProxyError('invalid_request', MESSAGES.mergeSame);
      }
      const into = await balanceHash(request.balance);
      // A balance that is gone already moved, or never held anything: both leave `into` as it is.
      deps.ledger.mergeBalance(await balanceHash(request.from), into);
      return c.json<MergeResponse>({ usd: microsToUsd(deps.ledger.balance(into) ?? 0) });
    });
}
