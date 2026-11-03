import { describe, it, expect, vi } from 'vitest';
import { openSettings } from '../../../src/popup/open-settings.js';

const ORIGIN = 'chrome-extension://id';
const POPUP_TAB = { contextType: 'TAB', tabId: 5, windowId: 3, documentUrl: `${ORIGIN}/popup.html` };
const SETTINGS_TAB = { contextType: 'TAB', tabId: 7, windowId: 3, documentUrl: `${ORIGIN}/options.html#modes` };

/** Fake runtime, tabs and windows; `getContexts` answers with `contexts`. */
function fakeApis(contexts) {
  return {
    runtime: {
      getURL: vi.fn((path) => `${ORIGIN}/${path}`),
      getContexts: vi.fn(async () => contexts),
    },
    tabs: { create: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
    windows: { update: vi.fn(async () => ({})) },
  };
}

describe('openSettings', () => {
  it('creates a tab at the route when no settings tab is open', async () => {
    const apis = fakeApis([POPUP_TAB]);
    await openSettings(apis, 'settings/provider');
    expect(apis.runtime.getContexts).toHaveBeenCalledWith({ contextTypes: ['TAB'] });
    expect(apis.tabs.create).toHaveBeenCalledWith({ url: `${ORIGIN}/options.html#settings/provider` });
    expect(apis.tabs.update).not.toHaveBeenCalled();
    expect(apis.windows.update).not.toHaveBeenCalled();
  });

  it('creates a tab at #home for Open settings', async () => {
    const apis = fakeApis([]);
    await openSettings(apis, null);
    expect(apis.tabs.create).toHaveBeenCalledWith({ url: `${ORIGIN}/options.html#home` });
  });

  it('reuses and focuses an open settings tab at a route', async () => {
    const apis = fakeApis([POPUP_TAB, SETTINGS_TAB]);
    await openSettings(apis, 'settings/provider');
    expect(apis.tabs.update).toHaveBeenCalledWith(7, { active: true, url: `${ORIGIN}/options.html#settings/provider` });
    expect(apis.windows.update).toHaveBeenCalledWith(3, { focused: true });
    expect(apis.tabs.create).not.toHaveBeenCalled();
  });

  it('finds the settings tab with no hash in its URL', async () => {
    const apis = fakeApis([{ ...SETTINGS_TAB, documentUrl: `${ORIGIN}/options.html` }]);
    await openSettings(apis, 'home');
    expect(apis.tabs.update).toHaveBeenCalledWith(7, { active: true, url: `${ORIGIN}/options.html#home` });
    expect(apis.tabs.create).not.toHaveBeenCalled();
  });

  it('Open settings focuses the open tab without changing its route', async () => {
    const apis = fakeApis([SETTINGS_TAB]);
    await openSettings(apis, null);
    expect(apis.tabs.update).toHaveBeenCalledWith(7, { active: true });
    expect(apis.windows.update).toHaveBeenCalledWith(3, { focused: true });
    expect(apis.tabs.create).not.toHaveBeenCalled();
  });

  it('a getContexts failure falls back to a new tab', async () => {
    const apis = fakeApis([]);
    apis.runtime.getContexts.mockRejectedValue(new Error('no contexts'));
    await openSettings(apis, 'settings/provider');
    expect(apis.tabs.create).toHaveBeenCalledWith({ url: `${ORIGIN}/options.html#settings/provider` });
    expect(apis.tabs.update).not.toHaveBeenCalled();
  });

  it('a windows.update failure still leaves the tab activated', async () => {
    const apis = fakeApis([SETTINGS_TAB]);
    apis.windows.update.mockRejectedValue(new Error('no window'));
    await expect(openSettings(apis, 'modes')).resolves.toBeUndefined();
    expect(apis.tabs.update).toHaveBeenCalledWith(7, { active: true, url: `${ORIGIN}/options.html#modes` });
  });

  it('a tabs.update failure still focuses the window', async () => {
    const apis = fakeApis([SETTINGS_TAB]);
    apis.tabs.update.mockRejectedValue(new Error('no tab'));
    await expect(openSettings(apis, null)).resolves.toBeUndefined();
    expect(apis.windows.update).toHaveBeenCalledWith(3, { focused: true });
    expect(apis.tabs.create).not.toHaveBeenCalled();
  });
});
