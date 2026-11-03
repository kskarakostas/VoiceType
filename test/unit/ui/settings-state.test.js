import { describe, it, expect, vi } from 'vitest';
import { createSettingsState } from '../../../src/ui/settings-state.js';
import { freshSettings } from '../../../src/shared/defaults.js';

const NOT_LOADED = 'Settings are not loaded. Nothing was saved.';

function storedSettings() {
  const s = freshSettings();
  s.keys = { openai: 'sk-proj-abcdefgh1234', gemini: 'AIza-gemini-5678' };
  return s;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * Fake settings client. `loads` and `saves` queue one-shot answers (values or promises); without
 * one, load answers a copy of `stored` and save succeeds. `fire()` plays an external change.
 */
function fakeClient(stored = storedSettings()) {
  const listeners = new Set();
  const loads = [];
  const saves = [];
  const client = {
    loads,
    saves,
    patches: [],
    load: vi.fn(async () => (loads.length ? loads.shift() : { ...freshSettings(), ...structuredClone(stored) })),
    save: vi.fn(async (patch) => {
      client.patches.push(structuredClone(patch));
      return saves.length ? saves.shift() : { success: true };
    }),
    onExternalChange: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    fire() { for (const listener of [...listeners]) listener(); },
  };
  return client;
}

function setup(client = fakeClient()) {
  const render = vi.fn();
  const toast = vi.fn();
  const state = createSettingsState({ client, render, toast });
  return { client, render, toast, state };
}

describe('createSettingsState', () => {
  it('starts on fresh settings, not loaded', () => {
    const { state, render } = setup();
    expect(state.settings()).toEqual(freshSettings());
    expect(state.loaded()).toBe(false);
    expect(render).not.toHaveBeenCalled();
  });

  it('start subscribes before it loads, then renders once', async () => {
    const { client, state, render } = setup();
    expect(await state.start()).toBe(true);
    expect(client.onExternalChange.mock.invocationCallOrder[0]).toBeLessThan(client.load.mock.invocationCallOrder[0]);
    expect(state.loaded()).toBe(true);
    expect(state.settings().keys.openai).toBe('sk-proj-abcdefgh1234');
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('a failed load stays not loaded, renders, and ignores external changes', async () => {
    const client = fakeClient();
    client.loads.push(null);
    const { state, render } = setup(client);
    expect(await state.start()).toBe(false);
    expect(state.loaded()).toBe(false);
    expect(render).toHaveBeenCalledTimes(1);
    client.fire();
    await flush();
    expect(client.load).toHaveBeenCalledTimes(1);
  });

  it('a change during the first load re-reads once after it', async () => {
    const client = fakeClient();
    const first = deferred();
    client.loads.push(first.promise);
    const { state } = setup(client);
    const started = state.start();
    client.fire();
    client.fire();
    first.resolve(storedSettings());
    await started;
    await flush();
    expect(client.load).toHaveBeenCalledTimes(2);
  });

  it('commit before loading saves nothing and shows the not-loaded toast', async () => {
    const client = fakeClient();
    client.loads.push(null);
    const { state, render, toast } = setup(client);
    await state.start();
    render.mockClear();
    expect(await state.commit((s) => { s.maxRecordingTime = 300; })).toBe(false);
    expect(client.save).not.toHaveBeenCalled();
    expect(state.settings().maxRecordingTime).toBe(freshSettings().maxRecordingTime);
    expect(render).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(NOT_LOADED, 'error');
  });

  it('commit sends only the changed fields and skips an empty patch', async () => {
    const { client, state, render, toast } = setup();
    await state.start();
    render.mockClear();
    expect(await state.commit((s) => { s.maxRecordingTime = 300; s.keys.gemini = 'AIza-new'; }, 'Saved')).toBe(true);
    expect(client.patches).toEqual([{ maxRecordingTime: 300, keys: { gemini: 'AIza-new' } }]);
    expect(state.settings().maxRecordingTime).toBe(300);
    expect(render).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('Saved', 'success');

    toast.mockClear();
    expect(await state.commit((s) => { s.maxRecordingTime = 300; })).toBe(true);
    expect(client.save).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it('commit never mutates the settings it hands out', async () => {
    const { state } = setup();
    await state.start();
    const before = state.settings();
    await state.commit((s) => { s.keys.openai = 'sk-new'; });
    expect(before.keys.openai).toBe('sk-proj-abcdefgh1234');
    expect(state.settings()).not.toBe(before);
  });

  it('a failed save restores only its own fields, keys per provider', async () => {
    const client = fakeClient();
    const failing = deferred();
    client.saves.push(failing.promise);
    const { state, toast } = setup(client);
    await state.start();
    const first = state.commit((s) => { s.provider = 'gemini'; s.keys.gemini = 'AIza-new'; });
    expect(state.settings().provider).toBe('gemini');
    expect(await state.commit((s) => { s.keys.openai = 'sk-proj-other'; s.maxRecordingTime = 300; })).toBe(true);
    failing.resolve({ success: false, error: 'Disk full' });
    expect(await first).toBe(false);
    expect(state.settings().provider).toBe('openai');
    expect(state.settings().keys).toEqual({ openai: 'sk-proj-other', gemini: 'AIza-gemini-5678' });
    expect(state.settings().maxRecordingTime).toBe(300);
    expect(toast).toHaveBeenLastCalledWith('Disk full', 'error');
  });

  it('a failed save removes a provider key or field the snapshot did not have', async () => {
    const stored = storedSettings();
    stored.keys = { openai: 'sk-a' };
    delete stored.alwaysCopy;
    const client = fakeClient(stored);
    client.load.mockImplementation(async () => structuredClone(stored));
    client.saves.push({ success: false });
    const { state, toast } = setup(client);
    await state.start();
    expect(await state.commit((s) => { s.keys.gemini = 'AQ.b'; s.alwaysCopy = true; })).toBe(false);
    expect(state.settings().keys).toEqual({ openai: 'sk-a' });
    expect(state.settings()).not.toHaveProperty('alwaysCopy');
    expect(toast).toHaveBeenLastCalledWith('Could not save settings.', 'error');
  });

  it('an external change re-reads and renders the fresh settings', async () => {
    const client = fakeClient();
    const { state, render } = setup(client);
    await state.start();
    client.loads.push({ ...storedSettings(), activeMode: 'email' });
    render.mockClear();
    client.fire();
    await flush();
    expect(client.load).toHaveBeenCalledTimes(2);
    expect(state.settings().activeMode).toBe('email');
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('a re-read that answers nothing keeps the settings', async () => {
    const client = fakeClient();
    const { state, render } = setup(client);
    await state.start();
    const before = state.settings();
    client.loads.push(null);
    render.mockClear();
    client.fire();
    await flush();
    expect(state.settings()).toBe(before);
    expect(render).not.toHaveBeenCalled();
  });

  it('an external change during a save waits for the save, then re-reads once', async () => {
    const client = fakeClient();
    const saving = deferred();
    client.saves.push(saving.promise);
    const { state } = setup(client);
    await state.start();
    const done = state.commit((s) => { s.maxRecordingTime = 300; });
    client.fire();
    client.fire();
    await flush();
    expect(client.load).toHaveBeenCalledTimes(1);
    saving.resolve({ success: true });
    await done;
    await flush();
    expect(client.load).toHaveBeenCalledTimes(2);
  });

  it('with two saves in flight the re-read waits for the last one', async () => {
    const client = fakeClient();
    const a = deferred();
    const b = deferred();
    client.saves.push(a.promise, b.promise);
    const { state } = setup(client);
    await state.start();
    const first = state.commit((s) => { s.maxRecordingTime = 300; });
    const second = state.commit((s) => { s.minRecordingTime = 2; });
    client.fire();
    a.resolve({ success: true });
    await first;
    await flush();
    expect(client.load).toHaveBeenCalledTimes(1);
    b.resolve({ success: true });
    await second;
    await flush();
    expect(client.load).toHaveBeenCalledTimes(2);
  });

  it('a re-read that started before a save is dropped and read again', async () => {
    const stored = storedSettings();
    const client = fakeClient(stored);
    const { state } = setup(client);
    await state.start();
    const reading = deferred();
    client.loads.push(reading.promise);
    client.fire();
    await state.commit((s) => { s.maxRecordingTime = 300; });
    stored.maxRecordingTime = 300;
    reading.resolve(storedSettings());
    await flush();
    expect(state.settings().maxRecordingTime).toBe(300);
    expect(client.load).toHaveBeenCalledTimes(3);
  });
});
