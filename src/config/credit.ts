// Credit (decisions 48, 52, 64, and 132): blind vouchers of $1, a balance at the proxy that each
// voucher fills, and each chat paid from the balance at the price of its model in config/models.ts,
// or else at cost plus 25%. Change the numbers here only, except the worth of a voucher, the packs,
// and the cap of a top-up, which the issuer signs by (apps/issuer/src/config/credit.ts) and must
// match there.
export const CREDIT = {
  /** The value of one voucher in USD (docs/CONCEPT.md, section "Blind vouchers"). */
  voucherUsd: 1,
  /**
   * What one holder voucher is worth when it fills a balance: $0.40 to start (decision 189). Must
   * match HOLD.voucherUsd in apps/issuer/src/config/hold.ts.
   */
  holderVoucherUsd: 0.4,
  /**
   * The quick choices of a top-up in the chat: $1, $5, or $20 (decision 64). A top-up may also buy
   * any other whole number of vouchers up to the cap below (the owner, 23 Oct 2026: "bikin custom
   * amount").
   */
  packs: [1, 5, 20],
  /**
   * The most that one top-up may cost, so that nobody sends too much by mistake (decision 95:
   * "maksimal $200 buat batas topup jangan sampai user kirim kegedean"). Every pack stays under it.
   */
  maxTopUpUsd: 200,
  /**
   * What a chat costs the user with a model that has no price of its own (decision 132): the cost
   * of the answer times this (decision 52).
   */
  markup: 1.25,
  /**
   * What web search costs a balance, once for each answer that searched, and what one document
   * costs to convert, in the private lane (decision 142): the fees of Tinfoil in config/tinfoil.ts
   * plus 25% (decision 52). The free trial has both too, and pays the fees from its budget.
   */
  webSearchUsd: 0.0625,
  documentUsd: 0.0625,
  /**
   * The Premium of the private lane, which only a balance pays (the owner, 23 Oct 2026: "jadi
   * nanti user kita bisa pake premium akses di chat nya"). One part of an answer spoken and one
   * message through the privacy filter cost the fee of Tinfoil in config/tinfoil.ts plus 25%
   * (decision 52), or the cost that the enclave reports plus 25% when that is more.
   */
  voiceReplyUsd: 0.0025,
  privacyFilterUsd: 0.00625,
  /**
   * One recording turned into text costs what Tinfoil reports for it, less 25%, with no price of
   * its own: "tergantung harga dari sana laaaah + discon -25%" (the owner, 23 Oct 2026), as the
   * prices of decision 134 stand 25% under. Voxtral Small 24B costs tokens at Tinfoil, and on 23 Oct
   * 2026 it reported $0 for each recording.
   */
  voiceInputUsd: 0,
  voiceInputCostShare: 0.75,
  /** The request header that carries the secret of a balance. */
  balanceHeader: 'X-Thinkr-Balance',
  /** Bytes of the random secret of a balance. */
  balanceSecretBytes: 32,
  /** Before a paid chat starts, the balance must cover its input and this many output tokens. */
  reserveOutputTokens: 4_096,
  /** Characters of a chat, or bytes of a sealed one, counted as one input token in that estimate. */
  charsPerToken: 3,
  /** Balances count in millionths of a dollar, so that every sum stays exact. */
  microsPerUsd: 1_000_000,
} as const;

/** The most vouchers that one top-up may buy: the cap of decision 95, in vouchers. */
export const MAX_TOP_UP_VOUCHERS = Math.floor(CREDIT.maxTopUpUsd / CREDIT.voucherUsd);

/** The blind RSA signature of the vouchers: RSABSSA-SHA384-PSS-Deterministic of RFC 9474. */
export const VOUCHER_SIGNATURE = {
  modulusBits: 2048,
  hash: 'sha384',
  /** The salt of RSA-PSS: the length of a SHA-384 digest. */
  saltBytes: 48,
  /** Bytes of the random message of each voucher, made on the device of the user. */
  nonceBytes: 32,
  /** Bytes of the SHA-256 of the public key that name the key. */
  keyIdBytes: 8,
} as const;
