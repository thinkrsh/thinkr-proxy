// The public key of the notes: RSA blind signatures, RSABSSA-SHA384-PSS-Deterministic of
// RFC 9474 (docs/CONCEPT.md, section "Blind vouchers"). The app blinds a random message on the
// device, the issuer (apps/issuer/) signs it without seeing it, and the proxy checks the unblinded
// note. Since 24 Oct 2026 the proxy holds the public key only, so it cannot sign a note. The
// Node entry implements it in node/note-key.ts. Holder vouchers (decision 189) come from a key
// of their own for each month, and are worth less than the note of a top-up.
import { CREDIT } from '../config/credit.js';

export interface NoteKey {
  /** The first bytes of the SHA-256 of the public key, in hex. */
  readonly keyId: string;
  /** The public key, SPKI DER. */
  readonly publicKey: Uint8Array;
  /** True when the signature is valid for the message of the note under this key. */
  verify: (nonce: Uint8Array, signature: Uint8Array) => boolean;
}

/** A key whose notes the proxy takes, with what one of them is worth. */
export interface KnownKey {
  readonly key: NoteKey;
  readonly usd: number;
  /** The month of a key of holder vouchers, as "2026-10", or null for the key of top-ups. */
  readonly holderMonth: string | null;
}

/** Every key whose notes the proxy takes. */
export interface NoteKeys {
  /** The key of top-ups, which the app blinds its notes with. */
  readonly topUp: NoteKey;
  /** The key of this id, or null when the proxy takes no note of it. */
  find: (keyId: string) => KnownKey | null;
  /** The keys of holder vouchers, the oldest month first. */
  holder: readonly KnownKey[];
}

export function noteKeysOf(topUp: NoteKey, holderKeys: ReadonlyMap<string, NoteKey>): NoteKeys {
  const known = new Map<string, KnownKey>([
    [topUp.keyId, { key: topUp, usd: CREDIT.voucherUsd, holderMonth: null }],
  ]);
  for (const [month, key] of holderKeys) {
    known.set(key.keyId, { key, usd: CREDIT.holderVoucherUsd, holderMonth: month });
  }
  const holder = [...known.values()]
    .filter((key) => key.holderMonth !== null)
    .sort((left, right) => (left.holderMonth ?? '').localeCompare(right.holderMonth ?? ''));
  return { topUp, find: (keyId) => known.get(keyId) ?? null, holder };
}
