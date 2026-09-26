import { MSG } from '../shared/messages.js';
import { emptyLog } from './usage.js';
import { redact } from './providers/errors.js';

/**
 * Turn any thrown value into text safe to show on a web page.
 * @param {unknown} err
 * @param {{ context?: 'validate' }} [options] 'validate' words timeouts for the popup key check.
 */
export function userMessage(err, { context } = {}) {
  if (err && typeof err === 'object') {
    const e = /** @type {{ name?: string, message?: string }} */ (err);
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return context === 'validate' ? 'Key check timed out. Try again.' : 'Request timed out. Try a shorter recording.';
    }
    if (e.name === 'ProviderError') return String(e.message);
    // fetch() rejects with a TypeError on network failure; other TypeErrors are bugs.
    if (err instanceof TypeError && /fetch|network/i.test(err.message)) return 'Network error. Check your connection.';
  }
  return 'Something went wrong. Try again.';
}

/** Log a failure for debugging without ever writing a key to the console. */
function warnFailure(err) {
  const e = /** @type {{ name?: string, message?: string }} */ (err);
  console.warn('VoiceType: ' + redact(e?.name + ': ' + e?.message));
}

/**
 * @param {{
 *   storage: ReturnType<import('./storage.js').createStorage>,
 *   runDictation: typeof import('./pipeline.js').runDictation,
 *   validateKey: (provider: string, key: string) => Promise<boolean>,
 *   applyUsage: typeof import('./usage.js').applyUsage,
 *   summarize: typeof import('./usage.js').summarize,
 *   toggleActiveTab: () => Promise<boolean>,
 * }} deps
 */
export function createRouter({ storage, runDictation, validateKey, applyUsage, summarize, toggleActiveTab }) {
  return async function handle(request) {
    switch (request?.action) {
      case MSG.GET_SETTINGS:
        return storage.getSettings();

      case MSG.SAVE_SETTINGS: {
        const next = request.settings;
        if (!next || typeof next !== 'object' || Array.isArray(next)) return { success: false, error: 'Invalid settings.' };
        // Content scripts never send keys; keep the stored ones. An explicit keys object (popup) wins.
        const current = await storage.getSettings();
        const keys = (next.keys && typeof next.keys === 'object' && !Array.isArray(next.keys)) ? next.keys : current.keys;
        await storage.saveSettings({ ...next, keys });
        return { success: true };
      }

      case MSG.CHECK_KEY: {
        const settings = await storage.getSettings();
        return { hasKey: Boolean(settings.keys?.[settings.provider]) };
      }

      case MSG.VALIDATE_KEY:
        try {
          await validateKey(request.provider, request.key);
          return { ok: true };
        } catch (err) {
          warnFailure(err);
          return { ok: false, error: userMessage(err, { context: 'validate' }) };
        }

      case MSG.TRANSCRIBE: {
        const settings = await storage.getSettings();
        try {
          const result = await runDictation({
            audioBase64: request.audioBase64,
            mimeType: request.mimeType || 'audio/webm',
            modeKey: request.mode,
            settings,
            durationSec: Number(request.audioDuration) || 0,
          });
          try {
            const log = applyUsage(await storage.getUsageLog(), {
              provider: result.provider, audioSeconds: result.audioSeconds, cost: result.cost, mode: request.mode,
            });
            await storage.setUsageLog(log);
          } catch (err) {
            // Logging is bookkeeping; never lose a paid transcript over it.
            console.warn('VoiceType: usage logging failed', err);
          }
          return { success: true, text: result.text, raw: result.raw, cost: result.cost, warning: result.warning ?? null };
        } catch (err) {
          warnFailure(err);
          return { success: false, error: userMessage(err) };
        }
      }

      case MSG.GET_USAGE:
        return summarize(await storage.getUsageLog());

      case MSG.CLEAR_USAGE:
        await storage.setUsageLog(emptyLog());
        return { success: true };

      case MSG.TOGGLE_RECORDING:
        await toggleActiveTab();
        return { success: true };

      default:
        return undefined;
    }
  };
}
