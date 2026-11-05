import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRouter, createValidateKey, senderKind, userMessage } from '../../../src/background/router.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings, MAX_EDIT_CHARS, SETTINGS_VERSION } from '../../../src/shared/defaults.js';
import { emptyLog } from '../../../src/background/usage.js';
import { ProviderError } from '../../../src/background/providers/errors.js';
import { createStorage } from '../../../src/background/storage.js';

// identify() is injected, so test senders carry their kind directly.
const POPUP = { kind: 'extension' };
const OFFSCREEN = { kind: 'offscreen' };
const STRANGER = { kind: 'unknown' };
const CONTENT = { kind: 'content', tab: { id: 7 }, frameId: 3 };
const TOP_FRAME = { kind: 'content', tab: { id: 7 } };
const NOT_ALLOWED = { success: false, error: 'Not allowed.' };
const ENTRY = Object.freeze({ id: 'id-1', raw: 'raw words', text: 'final words', mode: 'email', host: 'example.com', ts: 1000 });

let stored, usageLog, deps, handle;
beforeEach(() => {
  stored = freshSettings();
  stored.keys = { openai: 'sk-test-123456', gemini: '' };
  stored.modes.custom_1 = { name: 'Notes', icon: '📝', prompt: 'Bullet notes.', builtIn: false };
  usageLog = emptyLog();
  deps = {
    storage: {
      getSettings: vi.fn(async () => stored),
      updateSettings: vi.fn(async (fn) => {
        const next = fn(structuredClone(stored));
        if (next) stored = next;
        return stored;
      }),
      getUsageLog: vi.fn(async () => usageLog),
      setUsageLog: vi.fn(async (log) => { usageLog = log; }),
    },
    validateKey: vi.fn(async () => true),
    summarize: vi.fn(() => ({ today: 'today', last7Days: 'week', total: 'total' })),
    recorder: {
      start: vi.fn(async () => ({ ok: true })),
      stop: vi.fn(async () => ({ ok: true })),
      cancel: vi.fn(async () => ({ ok: true })),
      onLevel: vi.fn(),
      onDone: vi.fn(async () => {}),
      onOffscreenError: vi.fn(async () => {}),
      onPermissionResult: vi.fn(async () => {}),
      onFrameSight: vi.fn(),
      ping: vi.fn(async () => ({ alive: true })),
      sweep: vi.fn(async () => {}),
    },
    history: {
      list: vi.fn(async () => [ENTRY]),
      lastFor: vi.fn(async (host) => (host === ENTRY.host ? { ...ENTRY, edit: false } : null)),
      clear: vi.fn(async () => {}),
    },
    identify: vi.fn((sender) => sender?.kind ?? 'unknown'),
  };
  handle = createRouter(deps);
});
afterEach(() => vi.restoreAllMocks());

describe('senderKind', () => {
  const ids = { extensionId: 'abc', extensionOrigin: 'chrome-extension://abc', offscreenUrl: 'chrome-extension://abc/offscreen.html' };
  const rows = [
    ['offscreen document', { id: 'abc', origin: 'chrome-extension://abc', url: 'chrome-extension://abc/offscreen.html' }, 'offscreen'],
    ['offscreen document with a query', { id: 'abc', origin: 'chrome-extension://abc', url: 'chrome-extension://abc/offscreen.html?x=1' }, 'offscreen'],
    ['popup', { id: 'abc', origin: 'chrome-extension://abc', url: 'chrome-extension://abc/popup.html' }, 'extension'],
    ['permission page in a tab', { id: 'abc', origin: 'chrome-extension://abc', url: 'chrome-extension://abc/permission.html', tab: { id: 4 } }, 'extension'],
    ['extension page without a url', { id: 'abc', origin: 'chrome-extension://abc' }, 'extension'],
    ['content script', { id: 'abc', origin: 'https://example.com', url: 'https://example.com/', tab: { id: 4 }, frameId: 0 }, 'content'],
    ['content script in an opaque-origin frame', { id: 'abc', origin: 'null', tab: { id: 4 }, frameId: 2 }, 'content'],
    ['another extension', { id: 'evil', origin: 'chrome-extension://abc', url: 'chrome-extension://abc/offscreen.html' }, 'unknown'],
    ['another extension in a tab', { id: 'evil', origin: 'https://example.com', tab: { id: 4 } }, 'unknown'],
    ['page origin without a tab', { id: 'abc', origin: 'https://example.com' }, 'unknown'],
    ['tab without a numeric id', { id: 'abc', origin: 'https://example.com', tab: { id: '4' } }, 'unknown'],
    ['missing sender', undefined, 'unknown'],
  ];
  for (const [name, sender, kind] of rows) {
    it(`${name} is ${kind}`, () => {
      expect(senderKind(sender, ids)).toBe(kind);
    });
  }
});

describe('router access', () => {
  it('content cannot SAVE_SETTINGS, VALIDATE_KEY or CLEAR_USAGE', async () => {
    expect(await handle({ action: MSG.SAVE_SETTINGS, settings: { provider: 'gemini' } }, CONTENT)).toEqual(NOT_ALLOWED);
    expect(await handle({ action: MSG.VALIDATE_KEY, provider: 'openai', key: 'sk-x' }, CONTENT)).toEqual(NOT_ALLOWED);
    expect(await handle({ action: MSG.CLEAR_USAGE }, CONTENT)).toEqual(NOT_ALLOWED);
    expect(deps.storage.updateSettings).not.toHaveBeenCalled();
    expect(deps.validateKey).not.toHaveBeenCalled();
    expect(deps.storage.setUsageLog).not.toHaveBeenCalled();
    expect(deps.identify).toHaveBeenCalledWith(CONTENT);
  });

  it('content gets no keys from GET_SETTINGS; the popup gets them', async () => {
    const pub = await handle({ action: MSG.GET_SETTINGS }, CONTENT);
    expect(pub).not.toHaveProperty('keys');
    expect(pub.hasKey).toEqual({ openai: true, gemini: false });
    expect(pub.modes.custom_1.name).toBe('Notes');
    expect(JSON.stringify(pub)).not.toContain('sk-test');
    const full = await handle({ action: MSG.GET_SETTINGS }, POPUP);
    expect(full.keys.openai).toBe('sk-test-123456');
  });

  it('offscreen actions only from offscreen', async () => {
    for (const sender of [CONTENT, POPUP, STRANGER]) {
      expect(await handle({ action: MSG.OFFSCREEN_LEVEL, level: 0.5 }, sender)).toEqual(NOT_ALLOWED);
      expect(await handle({ action: MSG.OFFSCREEN_DONE, audioBase64: 'QUJD', mimeType: 'audio/webm', durationSec: 2, reason: 'user' }, sender)).toEqual(NOT_ALLOWED);
      expect(await handle({ action: MSG.OFFSCREEN_ERROR, error: 'x' }, sender)).toEqual(NOT_ALLOWED);
    }
    expect(deps.recorder.onLevel).not.toHaveBeenCalled();
    expect(deps.recorder.onDone).not.toHaveBeenCalled();
    expect(deps.recorder.onOffscreenError).not.toHaveBeenCalled();
  });

  it('recording actions only from content', async () => {
    for (const sender of [POPUP, OFFSCREEN, STRANGER]) {
      expect(await handle({ action: MSG.START_RECORDING }, sender)).toEqual(NOT_ALLOWED);
      expect(await handle({ action: MSG.STOP_RECORDING }, sender)).toEqual(NOT_ALLOWED);
      expect(await handle({ action: MSG.CANCEL_RECORDING }, sender)).toEqual(NOT_ALLOWED);
    }
    expect(deps.recorder.start).not.toHaveBeenCalled();
    expect(deps.recorder.stop).not.toHaveBeenCalled();
    expect(deps.recorder.cancel).not.toHaveBeenCalled();
  });

  it('PERMISSION_RESULT only from extension pages', async () => {
    expect(await handle({ action: MSG.PERMISSION_RESULT, granted: true }, CONTENT)).toEqual(NOT_ALLOWED);
    expect(await handle({ action: MSG.PERMISSION_RESULT, granted: true }, OFFSCREEN)).toEqual(NOT_ALLOWED);
    expect(deps.recorder.onPermissionResult).not.toHaveBeenCalled();
  });

  it('the offscreen document and unknown senders get no settings or usage', async () => {
    for (const sender of [OFFSCREEN, STRANGER]) {
      expect(await handle({ action: MSG.GET_SETTINGS }, sender)).toEqual(NOT_ALLOWED);
      expect(await handle({ action: MSG.UPDATE_SETTINGS, patch: { activeMode: 'email' } }, sender)).toEqual(NOT_ALLOWED);
      expect(await handle({ action: MSG.GET_USAGE }, sender)).toEqual(NOT_ALLOWED);
    }
    expect(deps.storage.getSettings).not.toHaveBeenCalled();
  });

  it('returns undefined for unknown actions, including inherited names', async () => {
    expect(await handle({ action: 'nope' }, POPUP)).toBeUndefined();
    expect(await handle({ action: 'constructor' }, POPUP)).toBeUndefined();
    expect(await handle({ action: 'transcribe' }, CONTENT)).toBeUndefined(); // removed v2.0 actions
    expect(await handle({ action: 'checkApiKey' }, CONTENT)).toBeUndefined();
    expect(await handle(undefined, POPUP)).toBeUndefined();
  });
});

describe('settings', () => {
  it('SAVE_SETTINGS { provider: gemini } keeps custom modes and both keys', async () => {
    stored.keys.gemini = 'AQ.gem-key';
    expect(await handle({ action: MSG.SAVE_SETTINGS, settings: { provider: 'gemini' } }, POPUP)).toEqual({ success: true });
    expect(stored.provider).toBe('gemini');
    expect(stored.modes.custom_1).toEqual({ name: 'Notes', icon: '📝', prompt: 'Bullet notes.', builtIn: false });
    expect(stored.keys).toEqual({ openai: 'sk-test-123456', gemini: 'AQ.gem-key' });
  });

  it('SAVE_SETTINGS merges string keys, so the popup can clear one', async () => {
    stored.keys.gemini = 'AQ.gem-key';
    await handle({ action: MSG.SAVE_SETTINGS, settings: { keys: { openai: '' } } }, POPUP);
    expect(stored.keys).toEqual({ openai: '', gemini: 'AQ.gem-key' });
    await handle({ action: MSG.SAVE_SETTINGS, settings: { keys: { openai: 42, gemini: null } } }, POPUP);
    expect(stored.keys).toEqual({ openai: '', gemini: 'AQ.gem-key' });
  });

  it('SAVE_SETTINGS runs migrateSettings over the merge and never the v1 path', async () => {
    await handle({ action: MSG.SAVE_SETTINGS, settings: { settingsVersion: 1, activeMode: 'missing' } }, POPUP);
    expect(stored.settingsVersion).toBe(SETTINGS_VERSION);
    expect(stored.activeMode).toBe('default');
    expect(stored.keys.openai).toBe('sk-test-123456');
  });

  it('SAVE_SETTINGS drops fields that are not settings, so they never reach a page', async () => {
    const settings = { provider: 'gemini', translateTargetLang: 'Greek', apiKey: 'sk-live-LEAK', draftKey: 'AQ.leak' };
    expect(await handle({ action: MSG.SAVE_SETTINGS, settings }, POPUP)).toEqual({ success: true });
    expect(stored.provider).toBe('gemini');
    expect(stored.translateTargetLang).toBe('Greek');
    expect(stored).not.toHaveProperty('apiKey');
    expect(stored).not.toHaveProperty('draftKey');
    const pub = await handle({ action: MSG.GET_SETTINGS }, CONTENT);
    expect(pub).not.toHaveProperty('apiKey');
    expect(pub).not.toHaveProperty('draftKey');
    expect(JSON.stringify(pub)).not.toMatch(/sk-live-LEAK|AQ\.leak/);
  });

  it('SAVE_SETTINGS rejects a missing or non-object payload without touching storage', async () => {
    for (const settings of [undefined, null, [], 'x']) {
      expect(await handle({ action: MSG.SAVE_SETTINGS, settings }, POPUP)).toEqual({ success: false, error: 'Invalid settings.' });
    }
    expect(deps.storage.updateSettings).not.toHaveBeenCalled();
  });

  describe('SAVE_SETTINGS through the real storage', () => {
    /** chrome.storage stand-in: values are cloned both ways, like the real structured-clone boundary. */
    function memoryArea(initial) {
      const store = structuredClone(initial);
      return {
        store,
        get: async (key) => ({ [key]: structuredClone(store[key]) }),
        set: async (items) => { Object.assign(store, structuredClone(items)); },
      };
    }
    function routerOver(area) {
      return createRouter({ ...deps, storage: createStorage(area) });
    }

    it('a dictionary patch stores both groups and keeps the stored key', async () => {
      const area = memoryArea({ settings: stored });
      const save = routerOver(area);
      expect(await save({ action: MSG.SAVE_SETTINGS, settings: { dictionary: { any: ['A'], el: ['B'] } } }, POPUP)).toEqual({ success: true });
      expect(area.store.settings.dictionary).toEqual({ any: ['A'], el: ['B'] });
      expect(area.store.settings.keys).toEqual({ openai: 'sk-test-123456', gemini: '' });
    });

    it('saving modes without a custom mode clears it from site rules', async () => {
      stored.siteRules = {
        'a.com': { hidePill: true, mode: 'custom_1' },
        'b.com': { hidePill: false, mode: 'custom_1' },
      };
      const area = memoryArea({ settings: stored });
      const save = routerOver(area);
      const { custom_1: _removed, ...modes } = stored.modes;
      expect(await save({ action: MSG.SAVE_SETTINGS, settings: { modes } }, POPUP)).toEqual({ success: true });
      expect(area.store.settings.modes).not.toHaveProperty('custom_1');
      expect(area.store.settings.siteRules).toEqual({ 'a.com': { hidePill: true, mode: null } });
    });

    it('a payload with siteRules leaves the stored rules alone and saves its other fields', async () => {
      stored.siteRules = { 'new.com': { hidePill: true, mode: 'email' } };
      const area = memoryArea({ settings: stored });
      const save = routerOver(area);
      const payload = { siteRules: { 'old.com': { hidePill: true, mode: null } }, pillStyle: 'minimal', sounds: true };
      expect(await save({ action: MSG.SAVE_SETTINGS, settings: payload }, POPUP)).toEqual({ success: true });
      expect(area.store.settings.siteRules).toEqual({ 'new.com': { hidePill: true, mode: 'email' } });
      expect(area.store.settings.pillStyle).toBe('minimal');
      expect(area.store.settings.sounds).toBe(true);
    });

    it('deleting a custom mode repairs the stored rules, not the rules in the payload', async () => {
      stored.siteRules = {
        'a.com': { hidePill: true, mode: 'custom_1' },
        'b.com': { hidePill: false, mode: 'custom_1' },
      };
      const area = memoryArea({ settings: stored });
      const save = routerOver(area);
      const { custom_1: _removed, ...modes } = stored.modes;
      const payload = { modes, siteRules: { 'old.com': { hidePill: true, mode: 'email' } } };
      expect(await save({ action: MSG.SAVE_SETTINGS, settings: payload }, POPUP)).toEqual({ success: true });
      expect(area.store.settings.modes).not.toHaveProperty('custom_1');
      expect(area.store.settings.siteRules).toEqual({ 'a.com': { hidePill: true, mode: null } });
    });
  });

  it('UPDATE_SETTINGS applies whitelisted fields from content', async () => {
    expect(await handle({ action: MSG.UPDATE_SETTINGS, patch: { activeMode: 'custom_1', translateTargetLang: 'Greek' } }, CONTENT)).toEqual({ success: true });
    expect(stored.activeMode).toBe('custom_1');
    expect(stored.translateTargetLang).toBe('Greek');
    expect(stored.keys.openai).toBe('sk-test-123456');
    expect(await handle({ action: MSG.UPDATE_SETTINGS, patch: { provider: 'gemini' } }, POPUP)).toEqual({ success: true });
    expect(stored.provider).toBe('gemini');
  });

  it('UPDATE_SETTINGS rejects anything outside the whitelist and writes nothing', async () => {
    const before = stored;
    expect(await handle({ action: MSG.UPDATE_SETTINGS, patch: { keys: { openai: 'sk-evil' } } }, CONTENT)).toEqual({ success: false, error: 'Invalid settings.' });
    expect(await handle({ action: MSG.UPDATE_SETTINGS, patch: { activeMode: 'email', modes: {} } }, CONTENT)).toEqual({ success: false, error: 'Invalid settings.' });
    expect(await handle({ action: MSG.UPDATE_SETTINGS, patch: null }, CONTENT)).toEqual({ success: false, error: 'Invalid settings.' });
    const unknownMode = await handle({ action: MSG.UPDATE_SETTINGS, patch: { activeMode: 'missing' } }, CONTENT);
    expect(unknownMode.success).toBe(false);
    expect(typeof unknownMode.error).toBe('string');
    expect(stored).toBe(before);
  });
});

describe('keys and usage', () => {
  it('validates a key and maps failures to friendly text', async () => {
    expect(await handle({ action: MSG.VALIDATE_KEY, provider: 'openai', key: 'sk-x' }, POPUP)).toEqual({ ok: true });
    expect(deps.validateKey).toHaveBeenCalledWith('openai', 'sk-x');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.validateKey.mockRejectedValueOnce(new ProviderError('OpenAI rejected the API key.', { code: 'auth' }));
    expect(await handle({ action: MSG.VALIDATE_KEY, provider: 'openai', key: 'sk-bad' }, POPUP)).toEqual({ ok: false, error: 'OpenAI rejected the API key.' });
  });

  it('warns about a failed key check with any key redacted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.validateKey.mockRejectedValueOnce(new ProviderError('Upstream echoed sk-abc123456 back'));
    await handle({ action: MSG.VALIDATE_KEY, provider: 'openai', key: 'sk-abc123456' }, POPUP);
    expect(warn).toHaveBeenCalledWith('VoiceType: ProviderError: Upstream echoed [key] back');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('sk-abc');
  });

  it('reports a key check timeout as a key check timeout', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.validateKey.mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'));
    expect(await handle({ action: MSG.VALIDATE_KEY, provider: 'gemini', key: 'AQ.x' }, POPUP)).toEqual({ ok: false, error: 'Key check timed out. Try again.' });
    deps.validateKey.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    expect(await handle({ action: MSG.VALIDATE_KEY, provider: 'gemini', key: 'AQ.x' }, POPUP)).toEqual({ ok: false, error: 'Key check timed out. Try again.' });
  });

  it('GET_USAGE returns the summary of the stored log to the popup and content', async () => {
    usageLog.total.sessions = 3;
    expect(await handle({ action: MSG.GET_USAGE }, POPUP)).toEqual({ today: 'today', last7Days: 'week', total: 'total' });
    expect(deps.summarize).toHaveBeenCalledWith(usageLog);
    expect(await handle({ action: MSG.GET_USAGE }, CONTENT)).toEqual({ today: 'today', last7Days: 'week', total: 'total' });
  });

  it('CLEAR_USAGE writes an empty log', async () => {
    usageLog.total.sessions = 3;
    expect(await handle({ action: MSG.CLEAR_USAGE }, POPUP)).toEqual({ success: true });
    expect(deps.storage.setUsageLog).toHaveBeenCalledTimes(1);
    expect(usageLog).toEqual(emptyLog());
  });
});

describe('history', () => {
  /** A sender as Chrome reports it. `tab.url` is the top page whatever frame sends; `origin` and `url` are the frame's. */
  const pageOf = (topUrl, { origin = topUrl && new URL(topUrl).origin, url = topUrl, incognito } = {}) => (
    { kind: 'content', origin, url, tab: { id: 7, url: topUrl, ...(incognito === undefined ? {} : { incognito }) }, frameId: 3 });

  it('GET_LAST_DICTATION answers from the sender tab host only', async () => {
    expect(await handle({ action: MSG.GET_LAST_DICTATION, host: 'other.com' }, pageOf('https://www.example.com/page'))).toEqual({ entry: { raw: 'raw words', text: 'final words', edit: false } });
    expect(deps.history.lastFor).toHaveBeenCalledTimes(1);
    expect(deps.history.lastFor).toHaveBeenCalledWith('example.com');
    expect(await handle({ action: MSG.GET_LAST_DICTATION, host: 'example.com' }, pageOf('https://other.com/'))).toEqual({ entry: null });
  });

  it.each([['a chrome page', 'chrome://settings/'], ['a file page', 'file:///home/a.html'], ['no url', undefined]])('GET_LAST_DICTATION is null with no host: %s', async (_name, url) => {
    expect(await handle({ action: MSG.GET_LAST_DICTATION }, pageOf(url))).toEqual({ entry: null });
    expect(deps.history.lastFor).toHaveBeenCalledWith(null);
  });

  describe('a frame reads its own site alone (V28)', () => {
    const FIRST_PARTY = 'https://example.com/page';
    const ANSWER = { entry: { raw: 'raw words', text: 'final words', edit: false } };
    const rows = [
      ['a same-site frame', pageOf(FIRST_PARTY, { url: 'https://example.com/frame' }), ANSWER],
      ['www and bare host are one site', pageOf('https://www.example.com/', { origin: 'https://example.com' }), ANSWER],
      ['http and https are one site', pageOf(FIRST_PARTY, { origin: 'http://example.com' }), ANSWER],
      ['an about:blank frame inherits its creator', pageOf(FIRST_PARTY, { url: 'about:blank' }), ANSWER],
      ['a third-party frame on the first party', pageOf(FIRST_PARTY, { origin: 'https://widget.com', url: 'https://widget.com/embed' }), { entry: null }],
      ['a subdomain frame', pageOf(FIRST_PARTY, { origin: 'https://mail.example.com', url: 'https://mail.example.com/' }), { entry: null }],
      ['an about:blank frame made by a third party', pageOf(FIRST_PARTY, { origin: 'https://widget.com', url: 'about:blank' }), { entry: null }],
      ['the first party framed by another site', pageOf('https://widget.com/', { origin: 'https://example.com', url: FIRST_PARTY }), { entry: null }],
      ['an opaque origin', pageOf(FIRST_PARTY, { origin: 'null', url: 'about:srcdoc' }), { entry: null }],
      ['no origin', { kind: 'content', url: FIRST_PARTY, tab: { id: 7, url: FIRST_PARTY }, frameId: 3 }, { entry: null }],
    ];
    it.each(rows)('%s', async (_name, sender, reply) => {
      expect(await handle({ action: MSG.GET_LAST_DICTATION }, sender)).toEqual(reply);
    });

    it('a third-party frame asks for no site at all', async () => {
      await handle({ action: MSG.GET_LAST_DICTATION }, pageOf(FIRST_PARTY, { origin: 'https://widget.com' }));
      expect(deps.history.lastFor).toHaveBeenCalledWith(null);
    });

    it('an opaque origin is no site even on a page whose host reads null', async () => {
      await handle({ action: MSG.GET_LAST_DICTATION }, pageOf('http://null/', { origin: 'null' }));
      expect(deps.history.lastFor).toHaveBeenCalledWith(null);
    });
  });

  describe('START_RECORDING gives the recorder the frame site (V26)', () => {
    const TOP = 'https://www.example.com/page';
    const started = async (sender) => {
      await handle({ action: MSG.START_RECORDING }, sender);
      return deps.recorder.start.mock.calls[0];
    };

    it('a first-party frame records under its site', async () => {
      expect(await started(pageOf(TOP))).toEqual([{ tabId: 7, frameId: 3 }, TOP, { host: 'example.com', incognito: false }]);
    });

    it('a third-party frame records under no site, and the rule still reads the top page', async () => {
      const sender = pageOf(TOP, { origin: 'https://widget.com', url: 'https://widget.com/embed' });
      expect(await started(sender)).toEqual([{ tabId: 7, frameId: 3 }, TOP, { host: null, incognito: false }]);
    });

    it('an about:blank editor records under the site that made it', async () => {
      expect((await started(pageOf(TOP, { url: 'about:blank' })))[2].host).toBe('example.com');
    });

    it('reports an incognito tab', async () => {
      expect((await started(pageOf(TOP, { incognito: true })))[2].incognito).toBe(true);
    });

    it('anything but true is not incognito', async () => {
      expect((await started(pageOf(TOP, { incognito: 'yes' })))[2].incognito).toBe(false);
    });
  });

  it('GET_LAST_DICTATION marks an edit', async () => {
    deps.history.lastFor.mockResolvedValueOnce({ ...ENTRY, edit: true });
    expect((await handle({ action: MSG.GET_LAST_DICTATION }, pageOf('https://example.com/'))).entry.edit).toBe(true);
  });

  it('GET_LAST_DICTATION returns raw, text and edit alone', async () => {
    const { entry } = await handle({ action: MSG.GET_LAST_DICTATION }, pageOf('https://example.com/'));
    expect(Object.keys(entry).sort()).toEqual(['edit', 'raw', 'text']);
  });

  it('GET_LAST_DICTATION is for content senders', async () => {
    for (const sender of [POPUP, OFFSCREEN, STRANGER]) {
      expect(await handle({ action: MSG.GET_LAST_DICTATION }, sender)).toEqual(NOT_ALLOWED);
    }
    expect(deps.history.lastFor).not.toHaveBeenCalled();
  });

  it('GET_HISTORY gives extension pages every entry', async () => {
    expect(await handle({ action: MSG.GET_HISTORY }, POPUP)).toEqual({ entries: [ENTRY] });
  });

  it('CLEAR_HISTORY clears for extension pages', async () => {
    expect(await handle({ action: MSG.CLEAR_HISTORY }, POPUP)).toEqual({ success: true });
    expect(deps.history.clear).toHaveBeenCalledTimes(1);
  });

  it('GET_HISTORY and CLEAR_HISTORY refuse content senders', async () => {
    for (const sender of [pageOf('https://example.com/'), OFFSCREEN, STRANGER]) {
      expect(await handle({ action: MSG.GET_HISTORY }, sender)).toEqual(NOT_ALLOWED);
      expect(await handle({ action: MSG.CLEAR_HISTORY }, sender)).toEqual(NOT_ALLOWED);
    }
    expect(deps.history.list).not.toHaveBeenCalled();
    expect(deps.history.clear).not.toHaveBeenCalled();
  });

  it('a save through SAVE_SETTINGS can turn keepHistory off, a content patch cannot', async () => {
    expect(await handle({ action: MSG.SAVE_SETTINGS, settings: { keepHistory: false } }, POPUP)).toEqual({ success: true });
    expect(stored.keepHistory).toBe(false);
    expect(await handle({ action: MSG.UPDATE_SETTINGS, patch: { keepHistory: true } }, CONTENT)).toEqual({ success: false, error: 'Invalid settings.' });
    expect(stored.keepHistory).toBe(false);
  });

  it('a page reads no keepHistory from GET_SETTINGS', async () => {
    expect(await handle({ action: MSG.GET_SETTINGS }, CONTENT)).not.toHaveProperty('keepHistory');
  });
});

describe('START_RECORDING with edit text', () => {
  const SELECTED = 'the selected words';

  it('hands the text to the recorder', async () => {
    expect(await handle({ action: MSG.START_RECORDING, edit: { text: SELECTED } }, CONTENT)).toEqual({ ok: true });
    expect(deps.recorder.start.mock.calls[0][2]).toMatchObject({ editText: SELECTED });
  });

  it('takes a selection of exactly MAX_EDIT_CHARS', async () => {
    const text = 'x'.repeat(MAX_EDIT_CHARS);
    await handle({ action: MSG.START_RECORDING, edit: { text } }, CONTENT);
    expect(deps.recorder.start.mock.calls[0][2].editText).toBe(text);
  });

  it('a dictation has no edit text', async () => {
    await handle({ action: MSG.START_RECORDING }, CONTENT);
    expect(deps.recorder.start.mock.calls[0][2].editText ?? null).toBeNull();
  });

  it.each([
    ['a number', { text: 7 }],
    ['an array', { text: ['a'] }],
    ['null text', { text: null }],
    ['no text', {}],
    ['a bare string', 'text'],
    ['null', null],
    ['empty', { text: '' }],
    ['over MAX_EDIT_CHARS', { text: 'x'.repeat(MAX_EDIT_CHARS + 1) }],
  ])('START_RECORDING refuses edit text that is not a string, empty or over MAX_EDIT_CHARS with reason badEdit: %s', async (_name, edit) => {
    const reply = await handle({ action: MSG.START_RECORDING, edit }, CONTENT);
    expect(reply).toEqual({ ok: false, reason: 'badEdit', error: expect.any(String) });
    expect(reply.error).not.toContain('xxx');
    expect(deps.recorder.start).not.toHaveBeenCalled();
  });

  it.each([['the popup', POPUP], ['the offscreen document', OFFSCREEN], ['a stranger', STRANGER]])('an extension sender cannot start: %s', async (_name, sender) => {
    expect(await handle({ action: MSG.START_RECORDING, edit: { text: SELECTED } }, sender)).toEqual(NOT_ALLOWED);
    expect(deps.recorder.start).not.toHaveBeenCalled();
  });
});

describe('recorder delegation', () => {
  it('recording actions go to the recorder with the sender frame as the endpoint', async () => {
    deps.recorder.start.mockResolvedValueOnce({ ok: false, reason: 'busy', error: 'VoiceType is busy in another tab. Try again in a moment.' });
    expect(await handle({ action: MSG.START_RECORDING }, CONTENT)).toEqual({ ok: false, reason: 'busy', error: 'VoiceType is busy in another tab. Try again in a moment.' });
    expect(deps.recorder.start).toHaveBeenCalledWith({ tabId: 7, frameId: 3 }, undefined, { host: null, incognito: false });
    expect(await handle({ action: MSG.STOP_RECORDING }, TOP_FRAME)).toEqual({ ok: true });
    expect(deps.recorder.stop).toHaveBeenCalledWith({ tabId: 7, frameId: 0 });
    expect(await handle({ action: MSG.CANCEL_RECORDING }, CONTENT)).toEqual({ ok: true });
    expect(deps.recorder.cancel).toHaveBeenCalledWith({ tabId: 7, frameId: 3 });
  });

  it('endpointOf carries sender.documentId', async () => {
    const sender = { ...CONTENT, documentId: 'DOC' };
    const endpoint = { tabId: 7, frameId: 3, documentId: 'DOC' };
    await handle({ action: MSG.START_RECORDING }, sender);
    expect(deps.recorder.start.mock.calls[0][0]).toStrictEqual(endpoint);
    await handle({ action: MSG.STOP_RECORDING }, sender);
    expect(deps.recorder.stop.mock.calls[0][0]).toStrictEqual(endpoint);
    await handle({ action: MSG.CANCEL_RECORDING }, sender);
    expect(deps.recorder.cancel.mock.calls[0][0]).toStrictEqual(endpoint);
    await handle({ action: MSG.FRAME_SIGHT, seen: true }, sender);
    expect(deps.recorder.onFrameSight.mock.calls[0][0]).toStrictEqual(endpoint);
  });

  it('PROCESSING_PING is content only', async () => {
    for (const sender of [POPUP, OFFSCREEN, STRANGER]) {
      expect(await handle({ action: MSG.PROCESSING_PING }, sender)).toEqual(NOT_ALLOWED);
    }
    expect(deps.recorder.ping).not.toHaveBeenCalled();
    deps.recorder.ping.mockResolvedValueOnce({ alive: false });
    expect(await handle({ action: MSG.PROCESSING_PING }, { ...CONTENT, documentId: 'DOC' })).toEqual({ alive: false });
    expect(deps.recorder.ping.mock.calls[0][0]).toStrictEqual({ tabId: 7, frameId: 3, documentId: 'DOC' });
  });

  it('every message sweeps, before it is handled and whoever sent it (V53)', async () => {
    await handle({ action: MSG.GET_SETTINGS }, POPUP);
    expect(deps.recorder.sweep).toHaveBeenCalledTimes(1);
    await handle({ action: MSG.GET_SETTINGS }, STRANGER);
    expect(deps.recorder.sweep).toHaveBeenCalledTimes(2);
    await handle({ action: 'noSuchAction' }, POPUP);
    expect(deps.recorder.sweep).toHaveBeenCalledTimes(3);
    await handle({ action: MSG.PROCESSING_PING }, CONTENT);
    expect(deps.recorder.sweep.mock.invocationCallOrder[3]).toBeLessThan(deps.recorder.ping.mock.invocationCallOrder[0]);
  });

  it('offscreen events go to the recorder with their capture id and are acknowledged', async () => {
    expect(await handle({ action: MSG.OFFSCREEN_LEVEL, level: 0.5, captureId: 'c1' }, OFFSCREEN)).toEqual({ ok: true });
    expect(deps.recorder.onLevel).toHaveBeenCalledWith(0.5, 'c1');
    const done = { audioBase64: 'QUJD', mimeType: 'audio/webm', durationSec: 2.5, reason: 'silence', captureId: 'c1' };
    expect(await handle({ action: MSG.OFFSCREEN_DONE, ...done }, OFFSCREEN)).toEqual({ ok: true });
    expect(deps.recorder.onDone).toHaveBeenCalledWith(done);
    expect(await handle({ action: MSG.OFFSCREEN_ERROR, error: 'Recording failed.', captureId: 'c1' }, OFFSCREEN)).toEqual({ ok: true });
    expect(deps.recorder.onOffscreenError).toHaveBeenCalledWith({ error: 'Recording failed.', captureId: 'c1' });
  });

  it('an empty capture report keeps its flag and duration, unchecked', async () => {
    const report = { error: 'Recording failed.', captureId: 'c1', empty: true, durationSec: 0.05 };
    expect(await handle({ action: MSG.OFFSCREEN_ERROR, ...report }, OFFSCREEN)).toEqual({ ok: true });
    expect(deps.recorder.onOffscreenError).toHaveBeenLastCalledWith(report);
    const odd = { error: 'x', captureId: 'c1', empty: 'yes', durationSec: '0.05' };
    await handle({ action: MSG.OFFSCREEN_ERROR, ...odd }, OFFSCREEN);
    expect(deps.recorder.onOffscreenError).toHaveBeenLastCalledWith(odd);
  });

  it('the permission page result goes to the recorder as a boolean', async () => {
    expect(await handle({ action: MSG.PERMISSION_RESULT, granted: true }, POPUP)).toEqual({ ok: true });
    expect(deps.recorder.onPermissionResult).toHaveBeenLastCalledWith({ granted: true });
    await handle({ action: MSG.PERMISSION_RESULT, granted: 'yes' }, POPUP);
    expect(deps.recorder.onPermissionResult).toHaveBeenLastCalledWith({ granted: false });
  });

  it('a frame reporting its sight goes to the recorder as a boolean', async () => {
    expect(await handle({ action: MSG.FRAME_SIGHT, seen: true }, CONTENT)).toEqual({ ok: true });
    expect(deps.recorder.onFrameSight).toHaveBeenLastCalledWith({ tabId: 7, frameId: 3 }, true);
    for (const seen of [false, 'yes', 1, undefined]) {
      expect(await handle({ action: MSG.FRAME_SIGHT, seen }, CONTENT)).toEqual({ ok: true });
      expect(deps.recorder.onFrameSight).toHaveBeenLastCalledWith({ tabId: 7, frameId: 3 }, false);
    }
  });

  it('only content may report its sight', async () => {
    for (const sender of [POPUP, OFFSCREEN, STRANGER]) {
      expect(await handle({ action: MSG.FRAME_SIGHT, seen: true }, sender)).toEqual(NOT_ALLOWED);
    }
    expect(deps.recorder.onFrameSight).not.toHaveBeenCalled();
  });

  it('the mirror message is no router action', async () => {
    expect(await handle({ action: MSG.RECORDING_MIRROR, state: 'idle', elapsedMs: 0 }, CONTENT)).toBeUndefined();
  });
});

describe('site rules', () => {
  const ON_A = { kind: 'content', tab: { id: 7, url: 'https://www.a.com/x' } };
  const ON_NEW_TAB = { kind: 'content', tab: { id: 7, url: 'chrome://newtab/' } };
  const NO_URL = { kind: 'content', tab: { id: 7 } };
  const INVALID = { success: false, error: 'Invalid settings.' };
  const OK = { success: true };

  beforeEach(() => {
    stored.siteRules = {
      'a.com': { hidePill: true, mode: 'email' },
      'b.com': { hidePill: false, mode: 'custom_1' },
    };
  });

  it('content GET_SETTINGS carries only its own site', async () => {
    const reply = await handle({ action: MSG.GET_SETTINGS }, ON_A);
    expect(reply.site).toEqual({ hidePill: true, mode: 'email' });
    expect(JSON.stringify(reply)).not.toContain('b.com');
    expect(JSON.stringify(reply)).not.toContain('siteRules');
    expect(reply).not.toHaveProperty('keys');
  });

  it('a page with no rule gets the empty rule', async () => {
    const reply = await handle({ action: MSG.GET_SETTINGS }, { kind: 'content', tab: { id: 7, url: 'https://c.com/' } });
    expect(reply.site).toEqual({ hidePill: false, mode: null });
    expect((await handle({ action: MSG.GET_SETTINGS }, NO_URL)).site).toEqual({ hidePill: false, mode: null });
  });

  it('a frame gets the rule of the top-level page', async () => {
    const frame = { kind: 'content', url: 'https://frame.test/', tab: { id: 7, url: 'https://a.com/' } };
    expect((await handle({ action: MSG.GET_SETTINGS }, frame)).site).toEqual({ hidePill: true, mode: 'email' });
  });

  it('the settings page gets no site field', async () => {
    const reply = await handle({ action: MSG.GET_SETTINGS }, POPUP);
    expect(reply).not.toHaveProperty('site');
    expect(reply).toBe(stored);
  });

  it('SET_SITE_MODE updates the sender\'s rule, keeps hidePill, and ignores a host in the request', async () => {
    const reply = await handle({ action: MSG.SET_SITE_MODE, mode: 'custom_1', host: 'b.com' }, ON_A);
    expect(reply).toEqual(OK);
    expect(stored.siteRules).toEqual({
      'a.com': { hidePill: true, mode: 'custom_1' },
      'b.com': { hidePill: false, mode: 'custom_1' },
    });
  });

  it('SET_SITE_MODE creates a rule on a site without one', async () => {
    const onC = { kind: 'content', tab: { id: 7, url: 'https://c.com/' } };
    expect(await handle({ action: MSG.SET_SITE_MODE, mode: 'email' }, onC)).toEqual(OK);
    expect(stored.siteRules['c.com']).toEqual({ hidePill: false, mode: 'email' });
  });

  it('a frame sets the mode of the top-level page', async () => {
    const frame = { kind: 'content', url: 'https://b.com/', tab: { id: 7, url: 'https://a.com/' } };
    expect(await handle({ action: MSG.SET_SITE_MODE, mode: 'custom_1' }, frame)).toEqual(OK);
    expect(stored.siteRules).toEqual({
      'a.com': { hidePill: true, mode: 'custom_1' },
      'b.com': { hidePill: false, mode: 'custom_1' },
    });
  });

  it('SET_SITE_MODE null clears the mode and deletes a rule that no longer hides', async () => {
    const onB = { kind: 'content', tab: { id: 7, url: 'https://b.com/' } };
    expect(await handle({ action: MSG.SET_SITE_MODE, mode: null }, onB)).toEqual(OK);
    expect(stored.siteRules).toEqual({ 'a.com': { hidePill: true, mode: 'email' } });
  });

  it('SET_SITE_MODE null keeps a rule that hides the pill', async () => {
    expect(await handle({ action: MSG.SET_SITE_MODE, mode: null }, ON_A)).toEqual(OK);
    expect(stored.siteRules['a.com']).toEqual({ hidePill: true, mode: null });
  });

  it('SET_SITE_MODE refuses an unknown mode and writes nothing', async () => {
    const before = stored;
    for (const mode of ['nope', '__proto__', 'constructor', 5, undefined, true, ['email']]) {
      expect(await handle({ action: MSG.SET_SITE_MODE, mode }, ON_A)).toEqual(INVALID);
    }
    expect(stored).toBe(before);
  });

  it('SET_SITE_MODE refuses a tab with no usable URL and writes nothing', async () => {
    const before = stored;
    const refused = { success: false, error: 'Not available on this page.' };
    expect(await handle({ action: MSG.SET_SITE_MODE, mode: 'email' }, NO_URL)).toEqual(refused);
    expect(await handle({ action: MSG.SET_SITE_MODE, mode: 'email', host: 'a.com' }, ON_NEW_TAB)).toEqual(refused);
    expect(stored).toBe(before);
  });

  const accessRows = [
    ['SET_SITE_MODE', 'extension', { action: MSG.SET_SITE_MODE, mode: 'email', host: 'b.com' }, POPUP],
    ['SET_SITE_MODE', 'offscreen', { action: MSG.SET_SITE_MODE, mode: 'email', host: 'b.com' }, OFFSCREEN],
    ['SET_SITE_MODE', 'unknown', { action: MSG.SET_SITE_MODE, mode: 'email', host: 'b.com' }, STRANGER],
    ['SET_SITE_RULE', 'content', { action: MSG.SET_SITE_RULE, host: 'b.com', hidePill: true, mode: null }, ON_A],
    ['SET_SITE_RULE', 'offscreen', { action: MSG.SET_SITE_RULE, host: 'b.com', hidePill: true, mode: null }, OFFSCREEN],
    ['SET_SITE_RULE', 'unknown', { action: MSG.SET_SITE_RULE, host: 'b.com', hidePill: true, mode: null }, STRANGER],
  ];
  for (const [name, kind, request, sender] of accessRows) {
    it(`${name} from ${kind} is not allowed`, async () => {
      const before = stored;
      expect(await handle(request, sender)).toEqual(NOT_ALLOWED);
      expect(stored).toBe(before);
    });
  }

  it('SET_SITE_RULE normalizes the host', async () => {
    stored.siteRules = {};
    expect(await handle({ action: MSG.SET_SITE_RULE, host: 'https://WWW.A.com/x', hidePill: true, mode: null }, POPUP)).toEqual(OK);
    expect(stored.siteRules).toEqual({ 'a.com': { hidePill: true, mode: null } });
  });

  it('SET_SITE_RULE replaces the whole rule', async () => {
    expect(await handle({ action: MSG.SET_SITE_RULE, host: 'a.com', hidePill: false, mode: 'custom_1' }, POPUP)).toEqual(OK);
    expect(stored.siteRules['a.com']).toEqual({ hidePill: false, mode: 'custom_1' });
  });

  it('SET_SITE_RULE deletes an empty rule', async () => {
    expect(await handle({ action: MSG.SET_SITE_RULE, host: 'a.com', hidePill: false, mode: null }, POPUP)).toEqual(OK);
    expect(stored.siteRules).toEqual({ 'b.com': { hidePill: false, mode: 'custom_1' } });
  });

  it('SET_SITE_RULE without a mode keeps the stored mode', async () => {
    stored.siteRules = { 'a.com': { hidePill: false, mode: 'email' } };
    expect(await handle({ action: MSG.SET_SITE_RULE, host: 'a.com', hidePill: true }, POPUP)).toEqual(OK);
    expect(stored.siteRules['a.com']).toEqual({ hidePill: true, mode: 'email' });
  });

  it('SET_SITE_RULE without hidePill keeps the stored hidePill', async () => {
    stored.siteRules = { 'a.com': { hidePill: true, mode: 'email' } };
    expect(await handle({ action: MSG.SET_SITE_RULE, host: 'a.com', mode: 'custom_1' }, POPUP)).toEqual(OK);
    expect(stored.siteRules['a.com']).toEqual({ hidePill: true, mode: 'custom_1' });
  });

  it('SET_SITE_RULE with one field on a host with no rule starts from the empty rule', async () => {
    stored.siteRules = {};
    expect(await handle({ action: MSG.SET_SITE_RULE, host: 'a.com', hidePill: true }, POPUP)).toEqual(OK);
    expect(await handle({ action: MSG.SET_SITE_RULE, host: 'b.com', mode: 'email' }, POPUP)).toEqual(OK);
    expect(stored.siteRules).toEqual({ 'a.com': { hidePill: true, mode: null }, 'b.com': { hidePill: false, mode: 'email' } });
  });

  it('SET_SITE_RULE with one field reads no inherited rule for a __proto__ host', async () => {
    stored.siteRules = {};
    expect(await handle({ action: MSG.SET_SITE_RULE, host: '__proto__', hidePill: true }, POPUP)).toEqual(OK);
    expect(Object.entries(stored.siteRules)).toEqual([['__proto__', { hidePill: true, mode: null }]]);
  });

  it.each([
    ['hidePill', { hidePill: true, mode: null }, { hidePill: false }],
    ['mode', { hidePill: false, mode: 'email' }, { mode: null }],
  ])('SET_SITE_RULE deletes a rule that one field leaves empty: %s', async (_name, rule, field) => {
    stored.siteRules = { 'a.com': rule };
    expect(await handle({ action: MSG.SET_SITE_RULE, host: 'a.com', ...field }, POPUP)).toEqual(OK);
    expect(stored.siteRules).toEqual({});
  });

  it('a stale control cannot overwrite a newer mode (V18)', async () => {
    stored.siteRules = {};
    await handle({ action: MSG.SET_SITE_RULE, host: 'a.com', mode: 'email' }, POPUP);
    // The select stays on email while the pill moves the site on, and then Hide pill changes.
    await handle({ action: MSG.SET_SITE_MODE, mode: 'custom_1' }, ON_A);
    expect(await handle({ action: MSG.SET_SITE_RULE, host: 'a.com', hidePill: true }, POPUP)).toEqual(OK);
    expect(stored.siteRules['a.com']).toEqual({ hidePill: true, mode: 'custom_1' });
  });

  it('SET_SITE_RULE refuses a bad host, hidePill or mode and writes nothing', async () => {
    const before = stored;
    const rows = [
      { host: 'mailto:a@b.com', hidePill: true, mode: null },
      { host: 5, hidePill: true, mode: null },
      { hidePill: true, mode: null },
      { host: 'a.com', hidePill: 'yes', mode: null },
      { host: 'a.com', hidePill: null },
      { host: 'a.com', hidePill: 'yes' },
      { host: 'a.com', hidePill: true, mode: 'nope' },
      { host: 'a.com', hidePill: true, mode: '__proto__' },
      { host: 'a.com', mode: 'nope' },
      { host: 'a.com', mode: 5 },
      { host: 'a.com' },
      { host: 'a.com', hidePill: undefined, mode: undefined },
    ];
    for (const row of rows) expect(await handle({ action: MSG.SET_SITE_RULE, ...row }, POPUP)).toEqual(INVALID);
    expect(stored).toBe(before);
  });

  it('an old payload cannot write rules through UPDATE_SETTINGS', async () => {
    const before = stored;
    expect(await handle({ action: MSG.UPDATE_SETTINGS, patch: { siteRules: {} } }, ON_A)).toEqual(INVALID);
    expect(stored).toBe(before);
  });

  it('START_RECORDING passes the tab URL to the recorder', async () => {
    const frame = { kind: 'content', url: 'https://frame.test/', tab: { id: 7, url: 'https://a.com/x' }, frameId: 3 };
    await handle({ action: MSG.START_RECORDING }, frame);
    expect(deps.recorder.start).toHaveBeenCalledWith({ tabId: 7, frameId: 3 }, 'https://a.com/x', expect.anything());
  });
});

describe('createValidateKey', () => {
  it('calls the provider adapter with the key and a timeout signal', async () => {
    const adapters = { openai: { validateKey: vi.fn(async () => true) }, gemini: { validateKey: vi.fn() } };
    await createValidateKey(adapters)('openai', 'sk-x');
    expect(adapters.openai.validateKey).toHaveBeenCalledWith({ key: 'sk-x', signal: expect.any(AbortSignal) });
    expect(adapters.gemini.validateKey).not.toHaveBeenCalled();
  });

  it('rejects inherited names such as constructor without calling an adapter', async () => {
    const adapters = { openai: { validateKey: vi.fn() }, gemini: { validateKey: vi.fn() } };
    const validate = createValidateKey(adapters);
    await expect(validate('constructor', 'k')).rejects.toThrow('Unknown provider.');
    await expect(validate('__proto__', 'k')).rejects.toBeInstanceOf(ProviderError);
    expect(adapters.openai.validateKey).not.toHaveBeenCalled();
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
