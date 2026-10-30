// Reads the environment once at startup and stops with a clear error when a variable is missing.
import { z } from 'zod';

import type { AccessMode } from '../contract.js';

const envSchema = z.object({
  OPENROUTER_API_KEY: z.string().trim().min(1),
  TINFOIL_API_KEY: z.string().trim().min(1),
  /** 'full' on the laptop of the owner; 'trial' on the server (decision 67). */
  ACCESS_MODE: z.enum(['full', 'trial']),
  /**
   * The header that carries the address of the visitor, such as CF-Connecting-IP behind Cloudflare
   * and Caddy. Unset, the proxy counts the address of the socket, as on the laptop.
   */
  CLIENT_ADDRESS_HEADER: z.string().trim().min(1).optional(),
  /**
   * The public key of the notes (RSA, PEM), which the issuer (apps/issuer/) signs with its
   * private key. The proxy holds no key that signs a note.
   */
  VOUCHER_PUBLIC_KEY_FILE: z.string().trim().min(1),
  /**
   * The public keys of holder vouchers, one for each month, as JSON: what
   * `npm run holder-keys -- public` of apps/issuer prints (decision 189).
   */
  HOLDER_PUBLIC_KEYS_FILE: z.string().trim().min(1),
  /**
   * The public keys of the notes of change, as JSON from `npm run change-keys -- public` of
   * apps/issuer. Unset, the proxy takes no note of change: no coin of top-ups is open.
   */
  CHANGE_PUBLIC_KEYS_FILE: z.string().trim().min(1).optional(),
  /** The secret that seals the tickets of video jobs: 32 bytes in base64url, on one line. */
  TICKET_KEY_FILE: z.string().trim().min(1),
  /** The SQLite file of the ledger: notes spent, balances, and video jobs settled. */
  DATABASE_FILE: z.string().trim().min(1),
  /**
   * The public HTTPS address of the proxy, such as https://chat.thinkr.sh, where a provider fetches
   * the source of a sourced video (decision 216). Unset, as on the laptop, no sourced video starts.
   */
  PUBLIC_ORIGIN: z
    .string()
    .trim()
    .regex(/^https:\/\/[a-z0-9.-]+(:\d+)?$/i)
    .optional(),
});

export interface Env {
  readonly openRouterApiKey: string;
  /** The key of the private lane. The proxy adds it to each sealed request it forwards. */
  readonly tinfoilApiKey: string;
  readonly accessMode: AccessMode;
  readonly clientAddressHeader: string | null;
  readonly notePublicKeyFile: string;
  readonly holderPublicKeysFile: string;
  readonly changePublicKeysFile: string | null;
  readonly ticketKeyFile: string;
  readonly databaseFile: string;
  /** The public HTTPS address of the proxy, without a slash at its end; null on the laptop. */
  readonly publicOrigin: string | null;
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

export function readEnv(source: EnvSource): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(
      `Missing or invalid environment variable: ${names.join(', ')}. ` +
        'Keys go in secret/openrouter.env and secret/tinfoil.env, settings in apps/proxy/env/ ' +
        '(on the laptop, the voucher keys, the ticket key, and the ledger are named in ' +
        'env/local.env) ' +
        '(see apps/proxy/.env.example).',
    );
  }
  return {
    openRouterApiKey: result.data.OPENROUTER_API_KEY,
    tinfoilApiKey: result.data.TINFOIL_API_KEY,
    accessMode: result.data.ACCESS_MODE,
    clientAddressHeader: result.data.CLIENT_ADDRESS_HEADER ?? null,
    notePublicKeyFile: result.data.VOUCHER_PUBLIC_KEY_FILE,
    holderPublicKeysFile: result.data.HOLDER_PUBLIC_KEYS_FILE,
    changePublicKeysFile: result.data.CHANGE_PUBLIC_KEYS_FILE ?? null,
    ticketKeyFile: result.data.TICKET_KEY_FILE,
    databaseFile: result.data.DATABASE_FILE,
    publicOrigin: result.data.PUBLIC_ORIGIN ?? null,
  };
}
