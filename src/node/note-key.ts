// The public keys of the notes on Node: the key of top-ups from the PEM that scripts/chat/deploy.sh
// keys derives from the key of the issuer, and the holder keys of each month and the keys of the
// notes of change from the JSON that `npm run holder-keys -- public` and `npm run change-keys --
// public` of apps/issuer print. Each checks an unblinded note as RSA-PSS with SHA-384 (RFC 9474).
import { constants, createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

import { z } from 'zod';

import { CHANGE_CENTS, NOTE_SIGNATURE } from '../config/credit.js';
import type { NoteKey } from '../credit/note-key.js';
import { fromBase64Url } from '../lib/bytes.js';

const MODULUS_BYTES = NOTE_SIGNATURE.modulusBits / 8;

/** The holder keys by month, from `{ "2026-10": "<SPKI DER in base64url>" }`. */
const holderKeysSchema = z.record(
  z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
  z.string().regex(/^[A-Za-z0-9_-]+$/),
);

export function noteKeyFromPublicPem(pem: string): NoteKey {
  return noteKeyOf(createPublicKey(pem));
}

/** Reads the holder keys of each month. Stops when the file holds none. */
export function holderKeysFromJson(json: string): Map<string, NoteKey> {
  const entries = Object.entries(holderKeysSchema.parse(JSON.parse(json)));
  if (entries.length === 0) throw new Error('The file of holder keys holds no key.');
  return new Map(
    entries.map(([month, spki]) => [
      month,
      noteKeyOf(
        createPublicKey({ key: Buffer.from(fromBase64Url(spki)), format: 'der', type: 'spki' }),
      ),
    ]),
  );
}

/** Reads the keys of the notes of change from `{ "10": "<SPKI DER in base64url>" }`. */
export function changeKeysFromJson(json: string): Map<number, NoteKey> {
  const entries = z
    .record(z.string(), z.string().regex(/^[A-Za-z0-9_-]+$/))
    .parse(JSON.parse(json));
  return new Map(
    CHANGE_CENTS.map((cents) => {
      const spki = entries[String(cents)];
      if (spki === undefined) throw new Error(`The file of change keys lacks ${String(cents)}.`);
      return [
        cents,
        noteKeyOf(
          createPublicKey({ key: Buffer.from(fromBase64Url(spki)), format: 'der', type: 'spki' }),
        ),
      ];
    }),
  );
}

function noteKeyOf(publicKey: KeyObject): NoteKey {
  const bits = publicKey.asymmetricKeyDetails?.modulusLength;
  if (publicKey.asymmetricKeyType !== 'rsa' || bits !== NOTE_SIGNATURE.modulusBits) {
    throw new Error(
      `The note key must be RSA with a ${String(NOTE_SIGNATURE.modulusBits)}-bit modulus.`,
    );
  }
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const keyId = createHash('sha256')
    .update(spki)
    .digest('hex')
    .slice(0, NOTE_SIGNATURE.keyIdBytes * 2);

  return {
    keyId,
    publicKey: new Uint8Array(spki),
    verify(nonce, signature) {
      if (signature.length !== MODULUS_BYTES) return false;
      try {
        return verify(
          NOTE_SIGNATURE.hash,
          nonce,
          {
            key: publicKey,
            padding: constants.RSA_PKCS1_PSS_PADDING,
            saltLength: NOTE_SIGNATURE.saltBytes,
          },
          signature,
        );
      } catch {
        return false;
      }
    },
  };
}
