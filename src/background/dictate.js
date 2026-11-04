import { redact } from './providers/errors.js';
import { warnFailure } from './router.js';
import { countWords } from './usage.js';

/** Once a transcript exists, the bookkeeping shares this long (V34), then the result goes out regardless. */
export const BOOKKEEPING_LIMIT_MS = 2000;

/**
 * Run the bookkeeping for a finished transcript under the limit. Never throws: logging is
 * bookkeeping, and a paid transcript is never lost over it. A step past the limit runs on unawaited.
 * @param {() => Promise<unknown>} step
 * @returns {Promise<void>}
 */
async function keepBooks(step) {
  let timer;
  try {
    await Promise.race([
      step(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Bookkeeping timed out.')), BOOKKEEPING_LIMIT_MS);
      }),
    ]);
  } catch (err) {
    console.warn('VoiceType: usage logging failed', err);
  } finally {
    clearTimeout(timer);
  }
}

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
    await keepBooks(() => storage.updateUsageLog((log) => applyUsage(log, {
      provider: result.provider, audioSeconds: result.audioSeconds, cost: result.cost, mode: modeKey,
      words: countWords(result.raw),
    })));
    return { success: true, text: result.text, raw: result.raw, cost: result.cost, warning: result.warning ?? null };
  };
}
