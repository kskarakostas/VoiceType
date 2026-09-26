import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRouter, userMessage } from '../../../src/background/router.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings } from '../../../src/shared/defaults.js';
import { emptyLog } from '../../../src/background/usage.js';
import { ProviderError } from '../../../src/background/providers/errors.js';

let deps, handle, saved, usageLog;
beforeEach(() => {
  saved = null; usageLog = emptyLog();
  const settings = freshSettings(); settings.keys.openai = 'sk-test';
  deps = {
    storage: {
      getSettings: vi.fn(async () => settings),
      saveSettings: vi.fn(async (s) => { saved = s; }),
      getUsageLog: vi.fn(async () => usageLog),
      setUsageLog: vi.fn(async (l) => { usageLog = l; }),
    },
    runDictation: vi.fn(async () => ({ raw: 'raw', text: 'final', provider: 'openai', sttModel: 'gpt-transcribe', textModel: null, audioSeconds: 12, cost: 0.0009, warning: null })),
    validateKey: vi.fn(async () => true),
    applyUsage: vi.fn((log, entry) => ({ ...log, lastEntry: entry })),
    summarize: vi.fn(() => ({ today: {}, last7Days: {}, total: {} })),
    toggleActiveTab: vi.fn(async () => true),
  };
  handle = createRouter(deps);
});

describe('router', () => {
  it('returns settings for getSettings', async () => {
    const s = await handle({ action: MSG.GET_SETTINGS });
    expect(s.keys.openai).toBe('sk-test');
  });

  it('saves settings', async () => {
    const s = freshSettings(); s.provider = 'gemini';
    expect(await handle({ action: MSG.SAVE_SETTINGS, settings: s })).toEqual({ success: true });
    expect(saved.provider).toBe('gemini');
  });

  it('keeps the stored keys when the payload has no keys object', async () => {
    const payload = { ...freshSettings(), provider: 'gemini' };
    delete payload.keys;
    expect(await handle({ action: MSG.SAVE_SETTINGS, settings: payload })).toEqual({ success: true });
    expect(saved.provider).toBe('gemini');
    expect(saved.keys.openai).toBe('sk-test');
  });

  it('stores explicit blank keys so the popup can clear them', async () => {
    const payload = { ...freshSettings(), keys: { openai: '', gemini: '' } };
    expect(await handle({ action: MSG.SAVE_SETTINGS, settings: payload })).toEqual({ success: true });
    expect(saved.keys).toEqual({ openai: '', gemini: '' });
  });

  it('rejects a missing or non-object settings payload without touching storage', async () => {
    expect(await handle({ action: MSG.SAVE_SETTINGS })).toEqual({ success: false, error: 'Invalid settings.' });
    expect(await handle({ action: MSG.SAVE_SETTINGS, settings: [] })).toEqual({ success: false, error: 'Invalid settings.' });
    expect(deps.storage.saveSettings).not.toHaveBeenCalled();
  });

  it('reports whether the active provider has a key', async () => {
    expect(await handle({ action: MSG.CHECK_KEY })).toEqual({ hasKey: true });
  });

  it('validates a key and maps failures to friendly text', async () => {
    expect(await handle({ action: MSG.VALIDATE_KEY, provider: 'openai', key: 'sk-x' })).toEqual({ ok: true });
    expect(deps.validateKey).toHaveBeenCalledWith('openai', 'sk-x');
    deps.validateKey.mockRejectedValueOnce(new ProviderError('OpenAI rejected the API key.', { code: 'auth' }));
    expect(await handle({ action: MSG.VALIDATE_KEY, provider: 'openai', key: 'sk-bad' })).toEqual({ ok: false, error: 'OpenAI rejected the API key.' });
  });

  it('transcribes, logs usage and returns text, raw and cost', async () => {
    const res = await handle({ action: MSG.TRANSCRIBE, audioBase64: 'QUJD', mimeType: 'audio/webm', mode: 'email', audioDuration: 12.4 });
    expect(deps.runDictation).toHaveBeenCalledWith(expect.objectContaining({ audioBase64: 'QUJD', mimeType: 'audio/webm', modeKey: 'email', durationSec: 12.4 }));
    expect(deps.applyUsage).toHaveBeenCalledWith(expect.anything(), { provider: 'openai', audioSeconds: 12, cost: 0.0009, mode: 'email' });
    expect(deps.storage.setUsageLog).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ success: true, text: 'final', raw: 'raw', cost: 0.0009, warning: null });
  });

  it('passes the mode warning through when the raw transcript was used', async () => {
    deps.runDictation.mockResolvedValueOnce({ raw: 'raw', text: 'raw', provider: 'openai', sttModel: 'gpt-transcribe', textModel: null, audioSeconds: 12, cost: 0.0009, warning: 'Mode not applied: x. Raw transcript inserted.' });
    const res = await handle({ action: MSG.TRANSCRIBE, audioBase64: 'QUJD', mimeType: 'audio/webm', mode: 'email', audioDuration: 12 });
    expect(res.warning).toBe('Mode not applied: x. Raw transcript inserted.');
  });

  it('keeps a successful dictation when usage logging fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.storage.setUsageLog.mockRejectedValueOnce(new Error('quota'));
    const res = await handle({ action: MSG.TRANSCRIBE, audioBase64: 'QUJD', mimeType: 'audio/webm', mode: 'email', audioDuration: 12 });
    expect(res).toEqual({ success: true, text: 'final', raw: 'raw', cost: 0.0009, warning: null });
    expect(warn).toHaveBeenCalledWith('VoiceType: usage logging failed', expect.any(Error));
    warn.mockRestore();
  });

  it('returns a friendly error when dictation fails and logs nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.runDictation.mockRejectedValueOnce(new ProviderError('No speech detected.', { code: 'empty' }));
    const res = await handle({ action: MSG.TRANSCRIBE, audioBase64: 'QUJD', mode: 'default', audioDuration: 1 });
    expect(res).toEqual({ success: false, error: 'No speech detected.' });
    expect(deps.storage.setUsageLog).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns about a failed dictation with any key redacted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.runDictation.mockRejectedValueOnce(new ProviderError('Upstream echoed sk-abc123456 back'));
    await handle({ action: MSG.TRANSCRIBE, audioBase64: 'QUJD', mode: 'default', audioDuration: 1 });
    expect(warn).toHaveBeenCalledWith('VoiceType: ProviderError: Upstream echoed [key] back');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('sk-abc');
    warn.mockRestore();
  });

  it('warns about a failed key check with any key redacted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.validateKey.mockRejectedValueOnce(new ProviderError('Upstream echoed sk-abc123456 back'));
    await handle({ action: MSG.VALIDATE_KEY, provider: 'openai', key: 'sk-abc123456' });
    expect(warn).toHaveBeenCalledWith('VoiceType: ProviderError: Upstream echoed [key] back');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('sk-abc');
    warn.mockRestore();
  });

  it('reports a key check timeout as a key check timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.validateKey.mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'));
    expect(await handle({ action: MSG.VALIDATE_KEY, provider: 'gemini', key: 'AQ.x' })).toEqual({ ok: false, error: 'Key check timed out. Try again.' });
    deps.validateKey.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    expect(await handle({ action: MSG.VALIDATE_KEY, provider: 'gemini', key: 'AQ.x' })).toEqual({ ok: false, error: 'Key check timed out. Try again.' });
    warn.mockRestore();
  });

  it('serves and clears usage', async () => {
    usageLog.total.sessions = 3;
    await handle({ action: MSG.GET_USAGE });
    expect(deps.summarize).toHaveBeenCalledWith(usageLog);
    expect(await handle({ action: MSG.CLEAR_USAGE })).toEqual({ success: true });
    expect(deps.storage.setUsageLog).toHaveBeenCalledTimes(1);
    expect(deps.storage.setUsageLog).toHaveBeenCalledWith(expect.objectContaining({ total: expect.objectContaining({ sessions: 0 }) }));
    expect(usageLog.total.sessions).toBe(0);
  });

  it('relays toggle-recording to the active tab', async () => {
    expect(await handle({ action: MSG.TOGGLE_RECORDING })).toEqual({ success: true });
    expect(deps.toggleActiveTab).toHaveBeenCalledTimes(1);
  });

  it('returns undefined for unknown actions', async () => {
    expect(await handle({ action: 'nope' })).toBeUndefined();
  });
});

describe('userMessage', () => {
  it('maps timeouts, provider errors, network errors and the rest', () => {
    expect(userMessage(new DOMException('x', 'TimeoutError'))).toBe('Request timed out. Try a shorter recording.');
    expect(userMessage(new ProviderError('Gemini rejected the API key.'))).toBe('Gemini rejected the API key.');
    expect(userMessage(new TypeError('fetch failed'))).toBe('Network error. Check your connection.');
    expect(userMessage(new TypeError('Failed to fetch'))).toBe('Network error. Check your connection.');
    expect(userMessage(new TypeError('x is not a function'))).toBe('Something went wrong. Try again.');
    expect(userMessage(new Error('boom'))).toBe('Something went wrong. Try again.');
    expect(userMessage('weird')).toBe('Something went wrong. Try again.');
  });

  it('words timeouts for the key check context', () => {
    expect(userMessage(new DOMException('x', 'TimeoutError'), { context: 'validate' })).toBe('Key check timed out. Try again.');
    expect(userMessage(new ProviderError('OpenAI rejected the API key.'), { context: 'validate' })).toBe('OpenAI rejected the API key.');
  });
});
