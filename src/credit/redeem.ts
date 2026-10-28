// The check of one blind voucher before it fills a balance (decision 48): the key it names must be a
// key of the issuer, and its signature must hold for its message. The credit route spends any such
// voucher; Inference spends holder vouchers only (29 Oct 2026).
import { MESSAGES } from '../config/messages.js';
import { fromBase64Url } from '../lib/bytes.js';
import { ProxyError } from '../lib/errors.js';
import { usdToMicros, voucherHash } from './balance.js';
import type { VoucherKeys } from './voucher-key.js';

/** One voucher as the app or the dashboard sends it, in base64url, with the hex id of its key. */
export interface VoucherFields {
  readonly keyId: string;
  readonly nonce: string;
  readonly signature: string;
}

/** A voucher whose signature holds, ready to spend into a balance. */
export interface CheckedVoucher {
  /** What the ledger keeps of it, so that it is spent once. */
  readonly hash: string;
  readonly micros: number;
  /** The month of its key for a holder voucher, or null for the voucher of a top-up. */
  readonly holderMonth: string | null;
}

/**
 * Checks one voucher. Throws `key_changed` for a key that the proxy does not take, and
 * `voucher_invalid` for a signature that does not hold.
 */
export async function checkVoucher(
  voucherKeys: VoucherKeys,
  voucher: VoucherFields,
): Promise<CheckedVoucher> {
  const known = voucherKeys.find(voucher.keyId);
  if (known === null) throw new ProxyError('key_changed', MESSAGES.keyChanged);
  const nonce = fromBase64Url(voucher.nonce);
  if (!known.key.verify(nonce, fromBase64Url(voucher.signature))) {
    throw new ProxyError('voucher_invalid', MESSAGES.voucherInvalid);
  }
  return {
    hash: await voucherHash(nonce),
    micros: usdToMicros(known.usd),
    holderMonth: known.holderMonth,
  };
}
