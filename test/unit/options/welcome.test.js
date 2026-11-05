// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initOptions } from '../../../src/options/options.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings } from '../../../src/shared/defaults.js';

// jsdom replaces the global URL, so resolve paths with node:path rather than new URL().
const HTML = readFileSync(join(import.meta.dirname, '../../../src/options/options.html'), 'utf8');
const KEY = 'sk-proj-abcdefgh1234';
const INSTRUCTION = 'click into any text field on a web page and press it';
const ASKS = 'Chrome asks once, for VoiceType itself, in a new tab.';
const BLOCKED = 'Microphone blocked for VoiceType. Allow it at chrome://settings/content/microphone.';

function storedSettings(fields = {}) {
  return { ...freshSettings(), provider: 'openai', keys: { openai: '', gemini: '' }, ...fields };
}

/** Fake chrome for the settings page. `fire` plays a storage.onChanged event. */
function fakeChrome(stored = storedSettings()) {
  const changeListeners = new Set();
  const fake = {
    stored,
    fire(changes, area) { for (const listener of [...changeListeners]) listener(changes, area); },
    runtime: {
      sendMessage: vi.fn(async (message) => {
        if (message.action === MSG.GET_SETTINGS) return structuredClone(fake.stored);
        return undefined;
      }),
      getManifest: () => ({ version: '3.0.0-test' }),
      getURL: (path) => `chrome-extension://abc/${path}`,
    },
    tabs: { create: vi.fn(async () => ({ id: 9 })) },
    storage: {
      onChanged: {
        addListener: vi.fn((listener) => changeListeners.add(listener)),
        removeListener: vi.fn((listener) => changeListeners.delete(listener)),
      },
    },
  };
  return fake;
}

/** A PermissionStatus stand-in; `set` changes the state the way a grant in another tab does. */
function fakeStatus(state) {
  const target = new EventTarget();
  return {
    state,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    set(next) {
      this.state = next;
      target.dispatchEvent(new Event('change'));
    },
  };
}

function stubNavigator(name, value) {
  Object.defineProperty(window.navigator, name, { configurable: true, value });
}

const $ = (id) => document.getElementById(id);
const flush = () => new Promise((r) => setTimeout(r, 0));
const section = () => document.querySelector('section[data-route="welcome"]');
const keyDone = () => $('welcome-key-status').dataset.ready === 'true';
const micDone = () => $('welcome-mic-status').dataset.ready === 'true';

async function open(chrome = fakeChrome()) {
  window.history.replaceState(null, '', '#welcome');
  const page = await initOptions({ chrome, document, window });
  await flush();
  return { chrome, page };
}

beforeEach(() => {
  document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
  window.history.replaceState(null, '', '/');
  stubNavigator('permissions', { query: vi.fn(async () => fakeStatus('prompt')) });
});
afterEach(() => {
  delete window.navigator.permissions;
  delete window.navigator.platform;
});

describe('Welcome: your key', () => {
  it('marks the key step done once the provider has a key', async () => {
    const { chrome } = await open();
    expect(section().textContent).toContain('Your key');
    expect(keyDone()).toBe(false);
    expect($('welcome-key-state').textContent).toBe('No OpenAI key');

    chrome.stored = storedSettings({ keys: { openai: KEY, gemini: '' } });
    chrome.fire({ settings: { newValue: {} } }, 'local');
    await flush();
    expect(keyDone()).toBe(true);
    expect($('welcome-key-state').textContent).toBe('OpenAI key saved');
    expect(section().textContent).not.toContain(KEY);
  });

  it('counts only the active provider, and a blank key is no key', async () => {
    await open(fakeChrome(storedSettings({ provider: 'gemini', keys: { openai: KEY, gemini: '   ' } })));
    expect(keyDone()).toBe(false);
    expect($('welcome-key-state').textContent).toBe('No Gemini key');
  });

  it('shows no key state it cannot know when settings did not load', async () => {
    const chrome = fakeChrome();
    chrome.runtime.sendMessage = vi.fn(async () => ({ error: 'nope' }));
    await open(chrome);
    expect(keyDone()).toBe(false);
    expect($('welcome-key-state').textContent).toBe('Unknown');
  });

  it('links the key step to Provider and holds no key form', async () => {
    await open();
    const link = section().querySelector('a[href="#settings/provider"]');
    expect(link.textContent.trim()).toBe('Provider');
    expect(section().querySelector('input')).toBeNull();
  });
});

describe('Welcome: microphone', () => {
  it('reads the microphone state from navigator.permissions', async () => {
    const expected = {
      granted: ['Allowed', true, true],
      prompt: ['Not allowed yet', false, false],
      denied: ['Blocked', false, false],
    };
    for (const [state, [text, done, buttonHidden]] of Object.entries(expected)) {
      const query = vi.fn(async () => fakeStatus(state));
      stubNavigator('permissions', { query });
      document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
      await open();
      expect(query).toHaveBeenCalledWith({ name: 'microphone' });
      expect($('welcome-mic-state').textContent, state).toBe(text);
      expect(micDone(), state).toBe(done);
      expect($('welcome-allow-mic').hidden, state).toBe(buttonHidden);
    }
  });

  it.each([
    ['a query that rejects', () => ({ query: vi.fn(async () => { throw new TypeError('bad name'); }) })],
    ['a query that throws', () => ({ query: vi.fn(() => { throw new TypeError('bad name'); }) })],
    ['no permissions API', () => undefined],
  ])('%s leaves the state unknown and the button shown', async (_name, permissions) => {
    stubNavigator('permissions', permissions());
    await open();
    expect($('welcome-mic-state').textContent).toBe('Unknown');
    expect(micDone()).toBe(false);
    expect($('welcome-allow-mic').hidden).toBe(false);
  });

  it('the hint fits the state: asks in the prompt state, how to unblock when Blocked, none when Allowed', async () => {
    const expected = { prompt: [ASKS, false], denied: [BLOCKED, false], granted: [null, true] };
    for (const [state, [text, hidden]] of Object.entries(expected)) {
      stubNavigator('permissions', { query: vi.fn(async () => fakeStatus(state)) });
      document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
      await open();
      expect($('welcome-mic-hint').hidden, state).toBe(hidden);
      if (text) expect($('welcome-mic-hint').textContent, state).toBe(text);
    }
  });

  it('keeps the hint when the state is unknown', async () => {
    stubNavigator('permissions', undefined);
    await open();
    expect($('welcome-mic-hint').hidden).toBe(false);
    expect($('welcome-mic-hint').textContent).toBe(ASKS);
  });

  it('the hint follows a state change', async () => {
    const status = fakeStatus('prompt');
    stubNavigator('permissions', { query: vi.fn(async () => status) });
    await open();
    status.set('denied');
    expect($('welcome-mic-hint').textContent).toBe(BLOCKED);
    status.set('granted');
    expect($('welcome-mic-hint').hidden).toBe(true);
    status.set('prompt');
    expect($('welcome-mic-hint').hidden).toBe(false);
    expect($('welcome-mic-hint').textContent).toBe(ASKS);
  });

  it('the Blocked hint has the wording of the recorder notice', () => {
    expect(readFileSync(join(import.meta.dirname, '../../../src/background/recorder.js'), 'utf8')).toContain(`'${BLOCKED}'`);
  });

  it('the Allow button opens permission.html', async () => {
    const { chrome } = await open();
    $('welcome-allow-mic').click();
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome-extension://abc/permission.html' });
  });

  it('says so when the tab cannot open', async () => {
    const chrome = fakeChrome();
    chrome.tabs.create.mockRejectedValueOnce(new Error('no window'));
    await open(chrome);
    $('welcome-allow-mic').click();
    await flush();
    expect($('toast').textContent).toBe('Could not open the microphone page.');
    expect($('toast').dataset.tone).toBe('error');
  });

  it('a state change updates the step', async () => {
    const status = fakeStatus('prompt');
    stubNavigator('permissions', { query: vi.fn(async () => status) });
    await open();
    expect(micDone()).toBe(false);

    status.set('granted');
    expect(micDone()).toBe(true);
    expect($('welcome-mic-state').textContent).toBe('Allowed');
    expect($('welcome-allow-mic').hidden).toBe(true);

    status.set('denied');
    expect(micDone()).toBe(false);
    expect($('welcome-mic-state').textContent).toBe('Blocked');
    expect($('welcome-allow-mic').hidden).toBe(false);
  });
});

describe('Welcome: start dictating', () => {
  it('shows the current hotkey with the instruction line', async () => {
    const { chrome } = await open();
    const step = $('welcome-hotkey').closest('li');
    expect(step.textContent).toContain('Start dictating');
    expect($('welcome-hotkey').textContent).toBe('Ctrl+Shift+Space');
    expect(step.textContent).toContain(INSTRUCTION);

    chrome.stored = storedSettings({ hotkey: { code: 'KeyD', ctrl: false, shift: false, alt: true, meta: false } });
    chrome.fire({ settings: { newValue: {} } }, 'local');
    await flush();
    expect($('welcome-hotkey').textContent).toBe('Alt+D');
  });

  it('names the keys the Mac way on a Mac', async () => {
    stubNavigator('platform', 'MacIntel');
    await open(fakeChrome(storedSettings({ hotkey: { code: 'KeyD', ctrl: false, shift: false, alt: true, meta: false } })));
    expect($('welcome-hotkey').textContent).toBe('Option+D');
  });
});
