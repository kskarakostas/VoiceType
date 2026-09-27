import { redact } from './providers/errors.js';
import { warnFailure } from './router.js';

/**
 * One dictation from recorded audio to the message the tab receives. Never throws.
 * @param {{
 *   storage: Pick<ReturnType<import('./storage.js').createStorage>, 'getSettings'|'updateUsageLog'>,
 *   runDictation: typeof import('./pipeline.js').runDictation,
 *   applyUsage: typeof import('./usage.js').applyUsage,
 *   userMessage: typeof import('./router.js').userMessage,
 * }} deps
 * @returns {(input: { audioBase64: string, mimeType: string, modeKey: string, durationSec: number }) => Promise<import('../shared/messages.js').DictationMessage>}
 */
export function createDictate({ storage, runDictation, applyUsage, userMessage }) {
  return async function dictate({ audioBase64, mimeType, modeKey, durationSec }) {
    let result;
    try {
      const settings = await storage.getSettings();
      result = await runDictation({ audioBase64, mimeType, modeKey, durationSec, settings });
    } catch (err) {
      warnFailure(err);
      // The text goes to a web page: redact again in case a provider echoed a key.
      return { success: false, error: redact(userMessage(err)), tone: 'error' };
    }
    try {
      await storage.updateUsageLog((log) => applyUsage(log, {
        provider: result.provider, audioSeconds: result.audioSeconds, cost: result.cost, mode: modeKey,
      }));
    } catch (err) {
      // Logging is bookkeeping; never lose a paid transcript over it.
      console.warn('VoiceType: usage logging failed', err);
    }
    return { success: true, text: result.text, raw: result.raw, cost: result.cost, warning: result.warning ?? null };
  };
}
