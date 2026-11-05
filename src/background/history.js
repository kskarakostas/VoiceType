import { EDIT_MODE } from '../shared/defaults.js';

/** How many recent dictations are held (V26). */
export const MAX_HISTORY = 20;

/**
 * @typedef {{ id: string, raw: string, text: string, mode: string, host: string|null, ts: number }} Entry
 * `mode` is the mode key; `host` is the site of the recording frame, or null (V26).
 */

/**
 * Recent dictations, newest first. Writes run through one promise queue of their own, so two adds
 * lose nothing and a hung settings or usage write never holds this one, nor the reverse. Reads go
 * to `area` each time and skip the queue: the worker may have restarted since the last add, and a
 * hung write must not hold a menu that is opening. The count of clears lives in memory: a worker
 * restart takes any dictation in flight with it, so no mark outlives the count it was taken from.
 * @param {{ area: { get: (key: string) => Promise<Record<string, unknown>>, set: (items: Record<string, unknown>) => Promise<void> } }} deps
 */
export function createHistory({ area }) {
  let tail = Promise.resolve();
  let clears = 0;

  /**
   * @param {() => Promise<void>} task
   * @returns {Promise<void>}
   */
  function enqueue(task) {
    const run = tail.then(task);
    tail = run.catch(() => {}); // a failed task must not block the ones queued after it
    return run;
  }

  /** @returns {Promise<Entry[]>} */
  async function read() {
    const { history } = await area.get('history');
    return Array.isArray(history) ? history : [];
  }

  return {
    /**
     * Where the clears stand. A dictation takes this before it starts, so a clear during it drops it (V27).
     * @returns {number}
     */
    mark() {
      return clears;
    },
    /**
     * Add an entry, unless history was cleared since `mark`.
     * @param {Omit<Entry, 'id'|'ts'>} entry
     * @param {number} mark From `mark()`, taken before the dictation started.
     * @returns {Promise<void>}
     */
    add(entry, mark) {
      return enqueue(async () => {
        if (mark !== clears) return;
        const added = { ...entry, id: crypto.randomUUID(), ts: Date.now() };
        await area.set({ history: [added, ...await read()].slice(0, MAX_HISTORY) });
      });
    },
    /** @returns {Promise<Entry[]>} */
    list() {
      return read();
    },
    /**
     * The newest entry dictated on exactly this site, marked when it is an edit (V48). A null host
     * matches nothing (V28).
     * @param {string|null} host
     * @returns {Promise<(Entry & { edit: boolean })|null>}
     */
    async lastFor(host) {
      if (host === null) return null;
      const entry = (await read()).find((candidate) => candidate.host === host);
      return entry ? { ...entry, edit: entry.mode === EDIT_MODE } : null;
    },
    /** @returns {Promise<void>} */
    clear() {
      clears += 1;
      return enqueue(() => area.set({ history: [] }));
    },
  };
}
