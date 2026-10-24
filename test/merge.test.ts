import { describe, expect, it } from 'vitest';

import type { ErrorBody, MergeResponse } from '../src/contract.js';
import { balanceHash, newBalanceSecret, usdToMicros } from '../src/credit/balance.js';
import { openLedger } from '../src/node/ledger.js';
import { createTestApp, fundedBalance, type TestApp } from './helpers.js';

function merge(app: TestApp['app'], balance: string, from: string): Promise<Response> {
  return Promise.resolve(
    app.request('/api/credit/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ balance, from }),
    }),
  );
}

describe('a merge of two balances', () => {
  it('moves what is left on one balance onto the other, and closes the first', async () => {
    const { app, ledger } = createTestApp();
    const stays = await fundedBalance(ledger, 3);
    const closes = await fundedBalance(ledger, 2);
    const response = await merge(app, stays, closes);
    expect(response.status).toBe(200);
    expect(((await response.json()) as MergeResponse).usd).toBe(5);
    expect(ledger.balance(await balanceHash(closes))).toBeNull();
    expect(ledger.balance(await balanceHash(stays))).toBe(usdToMicros(5));
  });

  it('leaves the balance as it is when the other one is gone, so a second try is safe', async () => {
    const { app, ledger } = createTestApp();
    const stays = await fundedBalance(ledger, 3);
    const closes = await fundedBalance(ledger, 2);
    await merge(app, stays, closes);
    const again = await merge(app, stays, closes);
    expect(again.status).toBe(200);
    expect(((await again.json()) as MergeResponse).usd).toBe(5);
  });

  it('opens the balance that stays when it is new', async () => {
    const { app, ledger } = createTestApp();
    const closes = await fundedBalance(ledger, 2);
    const response = await merge(app, newBalanceSecret(), closes);
    expect(((await response.json()) as MergeResponse).usd).toBe(2);
  });

  it('refuses a balance that merges into itself, or a secret of another shape', async () => {
    const { app, ledger } = createTestApp();
    const secret = await fundedBalance(ledger, 2);
    const same = await merge(app, secret, secret);
    expect(same.status).toBe(400);
    expect(((await same.json()) as ErrorBody).error.code).toBe('invalid_request');
    expect((await merge(app, secret, 'short')).status).toBe(400);
    expect(ledger.balance(await balanceHash(secret))).toBe(usdToMicros(2));
  });
});

describe('the merge in the ledger', () => {
  it('moves a debt along, and changes nothing for a balance that does not exist', () => {
    const ledger = openLedger(':memory:');
    ledger.redeem('voucher-1', 'stays', usdToMicros(1));
    ledger.redeem('voucher-2', 'closes', usdToMicros(1));
    ledger.charge('closes', usdToMicros(1.5));
    expect(ledger.mergeBalance('closes', 'stays')).toBe('ok');
    expect(ledger.balance('stays')).toBe(usdToMicros(0.5));
    expect(ledger.balance('closes')).toBeNull();
    expect(ledger.mergeBalance('missing', 'stays')).toBe('unknown');
    expect(ledger.balance('stays')).toBe(usdToMicros(0.5));
  });
});
