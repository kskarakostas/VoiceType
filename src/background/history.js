/** How many recent dictations are held (V26). */
export const MAX_HISTORY = 20;

/**
 * @typedef {{ id: string, raw: string, text: string, mode: string, host: string|null, ts: number }} Entry
 * `mode` is the mode key; `host` is the site key of the recording tab, or null.
 */

/**
 * Recent dictations, newest first. Writes run through one promise queue of their own, so two adds
 * lose nothing and a hung settings or usage write never holds this one, nor the reverse. Reads go
 * to `area` each time and skip the queue: the worker may have restarted since the last add, and a
 * hung write must not hold a menu that is opening.
 * @param {{ area: { get: (key: string) => Promise<Record<string, unknown>>, set: (items: Record<string, unknown>) => Promise<void> } }} deps
 */
export function createHistory({ area }) {
  let tail = Promise.resolve();

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
     * @param {Omit<Entry, 'id'|'ts'>} entry
     * @returns {Promise<void>}
     */
    add(entry) {
      return enqueue(async () => {
        const added = { ...entry, id: crypto.randomUUID(), ts: Date.now() };
        await area.set({ history: [added, ...await read()].slice(0, MAX_HISTORY) });
      });
    },
    /** @returns {Promise<Entry[]>} */
    list() {
      return read();
    },
    /**
     * The newest entry dictated on exactly this site. A null host matches nothing (V28).
     * @param {string|null} host
     * @returns {Promise<Entry|null>}
     */
    async lastFor(host) {
      if (host === null) return null;
      return (await read()).find((entry) => entry.host === host) ?? null;
    },
    /** @returns {Promise<void>} */
    clear() {
      return enqueue(() => area.set({ history: [] }));
    },
  };
}
