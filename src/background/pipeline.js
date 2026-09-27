import * as openai from './providers/openai.js';
import * as gemini from './providers/gemini.js';
import { PROVIDERS } from '../shared/models.js';
import { fillTemplate } from '../shared/text.js';
import { estimateSttCost, estimateTextCost } from '../shared/pricing.js';
import { ProviderError } from './providers/errors.js';

export const ADAPTERS = { openai, gemini };
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * `warning` is set when the mode step failed or returned nothing and the raw transcript
 * was kept; null otherwise.
 * @typedef {{ raw: string, text: string, provider: 'openai'|'gemini', sttModel: string,
 *             textModel: string|null, audioSeconds: number, cost: number,
 *             warning: string|null }} DictationResult
 */

/** @param {unknown} err */
function refineFailureMessage(err) {
  const e = /** @type {{ name?: string, message?: string }} */ (err);
  if (e?.name === 'ProviderError' && typeof e.message === 'string' && e.message.trim()) return e.message;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'Request timed out.';
  return 'Text model failed.';
}

/** @param {unknown} value */
function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** @param {string} text */
function asSentence(text) {
  const t = String(text).trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * Transcribe, then apply the active mode's prompt with the text model when it has one.
 * @param {{ audioBase64: string, mimeType?: string, modeKey: string,
 *           settings: import('../shared/defaults.js').Settings, durationSec: number }} args
 * @param {typeof ADAPTERS} [adapters]
 * @param {number} [timeoutMs]
 * @returns {Promise<DictationResult>}
 */
export async function runDictation({ audioBase64, mimeType = 'audio/webm', modeKey, settings, durationSec }, adapters = ADAPTERS, timeoutMs = REQUEST_TIMEOUT_MS) {
  const provider = Object.hasOwn(adapters, settings.provider) ? settings.provider : 'openai';
  const key = trimmed(settings.keys?.[provider]);
  if (!key) {
    throw new ProviderError(`${PROVIDERS[provider].label} API key not set. Click the extension icon to add it.`, { code: 'no_key' });
  }
  const mode = settings.modes?.[modeKey] || settings.modes?.default || { prompt: '' };
  const adapter = adapters[provider];
  const signal = AbortSignal.timeout(timeoutMs);

  const stt = await adapter.transcribe({
    audioBase64, mimeType, key,
    languages: settings.languages || [],
    keywords: settings.keywords || [],
    signal,
  });
  const raw = (stt.text || '').trim();
  if (!raw) throw new ProviderError('No speech detected.', { code: 'empty' });

  let text = raw;
  let textUsage = null; // set whenever the text model answered, so an empty answer is still billed
  let refined = false;
  let warning = null;
  // A non-string prompt (hand-edited or corrupt storage) means STT only, like an empty one.
  const instructions = trimmed(mode.prompt);
  if (instructions) {
    const filled = fillTemplate(instructions, { targetLanguage: trimmed(settings.translateTargetLang) || 'English' });
    try {
      const out = await adapter.refine({ key, instructions: filled, text: raw, signal });
      textUsage = out.usage || null;
      const refinedText = (out.text || '').trim();
      if (refinedText) {
        text = refinedText;
        refined = true;
      } else {
        warning = 'Mode returned nothing. Raw transcript inserted.';
      }
    } catch (err) {
      warning = `Mode not applied: ${asSentence(refineFailureMessage(err))} Raw transcript inserted.`;
    }
  }

  const sttModel = PROVIDERS[provider].stt;
  const textModel = refined ? PROVIDERS[provider].text : null;
  const audioSeconds = stt.usage?.kind === 'duration' ? stt.usage.seconds : durationSec;
  const cost = estimateSttCost(sttModel, stt.usage, durationSec) + estimateTextCost(PROVIDERS[provider].text, textUsage);

  return { raw, text, provider, sttModel, textModel, audioSeconds, cost, warning };
}
