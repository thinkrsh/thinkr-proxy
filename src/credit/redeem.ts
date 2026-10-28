// The check of one blind note before it fills a balance (decision 48): the key it names must be a
// key of the issuer, and its signature must hold for its message. The credit route spends any such
// note; Inference spends holder vouchers only (29 Oct 2026).
import { MESSAGES } from '../config/messages.js';
import { fromBase64Url } from '../lib/bytes.js';
import { ProxyError } from '../lib/errors.js';
import { usdToMicros, noteHash } from './balance.js';
import type { NoteKeys } from './note-key.js';

/** One note as the app or the dashboard sends it, in base64url, with the hex id of its key. */
export interface NoteFields {
  readonly keyId: string;
  readonly nonce: string;
  readonly signature: string;
}

/** A note whose signature holds, ready to spend into a balance. */
export interface CheckedNote {
  /** What the ledger keeps of it, so that it is spent once. */
  readonly hash: string;
  readonly micros: number;
  /** The month of its key for a holder voucher, or null for the note of a top-up. */
  readonly holderMonth: string | null;
}

/**
 * Checks one note. Throws `key_changed` for a key that the proxy does not take, and
 * `voucher_invalid` for a signature that does not hold.
 */
export async function checkNote(noteKeys: NoteKeys, note: NoteFields): Promise<CheckedNote> {
  const known = noteKeys.find(note.keyId);
  if (known === null) throw new ProxyError('key_changed', MESSAGES.keyChanged);
  const nonce = fromBase64Url(note.nonce);
  if (!known.key.verify(nonce, fromBase64Url(note.signature))) {
    throw new ProxyError('voucher_invalid', MESSAGES.noteInvalid);
  }
  return {
    hash: await noteHash(nonce),
    micros: usdToMicros(known.usd),
    holderMonth: known.holderMonth,
  };
}
