import { describe, expect, it } from 'vitest';

import { catalogProblems, findModel, findTeeModel, modelsResponse } from '../src/catalog.js';
import { CREDIT } from '../src/config/credit.js';
import { DEFAULT_MODEL_ID, MODEL_CATALOG, type CatalogModel } from '../src/config/models.js';

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

  it('forces every text model of the open lane to the no-retention level', () => {
    const text = MODEL_CATALOG.filter(({ info }) => info.lane === 'open' && info.kind === 'text');
    expect(text.length).toBeGreaterThan(0);
    expect(text.every((model) => model.info.privacy === 'open-no-retention')).toBe(true);
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

  it('keeps an image of ZDR on a chat completion, which forces zero data retention', () => {
    const image = findModel('open/nano-banana-2');
    if (image === undefined) throw new Error('The catalog lost a model.');
    const problems = catalogProblems(
      [
        {
          ...image,
          media: { kind: 'image', aspectRatio: '1:1', api: { name: 'images' }, costUsd: 1 },
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

  it('gives a price of decision 132 to the twelve models of thinkr.sh/pricing', () => {
    expect(MODEL_CATALOG.filter((model) => model.price !== null)).toHaveLength(12);
  });
});
