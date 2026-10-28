// The credit of the app (decision 48): GET /api/credit/key gives the public key that the app blinds
// its vouchers with, and POST /api/credit/redeem spends one voucher into a balance: the voucher of
// a top-up, or a holder voucher of any month (decision 189), each worth its own amount. The proxy
// sees a valid voucher, never who bought or claimed it. POST /api/credit/merge moves one balance
// onto another, for two devices of one person that share an encrypted backup.
// GET /api/credit/holder-totals counts the holder vouchers spent and what their credit paid for,
// by month, with no balance (decision 191).
import { Hono, type Context } from 'hono';

import { CREDIT, MAX_TOP_UP_VOUCHERS } from '../config/credit.js';
import { MESSAGES } from '../config/messages.js';
import { PAYMENT_WORDS } from '../config/payments.js';
import {
  mergeRequestSchema,
  redeemRequestSchema,
  type CreditKeyResponse,
  type HolderTotalsResponse,
  type MergeResponse,
  type RedeemResponse,
} from '../contract.js';
import { balanceHash, microsToUsd } from '../credit/balance.js';
import type { Ledger } from '../credit/ledger.js';
import { checkVoucher } from '../credit/redeem.js';
import type { VoucherKeys } from '../credit/voucher-key.js';
import { parseBody, readJson } from '../lib/body.js';
import { toBase64Url } from '../lib/bytes.js';
import { ProxyError } from '../lib/errors.js';
import type { RateLimiter } from '../lib/rate-limit.js';

export interface CreditRouteDeps {
  readonly now: () => number;
  readonly clientKey: (c: Context) => string;
  readonly limiter: RateLimiter;
  readonly ledger: Ledger;
  /** The public keys of the issuer, which check the vouchers that the app spends. */
  readonly voucherKeys: VoucherKeys;
}

export function createCreditRoute(deps: CreditRouteDeps): Hono {
  const key: CreditKeyResponse = {
    keyId: deps.voucherKeys.topUp.keyId,
    publicKey: toBase64Url(deps.voucherKeys.topUp.publicKey),
    voucherUsd: CREDIT.voucherUsd,
    packs: [...CREDIT.packs],
    maxVouchers: MAX_TOP_UP_VOUCHERS,
    payment: { ...PAYMENT_WORDS, tokens: [...PAYMENT_WORDS.tokens] },
    holderKeys: deps.voucherKeys.holder.map((known) => ({
      keyId: known.key.keyId,
      month: known.holderMonth ?? '',
      voucherUsd: known.usd,
    })),
  };

  return new Hono()
    .basePath('/credit')
    .get('/key', (c) => c.json<CreditKeyResponse>(key))
    .post('/redeem', async (c) => {
      if (!deps.limiter.take(deps.clientKey(c), deps.now())) {
        throw new ProxyError('rate_limited', MESSAGES.rateLimited);
      }
      const request = parseBody(redeemRequestSchema, await readJson(c));
      const voucher = await checkVoucher(deps.voucherKeys, request);
      const hash = await balanceHash(request.balance);
      if (deps.ledger.redeem(voucher.hash, hash, voucher.micros, voucher.holderMonth) === 'spent') {
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
    })
    .get('/holder-totals', (c) => {
      const totals = deps.ledger.holderTotals();
      return c.json<HolderTotalsResponse>({
        redeemed: [...totals.redeemed],
        spent: totals.spent.map((row) => ({
          month: row.month,
          use: row.use,
          usd: microsToUsd(row.micros),
        })),
      });
    });
}
