import { describe, expect, it } from 'vitest';

import { readEnv } from '../src/config/env.js';

const LAPTOP = {
  OPENROUTER_API_KEY: 'sk-test',
  TINFOIL_API_KEY: 'tk-test',
  ACCESS_MODE: 'full',
  VOUCHER_PUBLIC_KEY_FILE: '../../secret/voucher-dev-public.pem',
  TICKET_KEY_FILE: '../../secret/ticket-key-dev.txt',
  DATABASE_FILE: '.data/ledger.db',
};

describe('readEnv', () => {
  it('returns the keys and the settings when they are set', () => {
    expect(readEnv(LAPTOP)).toEqual({
      openRouterApiKey: 'sk-test',
      tinfoilApiKey: 'tk-test',
      accessMode: 'full',
      clientAddressHeader: null,
      voucherPublicKeyFile: '../../secret/voucher-dev-public.pem',
      ticketKeyFile: '../../secret/ticket-key-dev.txt',
      databaseFile: '.data/ledger.db',
    });
  });

  it('reads the header of Cloudflare on the server', () => {
    const server = { ...LAPTOP, ACCESS_MODE: 'trial', CLIENT_ADDRESS_HEADER: 'CF-Connecting-IP' };
    expect(readEnv(server)).toMatchObject({
      accessMode: 'trial',
      clientAddressHeader: 'CF-Connecting-IP',
    });
  });

  it('fails loudly and names every missing variable', () => {
    expect(() => readEnv({})).toThrow(
      /OPENROUTER_API_KEY, TINFOIL_API_KEY, ACCESS_MODE, VOUCHER_PUBLIC_KEY_FILE, TICKET_KEY_FILE, DATABASE_FILE/,
    );
  });

  it('fails when the key of the private lane is missing', () => {
    expect(() => readEnv({ ...LAPTOP, TINFOIL_API_KEY: undefined })).toThrow(/TINFOIL_API_KEY/);
  });

  it('fails on an access mode it does not know', () => {
    expect(() => readEnv({ ...LAPTOP, ACCESS_MODE: 'open' })).toThrow(/ACCESS_MODE/);
  });

  it('fails when a variable is blank', () => {
    expect(() => readEnv({ ...LAPTOP, OPENROUTER_API_KEY: '   ' })).toThrow(/OPENROUTER_API_KEY/);
  });
});
