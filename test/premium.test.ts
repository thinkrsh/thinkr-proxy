import { describe, expect, it, vi } from 'vitest';

import { CREDIT } from '../src/config/credit.js';
import { MESSAGES } from '../src/config/messages.js';
import { SERVER } from '../src/config/server.js';
import { TINFOIL } from '../src/config/tinfoil.js';
import type { AccessMode, ErrorBody, ModelsResponse } from '../src/contract.js';
import { balanceHash, usdToMicros } from '../src/credit/balance.js';
import {
  balanceHeader,
  createTestApp,
  fundedBalance,
  streamOf,
  upstreamCall,
  type TestApp,
} from './helpers.js';

const ROUTER = 'https://inference.tinfoil.sh';
const FILTER = TINFOIL.privacyFilter.enclaveUrl;
const NONCE = { [TINFOIL.headers.responseNonce]: 'cd'.repeat(32) };
const SEALED_BODY = new Uint8Array([0, 0, 0, 1, 9]);

interface PremiumRoute {
  readonly name: string;
  readonly path: string;
  readonly enclave: string;
  readonly upstreamPath: string;
  readonly contentType: string;
  /** Its fixed price; 0 for one that costs only what the enclave reports. */
  readonly priceUsd: number;
  /** The share of the reported cost that a balance pays when that is more than the price. */
  readonly costShare: number;
  /** What Tinfoil charges for each request. */
  readonly feeUsd: number;
}

const ROUTES: readonly PremiumRoute[] = [
  {
    name: 'a recording',
    path: `/api/private${TINFOIL.transcriptionPath}`,
    enclave: ROUTER,
    upstreamPath: TINFOIL.transcriptionPath,
    contentType: 'multipart/form-data; boundary=thinkr',
    priceUsd: CREDIT.voiceInputUsd,
    costShare: CREDIT.voiceInputCostShare,
    feeUsd: TINFOIL.fees.transcriptionUsd,
  },
  {
    name: 'a part of an answer to speak',
    path: `/api/private${TINFOIL.speechPath}`,
    enclave: ROUTER,
    upstreamPath: TINFOIL.speechPath,
    contentType: 'application/json',
    priceUsd: CREDIT.voiceReplyUsd,
    costShare: CREDIT.markup,
    feeUsd: TINFOIL.fees.speechUsd,
  },
  {
    name: 'a message for the privacy filter',
    path: `/api/private${SERVER.privacyFilterPath}${TINFOIL.privacyFilter.redactPath}`,
    enclave: FILTER,
    upstreamPath: TINFOIL.privacyFilter.redactPath,
    contentType: 'application/json',
    priceUsd: CREDIT.privacyFilterUsd,
    costShare: CREDIT.markup,
    feeUsd: TINFOIL.fees.privacyFilterUsd,
  },
];

/** An answer of the enclave, sent at once, with the usage in a header as the router sends it. */
function sealedAnswer(usage: string | null = null): Response {
  return new Response(streamOf(['sealed']), {
    status: 200,
    headers: { ...NONCE, ...(usage === null ? {} : { [TINFOIL.headers.usage]: usage }) },
  });
}

function appAnswering(answer: () => Response, accessMode: AccessMode = 'trial'): TestApp {
  return createTestApp(
    vi.fn<typeof fetch>(() => Promise.resolve(answer())),
    { accessMode },
  );
}

function postPremium(
  testApp: TestApp,
  route: PremiumRoute,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    testApp.app.request(route.path, {
      method: 'POST',
      headers: {
        'Content-Type': route.contentType,
        [TINFOIL.headers.encapsulatedKey]: 'ab'.repeat(32),
        [TINFOIL.headers.enclaveUrl]: route.enclave,
        ...headers,
      },
      body: SEALED_BODY,
    }),
  );
}

async function micros(testApp: TestApp, secret: string): Promise<number | null> {
  return testApp.ledger.balance(await balanceHash(secret));
}

async function errorOf(response: Response): Promise<ErrorBody['error']> {
  return ((await response.json()) as ErrorBody).error;
}

const FIXED_ROUTES = ROUTES.filter((route) => route.priceUsd > 0);

describe('the prices of Premium', () => {
  it.each(FIXED_ROUTES)('prices $name at the fee of Tinfoil plus 25%', (route) => {
    expect(route.priceUsd).toBeCloseTo(route.feeUsd * CREDIT.markup, 10);
    expect(route.costShare).toBe(CREDIT.markup);
  });

  it('prices a recording at what Tinfoil reports, less 25%, as a model (decision 134)', () => {
    expect(CREDIT.voiceInputUsd).toBe(0);
    expect(CREDIT.voiceInputCostShare).toBe(0.75);
  });

  it('lists them in the catalog for the app', async () => {
    const testApp = appAnswering(() => sealedAnswer());
    const { extras } = (await (await testApp.app.request('/api/models')).json()) as ModelsResponse;
    expect(extras).toMatchObject({
      voiceInputUsd: CREDIT.voiceInputUsd,
      voiceReplyUsd: CREDIT.voiceReplyUsd,
      privacyFilterUsd: CREDIT.privacyFilterUsd,
    });
  });
});

describe.each(ROUTES)('POST $path, $name', (route) => {
  it('sends the sealed body unchanged to its enclave, with the key of Thinkr and no model', async () => {
    const testApp = appAnswering(() => sealedAnswer());
    const secret = await fundedBalance(testApp.ledger, 1);
    const response = await postPremium(testApp, route, balanceHeader(secret));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('sealed');
    const { url, init } = upstreamCall(testApp.fetchMock);
    expect(url).toBe(`${route.enclave}${route.upstreamPath}`);
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(SEALED_BODY);
    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toBe(route.contentType);
    expect(headers.has(CREDIT.balanceHeader)).toBe(false);
    expect(headers.has(TINFOIL.headers.model)).toBe(false);
  });

  it('charges its price once the answer has passed whole, with no cost reported', async () => {
    const testApp = appAnswering(() => sealedAnswer());
    const secret = await fundedBalance(testApp.ledger, 1);
    await (await postPremium(testApp, route, balanceHeader(secret))).text();
    await vi.waitFor(async () => {
      expect(await micros(testApp, secret)).toBe(usdToMicros(1) - usdToMicros(route.priceUsd));
    });
  });

  it('charges its share of the reported cost when that is more than its price', async () => {
    const costUsd = route.feeUsd * 10;
    const testApp = appAnswering(() =>
      sealedAnswer(`prompt=0,completion=0,total=0,model=other,cost_usd=${String(costUsd)}`),
    );
    const secret = await fundedBalance(testApp.ledger, 1);
    await (await postPremium(testApp, route, balanceHeader(secret))).text();
    await vi.waitFor(async () => {
      expect(await micros(testApp, secret)).toBe(
        usdToMicros(1) - usdToMicros(costUsd * route.costShare),
      );
    });
  });

  it('charges nothing when the enclave fails', async () => {
    const testApp = appAnswering(() => new Response('busy', { status: 503 }));
    const secret = await fundedBalance(testApp.ledger, 1);
    expect((await postPremium(testApp, route, balanceHeader(secret))).status).toBe(502);
    expect(await micros(testApp, secret)).toBe(usdToMicros(1));
  });

  it('refuses the free trial before any forward, as a model locked for credit', async () => {
    const testApp = appAnswering(() => sealedAnswer());
    const response = await postPremium(testApp, route);
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toEqual({
      code: 'model_unavailable',
      message: MESSAGES.premiumOnly,
    });
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a balance that cannot cover its price, or that is empty', async () => {
    const testApp = appAnswering(() => sealedAnswer());
    const poor = await fundedBalance(testApp.ledger, route.priceUsd / 2);
    expect((await postPremium(testApp, route, balanceHeader(poor))).status).toBe(402);
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });

  it('opens free in the mode full of the laptop', async () => {
    const testApp = appAnswering(() => sealedAnswer(), 'full');
    expect((await postPremium(testApp, route)).status).toBe(200);
  });

  it('refuses a body that is not sealed', async () => {
    const testApp = appAnswering(() => sealedAnswer(), 'full');
    const response = await postPremium(testApp, route, {
      [TINFOIL.headers.encapsulatedKey]: 'not hex',
    });
    expect(response.status).toBe(400);
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });
});

describe('the enclave of the privacy filter', () => {
  const filterRoute = ROUTES[2];
  if (filterRoute === undefined) throw new Error('The routes lost the privacy filter.');

  it('forwards to that enclave only, never to the router', async () => {
    const testApp = appAnswering(() => sealedAnswer(), 'full');
    const response = await postPremium(testApp, filterRoute, {
      [TINFOIL.headers.enclaveUrl]: ROUTER,
    });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toEqual({
      code: 'invalid_request',
      message: MESSAGES.enclaveNotAllowed,
    });
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });

  it('passes its proof on, asking the attestation service for it and nothing else', async () => {
    const bundle = JSON.stringify({ domain: 'pii-filter.tinfoil.sh', digest: 'abc' });
    const testApp = appAnswering(() => new Response(bundle, { status: 200 }), 'full');
    const request = { enclaveUrl: FILTER, repo: TINFOIL.privacyFilter.configRepo };
    const response = await testApp.app.request('/api/private/attestation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Tinfoil-SDK': 'tinfoil-js', Cookie: 'a=1' },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(bundle);
    const { url, init } = upstreamCall(testApp.fetchMock);
    expect(url).toBe(TINFOIL.attestationUrl);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(request);
    expect([...new Headers(init.headers).keys()].sort()).toEqual(['content-type', 'tinfoil-sdk']);
  });

  it.each([
    ['another enclave', { enclaveUrl: 'https://evil.example', repo: 'tinfoilsh/x' }],
    ['another repository', { enclaveUrl: FILTER, repo: 'someone/else' }],
    ['a field more', { enclaveUrl: FILTER, repo: TINFOIL.privacyFilter.configRepo, extra: true }],
  ])('refuses the proof of %s', async (_name, request) => {
    const testApp = appAnswering(() => new Response('{}', { status: 200 }), 'full');
    const response = await testApp.app.request('/api/private/attestation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toEqual({
      code: 'invalid_request',
      message: MESSAGES.attestationNotAllowed,
    });
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });
});
