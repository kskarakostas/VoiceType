// The audio of one dictation, held in chrome.storage.session while the provider call runs, so the
// worker after a stopped one can run it again (V51). RAM only, and not open to content scripts.
// Nothing but this path writes it, and no part of it ever reaches a log line.

const KEY = 'pendingDictation';

/**
 * @typedef {{
 *   captureId: string, endpoint: import('./recorder.js').Endpoint, modeKey: string, host: string|null, incognito: boolean,
 *   sounds: boolean, alwaysCopy: boolean, audioBase64: string, mimeType: string, durationSec: number, editText: string|null,
 *   bootId: string, at: number, attempts: number,
 * }} PendingRecord
 * `bootId` is the worker that holds it, `at` when the audio arrived, `attempts` the runs after the first.
 */

/**
 * Writes run in order, each after the last settled: a clear lands after a slow save, never before it.
 * @param {{ area: { get: (key: string) => Promise<Record<string, unknown>>, set: (items: Record<string, unknown>) => Promise<void>, remove: (key: string) => Promise<void> } }} deps
 */
export function createPending({ area }) {
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

  return {
    /** @param {PendingRecord} record @returns {Promise<void>} */
    save: (record) => enqueue(() => area.set({ [KEY]: record })),
    /** @returns {Promise<PendingRecord|null>} */
    async read() {
      const { [KEY]: record } = await area.get(KEY);
      return /** @type {PendingRecord|undefined} */ (record) ?? null;
    },
    /** @returns {Promise<void>} */
    clear: () => enqueue(() => area.remove(KEY)),
  };
}
