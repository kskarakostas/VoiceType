// Single source of truth for model IDs, labels and list prices (USD).
// Prices are for estimates only. Change them here and nowhere else.

/**
 * @typedef {{ perMinute: number }} PerMinutePricing
 * @typedef {{ audioInputPerM: number, outputPerM: number }} AudioTokenPricing
 * @typedef {{ inputPerM: number, outputPerM: number }} TextTokenPricing
 * @typedef {{ provider: 'openai'|'gemini', kind: 'stt'|'text', label: string,
 *             pricing: PerMinutePricing|AudioTokenPricing|TextTokenPricing }} ModelInfo
 */

/** @type {Record<string, ModelInfo>} */
export const MODELS = Object.freeze({
  'gpt-transcribe': {
    provider: 'openai', kind: 'stt', label: 'GPT Transcribe',
    pricing: { perMinute: 0.0045 },
  },
  'gpt-6-luna': {
    provider: 'openai', kind: 'text', label: 'GPT-6 Luna',
    pricing: { inputPerM: 0.10, outputPerM: 0.50 },
  },
  'gemini-3.5-transcribe': {
    provider: 'gemini', kind: 'stt', label: 'Gemini 3.5 Transcribe',
    pricing: { audioInputPerM: 2.00, outputPerM: 12.00 },
  },
  'gemini-3.8-flash': {
    provider: 'gemini', kind: 'text', label: 'Gemini 3.8 Flash',
    // List price through 2026-12-31. From 2027-01-01: inputPerM 1.50, outputPerM 7.50.
    pricing: { inputPerM: 0.75, outputPerM: 3.75 },
  },
});

/** Gemini audio tokenisation rate used when the API returns no usage. */
export const GEMINI_AUDIO_TOKENS_PER_SECOND = 32;

export const PROVIDERS = Object.freeze({
  openai: { label: 'OpenAI', stt: 'gpt-transcribe', text: 'gpt-6-luna', keyPlaceholder: 'sk-...' },
  gemini: { label: 'Gemini', stt: 'gemini-3.5-transcribe', text: 'gemini-3.8-flash', keyPlaceholder: 'AQ.... or AIza...' },
});

/** v1 model ids, kept only so migration can recover the provider. Never sent to an API. */
export const LEGACY_PROVIDER_OF_MODEL = Object.freeze({
  'gpt-4o-transcribe': 'openai',
  'gpt-4o-mini-transcribe': 'openai',
  'gemini-2.5-flash': 'gemini',
  'gemini-3-flash-preview': 'gemini',
});
