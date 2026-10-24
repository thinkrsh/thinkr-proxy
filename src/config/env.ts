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
   * The public key of the vouchers (RSA, PEM), which the issuer (apps/issuer/) signs with its
   * private key. The proxy holds no key that signs a voucher.
   */
  VOUCHER_PUBLIC_KEY_FILE: z.string().trim().min(1),
  /** The secret that seals the tickets of video jobs: 32 bytes in base64url, on one line. */
  TICKET_KEY_FILE: z.string().trim().min(1),
  /** The SQLite file of the ledger: vouchers spent, balances, and video jobs settled. */
  DATABASE_FILE: z.string().trim().min(1),
});

export interface Env {
  readonly openRouterApiKey: string;
  /** The key of the private lane. The proxy adds it to each sealed request it forwards. */
  readonly tinfoilApiKey: string;
  readonly accessMode: AccessMode;
  readonly clientAddressHeader: string | null;
  readonly voucherPublicKeyFile: string;
  readonly ticketKeyFile: string;
  readonly databaseFile: string;
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

export function readEnv(source: EnvSource): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(
      `Missing or invalid environment variable: ${names.join(', ')}. ` +
        'Keys go in secret/openrouter.env and secret/tinfoil.env, settings in apps/proxy/env/ ' +
        '(on the laptop, the voucher key, the ticket key, and the ledger are named in ' +
        'env/local.env) ' +
        '(see apps/proxy/.env.example).',
    );
  }
  return {
    openRouterApiKey: result.data.OPENROUTER_API_KEY,
    tinfoilApiKey: result.data.TINFOIL_API_KEY,
    accessMode: result.data.ACCESS_MODE,
    clientAddressHeader: result.data.CLIENT_ADDRESS_HEADER ?? null,
    voucherPublicKeyFile: result.data.VOUCHER_PUBLIC_KEY_FILE,
    ticketKeyFile: result.data.TICKET_KEY_FILE,
    databaseFile: result.data.DATABASE_FILE,
  };
}
