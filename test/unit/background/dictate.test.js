import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BOOKKEEPING_LIMIT_MS, createDictate } from '../../../src/background/dictate.js';
import { createStorage } from '../../../src/background/storage.js';
import { createHistory } from '../../../src/background/history.js';
import { applyUsage } from '../../../src/background/usage.js';
import { userMessage } from '../../../src/background/router.js';
import { freshSettings } from '../../../src/shared/defaults.js';
import { ProviderError } from '../../../src/background/providers/errors.js';

const input = { audioBase64: 'QUJD', mimeType: 'audio/webm', modeKey: 'email', durationSec: 12.4, host: 'example.com', incognito: false };
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
    history: { mark: vi.fn(() => 5), add: vi.fn(async () => {}) },
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
    const { host: _host, incognito: _incognito, ...pipelineInput } = input;
    expect(deps.runDictation).toHaveBeenCalledWith({ ...pipelineInput, settings });
    expect(deps.storage.updateUsageLog).toHaveBeenCalledTimes(1);
    expect(deps.applyUsage).toHaveBeenCalledWith(expect.anything(), { provider: 'openai', audioSeconds: 12, cost: 0.0009, mode: 'email', words: 1 });
  });

  it('logs the word count of the raw transcript', async () => {
    deps.runDictation.mockResolvedValueOnce({ ...result, raw: 'Καλημέρα, τι κάνεις;', text: 'Good morning, how are you?' });
    await dictate(input);
    expect(deps.applyUsage.mock.calls[0][1].words).toBe(3);
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
    const real = createDictate({ storage, history: deps.history, runDictation: deps.runDictation, applyUsage, userMessage });
    await Promise.all([real(input), real(input)]);
    expect((await storage.getUsageLog()).total.sessions).toBe(2);
  });

  describe('history', () => {
    it('adds an entry after a success, with raw, text, mode and host', async () => {
      await dictate(input);
      expect(deps.history.add).toHaveBeenCalledTimes(1);
      expect(deps.history.add).toHaveBeenCalledWith({ raw: 'raw', text: 'final', mode: 'email', host: 'example.com' }, 5);
    });

    it('adds a null host as it came', async () => {
      await dictate({ ...input, host: null });
      expect(deps.history.add).toHaveBeenCalledWith(expect.objectContaining({ host: null }), 5);
    });

    it('adds nothing on a failure', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      deps.runDictation.mockRejectedValueOnce(new ProviderError('No speech detected.', { code: 'empty' }));
      await dictate(input);
      expect(deps.history.add).not.toHaveBeenCalled();
    });

    it('adds nothing with keepHistory off', async () => {
      settings.keepHistory = false;
      const message = await dictate(input);
      expect(message.success).toBe(true);
      expect(deps.history.add).not.toHaveBeenCalled();
      expect(deps.storage.updateUsageLog).toHaveBeenCalledTimes(1);
    });

    it('adds nothing for an incognito tab, and still logs usage', async () => {
      const message = await dictate({ ...input, incognito: true });
      expect(message.success).toBe(true);
      expect(deps.history.add).not.toHaveBeenCalled();
      expect(deps.storage.updateUsageLog).toHaveBeenCalledTimes(1);
    });

    it('takes the mark before it reads the settings', async () => {
      await dictate(input);
      expect(deps.history.mark.mock.invocationCallOrder[0]).toBeLessThan(deps.storage.getSettings.mock.invocationCallOrder[0]);
    });

    it('a failed history write still returns the result and logs usage, under its own text', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      deps.history.add.mockRejectedValueOnce(new Error('quota'));
      expect(await dictate(input)).toEqual({ success: true, text: 'final', raw: 'raw', cost: 0.0009, warning: null });
      expect(deps.storage.updateUsageLog).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('VoiceType: history write failed', expect.any(Error));
    });

    it('a history write that throws at once still logs usage', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      deps.history.add.mockImplementationOnce(() => { throw new Error('bug'); });
      expect((await dictate(input)).success).toBe(true);
      expect(deps.storage.updateUsageLog).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('VoiceType: history write failed', expect.any(Error));
    });

    it('a failed usage write still adds the entry, and warns about usage alone', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      deps.storage.updateUsageLog.mockRejectedValueOnce(new Error('quota'));
      expect((await dictate(input)).success).toBe(true);
      expect(deps.history.add).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('VoiceType: usage logging failed', expect.any(Error));
    });

    it('both writes failing warns twice: one does not hide the other', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      deps.storage.updateUsageLog.mockRejectedValueOnce(new Error('usage quota'));
      deps.history.add.mockRejectedValueOnce(new Error('history quota'));
      expect((await dictate(input)).success).toBe(true);
      expect(warn.mock.calls.map(([text]) => text).sort()).toEqual(['VoiceType: history write failed', 'VoiceType: usage logging failed']);
    });

    it('never writes the transcript to the console', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      deps.runDictation.mockResolvedValueOnce({ ...result, raw: 'private words', text: 'private final' });
      deps.storage.updateUsageLog.mockRejectedValueOnce(new Error('quota'));
      deps.history.add.mockRejectedValueOnce(new Error('quota'));
      await dictate(input);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(warn.mock.calls.map((call) => call.map(String)))).not.toContain('private');
    });
  });

  describe('a clear during the provider call (V27)', () => {
    let history, finish, real;

    /** The real store; the provider call waits for finish() so the test can act during it. */
    beforeEach(() => {
      const store = {};
      history = createHistory({
        area: {
          get: async (key) => ({ [key]: structuredClone(store[key]) }),
          set: async (items) => { Object.assign(store, structuredClone(items)); },
        },
      });
      deps.runDictation.mockImplementation(() => new Promise((resolve) => { finish = () => resolve({ ...result }); }));
      real = createDictate({ ...deps, history });
    });

    /** One dictation with `during` run while the provider is working. */
    async function dictateWith(during) {
      finish = null;
      const pending = real(input);
      await vi.waitFor(() => expect(finish).not.toBeNull());
      await during();
      finish();
      return pending;
    }

    it('a dictation with no clear adds one', async () => {
      await dictateWith(() => {});
      expect(await history.list()).toEqual([expect.objectContaining({ raw: 'raw', text: 'final', mode: 'email', host: 'example.com' })]);
    });

    it('toggle off during the provider call adds nothing, and the result still goes out', async () => {
      const message = await dictateWith(async () => {
        settings.keepHistory = false;
        await history.clear(); // what the worker does on the on-to-off change
      });
      expect(message.success).toBe(true);
      expect(await history.list()).toEqual([]);
    });

    it('Clear during the provider call adds nothing, with the toggle still on', async () => {
      const message = await dictateWith(() => history.clear());
      expect(message.success).toBe(true);
      expect(settings.keepHistory).toBe(true);
      expect(await history.list()).toEqual([]);
    });

    it('the settings read does not hide a clear: one landing between the mark and the read drops it', async () => {
      deps.storage.getSettings.mockImplementationOnce(async () => { await history.clear(); return settings; });
      await dictateWith(() => {});
      expect(await history.list()).toEqual([]);
    });

    it('the dictation after a clear is kept', async () => {
      await dictateWith(() => history.clear());
      await dictateWith(() => {});
      expect(await history.list()).toHaveLength(1);
    });
  });

  describe('the bookkeeping limit (V34)', () => {
    const delivered = { success: true, text: 'final', raw: 'raw', cost: 0.0009, warning: null };

    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('is 2 seconds', () => {
      expect(BOOKKEEPING_LIMIT_MS).toBe(2000);
    });

    it('returns the transcript when the usage write never settles', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      deps.storage.updateUsageLog.mockReturnValueOnce(new Promise(() => {}));
      const settled = vi.fn();
      const pending = dictate(input).then((message) => { settled(); return message; });
      await vi.advanceTimersByTimeAsync(BOOKKEEPING_LIMIT_MS - 1);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual(delivered);
      expect(warn).toHaveBeenCalledWith('VoiceType: usage logging failed', expect.any(Error));
    });

    it('a history write that never settles does not hold the result', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      deps.history.add.mockReturnValueOnce(new Promise(() => {}));
      const settled = vi.fn();
      const pending = dictate(input).then((message) => { settled(); return message; });
      await vi.advanceTimersByTimeAsync(BOOKKEEPING_LIMIT_MS - 1);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual(delivered);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('VoiceType: history write failed', expect.any(Error));
      expect(vi.getTimerCount()).toBe(0);
    });

    it('a usage write that never settles does not hold the history write', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      deps.storage.updateUsageLog.mockReturnValueOnce(new Promise(() => {}));
      const pending = dictate(input);
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.history.add).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(BOOKKEEPING_LIMIT_MS);
      expect(await pending).toEqual(delivered);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('VoiceType: usage logging failed', expect.any(Error));
    });

    it('the writes share one limit, and a write ending early does not extend it', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      deps.storage.updateUsageLog.mockReturnValueOnce(new Promise(() => {}));
      deps.history.add.mockReturnValueOnce(new Promise((resolve) => { setTimeout(resolve, BOOKKEEPING_LIMIT_MS - 1); }));
      const settled = vi.fn();
      const pending = dictate(input).then((message) => { settled(); return message; });
      await vi.advanceTimersByTimeAsync(BOOKKEEPING_LIMIT_MS - 1);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual(delivered);
    });

    it('both writes hanging warns about each and returns at the limit', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      deps.storage.updateUsageLog.mockReturnValueOnce(new Promise(() => {}));
      deps.history.add.mockReturnValueOnce(new Promise(() => {}));
      const pending = dictate(input);
      await vi.advanceTimersByTimeAsync(BOOKKEEPING_LIMIT_MS);
      expect(await pending).toEqual(delivered);
      expect(warn.mock.calls.map(([text]) => text).sort()).toEqual(['VoiceType: history write failed', 'VoiceType: usage logging failed']);
    });

    it('a write that hangs past the limit and fails later raises no unhandled rejection', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      let fail;
      deps.history.add.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
      const pending = dictate(input);
      await vi.advanceTimersByTimeAsync(BOOKKEEPING_LIMIT_MS);
      await pending;
      fail(new Error('late'));
      vi.useRealTimers();
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      process.off('unhandledRejection', unhandled);
      expect(unhandled).not.toHaveBeenCalled();
    });

    it('returns at once when the usage write ends early', async () => {
      expect(await dictate(input)).toEqual(delivered);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('leaves no timer when the usage write fails', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      deps.storage.updateUsageLog.mockRejectedValueOnce(new Error('quota'));
      expect(await dictate(input)).toEqual(delivered);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('starts no timer for a failed dictation', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      deps.runDictation.mockRejectedValueOnce(new ProviderError('No speech detected.', { code: 'empty' }));
      await dictate(input);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
