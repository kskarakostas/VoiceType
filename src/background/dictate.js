import { redact } from './providers/errors.js';
import { warnFailure } from './router.js';
import { countWords } from './usage.js';

/** Once a transcript exists, the bookkeeping shares this long (V34), then the result goes out regardless. */
export const BOOKKEEPING_LIMIT_MS = 2000;

/**
 * Run the bookkeeping for a finished transcript together, under one limit. Never throws: logging is
 * bookkeeping, and a paid transcript is never lost over it. Each write has its own catch and warning,
 * so one failing hides nothing of the other. A write past the limit runs on unawaited.
 * @param {{ warning: string, write: () => Promise<unknown> }[]} writes The warning never carries the transcript.
 * @returns {Promise<void>}
 */
async function keepBooks(writes) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Bookkeeping timed out.')), BOOKKEEPING_LIMIT_MS);
  });
  await Promise.allSettled(writes.map(async ({ warning, write }) => {
    try {
      await Promise.race([write(), expired]);
    } catch (err) {
      console.warn(warning, err);
    }
  }));
  clearTimeout(timer);
}

/**
 * One dictation from recorded audio to the message the tab receives. Never throws.
 * @param {{
 *   storage: Pick<ReturnType<import('./storage.js').createStorage>, 'getSettings'|'updateUsageLog'>,
 *   history: Pick<ReturnType<import('./history.js').createHistory>, 'mark'|'add'>,
 *   runDictation: typeof import('./pipeline.js').runDictation,
 *   applyUsage: typeof import('./usage.js').applyUsage,
 *   userMessage: typeof import('./router.js').userMessage,
 * }} deps
 * @returns {(input: { audioBase64: string, mimeType: string, modeKey: string, durationSec: number, host: string|null, incognito: boolean }) => Promise<import('../shared/messages.js').DictationMessage>}
 */
export function createDictate({ storage, history, runDictation, applyUsage, userMessage }) {
  return async function dictate({ audioBase64, mimeType, modeKey, durationSec, host, incognito }) {
    // Before the settings read: a clear after this point, even during that read, drops the entry (V27).
    const mark = history.mark();
    let settings;
    let result;
    try {
      settings = await storage.getSettings();
      result = await runDictation({ audioBase64, mimeType, modeKey, durationSec, settings });
    } catch (err) {
      warnFailure(err);
      // The text goes to a web page: redact again in case a provider echoed a key.
      return { success: false, error: redact(userMessage(err)), tone: 'error' };
    }
    const writes = [{
      warning: 'VoiceType: usage logging failed',
      write: () => storage.updateUsageLog((log) => applyUsage(log, {
        provider: result.provider, audioSeconds: result.audioSeconds, cost: result.cost, mode: modeKey,
        words: countWords(result.raw),
      })),
    }];
    if (settings.keepHistory === true && !incognito) {
      writes.push({
        warning: 'VoiceType: history write failed',
        write: () => history.add({ raw: result.raw, text: result.text, mode: modeKey, host }, mark),
      });
    }
    await keepBooks(writes);
    return { success: true, text: result.text, raw: result.raw, cost: result.cost, warning: result.warning ?? null };
  };
}
