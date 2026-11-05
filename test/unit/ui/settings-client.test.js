import { describe, it, expect, vi } from 'vitest';
import { changedFields, createSettingsClient } from '../../../src/ui/settings-client.js';
import { freshSettings } from '../../../src/shared/defaults.js';
import { MSG, SAVE_PORT } from '../../../src/shared/messages.js';

function withKeys() {
  const s = freshSettings();
  s.keys = { openai: 'sk-a', gemini: 'AQ.b' };
  return s;
}

/** Reverse the key order of an object, recursively, so only the order differs. */
function reversed(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.keys(value).reverse().map((k) => [k, reversed(value[k])]));
}

/** A stand-in for a runtime port: `answer` plays the worker's reply, `drop` a disconnect. */
function fakePort() {
  const received = [];
  const gone = [];
  return {
    postMessage: vi.fn(),
    onMessage: { addListener: (fn) => received.push(fn) },
    onDisconnect: { addListener: (fn) => gone.push(fn) },
    answer(reply) { for (const fn of received) fn(reply); },
    drop() { for (const fn of gone) fn(); },
  };
}

function fakeChrome(reply) {
  const listeners = new Set();
  return {
    runtime: { sendMessage: vi.fn(async () => (typeof reply === 'function' ? reply() : structuredClone(reply))) },
    storage: {
      onChanged: {
        addListener: vi.fn((fn) => listeners.add(fn)),
        removeListener: vi.fn((fn) => listeners.delete(fn)),
      },
    },
    fire(changes, areaName) { for (const fn of listeners) fn(changes, areaName); },
    listeners,
  };
}

describe('changedFields', () => {
  it('changedFields reports only differing top-level fields', () => {
    const previous = withKeys();
    const next = structuredClone(previous);
    next.minRecordingTime = 3;
    next.keys.gemini = 'AQ.c';
    expect(changedFields(previous, next)).toEqual({ minRecordingTime: 3, keys: { gemini: 'AQ.c' } });
  });

  it('changedFields ignores key order and settingsVersion', () => {
    const previous = withKeys();
    const next = { ...structuredClone(previous), modes: reversed(structuredClone(previous.modes)), settingsVersion: 99 };
    expect(Object.keys(next.modes)).not.toEqual(Object.keys(previous.modes));
    expect(changedFields(previous, next)).toEqual({});
  });

  it('changedFields sees nested edits', () => {
    const previous = withKeys();
    const edited = structuredClone(previous);
    const [first] = Object.keys(edited.modes);
    edited.modes[first].prompt = `${edited.modes[first].prompt} Be brief.`;
    expect(changedFields(previous, edited)).toEqual({ modes: edited.modes });

    const ruled = structuredClone(previous);
    ruled.siteRules = { 'mail.google.com': { hidePill: true, mode: null } };
    expect(changedFields(previous, ruled)).toEqual({ siteRules: ruled.siteRules });
  });

  it('does not report fields absent from next', () => {
    const previous = withKeys();
    expect(changedFields(previous, { pillStyle: previous.pillStyle })).toEqual({});
  });
});

describe('createSettingsClient', () => {
  it('load merges a settings reply over fresh settings', async () => {
    const stored = withKeys();
    delete stored.alwaysCopy;
    const client = createSettingsClient({ chrome: fakeChrome(stored) });
    const loaded = await client.load();
    expect(loaded).toEqual({ ...freshSettings(), ...stored });
    expect(loaded.alwaysCopy).toBe(freshSettings().alwaysCopy);
  });

  it('load returns null for a non-settings reply', async () => {
    for (const reply of [null, { success: false }, { modes: {}, keys: null }]) {
      const chrome = fakeChrome(reply);
      expect(await createSettingsClient({ chrome }).load()).toBeNull();
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: MSG.GET_SETTINGS });
    }
  });

  it('save sends only the patch', async () => {
    const ok = fakeChrome({ success: true });
    expect(await createSettingsClient({ chrome: ok }).save({ pillStyle: 'dot' })).toEqual({ success: true });
    expect(ok.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(ok.runtime.sendMessage).toHaveBeenCalledWith({ action: MSG.SAVE_SETTINGS, settings: { pillStyle: 'dot' } });

    const refused = fakeChrome({ success: false, error: 'x' });
    expect(await createSettingsClient({ chrome: refused }).save({ pillStyle: 'dot' })).toEqual({ success: false, error: 'x' });

    const thrown = fakeChrome(() => { throw new Error('no receiver'); });
    expect(await createSettingsClient({ chrome: thrown }).save({ pillStyle: 'dot' })).toEqual({ success: false, error: undefined });
  });

  it('saveSiteRule sends only the fields it was given', async () => {
    const chrome = fakeChrome({ success: true });
    await createSettingsClient({ chrome }).saveSiteRule({ host: 'example.com', mode: 'email' });
    expect(Object.keys(chrome.runtime.sendMessage.mock.calls[0][0]).toSorted()).toEqual(['action', 'host', 'mode']);
  });

  it('saveSiteRule sends the rule and reports the reply', async () => {
    const rule = { host: 'example.com', hidePill: true, mode: null };
    const ok = fakeChrome({ success: true });
    expect(await createSettingsClient({ chrome: ok }).saveSiteRule(rule)).toEqual({ success: true });
    expect(ok.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(ok.runtime.sendMessage).toHaveBeenCalledWith({ action: MSG.SET_SITE_RULE, ...rule });

    const refused = fakeChrome({ success: false, error: 'x' });
    expect(await createSettingsClient({ chrome: refused }).saveSiteRule(rule)).toEqual({ success: false, error: 'x' });

    expect(await createSettingsClient({ chrome: fakeChrome(null) }).saveSiteRule(rule))
      .toEqual({ success: false, error: undefined });

    const thrown = fakeChrome(() => { throw new Error('no receiver'); });
    expect(await createSettingsClient({ chrome: thrown }).saveSiteRule(rule)).toEqual({ success: false, error: undefined });
  });

  it('send returns null when sendMessage throws', async () => {
    const chrome = fakeChrome(() => { throw new Error('no receiver'); });
    expect(await createSettingsClient({ chrome }).send({ action: MSG.GET_USAGE })).toBeNull();
  });

  it('onExternalChange filters area and key', () => {
    const chrome = fakeChrome(null);
    const listener = vi.fn();
    const unsubscribe = createSettingsClient({ chrome }).onExternalChange(listener);

    chrome.fire({ settings: { newValue: {} } }, 'sync');
    chrome.fire({ usageLog: { newValue: [] } }, 'local');
    expect(listener).not.toHaveBeenCalled();

    chrome.fire({ settings: { newValue: {} }, usageLog: { newValue: [] } }, 'local');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledTimes(1);
    chrome.fire({ settings: { newValue: {} } }, 'local');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('createSettingsClient save port', () => {
  const PATCH = { keepHistory: false };
  const SAVE = { action: MSG.SAVE_SETTINGS, settings: PATCH };

  function setup() {
    const chrome = fakeChrome({ success: true });
    const port = fakePort();
    chrome.runtime.connect = vi.fn(() => port);
    return { chrome, port, client: createSettingsClient({ chrome }) };
  }

  it('sends a save by message while no port is open', async () => {
    const { chrome, client } = setup();
    expect(await client.save(PATCH)).toEqual({ success: true });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith(SAVE);
    expect(chrome.runtime.connect).not.toHaveBeenCalled();
  });

  it('opens one port however often it is asked', () => {
    const { chrome, client } = setup();
    client.openSavePort();
    client.openSavePort();
    expect(chrome.runtime.connect).toHaveBeenCalledExactlyOnceWith({ name: SAVE_PORT });
  });

  it('posts a save on the open port in the same tick and takes the reply that carries its id', async () => {
    const { chrome, port, client } = setup();
    client.openSavePort();
    const first = client.save(PATCH);
    const second = client.save({ keepHistory: true });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    const [[{ id: firstId, message }], [{ id: secondId }]] = port.postMessage.mock.calls;
    expect(message).toEqual(SAVE);
    expect(secondId).not.toBe(firstId);
    port.answer({ id: secondId, reply: { success: false, error: 'No' } });
    port.answer({ id: firstId, reply: { success: true } });
    expect(await first).toEqual({ success: true });
    expect(await second).toEqual({ success: false, error: 'No' });
  });

  it('fails a save whose port goes before the reply, and reopens on request', async () => {
    const { chrome, port, client } = setup();
    client.openSavePort();
    const waiting = client.save(PATCH);
    port.drop();
    expect(await waiting).toEqual({ success: false, error: undefined });
    expect(await client.save(PATCH)).toEqual({ success: true });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledOnce();
    client.openSavePort();
    expect(chrome.runtime.connect).toHaveBeenCalledTimes(2);
  });

  it('falls back to a message when the port refuses the post', async () => {
    const { chrome, port, client } = setup();
    client.openSavePort();
    port.postMessage.mockImplementation(() => { throw new Error('Attempting to use a disconnected port object'); });
    expect(await client.save(PATCH)).toEqual({ success: true });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith(SAVE);
  });

  it('stays on messages when the port cannot open', async () => {
    const { chrome, client } = setup();
    chrome.runtime.connect.mockImplementation(() => { throw new Error('Extension context invalidated.'); });
    client.openSavePort();
    expect(await client.save(PATCH)).toEqual({ success: true });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledOnce();
  });
});
