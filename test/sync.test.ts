import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SYNC } from '../src/config/sync.js';
import { openSyncStore } from '../src/node/sync-store.js';
import { createTestApp, type TestApp } from './helpers.js';

/** A history as the app of the client holds it: the name of its backup and the token to write it. */
interface History {
  storeId: string;
  writeToken: string;
}

function newHistory(): History {
  return { storeId: randomBytes(32).toString('hex'), writeToken: randomBytes(32).toString('hex') };
}

/** The envelope of a backup, as apps/sync seals it; the ciphertext is opaque to the proxy. */
function backupBody(marker: string): string {
  return JSON.stringify({
    v: 1,
    format: 'thinkr-sync-backup',
    keys: [
      {
        v: 1,
        kind: 'passkey',
        credentialId: 'Y3JlZGVudGlhbA',
        prfSalt: 'c2FsdA',
        nonce: 'bm9uY2U',
        ciphertext: 'd3JhcHBlZA',
      },
    ],
    nonce: 'bm9uY2U',
    ciphertext: Buffer.from(marker).toString('base64url'),
  });
}

function put(
  app: TestApp['app'],
  history: History,
  body: string,
  headers: Record<string, string>,
  visitor?: string,
): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/sync/${history.storeId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(visitor === undefined ? {} : { 'x-test-visitor': visitor }),
        ...headers,
      },
      body,
    }),
  );
}

function auth(history: History): Record<string, string> {
  return { Authorization: `Bearer ${history.writeToken}` };
}

/** Pushes the first backup of a history and returns its tag. */
async function create(app: TestApp['app'], history: History, marker = 'first'): Promise<string> {
  const response = await put(app, history, backupBody(marker), {
    ...auth(history),
    'If-None-Match': '*',
  });
  expect(response.status).toBe(201);
  return response.headers.get('ETag') ?? '';
}

describe('the backups of the app', () => {
  it('keeps a backup, gives it back with its tag, and answers 304 for that tag', async () => {
    const { app } = createTestApp();
    const history = newHistory();
    const etag = await create(app, history);
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

    const pulled = await app.request(`/api/sync/${history.storeId}`);
    expect(pulled.status).toBe(200);
    expect(pulled.headers.get('ETag')).toBe(etag);
    expect(await pulled.text()).toBe(backupBody('first'));

    const unchanged = await app.request(`/api/sync/${history.storeId}`, {
      headers: { 'If-None-Match': etag },
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe('');
  });

  it('replaces a backup over its tag, and refuses a write from a stale tag', async () => {
    const { app } = createTestApp();
    const history = newHistory();
    const first = await create(app, history);
    const replaced = await put(app, history, backupBody('second'), {
      ...auth(history),
      'If-Match': first,
    });
    expect(replaced.status).toBe(200);
    const second = replaced.headers.get('ETag');
    expect(second).not.toBe(first);

    const stale = await put(app, history, backupBody('third'), {
      ...auth(history),
      'If-Match': first,
    });
    expect(stale.status).toBe(412);
    expect(
      (await put(app, history, backupBody('third'), { ...auth(history), 'If-None-Match': '*' }))
        .status,
    ).toBe(412);
    expect((await put(app, history, backupBody('third'), auth(history))).status).toBe(428);
    const pulled = await app.request(`/api/sync/${history.storeId}`);
    expect(pulled.headers.get('ETag')).toBe(second);
  });

  it('knows its tag in the forms that a proxy in between gives it', async () => {
    const { app } = createTestApp();
    const history = newHistory();
    const etag = await create(app, history);
    const weak = `W/${etag}`;
    const unchanged = await app.request(`/api/sync/${history.storeId}`, {
      headers: { 'If-None-Match': weak },
    });
    expect(unchanged.status).toBe(304);
    const replaced = await put(app, history, backupBody('second'), {
      ...auth(history),
      'If-Match': etag.replace(/"$/, '-zstd"'),
    });
    expect(replaced.status).toBe(200);
  });

  it('refuses a write without the write token, or with the token of another history', async () => {
    const { app } = createTestApp();
    const history = newHistory();
    expect((await put(app, history, backupBody('x'), { 'If-None-Match': '*' })).status).toBe(401);
    const etag = await create(app, history);
    const stranger = { ...newHistory(), storeId: history.storeId };
    expect(
      (await put(app, history, backupBody('x'), { ...auth(stranger), 'If-Match': etag })).status,
    ).toBe(403);
    const removed = await app.request(`/api/sync/${history.storeId}`, {
      method: 'DELETE',
      headers: auth(stranger),
    });
    expect(removed.status).toBe(403);
  });

  it('refuses a body that is not a backup, or one past the limit', async () => {
    const { app } = createTestApp();
    const history = newHistory();
    const headers = { ...auth(history), 'If-None-Match': '*' };
    expect((await put(app, history, '{"chats":["plain"]}', headers)).status).toBe(400);
    expect((await put(app, history, 'not json', headers)).status).toBe(400);
    expect((await put(app, history, 'x'.repeat(SYNC.maxBackupBytes + 1), headers)).status).toBe(
      413,
    );
  });

  it('takes no new backup once all backups together reach the limit', async () => {
    const store = openSyncStore(':memory:');
    const { app } = createTestApp(undefined, {
      syncStore: { ...store, totalBytes: () => SYNC.maxTotalBytes - 10 },
    });
    const history = newHistory();
    const response = await put(app, history, backupBody('x'), {
      ...auth(history),
      'If-None-Match': '*',
    });
    expect(response.status).toBe(413);
  });

  it('limits the new backups of one client address in a day', async () => {
    const { app } = createTestApp();
    for (let i = 0; i < SYNC.newBackupsPerWindow; i++) {
      const history = newHistory();
      const response = await put(
        app,
        history,
        backupBody('x'),
        { ...auth(history), 'If-None-Match': '*' },
        'busy',
      );
      expect(response.status).toBe(201);
    }
    const history = newHistory();
    const headers = { ...auth(history), 'If-None-Match': '*' };
    expect((await put(app, history, backupBody('x'), headers, 'busy')).status).toBe(429);
    expect((await put(app, history, backupBody('x'), headers, 'other')).status).toBe(201);
  });

  it('deletes a backup with its write token', async () => {
    const { app } = createTestApp();
    const history = newHistory();
    await create(app, history);
    const removed = await app.request(`/api/sync/${history.storeId}`, {
      method: 'DELETE',
      headers: auth(history),
    });
    expect(removed.status).toBe(204);
    expect((await app.request(`/api/sync/${history.storeId}`)).status).toBe(404);
  });

  it('answers 404 for a path that is not a store ID', async () => {
    const { app } = createTestApp();
    expect((await app.request('/api/sync/not-a-store')).status).toBe(404);
    expect((await app.request(`/api/sync/${'A'.repeat(64)}`)).status).toBe(404);
  });

  it('writes no store ID into its log', async () => {
    const { app, logs } = createTestApp();
    const history = newHistory();
    await create(app, history);
    await app.request(`/api/sync/${history.storeId}`);
    expect(logs.join('\n')).not.toContain(history.storeId);
    expect(logs.some((line) => line.includes('GET /api/sync/:store 200'))).toBe(true);
  });
});
