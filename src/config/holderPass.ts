// The free chats of a holder (the owner, 31 Oct 2026: "misal kita gratisin private ai buat holder
// gimana ?"): a wallet that holds 1M THKR takes blind passes at the issuer (apps/issuer/src/hold/
// pass.ts), and each pass pays one chat here, so that a chat never names a wallet. Web search,
// documents, voice, and every other model still take credit or the free trial.
export const HOLDER_PASS = {
  /** The request header that carries one pass. It never reaches the enclave. */
  header: 'X-Thinkr-Pass',
  /** Joins the id of the key, the nonce, and the signature of a pass in that header. */
  separator: '.',
  /**
   * The models of free chats, the cheapest of the private lane: on 31 Oct 2026 a chat of 1,000 tokens
   * in and 500 out cost $0.00045, $0.0009, and $0.00137 at Tinfoil. Kimi K3 costs $0.014, so it stays
   * on credit.
   */
  modelIds: ['private/gpt-oss-120b', 'private/gemma-4-31b', 'private/deepseek-v4.1-flash'],
  /**
   * What free chats may cost in a day, in USD. Past it they pause until 00:00 UTC, and a chat goes
   * on credit or the free trial. 58 wallets held 1M THKR on 31 Oct 2026: about $8 a day if each spent
   * all 100 passes of a day on DeepSeek V4.1 Flash, in chats of that size.
   */
  dailyBudgetUsd: 10,
  /**
   * The most that the input of one free chat and the reserve of its answer may come to, at the price
   * that the user pays, so that a few long chats cannot spend the budget of the day: such a chat goes
   * on credit or the free trial.
   */
  maxChatUsd: 0.05,
} as const;

/** True for a model that a holder chats with free. */
export function isHolderFree(modelId: string): boolean {
  return (HOLDER_PASS.modelIds as readonly string[]).includes(modelId);
}
