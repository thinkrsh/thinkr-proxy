// The public key of the vouchers on Node, from the PEM that scripts/chat/deploy.sh keys derives
// from the key of the issuer. It checks an unblinded voucher as RSA-PSS with SHA-384 (RFC 9474).
import { constants, createHash, createPublicKey, verify } from 'node:crypto';

import { VOUCHER_SIGNATURE } from '../config/credit.js';
import type { VoucherKey } from '../credit/voucher-key.js';

const MODULUS_BYTES = VOUCHER_SIGNATURE.modulusBits / 8;

export function voucherKeyFromPublicPem(pem: string): VoucherKey {
  const publicKey = createPublicKey(pem);
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
