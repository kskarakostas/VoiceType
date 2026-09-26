import { describe, it, expect, vi } from 'vitest';
import { runDictation } from '../../../src/background/pipeline.js';
import { freshSettings } from '../../../src/shared/defaults.js';

function fakeAdapters({ sttText = 'raw words', refineText = 'refined words' } = {}) {
  const openai = {
    transcribe: vi.fn(async () => ({ text: sttText, usage: { kind: 'duration', seconds: 30 }, languages: ['en'] })),
    refine: vi.fn(async () => ({ text: refineText, usage: { inputTokens: 1000, outputTokens: 200 } })),
  };
  const gemini = {
    transcribe: vi.fn(async () => ({ text: sttText, usage: { kind: 'tokens', audioTokens: 960, textTokens: 0, outputTokens: 10 }, languages: [] })),
    refine: vi.fn(async () => ({ text: refineText, usage: { inputTokens: 500, outputTokens: 100 } })),
  };
  return { openai, gemini };
}

function settingsWith(overrides = {}) {
  const s = freshSettings();
  s.keys.openai = 'sk-test';
  s.keys.gemini = 'AQ.test';
  s.languages = ['el', 'en'];
  s.keywords = ['Palowise'];
  return Object.assign(s, overrides);
}

const base = { audioBase64: 'QUJD', mimeType: 'audio/webm', durationSec: 31 };

describe('runDictation', () => {
  it('default mode transcribes only and prices from reported duration', async () => {
    const adapters = fakeAdapters();
    const result = await runDictation({ ...base, modeKey: 'default', settings: settingsWith() }, adapters);
    expect(adapters.openai.transcribe).toHaveBeenCalledTimes(1);
    const args = adapters.openai.transcribe.mock.calls[0][0];
    expect(args).toMatchObject({ audioBase64: 'QUJD', mimeType: 'audio/webm', key: 'sk-test', languages: ['el', 'en'], keywords: ['Palowise'] });
    expect(args.signal).toBeInstanceOf(AbortSignal);
    expect(adapters.openai.refine).not.toHaveBeenCalled();
    expect(result).toMatchObject({ raw: 'raw words', text: 'raw words', provider: 'openai', sttModel: 'gpt-transcribe', textModel: null, audioSeconds: 30 });
    expect(result.cost).toBeCloseTo(0.00225, 6);
  });

  it('email mode refines with the mode prompt and sums both costs', async () => {
    const adapters = fakeAdapters();
    const settings = settingsWith();
    const result = await runDictation({ ...base, modeKey: 'email', settings }, adapters);
    expect(adapters.openai.refine).toHaveBeenCalledWith(expect.objectContaining({ key: 'sk-test', instructions: settings.modes.email.prompt, text: 'raw words' }));
    expect(result.text).toBe('refined words');
    expect(result.raw).toBe('raw words');
    expect(result.textModel).toBe('gpt-6-luna');
    expect(result.cost).toBeCloseTo(0.00225 + 0.0001 + 0.0001, 6);
  });

  it('translate with empty target falls back to English', async () => {
    const adapters = fakeAdapters();
    await runDictation({ ...base, modeKey: 'translate', settings: settingsWith({ translateTargetLang: '' }) }, adapters);
    const { instructions } = adapters.openai.refine.mock.calls[0][0];
    expect(instructions).toContain('Translate it into English.');
    expect(instructions).not.toContain('{{');
  });

  it('uses the Gemini adapter and token pricing when the provider is gemini', async () => {
    const adapters = fakeAdapters();
    const result = await runDictation({ ...base, modeKey: 'default', settings: settingsWith({ provider: 'gemini' }) }, adapters);
    expect(adapters.gemini.transcribe).toHaveBeenCalledTimes(1);
    expect(adapters.openai.transcribe).not.toHaveBeenCalled();
    expect(result.provider).toBe('gemini');
    expect(result.audioSeconds).toBe(31);
    expect(result.cost).toBeCloseTo((960 / 1e6) * 2 + (10 / 1e6) * 12, 9);
  });

  it('empty transcript throws and skips refine', async () => {
    const adapters = fakeAdapters({ sttText: '   ' });
    await expect(runDictation({ ...base, modeKey: 'email', settings: settingsWith() }, adapters)).rejects.toMatchObject({ name: 'ProviderError', code: 'empty' });
    expect(adapters.openai.refine).not.toHaveBeenCalled();
  });

  it('missing key throws before any network call', async () => {
    const adapters = fakeAdapters();
    const settings = settingsWith(); settings.keys.openai = '';
    await expect(runDictation({ ...base, modeKey: 'default', settings }, adapters)).rejects.toMatchObject({ code: 'no_key' });
    expect(adapters.openai.transcribe).not.toHaveBeenCalled();
  });

  it('unknown mode behaves like default', async () => {
    const adapters = fakeAdapters();
    const result = await runDictation({ ...base, modeKey: 'ghost', settings: settingsWith() }, adapters);
    expect(adapters.openai.refine).not.toHaveBeenCalled();
    expect(result.text).toBe('raw words');
  });

  it('falls back to the raw transcript when refine returns nothing', async () => {
    const adapters = fakeAdapters({ refineText: '' });
    const result = await runDictation({ ...base, modeKey: 'instruct', settings: settingsWith() }, adapters);
    expect(result.text).toBe('raw words');
  });
});
