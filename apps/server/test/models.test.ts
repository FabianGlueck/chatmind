import { OUTPUT_RESERVE } from '@chatmind/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, MODELS, findModel, modelDtos } from '../src/models';

describe('models', () => {
  it('has the two Anthropic models, a default, and four providers', () => {
    expect(findModel('claude-opus-5')?.provider).toBe('anthropic');
    expect(findModel('claude-sonnet-5')?.provider).toBe('anthropic');
    expect(DEFAULT_MODEL).toBe('claude-opus-5');
    expect(new Set(MODELS.map((m) => m.provider))).toEqual(new Set(['anthropic', 'openai', 'openrouter', 'mistral']));
    expect(new Set(MODELS.map((m) => m.id)).size).toBe(MODELS.length);
  });
  it('marks availability per provider key', () => {
    const dtos = modelDtos({ openrouter: 'k' });
    expect(dtos.filter((d) => d.available).every((d) => d.provider === 'openrouter')).toBe(true);
    expect(dtos.some((d) => d.provider === 'anthropic' && !d.available)).toBe(true);
    expect(modelDtos({}).every((d) => !d.available)).toBe(true);
  });
  it('offers Mistral models directly, available with a Mistral key only', () => {
    expect(findModel('mistral-large-4')?.provider).toBe('mistral');
    const dtos = modelDtos({ mistral: 'k' });
    expect(dtos.filter((d) => d.available).map((d) => d.id)).toEqual(['mistral-large-4', 'mistral-medium-3-5', 'mistral-small-2603']);
  });
});

describe('models — context windows', () => {
  it('every model has a positive contextTokens that GET /api/models exposes', () => {
    for (const m of MODELS) expect(m.contextTokens).toBeGreaterThan(OUTPUT_RESERVE);
    for (const d of modelDtos({})) expect(typeof d.contextTokens).toBe('number');
  });
});
