import { describe, it, expect, vi } from 'vitest';
import { createOffscreenClient } from '../../../src/background/offscreen-client.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakes({ contexts = [] } = {}) {
  const runtime = {
    getContexts: vi.fn(async () => contexts),
    getURL: (path) => `chrome-extension://abc/${path}`,
    sendMessage: vi.fn(async () => ({ ok: true })),
  };
  const offscreen = { createDocument: vi.fn(async () => {}) };
  return { runtime, offscreen, client: createOffscreenClient({ runtime, offscreen }) };
}

describe('createOffscreenClient', () => {
  it('creates the USER_MEDIA document from the full extension URL', async () => {
    const { runtime, offscreen, client } = fakes();
    await client.ensure();
    expect(runtime.getContexts).toHaveBeenCalledWith({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    expect(offscreen.createDocument).toHaveBeenCalledWith({
      url: 'chrome-extension://abc/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Record dictation audio from the microphone.',
    });
  });

  it('skips creation when an offscreen document already exists', async () => {
    const { offscreen, client } = fakes({ contexts: [{ contextType: 'OFFSCREEN_DOCUMENT' }] });
    await client.ensure();
    expect(offscreen.createDocument).not.toHaveBeenCalled();
  });

  it('shares one in-flight create between concurrent callers', async () => {
    const { offscreen, client } = fakes();
    const pending = deferred();
    offscreen.createDocument.mockImplementation(() => pending.promise);
    const first = client.ensure();
    const second = client.ensure();
    await vi.waitFor(() => expect(offscreen.createDocument).toHaveBeenCalledTimes(1));
    pending.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(offscreen.createDocument).toHaveBeenCalledTimes(1);
  });

  it('treats the "single offscreen document" rejection as success', async () => {
    const { offscreen, client } = fakes();
    offscreen.createDocument.mockRejectedValueOnce(new Error('Only a single offscreen document may be created.'));
    await expect(client.ensure()).resolves.toBeUndefined();
  });

  it('rethrows other creation errors and tries again on the next call', async () => {
    const { offscreen, client } = fakes();
    offscreen.createDocument.mockRejectedValueOnce(new Error('Invalid reason'));
    await expect(client.ensure()).rejects.toThrow('Invalid reason');
    await expect(client.ensure()).resolves.toBeUndefined();
    expect(offscreen.createDocument).toHaveBeenCalledTimes(2);
  });

  it('honours a custom document path', async () => {
    const { runtime, offscreen } = fakes();
    await createOffscreenClient({ runtime, offscreen, path: 'rec.html' }).ensure();
    expect(offscreen.createDocument.mock.calls[0][0].url).toBe('chrome-extension://abc/rec.html');
  });

  it('send forwards the message to runtime.sendMessage', async () => {
    const { runtime, client } = fakes();
    const message = { action: 'offscreenStop', discard: true };
    await expect(client.send(message)).resolves.toEqual({ ok: true });
    expect(runtime.sendMessage).toHaveBeenCalledWith(message);
  });
});
