import { describe, it, expect, vi } from 'vitest';
import { createStorage } from '../../../src/background/storage.js';
import { freshSettings, SETTINGS_VERSION } from '../../../src/shared/defaults.js';

function fakeArea(initial = {}) {
  const store = { ...initial };
  return {
    store,
    get: vi.fn(async (key) => ({ [key]: store[key] })),
    set: vi.fn(async (obj) => { Object.assign(store, obj); }),
  };
}

describe('createStorage', () => {
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

  it('replaces a v1 usage log with an empty v2 log', async () => {
    const storage = createStorage(fakeArea({ usageLog: { daily: {}, total: { sessions: 9 } } }));
    const log = await storage.getUsageLog();
    expect(log.version).toBe(2);
    expect(log.total.sessions).toBe(0);
  });
});
