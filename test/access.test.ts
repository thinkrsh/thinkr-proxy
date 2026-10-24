import { describe, expect, it } from 'vitest';

import { createAccess } from '../src/access/access.js';
import { MESSAGES } from '../src/config/messages.js';
import { MODEL_CATALOG } from '../src/config/models.js';
import { TRIAL } from '../src/config/trial.js';
import { ProxyError } from '../src/lib/errors.js';

const NOON = Date.parse('2026-10-20T12:00:00Z');
const NEXT_DAY = Date.parse('2026-10-21T00:00:01Z');

function trial() {
  const logs: string[] = [];
  const access = createAccess('trial', (line) => {
    logs.push(line);
  });
  return { access, logs };
}

function admitError(run: () => void): ProxyError {
  try {
    run();
  } catch (error) {
    if (error instanceof ProxyError) return error;
    throw error;
  }
  throw new Error('The chat was admitted.');
}

describe('createAccess, full', () => {
  it('opens every model and limits nothing', () => {
    const access = createAccess('full', () => undefined);
    expect(access.opens('open/claude-opus-5.5')).toBe(true);
    for (let index = 0; index < 100; index += 1) access.admit('a', 'open', NOON);
    expect(access.status('a', NOON)).toEqual({ mode: 'full' });
  });
});

describe('createAccess, trial', () => {
  it('opens every model that the proxy serves but video, and nothing else', () => {
    const { access } = trial();
    for (const { info } of MODEL_CATALOG) {
      expect(access.opens(info.id)).toBe(info.available && info.kind !== 'video');
    }
    expect(access.opens('open/not-in-the-catalog')).toBe(false);
  });

  it('admits the chats of a day for each visitor and lane, then refuses', () => {
    const { access } = trial();
    for (let index = 0; index < TRIAL.chatsPerDay.private; index += 1) {
      access.admit('a', 'private', NOON);
    }
    const error = admitError(() => {
      access.admit('a', 'private', NOON);
    });
    expect(error.code).toBe('quota_exceeded');
    expect(error.message).toBe(MESSAGES.quotaExceeded);
    expect(() => {
      access.admit('b', 'private', NOON);
    }).not.toThrow();
    expect(() => {
      access.admit('a', 'open', NOON);
    }).not.toThrow();
  });

  it('gives a chat back when the provider failed before the answer', () => {
    const { access } = trial();
    access.admit('a', 'open', NOON);
    access.refund('a', 'open', NOON);
    expect(access.status('a', NOON)).toMatchObject({
      lanes: { open: { chatsLeft: TRIAL.chatsPerDay.open } },
    });
  });

  it('pauses a lane once it spent its budget, and says so once in the log', () => {
    const { access, logs } = trial();
    access.spend('open', TRIAL.dailyBudgetUsd.open / 2, NOON);
    access.admit('a', 'open', NOON);
    access.spend('open', TRIAL.dailyBudgetUsd.open / 2, NOON);
    access.spend('open', 1, NOON);
    expect(
      admitError(() => {
        access.admit('b', 'open', NOON);
      }).code,
    ).toBe('trial_paused');
    expect(() => {
      access.admit('b', 'private', NOON);
    }).not.toThrow();
    expect(logs).toEqual(['Trial paused: the open lane spent its budget for 2026-10-20.']);
  });

  it('starts every count again at 00:00 UTC', () => {
    const { access } = trial();
    for (let index = 0; index < TRIAL.chatsPerDay.open; index += 1) access.admit('a', 'open', NOON);
    access.spend('private', TRIAL.dailyBudgetUsd.private, NOON);
    expect(access.status('a', NEXT_DAY)).toEqual({
      mode: 'trial',
      lanes: {
        private: {
          chatsPerDay: TRIAL.chatsPerDay.private,
          chatsLeft: TRIAL.chatsPerDay.private,
          paused: false,
        },
        open: {
          chatsPerDay: TRIAL.chatsPerDay.open,
          chatsLeft: TRIAL.chatsPerDay.open,
          paused: false,
        },
      },
    });
  });

  it('reports the chats left and a paused lane', () => {
    const { access } = trial();
    access.admit('a', 'private', NOON);
    access.spend('open', TRIAL.dailyBudgetUsd.open, NOON);
    expect(access.status('a', NOON)).toEqual({
      mode: 'trial',
      lanes: {
        private: {
          chatsPerDay: TRIAL.chatsPerDay.private,
          chatsLeft: TRIAL.chatsPerDay.private - 1,
          paused: false,
        },
        open: {
          chatsPerDay: TRIAL.chatsPerDay.open,
          chatsLeft: TRIAL.chatsPerDay.open,
          paused: true,
        },
      },
    });
  });
});
