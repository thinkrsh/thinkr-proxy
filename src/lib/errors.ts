// Errors the proxy reports to the app, with the HTTP status of each code.
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { MESSAGES } from '../config/messages.js';
import type { ErrorBody, ErrorCode } from '../contract.js';

export const ERROR_STATUS = {
  invalid_request: 400,
  unknown_model: 404,
  model_unavailable: 403,
  rate_limited: 429,
  upstream_error: 502,
  upstream_timeout: 504,
  internal_error: 500,
  quota_exceeded: 429,
  trial_paused: 429,
  key_changed: 409,
  voucher_invalid: 400,
  voucher_spent: 409,
  balance_unknown: 401,
  balance_low: 402,
  pass_invalid: 400,
  pass_spent: 409,
  pass_paused: 429,
  pass_too_long: 413,
} as const satisfies Record<ErrorCode, ContentfulStatusCode>;

export class ProxyError extends Error {
  override readonly name = 'ProxyError';
  readonly code: ErrorCode;
  readonly status: ContentfulStatusCode;

  constructor(code: ErrorCode, message: string, status: ContentfulStatusCode = ERROR_STATUS[code]) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

/** The error for an upstream that answered with an HTTP error before any answer started. */
export function upstreamStatusError(status: number): ProxyError {
  if (status === 429) return new ProxyError('upstream_error', MESSAGES.upstreamBusy);
  if (status === 503) return new ProxyError('upstream_error', MESSAGES.upstreamNoProvider);
  return new ProxyError('upstream_error', MESSAGES.upstreamStatus(status));
}
