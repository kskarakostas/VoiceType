import { describe, it, expect, vi } from 'vitest';
import { createStorage } from '../../../src/background/storage.js';
import { applyUsage } from '../../../src/background/usage.js';
import { freshSettings, SETTINGS_VERSION } from '../../../src/shared/defaults.js';

/** chrome.storage stand-in: values are cloned both ways, like the real structured-clone boundary. */
function fakeArea(initial = {}) {
  const store = structuredClone(initial);
  return {
    store,
    get: vi.fn(async (key) => ({ [key]: structuredClone(store[key]) })),
    set: vi.fn(async (items) => { Object.assign(store, structuredClone(items)); }),
  };
}

const entry = { provider: 'openai', audioSeconds: 10, cost: 0.001, mode: 'default' };
const now = new Date(2026, 8, 26, 12);

describe('createStorage settings', () => {
  it('migrates v1 settings on first read and writes them back once', async () => {
    const area = fakeArea({ settings: { apiKey: 'sk-old', apiKeyEncrypted: false, provider: 'openai', modes: {} } });
    const storage = createStorage(area);
    const s = await storage.getSettings();
    expect(s.settingsVersion).toBe(SETTINGS_VERSION);
    expect(s.keys.openai).toBe('sk-old');
    expect(area.set).toHaveBeenCalledTimes(1);
    await storage.getSettings();
    expect(area.set).toHaveBeenCalledTimes(1);
  });

  it('returns defaults when nothing is stored', async () => {
    const storage = createStorage(fakeArea());
    const s = await storage.getSettings();
    expect(s.provider).toBe('openai');
    expect(s.modes.default).toBeDefined();
  });

  it('stamps the version on save', async () => {
    const area = fakeArea();
    const storage = createStorage(area);
    const s = freshSettings(); delete s.settingsVersion; s.keys.gemini = 'AQ.x';
    await storage.saveSettings(s);
    expect(area.store.settings.settingsVersion).toBe(SETTINGS_VERSION);
    expect(area.store.settings.keys.gemini).toBe('AQ.x');
  });

  it('updateSettings writes the callback result and returns it', async () => {
    const area = fakeArea({ settings: freshSettings() });
    const storage = createStorage(area);
    const result = await storage.updateSettings((current) => ({ ...current, activeMode: 'email' }));
    expect(result.activeMode).toBe('email');
    expect(result.settingsVersion).toBe(SETTINGS_VERSION);
    expect(area.store.settings.activeMode).toBe('email');
  });

  it('updateSettings writes nothing when the callback returns null', async () => {
    const area = fakeArea({ settings: freshSettings() });
    const storage = createStorage(area);
    const result = await storage.updateSettings(() => null);
    expect(result.activeMode).toBe('default');
    expect(area.set).not.toHaveBeenCalled();
  });

  it('two concurrent settings updates both land', async () => {
    const area = fakeArea({ settings: freshSettings() });
    const storage = createStorage(area);
    await Promise.all([
      storage.updateSettings((s) => ({ ...s, activeMode: 'email' })),
      storage.updateSettings((s) => ({ ...s, provider: 'gemini' })),
    ]);
    expect(area.store.settings.activeMode).toBe('email');
    expect(area.store.settings.provider).toBe('gemini');
  });
});

describe('createStorage usage', () => {
  it('replaces a v1 usage log with an empty v2 log', async () => {
    const storage = createStorage(fakeArea({ usageLog: { daily: {}, total: { sessions: 9 } } }));
    const log = await storage.getUsageLog();
    expect(log.version).toBe(2);
    expect(log.total.sessions).toBe(0);
  });

  it('normalizes a partial v2 usage log on read', async () => {
    const storage = createStorage(fakeArea({ usageLog: { version: 2, daily: { '2026-09-26': { sessions: 2 } }, total: { sessions: 2 } } }));
    const log = await storage.getUsageLog();
    expect(log.daily['2026-09-26'].estimatedCost).toBe(0);
    expect(log.daily['2026-09-26'].byProvider.openai).toEqual({ sessions: 0, audioSeconds: 0, cost: 0 });
    expect(log.total.sessions).toBe(2);
    expect(log.total.audioSeconds).toBe(0);
  });

  it('two concurrent updateUsageLog calls both land: 2 sessions', async () => {
    const area = fakeArea();
    const storage = createStorage(area);
    await Promise.all([
      storage.updateUsageLog((log) => applyUsage(log, entry, now)),
      storage.updateUsageLog((log) => applyUsage(log, entry, now)),
    ]);
    expect(area.store.usageLog.total.sessions).toBe(2);
    expect((await storage.getUsageLog()).total.sessions).toBe(2);
  });

  it('serializes usage updates with plain writes', async () => {
    const area = fakeArea();
    const storage = createStorage(area);
    const logged = storage.updateUsageLog((log) => applyUsage(log, entry, now));
    const cleared = storage.setUsageLog({ version: 2, daily: {}, total: {} });
    await Promise.all([logged, cleared]);
    expect((await storage.getUsageLog()).total.sessions).toBe(0);
  });

  it('a failed update does not block later calls', async () => {
    const storage = createStorage(fakeArea());
    await expect(storage.updateUsageLog(() => { throw new Error('boom'); })).rejects.toThrow('boom');
    const log = await storage.updateUsageLog((l) => applyUsage(l, entry, now));
    expect(log.total.sessions).toBe(1);
  });
});
