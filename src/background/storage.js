import { migrateSettings, SETTINGS_VERSION } from '../shared/defaults.js';
import { emptyLog } from './usage.js';

/**
 * @param {{ get: (key: string) => Promise<Record<string, unknown>>, set: (items: Record<string, unknown>) => Promise<void> }} area
 */
export function createStorage(area) {
  return {
    /** @returns {Promise<import('../shared/defaults.js').Settings>} */
    async getSettings() {
      const { settings } = await area.get('settings');
      const migrated = migrateSettings(settings);
      if (migrated !== settings) await area.set({ settings: migrated });
      return migrated;
    },
    /** @param {import('../shared/defaults.js').Settings} settings */
    async saveSettings(settings) {
      await area.set({ settings: { ...settings, settingsVersion: SETTINGS_VERSION } });
    },
    /** @returns {Promise<import('./usage.js').UsageLog>} */
    async getUsageLog() {
      const { usageLog } = await area.get('usageLog');
      return usageLog && usageLog.version === 2 ? usageLog : emptyLog();
    },
    /** @param {import('./usage.js').UsageLog} usageLog */
    async setUsageLog(usageLog) {
      await area.set({ usageLog });
    },
  };
}
