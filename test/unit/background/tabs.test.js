import { describe, it, expect, vi } from 'vitest';
import { broadcast } from '../../../src/background/tabs.js';

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
      sendMessage: vi.fn(async (id) => { if (id === 1) throw new Error('Could not establish connection. Receiving end does not exist.'); }),
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
