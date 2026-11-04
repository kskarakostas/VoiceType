import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHistory, MAX_HISTORY } from '../../../src/background/history.js';

/** chrome.storage.session stand-in over a Map; a value goes in and out by copy, as in Chrome. */
function fakeArea(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    get: vi.fn(async (key) => (map.has(key) ? { [key]: structuredClone(map.get(key)) } : {})),
    set: vi.fn(async (items) => {
      for (const [key, value] of Object.entries(items)) map.set(key, structuredClone(value));
    }),
  };
}

const entry = (text, host = 'example.com') => ({ raw: `raw ${text}`, text, mode: 'default', host });
const texts = (entries) => entries.map(({ text }) => text);

afterEach(() => vi.restoreAllMocks());

describe('createHistory', () => {
  it('holds twenty at most', () => {
    expect(MAX_HISTORY).toBe(20);
  });

  it('stores under the key history, with an id and a time of its own', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    const area = fakeArea();
    const history = createHistory({ area });
    await history.add({ raw: 'raw', text: 'text', mode: 'email', host: null });
    await history.add({ raw: 'raw', text: 'text', mode: 'email', host: null });
    const [second, first] = area.map.get('history');
    expect(first).toEqual({ id: expect.any(String), raw: 'raw', text: 'text', mode: 'email', host: null, ts: 1234 });
    expect(second.id).not.toBe(first.id);
  });

  it('keeps the newest first', async () => {
    const history = createHistory({ area: fakeArea() });
    await history.add(entry('one'));
    await history.add(entry('two'));
    expect(texts(await history.list())).toEqual(['two', 'one']);
  });

  it('drops the oldest past MAX_HISTORY', async () => {
    const history = createHistory({ area: fakeArea() });
    for (let i = 1; i <= MAX_HISTORY + 1; i++) await history.add(entry(`n${i}`));
    const list = await history.list();
    expect(list).toHaveLength(MAX_HISTORY);
    expect(list[0].text).toBe(`n${MAX_HISTORY + 1}`);
    expect(list.at(-1).text).toBe('n2');
  });

  it('loses nothing when two adds overlap', async () => {
    const history = createHistory({ area: fakeArea() });
    await Promise.all([history.add(entry('one')), history.add(entry('two'))]);
    expect(texts(await history.list())).toEqual(['two', 'one']);
  });

  it('holds the cap when more adds overlap than it allows', async () => {
    const history = createHistory({ area: fakeArea() });
    await Promise.all(Array.from({ length: MAX_HISTORY + 5 }, (_, i) => history.add(entry(`n${i}`))));
    const list = await history.list();
    expect(list).toHaveLength(MAX_HISTORY);
    expect(list[0].text).toBe(`n${MAX_HISTORY + 4}`);
    expect(list.at(-1).text).toBe('n5');
  });

  it('reads the store each time: a new instance sees earlier entries', async () => {
    const area = fakeArea();
    await createHistory({ area }).add(entry('before the restart'));
    const restarted = createHistory({ area });
    expect(texts(await restarted.list())).toEqual(['before the restart']);
    await restarted.add(entry('after the restart'));
    expect(texts(await restarted.list())).toEqual(['after the restart', 'before the restart']);
  });

  it('holds the cap across a restart', async () => {
    const area = fakeArea();
    for (let i = 1; i <= MAX_HISTORY; i++) await createHistory({ area }).add(entry(`n${i}`));
    await createHistory({ area }).add(entry('last'));
    expect(area.map.get('history')).toHaveLength(MAX_HISTORY);
  });

  it('a failed write does not stop the next one', async () => {
    const area = fakeArea();
    const history = createHistory({ area });
    area.set.mockRejectedValueOnce(new Error('quota'));
    await expect(history.add(entry('lost'))).rejects.toThrow('quota');
    await history.add(entry('kept'));
    expect(texts(await history.list())).toEqual(['kept']);
  });

  it('a read does not wait for a write that hangs', async () => {
    const area = fakeArea({ history: [{ ...entry('held'), id: 'a', ts: 1 }] });
    const history = createHistory({ area });
    area.set.mockReturnValueOnce(new Promise(() => {}));
    history.add(entry('hung'));
    expect(texts(await history.list())).toEqual(['held']);
    expect((await history.lastFor('example.com')).text).toBe('held');
  });

  it('lastFor matches the host exactly, newest first', async () => {
    const history = createHistory({ area: fakeArea() });
    await history.add(entry('old', 'example.com'));
    await history.add(entry('new', 'example.com'));
    await history.add(entry('sub', 'mail.example.com'));
    expect((await history.lastFor('example.com')).text).toBe('new');
    expect((await history.lastFor('mail.example.com')).text).toBe('sub');
    expect(await history.lastFor('other.example.com')).toBeNull();
    expect(await history.lastFor('ample.com')).toBeNull();
  });

  it('lastFor(null) is null even with a null-host entry', async () => {
    const history = createHistory({ area: fakeArea() });
    await history.add(entry('no site', null));
    expect(await history.lastFor(null)).toBeNull();
  });

  it('lastFor is null on an empty store', async () => {
    expect(await createHistory({ area: fakeArea() }).lastFor('example.com')).toBeNull();
  });

  it.each([['a string', 'junk'], ['an object', { 0: 'x' }], ['null', null], ['a number', 7]])('repairs a stored non-array to empty: %s', async (_name, stored) => {
    const area = fakeArea({ history: stored });
    const history = createHistory({ area });
    expect(await history.list()).toEqual([]);
    expect(await history.lastFor('example.com')).toBeNull();
    await history.add(entry('fresh'));
    expect(texts(await history.list())).toEqual(['fresh']);
  });

  it('clear empties it', async () => {
    const history = createHistory({ area: fakeArea() });
    await history.add(entry('one'));
    await history.clear();
    expect(await history.list()).toEqual([]);
    expect(await history.lastFor('example.com')).toBeNull();
  });

  it('a clear waits its turn: an add queued before it does not survive it', async () => {
    const history = createHistory({ area: fakeArea() });
    await Promise.all([history.add(entry('one')), history.clear()]);
    expect(await history.list()).toEqual([]);
  });
});
