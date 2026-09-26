import { PROVIDERS } from '../../shared/models.js';
import { sanitizeHint } from '../../shared/text.js';
import { friendlyHttpError } from './errors.js';

const BASE = 'https://api.openai.com/v1';

/**
 * @param {{ audioBase64: string, mimeType?: string, key: string, languages?: string[], keywords?: string[], prompt?: string, signal?: AbortSignal }} args
 * @returns {Promise<{ text: string, usage: import('../../shared/pricing.js').SttUsage|null, languages: string[] }>}
 */
export async function transcribe({ audioBase64, mimeType = 'audio/webm', key, languages = [], keywords = [], prompt = '', signal }) {
  const form = new FormData();
  form.append('file', base64ToBlob(audioBase64, mimeType), 'recording.webm');
  form.append('model', PROVIDERS.openai.stt);
  form.append('response_format', 'json');
  for (const code of languages) form.append('languages[]', code);
  for (const keyword of keywords) {
    const clean = sanitizeHint(keyword, 64);
    if (clean) form.append('keywords[]', clean);
  }
  const hint = sanitizeHint(prompt);
  if (hint) form.append('prompt', hint);

  const res = await fetch(`${BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal,
  });
  if (!res.ok) throw friendlyHttpError('openai', res.status, await readErrorMessage(res));
  const data = await res.json();
  return {
    text: String(data.text || '').trim(),
    usage: normalizeSttUsage(data.usage),
    languages: Array.isArray(data.languages) ? data.languages.map((l) => l?.code).filter(Boolean) : [],
  };
}

/**
 * Apply a mode prompt to a transcript with the text model.
 * @param {{ key: string, instructions: string, text: string, signal?: AbortSignal }} args
 * @returns {Promise<{ text: string, usage: import('../../shared/pricing.js').TextUsage }>}
 */
export async function refine({ key, instructions, text, signal }) {
  const res = await fetch(`${BASE}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: PROVIDERS.openai.text, instructions, input: text, reasoning: { effort: 'none' } }),
    signal,
  });
  if (!res.ok) throw friendlyHttpError('openai', res.status, await readErrorMessage(res));
  const data = await res.json();
  return {
    text: extractOutputText(data).trim(),
    usage: { inputTokens: data.usage?.input_tokens || 0, outputTokens: data.usage?.output_tokens || 0 },
  };
}

/** @param {{ key: string, signal?: AbortSignal }} args */
export async function validateKey({ key, signal }) {
  const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${key}` }, signal });
  if (!res.ok) throw friendlyHttpError('openai', res.status, await readErrorMessage(res));
  return true;
}

/** Responses API: concatenate every output_text part of every message item. */
export function extractOutputText(data) {
  const parts = [];
  for (const item of data?.output || []) {
    if (item?.type !== 'message') continue;
    for (const c of item.content || []) {
      if (c?.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('');
}

/**
 * Null on any unexpected shape so pricing falls back to the recording length; never throws.
 * @returns {import('../../shared/pricing.js').SttUsage|null}
 */
export function normalizeSttUsage(usage) {
  try {
    if (!usage || typeof usage !== 'object') return null;
    if (usage.type === 'duration') return { kind: 'duration', seconds: Number(usage.seconds) || 0 };
    if (usage.type === 'tokens') {
      return {
        kind: 'tokens',
        audioTokens: usage.input_token_details?.audio_tokens || 0,
        textTokens: usage.input_token_details?.text_tokens || 0,
        outputTokens: usage.output_tokens || 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

async function readErrorMessage(res) {
  try {
    const body = await res.json();
    return body?.error?.message || '';
  } catch {
    return '';
  }
}
