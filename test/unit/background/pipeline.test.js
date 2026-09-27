import { describe, it, expect, vi } from 'vitest';
import { runDictation } from '../../../src/background/pipeline.js';
import { freshSettings } from '../../../src/shared/defaults.js';
import { ProviderError } from '../../../src/background/providers/errors.js';

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
    expect(result).toMatchObject({ raw: 'raw words', text: 'raw words', provider: 'openai', sttModel: 'gpt-transcribe', textModel: null, audioSeconds: 30, warning: null });
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
    expect(result.warning).toBeNull();
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
    expect(result.warning).toBe('Mode returned nothing. Raw transcript inserted.');
    expect(result.textModel).toBeNull();
    // The empty refine call was still billed.
    expect(result.cost).toBeCloseTo(0.00225 + 0.0001 + 0.0001, 6);
  });

  it('gemini email mode uses the gemini key on both calls and the same signal', async () => {
    const adapters = fakeAdapters();
    const result = await runDictation({ ...base, modeKey: 'email', settings: settingsWith({ provider: 'gemini' }) }, adapters);
    const t = adapters.gemini.transcribe.mock.calls[0][0];
    const r = adapters.gemini.refine.mock.calls[0][0];
    expect(t.key).toBe('AQ.test');
    expect(r.key).toBe('AQ.test');
    expect(r.signal).toBe(t.signal);
    expect(adapters.openai.transcribe).not.toHaveBeenCalled();
    expect(adapters.openai.refine).not.toHaveBeenCalled();
    expect(result.textModel).toBe('gemini-3.8-flash');
    expect(result.warning).toBeNull();
    expect(result.cost).toBeCloseTo((960 / 1e6) * 2 + (10 / 1e6) * 12 + (500 / 1e6) * 0.75 + (100 / 1e6) * 3.75, 9);
  });

  it('fills the configured target language', async () => {
    const adapters = fakeAdapters();
    await runDictation({ ...base, modeKey: 'translate', settings: settingsWith({ translateTargetLang: 'Greek' }) }, adapters);
    expect(adapters.openai.refine.mock.calls[0][0].instructions).toContain('Translate it into Greek.');
  });

  it('falls back to the raw transcript with a warning when refine fails', async () => {
    const adapters = fakeAdapters();
    adapters.openai.refine.mockRejectedValueOnce(new ProviderError('OpenAI rate limit or quota reached.', { status: 429, code: 'rate_limit' }));
    const result = await runDictation({ ...base, modeKey: 'email', settings: settingsWith() }, adapters);
    expect(result.text).toBe('raw words');
    expect(result.textModel).toBeNull();
    expect(result.warning).toBe('Mode not applied: OpenAI rate limit or quota reached. Raw transcript inserted.');
    expect(result.cost).toBeCloseTo(0.00225, 6);
  });

  it('adds a period to a refine failure reason that lacks one', async () => {
    const adapters = fakeAdapters();
    adapters.openai.refine.mockRejectedValueOnce(new ProviderError('OpenAI rejected the request: Unsupported model', { status: 400, code: 'bad_request' }));
    const result = await runDictation({ ...base, modeKey: 'email', settings: settingsWith() }, adapters);
    expect(result.warning).toBe('Mode not applied: OpenAI rejected the request: Unsupported model. Raw transcript inserted.');
  });

  it('words a refine timeout in the warning', async () => {
    const adapters = fakeAdapters();
    adapters.openai.refine.mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'));
    const result = await runDictation({ ...base, modeKey: 'email', settings: settingsWith() }, adapters);
    expect(result.warning).toBe('Mode not applied: Request timed out. Raw transcript inserted.');
  });

  it('ignores inherited property names as providers', async () => {
    const adapters = fakeAdapters();
    const settings = settingsWith({ provider: 'toString' });
    await runDictation({ ...base, modeKey: 'default', settings }, adapters);
    expect(adapters.openai.transcribe).toHaveBeenCalledTimes(1);
  });

  it('aborts the provider call after timeoutMs', async () => {
    const adapters = fakeAdapters();
    adapters.openai.transcribe.mockImplementationOnce(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    }));
    await expect(runDictation({ ...base, modeKey: 'default', settings: settingsWith() }, adapters, 5)).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('treats a non-string mode prompt as STT only', async () => {
    const adapters = fakeAdapters();
    const settings = settingsWith();
    settings.modes.odd = { name: 'Odd', icon: 'x', prompt: 42, builtIn: false };
    const result = await runDictation({ ...base, modeKey: 'odd', settings }, adapters);
    expect(adapters.openai.refine).not.toHaveBeenCalled();
    expect(result.text).toBe('raw words');
    expect(result.warning).toBeNull();
  });

  it('treats a whitespace-only key as missing', async () => {
    const adapters = fakeAdapters();
    const settings = settingsWith(); settings.keys.openai = '   ';
    await expect(runDictation({ ...base, modeKey: 'default', settings }, adapters)).rejects.toMatchObject({ code: 'no_key' });
    expect(adapters.openai.transcribe).not.toHaveBeenCalled();
  });

  it('sends the trimmed key on both calls', async () => {
    const adapters = fakeAdapters();
    const settings = settingsWith(); settings.keys.openai = '  sk-test \n';
    await runDictation({ ...base, modeKey: 'email', settings }, adapters);
    expect(adapters.openai.transcribe.mock.calls[0][0].key).toBe('sk-test');
    expect(adapters.openai.refine.mock.calls[0][0].key).toBe('sk-test');
  });

  it('trims the target language before falling back to English', async () => {
    const adapters = fakeAdapters();
    await runDictation({ ...base, modeKey: 'translate', settings: settingsWith({ translateTargetLang: '   ' }) }, adapters);
    expect(adapters.openai.refine.mock.calls[0][0].instructions).toContain('Translate it into English.');
    await runDictation({ ...base, modeKey: 'translate', settings: settingsWith({ translateTargetLang: ' Greek ' }) }, adapters);
    expect(adapters.openai.refine.mock.calls[1][0].instructions).toContain('Translate it into Greek.');
  });

  it('words a blank refine failure as Text model failed.', async () => {
    const adapters = fakeAdapters();
    adapters.openai.refine.mockRejectedValueOnce(new ProviderError('   '));
    const result = await runDictation({ ...base, modeKey: 'email', settings: settingsWith() }, adapters);
    expect(result.text).toBe('raw words');
    expect(result.warning).toBe('Mode not applied: Text model failed. Raw transcript inserted.');
  });
});
