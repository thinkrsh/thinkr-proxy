// The public keys of the vouchers on Node: the key of top-ups from the PEM that scripts/chat/deploy.sh
// keys derives from the key of the issuer, and the holder keys of each month from the JSON that
// `npm run holder-keys -- public` of apps/issuer prints. Each checks an unblinded voucher as RSA-PSS
// with SHA-384 (RFC 9474).
import { constants, createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

import { z } from 'zod';

import { VOUCHER_SIGNATURE } from '../config/credit.js';
import type { VoucherKey } from '../credit/voucher-key.js';
import { fromBase64Url } from '../lib/bytes.js';

const MODULUS_BYTES = VOUCHER_SIGNATURE.modulusBits / 8;

/** The holder keys by month, from `{ "2026-10": "<SPKI DER in base64url>" }`. */
const holderKeysSchema = z.record(
  z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
  z.string().regex(/^[A-Za-z0-9_-]+$/),
);

export function voucherKeyFromPublicPem(pem: string): VoucherKey {
  return voucherKeyOf(createPublicKey(pem));
}

/** Reads the holder keys of each month. Stops when the file holds none. */
export function holderKeysFromJson(json: string): Map<string, VoucherKey> {
  const entries = Object.entries(holderKeysSchema.parse(JSON.parse(json)));
  if (entries.length === 0) throw new Error('The file of holder keys holds no key.');
  return new Map(
    entries.map(([month, spki]) => [
      month,
      voucherKeyOf(
        createPublicKey({ key: Buffer.from(fromBase64Url(spki)), format: 'der', type: 'spki' }),
      ),
    ]),
  );
}

function voucherKeyOf(publicKey: KeyObject): VoucherKey {
  const bits = publicKey.asymmetricKeyDetails?.modulusLength;
  if (publicKey.asymmetricKeyType !== 'rsa' || bits !== VOUCHER_SIGNATURE.modulusBits) {
    throw new Error(
      `The voucher key must be RSA with a ${String(VOUCHER_SIGNATURE.modulusBits)}-bit modulus.`,
    );
  }
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const keyId = createHash('sha256')
    .update(spki)
    .digest('hex')
    .slice(0, VOUCHER_SIGNATURE.keyIdBytes * 2);

  return {
    keyId,
    publicKey: new Uint8Array(spki),
    verify(nonce, signature) {
      if (signature.length !== MODULUS_BYTES) return false;
      try {
        return verify(
          VOUCHER_SIGNATURE.hash,
          nonce,
          {
            key: publicKey,
            padding: constants.RSA_PKCS1_PSS_PADDING,
            saltLength: VOUCHER_SIGNATURE.saltBytes,
          },
          signature,
        );
      } catch {
        return false;
      }
    },
  };
}
