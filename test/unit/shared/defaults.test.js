import { describe, it, expect } from 'vitest';
import {
  SETTINGS_VERSION, BUILTIN_MODES, DEFAULT_SETTINGS, freshSettings, recoverKey, migrateSettings,
} from '../../../src/shared/defaults.js';

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
    expect(DEFAULT_SETTINGS.modes.email.name).toBe('Email');
    expect(freshSettings().modes.email.name).toBe('Email');
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
});
