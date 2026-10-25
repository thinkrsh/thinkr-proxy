import { describe, expect, it } from 'vitest';

import { CREDIT, MAX_TOP_UP_VOUCHERS } from '../src/config/credit.js';
import { PAYMENT_WORDS } from '../src/config/payments.js';
import type {
  AccessResponse,
  CreditKeyResponse,
  ErrorBody,
  RedeemResponse,
} from '../src/contract.js';
import { newBalanceSecret } from '../src/credit/balance.js';
import { fromBase64Url } from '../src/lib/bytes.js';
import {
  balanceHeader,
  createTestApp,
  issuerBlindSign,
  TEST_HOLDER_KEY,
  TEST_HOLDER_MONTH,
  TEST_VOUCHER_KEY,
  type TestApp,
} from './helpers.js';
import { blindVouchers, finalizeVoucher, redeemBody, signedVoucher } from './vouchers.js';

const KEY = TEST_VOUCHER_KEY;

function redeem(app: TestApp['app'], body: string): Promise<Response> {
  return Promise.resolve(
    app.request('/api/credit/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }),
  );
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as ErrorBody).error.code;
}

async function creditOf(app: TestApp['app'], secret: string): Promise<AccessResponse['credit']> {
  const response = await app.request('/api/access', { headers: balanceHeader(secret) });
  return ((await response.json()) as AccessResponse).credit;
}

describe('the voucher key', () => {
  it('passes vouchers that the issuer signed blinded (RFC 9474)', async () => {
    const vouchers = await blindVouchers(KEY, 3);
    for (const voucher of vouchers) {
      const blindSignature = issuerBlindSign(KEY, voucher.blinded);
      const { nonce, signature } = await finalizeVoucher(KEY, voucher, blindSignature);
      expect(KEY.verify(nonce, signature)).toBe(true);
    }
  });

  it('refuses a voucher whose message or signature changed', async () => {
    const { nonce, signature } = await signedVoucher(KEY);
    const otherNonce = nonce.slice();
    otherNonce[0] = (otherNonce[0] ?? 0) ^ 1;
    expect(KEY.verify(otherNonce, signature)).toBe(false);
    expect(KEY.verify(nonce, signature.slice(1))).toBe(false);
  });
});

describe('the packs of a top-up', () => {
  it('never cost more than the cap of one top-up (decision 95)', () => {
    for (const vouchers of CREDIT.packs) {
      expect(vouchers * CREDIT.voucherUsd).toBeLessThanOrEqual(CREDIT.maxTopUpUsd);
    }
  });

  it('let a typed amount buy up to the cap, in whole vouchers', () => {
    expect(MAX_TOP_UP_VOUCHERS).toBe(200);
    expect(MAX_TOP_UP_VOUCHERS * CREDIT.voucherUsd).toBe(CREDIT.maxTopUpUsd);
  });
});

describe('GET /api/credit/key', () => {
  it('gives the public key that the app blinds with, the packs, and the way to pay', async () => {
    const response = await createTestApp().app.request('/api/credit/key');
    const body = (await response.json()) as CreditKeyResponse;
    expect(body).toMatchObject({
      keyId: KEY.keyId,
      voucherUsd: CREDIT.voucherUsd,
      packs: [...CREDIT.packs],
      maxVouchers: MAX_TOP_UP_VOUCHERS,
      payment: { network: 'Robinhood Chain', token: 'USDG', tokens: ['USDG', 'THKR'] },
      holderKeys: [
        {
          keyId: TEST_HOLDER_KEY.keyId,
          month: TEST_HOLDER_MONTH,
          voucherUsd: CREDIT.holderVoucherUsd,
        },
      ],
    });
    expect(fromBase64Url(body.publicKey)).toEqual(KEY.publicKey);
  });

  it('names the payment of the issuer on mainnet (decision 82)', async () => {
    const response = await createTestApp().app.request('/api/credit/key');
    expect(((await response.json()) as CreditKeyResponse).payment).toEqual({
      ...PAYMENT_WORDS,
      testnet: false,
    });
  });
});

describe('POST /api/credit/redeem', () => {
  it('opens the balance that the app names, then adds a second voucher to it', async () => {
    const { app } = createTestApp();
    const secret = newBalanceSecret();
    const first = await redeem(app, redeemBody(KEY, await signedVoucher(KEY), secret));
    expect((await first.json()) as RedeemResponse).toEqual({ usd: 1 });
    const second = await redeem(app, redeemBody(KEY, await signedVoucher(KEY), secret));
    expect((await second.json()) as RedeemResponse).toEqual({ usd: 2 });
    expect(await creditOf(app, secret)).toEqual({ usd: 2 });
  });

  it('spends a voucher once, and a lost answer loses no credit', async () => {
    const { app } = createTestApp();
    const secret = newBalanceSecret();
    const voucher = await signedVoucher(KEY);
    expect((await redeem(app, redeemBody(KEY, voucher, secret))).status).toBe(200);
    const again = await redeem(app, redeemBody(KEY, voucher, newBalanceSecret()));
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe('voucher_spent');
    expect(await creditOf(app, secret)).toEqual({ usd: 1 });
  });

  it('refuses a voucher that the key did not sign', async () => {
    const { app } = createTestApp();
    const voucher = await signedVoucher(KEY);
    const forged = { nonce: voucher.nonce, signature: voucher.signature.map((byte) => byte ^ 1) };
    const response = await redeem(app, redeemBody(KEY, forged, newBalanceSecret()));
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('voucher_invalid');
  });

  it('asks for a new top-up when the key changed', async () => {
    const { app } = createTestApp();
    const body = redeemBody(KEY, await signedVoucher(KEY), newBalanceSecret());
    const changed = { ...(JSON.parse(body) as Record<string, string>), keyId: '0'.repeat(16) };
    const response = await redeem(app, JSON.stringify(changed));
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('key_changed');
  });

  it('refuses a body without the shape of a voucher', async () => {
    const response = await redeem(createTestApp().app, JSON.stringify({ keyId: KEY.keyId }));
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_request');
  });
});

describe('GET /api/access with a balance', () => {
  it('reports a balance that does not exist', async () => {
    const response = await createTestApp().app.request('/api/access', {
      headers: balanceHeader(newBalanceSecret()),
    });
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('balance_unknown');
  });
});
