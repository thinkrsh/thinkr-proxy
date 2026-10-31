// One pass of the free chats of a holder (config/holderPass.ts): a blind note of a key of its own for
// each month, so that it can only pay a chat, never fill a balance, and so that a browser can keep
// passes for one month at most. The proxy sees a valid pass, never the wallet that took it.
import { HOLDER_PASS } from '../config/holderPass.js';
import { MESSAGES } from '../config/messages.js';
import { fromBase64Url } from '../lib/bytes.js';
import { ProxyError } from '../lib/errors.js';
import { noteHash } from './balance.js';
import type { NoteKey } from './note-key.js';

/** The keys of the passes by month, as "2026-10". */
export type PassKeys = ReadonlyMap<string, NoteKey>;

/** A pass whose signature holds, ready to spend. */
export interface HolderPass {
  /** What the ledger keeps of it, so that it is spent once. */
  readonly hash: string;
  readonly month: string;
}

const FIELD = /^[A-Za-z0-9_-]+$/;

/** The month of UTC of a time, as "2026-10". */
function monthOf(at: number): string {
  return new Date(at).toISOString().slice(0, 'YYYY-MM'.length);
}

/** Checks one pass from its header, under the key of this month. Throws `pass_invalid` otherwise. */
export async function checkPass(keys: PassKeys, header: string, at: number): Promise<HolderPass> {
  const [keyId, nonce, signature, ...rest] = header.split(HOLDER_PASS.separator);
  const month = monthOf(at);
  const key = keys.get(month);
  if (
    key === undefined ||
    keyId !== key.keyId ||
    nonce === undefined ||
    signature === undefined ||
    rest.length > 0 ||
    !FIELD.test(nonce) ||
    !FIELD.test(signature)
  ) {
    throw new ProxyError('pass_invalid', MESSAGES.passInvalid);
  }
  const message = fromBase64Url(nonce);
  if (!key.verify(message, fromBase64Url(signature))) {
    throw new ProxyError('pass_invalid', MESSAGES.passInvalid);
  }
  return { hash: await noteHash(message), month };
}
