import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MSG, SAVE_PORT } from '../../../src/shared/messages.js';
import { freshSettings } from '../../../src/shared/defaults.js';

/**
 * Minimal chrome stand-in: records listeners and keeps storage.local in memory. It has no
 * `commands` namespace, so an entry that still registers a command listener fails to load.
 */
function fakeChrome({ accessLevel = true } = {}) {
  const listeners = {};
  const on = (name) => ({ addListener: vi.fn((fn) => { listeners[name] = fn; }) });
  const store = {};
  const session = {};
  const chrome = {
    runtime: {
      id: 'abc',
      getURL: (path) => `chrome-extension://abc/${path.replace(/^\//, '')}`,
      getContexts: vi.fn(async () => []),
      sendMessage: vi.fn(async () => ({ ok: true })),
      onMessage: on('message'),
      onConnect: on('connect'),
      onInstalled: on('installed'),
      onStartup: on('startup'),
    },
    offscreen: { createDocument: vi.fn(async () => {}) },
    storage: {
      local: {
        get: vi.fn(async (key) => ({ [key]: structuredClone(store[key]) })),
        set: vi.fn(async (items) => { Object.assign(store, structuredClone(items)); }),
        setAccessLevel: accessLevel ? vi.fn(async () => {}) : undefined,
      },
      session: {
        get: vi.fn(async (key) => ({ [key]: structuredClone(session[key]) })),
        set: vi.fn(async (items) => { Object.assign(session, structuredClone(items)); }),
        remove: vi.fn(async (key) => { delete session[key]; }),
      },
      onChanged: on('storageChanged'),
    },
    tabs: {
      query: vi.fn(async () => [{ id: 1 }, { id: 2 }]),
      sendMessage: vi.fn(async () => undefined),
      create: vi.fn(async () => ({ id: 9 })),
      onRemoved: on('tabRemoved'),
    },
    scripting: { executeScript: vi.fn(async () => []) },
  };
  return { chrome, listeners, store, session };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const PAGE = { id: 'abc', origin: 'https://example.com', url: 'https://example.com/', tab: { id: 1 }, frameId: 0 };
const OTHER_PAGE = { id: 'abc', origin: 'https://example.org', url: 'https://example.org/', tab: { id: 2 }, frameId: 0 };
const POPUP = { id: 'abc', origin: 'chrome-extension://abc', url: 'chrome-extension://abc/popup.html' };
const OFFSCREEN = { id: 'abc', origin: 'chrome-extension://abc', url: 'chrome-extension://abc/offscreen.html' };

async function load({ pendingDictation, ...options } = {}) {
  const fake = fakeChrome(options);
  if (pendingDictation) fake.session.pendingDictation = pendingDictation;
  vi.stubGlobal('chrome', fake.chrome);
  vi.resetModules();
  await import('../../../src/background/index.js');
  return fake;
}

/** Call the onMessage listener the way Chrome does and wait for the async response. */
async function send(listeners, request, sender) {
  const sendResponse = vi.fn();
  expect(listeners.message(request, sender, sendResponse)).toBe(true);
  await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
  return sendResponse.mock.calls[0][0];
}

/** Open a port the way Chrome does: `post` plays a message from the page. */
function connect(listeners, name, sender) {
  let onPost;
  const port = { name, sender, postMessage: vi.fn(), onMessage: { addListener: vi.fn((fn) => { onPost = fn; }) } };
  listeners.connect(port);
  return { port, post: (message) => onPost?.(message) };
}

let fake;
beforeEach(async () => { fake = await load(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('service worker entry', () => {
  it('saves a post on the save port and answers with its id', async () => {
    const { port, post } = connect(fake.listeners, SAVE_PORT, POPUP);
    post({ id: 7, message: { action: MSG.SAVE_SETTINGS, settings: { keepHistory: false } } });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ id: 7, reply: { success: true } }));
    expect(fake.store.settings.keepHistory).toBe(false);
  });

  it('holds the save port to the access rules of a message', async () => {
    const { port, post } = connect(fake.listeners, SAVE_PORT, PAGE);
    post({ id: 1, message: { action: MSG.SAVE_SETTINGS, settings: { keepHistory: false } } });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ id: 1, reply: { success: false, error: 'Not allowed.' } }));
    expect(fake.store.settings?.keepHistory).not.toBe(false);
  });

  it('still saves when the page has gone before the answer', async () => {
    const { port, post } = connect(fake.listeners, SAVE_PORT, POPUP);
    port.postMessage.mockImplementation(() => { throw new Error('Attempting to use a disconnected port object'); });
    post({ id: 2, message: { action: MSG.SAVE_SETTINGS, settings: { keepHistory: false } } });
    await vi.waitFor(() => expect(fake.store.settings?.keepHistory).toBe(false));
    await flush();
    expect(port.postMessage).toHaveBeenCalledOnce();
  });

  it('ignores a port of any other name', () => {
    const { port } = connect(fake.listeners, 'other', POPUP);
    expect(port.onMessage.addListener).not.toHaveBeenCalled();
  });

  it('restricts storage.local to trusted contexts at load', () => {
    expect(fake.chrome.storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  });

  it('only warns when setAccessLevel is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await load({ accessLevel: false });
    await flush();
    expect(warn).toHaveBeenCalledWith('VoiceType: could not restrict storage access', expect.any(TypeError));
  });

  it('pushes key-free settings to every tab when settings change', async () => {
    const settings = freshSettings();
    settings.keys.openai = 'sk-secret-123456';
    fake.listeners.storageChanged({ settings: { newValue: settings } }, 'local');
    await flush();
    expect(fake.chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    const [tabId, message] = fake.chrome.tabs.sendMessage.mock.calls[0];
    expect(tabId).toBe(1);
    expect(message.action).toBe(MSG.SETTINGS_CHANGED);
    expect(message.settings).not.toHaveProperty('keys');
    expect(message.settings.hasKey).toEqual({ openai: true, gemini: false });
    expect(JSON.stringify(fake.chrome.tabs.sendMessage.mock.calls)).not.toContain('sk-secret');
  });

  it('never broadcasts a stray field of the stored settings', async () => {
    fake.listeners.storageChanged({ settings: { newValue: { ...freshSettings(), apiKey: 'sk-live-LEAK' } } }, 'local');
    await flush();
    expect(fake.chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    const [, message] = fake.chrome.tabs.sendMessage.mock.calls[0];
    expect(message.action).toBe(MSG.SETTINGS_CHANGED);
    expect(message.settings).not.toHaveProperty('apiKey');
    expect(JSON.stringify(fake.chrome.tabs.sendMessage.mock.calls)).not.toContain('sk-live-LEAK');
  });

  it('each tab gets its own site', async () => {
    fake.chrome.tabs.query.mockResolvedValue([{ id: 1, url: 'https://a.com/' }, { id: 2 }]);
    const settings = freshSettings();
    settings.keys.openai = 'sk-secret-123456';
    settings.siteRules = {
      'a.com': { hidePill: true, mode: 'email' },
      'b.com': { hidePill: false, mode: 'email' },
    };
    fake.listeners.storageChanged({ settings: { newValue: settings } }, 'local');
    await flush();
    const [[, first], [, second]] = fake.chrome.tabs.sendMessage.mock.calls;
    expect(fake.chrome.tabs.query).toHaveBeenCalledTimes(1);
    expect(first.settings.site).toEqual({ hidePill: true, mode: 'email' });
    expect(second.settings.site).toEqual({ hidePill: false, mode: null });
    for (const message of [first, second]) {
      expect(message.action).toBe(MSG.SETTINGS_CHANGED);
      expect(message.settings).not.toHaveProperty('siteRules');
      expect(message.settings).not.toHaveProperty('keys');
      expect(JSON.stringify(message)).not.toContain('b.com');
      expect(JSON.stringify(message)).not.toContain('sk-secret');
    }
    expect(JSON.stringify(second)).not.toContain('a.com');
  });

  it('ignores removed settings, usage writes and other areas', async () => {
    fake.listeners.storageChanged({ settings: { oldValue: freshSettings() } }, 'local');
    fake.listeners.storageChanged({ usageLog: { newValue: { version: 2 } } }, 'local');
    fake.listeners.storageChanged({ settings: { newValue: freshSettings() } }, 'sync');
    await flush();
    expect(fake.chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('routes messages with the real sender: pages get public settings, the popup gets keys', async () => {
    fake.store.settings = { ...freshSettings(), keys: { openai: 'sk-secret-123456', gemini: '' } };
    const pub = await send(fake.listeners, { action: MSG.GET_SETTINGS }, PAGE);
    expect(pub).not.toHaveProperty('keys');
    const full = await send(fake.listeners, { action: MSG.GET_SETTINGS }, POPUP);
    expect(full.keys.openai).toBe('sk-secret-123456');
    expect(await send(fake.listeners, { action: MSG.SAVE_SETTINGS, settings: {} }, PAGE)).toEqual({ success: false, error: 'Not allowed.' });
    expect(await send(fake.listeners, { action: 'nope' }, POPUP)).toEqual({ success: false, error: 'Unknown action' });
  });
});

describe('history wiring', () => {
  const ENTRY = { id: 'a', raw: 'raw words', text: 'final words', mode: 'default', host: 'example.com', ts: 1 };
  const AT_EXAMPLE = { ...PAGE, tab: { id: 1, url: 'https://example.com/page' } };
  const AT_OTHER = { ...OTHER_PAGE, tab: { id: 2, url: 'https://example.org/' } };
  const on = () => freshSettings();
  const off = () => ({ ...freshSettings(), keepHistory: false });

  /** Report a settings write the way Chrome does and let the listener's work land. */
  async function settingsChanged(oldValue, newValue) {
    fake.listeners.storageChanged({ settings: { oldValue, newValue } }, 'local');
    await flush();
  }

  beforeEach(() => { fake.session.history = [ENTRY]; });

  it('turning keepHistory off clears history; a later unrelated save does not', async () => {
    await settingsChanged(on(), off());
    expect(fake.session.history).toEqual([]);
    fake.session.history = [ENTRY];
    await settingsChanged(off(), { ...off(), pillStyle: 'pill' });
    expect(fake.session.history).toEqual([ENTRY]);
  });

  it('a save with keepHistory on leaves history alone', async () => {
    await settingsChanged(on(), { ...on(), pillStyle: 'pill' });
    await settingsChanged(off(), on());
    expect(fake.session.history).toEqual([ENTRY]);
  });

  it('an old record with no keepHistory counts as on', async () => {
    const { keepHistory: _keepHistory, ...before } = freshSettings();
    await settingsChanged(before, off());
    expect(fake.session.history).toEqual([]);
  });

  it('a change in another area clears nothing', async () => {
    fake.listeners.storageChanged({ settings: { oldValue: on(), newValue: off() } }, 'sync');
    await flush();
    expect(fake.session.history).toEqual([ENTRY]);
  });

  it('a failed clear warns and still pushes the settings to the tabs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fake.chrome.storage.session.set.mockRejectedValueOnce(new Error('down'));
    await settingsChanged(on(), off());
    expect(warn).toHaveBeenCalledWith('VoiceType: could not clear history', expect.any(Error));
    expect(fake.chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('answers each sender from chrome.storage.session', async () => {
    expect(await send(fake.listeners, { action: MSG.GET_LAST_DICTATION }, AT_EXAMPLE)).toEqual({ entry: { raw: 'raw words', text: 'final words', edit: false } });
    expect(await send(fake.listeners, { action: MSG.GET_LAST_DICTATION }, AT_OTHER)).toEqual({ entry: null });
    expect(await send(fake.listeners, { action: MSG.GET_HISTORY }, POPUP)).toEqual({ entries: [ENTRY] });
    expect(await send(fake.listeners, { action: MSG.GET_HISTORY }, AT_EXAMPLE)).toEqual({ success: false, error: 'Not allowed.' });
    expect(await send(fake.listeners, { action: MSG.CLEAR_HISTORY }, POPUP)).toEqual({ success: true });
    expect(fake.session.history).toEqual([]);
  });

  /** One dictation from `sender` through the real worker, with the provider stubbed. */
  async function dictateFrom(sender) {
    fake.session.history = [];
    fake.store.settings = { ...freshSettings(), keys: { openai: 'sk-secret-123456', gemini: '' } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ text: 'spoken words', usage: {} }), { status: 200 })));
    await send(fake.listeners, { action: MSG.START_RECORDING }, sender);
    const [{ captureId }] = fake.chrome.runtime.sendMessage.mock.calls.map(([m]) => m).filter((m) => m.action === MSG.OFFSCREEN_START);
    await send(fake.listeners, { action: MSG.OFFSCREEN_DONE, audioBase64: 'QUJD', mimeType: 'audio/webm', durationSec: 2, reason: 'user', captureId }, OFFSCREEN);
  }

  it('a third-party frame files its dictation under no site, and cannot read the first party', async () => {
    const WIDGET = { ...AT_EXAMPLE, origin: 'https://widget.com', url: 'https://widget.com/embed', frameId: 4 };
    await dictateFrom(WIDGET);
    expect(fake.session.history).toEqual([expect.objectContaining({ host: null })]);
    fake.session.history = [ENTRY];
    expect(await send(fake.listeners, { action: MSG.GET_LAST_DICTATION }, WIDGET)).toEqual({ entry: null });
  });

  it('an incognito tab keeps nothing', async () => {
    await dictateFrom({ ...AT_EXAMPLE, tab: { ...AT_EXAMPLE.tab, incognito: true } });
    expect(fake.session.history).toEqual([]);
  });

  it('a dictation lands in chrome.storage.session under the site of its tab, nothing in storage.local', async () => {
    await dictateFrom(AT_EXAMPLE);
    expect(fake.session.history).toEqual([{ id: expect.any(String), raw: 'spoken words', text: 'spoken words', mode: 'default', host: 'example.com', ts: expect.any(Number) }]);
    expect(JSON.stringify(fake.store)).not.toContain('spoken words');
  });
});

describe('first install', () => {
  it('opens #welcome on install', async () => {
    fake.listeners.installed({ reason: 'install' });
    await flush();
    expect(fake.chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(fake.chrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome-extension://abc/options.html#welcome' });
  });

  it('opens nothing on update or browser update', async () => {
    for (const reason of ['update', 'chrome_update', 'shared_module_update']) {
      fake.listeners.installed({ reason });
      await flush();
    }
    fake.listeners.startup();
    await flush();
    expect(fake.chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('a failed tab open is ignored', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    // A plain function: a vi.fn watches its promise, which would hide an unhandled rejection.
    let opened = 0;
    fake.chrome.tabs.create = () => {
      opened += 1;
      return Promise.reject(new Error('no window'));
    };
    try {
      fake.listeners.installed({ reason: 'install' });
      await flush();
      await flush();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(opened).toBe(1);
    expect(unhandled).not.toHaveBeenCalled();
    // onInstalled keeps its other work.
    expect(fake.store.settings).toBeDefined();
    expect(fake.chrome.scripting.executeScript).toHaveBeenCalledTimes(2);
  });
});

describe('recording wiring', () => {
  beforeEach(() => {
    fake.store.settings = { ...freshSettings(), keys: { openai: 'sk-secret-123456', gemini: '' } };
  });

  it('re-injects content scripts into open tabs on install', async () => {
    fake.listeners.installed({ reason: 'update' });
    await flush();
    expect(fake.chrome.tabs.query).toHaveBeenCalledWith({ url: ['http://*/*', 'https://*/*', 'file:///*'] });
    expect(fake.chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 1, allFrames: true }, files: ['content.js'] });
    expect(fake.chrome.scripting.executeScript).toHaveBeenCalledTimes(2);
  });

  it('starts a recording through the offscreen document and relays levels to the frame', async () => {
    expect(await send(fake.listeners, { action: MSG.START_RECORDING }, PAGE)).toEqual({ ok: true });
    expect(fake.chrome.offscreen.createDocument).toHaveBeenCalledWith(expect.objectContaining({
      url: 'chrome-extension://abc/offscreen.html', reasons: ['USER_MEDIA', 'CLIPBOARD'],
    }));
    expect(fake.chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: MSG.OFFSCREEN_START, maxSec: 120, silenceSec: 0, captureId: expect.any(String) });
    expect(JSON.stringify(fake.chrome.runtime.sendMessage.mock.calls)).not.toContain('sk-secret');
    const [{ captureId }] = fake.chrome.runtime.sendMessage.mock.calls.map(([m]) => m).filter((m) => m.action === MSG.OFFSCREEN_START);
    expect(await send(fake.listeners, { action: MSG.OFFSCREEN_LEVEL, level: 0.5, captureId }, OFFSCREEN)).toEqual({ ok: true });
    await vi.waitFor(() => expect(fake.chrome.tabs.sendMessage).toHaveBeenCalledWith(1, { action: MSG.AUDIO_LEVEL, level: 0.5 }, { frameId: 0 }));
  });

  it('a removed tab frees its recording for the next tab', async () => {
    await send(fake.listeners, { action: MSG.START_RECORDING }, PAGE);
    await fake.listeners.tabRemoved(1);
    await vi.waitFor(() => expect(fake.chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: MSG.OFFSCREEN_STOP, discard: true, captureId: expect.any(String) }));
    expect(await send(fake.listeners, { action: MSG.START_RECORDING }, OTHER_PAGE)).toEqual({ ok: true });
  });

  it('opens the permission page when the microphone needs permission', async () => {
    fake.chrome.runtime.sendMessage.mockResolvedValueOnce({ ok: false, reason: 'needsPermission', error: 'Microphone permission needed.' });
    const res = await send(fake.listeners, { action: MSG.START_RECORDING }, PAGE);
    expect(res.reason).toBe('needsPermission');
    expect(fake.chrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome-extension://abc/permission.html' });
  });
});

describe('held audio wiring', () => {
  const STALE = { captureId: 'c', endpoint: { tabId: 1, frameId: 0 }, audioBase64: 'QUJD', bootId: 'gone', at: 1000, attempts: 0 };

  beforeEach(() => {
    fake.store.settings = { ...freshSettings(), keys: { openai: 'sk-secret-123456', gemini: '' } };
  });

  it('a worker sweeps at load', async () => {
    const stale = await load({ pendingDictation: STALE });
    await vi.waitFor(() => expect(stale.session.pendingDictation).toBeUndefined());
  });

  it('keeps a fresh record at load, in the session area', async () => {
    const record = { ...STALE, at: Date.now() };
    const kept = await load({ pendingDictation: record });
    await flush();
    expect(kept.session.pendingDictation).toEqual(record);
    expect(kept.chrome.storage.session.get).toHaveBeenCalledWith('pendingDictation');
  });

  describe('a worker event past the window', () => {
    const NOW = 10_000_000;
    /** A worker that noted a fresh record at load, with the clock moved past its window. */
    async function noted() {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
      const worker = await load({ pendingDictation: { ...STALE, at: NOW - 1000, endpoint: { tabId: 7, frameId: 0 } } });
      await flush();
      expect(worker.session.pendingDictation).toBeDefined();
      clock.mockReturnValue(NOW + 120_000);
      return worker;
    }

    it('a tab closing anywhere clears the record', async () => {
      const worker = await noted();
      worker.listeners.tabRemoved(99);
      await vi.waitFor(() => expect(worker.session.pendingDictation).toBeUndefined());
    });

    it('a storage change clears the record', async () => {
      const worker = await noted();
      worker.listeners.storageChanged({ history: {} }, 'session');
      await vi.waitFor(() => expect(worker.session.pendingDictation).toBeUndefined());
    });
  });

  it('a worker woken by the close of its tab clears that tab\'s fresh record', async () => {
    const woken = await load({ pendingDictation: { ...STALE, at: Date.now() } });
    woken.listeners.tabRemoved(1);
    await vi.waitFor(() => expect(woken.session.pendingDictation).toBeUndefined());
  });

  it('a page ping answers from the recorder', async () => {
    expect(await send(fake.listeners, { action: MSG.PROCESSING_PING }, PAGE)).toEqual({ alive: false });
  });

  it('a page ping resumes a record left by an earlier worker, under a boot id of this worker', async () => {
    fake.store.settings = undefined;
    const record = { ...STALE, at: Date.now(), modeKey: 'default', host: null, incognito: false, sounds: false, alwaysCopy: false, mimeType: 'audio/webm', durationSec: 2, editText: null };
    const resumed = await load({ pendingDictation: record });
    expect(await send(resumed.listeners, { action: MSG.PROCESSING_PING }, PAGE)).toEqual({ alive: true });
    await vi.waitFor(() => expect(resumed.chrome.storage.session.set).toHaveBeenCalled());
    const { pendingDictation } = resumed.chrome.storage.session.set.mock.calls[0][0];
    expect(pendingDictation).toMatchObject({ attempts: 1 });
    expect(pendingDictation.bootId).not.toBe('gone');
    expect(pendingDictation.bootId).toEqual(expect.any(String));
  });
});
