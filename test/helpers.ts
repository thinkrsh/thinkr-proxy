// Shared helpers for the proxy tests: fake upstream streams, a test app, and credit.
import {
  constants,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
  randomUUID,
  type KeyObject,
} from 'node:crypto';

import { vi } from 'vitest';

import { createApp } from '../src/app.js';
import { CREDIT, NOTE_SIGNATURE } from '../src/config/credit.js';
import { MEDIA } from '../src/config/media.js';
import type { AccessMode, ChatEvent, ChatRequest } from '../src/contract.js';
import { balanceHash, newBalanceSecret, usdToMicros } from '../src/credit/balance.js';
import type { Ledger } from '../src/credit/ledger.js';
import type { Forward } from '../src/lib/forward.js';
import type { SyncStore } from '../src/sync/store.js';
import { readSseData } from '../src/lib/sse.js';
import { openLedger } from '../src/node/ledger.js';
import { openSyncStore } from '../src/node/sync-store.js';
import { noteKeysOf, type NoteKey } from '../src/credit/note-key.js';
import { noteKeyFromPublicPem } from '../src/node/note-key.js';

export const TEST_API_KEY = 'test-key';
export const TEST_TINFOIL_KEY = 'test-tinfoil-key';
export const TEST_CLIENT = 'client-1';

/** The private keys of the tests by key id, as the issuer holds them. */
const PRIVATE_KEYS = new Map<string, KeyObject>();

/**
 * A key pair of notes for all the tests of a file, since making an RSA key takes a moment. The
 * proxy gets its public key, as from the issuer; the tests sign with its private key.
 */
function testKey(): NoteKey {
  const pair = generateKeyPairSync('rsa', { modulusLength: NOTE_SIGNATURE.modulusBits });
  const key = noteKeyFromPublicPem(
    pair.publicKey.export({ type: 'spki', format: 'pem' }) as string,
  );
  PRIVATE_KEYS.set(key.keyId, pair.privateKey);
  return key;
}

/** The key of top-ups, and the holder key of October 2026. */
export const TEST_NOTE_KEY = testKey();
export const TEST_HOLDER_MONTH = '2026-10';
export const TEST_HOLDER_KEY = testKey();
/** The key of the notes of 10 cents of the tests. */
export const TEST_CHANGE_KEY = testKey();
export const TEST_NOTE_KEYS = noteKeysOf(
  TEST_NOTE_KEY,
  new Map([[TEST_HOLDER_MONTH, TEST_HOLDER_KEY]]),
  new Map([[10, TEST_CHANGE_KEY]]),
);

/** The key of the passes of free chats of October 2026. */
export const TEST_PASS_MONTH = '2026-10';
export const TEST_PASS_KEY = testKey();
export const TEST_PASS_KEYS = new Map([[TEST_PASS_MONTH, TEST_PASS_KEY]]);

/** Signs one blinded note with a key, as the issuer does (apps/issuer/src/node/note-key.ts). */
export function issuerBlindSign(key: NoteKey, blinded: Uint8Array): Uint8Array {
  const privateKey = PRIVATE_KEYS.get(key.keyId);
  if (privateKey === undefined) throw new Error('The tests hold no private key of this key.');
  return new Uint8Array(
    privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, blinded),
  );
}

/** The secret that seals the tickets of video jobs in the tests. */
export const TEST_TICKET_KEY = new Uint8Array(randomBytes(MEDIA.ticket.keyBytes));

/** A balance with this much credit, as if a note had opened it. Returns its secret. */
export async function fundedBalance(ledger: Ledger, usd: number): Promise<string> {
  const secret = newBalanceSecret();
  ledger.redeem(randomUUID(), await balanceHash(secret), usdToMicros(usd), null);
  return secret;
}

/** The header that names a balance. */
export function balanceHeader(secret: string): Record<string, string> {
  return { [CREDIT.balanceHeader]: secret };
}

export type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

/** A byte stream that sends each string as its own chunk. */
export function streamOf(parts: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

/** One SSE event of the OpenRouter stream, carrying the given chunk as JSON. */
export function chunk(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

export function contentChunk(content: string): string {
  return chunk({ choices: [{ index: 0, delta: { role: 'assistant', content } }] });
}

export const DONE = 'data: [DONE]\n\n';

export function upstreamResponse(parts: readonly string[]): Response {
  return new Response(streamOf(parts), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

export interface TestApp {
  readonly app: ReturnType<typeof createApp>;
  readonly fetchMock: FetchMock;
  readonly logs: string[];
  /** The ledger of this app, in memory. */
  readonly ledger: Ledger;
  /** The encrypted backups of this app. */
  readonly syncStore: SyncStore;
}

export interface TestAppOptions {
  readonly accessMode?: AccessMode;
  /** The trailers of each sealed answer, as the enclave would send them. */
  readonly trailers?: () => Headers;
  readonly now?: () => number;
  /** The backups; unset, a new store in memory. */
  readonly syncStore?: SyncStore;
  /** The public address where providers fetch sources; unset, the one of the tests. */
  readonly publicOrigin?: string | null;
}

/** The public address of the proxy in the tests, where providers fetch sources. */
export const TEST_PUBLIC_ORIGIN = 'https://chat.example.test';

/**
 * The forward of the private lane over the fetch mock, so that one mock sees every upstream call.
 * The answer carries the given trailers once its body is read.
 */
function forwardThrough(fetchMock: FetchMock, trailers: () => Headers): Forward {
  return async (url, init) => {
    const response = await fetchMock(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    });
    return {
      status: response.status,
      headers: response.headers,
      body: response.body ?? streamOf([]),
      trailers: Promise.resolve(trailers()),
    };
  };
}

export function createTestApp(
  fetchMock: FetchMock = vi.fn<typeof fetch>(),
  options: TestAppOptions = {},
): TestApp {
  const logs: string[] = [];
  const ledger = openLedger(':memory:');
  const syncStore = options.syncStore ?? openSyncStore(':memory:');
  const app = createApp({
    env: {
      openRouterApiKey: TEST_API_KEY,
      tinfoilApiKey: TEST_TINFOIL_KEY,
      accessMode: options.accessMode ?? 'full',
      clientAddressHeader: null,
      notePublicKeyFile: 'unused-in-tests.pem',
      holderPublicKeysFile: 'unused-in-tests.json',
      passPublicKeysFile: 'unused-in-tests.json',
      changePublicKeysFile: null,
      ticketKeyFile: 'unused-in-tests.txt',
      databaseFile: ':memory:',
      publicOrigin: options.publicOrigin === undefined ? TEST_PUBLIC_ORIGIN : options.publicOrigin,
    },
    ledger,
    noteKeys: TEST_NOTE_KEYS,
    passKeys: TEST_PASS_KEYS,
    ticketKey: TEST_TICKET_KEY,
    syncStore,
    fetch: fetchMock,
    forward: forwardThrough(fetchMock, options.trailers ?? (() => new Headers())),
    now: options.now ?? (() => Date.now()),
    clientKey: (c) => c.req.header('x-test-visitor') ?? TEST_CLIENT,
    log: (line) => {
      logs.push(line);
    },
  });
  return { app, fetchMock, logs, ledger, syncStore };
}

export const VALID_CHAT: ChatRequest = {
  modelId: 'open/glm-5.3-flash',
  messages: [{ role: 'user', content: 'Hello' }],
};

export function postChat(
  app: TestApp['app'],
  body: unknown,
  init: RequestInit = {},
): Promise<Response> {
  return Promise.resolve(
    app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      ...init,
    }),
  );
}

/** Reads every ChatEvent of a proxy response. */
export async function readEvents(response: Response): Promise<ChatEvent[]> {
  if (response.body === null) throw new Error('The response has no body.');
  const events: ChatEvent[] = [];
  for await (const data of readSseData(response.body)) events.push(JSON.parse(data) as ChatEvent);
  return events;
}

/** The method and the parameters of a call to the RPC of the chain. */
export function rpcCallOf(init: RequestInit | undefined): { method: string; params: unknown[] } {
  if (typeof init?.body !== 'string') throw new Error('The RPC call has no text body.');
  return JSON.parse(init.body) as { method: string; params: unknown[] };
}

/** The URL and the parsed JSON body of the n-th upstream call. */
export function upstreamCall(fetchMock: FetchMock, index = 0): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[index];
  if (call === undefined) throw new Error(`No upstream call ${String(index)}.`);
  const [input, init] = call;
  if (input instanceof Request || init === undefined) throw new Error('Unexpected fetch call.');
  return { url: String(input), init };
}
