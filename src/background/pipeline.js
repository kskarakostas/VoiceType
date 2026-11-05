import * as openai from './providers/openai.js';
import * as gemini from './providers/gemini.js';
import { PROVIDERS } from '../shared/models.js';
import { fillTemplate } from '../shared/text.js';
import { flattenDictionary } from '../shared/dictionary.js';
import { estimateSttCost, estimateTextCost } from '../shared/pricing.js';
import { ProviderError } from './providers/errors.js';
import { EDIT_INSTRUCTIONS, editInput } from './edit-prompt.js';

export const ADAPTERS = { openai, gemini };
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * `warning` is set when the mode step failed or returned nothing and the raw transcript
 * was kept; null otherwise. `failed` is true when an edit's text step failed or returned nothing:
 * `text` is then the instruction, which is never inserted, and `warning` is null.
 * @typedef {{ raw: string, text: string, provider: 'openai'|'gemini', sttModel: string,
 *             textModel: string|null, audioSeconds: number, cost: number,
 *             warning: string|null, failed: boolean }} DictationResult
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
 * What the text model is asked: the fixed edit request, or the mode's prompt over the transcript.
 * @param {{ raw: string, modeKey: string, settings: import('../shared/defaults.js').Settings, editText: string|null }} args
 * @returns {{ instructions: string, text: string }|null} Null means speech to text only.
 */
function textRequest({ raw, modeKey, settings, editText }) {
  if (editText !== null) return { instructions: EDIT_INSTRUCTIONS, text: editInput(raw, editText) };
  const mode = settings.modes?.[modeKey] || settings.modes?.default || { prompt: '' };
  // A non-string prompt (hand-edited or corrupt storage) means STT only, like an empty one.
  const prompt = trimmed(mode.prompt);
  if (!prompt) return null;
  return { instructions: fillTemplate(prompt, { targetLanguage: trimmed(settings.translateTargetLang) || 'English' }), text: raw };
}

/**
 * Transcribe, then apply the active mode's prompt with the text model when it has one. With
 * `editText`, the transcript is an instruction for that text and the mode does not apply.
 * @param {{ audioBase64: string, mimeType?: string, modeKey: string,
 *           settings: import('../shared/defaults.js').Settings, durationSec: number, editText?: string|null }} args
 * @param {typeof ADAPTERS} [adapters]
 * @param {number} [timeoutMs]
 * @returns {Promise<DictationResult>}
 */
export async function runDictation({ audioBase64, mimeType = 'audio/webm', modeKey, settings, durationSec, editText = null }, adapters = ADAPTERS, timeoutMs = REQUEST_TIMEOUT_MS) {
  const provider = Object.hasOwn(adapters, settings.provider) ? settings.provider : 'openai';
  const key = trimmed(settings.keys?.[provider]);
  if (!key) {
    throw new ProviderError(`${PROVIDERS[provider].label} API key not set. Add it in VoiceType settings.`, { code: 'no_key' });
  }
  const adapter = adapters[provider];
  const signal = AbortSignal.timeout(timeoutMs);

  const stt = await adapter.transcribe({
    audioBase64, mimeType, key,
    languages: settings.languages || [],
    keywords: flattenDictionary(settings.dictionary),
    signal,
  });
  const raw = (stt.text || '').trim();
  if (!raw) throw new ProviderError('No speech detected.', { code: 'empty' });

  let text = raw;
  let textUsage = null; // set whenever the text model answered, so an empty answer is still billed
  let refined = false;
  let warning = null;
  const request = textRequest({ raw, modeKey, settings, editText });
  if (request) {
    try {
      const out = await adapter.refine({ key, ...request, signal });
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

  const failed = editText !== null && !refined;
  const sttModel = PROVIDERS[provider].stt;
  const textModel = refined ? PROVIDERS[provider].text : null;
  const audioSeconds = stt.usage?.kind === 'duration' ? stt.usage.seconds : durationSec;
  const cost = estimateSttCost(sttModel, stt.usage, durationSec) + estimateTextCost(PROVIDERS[provider].text, textUsage);

  return { raw, text, provider, sttModel, textModel, audioSeconds, cost, warning: failed ? null : warning, failed };
}
