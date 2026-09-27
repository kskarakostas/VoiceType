import { describe, it, expect } from 'vitest';
import { MODELS, PROVIDERS, LEGACY_PROVIDER_OF_MODEL, deepFreeze } from '../../../src/shared/models.js';

describe('model registry', () => {
  it('every provider points at registered models of the right kind', () => {
    for (const [provider, cfg] of Object.entries(PROVIDERS)) {
      expect(MODELS[cfg.stt], `${provider}.stt`).toBeDefined();
      expect(MODELS[cfg.stt].kind).toBe('stt');
      expect(MODELS[cfg.stt].provider).toBe(provider);
      expect(MODELS[cfg.text], `${provider}.text`).toBeDefined();
      expect(MODELS[cfg.text].kind).toBe('text');
      expect(MODELS[cfg.text].provider).toBe(provider);
    }
  });

  it('uses the current model ids', () => {
    expect(PROVIDERS.openai.stt).toBe('gpt-transcribe');
    expect(PROVIDERS.openai.text).toBe('gpt-6-luna');
    expect(PROVIDERS.gemini.stt).toBe('gemini-3.5-transcribe');
    expect(PROVIDERS.gemini.text).toBe('gemini-3.8-flash');
  });

  it('maps every v1 model id to a provider', () => {
    expect(LEGACY_PROVIDER_OF_MODEL['gpt-4o-transcribe']).toBe('openai');
    expect(LEGACY_PROVIDER_OF_MODEL['gpt-4o-mini-transcribe']).toBe('openai');
    expect(LEGACY_PROVIDER_OF_MODEL['gemini-2.5-flash']).toBe('gemini');
    expect(LEGACY_PROVIDER_OF_MODEL['gemini-3-flash-preview']).toBe('gemini');
  });

  it('keeps legacy ids out of the priced registry', () => {
    for (const id of Object.keys(LEGACY_PROVIDER_OF_MODEL)) expect(Object.hasOwn(MODELS, id), id).toBe(false);
  });

  it('deep-freezes every registry', () => {
    expect(Object.isFrozen(MODELS)).toBe(true);
    expect(Object.isFrozen(MODELS['gpt-transcribe'])).toBe(true);
    expect(Object.isFrozen(MODELS['gpt-transcribe'].pricing)).toBe(true);
    expect(Object.isFrozen(PROVIDERS.openai)).toBe(true);
    expect(Object.isFrozen(LEGACY_PROVIDER_OF_MODEL)).toBe(true);
    expect(() => { MODELS['gemini-3.8-flash'].pricing.outputPerM = 0; }).toThrow(TypeError);
  });
});

describe('deepFreeze', () => {
  it('freezes nested objects and arrays and returns its argument', () => {
    const value = { a: { b: [1, { c: 2 }] } };
    expect(deepFreeze(value)).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.a)).toBe(true);
    expect(Object.isFrozen(value.a.b)).toBe(true);
    expect(Object.isFrozen(value.a.b[1])).toBe(true);
  });

  it('passes primitives and null through', () => {
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(3)).toBe(3);
    expect(deepFreeze('x')).toBe('x');
  });
});
