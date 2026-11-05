import { describe, it, expect, vi } from 'vitest';
import { createPending } from '../../../src/background/pending.js';

/** chrome.storage.session stand-in over a Map; a value goes in and out by copy, as in Chrome. */
function fakeArea() {
  const map = new Map();
  return {
    map,
    get: vi.fn(async (key) => (map.has(key) ? { [key]: structuredClone(map.get(key)) } : {})),
    set: vi.fn(async (items) => {
      for (const [key, value] of Object.entries(items)) map.set(key, structuredClone(value));
    }),
    remove: vi.fn(async (key) => { map.delete(key); }),
  };
}

const RECORD = { captureId: 'c1', endpoint: { tabId: 1, frameId: 0, documentId: 'd1' }, audioBase64: 'QUJD', at: 1000, attempts: 0 };

describe('createPending', () => {
  it('save, read, clear round-trip', async () => {
    const area = fakeArea();
    const pending = createPending({ area });
    expect(await pending.read()).toBeNull();
    await pending.save(RECORD);
    expect(await pending.read()).toEqual(RECORD);
    await pending.clear();
    expect(await pending.read()).toBeNull();
  });

  it('holds one record, under the key pendingDictation', async () => {
    const area = fakeArea();
    const pending = createPending({ area });
    await pending.save(RECORD);
    await pending.save({ ...RECORD, attempts: 1 });
    expect([...area.map.keys()]).toEqual(['pendingDictation']);
    expect((await pending.read()).attempts).toBe(1);
  });

  it('a clear after a slow save lands after it: no audio outlives its clear', async () => {
    const area = fakeArea();
    let land;
    const write = area.set.getMockImplementation();
    area.set.mockImplementationOnce((items) => new Promise((resolve) => { land = () => resolve(write(items)); }));
    const pending = createPending({ area });
    const saved = pending.save(RECORD);
    const cleared = pending.clear();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(area.remove).not.toHaveBeenCalled();
    land();
    await Promise.all([saved, cleared]);
    expect(await pending.read()).toBeNull();
  });

  it('a failed save rejects for its caller and does not block the next write', async () => {
    const area = fakeArea();
    area.set.mockRejectedValueOnce(new Error('Session storage quota bytes exceeded.'));
    const pending = createPending({ area });
    await expect(pending.save(RECORD)).rejects.toThrow('quota');
    await pending.save({ ...RECORD, attempts: 1 });
    expect((await pending.read()).attempts).toBe(1);
  });
});
