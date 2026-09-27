import { PROVIDERS } from '../../shared/models.js';
import { sanitizeHint } from '../../shared/text.js';
import { authError, friendlyHttpError } from './errors.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

const BCP47 = { en: 'en-US', el: 'el-GR', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', it: 'it-IT', pt: 'pt-PT', nl: 'nl-NL', tr: 'tr-TR' };

/** Gemini expects BCP-47 tags; settings store ISO 639-1 codes. */
export function toBcp47(code) {
  return BCP47[code] || code;
}

function headers(key) {
  return { 'x-goog-api-key': key, 'Content-Type': 'application/json' };
}

/**
 * @param {{ audioBase64: string, mimeType?: string, key: string, languages?: string[], keywords?: string[], signal?: AbortSignal }} args
 * @returns {Promise<{ text: string, usage: import('../../shared/pricing.js').SttUsage|null, languages: string[] }>}
 */
export async function transcribe({ audioBase64, mimeType = 'audio/webm', key, languages = [], keywords = [], signal }) {
  const audioTranscriptionConfig = { mode: 'SMART' };
  if (languages.length) audioTranscriptionConfig.languageCodes = languages.map(toBcp47);
  const vocabulary = keywords.map((k) => sanitizeHint(k, 64)).filter(Boolean);
  if (vocabulary.length) audioTranscriptionConfig.customVocabulary = vocabulary;

  const res = await fetch(`${BASE}/models/${PROVIDERS.gemini.stt}:generateContent`, {
    method: 'POST',
    headers: headers(key),
    body: JSON.stringify({
      contents: [{ parts: [{ inlineData: { mimeType, data: audioBase64 } }] }],
      generationConfig: { audioTranscriptionConfig },
    }),
    signal,
  });
  if (!res.ok) throw await httpError(res);
  const data = await res.json();
  return { text: joinParts(data).trim(), usage: normalizeSttUsage(data.usageMetadata), languages: [] };
}

/**
 * @param {{ key: string, instructions: string, text: string, signal?: AbortSignal }} args
 * @returns {Promise<{ text: string, usage: import('../../shared/pricing.js').TextUsage }>}
 */
export async function refine({ key, instructions, text, signal }) {
  const res = await fetch(`${BASE}/models/${PROVIDERS.gemini.text}:generateContent`, {
    method: 'POST',
    headers: headers(key),
    body: JSON.stringify({
      system_instruction: { parts: [{ text: instructions }] },
      contents: [{ parts: [{ text }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'low' } },
    }),
    signal,
  });
  if (!res.ok) throw await httpError(res);
  const data = await res.json();
  const meta = data.usageMetadata || {};
  return {
    text: joinParts(data).trim(),
    usage: { inputTokens: meta.promptTokenCount || 0, outputTokens: (meta.candidatesTokenCount || 0) + (meta.thoughtsTokenCount || 0) },
  };
}

/** @param {{ key: string, signal?: AbortSignal }} args */
export async function validateKey({ key, signal }) {
  const res = await fetch(`${BASE}/models?pageSize=1`, { headers: { 'x-goog-api-key': key }, signal });
  if (!res.ok) throw await httpError(res);
  return true;
}

/** Concatenate text parts of the first candidate, skipping thought parts. */
export function joinParts(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.filter((p) => typeof p?.text === 'string' && !p.thought).map((p) => p.text).join('');
}

/**
 * Audio tokens come from the AUDIO modality detail, else from promptTokenCount minus text.
 * Null when neither exists, or on any unexpected shape, so pricing falls back to the
 * recording length. Never throws.
 * @returns {import('../../shared/pricing.js').SttUsage|null}
 */
export function normalizeSttUsage(meta) {
  try {
    if (!meta || typeof meta !== 'object') return null;
    const byModality = {};
    if (Array.isArray(meta.promptTokensDetails)) {
      for (const d of meta.promptTokensDetails) {
        if (!d || typeof d !== 'object') continue;
        byModality[d.modality] = (byModality[d.modality] || 0) + (d.tokenCount || 0);
      }
    }
    const textTokens = byModality.TEXT || 0;
    let audioTokens;
    if (typeof byModality.AUDIO === 'number') audioTokens = byModality.AUDIO;
    else if (typeof meta.promptTokenCount === 'number') audioTokens = Math.max(0, meta.promptTokenCount - textTokens);
    else return null;
    return { kind: 'tokens', audioTokens, textTokens, outputTokens: meta.candidatesTokenCount || 0 };
  } catch {
    return null;
  }
}

const INVALID_KEY = /api key not valid|api key expired|API_KEY_(?:INVALID|EXPIRED)/i;

/** Map a failed response to a ProviderError. Gemini reports a bad or expired key as HTTP 400, not 401 or 403. */
async function httpError(res) {
  const error = (await readErrorBody(res))?.error;
  const message = typeof error?.message === 'string' ? error.message : '';
  const reasons = Array.isArray(error?.details) ? error.details.map((d) => d?.reason) : [];
  if (res.status === 400 && [message, ...reasons].some((s) => typeof s === 'string' && INVALID_KEY.test(s))) {
    return authError('gemini', 400);
  }
  return friendlyHttpError('gemini', res.status, message);
}

async function readErrorBody(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
