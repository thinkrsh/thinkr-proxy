import { describe, expect, it } from 'vitest';

import { MESSAGES } from '../src/config/messages.js';
import type { ErrorBody, HealthResponse, ModelsResponse } from '../src/contract.js';
import { createTestApp } from './helpers.js';

describe('GET /api/health', () => {
  it('answers ok without caching', async () => {
    const response = await createTestApp().app.request('/api/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual<HealthResponse>({ ok: true });
  });
});

describe('GET /api/models', () => {
  it('lists the catalog with a default model that can be used', async () => {
    const response = await createTestApp().app.request('/api/models');
    const body = (await response.json()) as ModelsResponse;
    const fallback = body.models.find((model) => model.id === body.defaultModelId);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(fallback?.available).toBe(true);
    expect(fallback?.lane).toBe('private');
  });

  it('gives each private model the id inside its TEE, and each open model none', async () => {
    const response = await createTestApp().app.request('/api/models');
    const { models } = (await response.json()) as ModelsResponse;
    for (const model of models) {
      if (model.lane === 'private') expect(model.teeModelId).toMatch(/^[a-z0-9-]+$/);
      else expect(model.teeModelId).toBeNull();
    }
  });

  it('never exposes the upstream slugs', async () => {
    const text = await (await createTestApp().app.request('/api/models')).text();
    expect(text).not.toContain('openRouterSlug');
    expect(text).not.toContain('z-ai/');
  });
});

describe('unknown routes', () => {
  it('answer 404 in the error shape of the contract', async () => {
    const { app, logs } = createTestApp();
    const response = await app.request('/api/nothing');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual<ErrorBody>({
      error: { code: 'invalid_request', message: MESSAGES.notFound },
    });
    expect(logs).toHaveLength(1);
  });
});

describe('the request log', () => {
  it('writes one line with method, path, status, and duration only', async () => {
    const { app, logs } = createTestApp();
    await app.request('/api/health');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\S+Z GET \/api\/health 200 \d+ms$/);
  });
});
