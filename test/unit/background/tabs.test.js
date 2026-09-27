import { describe, it, expect, vi } from 'vitest';
import { broadcast, sendToFrame, reinject, REINJECT_URLS } from '../../../src/background/tabs.js';

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';

describe('broadcast', () => {
  it('sends the message to every tab with an id, all frames', async () => {
    const tabsApi = {
      query: vi.fn(async () => [{ id: 1 }, { id: 2 }, {}]),
      sendMessage: vi.fn(async () => undefined),
    };
    const message = { action: 'settingsChanged', settings: { provider: 'openai' } };
    await broadcast(tabsApi, message);
    expect(tabsApi.query).toHaveBeenCalledWith({});
    expect(tabsApi.sendMessage.mock.calls).toEqual([[1, message], [2, message]]);
  });

  it('a tab without a receiver does not stop the others', async () => {
    const tabsApi = {
      query: vi.fn(async () => [{ id: 1 }, { id: 2 }]),
      sendMessage: vi.fn(async (id) => { if (id === 1) throw new Error(NO_RECEIVER); }),
    };
    await expect(broadcast(tabsApi, { action: 'x' })).resolves.toBeUndefined();
    expect(tabsApi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('resolves when the tab query fails', async () => {
    const tabsApi = { query: vi.fn(async () => { throw new Error('no'); }), sendMessage: vi.fn() };
    await expect(broadcast(tabsApi, { action: 'x' })).resolves.toBeUndefined();
    expect(tabsApi.sendMessage).not.toHaveBeenCalled();
  });
});

describe('sendToFrame', () => {
  it('sends to one frame and reports delivery', async () => {
    const tabsApi = { sendMessage: vi.fn(async () => undefined) };
    const message = { action: 'audioLevel', level: 0.5 };
    expect(await sendToFrame(tabsApi, { tabId: 4, frameId: 2 }, message)).toBe(true);
    expect(tabsApi.sendMessage).toHaveBeenCalledWith(4, message, { frameId: 2 });
  });

  it('reports false when the frame or tab has no receiver', async () => {
    const tabsApi = { sendMessage: vi.fn(async () => { throw new Error(NO_RECEIVER); }) };
    expect(await sendToFrame(tabsApi, { tabId: 4, frameId: 0 }, { action: 'x' })).toBe(false);
    tabsApi.sendMessage.mockRejectedValueOnce(new Error('No tab with id: 4.'));
    expect(await sendToFrame(tabsApi, { tabId: 4, frameId: 0 }, { action: 'x' })).toBe(false);
  });

  it('counts a receiver that sent no response as delivered', async () => {
    const tabsApi = { sendMessage: vi.fn(async () => { throw new Error('The message port closed before a response was received.'); }) };
    expect(await sendToFrame(tabsApi, { tabId: 4, frameId: 0 }, { action: 'x' })).toBe(true);
  });
});

describe('reinject', () => {
  it('injects content.js into every frame of every web and file tab', async () => {
    const tabsApi = { query: vi.fn(async () => [{ id: 1 }, { id: 2 }, {}]) };
    const scriptingApi = { executeScript: vi.fn(async () => []) };
    await reinject(tabsApi, scriptingApi);
    expect(REINJECT_URLS).toEqual(['http://*/*', 'https://*/*', 'file:///*']);
    expect(tabsApi.query).toHaveBeenCalledWith({ url: REINJECT_URLS });
    expect(scriptingApi.executeScript.mock.calls).toEqual([
      [{ target: { tabId: 1, allFrames: true }, files: ['content.js'] }],
      [{ target: { tabId: 2, allFrames: true }, files: ['content.js'] }],
    ]);
  });

  it('a tab that refuses injection does not stop the others', async () => {
    const tabsApi = { query: vi.fn(async () => [{ id: 1 }, { id: 2 }]) };
    const scriptingApi = {
      executeScript: vi.fn(async ({ target }) => { if (target.tabId === 1) throw new Error('Cannot access contents of the page.'); return []; }),
    };
    await expect(reinject(tabsApi, scriptingApi)).resolves.toBeUndefined();
    expect(scriptingApi.executeScript).toHaveBeenCalledTimes(2);
  });

  it('resolves when the tab query fails', async () => {
    const tabsApi = { query: vi.fn(async () => { throw new Error('no'); }) };
    const scriptingApi = { executeScript: vi.fn() };
    await expect(reinject(tabsApi, scriptingApi)).resolves.toBeUndefined();
    expect(scriptingApi.executeScript).not.toHaveBeenCalled();
  });
});
