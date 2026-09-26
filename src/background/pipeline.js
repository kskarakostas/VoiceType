import * as openai from './providers/openai.js';
import * as gemini from './providers/gemini.js';
import { PROVIDERS } from '../shared/models.js';
import { fillTemplate } from '../shared/text.js';
import { estimateSttCost, estimateTextCost } from '../shared/pricing.js';
import { ProviderError } from './providers/errors.js';

export const ADAPTERS = { openai, gemini };
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * @typedef {{ raw: string, text: string, provider: 'openai'|'gemini', sttModel: string,
 *             textModel: string|null, audioSeconds: number, cost: number }} DictationResult
 */

/**
 * Transcribe, then apply the active mode's prompt with the text model when it has one.
 * @param {{ audioBase64: string, mimeType?: string, modeKey: string,
 *           settings: import('../shared/defaults.js').Settings, durationSec: number }} args
 * @param {typeof ADAPTERS} [adapters]
 * @param {number} [timeoutMs]
 * @returns {Promise<DictationResult>}
 */
export async function runDictation({ audioBase64, mimeType = 'audio/webm', modeKey, settings, durationSec }, adapters = ADAPTERS, timeoutMs = REQUEST_TIMEOUT_MS) {
  const provider = settings.provider in adapters ? settings.provider : 'openai';
  const key = settings.keys?.[provider] || '';
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
  let textUsage = null;
  const instructions = (mode.prompt || '').trim();
  if (instructions) {
    const filled = fillTemplate(instructions, { targetLanguage: settings.translateTargetLang || 'English' });
    const refined = await adapter.refine({ key, instructions: filled, text: raw, signal });
    text = (refined.text || '').trim() || raw;
    textUsage = refined.usage || null;
  }

  const sttModel = PROVIDERS[provider].stt;
  const textModel = textUsage ? PROVIDERS[provider].text : null;
  const audioSeconds = stt.usage?.kind === 'duration' ? stt.usage.seconds : durationSec;
  const cost = estimateSttCost(sttModel, stt.usage, durationSec) + (textModel ? estimateTextCost(textModel, textUsage) : 0);

  return { raw, text, provider, sttModel, textModel, audioSeconds, cost };
}
