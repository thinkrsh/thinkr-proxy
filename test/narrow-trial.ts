// The free trial as it stood until 22 Oct 2026, when it opened every model: four models, so that the
// tests of a trial that locks the other models for credit still have a model to lock.
import type * as TrialConfig from '../src/config/trial.js';

export const NARROW_TRIAL_IDS = [
  'private/gpt-oss-120b',
  'private/gemma-4-31b',
  'open/claude-haiku-5.5',
  'open/gpt-6-luna',
] as const;

/** The factory of vi.mock for config/trial.js: the trial of the config, with only these models. */
export async function narrowTrial(
  importOriginal: () => Promise<typeof TrialConfig>,
): Promise<typeof TrialConfig> {
  const { TRIAL } = await importOriginal();
  return { TRIAL: { ...TRIAL, modelIds: [...NARROW_TRIAL_IDS] } };
}
