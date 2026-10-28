// The side of the app in a top-up, with the reference library of RFC 9474: it blinds random
// messages, and unblinds the signatures of the issuer into notes. The issuer signs with the
// private key of the tests (helpers.ts).
import { RSABSSA } from '@cloudflare/blindrsa-ts';

import { NOTE_SIGNATURE } from '../src/config/credit.js';
import type { NoteKey } from '../src/credit/note-key.js';
import { randomBytes, toBase64Url } from '../src/lib/bytes.js';
import { issuerBlindSign } from './helpers.js';

const SUITE = RSABSSA.SHA384.PSS.Deterministic();

export interface BlindedNote {
  readonly nonce: Uint8Array;
  readonly blinded: Uint8Array;
  readonly inv: Uint8Array;
}

export interface Note {
  readonly nonce: Uint8Array;
  readonly signature: Uint8Array;
}

function publicKeyOf(key: NoteKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    new Uint8Array(key.publicKey),
    { name: 'RSA-PSS', hash: 'SHA-384' },
    true,
    ['verify'],
  );
}

export async function blindNotes(key: NoteKey, count: number): Promise<BlindedNote[]> {
  const publicKey = await publicKeyOf(key);
  return Promise.all(
    Array.from({ length: count }, async () => {
      const nonce = randomBytes(NOTE_SIGNATURE.nonceBytes);
      const { blindedMsg, inv } = await SUITE.blind(publicKey, SUITE.prepare(nonce));
      return { nonce, blinded: blindedMsg, inv };
    }),
  );
}

export async function finalizeNote(
  key: NoteKey,
  note: BlindedNote,
  blindSignature: Uint8Array,
): Promise<Note> {
  const publicKey = await publicKeyOf(key);
  const signature = await SUITE.finalize(publicKey, note.nonce, blindSignature, note.inv);
  return { nonce: note.nonce, signature };
}

/** A note that the key signed, as the app holds it once a top-up is done. */
export async function signedNote(key: NoteKey): Promise<Note> {
  const [blinded] = await blindNotes(key, 1);
  if (blinded === undefined) throw new Error('No voucher was blinded.');
  return finalizeNote(key, blinded, issuerBlindSign(key, blinded.blinded));
}

/** The body of POST /api/credit/redeem for a note. */
export function redeemBody(key: NoteKey, note: Note, balance: string): string {
  return JSON.stringify({
    keyId: key.keyId,
    nonce: toBase64Url(note.nonce),
    signature: toBase64Url(note.signature),
    balance,
  });
}
