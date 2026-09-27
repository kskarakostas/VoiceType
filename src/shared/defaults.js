// Single source of truth for the settings shape, built-in modes, migration and validation.
import { LEGACY_PROVIDER_OF_MODEL, PROVIDERS, deepFreeze } from './models.js';
import { isValidChord } from './chord.js';

export const SETTINGS_VERSION = 2;

/** Silence auto-stop choices in seconds; 0 turns it off. */
export const AUTO_STOP_CHOICES = Object.freeze([0, 2, 3, 5]);

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
 *   hotkey: import('./chord.js').Chord,
 *   autoStopSilenceSec: number,
 *   modes: Record<string, Mode>,
 * }} Settings
 * @typedef {Omit<Settings, 'keys'> & { hasKey: { openai: boolean, gemini: boolean } }} PublicSettings
 */

/** @type {Record<string, Mode>} */
export const BUILTIN_MODES = deepFreeze({
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
export const DEFAULT_SETTINGS = deepFreeze({
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
  hotkey: { code: 'Space', ctrl: true, shift: true, alt: false, meta: false },
  autoStopSilenceSec: 0,
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

/** @param {unknown} v */
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
/** @param {unknown} v */
const isPositive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
/** @param {unknown} v */
const isNonNegative = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
/** @param {unknown} v */
const isNonBlank = (v) => typeof v === 'string' && v.trim() !== '';
/** @param {unknown} v */
const isProvider = (v) => typeof v === 'string' && Object.hasOwn(PROVIDERS, v);

/** Same reference when every entry is a string, else the string entries only. */
function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.every((item) => typeof item === 'string') ? value : value.filter((item) => typeof item === 'string');
}

/** Same reference when every provider has a string key, else a repaired copy (extra entries kept). */
function repairKeys(value) {
  const keys = isObject(value) ? value : {};
  const ok = keys === value && Object.keys(PROVIDERS).every((id) => typeof keys[id] === 'string');
  if (ok) return value;
  const out = { ...keys };
  for (const id of Object.keys(PROVIDERS)) if (typeof out[id] !== 'string') out[id] = '';
  return out;
}

/** Same reference when every mode is an object and every built-in is present, else a repaired copy. */
function repairModes(value) {
  const modes = isObject(value) ? value : {};
  const entries = Object.entries(modes).filter(([, mode]) => isObject(mode));
  const missing = Object.keys(BUILTIN_MODES).filter((key) => !Object.hasOwn(modes, key) || !isObject(modes[key]));
  if (modes === value && entries.length === Object.keys(modes).length && missing.length === 0) return value;
  const out = Object.fromEntries(entries);
  for (const key of missing) out[key] = structuredClone(BUILTIN_MODES[key]);
  return out;
}

/** v2 and newer: validate every field, repair only what is wrong, keep everything else. */
function migrateV2(v) {
  const fix = {};
  if (typeof v.settingsVersion !== 'number') fix.settingsVersion = SETTINGS_VERSION;
  if (!isProvider(v.provider)) fix.provider = DEFAULT_SETTINGS.provider;
  const keys = repairKeys(v.keys);
  if (keys !== v.keys) fix.keys = keys;
  const modes = repairModes(v.modes);
  if (modes !== v.modes) fix.modes = modes;
  if (!(typeof v.activeMode === 'string' && Object.hasOwn(modes, v.activeMode))) fix.activeMode = 'default';
  if (!isPositive(v.minRecordingTime)) fix.minRecordingTime = DEFAULT_SETTINGS.minRecordingTime;
  if (!isPositive(v.maxRecordingTime)) fix.maxRecordingTime = DEFAULT_SETTINGS.maxRecordingTime;
  if (!isNonBlank(v.translateTargetLang)) fix.translateTargetLang = DEFAULT_SETTINGS.translateTargetLang;
  const languages = stringList(v.languages);
  if (languages !== v.languages) fix.languages = languages;
  const keywords = stringList(v.keywords);
  if (keywords !== v.keywords) fix.keywords = keywords;
  if (!isNonNegative(v.pillGap)) fix.pillGap = DEFAULT_SETTINGS.pillGap;
  if (!isValidChord(v.hotkey)) fix.hotkey = DEFAULT_SETTINGS.hotkey;
  if (!AUTO_STOP_CHOICES.includes(v.autoStopSilenceSec)) fix.autoStopSilenceSec = DEFAULT_SETTINGS.autoStopSilenceSec;
  if (Object.keys(fix).length === 0) return v;
  // Clone so the result shares nothing with storage or with the frozen defaults.
  return structuredClone({ ...v, ...fix });
}

/** v1 (unversioned) to v2: recover keys and custom modes, replace built-in prompts. */
function migrateV1(v) {
  const s = freshSettings();
  if (isProvider(v.provider)) s.provider = v.provider;
  else s.provider = Object.hasOwn(LEGACY_PROVIDER_OF_MODEL, v.model) ? LEGACY_PROVIDER_OF_MODEL[v.model] : 'openai';
  s.keys.openai = recoverKey(v.apiKey, v.apiKeyEncrypted);
  s.keys.gemini = recoverKey(v.geminiKey, v.geminiKeyEncrypted);
  const maxTime = Number(v.maxRecordingTime);
  if (isPositive(maxTime)) s.maxRecordingTime = maxTime;
  if (isNonBlank(v.translateTargetLang)) s.translateTargetLang = v.translateTargetLang;
  if (isNonNegative(v.pillGap)) s.pillGap = v.pillGap;

  const text = (value, fallback) => (isNonBlank(value) ? value : fallback);
  for (const [key, mode] of Object.entries(isObject(v.modes) ? v.modes : {})) {
    if (!isObject(mode)) continue;
    if (Object.hasOwn(BUILTIN_MODES, key)) {
      const builtIn = BUILTIN_MODES[key];
      s.modes[key] = { ...structuredClone(builtIn), name: text(mode.name, builtIn.name), icon: text(mode.icon, builtIn.icon) };
    } else if (typeof mode.prompt === 'string') {
      s.modes[key] = { name: text(mode.name, key), icon: text(mode.icon, '🎯'), prompt: mode.prompt, builtIn: false };
    }
  }
  s.activeMode = typeof v.activeMode === 'string' && Object.hasOwn(s.modes, v.activeMode) ? v.activeMode : 'default';
  return s;
}

/**
 * Bring any stored value up to the current schema and repair invalid fields. Returns the
 * input reference when nothing needs to change so callers can skip the write.
 * @param {unknown} stored
 * @returns {Settings}
 */
export function migrateSettings(stored) {
  if (!isObject(stored)) return freshSettings();
  const v = /** @type {any} */ (stored);
  // Data from this or a newer version is never pushed through the v1 migration.
  return Number(v.settingsVersion) >= SETTINGS_VERSION ? migrateV2(v) : migrateV1(v);
}

/**
 * Settings safe to hand to a web page's content script: a deep copy without `keys`,
 * plus which providers have a non-blank key.
 * @param {Settings} settings
 * @returns {PublicSettings}
 */
export function toPublicSettings(settings) {
  const { keys, ...rest } = settings;
  const hasKey = /** @type {PublicSettings['hasKey']} */ (
    Object.fromEntries(Object.keys(PROVIDERS).map((id) => [id, isNonBlank(keys?.[id])])));
  return { ...structuredClone(rest), hasKey };
}

/** Fields a content script may change through `updateSettings`. */
export const CONTENT_PATCH_FIELDS = Object.freeze(['activeMode', 'provider', 'translateTargetLang']);

const MAX_TARGET_LANG_LENGTH = 40;

/**
 * Apply a whitelisted patch from a content script. Never mutates `settings`.
 * @param {Settings} settings
 * @param {unknown} patch
 * @returns {{ ok: true, settings: Settings } | { ok: false, error: string }}
 */
export function applySettingsPatch(settings, patch) {
  const invalid = { ok: false, error: 'Invalid settings.' };
  if (!isObject(patch)) return invalid;
  const p = /** @type {Record<string, unknown>} */ (patch);
  if (!Object.keys(p).every((field) => CONTENT_PATCH_FIELDS.includes(field))) return invalid;
  const next = { ...settings };
  if (Object.hasOwn(p, 'activeMode')) {
    if (typeof p.activeMode !== 'string' || !isObject(settings.modes) || !Object.hasOwn(settings.modes, p.activeMode)) return invalid;
    next.activeMode = p.activeMode;
  }
  if (Object.hasOwn(p, 'provider')) {
    if (!isProvider(p.provider)) return invalid;
    next.provider = /** @type {Settings['provider']} */ (p.provider);
  }
  if (Object.hasOwn(p, 'translateTargetLang')) {
    const lang = typeof p.translateTargetLang === 'string' ? p.translateTargetLang.trim() : '';
    if (!lang || lang.length > MAX_TARGET_LANG_LENGTH) return invalid;
    next.translateTargetLang = lang;
  }
  return { ok: true, settings: next };
}
