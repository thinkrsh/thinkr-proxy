// The sources of sourced videos that the proxy holds (decision 216, 26 Oct 2026): each in memory at
// a random name, until its job ends or SOURCED.holdMs passes, and never on disk. A provider fetches
// a source at its link; the name goes to OpenRouter only, inside the request of the job.
import { MESSAGES } from '../config/messages.js';
import { SOURCED } from '../config/sourcedTools.js';
import { randomBytes, toBase64Url } from '../lib/bytes.js';
import { ProxyError } from '../lib/errors.js';
import type { Measured } from './measure.js';

/** One source as the proxy holds it: its bytes, their type, and what the proxy read from them. */
export interface HeldSource extends Measured {
  readonly bytes: Uint8Array;
  readonly type: string;
}

export interface SourceStore {
  /** Holds a source and returns its name, or throws when the proxy holds too much already. */
  hold: (source: HeldSource) => string;
  /** The source of a name while the proxy holds it. */
  get: (name: string) => HeldSource | undefined;
  /** Lets a source go at once: its job ended. */
  drop: (name: string) => void;
}

export interface SourceStoreDeps {
  readonly now: () => number;
  /** Runs a task after some time, so that a source goes even when nobody asks for it again. */
  readonly later: (ms: number, task: () => void) => void;
}

export function createSourceStore(deps: SourceStoreDeps): SourceStore {
  const held = new Map<string, { source: HeldSource; until: number }>();
  let heldBytes = 0;
  const drop = (name: string): void => {
    const entry = held.get(name);
    if (entry === undefined) return;
    held.delete(name);
    heldBytes -= entry.source.bytes.byteLength;
  };

  return {
    hold(source) {
      if (heldBytes + source.bytes.byteLength > SOURCED.maxHeldBytes) {
        throw new ProxyError('rate_limited', MESSAGES.sourcesFull);
      }
      const name = toBase64Url(randomBytes(SOURCED.nameBytes));
      held.set(name, { source, until: deps.now() + SOURCED.holdMs });
      heldBytes += source.bytes.byteLength;
      deps.later(SOURCED.holdMs, () => {
        drop(name);
      });
      return name;
    },
    get(name) {
      const entry = held.get(name);
      if (entry === undefined) return undefined;
      if (deps.now() >= entry.until) {
        drop(name);
        return undefined;
      }
      return entry.source;
    },
    drop,
  };
}

/** A timer that keeps no process alive on Node, where a timer has `unref`. */
export function laterByTimer(ms: number, task: () => void): void {
  const timer: unknown = setTimeout(task, ms);
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as { unref: () => void }).unref();
  }
}
