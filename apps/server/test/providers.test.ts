import { describe, expect, it } from 'vitest';
import { findModel } from '../src/models';
import { createModelFactory } from '../src/providers';

describe('createModelFactory', () => {
  it('builds a Mistral client for a Mistral model', () => {
    const model = createModelFactory({ mistral: 'k' })(findModel('mistral-large-4')!);
    expect(typeof model === 'object' && { provider: model.provider, modelId: model.modelId }).toEqual({ provider: 'mistral.chat', modelId: 'mistral-large-4' });
  });
  it('throws without the provider key', () => {
    expect(() => createModelFactory({ openrouter: 'k' })(findModel('mistral-large-4')!)).toThrow(/no API key for provider mistral/);
  });
});
