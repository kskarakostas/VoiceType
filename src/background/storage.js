import { migrateSettings, SETTINGS_VERSION } from '../shared/defaults.js';
import { normalizeLog } from './usage.js';

/**
 * Settings and usage log persistence. Every call runs through one promise queue, so a
 * read-modify-write (usage logging, a settings patch) never interleaves with another write.
 * Update callbacks must be synchronous and must not call back into this storage object.
 * @param {{ get: (key: string) => Promise<Record<string, unknown>>, set: (items: Record<string, unknown>) => Promise<void> }} area
 */
export function createStorage(area) {
  let tail = Promise.resolve();

  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function enqueue(task) {
    const run = tail.then(task);
    tail = run.catch(() => {}); // a failed task must not block the ones queued after it
    return run;
  }

  /** @returns {Promise<import('../shared/defaults.js').Settings>} */
  async function readSettings() {
    const { settings } = await area.get('settings');
    const migrated = migrateSettings(settings);
    if (migrated !== settings) await area.set({ settings: migrated });
    return migrated;
  }

  /** @param {import('../shared/defaults.js').Settings} settings */
  async function writeSettings(settings) {
    const stamped = { ...settings, settingsVersion: SETTINGS_VERSION };
    await area.set({ settings: stamped });
    return stamped;
  }

  /** @returns {Promise<import('./usage.js').UsageLog>} */
  async function readUsageLog() {
    const { usageLog } = await area.get('usageLog');
    return normalizeLog(usageLog);
  }

  return {
    /** @returns {Promise<import('../shared/defaults.js').Settings>} */
    getSettings() {
      return enqueue(readSettings);
    },
    /**
     * @param {import('../shared/defaults.js').Settings} settings
     * @returns {Promise<void>}
     */
    saveSettings(settings) {
      return enqueue(async () => { await writeSettings(settings); });
    },
    /**
     * Read, transform and write the settings as one queued step. A callback result that is
     * not an object (null) writes nothing and resolves with the current settings.
     * @param {(current: import('../shared/defaults.js').Settings) => import('../shared/defaults.js').Settings|null} fn
     * @returns {Promise<import('../shared/defaults.js').Settings>}
     */
    updateSettings(fn) {
      return enqueue(async () => {
        const current = await readSettings();
        const next = fn(current);
        if (!next || typeof next !== 'object') return current;
        return writeSettings(next);
      });
    },
    /** @returns {Promise<import('./usage.js').UsageLog>} */
    getUsageLog() {
      return enqueue(readUsageLog);
    },
    /**
     * @param {import('./usage.js').UsageLog} usageLog
     * @returns {Promise<void>}
     */
    setUsageLog(usageLog) {
      return enqueue(() => area.set({ usageLog }));
    },
    /**
     * @param {(log: import('./usage.js').UsageLog) => import('./usage.js').UsageLog} fn
     * @returns {Promise<import('./usage.js').UsageLog>}
     */
    updateUsageLog(fn) {
      return enqueue(async () => {
        const next = fn(await readUsageLog());
        await area.set({ usageLog: next });
        return next;
      });
    },
  };
}
