import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHistory, MAX_HISTORY } from '../../../src/background/history.js';
import { EDIT_MODE } from '../../../src/shared/defaults.js';

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
/** An add with nothing cleared since its mark. */
const put = (history, added) => history.add(added, history.mark());

afterEach(() => vi.restoreAllMocks());

describe('createHistory', () => {
  it('holds twenty at most', () => {
    expect(MAX_HISTORY).toBe(20);
  });

  it('stores under the key history, with an id and a time of its own', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    const area = fakeArea();
    const history = createHistory({ area });
    await put(history, { raw: 'raw', text: 'text', mode: 'email', host: null });
    await put(history, { raw: 'raw', text: 'text', mode: 'email', host: null });
    const [second, first] = area.map.get('history');
    expect(first).toEqual({ id: expect.any(String), raw: 'raw', text: 'text', mode: 'email', host: null, ts: 1234 });
    expect(second.id).not.toBe(first.id);
  });

  it('keeps the newest first', async () => {
    const history = createHistory({ area: fakeArea() });
    await put(history, entry('one'));
    await put(history, entry('two'));
    expect(texts(await history.list())).toEqual(['two', 'one']);
  });

  it('drops the oldest past MAX_HISTORY', async () => {
    const history = createHistory({ area: fakeArea() });
    for (let i = 1; i <= MAX_HISTORY + 1; i++) await put(history, entry(`n${i}`));
    const list = await history.list();
    expect(list).toHaveLength(MAX_HISTORY);
    expect(list[0].text).toBe(`n${MAX_HISTORY + 1}`);
    expect(list.at(-1).text).toBe('n2');
  });

  it('loses nothing when two adds overlap', async () => {
    const history = createHistory({ area: fakeArea() });
    await Promise.all([put(history, entry('one')), put(history, entry('two'))]);
    expect(texts(await history.list())).toEqual(['two', 'one']);
  });

  it('holds the cap when more adds overlap than it allows', async () => {
    const history = createHistory({ area: fakeArea() });
    await Promise.all(Array.from({ length: MAX_HISTORY + 5 }, (_, i) => put(history, entry(`n${i}`))));
    const list = await history.list();
    expect(list).toHaveLength(MAX_HISTORY);
    expect(list[0].text).toBe(`n${MAX_HISTORY + 4}`);
    expect(list.at(-1).text).toBe('n5');
  });

  it('reads the store each time: a new instance sees earlier entries', async () => {
    const area = fakeArea();
    await put(createHistory({ area }), entry('before the restart'));
    const restarted = createHistory({ area });
    expect(texts(await restarted.list())).toEqual(['before the restart']);
    await put(restarted, entry('after the restart'));
    expect(texts(await restarted.list())).toEqual(['after the restart', 'before the restart']);
  });

  it('holds the cap across a restart', async () => {
    const area = fakeArea();
    for (let i = 1; i <= MAX_HISTORY; i++) await put(createHistory({ area }), entry(`n${i}`));
    await put(createHistory({ area }), entry('last'));
    expect(area.map.get('history')).toHaveLength(MAX_HISTORY);
  });

  it('a failed write does not stop the next one', async () => {
    const area = fakeArea();
    const history = createHistory({ area });
    area.set.mockRejectedValueOnce(new Error('quota'));
    await expect(put(history, entry('lost'))).rejects.toThrow('quota');
    await put(history, entry('kept'));
    expect(texts(await history.list())).toEqual(['kept']);
  });

  it('a read does not wait for a write that hangs', async () => {
    const area = fakeArea({ history: [{ ...entry('held'), id: 'a', ts: 1 }] });
    const history = createHistory({ area });
    area.set.mockReturnValueOnce(new Promise(() => {}));
    put(history, entry('hung'));
    expect(texts(await history.list())).toEqual(['held']);
    expect((await history.lastFor('example.com')).text).toBe('held');
  });

  it('lastFor matches the host exactly, newest first', async () => {
    const history = createHistory({ area: fakeArea() });
    await put(history, entry('old', 'example.com'));
    await put(history, entry('new', 'example.com'));
    await put(history, entry('sub', 'mail.example.com'));
    expect((await history.lastFor('example.com')).text).toBe('new');
    expect((await history.lastFor('mail.example.com')).text).toBe('sub');
    expect(await history.lastFor('other.example.com')).toBeNull();
    expect(await history.lastFor('ample.com')).toBeNull();
  });

  it('lastFor marks an edit', async () => {
    const history = createHistory({ area: fakeArea() });
    await put(history, entry('plain'));
    expect((await history.lastFor('example.com')).edit).toBe(false);
    await put(history, { ...entry('edited'), mode: EDIT_MODE });
    expect((await history.lastFor('example.com')).edit).toBe(true);
  });

  it('the mark stays out of what is stored', async () => {
    const area = fakeArea();
    const history = createHistory({ area });
    await put(history, entry('plain'));
    await history.lastFor('example.com');
    expect(area.map.get('history')[0]).not.toHaveProperty('edit');
  });

  it('lastFor(null) is null even with a null-host entry', async () => {
    const history = createHistory({ area: fakeArea() });
    await put(history, entry('no site', null));
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
    await put(history, entry('fresh'));
    expect(texts(await history.list())).toEqual(['fresh']);
  });

  it('clear empties it', async () => {
    const history = createHistory({ area: fakeArea() });
    await put(history, entry('one'));
    await history.clear();
    expect(await history.list()).toEqual([]);
    expect(await history.lastFor('example.com')).toBeNull();
  });

  it('an add marked before a clear is dropped', async () => {
    const history = createHistory({ area: fakeArea() });
    const mark = history.mark();
    await history.clear();
    await history.add(entry('late'), mark);
    expect(await history.list()).toEqual([]);
  });

  it('an add marked after the clear is kept', async () => {
    const history = createHistory({ area: fakeArea() });
    await history.clear();
    await history.add(entry('next'), history.mark());
    expect(texts(await history.list())).toEqual(['next']);
  });

  it('a clear counts from the call, so an add still queued behind a write is dropped', async () => {
    const area = fakeArea();
    const history = createHistory({ area });
    const adds = [put(history, entry('first')), put(history, entry('second'))];
    history.clear();
    await Promise.all(adds);
    expect(area.set).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(area.map.get('history')).toEqual([]));
  });

  it('a failed clear still counts: a marked add does not land after it', async () => {
    const area = fakeArea();
    const history = createHistory({ area });
    const mark = history.mark();
    area.set.mockRejectedValueOnce(new Error('down'));
    await expect(history.clear()).rejects.toThrow('down');
    await history.add(entry('late'), mark);
    expect(await history.list()).toEqual([]);
  });

  it('an add with no mark adds nothing', async () => {
    const history = createHistory({ area: fakeArea() });
    await history.add(entry('unmarked'));
    expect(await history.list()).toEqual([]);
  });

  it('a clear waits its turn: an add queued before it does not survive it', async () => {
    const history = createHistory({ area: fakeArea() });
    await Promise.all([put(history, entry('one')), history.clear()]);
    expect(await history.list()).toEqual([]);
  });
});
