import { describe, expect, it } from 'vitest';

import { CREDIT } from '../src/config/credit.js';
import type { HolderTotalsResponse, RedeemResponse } from '../src/contract.js';
import { newBalanceSecret, usdToMicros } from '../src/credit/balance.js';
import { openLedger } from '../src/node/ledger.js';
import {
  createTestApp,
  TEST_HOLDER_KEY,
  TEST_HOLDER_MONTH,
  TEST_NOTE_KEY,
  type TestApp,
} from './helpers.js';
import { redeemBody, signedNote } from './notes.js';

const AT = Date.UTC(2026, 9, 26, 12);

function redeem(app: TestApp['app'], body: string): Promise<Response> {
  return Promise.resolve(
    app.request('/api/credit/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }),
  );
}

describe('holder vouchers at the proxy', () => {
  it('fill a balance with $0.40 each, beside the $1 of a top-up voucher', async () => {
    const { app } = createTestApp();
    const secret = newBalanceSecret();
    const holder = await redeem(
      app,
      redeemBody(TEST_HOLDER_KEY, await signedNote(TEST_HOLDER_KEY), secret),
    );
    expect(((await holder.json()) as RedeemResponse).usd).toBe(CREDIT.holderVoucherUsd);
    const topUp = await redeem(
      app,
      redeemBody(TEST_NOTE_KEY, await signedNote(TEST_NOTE_KEY), secret),
    );
    expect(((await topUp.json()) as RedeemResponse).usd).toBeCloseTo(1.4, 6);
  });

  it('count the holder vouchers spent by the month of their key, with no balance', async () => {
    const { app } = createTestApp();
    for (let index = 0; index < 2; index += 1) {
      const note = await signedNote(TEST_HOLDER_KEY);
      await redeem(app, redeemBody(TEST_HOLDER_KEY, note, newBalanceSecret()));
    }
    const response = await app.request('/api/credit/holder-totals');
    expect((await response.json()) as HolderTotalsResponse).toEqual({
      redeemed: [{ month: TEST_HOLDER_MONTH, vouchers: 2 }],
      spent: [],
    });
  });
});

describe('the credit of holder vouchers in the ledger', () => {
  it('goes first, and counts what it paid for', () => {
    const ledger = openLedger(':memory:');
    ledger.redeem('top-up', 'balance', usdToMicros(1), null);
    ledger.redeem('holder', 'balance', usdToMicros(0.4), TEST_HOLDER_MONTH);
    ledger.charge('balance', usdToMicros(0.25), 'chat', AT);
    ledger.charge('balance', usdToMicros(0.25), 'image', AT);
    expect(ledger.balance('balance')).toBe(usdToMicros(0.9));
    expect(ledger.holderTotals().spent).toEqual([
      { month: '2026-10', use: 'chat', micros: usdToMicros(0.25) },
      { month: '2026-10', use: 'image', micros: usdToMicros(0.15) },
    ]);
  });

  it('moves along when two balances merge', () => {
    const ledger = openLedger(':memory:');
    ledger.redeem('holder', 'closes', usdToMicros(0.4), TEST_HOLDER_MONTH);
    ledger.redeem('top-up', 'stays', usdToMicros(1), null);
    ledger.mergeBalance('closes', 'stays');
    ledger.charge('stays', usdToMicros(0.4), 'video', AT);
    expect(ledger.holderTotals().spent).toEqual([
      { month: '2026-10', use: 'video', micros: usdToMicros(0.4) },
    ]);
  });

  it('counts what a video job costs beyond its prepayment as video', () => {
    const ledger = openLedger(':memory:');
    ledger.redeem('holder', 'balance', usdToMicros(0.4), TEST_HOLDER_MONTH);
    ledger.redeem('top-up', 'balance', usdToMicros(1), null);
    ledger.charge('balance', usdToMicros(0.3), 'video', AT);
    ledger.settleJob('job', 'balance', -usdToMicros(0.2), AT);
    expect(ledger.holderTotals().spent).toEqual([
      { month: '2026-10', use: 'video', micros: usdToMicros(0.4) },
    ]);
    expect(ledger.balance('balance')).toBe(usdToMicros(0.9));
  });
});
