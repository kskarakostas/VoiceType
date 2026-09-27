import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDictate } from '../../../src/background/dictate.js';
import { createStorage } from '../../../src/background/storage.js';
import { applyUsage } from '../../../src/background/usage.js';
import { userMessage } from '../../../src/background/router.js';
import { freshSettings } from '../../../src/shared/defaults.js';
import { ProviderError } from '../../../src/background/providers/errors.js';

const input = { audioBase64: 'QUJD', mimeType: 'audio/webm', modeKey: 'email', durationSec: 12.4 };
const result = { raw: 'raw', text: 'final', provider: 'openai', sttModel: 'gpt-transcribe', textModel: 'gpt-6-luna', audioSeconds: 12, cost: 0.0009, warning: null };

let settings, deps, dictate;
beforeEach(() => {
  settings = freshSettings();
  settings.keys.openai = 'sk-test-secret-123';
  deps = {
    storage: {
      getSettings: vi.fn(async () => settings),
      updateUsageLog: vi.fn(async (fn) => fn({ version: 2, daily: {}, total: {} })),
    },
    runDictation: vi.fn(async () => ({ ...result })),
    applyUsage: vi.fn((log, entry) => ({ ...log, lastEntry: entry })),
    userMessage,
  };
  dictate = createDictate(deps);
});
afterEach(() => vi.restoreAllMocks());

describe('createDictate', () => {
  it('runs the pipeline with fresh settings, logs usage and returns the dictation', async () => {
    const message = await dictate(input);
    expect(message).toEqual({ success: true, text: 'final', raw: 'raw', cost: 0.0009, warning: null });
    expect(deps.runDictation).toHaveBeenCalledWith({ ...input, settings });
    expect(deps.storage.updateUsageLog).toHaveBeenCalledTimes(1);
    expect(deps.applyUsage).toHaveBeenCalledWith(expect.anything(), { provider: 'openai', audioSeconds: 12, cost: 0.0009, mode: 'email' });
  });

  it('reads the settings again on every call', async () => {
    await dictate(input);
    settings = { ...settings, provider: 'gemini' };
    await dictate(input);
    expect(deps.storage.getSettings).toHaveBeenCalledTimes(2);
    expect(deps.runDictation.mock.calls[1][0].settings.provider).toBe('gemini');
  });

  it('passes the mode warning through', async () => {
    deps.runDictation.mockResolvedValueOnce({ ...result, text: 'raw', warning: 'Mode not applied: x. Raw transcript inserted.' });
    const message = await dictate(input);
    expect(message).toEqual({ success: true, text: 'raw', raw: 'raw', cost: 0.0009, warning: 'Mode not applied: x. Raw transcript inserted.' });
  });

  it('usage logging failure still succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.storage.updateUsageLog.mockRejectedValueOnce(new Error('quota'));
    const message = await dictate(input);
    expect(message).toEqual({ success: true, text: 'final', raw: 'raw', cost: 0.0009, warning: null });
    expect(warn).toHaveBeenCalledWith('VoiceType: usage logging failed', expect.any(Error));
  });

  it('maps a provider error with tone error and logs nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.runDictation.mockRejectedValueOnce(new ProviderError('No speech detected.', { code: 'empty' }));
    expect(await dictate(input)).toEqual({ success: false, error: 'No speech detected.', tone: 'error' });
    expect(deps.storage.updateUsageLog).not.toHaveBeenCalled();
  });

  it('maps a settings read failure to the generic message', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.storage.getSettings.mockRejectedValueOnce(new Error('storage down'));
    expect(await dictate(input)).toEqual({ success: false, error: 'Something went wrong. Try again.', tone: 'error' });
    expect(deps.runDictation).not.toHaveBeenCalled();
  });

  it('never writes the key to the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.runDictation.mockRejectedValueOnce(new ProviderError('Upstream echoed sk-test-secret-123 back'));
    const message = await dictate(input);
    expect(warn).toHaveBeenCalledWith('VoiceType: ProviderError: Upstream echoed [key] back');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('sk-test');
    expect(JSON.stringify(message)).not.toContain('sk-test');
  });

  it('two concurrent dictations log 2 sessions', async () => {
    const store = {};
    const area = {
      get: async (key) => ({ [key]: structuredClone(store[key]) }),
      set: async (items) => { Object.assign(store, structuredClone(items)); },
    };
    const storage = createStorage(area);
    await storage.saveSettings(settings);
    const real = createDictate({ storage, runDictation: deps.runDictation, applyUsage, userMessage });
    await Promise.all([real(input), real(input)]);
    expect((await storage.getUsageLog()).total.sessions).toBe(2);
  });
});
