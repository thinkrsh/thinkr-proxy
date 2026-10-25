// The side of the app in a top-up, with the reference library of RFC 9474: it blinds random
// messages, and unblinds the signatures of the issuer into vouchers. The issuer signs with the
// private key of the tests (helpers.ts).
import { RSABSSA } from '@cloudflare/blindrsa-ts';

import { VOUCHER_SIGNATURE } from '../src/config/credit.js';
import type { VoucherKey } from '../src/credit/voucher-key.js';
import { randomBytes, toBase64Url } from '../src/lib/bytes.js';
import { issuerBlindSign } from './helpers.js';

const SUITE = RSABSSA.SHA384.PSS.Deterministic();

export interface BlindedVoucher {
  readonly nonce: Uint8Array;
  readonly blinded: Uint8Array;
  readonly inv: Uint8Array;
}

export interface Voucher {
  readonly nonce: Uint8Array;
  readonly signature: Uint8Array;
}

function publicKeyOf(key: VoucherKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    new Uint8Array(key.publicKey),
    { name: 'RSA-PSS', hash: 'SHA-384' },
    true,
    ['verify'],
  );
}

export async function blindVouchers(key: VoucherKey, count: number): Promise<BlindedVoucher[]> {
  const publicKey = await publicKeyOf(key);
  return Promise.all(
    Array.from({ length: count }, async () => {
      const nonce = randomBytes(VOUCHER_SIGNATURE.nonceBytes);
      const { blindedMsg, inv } = await SUITE.blind(publicKey, SUITE.prepare(nonce));
      return { nonce, blinded: blindedMsg, inv };
    }),
  );
}

export async function finalizeVoucher(
  key: VoucherKey,
  voucher: BlindedVoucher,
  blindSignature: Uint8Array,
): Promise<Voucher> {
  const publicKey = await publicKeyOf(key);
  const signature = await SUITE.finalize(publicKey, voucher.nonce, blindSignature, voucher.inv);
  return { nonce: voucher.nonce, signature };
}

/** A voucher that the key signed, as the app holds it once a top-up is done. */
export async function signedVoucher(key: VoucherKey): Promise<Voucher> {
  const [blinded] = await blindVouchers(key, 1);
  if (blinded === undefined) throw new Error('No voucher was blinded.');
  return finalizeVoucher(key, blinded, issuerBlindSign(key, blinded.blinded));
}

/** The body of POST /api/credit/redeem for a voucher. */
export function redeemBody(key: VoucherKey, voucher: Voucher, balance: string): string {
  return JSON.stringify({
    keyId: key.keyId,
    nonce: toBase64Url(voucher.nonce),
    signature: toBase64Url(voucher.signature),
    balance,
  });
}
