// Thinkr Inference (decision 45): the OpenAI-compatible API of the private lane at api.thinkr.sh/v1.
// Its SDK verifies the enclave and seals each request, so the proxy forwards ciphertext only, as it
// does for the app (decision 64). An API key is the secret of a balance of its own, and a chat
// spends what is on it. GET /v1/models lists the models, GET /v1/attestation passes the proof of the
// router on, GET /v1/balance tells the credit of a key, POST /v1/keys/fill moves credit onto a key
// from the balance of the app (the owner, 30 Oct 2026), POST /v1/keys/close stops a key and moves
// what is left back, POST /v1/keys/redeem spends holder vouchers into a key for the dashboard, and
// POST /v1/chat/completions forwards a sealed chat. A move names the balance and the key in one
// request, and the ledger and the log keep neither beside the other.
import { Hono, type Context } from 'hono';

import type { Balance } from '../access/gate.js';
import { CREDIT } from '../config/credit.js';
import { INFERENCE } from '../config/inference.js';
import { MESSAGES } from '../config/messages.js';
import { MODEL_CATALOG, type CatalogModel } from '../config/models.js';
import { TINFOIL } from '../config/tinfoil.js';
import { balanceHash, isBalanceSecret, microsToUsd, userPricing } from '../credit/balance.js';
import type { Ledger } from '../credit/ledger.js';
import { checkNote } from '../credit/redeem.js';
import type { NoteKeys } from '../credit/note-key.js';
import {
  keyCloseRequestSchema,
  keyFillRequestSchema,
  keyRedeemRequestSchema,
  type InferenceModel,
  type InferenceModelsResponse,
  type KeyBalanceResponse,
  type KeyCloseResponse,
  type KeyFillResponse,
  type KeyRedeemResponse,
} from '../inference/contract.js';
import { parseBody, readJson } from '../lib/body.js';
import { ProxyError } from '../lib/errors.js';
import { fetchAttestation } from '../tinfoil/attestation.js';
import { forwardSealedChat, sealedChatLimit, type PrivateRouteDeps } from './private.js';

export interface InferenceRouteDeps extends PrivateRouteDeps {
  readonly ledger: Ledger;
  /** The public keys of the issuer, which check the holder vouchers that fill a key. */
  readonly noteKeys: NoteKeys;
}

/** A model of the private lane that Inference serves: one that takes a chat, with its enclave. */
type ServedModel = CatalogModel & { readonly info: { readonly teeModelId: string } };

export function createInferenceRoute(deps: InferenceRouteDeps): Hono {
  const models: InferenceModelsResponse = {
    object: 'list',
    data: MODEL_CATALOG.filter(isServed).map(inferenceModel),
  };
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
        return await forwardSealedChat(deps, c, async (visitor) => ({
          visitor,
          balance: await keyBalance(deps.ledger, c),
        }));
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

function isServed(model: CatalogModel): model is ServedModel {
  const { info } = model;
  return (
    info.lane === 'private' && info.kind === 'text' && info.available && info.teeModelId !== null
  );
}

function inferenceModel(model: ServedModel): InferenceModel {
  const { info } = model;
  const pricing = userPricing(model);
  return {
    id: info.teeModelId,
    object: 'model',
    owned_by: info.maker,
    name: info.name,
    context_length: info.contextTokens,
    pricing:
      pricing === null
        ? null
        : {
            input_usd_per_mtok: pricing.inputUsdPerMTok,
            output_usd_per_mtok: pricing.outputUsdPerMTok,
          },
    vision: info.vision,
    reasoning: info.reasoning,
  };
}
