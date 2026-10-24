// The public key of the vouchers: RSA blind signatures, RSABSSA-SHA384-PSS-Deterministic of
// RFC 9474 (docs/CONCEPT.md, section "Blind vouchers"). The app blinds a random message on the
// device, the issuer (apps/issuer/) signs it without seeing it, and the proxy checks the unblinded
// voucher. Since 24 Oct 2026 the proxy holds the public key only, so it cannot sign a voucher. The
// Node entry implements it in node/voucher-key.ts.
export interface VoucherKey {
  /** The first bytes of the SHA-256 of the public key, in hex. */
  readonly keyId: string;
  /** The public key, SPKI DER. */
  readonly publicKey: Uint8Array;
  /** True when the signature is valid for the message of the voucher under this key. */
  verify: (nonce: Uint8Array, signature: Uint8Array) => boolean;
}
