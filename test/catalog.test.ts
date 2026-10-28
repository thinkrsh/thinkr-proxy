import { describe, expect, it } from 'vitest';

import {
  catalogProblems,
  findModel,
  findTeeModel,
  isDearest,
  modelsResponse,
  thinkingProblems,
  trialModelIds,
} from '../src/catalog.js';
import { CREDIT } from '../src/config/credit.js';
import { DEFAULT_MODEL_ID, MODEL_CATALOG, type CatalogModel } from '../src/config/models.js';
import { ALWAYS_THINKING, NO_DEFAULT_THINKING, NO_LESS_THINKING } from '../src/config/thinking.js';
import { TRIAL } from '../src/config/trial.js';

function catalogModel(id: string): CatalogModel {
  const model = findModel(id);
  if (model === undefined) throw new Error(`The catalog lost ${id}.`);
  return model;
}

function openModel(id: string): CatalogModel {
  const model = findModel('open/glm-5.3-flash');
  if (model === undefined) throw new Error('The catalog lost GLM 5.3 Flash.');
  return { ...model, info: { ...model.info, id } };
}

function privateModel(id: string, teeModelId: string): CatalogModel {
  const model = findModel('private/gpt-oss-120b');
  if (model === undefined) throw new Error('The catalog lost GPT-OSS 120B.');
  return { ...model, info: { ...model.info, id, teeModelId } };
}

describe('the model catalog', () => {
  it('is valid', () => {
    expect(catalogProblems(MODEL_CATALOG, DEFAULT_MODEL_ID)).toEqual([]);
  });

  it('puts each text model of the open lane at the no-retention level, or at Open without ZDR', () => {
    const text = MODEL_CATALOG.filter(({ info }) => info.lane === 'open' && info.kind === 'text');
    expect(text.some(({ info }) => info.privacy === 'open-no-retention')).toBe(true);
    expect(text.some(({ info }) => info.privacy === 'open')).toBe(true);
    for (const { info } of text) expect(['open-no-retention', 'open']).toContain(info.privacy);
  });

  it('puts every video model at the level Open, with no zero data retention', () => {
    const video = MODEL_CATALOG.filter(({ info }) => info.kind === 'video');
    expect(video.length).toBeGreaterThan(0);
    for (const { info, media } of video) {
      expect(info.privacy).toBe('open');
      expect(media?.kind).toBe('video');
    }
  });

  it('has image models at both levels of the open lane', () => {
    const images = MODEL_CATALOG.filter(({ info }) => info.kind === 'image');
    expect(images.some(({ info }) => info.privacy === 'open-no-retention')).toBe(true);
    expect(images.some(({ info }) => info.privacy === 'open')).toBe(true);
  });

  it('serves the private lane through a TEE, never through OpenRouter', () => {
    const lane = MODEL_CATALOG.filter((model) => model.info.lane === 'private');
    expect(lane.length).toBeGreaterThan(0);
    for (const model of lane) {
      expect(model.info.available).toBe(true);
      expect(model.info.teeModelId).not.toBeNull();
      expect(model.openRouterSlug).toBeNull();
    }
  });

  it('defaults to GPT-OSS 120B in the private lane (decision 64)', () => {
    expect(findModel(DEFAULT_MODEL_ID)?.info.teeModelId).toBe('gpt-oss-120b');
  });
});

describe('the dearest models of the trial', () => {
  it('keeps a chat model and an image model under the limits open', () => {
    expect(isDearest(catalogModel('open/claude-opus-5.5'))).toBe(false);
    expect(isDearest(catalogModel('open/nano-banana-pro'))).toBe(false);
  });

  it('takes credit for a chat model and an image model past the limits', () => {
    expect(isDearest(catalogModel('open/gpt-5.5-pro'))).toBe(true);
    expect(isDearest(catalogModel('open/gpt-image-1'))).toBe(true);
  });

  it('prices one chat of the fallback usage at the user price, up to the limit included', () => {
    const atLimit = (TRIAL.dearest.chatUsd * 1_000_000) / TRIAL.fallbackUsage.outputTokens;
    const model = catalogModel('open/claude-opus-5.5');
    const priced = (output: number): CatalogModel => ({
      ...model,
      price: { inputUsdPerMTok: 0, outputUsdPerMTok: output },
    });
    expect(isDearest(priced(atLimit))).toBe(false);
    expect(isDearest(priced(atLimit + 0.01))).toBe(true);
  });

  it('leaves the dearest models out of the trial, and video too', () => {
    const ids = trialModelIds();
    expect(ids).toContain('open/claude-opus-5.5');
    expect(ids).not.toContain('open/gpt-5.5-pro');
    for (const id of ids) {
      const model = catalogModel(id);
      expect(isDearest(model)).toBe(false);
      expect(model.info.kind).not.toBe('video');
    }
  });
});

describe('the thinking of the models (28 Oct 2026)', () => {
  it('names only models of text of the catalog that can think', () => {
    const lists = {
      always: ALWAYS_THINKING,
      noDefault: NO_DEFAULT_THINKING,
      noLess: NO_LESS_THINKING,
    };
    expect(thinkingProblems(MODEL_CATALOG, lists)).toEqual([]);
  });

  it('finds a model outside the catalog, one that cannot think, and a lane or a class too many', () => {
    const plain = MODEL_CATALOG.find(({ info }) => info.kind === 'text' && !info.reasoning);
    if (plain === undefined) throw new Error('The catalog has no model of text that cannot think.');
    const always = new Set(['open/nothing', plain.info.id, 'open/claude-haiku-4.5']);
    const noDefault = new Set(['open/claude-haiku-4.5', 'private/deepseek-v4.1-flash']);
    const noLess = new Set(['open/deepseek-v4.1-flash']);
    expect(thinkingProblems(MODEL_CATALOG, { always, noDefault, noLess })).toEqual([
      'open/deepseek-v4.1-flash: only a model that always thinks lacks a lesser effort',
      'open/nothing: named for thinking but not in the catalog',
      `${plain.info.id}: named for thinking but cannot think`,
      'open/claude-haiku-4.5: cannot both always think and have no default',
      'private/deepseek-v4.1-flash: the private lane is never asked to think through OpenRouter',
    ]);
  });

  it('tells the app which models always think, in both lanes', () => {
    const listed = new Map(modelsResponse({ opens: () => true }).models.map((m) => [m.id, m]));
    expect(listed.get('open/glm-5.3-flash')?.alwaysThinks).toBe(true);
    expect(listed.get('private/gpt-oss-120b')?.alwaysThinks).toBe(true);
    expect(listed.get('open/deepseek-v4.1-flash')?.alwaysThinks).toBe(false);
    expect(listed.get('private/deepseek-v4.1-flash')?.alwaysThinks).toBe(false);
  });

  it('tells the app which models always think in full, so Think stays on (29 Oct 2026)', () => {
    const listed = new Map(modelsResponse({ opens: () => true }).models.map((m) => [m.id, m]));
    const inFull = [...listed.values()].filter((model) => model.thinksInFull).map(({ id }) => id);
    expect(inFull.sort()).toEqual(['open/gpt-5.4-pro', 'open/gpt-5.5-pro', 'private/kimi-k3']);
    expect(listed.get('open/glm-5.3-flash')?.thinksInFull).toBe(false);
  });
});

describe('findTeeModel', () => {
  it('finds a model of the private lane by the id inside the TEE', () => {
    expect(findTeeModel('kimi-k3')?.info.id).toBe('private/kimi-k3');
  });

  it('finds nothing for an id of the catalog or an unknown model', () => {
    expect(findTeeModel('private/kimi-k3')).toBeUndefined();
    expect(findTeeModel('qwen3-vl')).toBeUndefined();
  });
});

describe('catalogProblems', () => {
  it('finds duplicate ids and a missing default', () => {
    const problems = catalogProblems([openModel('open/a'), openModel('open/a')], 'open/b');
    expect(problems).toEqual([
      'duplicate ids: open/a',
      'the default model open/b is not in the catalog',
    ]);
  });

  it('finds an id outside its lane and an available model without an upstream', () => {
    const broken = openModel('private/x');
    const problems = catalogProblems([{ ...broken, openRouterSlug: null }], 'private/x');
    expect(problems).toContain('private/x: the id must start with its lane');
    expect(problems).toContain('private/x: available but no upstream');
  });

  it('keeps each lane on its own upstream', () => {
    const sealed = privateModel('private/a', 'a');
    const problems = catalogProblems(
      [
        { ...sealed, openRouterSlug: 'vendor/a' },
        { ...openModel('open/b'), info: { ...openModel('open/b').info, teeModelId: 'b' } },
      ],
      'private/a',
    );
    expect(problems).toContain('private/a: the private lane never goes through OpenRouter');
    expect(problems).toContain('open/b: the open lane has no TEE model');
  });

  it('keeps the media of a model to its kind, and video at the level Open', () => {
    const video = findModel('open/wan-3.0');
    const image = findModel('open/nano-banana-2');
    if (video === undefined || image?.media === undefined) {
      throw new Error('The catalog lost a model.');
    }
    const problems = catalogProblems(
      [
        { ...video, info: { ...video.info, privacy: 'open-no-retention' } },
        { ...image, info: { ...image.info, kind: 'video' } },
        { ...openModel('open/text'), media: image.media },
      ],
      'open/text',
    );
    expect(problems).toContain(
      'open/wan-3.0: video has no zero data retention, so its level is Open',
    );
    expect(problems).toContain('open/nano-banana-2: its media settings must be video');
    expect(problems).toContain('open/text: a text model has no media settings');
  });

  it('keeps the default shape and length among the options, the lengths shortest first', () => {
    const video = catalogModel('open/wan-3.0');
    if (video.media?.kind !== 'video') throw new Error('Wan 3.0 lost its video settings.');
    const media = { ...video.media, aspectRatios: ['1:1'], durations: [10, 5] };
    expect(catalogProblems([{ ...video, media }], 'open/wan-3.0')).toEqual([
      'open/wan-3.0: its shapes must hold its default shape',
      'open/wan-3.0: its lengths must hold its default length',
      'open/wan-3.0: its lengths must run from the shortest up',
    ]);
  });

  it('keeps an image of ZDR on a chat completion, which forces zero data retention', () => {
    const image = findModel('open/nano-banana-2');
    if (image === undefined) throw new Error('The catalog lost a model.');
    const problems = catalogProblems(
      [
        {
          ...image,
          media: {
            kind: 'image',
            aspectRatio: '1:1',
            aspectRatios: ['1:1'],
            api: { name: 'images' },
            costUsd: 1,
          },
        },
      ],
      'open/nano-banana-2',
    );
    expect(problems).toContain(
      'open/nano-banana-2: only a chat completion forces zero data retention on an image',
    );
  });

  it('finds duplicate TEE ids and a private model without one', () => {
    const problems = catalogProblems(
      [
        privateModel('private/a', 'same'),
        privateModel('private/b', 'same'),
        {
          ...privateModel('private/c', 'c'),
          info: { ...privateModel('private/c', 'c').info, teeModelId: null },
        },
      ],
      'private/a',
    );
    expect(problems).toContain('duplicate TEE model ids: same');
    expect(problems).toContain('private/c: available but no upstream');
  });
});

describe('the price that the app shows', () => {
  const listed = modelsResponse({ opens: () => true }).models;

  function shown(id: string) {
    return listed.find((model) => model.id === id)?.pricing;
  }

  it('is the price of decision 132 for a model that has one', () => {
    expect(shown('private/kimi-k3')).toEqual(findModel('private/kimi-k3')?.price);
    expect(shown('open/claude-opus-5.5')).toEqual(findModel('open/claude-opus-5.5')?.price);
  });

  it('is the cost plus 25% for any other model, never the bare cost', () => {
    const cost = findModel('open/glm-5.3-flash')?.cost;
    expect(shown('open/glm-5.3-flash')).toEqual({
      inputUsdPerMTok: (cost?.inputUsdPerMTok ?? 0) * CREDIT.markup,
      outputUsdPerMTok: (cost?.outputUsdPerMTok ?? 0) * CREDIT.markup,
    });
  });

  it('gives a price of decision 134 to the twelve models of thinkr.sh/pricing', () => {
    const page = [
      'private/gpt-oss-120b',
      'private/deepseek-v4.1-flash',
      'private/kimi-k3',
      'private/glm-5.3',
      'private/gemma-4-31b',
      'private/llama-3.3-70b',
      'open/claude-opus-5.5',
      'open/claude-haiku-5.5',
      'open/gpt-6.1-sol',
      'open/gpt-6-luna',
      'open/gemini-3.8-flash',
      'open/grok-4.7',
    ];
    for (const id of page) expect(catalogModel(id).price, id).not.toBeNull();
  });

  it('never prices a model above its cost plus 25% (decision 52), input and output apart', () => {
    for (const { cost, price, info } of MODEL_CATALOG) {
      if (price === null || cost === null) continue;
      const most = (value: number): number => value * CREDIT.markup + Number.EPSILON;
      expect(price.inputUsdPerMTok, info.id).toBeLessThanOrEqual(most(cost.inputUsdPerMTok));
      expect(price.outputUsdPerMTok, info.id).toBeLessThanOrEqual(most(cost.outputUsdPerMTok));
    }
  });
});
