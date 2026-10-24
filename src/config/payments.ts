// How the dashboard takes payment, for the words of the app in GET /api/credit/key (decisions 82
// and 167). The issuer (apps/issuer/) takes the payments, apart from the proxy since 24 Oct 2026:
// these words must match its config/payments.ts and config/token.ts. Change both together.
export const PAYMENT_WORDS = {
  network: 'Robinhood Chain',
  /** The stablecoin of a top-up. */
  token: 'USDG',
  /** Every token that pays: USDG, and THKR, which buys 25% more credit (decision 167). */
  tokens: ['USDG', 'THKR'],
  /** False on Robinhood Chain mainnet (decision 82). */
  testnet: false,
} as const;
