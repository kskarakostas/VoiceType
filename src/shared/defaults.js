// Single source of truth for the settings shape, built-in modes and migration.

export const SETTINGS_VERSION = 2;

/**
 * @typedef {{ name: string, icon: string, prompt: string, builtIn: boolean, hasLanguageOption?: boolean }} Mode
 * @typedef {{
 *   settingsVersion: number,
 *   provider: 'openai'|'gemini',
 *   keys: { openai: string, gemini: string },
 *   activeMode: string,
 *   minRecordingTime: number,
 *   maxRecordingTime: number,
 *   translateTargetLang: string,
 *   languages: string[],
 *   keywords: string[],
 *   pillGap: number,
 *   modes: Record<string, Mode>,
 * }} Settings
 */

/** @type {Record<string, Mode>} */
export const BUILTIN_MODES = Object.freeze({
  default: { name: 'Default', icon: '🎤', builtIn: true, prompt: '' },
  email: {
    name: 'Email', icon: '📧', builtIn: true,
    prompt: [
      'You receive the raw transcript of a dictated message. Write it as a ready-to-send, semi-formal email.',
      'Rules:',
      '- Output only the email text, nothing else.',
      '- Start with a greeting and end with a sign-off. If no recipient name was spoken, use a generic greeting; never insert placeholders such as [Name].',
      '- Organize the content into clear paragraphs and keep every fact and request from the transcript.',
      '- Remove filler words, false starts and spoken self-corrections; keep the corrected version.',
      '- Do not add commentary, a title or a subject line.',
    ].join('\n'),
  },
  translate: {
    name: 'Translate', icon: '🌐', builtIn: true, hasLanguageOption: true,
    prompt: [
      'You receive the raw transcript of dictated speech in any language. Translate it into {{targetLanguage}}.',
      'Rules:',
      '- Output only the translation, nothing else.',
      '- Preserve meaning, tone and register; remove filler words and false starts.',
      '- Do not add notes, labels or the original text.',
    ].join('\n'),
  },
  instruct: {
    name: 'Instruct', icon: '💡', builtIn: true,
    prompt: [
      'You receive the raw transcript of a spoken request. Carry out the request and output only the result.',
      'Rules:',
      '- Do not repeat or paraphrase the request and do not add a preamble.',
      '- If the request asks for text (an answer, a draft, code), output exactly that text.',
      '- Be concise but complete.',
    ].join('\n'),
  },
});

/** @type {Settings} */
export const DEFAULT_SETTINGS = Object.freeze({
  settingsVersion: SETTINGS_VERSION,
  provider: 'openai',
  keys: { openai: '', gemini: '' },
  activeMode: 'default',
  minRecordingTime: 1,
  maxRecordingTime: 120,
  translateTargetLang: 'English',
  languages: [],
  keywords: [],
  pillGap: 8,
  modes: BUILTIN_MODES,
});

/** @returns {Settings} */
export function freshSettings() {
  return structuredClone(DEFAULT_SETTINGS);
}

const XOR_KEY = 'VoiceType_2024_SecureKey';
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/**
 * v1 stored keys XOR-obfuscated and flagged. A v1 bug also stored plaintext with the
 * flag set, so a flagged value is decoded only when the result is printable ASCII.
 * @param {unknown} value
 * @param {unknown} flagged
 */
export function recoverKey(value, flagged) {
  if (typeof value !== 'string' || value === '') return '';
  if (!flagged) return value;
  try {
    const decoded = atob(value);
    let out = '';
    for (let i = 0; i < decoded.length; i++) {
      out += String.fromCharCode(decoded.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
    }
    return PRINTABLE_ASCII.test(out) ? out : value;
  } catch {
    return value;
  }
}

/**
 * Bring any stored value up to the current schema. Returns the input reference
 * when nothing needs to change so callers can skip the write.
 * @param {unknown} stored
 * @returns {Settings}
 */
export function migrateSettings(stored) {
  if (!stored || typeof stored !== 'object') return freshSettings();
  const v = /** @type {any} */ (stored);

  // Data from this or a newer version is never pushed through the v1 migration.
  if (typeof v.settingsVersion === 'number' && v.settingsVersion >= SETTINGS_VERSION) {
    const modesOk = !!v.modes && typeof v.modes === 'object' && !Array.isArray(v.modes);
    const missing = Object.keys(BUILTIN_MODES).filter((k) => !modesOk || !v.modes[k]);
    const keysOk = !!v.keys && typeof v.keys === 'object'
      && typeof v.keys.openai === 'string' && typeof v.keys.gemini === 'string';
    if (missing.length === 0 && keysOk) return v;
    const patched = structuredClone(v);
    if (!modesOk) patched.modes = {};
    for (const k of missing) patched.modes[k] = structuredClone(BUILTIN_MODES[k]);
    if (!keysOk) {
      const keys = patched.keys && typeof patched.keys === 'object' ? patched.keys : {};
      patched.keys = {
        ...keys,
        openai: typeof keys.openai === 'string' ? keys.openai : '',
        gemini: typeof keys.gemini === 'string' ? keys.gemini : '',
      };
    }
    return patched;
  }

  const s = freshSettings();
  s.provider = v.provider === 'gemini' ? 'gemini' : 'openai';
  s.keys.openai = recoverKey(v.apiKey, v.apiKeyEncrypted);
  s.keys.gemini = recoverKey(v.geminiKey, v.geminiKeyEncrypted);
  const maxTime = Number(v.maxRecordingTime);
  if (Number.isFinite(maxTime) && maxTime > 0) s.maxRecordingTime = maxTime;
  if (typeof v.translateTargetLang === 'string' && v.translateTargetLang) s.translateTargetLang = v.translateTargetLang;
  if (Number.isFinite(v.pillGap)) s.pillGap = v.pillGap;

  for (const [key, mode] of Object.entries(v.modes || {})) {
    if (!mode || typeof mode !== 'object') continue;
    if (BUILTIN_MODES[key]) {
      s.modes[key] = {
        ...structuredClone(BUILTIN_MODES[key]),
        name: mode.name || BUILTIN_MODES[key].name,
        icon: mode.icon || BUILTIN_MODES[key].icon,
      };
    } else if (typeof mode.prompt === 'string') {
      s.modes[key] = { name: mode.name || key, icon: mode.icon || '🎯', prompt: mode.prompt, builtIn: false };
    }
  }
  s.activeMode = typeof v.activeMode === 'string' && s.modes[v.activeMode] ? v.activeMode : 'default';
  return s;
}
