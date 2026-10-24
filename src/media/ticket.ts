// The ticket of a video job (the owner, 23 Oct 2026): the job at OpenRouter, its model, and what a
// balance paid ahead, sealed with AES-GCM under a secret of the proxy. The proxy keeps no
// record of a job until it settles; the app holds the ticket with its chat and sends it back to
// follow the job. Nobody can read a ticket or change what it says.
import { z } from 'zod';

import type { Prepayment } from '../access/gate.js';
import { MEDIA } from '../config/media.js';
import { MESSAGES } from '../config/messages.js';
import { concatBytes, fromBase64Url, randomBytes, toBase64Url } from '../lib/bytes.js';
import { ProxyError } from '../lib/errors.js';

/** What a ticket says. */
export interface JobClaims {
  /** The id of the job at OpenRouter. */
  readonly jobId: string;
  /** The catalog id of the model. */
  readonly modelId: string;
  readonly prepayment: Prepayment;
}

export interface TicketSealer {
  seal: (claims: JobClaims) => Promise<string>;
  /** Opens a ticket, or throws `invalid_request` for one that this proxy did not seal. */
  open: (ticket: string) => Promise<JobClaims>;
}

const sealedSchema = z.strictObject({
  v: z.literal(MEDIA.ticket.version),
  job: z.string().min(1),
  model: z.string().min(1),
  balance: z.string().min(1).nullable(),
  paid: z.number().int().nonnegative(),
});

const ALGORITHM = 'AES-GCM';

/** `secret`: the raw key of AES-GCM, `MEDIA.ticket.keyBytes` long. */
export function createTicketSealer(secret: Uint8Array): TicketSealer {
  const key = crypto.subtle.importKey('raw', new Uint8Array(secret), ALGORITHM, false, [
    'encrypt',
    'decrypt',
  ]);

  return {
    async seal({ jobId, modelId, prepayment }) {
      const body: z.infer<typeof sealedSchema> = {
        v: MEDIA.ticket.version,
        job: jobId,
        model: modelId,
        balance: prepayment.balanceHash,
        paid: prepayment.micros,
      };
      const iv = randomBytes(MEDIA.ticket.ivBytes);
      const plain = new TextEncoder().encode(JSON.stringify(body));
      const sealed = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, await key, plain);
      return toBase64Url(concatBytes([iv, new Uint8Array(sealed)]));
    },
    async open(ticket) {
      const body = sealedSchema.safeParse(await decrypt(await key, ticket));
      if (!body.success) throw invalidTicket();
      return {
        jobId: body.data.job,
        modelId: body.data.model,
        prepayment: { balanceHash: body.data.balance, micros: body.data.paid },
      };
    },
  };
}

/**
 * The key of the tickets, as Web Crypto gives it. The build loads no DOM types (lib ES2023, types
 * node), so the type comes from importKey itself, not from the name CryptoKey.
 */
type TicketKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** The JSON inside a ticket, or throws when the ticket was not sealed under this key. */
async function decrypt(key: TicketKey, ticket: string): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(ticket);
  } catch {
    throw invalidTicket();
  }
  const iv = bytes.slice(0, MEDIA.ticket.ivBytes);
  const sealed = bytes.slice(MEDIA.ticket.ivBytes);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, sealed);
  } catch {
    throw invalidTicket();
  }
  try {
    return JSON.parse(new TextDecoder().decode(plain)) as unknown;
  } catch {
    throw invalidTicket();
  }
}

function invalidTicket(): ProxyError {
  return new ProxyError('invalid_request', MESSAGES.ticketInvalid);
}
