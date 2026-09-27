import { describe, it, expect } from 'vitest';
import {
  SETTINGS_VERSION, BUILTIN_MODES, DEFAULT_SETTINGS, AUTO_STOP_CHOICES, CONTENT_PATCH_FIELDS,
  freshSettings, recoverKey, migrateSettings, toPublicSettings, applySettingsPatch, orderedModeKeys,
} from '../../../src/shared/defaults.js';
import { isValidChord } from '../../../src/shared/chord.js';

// v1 obfuscation, reproduced here so the tests can build realistic stored values.
const XOR_KEY = 'VoiceType_2024_SecureKey';
function v1Encrypt(key) {
  let out = '';
  for (let i = 0; i < key.length; i++) out += String.fromCharCode(key.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
  return btoa(out);
}

const V1_SETTINGS = {
  apiKey: v1Encrypt('sk-proj-abc123'), apiKeyEncrypted: true,
  geminiKey: 'AIzaSyD9x2KqL0mN3pQ7rS8tU1vW4xY5zA6bC7dE', geminiKeyEncrypted: true, // plaintext with flag: the v1 bug
  provider: 'gemini', model: 'gpt-4o-transcribe', geminiModel: 'gemini-2.5-flash',
  activeMode: 'custom_1', minRecordingTime: 0, maxRecordingTime: 180, translateTargetLang: 'Greek', pillGap: 12,
  modes: {
    default: { name: 'Default', prompt: 'You are a transcription assistant...', icon: '🎤' },
    email: { name: 'Mail', prompt: 'old audio prompt', icon: '✉️' },
    translate: { name: 'Translate', prompt: 'old', icon: '🌐', hasLanguageOption: true },
    instruct: { name: 'Instruct', prompt: 'old', icon: '💡' },
    custom_1: { name: 'Notes', prompt: 'Turn this into bullet notes.', icon: '📝' },
  },
  shortcuts: { toggleRecording: 'Ctrl+Shift+Space' },
};

const DEFAULT_HOTKEY = { code: 'Space', ctrl: true, shift: true, alt: false, meta: false };

/** A v2 record as Phase 0 stored it: no hotkey, no autoStopSilenceSec. */
function phase0Settings() {
  return {
    settingsVersion: 2,
    provider: 'gemini',
    keys: { openai: 'sk-proj-abc123', gemini: 'AQ.Ab8Rn2xyz' },
    activeMode: 'custom_1',
    minRecordingTime: 2,
    maxRecordingTime: 90,
    translateTargetLang: 'Greek',
    languages: ['el', 'en'],
    keywords: ['Palowise', 'Karakostas'],
    pillGap: 12,
    modes: {
      ...structuredClone(BUILTIN_MODES),
      custom_1: { name: 'Notes', icon: '📝', prompt: 'Turn this into bullet notes.', builtIn: false },
    },
  };
}

/** A v2 record with every field present and valid, none at its default. */
function fullSettings() {
  return {
    ...phase0Settings(),
    hotkey: { code: 'KeyD', ctrl: false, shift: false, alt: true, meta: false },
    autoStopSilenceSec: 3,
  };
}

describe('defaults', () => {
  it('default mode has no prompt and all built-ins are flagged', () => {
    expect(BUILTIN_MODES.default.prompt).toBe('');
    for (const mode of Object.values(BUILTIN_MODES)) expect(mode.builtIn).toBe(true);
    expect(BUILTIN_MODES.translate.hasLanguageOption).toBe(true);
    expect(BUILTIN_MODES.translate.prompt).toContain('{{targetLanguage}}');
  });
  it('freshSettings returns an independent deep copy', () => {
    const a = freshSettings();
    a.modes.email.name = 'changed';
    a.hotkey.alt = true;
    expect(DEFAULT_SETTINGS.modes.email.name).toBe('Email');
    expect(DEFAULT_SETTINGS.hotkey.alt).toBe(false);
    expect(freshSettings().modes.email.name).toBe('Email');
  });
  it('defaults the hotkey to Ctrl+Shift+Space and silence auto-stop to off', () => {
    expect(DEFAULT_SETTINGS.hotkey).toEqual(DEFAULT_HOTKEY);
    expect(isValidChord(DEFAULT_SETTINGS.hotkey)).toBe(true);
    expect(DEFAULT_SETTINGS.autoStopSilenceSec).toBe(0);
    expect(AUTO_STOP_CHOICES).toEqual([0, 2, 3, 5]);
    expect(Object.isFrozen(AUTO_STOP_CHOICES)).toBe(true);
  });
  it('deep-freezes DEFAULT_SETTINGS and BUILTIN_MODES', () => {
    for (const value of [DEFAULT_SETTINGS, DEFAULT_SETTINGS.keys, DEFAULT_SETTINGS.hotkey, DEFAULT_SETTINGS.languages, DEFAULT_SETTINGS.modes.email, BUILTIN_MODES, BUILTIN_MODES.translate]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => { DEFAULT_SETTINGS.keys.openai = 'sk-leak'; }).toThrow(TypeError);
    expect(() => { BUILTIN_MODES.email.prompt = ''; }).toThrow(TypeError);
  });
});

describe('recoverKey', () => {
  it('decodes a v1 obfuscated key', () => {
    expect(recoverKey(v1Encrypt('sk-proj-abc123'), true)).toBe('sk-proj-abc123');
  });
  it('flagged plaintext key survives', () => {
    const plain = 'AIzaSyD9x2KqL0mN3pQ7rS8tU1vW4xY5zA6bC7dE';
    expect(recoverKey(plain, true)).toBe(plain);
    expect(recoverKey('sk-proj-abc123', true)).toBe('sk-proj-abc123');
  });
  it('returns unflagged values unchanged and blanks non-strings', () => {
    expect(recoverKey('AQ.abc', false)).toBe('AQ.abc');
    expect(recoverKey(undefined, true)).toBe('');
    expect(recoverKey('', true)).toBe('');
  });
});

describe('migrateSettings', () => {
  it('returns fresh defaults for missing storage', () => {
    const s = migrateSettings(undefined);
    expect(s.settingsVersion).toBe(SETTINGS_VERSION);
    expect(s.keys).toEqual({ openai: '', gemini: '' });
    expect(Object.keys(s.modes)).toEqual(['default', 'email', 'translate', 'instruct']);
  });

  it('migrates a v1 object', () => {
    const s = migrateSettings(V1_SETTINGS);
    expect(s.settingsVersion).toBe(2);
    expect(s.provider).toBe('gemini');
    expect(s.keys.openai).toBe('sk-proj-abc123');
    expect(s.keys.gemini).toBe('AIzaSyD9x2KqL0mN3pQ7rS8tU1vW4xY5zA6bC7dE');
    expect(s.maxRecordingTime).toBe(180);
    expect(s.translateTargetLang).toBe('Greek');
    expect(s.pillGap).toBe(12);
    expect(s.activeMode).toBe('custom_1');
    expect(s.modes.custom_1).toEqual({ name: 'Notes', icon: '📝', prompt: 'Turn this into bullet notes.', builtIn: false });
    // built-in prompts are replaced (v1 prompts addressed audio), user names and icons kept
    expect(s.modes.email.prompt).toBe(BUILTIN_MODES.email.prompt);
    expect(s.modes.email.name).toBe('Mail');
    expect(s.modes.email.icon).toBe('✉️');
    expect(s.modes.email.builtIn).toBe(true);
    expect(s.modes.translate.hasLanguageOption).toBe(true);
    expect(s).not.toHaveProperty('model');
    expect(s).not.toHaveProperty('apiKey');
    expect(s).not.toHaveProperty('apiKeyEncrypted');
    expect(s.minRecordingTime).toBe(1);
    expect(s.hotkey).toEqual(DEFAULT_HOTKEY);
    expect(s.autoStopSilenceSec).toBe(0);
  });

  it('derives the provider from the legacy model when v1 stored none', () => {
    expect(migrateSettings({ model: 'gemini-2.5-flash', modes: {} }).provider).toBe('gemini');
    expect(migrateSettings({ model: 'gpt-4o-transcribe', modes: {} }).provider).toBe('openai');
    expect(migrateSettings({ model: 'toString', modes: {} }).provider).toBe('openai');
    expect(migrateSettings({ modes: {} }).provider).toBe('openai');
  });

  it('falls back to default when the active mode no longer exists', () => {
    const s = migrateSettings({ ...V1_SETTINGS, activeMode: 'gone' });
    expect(s.activeMode).toBe('default');
  });

  it('returns the same reference for a complete v2 object', () => {
    const v2 = freshSettings();
    expect(migrateSettings(v2)).toBe(v2);
  });

  it('adds missing built-in modes to a v2 object', () => {
    const v2 = freshSettings();
    delete v2.modes.instruct;
    const s = migrateSettings(v2);
    expect(s).not.toBe(v2);
    expect(s.modes.instruct).toEqual(BUILTIN_MODES.instruct);
  });

  it('passes through data from a newer settings version without touching keys', () => {
    const v3 = { ...freshSettings(), settingsVersion: 3 };
    v3.keys.openai = 'sk-newer';
    const s = migrateSettings(v3);
    expect(s).toBe(v3);
    expect(s.keys.openai).toBe('sk-newer');
  });

  it('restores a missing keys object on a v2 record', () => {
    const v2 = freshSettings();
    delete v2.keys;
    const s = migrateSettings(v2);
    expect(s).not.toBe(v2);
    expect(s.keys).toEqual({ openai: '', gemini: '' });
  });

  it('replaces a non-object modes value on a v2 record instead of throwing', () => {
    for (const bad of ['x', 5, true, []]) {
      const v2 = { ...freshSettings(), modes: bad };
      const s = migrateSettings(v2);
      expect(s).not.toBe(v2);
      expect(Object.keys(s.modes)).toEqual(['default', 'email', 'translate', 'instruct']);
    }
  });

  it('fills missing providers in a partial keys object without dropping present keys', () => {
    const v2 = { ...freshSettings(), keys: { openai: 'sk-a' } };
    const s = migrateSettings(v2);
    expect(s).not.toBe(v2);
    expect(s.keys).toEqual({ openai: 'sk-a', gemini: '' });
  });

  it('gives a Phase 0 v2 record the new defaults and keeps its keys and custom modes', () => {
    const stored = phase0Settings();
    const s = migrateSettings(stored);
    expect(s).not.toBe(stored);
    expect(s).toEqual({ ...phase0Settings(), hotkey: DEFAULT_HOTKEY, autoStopSilenceSec: 0 });
    expect(s.keys).toEqual({ openai: 'sk-proj-abc123', gemini: 'AQ.Ab8Rn2xyz' });
    expect(s.modes.custom_1).toEqual({ name: 'Notes', icon: '📝', prompt: 'Turn this into bullet notes.', builtIn: false });
    expect(s.activeMode).toBe('custom_1');
    expect(stored).not.toHaveProperty('hotkey');
    expect(Object.isFrozen(s.hotkey)).toBe(false);
    expect(migrateSettings(s)).toBe(s);
  });

  it('returns the same reference for a fully populated v2 record and leaves it untouched', () => {
    const stored = fullSettings();
    expect(migrateSettings(stored)).toBe(stored);
    expect(stored).toEqual(fullSettings());
  });

  it('keeps valid edge values', () => {
    const stored = { ...fullSettings(), pillGap: 0, minRecordingTime: 0.5, autoStopSilenceSec: 5, languages: [], keywords: [] };
    expect(migrateSettings(stored)).toBe(stored);
  });

  it('takes the v2 path for a string settings version and stores it as a number', () => {
    const s = migrateSettings({ ...fullSettings(), settingsVersion: '2' });
    expect(s.settingsVersion).toBe(2);
    expect(s.keys).toEqual(fullSettings().keys);
    expect(s.modes.custom_1).toEqual(fullSettings().modes.custom_1);
    expect(s.hotkey).toEqual(fullSettings().hotkey);
  });

  it('repairs each invalid field and keeps the rest', () => {
    const cases = [
      ['provider', 'toString', 'openai'],
      ['provider', 'anthropic', 'openai'],
      ['provider', 5, 'openai'],
      ['activeMode', 'gone', 'default'],
      ['activeMode', 'constructor', 'default'],
      ['activeMode', 7, 'default'],
      ['minRecordingTime', 0, 1],
      ['minRecordingTime', -1, 1],
      ['minRecordingTime', NaN, 1],
      ['minRecordingTime', '5', 1],
      ['maxRecordingTime', null, 120],
      ['maxRecordingTime', Infinity, 120],
      ['translateTargetLang', '', 'English'],
      ['translateTargetLang', '   ', 'English'],
      ['translateTargetLang', 5, 'English'],
      ['languages', 'el', []],
      ['languages', null, []],
      ['languages', ['el', 5, null, 'en'], ['el', 'en']],
      ['keywords', {}, []],
      ['keywords', ['a', {}, 'b'], ['a', 'b']],
      ['pillGap', -1, 8],
      ['pillGap', '12', 8],
      ['hotkey', null, DEFAULT_HOTKEY],
      ['hotkey', 'Ctrl+Shift+Space', DEFAULT_HOTKEY],
      ['hotkey', { code: 'KeyA', ctrl: false, shift: true, alt: false, meta: false }, DEFAULT_HOTKEY],
      ['hotkey', { code: 'ShiftLeft', ctrl: true, shift: true, alt: false, meta: false }, DEFAULT_HOTKEY],
      ['autoStopSilenceSec', 4, 0],
      ['autoStopSilenceSec', '2', 0],
      ['autoStopSilenceSec', null, 0],
    ];
    for (const [field, bad, expected] of cases) {
      const stored = { ...fullSettings(), [field]: bad };
      const s = migrateSettings(stored);
      const label = `${field} = ${JSON.stringify(bad)}`;
      expect(s, label).not.toBe(stored);
      expect(s[field], label).toEqual(expected);
      expect(s.keys, label).toEqual(fullSettings().keys);
      expect(s.modes, label).toEqual(fullSettings().modes);
      expect(migrateSettings(s), label).toBe(s);
    }
  });

  it('repairs keys that are not strings', () => {
    expect(migrateSettings({ ...fullSettings(), keys: { openai: 5, gemini: null } }).keys).toEqual({ openai: '', gemini: '' });
    expect(migrateSettings({ ...fullSettings(), keys: 'sk-x' }).keys).toEqual({ openai: '', gemini: '' });
  });

  it('restores a built-in mode that is not an object and drops non-object modes', () => {
    const stored = fullSettings();
    stored.modes = { ...stored.modes, email: 'broken', junk: null, list: [] };
    const s = migrateSettings(stored);
    expect(s.modes.email).toEqual(BUILTIN_MODES.email);
    expect(s.modes).not.toHaveProperty('junk');
    expect(s.modes).not.toHaveProperty('list');
    expect(s.modes.custom_1).toEqual(fullSettings().modes.custom_1);
  });

  it('never mutates the stored object while repairing it', () => {
    const stored = { ...phase0Settings(), provider: 'nope', languages: ['el', 3] };
    const snapshot = structuredClone(stored);
    migrateSettings(stored);
    expect(stored).toEqual(snapshot);
  });

  it('returns a result that shares nothing with DEFAULT_SETTINGS', () => {
    const s = migrateSettings({ ...fullSettings(), hotkey: null });
    expect(s.hotkey).not.toBe(DEFAULT_SETTINGS.hotkey);
    s.hotkey.alt = true;
    expect(DEFAULT_SETTINGS.hotkey.alt).toBe(false);
  });

  it('v1: keeps a mode keyed constructor as a custom mode instead of throwing', () => {
    const s = migrateSettings({ modes: { constructor: { name: 'Ctor', icon: 'C', prompt: 'Summarize.' } }, activeMode: 'constructor' });
    expect(Object.hasOwn(s.modes, 'constructor')).toBe(true);
    expect(s.modes.constructor).toEqual({ name: 'Ctor', icon: 'C', prompt: 'Summarize.', builtIn: false });
    expect(s.activeMode).toBe('constructor');
  });

  it('v1: keeps only string names and icons', () => {
    const s = migrateSettings({
      modes: {
        email: { name: 5, icon: {}, prompt: 'old' },
        custom_1: { name: ['x'], icon: 7, prompt: 'Do it.' },
      },
    });
    expect(s.modes.email.name).toBe('Email');
    expect(s.modes.email.icon).toBe('📧');
    expect(s.modes.custom_1).toEqual({ name: 'custom_1', icon: '🎯', prompt: 'Do it.', builtIn: false });
  });

  it('v1: ignores a negative pillGap and a blank target language', () => {
    const s = migrateSettings({ pillGap: -4, translateTargetLang: '   ', modes: {} });
    expect(s.pillGap).toBe(8);
    expect(s.translateTargetLang).toBe('English');
  });

  it('v1: produces a record the v2 path accepts unchanged', () => {
    const s = migrateSettings(V1_SETTINGS);
    expect(migrateSettings(s)).toBe(s);
  });
});

describe('toPublicSettings', () => {
  function withKeys() {
    const s = fullSettings();
    s.keys = { openai: 'sk-proj-secret123', gemini: '   ' };
    return s;
  }

  it('drops the keys and reports which providers have a non-blank one', () => {
    const pub = toPublicSettings(withKeys());
    expect(pub).not.toHaveProperty('keys');
    expect(pub.hasKey).toEqual({ openai: true, gemini: false });
    expect(JSON.stringify(pub)).not.toContain('sk-proj-secret123');
  });

  it('keeps every other field', () => {
    const { keys: _keys, ...rest } = withKeys();
    expect(toPublicSettings(withKeys())).toEqual({ ...rest, hasKey: { openai: true, gemini: false } });
  });

  it('drops an unknown field and still carries every known field plus hasKey', () => {
    const pub = toPublicSettings({ ...withKeys(), apiKey: 'sk-live-LEAK', draftKey: 'AQ.leak' });
    expect(pub).not.toHaveProperty('apiKey');
    expect(pub).not.toHaveProperty('draftKey');
    const { keys: _keys, ...known } = withKeys();
    expect(pub).toEqual({ ...known, hasKey: { openai: true, gemini: false } });
    expect(Object.keys(pub).sort()).toEqual([...Object.keys(DEFAULT_SETTINGS).filter((f) => f !== 'keys'), 'hasKey'].sort());
  });

  it('returns a deep copy and leaves the input intact', () => {
    const settings = withKeys();
    const pub = toPublicSettings(settings);
    pub.modes.email.name = 'changed';
    pub.hotkey.alt = false;
    expect(settings.modes.email.name).toBe('Email');
    expect(settings.hotkey.alt).toBe(true);
    expect(settings.keys.openai).toBe('sk-proj-secret123');
  });

  it('reports no key when keys are missing', () => {
    const { keys: _keys, ...noKeys } = fullSettings();
    expect(toPublicSettings(noKeys).hasKey).toEqual({ openai: false, gemini: false });
  });
});

describe('applySettingsPatch', () => {
  const INVALID = { ok: false, error: 'Invalid settings.' };

  it('whitelists activeMode, provider and translateTargetLang', () => {
    expect(CONTENT_PATCH_FIELDS).toEqual(['activeMode', 'provider', 'translateTargetLang']);
    expect(Object.isFrozen(CONTENT_PATCH_FIELDS)).toBe(true);
  });

  it('applies whitelisted fields to a copy', () => {
    const settings = fullSettings();
    const result = applySettingsPatch(settings, { activeMode: 'email', provider: 'openai', translateTargetLang: '  French  ' });
    expect(result.ok).toBe(true);
    expect(result.settings).not.toBe(settings);
    expect(result.settings).toEqual({ ...fullSettings(), activeMode: 'email', provider: 'openai', translateTargetLang: 'French' });
    expect(settings).toEqual(fullSettings());
  });

  it('accepts an empty patch as a no-op', () => {
    const result = applySettingsPatch(fullSettings(), {});
    expect(result).toEqual({ ok: true, settings: fullSettings() });
  });

  it('rejects a patch that is not an object', () => {
    for (const patch of [null, undefined, 'activeMode', 5, true, [], [['activeMode', 'email']]]) {
      expect(applySettingsPatch(fullSettings(), patch), JSON.stringify(patch)).toEqual(INVALID);
    }
  });

  it('rejects any field outside the whitelist, even next to valid ones', () => {
    const patches = [
      { keys: { openai: 'sk-evil', gemini: '' } },
      { modes: {} },
      { activeMode: 'email', hotkey: DEFAULT_HOTKEY },
      { autoStopSilenceSec: 2 },
      JSON.parse('{"__proto__": {"activeMode": "email"}}'),
    ];
    for (const patch of patches) expect(applySettingsPatch(fullSettings(), patch), JSON.stringify(patch)).toEqual(INVALID);
  });

  it('rejects an activeMode that is not an own mode key', () => {
    for (const activeMode of ['gone', 'constructor', '__proto__', 5, null]) {
      expect(applySettingsPatch(fullSettings(), { activeMode }), String(activeMode)).toEqual(INVALID);
    }
  });

  it('rejects an unknown or inherited provider', () => {
    for (const provider of ['anthropic', 'toString', '', null]) {
      expect(applySettingsPatch(fullSettings(), { provider }), String(provider)).toEqual(INVALID);
    }
  });

  it('rejects a blank, non-string or over-long target language', () => {
    for (const translateTargetLang of ['', '   ', 7, null, 'x'.repeat(41)]) {
      expect(applySettingsPatch(fullSettings(), { translateTargetLang }), String(translateTargetLang)).toEqual(INVALID);
    }
    expect(applySettingsPatch(fullSettings(), { translateTargetLang: ` ${'x'.repeat(40)} ` }).settings.translateTargetLang).toBe('x'.repeat(40));
  });
});

describe('orderedModeKeys', () => {
  const custom = (name) => ({ name, icon: '🎯', prompt: '', builtIn: false });

  it('lists the built-ins first in BUILTIN_MODES order, whatever the key order', () => {
    // chrome.storage hands objects back with their keys sorted: custom_ before default.
    const modes = { custom_1790000000000: custom('Notes'), ...structuredClone(BUILTIN_MODES) };
    const sorted = Object.fromEntries(Object.keys(modes).sort().map((key) => [key, modes[key]]));
    expect(Object.keys(sorted)).toEqual(['custom_1790000000000', 'default', 'email', 'instruct', 'translate']);
    expect(orderedModeKeys(sorted)).toEqual(['default', 'email', 'translate', 'instruct', 'custom_1790000000000']);
  });

  it('skips built-ins that are missing', () => {
    expect(orderedModeKeys({ translate: {}, custom_5: custom('Five'), default: {} })).toEqual(['default', 'translate', 'custom_5']);
  });

  it('orders custom modes by their number, not as strings', () => {
    const modes = { custom_100: custom('C'), custom_10: custom('B'), default: {}, custom_9: custom('A') };
    expect(orderedModeKeys(modes)).toEqual(['default', 'custom_9', 'custom_10', 'custom_100']);
  });

  it('puts any other keys last in ascending string order', () => {
    const modes = { zeta: {}, custom_2: custom('Two'), beta: {}, custom_x: {}, default: {}, Alpha: {}, custom_1: custom('One') };
    expect(orderedModeKeys(modes)).toEqual(['default', 'custom_1', 'custom_2', 'Alpha', 'beta', 'custom_x', 'zeta']);
  });

  it('ignores inherited keys', () => {
    const modes = Object.create({ email: {}, custom_1: custom('Inherited') });
    modes.default = {};
    modes.custom_2 = custom('Own');
    expect(orderedModeKeys(modes)).toEqual(['default', 'custom_2']);
  });

  it('returns an empty list for anything but an object', () => {
    for (const value of [null, undefined, [], 'default', 7]) expect(orderedModeKeys(value), String(value)).toEqual([]);
  });
});
