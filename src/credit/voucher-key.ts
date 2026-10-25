// The public key of the vouchers: RSA blind signatures, RSABSSA-SHA384-PSS-Deterministic of
// RFC 9474 (docs/CONCEPT.md, section "Blind vouchers"). The app blinds a random message on the
// device, the issuer (apps/issuer/) signs it without seeing it, and the proxy checks the unblinded
// voucher. Since 24 Oct 2026 the proxy holds the public key only, so it cannot sign a voucher. The
// Node entry implements it in node/voucher-key.ts. Holder vouchers (decision 189) come from a key
// of their own for each month, and are worth less than the voucher of a top-up.
import { CREDIT } from '../config/credit.js';

export interface VoucherKey {
  /** The first bytes of the SHA-256 of the public key, in hex. */
  readonly keyId: string;
  /** The public key, SPKI DER. */
  readonly publicKey: Uint8Array;
  /** True when the signature is valid for the message of the voucher under this key. */
  verify: (nonce: Uint8Array, signature: Uint8Array) => boolean;
}

/** A key whose vouchers the proxy takes, with what one of them is worth. */
export interface KnownKey {
  readonly key: VoucherKey;
  readonly usd: number;
  /** The month of a key of holder vouchers, as "2026-10", or null for the key of top-ups. */
  readonly holderMonth: string | null;
}

/** Every key whose vouchers the proxy takes. */
export interface VoucherKeys {
  /** The key of top-ups, which the app blinds its vouchers with. */
  readonly topUp: VoucherKey;
  /** The key of this id, or null when the proxy takes no voucher of it. */
  find: (keyId: string) => KnownKey | null;
  /** The keys of holder vouchers, the oldest month first. */
  holder: readonly KnownKey[];
}

export function voucherKeysOf(
  topUp: VoucherKey,
  holderKeys: ReadonlyMap<string, VoucherKey>,
): VoucherKeys {
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
