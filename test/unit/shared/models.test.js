import { describe, it, expect } from 'vitest';
import { MODELS, PROVIDERS, LEGACY_PROVIDER_OF_MODEL } from '../../../src/shared/models.js';

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
});
