import { describe, expect, it } from 'vitest';

import { CREDIT, MAX_TOP_UP_NOTES } from '../src/config/credit.js';
import { PAYMENT_WORDS } from '../src/config/payments.js';
import type {
  AccessResponse,
  CreditKeyResponse,
  ErrorBody,
  RedeemResponse,
} from '../src/contract.js';
import { newBalanceSecret } from '../src/credit/balance.js';
import { noteKeysOf } from '../src/credit/note-key.js';
import { fromBase64Url, toBase64Url } from '../src/lib/bytes.js';
import { changeKeysFromJson } from '../src/node/note-key.js';
import {
  balanceHeader,
  createTestApp,
  issuerBlindSign,
  TEST_CHANGE_KEY,
  TEST_HOLDER_KEY,
  TEST_HOLDER_MONTH,
  TEST_NOTE_KEY,
  type TestApp,
} from './helpers.js';
import { blindNotes, finalizeNote, redeemBody, signedNote } from './notes.js';

const KEY = TEST_NOTE_KEY;

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
    const notes = await blindNotes(KEY, 3);
    for (const note of notes) {
      const blindSignature = issuerBlindSign(KEY, note.blinded);
      const { nonce, signature } = await finalizeNote(KEY, note, blindSignature);
      expect(KEY.verify(nonce, signature)).toBe(true);
    }
  });

  it('refuses a voucher whose message or signature changed', async () => {
    const { nonce, signature } = await signedNote(KEY);
    const otherNonce = nonce.slice();
    otherNonce[0] = (otherNonce[0] ?? 0) ^ 1;
    expect(KEY.verify(otherNonce, signature)).toBe(false);
    expect(KEY.verify(nonce, signature.slice(1))).toBe(false);
  });
});

describe('the packs of a top-up', () => {
  it('never cost more than the cap of one top-up (decision 95)', () => {
    for (const notes of CREDIT.packs) {
      expect(notes * CREDIT.voucherUsd).toBeLessThanOrEqual(CREDIT.maxTopUpUsd);
    }
  });

  it('let a typed amount buy up to the cap, in whole vouchers', () => {
    expect(MAX_TOP_UP_NOTES).toBe(200);
    expect(MAX_TOP_UP_NOTES * CREDIT.voucherUsd).toBe(CREDIT.maxTopUpUsd);
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
      maxVouchers: MAX_TOP_UP_NOTES,
      payment: { network: 'Robinhood Chain', token: 'USDG', tokens: ['USDG', 'THKR'] },
      holderKeys: [
        {
          keyId: TEST_HOLDER_KEY.keyId,
          month: TEST_HOLDER_MONTH,
          voucherUsd: CREDIT.holderVoucherUsd,
        },
      ],
      changeKeys: [{ keyId: TEST_CHANGE_KEY.keyId, voucherUsd: 0.1 }],
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
    const first = await redeem(app, redeemBody(KEY, await signedNote(KEY), secret));
    expect((await first.json()) as RedeemResponse).toEqual({ usd: 1 });
    const second = await redeem(app, redeemBody(KEY, await signedNote(KEY), secret));
    expect((await second.json()) as RedeemResponse).toEqual({ usd: 2 });
    expect(await creditOf(app, secret)).toEqual({ usd: 2 });
  });

  it('adds what a note of change is worth, once (31 Oct 2026)', async () => {
    const { app } = createTestApp();
    const secret = newBalanceSecret();
    const note = await signedNote(TEST_CHANGE_KEY);
    const first = await redeem(app, redeemBody(TEST_CHANGE_KEY, note, secret));
    expect((await first.json()) as RedeemResponse).toEqual({ usd: 0.1 });
    const again = await redeem(app, redeemBody(TEST_CHANGE_KEY, note, secret));
    expect(await errorCode(again)).toBe('voucher_spent');
    expect(await creditOf(app, secret)).toEqual({ usd: 0.1 });
  });

  it('counts a note of change as a top-up, not as a holder voucher', async () => {
    const { app, ledger } = createTestApp();
    await redeem(
      app,
      redeemBody(TEST_CHANGE_KEY, await signedNote(TEST_CHANGE_KEY), newBalanceSecret()),
    );
    expect([...ledger.holderTotals().redeemed]).toEqual([]);
  });

  it('spends a voucher once, and a lost answer loses no credit', async () => {
    const { app } = createTestApp();
    const secret = newBalanceSecret();
    const note = await signedNote(KEY);
    expect((await redeem(app, redeemBody(KEY, note, secret))).status).toBe(200);
    const again = await redeem(app, redeemBody(KEY, note, newBalanceSecret()));
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe('voucher_spent');
    expect(await creditOf(app, secret)).toEqual({ usd: 1 });
  });

  it('refuses a voucher that the key did not sign', async () => {
    const { app } = createTestApp();
    const note = await signedNote(KEY);
    const forged = { nonce: note.nonce, signature: note.signature.map((byte) => byte ^ 1) };
    const response = await redeem(app, redeemBody(KEY, forged, newBalanceSecret()));
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('voucher_invalid');
  });

  it('asks for a new top-up when the key changed', async () => {
    const { app } = createTestApp();
    const body = redeemBody(KEY, await signedNote(KEY), newBalanceSecret());
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

describe('the keys of the notes of change on Node (31 Oct 2026)', () => {
  const spki = toBase64Url(TEST_CHANGE_KEY.publicKey);

  it('reads one key for each kind', () => {
    const keys = changeKeysFromJson(JSON.stringify({ 10: spki, 1: spki }));
    expect([...keys.keys()]).toEqual([10, 1]);
    expect(keys.get(10)?.keyId).toBe(TEST_CHANGE_KEY.keyId);
  });

  it('stops when a kind is missing', () => {
    expect(() => changeKeysFromJson(JSON.stringify({ 10: spki }))).toThrow(/lacks 1/);
  });

  it('takes no note of change while no file names their keys', () => {
    const keys = noteKeysOf(KEY, new Map([[TEST_HOLDER_MONTH, TEST_HOLDER_KEY]]));
    expect(keys.change).toEqual([]);
    expect(keys.find(TEST_CHANGE_KEY.keyId)).toBeNull();
  });
});
