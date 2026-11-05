// Thinkr Inference (decision 45): the OpenAI-compatible API at api.thinkr.sh/v1. For a model of the
// private lane, its SDK verifies the enclave and seals each request, so the proxy forwards ciphertext
// only, as it does for the app (decision 64). A model of ZDR or Open takes plain JSON, which the proxy
// reads and sends to OpenRouter (inference/plain-chat.ts). An API key is the secret of a balance of
// its own, and a chat spends what is on it. GET /v1/models lists the models, GET /v1/attestation
// passes the proof of the router on, GET /v1/balance tells the credit of a key, POST /v1/keys/fill
// moves credit onto a key from the balance of the app (the owner, 30 Oct 2026), POST /v1/keys/close
// stops a key and moves what is left back, POST /v1/keys/redeem spends holder vouchers into a key for
// the dashboard, and POST /v1/chat/completions takes a plain chat, or forwards a sealed one, as raw
// frames or in the text encoding of INFERENCE.bodyEncoding, for a caller such as Postman. A move
// names the balance and the key in one request, and the ledger and the log keep neither beside the
// other.
import { Hono, type Context } from 'hono';

import type { Balance } from '../access/gate.js';
import { CREDIT } from '../config/credit.js';
import { INFERENCE } from '../config/inference.js';
import { MESSAGES } from '../config/messages.js';
import { TINFOIL } from '../config/tinfoil.js';
import { balanceHash, isBalanceSecret, microsToUsd } from '../credit/balance.js';
import type { Ledger } from '../credit/ledger.js';
import { checkNote } from '../credit/redeem.js';
import type { NoteKeys } from '../credit/note-key.js';
import {
  keyCloseRequestSchema,
  keyFillRequestSchema,
  keyRedeemRequestSchema,
  type EncodedChatAnswer,
  type InferenceModelsResponse,
  type KeyBalanceResponse,
  type KeyCloseResponse,
  type KeyFillResponse,
  type KeyRedeemResponse,
} from '../inference/contract.js';
import { listInferenceModels } from '../inference/models.js';
import { createOpenChats, startPlainChat, type OpenChats } from '../inference/plain-chat.js';
import { parseBody, readJson } from '../lib/body.js';
import { fromBase64Url, toBase64Url } from '../lib/bytes.js';
import { ProxyError } from '../lib/errors.js';
import type { LogLine } from '../lib/log.js';
import { fetchAttestation } from '../tinfoil/attestation.js';
import { forwardSealedChat, sealedChatLimit, type PrivateRouteDeps } from './private.js';

export interface InferenceRouteDeps extends PrivateRouteDeps {
  readonly ledger: Ledger;
  /** The public keys of the issuer, which check the holder vouchers that fill a key. */
  readonly noteKeys: NoteKeys;
  /** The key of OpenRouter, for the chats of ZDR and Open. `apiKey` is that of the private lane. */
  readonly openRouterApiKey: string;
  readonly log: LogLine;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function createInferenceRoute(deps: InferenceRouteDeps): Hono {
  const models: InferenceModelsResponse = {
    object: 'list',
    data: listInferenceModels(),
  };
  const openChats = createOpenChats();
  return new Hono()
    .basePath(INFERENCE.basePath)
    .get(INFERENCE.modelsPath, (c) => c.json<InferenceModelsResponse>(models))
    .get(INFERENCE.attestationPath, (c) =>
      fetchAttestation(deps, c.req.raw.headers, c.req.raw.signal),
    )
    .get(INFERENCE.balancePath, async (c) => {
      takeRequest(deps, c);
      const key = await keyBalance(deps.ledger, c);
      return c.json<KeyBalanceResponse>({ usd: microsToUsd(key.micros) });
    })
    .post(INFERENCE.redeemPath, async (c) =>
      c.json<KeyRedeemResponse>(await redeemIntoKey(deps, c)),
    )
    .post(INFERENCE.fillPath, async (c) => c.json<KeyFillResponse>(await fillKey(deps, c)))
    .post(INFERENCE.closePath, async (c) => c.json<KeyCloseResponse>(await closeKey(deps, c)))
    .post(TINFOIL.chatCompletionsPath, sealedChatLimit(), async (c) => {
      try {
        return isEncrypted(c) ? await encryptedChat(deps, c) : await plainChat(deps, openChats, c);
      } catch (error) {
        // The gate tells a chat to top up, which an API key never does.
        if (error instanceof ProxyError && error.code === 'balance_low') {
          throw new ProxyError('balance_low', INFERENCE.messages.creditLow);
        }
        throw error;
      }
    });
}

/**
 * True for a request that the SDK or its local bridge sealed, which names the seal, its encoding, or
 * the model in its headers. The body of any other request is the chat itself.
 */
function isEncrypted(c: Context): boolean {
  return [
    TINFOIL.headers.encapsulatedKey,
    TINFOIL.headers.model,
    INFERENCE.bodyEncodingHeader,
  ].some((name) => c.req.header(name) !== undefined);
}

async function encryptedChat(deps: InferenceRouteDeps, c: Context): Promise<Response> {
  const encoded = await decodeBody(c);
  const answer = await forwardSealedChat(deps, c, async (visitor) => ({
    visitor,
    balance: await keyBalance(deps.ledger, c),
  }));
  return encoded ? encodedAnswer(answer) : answer;
}

/** A chat of ZDR or Open, or a refusal of a chat of the private lane sent without its seal. */
async function plainChat(
  deps: InferenceRouteDeps,
  openChats: OpenChats,
  c: Context,
): Promise<Response> {
  takeRequest(deps, c);
  const balance = await keyBalance(deps.ledger, c);
  return startPlainChat(
    { ...deps, apiKey: deps.openRouterApiKey, openChats },
    { visitor: deps.clientKey(c), balance },
    await readJson(c),
  );
}

/**
 * Puts the encrypted frames of a body sent as text in place of that text, and tells whether it did.
 * The frames stay encrypted, so this reads nothing of the chat.
 */
async function decodeBody(c: Context): Promise<boolean> {
  const encoding = c.req.header(INFERENCE.bodyEncodingHeader);
  if (encoding === undefined) return false;
  if (encoding !== INFERENCE.bodyEncoding) {
    throw new ProxyError('invalid_request', INFERENCE.messages.encodingUnknown);
  }
  const text = (await c.req.raw.text()).trim();
  if (!BASE64URL.test(text)) {
    throw new ProxyError('invalid_request', INFERENCE.messages.encodedBodyInvalid);
  }
  c.req.raw = new Request(c.req.raw, { body: new Uint8Array(fromBase64Url(text)) });
  return true;
}

/**
 * The whole encrypted answer as text, with its nonce. An error comes with no frames and stays as it
 * is. Reading the answer to its end is what lets the chat be paid, as a stream does.
 */
async function encodedAnswer(answer: Response): Promise<Response> {
  if (!answer.ok) return answer;
  const nonce = answer.headers.get(TINFOIL.headers.responseNonce);
  if (nonce === null) throw new ProxyError('upstream_error', MESSAGES.upstreamUnreadable);
  const ciphertext = toBase64Url(new Uint8Array(await answer.arrayBuffer()));
  return Response.json({ nonce, ciphertext } satisfies EncodedChatAnswer);
}

/**
 * Spends holder vouchers into a key. Every note is checked before any is spent, so a note of
 * a top-up refuses the whole call; a note spent before is skipped, so a call can be sent again.
 */
async function redeemIntoKey(deps: InferenceRouteDeps, c: Context): Promise<KeyRedeemResponse> {
  takeRequest(deps, c);
  const request = parseBody(keyRedeemRequestSchema, await readJson(c));
  const secret = keySecret(request.key);
  if (secret === null) throw new ProxyError('invalid_request', INFERENCE.messages.keyRequired);
  const notes = await Promise.all(request.vouchers.map((note) => checkNote(deps.noteKeys, note)));
  if (notes.some((note) => note.holderMonth === null)) {
    throw new ProxyError('voucher_invalid', INFERENCE.messages.holderOnly);
  }
  const hash = await balanceHash(secret);
  let redeemed = 0;
  for (const note of notes) {
    if (deps.ledger.redeem(note.hash, hash, note.micros, note.holderMonth) === 'ok') {
      redeemed += 1;
    }
  }
  return {
    usd: microsToUsd(deps.ledger.balance(hash) ?? 0),
    redeemed,
    spent: notes.length - redeemed,
  };
}

/** Moves credit from the balance of the app onto a key. A call sent again moves nothing more. */
async function fillKey(deps: InferenceRouteDeps, c: Context): Promise<KeyFillResponse> {
  takeRequest(deps, c);
  const request = parseBody(keyFillRequestSchema, await readJson(c));
  const secret = secretOfOtherKey(request.key, request.balance);
  const from = await balanceHash(request.balance);
  const into = await balanceHash(secret);
  const micros = Math.round(request.usd * CREDIT.microsPerUsd);
  const moved = deps.ledger.moveCredit(await balanceHash(request.fill), from, into, micros);
  if (moved === 'unknown') {
    throw new ProxyError('balance_unknown', INFERENCE.messages.balanceUnknown);
  }
  if (moved === 'low') throw new ProxyError('balance_low', INFERENCE.messages.fillLow);
  return {
    usd: microsToUsd(deps.ledger.balance(into) ?? 0),
    balance: microsToUsd(deps.ledger.balance(from) ?? 0),
  };
}

/** Stops a key, and moves what is left on it, or its debt, onto the balance of the app. */
async function closeKey(deps: InferenceRouteDeps, c: Context): Promise<KeyCloseResponse> {
  takeRequest(deps, c);
  const request = parseBody(keyCloseRequestSchema, await readJson(c));
  const secret = secretOfOtherKey(request.key, request.balance);
  const into = await balanceHash(request.balance);
  if (deps.ledger.mergeBalance(await balanceHash(secret), into) === 'unknown') {
    throw new ProxyError('balance_unknown', INFERENCE.messages.keyUnknown);
  }
  return { usd: microsToUsd(deps.ledger.balance(into) ?? 0) };
}

/** The secret of a key of the right shape that is not the balance it moves credit with. */
function secretOfOtherKey(key: string, balance: string): string {
  const secret = keySecret(key);
  if (secret === null) throw new ProxyError('invalid_request', INFERENCE.messages.keyRequired);
  if (secret === balance) throw new ProxyError('invalid_request', INFERENCE.messages.keyIsBalance);
  return secret;
}

/** The key of the request, with what is on it as the balance that pays. */
async function keyBalance(ledger: Ledger, c: Context): Promise<Balance> {
  const secret = keySecret(bearerOf(c.req.header('Authorization')));
  if (secret === null) throw new ProxyError('balance_unknown', INFERENCE.messages.keyRequired);
  const hash = await balanceHash(secret);
  const micros = ledger.balance(hash);
  if (micros === null) throw new ProxyError('balance_unknown', INFERENCE.messages.keyUnknown);
  return { hash, micros };
}

/** The token of an Authorization header of the Bearer scheme, whose name takes any case. */
function bearerOf(header: string | undefined): string | undefined {
  const scheme = `${INFERENCE.authScheme} `.toLowerCase();
  if (header?.slice(0, scheme.length).toLowerCase() !== scheme) return undefined;
  return header.slice(scheme.length).trim();
}

/** The secret of the balance that an API key holds, or null for text of another shape. */
function keySecret(key: string | undefined): string | null {
  if (key?.startsWith(INFERENCE.keyPrefix) !== true) return null;
  const secret = key.slice(INFERENCE.keyPrefix.length);
  return isBalanceSecret(secret) ? secret : null;
}

/** Every route of a key counts against the limit of Inference, per client address. */
function takeRequest(deps: InferenceRouteDeps, c: Context): void {
  if (!deps.limiter.take(deps.clientKey(c), deps.now())) {
    throw new ProxyError('rate_limited', MESSAGES.rateLimited);
  }
}
