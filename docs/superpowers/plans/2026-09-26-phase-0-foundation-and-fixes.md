# VoiceType Phase 0: Foundation and Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make VoiceType work as advertised on both providers with current model IDs, remove the key-corruption path, make failures visible and recoverable, and put all pure logic under test. Ships as v2.0.0.

**Architecture:** Move the flat extension into `src/` with esbuild bundling three entry points (background, content, popup) into `dist/`. Introduce `src/shared/` as the single source of truth for settings, models, prices and message names. Replace the audio-prompt design with a two-stage pipeline (dedicated STT model, then a text model that applies the mode prompt) behind provider adapters with injected `fetch`. Patch the existing content script and popup in place; the Shadow DOM pill and offscreen recorder are Phase 1.

**Tech Stack:** Chrome Manifest V3, plain JavaScript with JSDoc, esbuild, Vitest (node and jsdom environments), Node 20+.

**Spec:** `docs/superpowers/specs/2026-09-26-voicetype-roadmap.md` (sections 2 to 5 govern this plan).

## Global Constraints

- `minimum_chrome_version: "116"`.
- Node 20 or newer. devDependencies only: `esbuild`, `vitest`, `jsdom`. No runtime dependencies.
- Model IDs, labels and prices only in `src/shared/models.js`. Message names only in `src/shared/messages.js`. Defaults and migration only in `src/shared/defaults.js`.
- OpenAI auth: `Authorization: Bearer <key>`. Gemini auth: `x-goog-api-key` header. A key never appears in a URL.
- Provider error bodies are never shown raw; `friendlyHttpError` maps them and `redact` strips key patterns.
- `input[type=password]` is never a dictation target.
- No em dashes or en dashes in code comments, UI copy or docs.
- Commit messages carry only the change description. No AI attribution trailers.
- Every task ends with `npm test` green (`N/N` reported) before its commit.

## Review Focus

1. Silence recorded: STT returns an empty string. Expected: "No speech detected", no refine call, no usage logged. Pinned in Task 7 (`pipeline.test.js`, "empty transcript").
2. Provider returns 401 with a body that echoes the key. Expected: the message says the key was rejected and contains no key fragment. Pinned in Task 5 (`errors.test.js` and `openai.test.js`, "401 redacts key").
3. Target field removed or unfocused before the result arrives. Expected: text lands on the clipboard and the pill says so. Pinned in Task 10 (`insert.test.js`, "disconnected target copies to clipboard").
4. Translate mode with an empty target language. Expected: falls back to English rather than sending `{{targetLanguage}}` literally. Pinned in Task 7 (`pipeline.test.js`, "translate with empty target").
5. v1 storage holding a plaintext key with the encrypted flag set (the corruption bug). Expected: the plaintext key survives migration. Pinned in Task 4 (`defaults.test.js`, "flagged plaintext key survives").

---

### Task 1: Toolchain, git, and `src/` layout

**Files:**
- Create: `package.json`, `build.mjs`, `.gitignore`, `test/fixtures/fields.html`
- Move: `background.js` to `src/background/index.js`; `content.js` to `src/content/index.js`; `content.css` to `src/content/content.css`; `popup.js`, `popup.html`, `popup.css` to `src/popup/`
- Modify: `manifest.json` (no path changes needed; paths already match `dist/` layout)

**Interfaces:**
- Produces: `npm run build` emitting `dist/{background.js,content.js,popup.js,popup.html,popup.css,content.css,manifest.json,icons/}`; `npm test` running Vitest over `test/unit/**/*.test.js`.

- [ ] **Step 1: Initialise git and ignore build output**

Run from the project root:

```bash
cd /home/kara/Dropbox/PersProjects/voicetype
git init -b main
printf 'node_modules/\ndist/\n*.zip\n.DS_Store\n' > .gitignore
git add -A
git commit -m "Import VoiceType 1.7.6 as the starting point for 2.0"
```

Expected: one commit containing the 21 existing files plus `.gitignore`.

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "voicetype",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "description": "BYOK dictation for Chrome with cost transparency",
  "scripts": {
    "build": "node build.mjs",
    "watch": "node build.mjs --watch",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 3: Install dev dependencies**

```bash
npm install --save-dev esbuild vitest jsdom
```

Expected: `package.json` gains a `devDependencies` block with the three packages; `node_modules/` appears and is ignored.

- [ ] **Step 4: Move sources into `src/`**

```bash
mkdir -p src/background src/content src/popup test/unit test/fixtures
git mv background.js src/background/index.js
git mv content.js src/content/index.js
git mv content.css src/content/content.css
git mv popup.js src/popup/popup.js
git mv popup.html src/popup/popup.html
git mv popup.css src/popup/popup.css
```

- [ ] **Step 5: Create `build.mjs`**

```js
// esbuild build script. Bundles three entry points and copies static assets into dist/.
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: {
    background: 'src/background/index.js',
    content: 'src/content/index.js',
    popup: 'src/popup/popup.js',
  },
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  outdir,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

function copyStatic() {
  cpSync('manifest.json', `${outdir}/manifest.json`);
  cpSync('src/popup/popup.html', `${outdir}/popup.html`);
  cpSync('src/popup/popup.css', `${outdir}/popup.css`);
  cpSync('src/content/content.css', `${outdir}/content.css`);
  cpSync('icons', `${outdir}/icons`, { recursive: true });
}

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  copyStatic();
  console.log('watching for changes');
} else {
  await build(options);
  copyStatic();
}
```

- [ ] **Step 6: Wrap the moved scripts so they bundle unchanged**

The moved files are classic scripts. esbuild's `iife` output wraps each bundle already, so the existing IIFE in `src/content/index.js` is harmless for now (Task 11 removes it). Nothing to change in this step for `background` or `popup`. Confirm the build runs:

```bash
npm run build && ls dist dist/icons
```

Expected output lists `background.js content.css content.js icons manifest.json popup.css popup.html popup.js` and the three icon PNGs.

- [ ] **Step 7: Create the fixtures page**

`test/fixtures/fields.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>VoiceType fixtures</title>
  <style>
    body { font: 16px system-ui, sans-serif; margin: 40px; max-width: 720px; }
    label { display: block; margin: 18px 0 6px; font-weight: 600; }
    input, textarea, [contenteditable] { width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid #999; border-radius: 4px; }
    [contenteditable] { min-height: 64px; }
    .left-flush { margin-left: -40px; width: 200px; }
  </style>
</head>
<body>
  <h1>VoiceType fixtures</h1>
  <label for="text">input type=text</label>
  <input id="text" type="text" placeholder="text">
  <label for="email">input type=email</label>
  <input id="email" type="email" placeholder="email">
  <label for="password">input type=password (no pill expected)</label>
  <input id="password" type="password" placeholder="password">
  <label for="ta">textarea</label>
  <textarea id="ta" rows="4"></textarea>
  <label for="ce">contenteditable</label>
  <div id="ce" contenteditable="true"></div>
  <label for="role">role=textbox</label>
  <div id="role" role="textbox" contenteditable="true"></div>
  <label for="left">left-flush input (positioning check, Phase 1)</label>
  <input id="left" class="left-flush" type="text">
</body>
</html>
```

- [ ] **Step 8: Verify Vitest runs with zero tests**

```bash
npx vitest run
```

Expected: "No test files found" and exit code 1 is acceptable at this point; Task 2 adds the first tests. If Vitest complains about the environment, no config is needed: node is the default, and jsdom tests opt in per file with a `// @vitest-environment jsdom` comment.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Add esbuild and Vitest toolchain, move sources into src/, add fixtures page"
```

---

### Task 2: Model registry and pricing

**Files:**
- Create: `src/shared/models.js`, `src/shared/pricing.js`
- Test: `test/unit/shared/models.test.js`, `test/unit/shared/pricing.test.js`

**Interfaces:**
- Produces:
  - `MODELS: Record<string, { provider: 'openai'|'gemini', kind: 'stt'|'text', label: string, pricing: object }>`
  - `PROVIDERS: { openai: { label, stt, text, keyPlaceholder }, gemini: {...} }`
  - `LEGACY_PROVIDER_OF_MODEL: Record<string, 'openai'|'gemini'>`
  - `estimateSttCost(modelId: string, usage: SttUsage|null, fallbackSeconds: number): number`
  - `estimateTextCost(modelId: string, usage: TextUsage|null): number`
  - `formatCost(cost: number): string`
  - Types: `SttUsage = { kind: 'duration', seconds } | { kind: 'tokens', audioTokens, textTokens, outputTokens }`; `TextUsage = { inputTokens, outputTokens }`

- [ ] **Step 1: Write the failing tests**

`test/unit/shared/models.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { MODELS, PROVIDERS, LEGACY_PROVIDER_OF_MODEL } from '../../../src/shared/models.js';

describe('model registry', () => {
  it('every provider points at registered models of the right kind', () => {
    for (const [provider, cfg] of Object.entries(PROVIDERS)) {
      expect(MODELS[cfg.stt], `${provider}.stt`).toBeDefined();
      expect(MODELS[cfg.stt].kind).toBe('stt');
      expect(MODELS[cfg.stt].provider).toBe(provider);
      expect(MODELS[cfg.text], `${provider}.text`).toBeDefined();
      expect(MODELS[cfg.text].kind).toBe('text');
      expect(MODELS[cfg.text].provider).toBe(provider);
    }
  });

  it('uses the current model ids', () => {
    expect(PROVIDERS.openai.stt).toBe('gpt-transcribe');
    expect(PROVIDERS.openai.text).toBe('gpt-6-luna');
    expect(PROVIDERS.gemini.stt).toBe('gemini-3.5-transcribe');
    expect(PROVIDERS.gemini.text).toBe('gemini-3.8-flash');
  });

  it('maps every v1 model id to a provider', () => {
    expect(LEGACY_PROVIDER_OF_MODEL['gpt-4o-transcribe']).toBe('openai');
    expect(LEGACY_PROVIDER_OF_MODEL['gpt-4o-mini-transcribe']).toBe('openai');
    expect(LEGACY_PROVIDER_OF_MODEL['gemini-2.5-flash']).toBe('gemini');
    expect(LEGACY_PROVIDER_OF_MODEL['gemini-3-flash-preview']).toBe('gemini');
  });
});
```

`test/unit/shared/pricing.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { estimateSttCost, estimateTextCost, formatCost } from '../../../src/shared/pricing.js';

describe('estimateSttCost', () => {
  it('prices OpenAI by reported duration', () => {
    expect(estimateSttCost('gpt-transcribe', { kind: 'duration', seconds: 30 }, 99)).toBeCloseTo(0.00225, 6);
  });
  it('falls back to measured seconds when OpenAI reports tokens', () => {
    const usage = { kind: 'tokens', audioTokens: 500, textTokens: 0, outputTokens: 40 };
    expect(estimateSttCost('gpt-transcribe', usage, 60)).toBeCloseTo(0.0045, 6);
  });
  it('falls back to measured seconds when usage is missing', () => {
    expect(estimateSttCost('gpt-transcribe', null, 120)).toBeCloseTo(0.009, 6);
  });
  it('prices Gemini by audio and output tokens', () => {
    const usage = { kind: 'tokens', audioTokens: 1920, textTokens: 0, outputTokens: 100 };
    const expected = (1920 / 1e6) * 2.0 + (100 / 1e6) * 12.0;
    expect(estimateSttCost('gemini-3.5-transcribe', usage, 0)).toBeCloseTo(expected, 9);
  });
  it('estimates Gemini from seconds at 32 tokens per second when usage is missing', () => {
    expect(estimateSttCost('gemini-3.5-transcribe', null, 60)).toBeCloseTo((1920 / 1e6) * 2.0, 9);
  });
  it('returns 0 for unknown models', () => {
    expect(estimateSttCost('nope', null, 60)).toBe(0);
  });
});

describe('estimateTextCost', () => {
  it('prices input and output tokens', () => {
    expect(estimateTextCost('gpt-6-luna', { inputTokens: 1000, outputTokens: 200 })).toBeCloseTo(0.0001 + 0.0001, 9);
    expect(estimateTextCost('gemini-3.8-flash', { inputTokens: 1e6, outputTokens: 0 })).toBeCloseTo(0.75, 9);
  });
  it('returns 0 without usage', () => {
    expect(estimateTextCost('gpt-6-luna', null)).toBe(0);
  });
});

describe('formatCost', () => {
  it('formats zero, sub-cent and normal amounts', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(0.1234)).toBe('$0.12');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/unit/shared
```

Expected: both files fail with "Failed to resolve import" for the two modules.

- [ ] **Step 3: Create `src/shared/models.js`**

```js
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
```

- [ ] **Step 4: Create `src/shared/pricing.js`**

```js
import { MODELS, GEMINI_AUDIO_TOKENS_PER_SECOND } from './models.js';

/**
 * @typedef {{ kind: 'duration', seconds: number }
 *         | { kind: 'tokens', audioTokens: number, textTokens: number, outputTokens: number }} SttUsage
 * @typedef {{ inputTokens: number, outputTokens: number }} TextUsage
 */

/**
 * @param {string} modelId
 * @param {SttUsage|null} usage
 * @param {number} fallbackSeconds client-measured recording length
 * @returns {number} USD
 */
export function estimateSttCost(modelId, usage, fallbackSeconds) {
  const model = MODELS[modelId];
  if (!model) return 0;
  const p = model.pricing;
  if ('perMinute' in p) {
    const seconds = usage?.kind === 'duration' ? usage.seconds : fallbackSeconds;
    return (seconds / 60) * p.perMinute;
  }
  if ('audioInputPerM' in p) {
    const audioTokens = usage?.kind === 'tokens' ? usage.audioTokens : fallbackSeconds * GEMINI_AUDIO_TOKENS_PER_SECOND;
    const outputTokens = usage?.kind === 'tokens' ? usage.outputTokens : 0;
    return (audioTokens / 1e6) * p.audioInputPerM + (outputTokens / 1e6) * p.outputPerM;
  }
  return 0;
}

/**
 * @param {string} modelId
 * @param {TextUsage|null} usage
 * @returns {number} USD
 */
export function estimateTextCost(modelId, usage) {
  const model = MODELS[modelId];
  if (!model || !usage || !('inputPerM' in model.pricing)) return 0;
  return (usage.inputTokens / 1e6) * model.pricing.inputPerM + (usage.outputTokens / 1e6) * model.pricing.outputPerM;
}

/** @param {number} cost */
export function formatCost(cost) {
  if (!cost) return '$0.00';
  if (cost < 0.01) return '<$0.01';
  return '$' + cost.toFixed(2);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run test/unit/shared
```

Expected: 2 files, 12 tests passed.

- [ ] **Step 6: Commit**

```bash
git add src/shared/models.js src/shared/pricing.js test/unit/shared
git commit -m "Add model registry and pricing estimates as the single source of truth"
```

---

### Task 3: Text helpers and message names

**Files:**
- Create: `src/shared/text.js`, `src/shared/messages.js`
- Test: `test/unit/shared/text.test.js`

**Interfaces:**
- Produces:
  - `sanitizeHint(text: unknown, maxLen = 1000): string` strips `<`, `>`, CR, LF (OpenAI rejects them in `prompt` and `keywords`), collapses whitespace, trims, truncates.
  - `fillTemplate(template: string, vars: Record<string, unknown>): string` replaces `{{name}}`; unknown names become empty strings.
  - `MSG` frozen constants: `GET_SETTINGS, SAVE_SETTINGS, CHECK_KEY, VALIDATE_KEY, TRANSCRIBE, GET_USAGE, CLEAR_USAGE, TOGGLE_RECORDING`.

- [ ] **Step 1: Write the failing tests**

`test/unit/shared/text.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { sanitizeHint, fillTemplate } from '../../../src/shared/text.js';

describe('sanitizeHint', () => {
  it('removes characters the transcription API rejects', () => {
    expect(sanitizeHint('Kostas <Karakostas>\r\nPalowise')).toBe('Kostas Karakostas Palowise');
  });
  it('collapses whitespace and trims', () => {
    expect(sanitizeHint('  a   b\t c ')).toBe('a b c');
  });
  it('truncates to maxLen', () => {
    expect(sanitizeHint('abcdefgh', 4)).toBe('abcd');
  });
  it('tolerates null and numbers', () => {
    expect(sanitizeHint(null)).toBe('');
    expect(sanitizeHint(42)).toBe('42');
  });
});

describe('fillTemplate', () => {
  it('replaces known variables and blanks unknown ones', () => {
    expect(fillTemplate('to {{targetLanguage}} and {{ other }} end', { targetLanguage: 'Greek' })).toBe('to Greek and  end');
  });
  it('returns the template untouched when it has no variables', () => {
    expect(fillTemplate('plain', {})).toBe('plain');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/unit/shared/text.test.js
```

Expected: fails with "Failed to resolve import".

- [ ] **Step 3: Create `src/shared/text.js`**

```js
/**
 * Make a string safe for OpenAI `prompt` and `keywords[]` fields, which reject
 * `<`, `>`, CR and LF, and keep hints short.
 * @param {unknown} text
 * @param {number} [maxLen]
 */
export function sanitizeHint(text, maxLen = 1000) {
  return String(text ?? '')
    .replace(/[<>\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/**
 * Replace `{{name}}` placeholders. Unknown names become empty strings.
 * @param {string} template
 * @param {Record<string, unknown>} vars
 */
export function fillTemplate(template, vars) {
  return String(template ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) =>
    vars && vars[name] != null ? String(vars[name]) : '');
}
```

- [ ] **Step 4: Create `src/shared/messages.js`**

```js
// Message action names shared by background, content and popup.
export const MSG = Object.freeze({
  GET_SETTINGS: 'getSettings',
  SAVE_SETTINGS: 'saveSettings',
  CHECK_KEY: 'checkApiKey',
  VALIDATE_KEY: 'validateKey',
  TRANSCRIBE: 'transcribe',
  GET_USAGE: 'getUsageStats',
  CLEAR_USAGE: 'clearUsageStats',
  TOGGLE_RECORDING: 'toggle-recording',
});

/**
 * @typedef {{ action: 'transcribe', audioBase64: string, mimeType: string, mode: string, audioDuration: number }} TranscribeRequest
 * @typedef {{ success: true, text: string, raw: string, cost: number } | { success: false, error: string }} TranscribeResponse
 * @typedef {{ action: 'validateKey', provider: 'openai'|'gemini', key: string }} ValidateKeyRequest
 */
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run test/unit/shared
```

Expected: 3 files, 18 tests passed.

- [ ] **Step 6: Commit**

```bash
git add src/shared/text.js src/shared/messages.js test/unit/shared/text.test.js
git commit -m "Add hint sanitiser, template filler and shared message names"
```

---

### Task 4: Settings defaults, migration and key recovery

**Files:**
- Create: `src/shared/defaults.js`
- Test: `test/unit/shared/defaults.test.js`

**Interfaces:**
- Produces:
  - `SETTINGS_VERSION = 2`
  - `BUILTIN_MODES` (`default`, `email`, `translate`, `instruct`), each `{ name, icon, prompt, builtIn: true, hasLanguageOption? }`; `default.prompt === ''`.
  - `DEFAULT_SETTINGS` (frozen) and `freshSettings(): Settings` (deep clone).
  - `recoverKey(value: unknown, flagged: unknown): string`
  - `migrateSettings(stored: unknown): Settings` returns the same object reference when nothing needs changing.
  - Type `Settings` as in spec section 4.4.

- [ ] **Step 1: Write the failing tests**

`test/unit/shared/defaults.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/unit/shared/defaults.test.js
```

Expected: fails with "Failed to resolve import".

- [ ] **Step 3: Create `src/shared/defaults.js`**

```js
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

  if (v.settingsVersion === SETTINGS_VERSION) {
    const missing = Object.keys(BUILTIN_MODES).filter((k) => !v.modes?.[k]);
    if (missing.length === 0) return v;
    const patched = structuredClone(v);
    patched.modes = patched.modes || {};
    for (const k of missing) patched.modes[k] = structuredClone(BUILTIN_MODES[k]);
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
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/unit/shared
```

Expected: 4 files, 28 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/shared/defaults.js test/unit/shared/defaults.test.js
git commit -m "Add settings v2 defaults with v1 migration and key recovery"
```

---

### Task 5: Provider errors and the OpenAI adapter

**Files:**
- Create: `src/background/providers/errors.js`, `src/background/providers/openai.js`
- Test: `test/unit/background/providers/errors.test.js`, `test/unit/background/providers/openai.test.js`

**Interfaces:**
- Consumes: `PROVIDERS` (Task 2), `sanitizeHint` (Task 3).
- Produces:
  - `class ProviderError extends Error { status?: number, code: string }`
  - `friendlyHttpError(provider: 'openai'|'gemini', status: number, apiMessage: string): ProviderError`
  - `redact(text: string): string`
  - OpenAI adapter, all returning promises and accepting an `AbortSignal`:
    - `transcribe({ audioBase64, mimeType, key, languages, keywords, prompt, signal }) => { text: string, usage: SttUsage|null, languages: string[] }`
    - `refine({ key, instructions, text, signal }) => { text: string, usage: TextUsage }`
    - `validateKey({ key, signal }) => true` (throws `ProviderError` otherwise)
    - `extractOutputText(responseJson): string`, `normalizeSttUsage(usageJson): SttUsage|null`, `base64ToBlob(base64, mimeType): Blob`

- [ ] **Step 1: Write the failing error tests**

`test/unit/background/providers/errors.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { ProviderError, friendlyHttpError, redact } from '../../../../src/background/providers/errors.js';

describe('redact', () => {
  it('replaces OpenAI and Gemini key patterns', () => {
    expect(redact('Incorrect API key provided: sk-proj-abcdef123456.')).toBe('Incorrect API key provided: [key].');
    expect(redact('bad AIzaSyD9x2KqL0mN3p and AQ.Ab8Rn2xyz')).toBe('bad [key] and [key]');
  });
  it('caps length', () => {
    expect(redact('x'.repeat(500)).length).toBe(160);
  });
});

describe('friendlyHttpError', () => {
  it('401 redacts key', () => {
    const e = friendlyHttpError('openai', 401, 'Incorrect API key provided: sk-proj-abcdef123456');
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.code).toBe('auth');
    expect(e.message).toContain('OpenAI rejected the API key');
    expect(e.message).not.toContain('sk-proj');
  });
  it('maps rate limits, bad requests and server errors', () => {
    expect(friendlyHttpError('gemini', 429, '').message).toContain('Gemini rate limit or quota');
    expect(friendlyHttpError('gemini', 400, 'Unsupported MIME type').message).toBe('Gemini rejected the request: Unsupported MIME type');
    expect(friendlyHttpError('openai', 503, '').message).toContain('HTTP 503');
    expect(friendlyHttpError('openai', 418, '').message).toBe('OpenAI error (HTTP 418).');
  });
});
```

- [ ] **Step 2: Write the failing OpenAI adapter tests**

`test/unit/background/providers/openai.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { transcribe, refine, validateKey, extractOutputText, normalizeSttUsage } from '../../../../src/background/providers/openai.js';

const AUDIO = btoa('fake-webm-bytes');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let fetchMock;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('transcribe', () => {
  it('posts multipart with model, hints and bearer auth', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: ' hello world ', usage: { type: 'duration', seconds: 12 }, languages: [{ code: 'en' }] }));
    const result = await transcribe({ audioBase64: AUDIO, mimeType: 'audio/webm', key: 'sk-test', languages: ['el', 'en'], keywords: ['Palowise', 'bad<kw>'], prompt: 'Topic:\nAI' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    const form = init.body;
    expect(form.get('model')).toBe('gpt-transcribe');
    expect(form.get('response_format')).toBe('json');
    expect(form.getAll('languages[]')).toEqual(['el', 'en']);
    expect(form.getAll('keywords[]')).toEqual(['Palowise', 'bad kw']);
    expect(form.get('prompt')).toBe('Topic: AI');
    expect(form.get('file').type).toBe('audio/webm');

    expect(result).toEqual({ text: 'hello world', usage: { kind: 'duration', seconds: 12 }, languages: ['en'] });
  });

  it('omits prompt when empty and handles token usage', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: 'x', usage: { type: 'tokens', input_tokens: 14, output_tokens: 45, total_tokens: 59, input_token_details: { audio_tokens: 14, text_tokens: 0 } } }));
    const result = await transcribe({ audioBase64: AUDIO, key: 'sk-test' });
    expect(fetchMock.mock.calls[0][1].body.has('prompt')).toBe(false);
    expect(result.usage).toEqual({ kind: 'tokens', audioTokens: 14, textTokens: 0, outputTokens: 45 });
    expect(result.languages).toEqual([]);
  });

  it('401 redacts key', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'Incorrect API key provided: sk-test-abcdef' } }, 401));
    await expect(transcribe({ audioBase64: AUDIO, key: 'sk-test-abcdef' })).rejects.toMatchObject({ name: 'ProviderError', code: 'auth' });
    await expect(transcribe({ audioBase64: AUDIO, key: 'sk-test-abcdef' })).rejects.not.toThrow(/sk-test/);
  });

  it('passes the abort signal through', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: 'x' }));
    const controller = new AbortController();
    await transcribe({ audioBase64: AUDIO, key: 'k', signal: controller.signal });
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });
});

describe('refine', () => {
  it('calls the Responses API and walks the output', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', content: [{ type: 'output_text', text: 'Dear team,' }, { type: 'output_text', text: ' hello.' }] },
      ],
      usage: { input_tokens: 120, output_tokens: 30 },
    }));
    const result = await refine({ key: 'sk-test', instructions: 'Write an email.', text: 'hi team hello' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ model: 'gpt-6-luna', instructions: 'Write an email.', input: 'hi team hello', reasoning: { effort: 'none' } });
    expect(result).toEqual({ text: 'Dear team, hello.', usage: { inputTokens: 120, outputTokens: 30 } });
  });
});

describe('validateKey', () => {
  it('resolves true on 200 and throws a friendly error on 401', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await expect(validateKey({ key: 'sk-ok' })).resolves.toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/models');
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'nope' } }, 401));
    await expect(validateKey({ key: 'sk-bad' })).rejects.toMatchObject({ code: 'auth' });
  });
});

describe('helpers', () => {
  it('extractOutputText ignores non-message items', () => {
    expect(extractOutputText({ output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'refusal', refusal: 'no' }, { type: 'output_text', text: 'ok' }] }] })).toBe('ok');
    expect(extractOutputText({})).toBe('');
  });
  it('normalizeSttUsage returns null for unknown shapes', () => {
    expect(normalizeSttUsage(undefined)).toBeNull();
    expect(normalizeSttUsage({ type: 'other' })).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npx vitest run test/unit/background/providers
```

Expected: both files fail with "Failed to resolve import".

- [ ] **Step 4: Create `src/background/providers/errors.js`**

```js
export class ProviderError extends Error {
  /**
   * @param {string} message user-facing text
   * @param {{ status?: number, code?: string }} [info]
   */
  constructor(message, { status, code = 'provider' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
  }
}

const KEY_PATTERN = /\b(sk-[A-Za-z0-9_-]{4,}|AIza[A-Za-z0-9_-]{4,}|AQ\.[A-Za-z0-9_-]{4,})/g;

/** Strip anything that looks like an API key and cap the length. */
export function redact(text) {
  return String(text ?? '').replace(KEY_PATTERN, '[key]').slice(0, 160);
}

/**
 * @param {'openai'|'gemini'} provider
 * @param {number} status
 * @param {string} apiMessage message from the provider body, may be empty
 */
export function friendlyHttpError(provider, status, apiMessage) {
  const label = provider === 'openai' ? 'OpenAI' : 'Gemini';
  if (status === 401 || status === 403) {
    return new ProviderError(`${label} rejected the API key. Check it in the extension settings.`, { status, code: 'auth' });
  }
  if (status === 429) {
    return new ProviderError(`${label} rate limit or quota reached. Try again shortly or check billing.`, { status, code: 'rate_limit' });
  }
  if (status === 400) {
    const detail = apiMessage ? `: ${redact(apiMessage)}` : '.';
    return new ProviderError(`${label} rejected the request${detail}`, { status, code: 'bad_request' });
  }
  if (status >= 500) {
    return new ProviderError(`${label} is having trouble (HTTP ${status}). Try again.`, { status, code: 'server' });
  }
  return new ProviderError(`${label} error (HTTP ${status}).`, { status, code: 'http' });
}
```

- [ ] **Step 5: Create `src/background/providers/openai.js`**

```js
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
    languages: Array.isArray(data.languages) ? data.languages.map((l) => l.code).filter(Boolean) : [],
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

/** @returns {import('../../shared/pricing.js').SttUsage|null} */
export function normalizeSttUsage(usage) {
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
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run test/unit/background/providers
```

Expected: 2 files, 12 tests passed.

- [ ] **Step 7: Commit**

```bash
git add src/background/providers test/unit/background/providers
git commit -m "Add provider error mapping and the OpenAI transcribe and refine adapter"
```

---

### Task 6: Gemini adapter

**Files:**
- Create: `src/background/providers/gemini.js`
- Test: `test/unit/background/providers/gemini.test.js`

**Interfaces:**
- Consumes: `PROVIDERS`, `sanitizeHint`, `friendlyHttpError`.
- Produces: same adapter surface as Task 5 (`transcribe`, `refine`, `validateKey`) plus `joinParts(responseJson): string`, `normalizeSttUsage(usageMetadata): SttUsage|null`, `toBcp47(code): string`.

- [ ] **Step 1: Write the failing tests**

`test/unit/background/providers/gemini.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { transcribe, refine, validateKey, joinParts, normalizeSttUsage, toBcp47 } from '../../../../src/background/providers/gemini.js';

const AUDIO = btoa('fake-webm-bytes');
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
let fetchMock;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('transcribe', () => {
  it('posts inline audio with SMART mode, header auth and no key in the URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      candidates: [{ content: { parts: [{ text: 'Καλημέρα ' }, { text: 'κόσμε' }] } }],
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 6, totalTokenCount: 206, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 192 }, { modality: 'TEXT', tokenCount: 8 }] },
    }));
    const result = await transcribe({ audioBase64: AUDIO, mimeType: 'audio/webm', key: 'AQ.secret', languages: ['el'], keywords: ['Palowise', 'x<y>'] });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent');
    expect(url).not.toContain('key=');
    expect(init.headers['x-goog-api-key']).toBe('AQ.secret');
    const body = JSON.parse(init.body);
    expect(body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'audio/webm', data: AUDIO } });
    expect(body.generationConfig.audioTranscriptionConfig).toEqual({ mode: 'SMART', languageCodes: ['el-GR'], customVocabulary: ['Palowise', 'x y'] });

    expect(result.text).toBe('Καλημέρα κόσμε');
    expect(result.usage).toEqual({ kind: 'tokens', audioTokens: 192, textTokens: 8, outputTokens: 6 });
    expect(result.languages).toEqual([]);
  });

  it('omits empty hint fields', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }));
    await transcribe({ audioBase64: AUDIO, key: 'k' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.generationConfig.audioTranscriptionConfig).toEqual({ mode: 'SMART' });
  });

  it('maps 403 to a friendly auth error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'API key not valid. Please pass a valid API key.' } }, 403));
    await expect(transcribe({ audioBase64: AUDIO, key: 'AQ.bad' })).rejects.toMatchObject({ name: 'ProviderError', code: 'auth' });
  });
});

describe('refine', () => {
  it('sends a system instruction with low thinking and joins non-thought parts', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: 'Dear team,' }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5 },
    }));
    const result = await refine({ key: 'k', instructions: 'Write an email.', text: 'hi team' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(JSON.parse(init.body)).toEqual({
      system_instruction: { parts: [{ text: 'Write an email.' }] },
      contents: [{ parts: [{ text: 'hi team' }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'low' } },
    });
    expect(result).toEqual({ text: 'Dear team,', usage: { inputTokens: 100, outputTokens: 25 } });
  });
});

describe('validateKey', () => {
  it('lists models with header auth', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ models: [] }));
    await expect(validateKey({ key: 'AQ.ok' })).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1');
    expect(init.headers['x-goog-api-key']).toBe('AQ.ok');
  });
});

describe('helpers', () => {
  it('joinParts tolerates missing candidates', () => {
    expect(joinParts({})).toBe('');
  });
  it('normalizeSttUsage handles missing details', () => {
    expect(normalizeSttUsage(undefined)).toBeNull();
    expect(normalizeSttUsage({ candidatesTokenCount: 3 })).toEqual({ kind: 'tokens', audioTokens: 0, textTokens: 0, outputTokens: 3 });
  });
  it('toBcp47 maps known codes and passes others through', () => {
    expect(toBcp47('el')).toBe('el-GR');
    expect(toBcp47('en')).toBe('en-US');
    expect(toBcp47('ja')).toBe('ja');
    expect(toBcp47('pt-BR')).toBe('pt-BR');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/unit/background/providers/gemini.test.js
```

Expected: fails with "Failed to resolve import".

- [ ] **Step 3: Create `src/background/providers/gemini.js`**

```js
import { PROVIDERS } from '../../shared/models.js';
import { sanitizeHint } from '../../shared/text.js';
import { friendlyHttpError } from './errors.js';

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
 * @param {{ audioBase64: string, mimeType?: string, key: string, languages?: string[], keywords?: string[], prompt?: string, signal?: AbortSignal }} args
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
  if (!res.ok) throw friendlyHttpError('gemini', res.status, await readErrorMessage(res));
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
  if (!res.ok) throw friendlyHttpError('gemini', res.status, await readErrorMessage(res));
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
  if (!res.ok) throw friendlyHttpError('gemini', res.status, await readErrorMessage(res));
  return true;
}

/** Concatenate text parts of the first candidate, skipping thought parts. */
export function joinParts(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.filter((p) => typeof p?.text === 'string' && !p.thought).map((p) => p.text).join('');
}

/** @returns {import('../../shared/pricing.js').SttUsage|null} */
export function normalizeSttUsage(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const byModality = {};
  for (const d of meta.promptTokensDetails || []) byModality[d.modality] = (byModality[d.modality] || 0) + (d.tokenCount || 0);
  return {
    kind: 'tokens',
    audioTokens: byModality.AUDIO || 0,
    textTokens: byModality.TEXT || 0,
    outputTokens: meta.candidatesTokenCount || 0,
  };
}

async function readErrorMessage(res) {
  try {
    const body = await res.json();
    return body?.error?.message || '';
  } catch {
    return '';
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/unit/background/providers
```

Expected: 3 files, 20 tests passed.

- [ ] **Step 5: Live smoke of the Gemini request shape**

The `audioTranscriptionConfig` field names come from the 2026-09-26 docs pass and have not been exercised against the live API. Before committing, run one real call with a short WebM clip and a Gemini key. Record a 3 second clip in Chrome (any page, DevTools console):

```js
const s = await navigator.mediaDevices.getUserMedia({ audio: true });
const r = new MediaRecorder(s, { mimeType: 'audio/webm;codecs=opus' }); const chunks = [];
r.ondataavailable = (e) => chunks.push(e.data); r.start(); await new Promise((res) => setTimeout(res, 3000)); r.stop();
await new Promise((res) => (r.onstop = res)); s.getTracks().forEach((t) => t.stop());
const b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(',')[1]); fr.readAsDataURL(new Blob(chunks, { type: 'audio/webm' })); });
copy(b64);
```

Paste the clipboard into `/tmp/clip.b64`, then:

```bash
GEMINI_KEY=... node -e '
import("./src/background/providers/gemini.js").then(async (g) => {
  const audioBase64 = (await import("node:fs")).readFileSync("/tmp/clip.b64", "utf8").trim();
  console.log(await g.transcribe({ audioBase64, key: process.env.GEMINI_KEY, languages: ["el"] }));
});'
```

Expected: `{ text: "<what you said>", usage: { kind: "tokens", audioTokens: ~96, ... }, languages: [] }`. If the API returns 400 naming `audioTranscriptionConfig`, `mode`, `languageCodes` or `customVocabulary`, open https://ai.google.dev/gemini-api/docs/generate-content/transcribe, correct the field names in `gemini.js`, update the two assertions in `gemini.test.js` that spell them out, and rerun the tests.

- [ ] **Step 6: Commit**

```bash
git add src/background/providers/gemini.js test/unit/background/providers/gemini.test.js
git commit -m "Add the Gemini transcribe and refine adapter with header auth"
```

---

### Task 7: Dictation pipeline

**Files:**
- Create: `src/background/pipeline.js`
- Test: `test/unit/background/pipeline.test.js`

**Interfaces:**
- Consumes: adapters with `transcribe` and `refine` (Tasks 5, 6), `PROVIDERS`, `fillTemplate`, `estimateSttCost`, `estimateTextCost`, `ProviderError`.
- Produces:
  - `REQUEST_TIMEOUT_MS = 60_000`
  - `runDictation({ audioBase64, mimeType, modeKey, settings, durationSec }, adapters = ADAPTERS, timeoutMs = REQUEST_TIMEOUT_MS) => Promise<DictationResult>`
  - `DictationResult = { raw: string, text: string, provider: 'openai'|'gemini', sttModel: string, textModel: string|null, audioSeconds: number, cost: number }`
  - Throws `ProviderError` with `code: 'no_key'` or `code: 'empty'`.

- [ ] **Step 1: Write the failing tests**

`test/unit/background/pipeline.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { runDictation } from '../../../src/background/pipeline.js';
import { freshSettings } from '../../../src/shared/defaults.js';

function fakeAdapters({ sttText = 'raw words', refineText = 'refined words' } = {}) {
  const openai = {
    transcribe: vi.fn(async () => ({ text: sttText, usage: { kind: 'duration', seconds: 30 }, languages: ['en'] })),
    refine: vi.fn(async () => ({ text: refineText, usage: { inputTokens: 1000, outputTokens: 200 } })),
  };
  const gemini = {
    transcribe: vi.fn(async () => ({ text: sttText, usage: { kind: 'tokens', audioTokens: 960, textTokens: 0, outputTokens: 10 }, languages: [] })),
    refine: vi.fn(async () => ({ text: refineText, usage: { inputTokens: 500, outputTokens: 100 } })),
  };
  return { openai, gemini };
}

function settingsWith(overrides = {}) {
  const s = freshSettings();
  s.keys.openai = 'sk-test';
  s.keys.gemini = 'AQ.test';
  s.languages = ['el', 'en'];
  s.keywords = ['Palowise'];
  return Object.assign(s, overrides);
}

const base = { audioBase64: 'QUJD', mimeType: 'audio/webm', durationSec: 31 };

describe('runDictation', () => {
  it('default mode transcribes only and prices from reported duration', async () => {
    const adapters = fakeAdapters();
    const result = await runDictation({ ...base, modeKey: 'default', settings: settingsWith() }, adapters);
    expect(adapters.openai.transcribe).toHaveBeenCalledTimes(1);
    const args = adapters.openai.transcribe.mock.calls[0][0];
    expect(args).toMatchObject({ audioBase64: 'QUJD', mimeType: 'audio/webm', key: 'sk-test', languages: ['el', 'en'], keywords: ['Palowise'] });
    expect(args.signal).toBeInstanceOf(AbortSignal);
    expect(adapters.openai.refine).not.toHaveBeenCalled();
    expect(result).toMatchObject({ raw: 'raw words', text: 'raw words', provider: 'openai', sttModel: 'gpt-transcribe', textModel: null, audioSeconds: 30 });
    expect(result.cost).toBeCloseTo(0.00225, 6);
  });

  it('email mode refines with the mode prompt and sums both costs', async () => {
    const adapters = fakeAdapters();
    const settings = settingsWith();
    const result = await runDictation({ ...base, modeKey: 'email', settings }, adapters);
    expect(adapters.openai.refine).toHaveBeenCalledWith(expect.objectContaining({ key: 'sk-test', instructions: settings.modes.email.prompt, text: 'raw words' }));
    expect(result.text).toBe('refined words');
    expect(result.raw).toBe('raw words');
    expect(result.textModel).toBe('gpt-6-luna');
    expect(result.cost).toBeCloseTo(0.00225 + 0.0001 + 0.0001, 6);
  });

  it('translate with empty target falls back to English', async () => {
    const adapters = fakeAdapters();
    await runDictation({ ...base, modeKey: 'translate', settings: settingsWith({ translateTargetLang: '' }) }, adapters);
    const { instructions } = adapters.openai.refine.mock.calls[0][0];
    expect(instructions).toContain('Translate it into English.');
    expect(instructions).not.toContain('{{');
  });

  it('uses the Gemini adapter and token pricing when the provider is gemini', async () => {
    const adapters = fakeAdapters();
    const result = await runDictation({ ...base, modeKey: 'default', settings: settingsWith({ provider: 'gemini' }) }, adapters);
    expect(adapters.gemini.transcribe).toHaveBeenCalledTimes(1);
    expect(adapters.openai.transcribe).not.toHaveBeenCalled();
    expect(result.provider).toBe('gemini');
    expect(result.audioSeconds).toBe(31);
    expect(result.cost).toBeCloseTo((960 / 1e6) * 2 + (10 / 1e6) * 12, 9);
  });

  it('empty transcript throws and skips refine', async () => {
    const adapters = fakeAdapters({ sttText: '   ' });
    await expect(runDictation({ ...base, modeKey: 'email', settings: settingsWith() }, adapters)).rejects.toMatchObject({ name: 'ProviderError', code: 'empty' });
    expect(adapters.openai.refine).not.toHaveBeenCalled();
  });

  it('missing key throws before any network call', async () => {
    const adapters = fakeAdapters();
    const settings = settingsWith(); settings.keys.openai = '';
    await expect(runDictation({ ...base, modeKey: 'default', settings }, adapters)).rejects.toMatchObject({ code: 'no_key' });
    expect(adapters.openai.transcribe).not.toHaveBeenCalled();
  });

  it('unknown mode behaves like default', async () => {
    const adapters = fakeAdapters();
    const result = await runDictation({ ...base, modeKey: 'ghost', settings: settingsWith() }, adapters);
    expect(adapters.openai.refine).not.toHaveBeenCalled();
    expect(result.text).toBe('raw words');
  });

  it('falls back to the raw transcript when refine returns nothing', async () => {
    const adapters = fakeAdapters({ refineText: '' });
    const result = await runDictation({ ...base, modeKey: 'instruct', settings: settingsWith() }, adapters);
    expect(result.text).toBe('raw words');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/unit/background/pipeline.test.js
```

Expected: fails with "Failed to resolve import".

- [ ] **Step 3: Create `src/background/pipeline.js`**

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/unit/background
```

Expected: 4 files, 28 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/background/pipeline.js test/unit/background/pipeline.test.js
git commit -m "Add two-stage dictation pipeline with timeout, empty guard and cost"
```

---

### Task 8: Usage log v2 and storage

**Files:**
- Create: `src/background/usage.js`, `src/background/storage.js`
- Test: `test/unit/background/usage.test.js`, `test/unit/background/storage.test.js`

**Interfaces:**
- Consumes: `migrateSettings`, `SETTINGS_VERSION`.
- Produces:
  - `localDateKey(date = new Date()): 'YYYY-MM-DD'` in local time.
  - `emptyLog(): UsageLog`, `RETENTION_DAYS = 90`
  - `applyUsage(log, entry: { provider, audioSeconds, cost, mode }, now = new Date()): UsageLog` (pure, returns a new object)
  - `summarize(log, now = new Date()): { today: Bucket, last7Days: Bucket, total: Bucket }`
  - `Bucket = { sessions, audioSeconds, estimatedCost, byProvider: { openai: {sessions, audioSeconds, cost}, gemini: {...} }, modes: Record<string, number> }`
  - `createStorage(area) => { getSettings(), saveSettings(settings), getUsageLog(), setUsageLog(log) }` where `area` has promise-returning `get(key)` and `set(obj)` like `chrome.storage.local`.

- [ ] **Step 1: Write the failing usage tests**

`test/unit/background/usage.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { localDateKey, emptyLog, applyUsage, summarize, RETENTION_DAYS } from '../../../src/background/usage.js';

const entry = (provider, audioSeconds, cost, mode = 'default') => ({ provider, audioSeconds, cost, mode });

describe('localDateKey', () => {
  it('uses local calendar date, not UTC', () => {
    const late = new Date(2026, 8, 26, 23, 30); // local 26 Sept, 23:30
    expect(localDateKey(late)).toBe('2026-09-26');
    expect(localDateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('applyUsage', () => {
  it('creates the day bucket and accumulates totals per provider and mode', () => {
    const now = new Date(2026, 8, 26, 10);
    let log = applyUsage(emptyLog(), entry('openai', 30, 0.002, 'email'), now);
    log = applyUsage(log, entry('gemini', 60, 0.004), now);
    const day = log.daily['2026-09-26'];
    expect(day.sessions).toBe(2);
    expect(day.audioSeconds).toBe(90);
    expect(day.estimatedCost).toBeCloseTo(0.006, 9);
    expect(day.byProvider.openai).toEqual({ sessions: 1, audioSeconds: 30, cost: 0.002 });
    expect(day.byProvider.gemini).toEqual({ sessions: 1, audioSeconds: 60, cost: 0.004 });
    expect(day.modes).toEqual({ email: 1, default: 1 });
    expect(log.total.sessions).toBe(2);
    expect(log.total.byProvider.gemini.audioSeconds).toBe(60);
  });

  it('does not mutate its input', () => {
    const before = emptyLog();
    applyUsage(before, entry('openai', 1, 0.1), new Date(2026, 8, 26));
    expect(before.total.sessions).toBe(0);
  });

  it('prunes days older than the retention window but keeps totals', () => {
    const old = new Date(2026, 0, 1);
    let log = applyUsage(emptyLog(), entry('openai', 10, 0.001), old);
    const now = new Date(2026, 8, 26);
    log = applyUsage(log, entry('openai', 10, 0.001), now);
    expect(log.daily['2026-01-01']).toBeUndefined();
    expect(log.daily['2026-09-26'].sessions).toBe(1);
    expect(log.total.sessions).toBe(2);
    const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    expect(RETENTION_DAYS).toBe(90);
  });

  it('discards a v1 log shape', () => {
    const v1 = { daily: { '2026-09-01': { sessions: 5 } }, total: { sessions: 5, audioSeconds: 1, estimatedCost: 1 } };
    const log = applyUsage(v1, entry('openai', 1, 0.001), new Date(2026, 8, 26));
    expect(log.version).toBe(2);
    expect(log.total.sessions).toBe(1);
  });
});

describe('summarize', () => {
  it('sums today, the last seven days and all time', () => {
    const now = new Date(2026, 8, 26, 12);
    const daysAgo = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return d; };
    let log = emptyLog();
    log = applyUsage(log, entry('openai', 10, 0.01), now);
    log = applyUsage(log, entry('gemini', 20, 0.02), daysAgo(3));
    log = applyUsage(log, entry('openai', 40, 0.04), daysAgo(6));
    log = applyUsage(log, entry('openai', 80, 0.08), daysAgo(7));
    const s = summarize(log, now);
    expect(s.today.sessions).toBe(1);
    expect(s.today.audioSeconds).toBe(10);
    expect(s.last7Days.sessions).toBe(3);
    expect(s.last7Days.audioSeconds).toBe(70);
    expect(s.last7Days.byProvider.gemini.cost).toBeCloseTo(0.02, 9);
    expect(s.total.sessions).toBe(4);
    expect(s.total.audioSeconds).toBe(150);
  });

  it('returns empty buckets for a missing log', () => {
    const s = summarize(undefined);
    expect(s.today.sessions).toBe(0);
    expect(s.total.byProvider.openai.cost).toBe(0);
  });
});
```

- [ ] **Step 2: Write the failing storage tests**

`test/unit/background/storage.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { createStorage } from '../../../src/background/storage.js';
import { freshSettings, SETTINGS_VERSION } from '../../../src/shared/defaults.js';

function fakeArea(initial = {}) {
  const store = { ...initial };
  return {
    store,
    get: vi.fn(async (key) => ({ [key]: store[key] })),
    set: vi.fn(async (obj) => { Object.assign(store, obj); }),
  };
}

describe('createStorage', () => {
  it('migrates v1 settings on first read and writes them back once', async () => {
    const area = fakeArea({ settings: { apiKey: 'sk-old', apiKeyEncrypted: false, provider: 'openai', modes: {} } });
    const storage = createStorage(area);
    const s = await storage.getSettings();
    expect(s.settingsVersion).toBe(SETTINGS_VERSION);
    expect(s.keys.openai).toBe('sk-old');
    expect(area.set).toHaveBeenCalledTimes(1);
    await storage.getSettings();
    expect(area.set).toHaveBeenCalledTimes(1);
  });

  it('returns defaults when nothing is stored', async () => {
    const storage = createStorage(fakeArea());
    const s = await storage.getSettings();
    expect(s.provider).toBe('openai');
    expect(s.modes.default).toBeDefined();
  });

  it('stamps the version on save', async () => {
    const area = fakeArea();
    const storage = createStorage(area);
    const s = freshSettings(); delete s.settingsVersion; s.keys.gemini = 'AQ.x';
    await storage.saveSettings(s);
    expect(area.store.settings.settingsVersion).toBe(SETTINGS_VERSION);
    expect(area.store.settings.keys.gemini).toBe('AQ.x');
  });

  it('replaces a v1 usage log with an empty v2 log', async () => {
    const storage = createStorage(fakeArea({ usageLog: { daily: {}, total: { sessions: 9 } } }));
    const log = await storage.getUsageLog();
    expect(log.version).toBe(2);
    expect(log.total.sessions).toBe(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npx vitest run test/unit/background/usage.test.js test/unit/background/storage.test.js
```

Expected: both fail with "Failed to resolve import".

- [ ] **Step 4: Create `src/background/usage.js`**

```js
// Usage log v2. Pure functions; storage is handled by storage.js.

export const RETENTION_DAYS = 90;
const PROVIDER_KEYS = ['openai', 'gemini'];

/**
 * @typedef {{ sessions: number, audioSeconds: number, cost: number }} ProviderBucket
 * @typedef {{ sessions: number, audioSeconds: number, estimatedCost: number,
 *             byProvider: { openai: ProviderBucket, gemini: ProviderBucket }, modes: Record<string, number> }} Bucket
 * @typedef {{ version: 2, daily: Record<string, Bucket>, total: Bucket }} UsageLog
 * @typedef {{ provider: 'openai'|'gemini', audioSeconds: number, cost: number, mode: string }} UsageEntry
 */

/** Local calendar date as YYYY-MM-DD. */
export function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** @returns {Bucket} */
function emptyBucket() {
  return {
    sessions: 0, audioSeconds: 0, estimatedCost: 0,
    byProvider: { openai: { sessions: 0, audioSeconds: 0, cost: 0 }, gemini: { sessions: 0, audioSeconds: 0, cost: 0 } },
    modes: {},
  };
}

/** @returns {UsageLog} */
export function emptyLog() {
  return { version: 2, daily: {}, total: emptyBucket() };
}

function isV2(log) {
  return Boolean(log) && log.version === 2 && typeof log.daily === 'object' && typeof log.total === 'object';
}

function addTo(bucket, entry) {
  bucket.sessions += 1;
  bucket.audioSeconds += entry.audioSeconds;
  bucket.estimatedCost += entry.cost;
  const p = bucket.byProvider[entry.provider] || (bucket.byProvider[entry.provider] = { sessions: 0, audioSeconds: 0, cost: 0 });
  p.sessions += 1;
  p.audioSeconds += entry.audioSeconds;
  p.cost += entry.cost;
  bucket.modes[entry.mode] = (bucket.modes[entry.mode] || 0) + 1;
}

/**
 * @param {unknown} log
 * @param {UsageEntry} entry
 * @param {Date} [now]
 * @returns {UsageLog}
 */
export function applyUsage(log, entry, now = new Date()) {
  const next = isV2(log) ? structuredClone(log) : emptyLog();
  const key = localDateKey(now);
  const day = next.daily[key] || (next.daily[key] = emptyBucket());
  addTo(day, entry);
  addTo(next.total, entry);

  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffKey = localDateKey(cutoff);
  for (const k of Object.keys(next.daily)) if (k < cutoffKey) delete next.daily[k];
  return next;
}

function sumDays(log, keys) {
  const acc = emptyBucket();
  for (const k of keys) {
    const d = log.daily[k];
    if (!d) continue;
    acc.sessions += d.sessions;
    acc.audioSeconds += d.audioSeconds;
    acc.estimatedCost += d.estimatedCost;
    for (const p of PROVIDER_KEYS) {
      acc.byProvider[p].sessions += d.byProvider?.[p]?.sessions || 0;
      acc.byProvider[p].audioSeconds += d.byProvider?.[p]?.audioSeconds || 0;
      acc.byProvider[p].cost += d.byProvider?.[p]?.cost || 0;
    }
    for (const [mode, n] of Object.entries(d.modes || {})) acc.modes[mode] = (acc.modes[mode] || 0) + n;
  }
  return acc;
}

/**
 * @param {unknown} log
 * @param {Date} [now]
 * @returns {{ today: Bucket, last7Days: Bucket, total: Bucket }}
 */
export function summarize(log, now = new Date()) {
  const src = isV2(log) ? log : emptyLog();
  const keys = (n) => Array.from({ length: n }, (_, i) => { const d = new Date(now); d.setDate(d.getDate() - i); return localDateKey(d); });
  return { today: sumDays(src, keys(1)), last7Days: sumDays(src, keys(7)), total: structuredClone(src.total) };
}
```

- [ ] **Step 5: Create `src/background/storage.js`**

```js
import { migrateSettings, SETTINGS_VERSION } from '../shared/defaults.js';
import { emptyLog } from './usage.js';

/**
 * @param {{ get: (key: string) => Promise<Record<string, unknown>>, set: (items: Record<string, unknown>) => Promise<void> }} area
 */
export function createStorage(area) {
  return {
    /** @returns {Promise<import('../shared/defaults.js').Settings>} */
    async getSettings() {
      const { settings } = await area.get('settings');
      const migrated = migrateSettings(settings);
      if (migrated !== settings) await area.set({ settings: migrated });
      return migrated;
    },
    /** @param {import('../shared/defaults.js').Settings} settings */
    async saveSettings(settings) {
      await area.set({ settings: { ...settings, settingsVersion: SETTINGS_VERSION } });
    },
    /** @returns {Promise<import('./usage.js').UsageLog>} */
    async getUsageLog() {
      const { usageLog } = await area.get('usageLog');
      return usageLog && usageLog.version === 2 ? usageLog : emptyLog();
    },
    /** @param {import('./usage.js').UsageLog} usageLog */
    async setUsageLog(usageLog) {
      await area.set({ usageLog });
    },
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run test/unit/background
```

Expected: 6 files, 39 tests passed.

- [ ] **Step 7: Commit**

```bash
git add src/background/usage.js src/background/storage.js test/unit/background/usage.test.js test/unit/background/storage.test.js
git commit -m "Add usage log v2 with local dates and plaintext settings storage"
```

---

### Task 9: Message router and service worker entry

**Files:**
- Create: `src/background/router.js`
- Rewrite: `src/background/index.js` (replace the whole v1 file)
- Test: `test/unit/background/router.test.js`

**Interfaces:**
- Consumes: `MSG`, `createStorage`, `runDictation`, `applyUsage`, `summarize`, `emptyLog`, adapters' `validateKey`.
- Produces:
  - `createRouter({ storage, runDictation, validateKey, applyUsage, summarize, toggleActiveTab }) => (request) => Promise<object|undefined>`
  - `userMessage(err: unknown): string`
  - Response shapes exactly as in spec section 4.3.

- [ ] **Step 1: Write the failing tests**

`test/unit/background/router.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRouter, userMessage } from '../../../src/background/router.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings } from '../../../src/shared/defaults.js';
import { emptyLog } from '../../../src/background/usage.js';
import { ProviderError } from '../../../src/background/providers/errors.js';

let deps, handle, saved, usageLog;
beforeEach(() => {
  saved = null; usageLog = emptyLog();
  const settings = freshSettings(); settings.keys.openai = 'sk-test';
  deps = {
    storage: {
      getSettings: vi.fn(async () => settings),
      saveSettings: vi.fn(async (s) => { saved = s; }),
      getUsageLog: vi.fn(async () => usageLog),
      setUsageLog: vi.fn(async (l) => { usageLog = l; }),
    },
    runDictation: vi.fn(async () => ({ raw: 'raw', text: 'final', provider: 'openai', sttModel: 'gpt-transcribe', textModel: null, audioSeconds: 12, cost: 0.0009 })),
    validateKey: vi.fn(async () => true),
    applyUsage: vi.fn((log, entry) => ({ ...log, lastEntry: entry })),
    summarize: vi.fn(() => ({ today: {}, last7Days: {}, total: {} })),
    toggleActiveTab: vi.fn(async () => true),
  };
  handle = createRouter(deps);
});

describe('router', () => {
  it('returns settings for getSettings', async () => {
    const s = await handle({ action: MSG.GET_SETTINGS });
    expect(s.keys.openai).toBe('sk-test');
  });

  it('saves settings', async () => {
    const s = freshSettings(); s.provider = 'gemini';
    expect(await handle({ action: MSG.SAVE_SETTINGS, settings: s })).toEqual({ success: true });
    expect(saved.provider).toBe('gemini');
  });

  it('reports whether the active provider has a key', async () => {
    expect(await handle({ action: MSG.CHECK_KEY })).toEqual({ hasKey: true });
  });

  it('validates a key and maps failures to friendly text', async () => {
    expect(await handle({ action: MSG.VALIDATE_KEY, provider: 'openai', key: 'sk-x' })).toEqual({ ok: true });
    expect(deps.validateKey).toHaveBeenCalledWith('openai', 'sk-x');
    deps.validateKey.mockRejectedValueOnce(new ProviderError('OpenAI rejected the API key.', { code: 'auth' }));
    expect(await handle({ action: MSG.VALIDATE_KEY, provider: 'openai', key: 'sk-bad' })).toEqual({ ok: false, error: 'OpenAI rejected the API key.' });
  });

  it('transcribes, logs usage and returns text, raw and cost', async () => {
    const res = await handle({ action: MSG.TRANSCRIBE, audioBase64: 'QUJD', mimeType: 'audio/webm', mode: 'email', audioDuration: 12.4 });
    expect(deps.runDictation).toHaveBeenCalledWith(expect.objectContaining({ audioBase64: 'QUJD', mimeType: 'audio/webm', modeKey: 'email', durationSec: 12.4 }));
    expect(deps.applyUsage).toHaveBeenCalledWith(expect.anything(), { provider: 'openai', audioSeconds: 12, cost: 0.0009, mode: 'email' });
    expect(deps.storage.setUsageLog).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ success: true, text: 'final', raw: 'raw', cost: 0.0009 });
  });

  it('returns a friendly error when dictation fails and logs nothing', async () => {
    deps.runDictation.mockRejectedValueOnce(new ProviderError('No speech detected.', { code: 'empty' }));
    const res = await handle({ action: MSG.TRANSCRIBE, audioBase64: 'QUJD', mode: 'default', audioDuration: 1 });
    expect(res).toEqual({ success: false, error: 'No speech detected.' });
    expect(deps.storage.setUsageLog).not.toHaveBeenCalled();
  });

  it('serves and clears usage', async () => {
    await handle({ action: MSG.GET_USAGE });
    expect(deps.summarize).toHaveBeenCalledWith(usageLog);
    expect(await handle({ action: MSG.CLEAR_USAGE })).toEqual({ success: true });
    expect(usageLog.total.sessions).toBe(0);
  });

  it('relays toggle-recording to the active tab', async () => {
    expect(await handle({ action: MSG.TOGGLE_RECORDING })).toEqual({ success: true });
    expect(deps.toggleActiveTab).toHaveBeenCalledTimes(1);
  });

  it('returns undefined for unknown actions', async () => {
    expect(await handle({ action: 'nope' })).toBeUndefined();
  });
});

describe('userMessage', () => {
  it('maps timeouts, provider errors, network errors and the rest', () => {
    expect(userMessage(new DOMException('x', 'TimeoutError'))).toBe('Request timed out. Try a shorter recording.');
    expect(userMessage(new ProviderError('Gemini rejected the API key.'))).toBe('Gemini rejected the API key.');
    expect(userMessage(new TypeError('fetch failed'))).toBe('Network error. Check your connection.');
    expect(userMessage(new Error('boom'))).toBe('Something went wrong. Try again.');
    expect(userMessage('weird')).toBe('Something went wrong. Try again.');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/unit/background/router.test.js
```

Expected: fails with "Failed to resolve import".

- [ ] **Step 3: Create `src/background/router.js`**

```js
import { MSG } from '../shared/messages.js';
import { emptyLog } from './usage.js';

/** Turn any thrown value into text safe to show on a web page. */
export function userMessage(err) {
  if (err && typeof err === 'object') {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'Request timed out. Try a shorter recording.';
    if (err.name === 'ProviderError') return err.message;
    if (err instanceof TypeError) return 'Network error. Check your connection.';
  }
  return 'Something went wrong. Try again.';
}

/**
 * @param {{
 *   storage: ReturnType<import('./storage.js').createStorage>,
 *   runDictation: typeof import('./pipeline.js').runDictation,
 *   validateKey: (provider: string, key: string) => Promise<boolean>,
 *   applyUsage: typeof import('./usage.js').applyUsage,
 *   summarize: typeof import('./usage.js').summarize,
 *   toggleActiveTab: () => Promise<boolean>,
 * }} deps
 */
export function createRouter({ storage, runDictation, validateKey, applyUsage, summarize, toggleActiveTab }) {
  return async function handle(request) {
    switch (request?.action) {
      case MSG.GET_SETTINGS:
        return storage.getSettings();

      case MSG.SAVE_SETTINGS:
        await storage.saveSettings(request.settings);
        return { success: true };

      case MSG.CHECK_KEY: {
        const settings = await storage.getSettings();
        return { hasKey: Boolean(settings.keys?.[settings.provider]) };
      }

      case MSG.VALIDATE_KEY:
        try {
          await validateKey(request.provider, request.key);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: userMessage(err) };
        }

      case MSG.TRANSCRIBE: {
        const settings = await storage.getSettings();
        try {
          const result = await runDictation({
            audioBase64: request.audioBase64,
            mimeType: request.mimeType || 'audio/webm',
            modeKey: request.mode,
            settings,
            durationSec: Number(request.audioDuration) || 0,
          });
          const log = applyUsage(await storage.getUsageLog(), {
            provider: result.provider, audioSeconds: result.audioSeconds, cost: result.cost, mode: request.mode,
          });
          await storage.setUsageLog(log);
          return { success: true, text: result.text, raw: result.raw, cost: result.cost };
        } catch (err) {
          return { success: false, error: userMessage(err) };
        }
      }

      case MSG.GET_USAGE:
        return summarize(await storage.getUsageLog());

      case MSG.CLEAR_USAGE:
        await storage.setUsageLog(emptyLog());
        return { success: true };

      case MSG.TOGGLE_RECORDING:
        await toggleActiveTab();
        return { success: true };

      default:
        return undefined;
    }
  };
}
```

- [ ] **Step 4: Replace `src/background/index.js` with the wired entry**

Delete the entire v1 content and write:

```js
// VoiceType service worker. Listeners only; logic lives in router.js and pipeline.js.
import { MSG } from '../shared/messages.js';
import { createStorage } from './storage.js';
import { createRouter, userMessage } from './router.js';
import { runDictation, ADAPTERS } from './pipeline.js';
import { applyUsage, summarize } from './usage.js';

const storage = createStorage(chrome.storage.local);

async function validateKey(provider, key) {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`Unknown provider: ${provider}`);
  return adapter.validateKey({ key, signal: AbortSignal.timeout(15_000) });
}

/** Send toggle to the active tab, injecting the content script if it is not there. */
async function toggleActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || '')) return false;
  try {
    await chrome.tabs.sendMessage(tab.id, { action: MSG.TOGGLE_RECORDING });
  } catch {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      setTimeout(() => { chrome.tabs.sendMessage(tab.id, { action: MSG.TOGGLE_RECORDING }).catch(() => {}); }, 150);
    } catch {
      // Page forbids injection (browser UI, store pages). Nothing to do.
    }
  }
  return true;
}

const handle = createRouter({ storage, runDictation, validateKey, applyUsage, summarize, toggleActiveTab });

chrome.runtime.onInstalled.addListener(() => { storage.getSettings().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { storage.getSettings().catch(() => {}); });

chrome.commands.onCommand.addListener((command) => {
  if (command === MSG.TOGGLE_RECORDING) toggleActiveTab();
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  handle(request).then(
    (response) => sendResponse(response ?? { success: false, error: 'Unknown action' }),
    (err) => sendResponse({ success: false, error: userMessage(err) }),
  );
  return true; // keep the channel open for the async response
});
```

- [ ] **Step 5: Run the tests and the build**

```bash
npx vitest run && npm run build
```

Expected: 11 files, 77 tests passed; build completes and `dist/background.js` exists. Load `dist/` as an unpacked extension in `chrome://extensions`; the service worker must show no errors in its console. Recording is not expected to work yet because the content script still sends v1-shaped messages (Task 11 fixes that).

- [ ] **Step 6: Commit**

```bash
git add src/background/router.js src/background/index.js test/unit/background/router.test.js
git commit -m "Replace the v1 service worker with a tested message router"
```

---

### Task 10: Field detection and the insertion ladder

**Files:**
- Create: `src/content/fields.js`, `src/content/insert.js`
- Test: `test/unit/content/fields.test.js`, `test/unit/content/insert.test.js` (both jsdom)

**Interfaces:**
- Produces:
  - `TEXT_INPUT_TYPES: Set<string>` (`text, search, email, url, tel`; never `password`)
  - `isValidInput(el: Element|null): boolean`
  - `deepActiveElement(root = document): Element|null` follows open shadow roots
  - `insertText(target: Element|null, text: string, deps?: { execCommand?, writeClipboard? }) => Promise<'inserted'|'clipboard'|'failed'>`
  - `readValue(el): string`

- [ ] **Step 1: Write the failing field tests**

`test/unit/content/fields.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { isValidInput, deepActiveElement, TEXT_INPUT_TYPES } from '../../../src/content/fields.js';

function make(html) {
  document.body.innerHTML = html;
  return document.body.firstElementChild;
}

describe('isValidInput', () => {
  it('accepts textareas and text-like inputs', () => {
    expect(isValidInput(make('<textarea></textarea>'))).toBe(true);
    for (const type of TEXT_INPUT_TYPES) expect(isValidInput(make(`<input type="${type}">`)), type).toBe(true);
    expect(isValidInput(make('<input>'))).toBe(true);
  });
  it('rejects password, number, checkbox, disabled and readonly fields', () => {
    expect(isValidInput(make('<input type="password">'))).toBe(false);
    expect(isValidInput(make('<input type="number">'))).toBe(false);
    expect(isValidInput(make('<input type="checkbox">'))).toBe(false);
    expect(isValidInput(make('<input type="text" disabled>'))).toBe(false);
    expect(isValidInput(make('<textarea readonly></textarea>'))).toBe(false);
  });
  it('accepts contenteditable and role=textbox, rejects plain elements and null', () => {
    expect(isValidInput(make('<div contenteditable="true"></div>'))).toBe(true);
    expect(isValidInput(make('<div role="textbox"></div>'))).toBe(true);
    expect(isValidInput(make('<div></div>'))).toBe(false);
    expect(isValidInput(null)).toBe(false);
    expect(isValidInput(document.createTextNode('x'))).toBe(false);
  });
});

describe('deepActiveElement', () => {
  it('descends into open shadow roots', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById('host');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<input id="inner" type="text">';
    root.getElementById('inner').focus();
    expect(deepActiveElement()).toBe(root.getElementById('inner'));
  });
  it('returns the light DOM active element otherwise', () => {
    document.body.innerHTML = '<textarea id="ta"></textarea>';
    document.getElementById('ta').focus();
    expect(deepActiveElement()).toBe(document.getElementById('ta'));
  });
});
```

- [ ] **Step 2: Write the failing insertion tests**

`test/unit/content/insert.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { insertText, readValue } from '../../../src/content/insert.js';

const noopExec = vi.fn(() => false);
/** execCommand stand-in that behaves like Chrome for form fields. */
function realisticExec(text) {
  const el = document.activeElement;
  if (!el || !('value' in el)) return false;
  const start = el.selectionStart, end = el.selectionEnd;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  el.setSelectionRange(start + text.length, start + text.length);
  return true;
}

function textarea(value = '', caret = value.length) {
  document.body.innerHTML = '<textarea id="ta"></textarea>';
  const el = document.getElementById('ta');
  el.value = value; el.focus(); el.setSelectionRange(caret, caret);
  return el;
}

describe('insertText', () => {
  it('uses execCommand when it changes the field', async () => {
    const el = textarea('Hello ', 6);
    const outcome = await insertText(el, 'world', { execCommand: realisticExec, writeClipboard: vi.fn() });
    expect(outcome).toBe('inserted');
    expect(el.value).toBe('Hello world');
  });

  it('falls back to the native setter at the caret and fires input events', async () => {
    const el = textarea('ab', 1);
    const events = [];
    el.addEventListener('input', (e) => events.push(e.inputType));
    const clipboard = vi.fn();
    const outcome = await insertText(el, 'X', { execCommand: noopExec, writeClipboard: clipboard });
    expect(outcome).toBe('inserted');
    expect(el.value).toBe('aXb');
    expect(el.selectionStart).toBe(2);
    expect(events).toEqual(['insertText']);
    expect(clipboard).not.toHaveBeenCalled();
  });

  it('appends to a contenteditable when there is no selection inside it', async () => {
    document.body.innerHTML = '<div id="ce" contenteditable="true">Hi</div>';
    const el = document.getElementById('ce');
    const outcome = await insertText(el, ' there', { execCommand: noopExec, writeClipboard: vi.fn() });
    expect(outcome).toBe('inserted');
    expect(el.textContent).toBe('Hi there');
  });

  it('disconnected target copies to clipboard', async () => {
    const el = document.createElement('textarea');
    const clipboard = vi.fn(async () => {});
    const outcome = await insertText(el, 'lost text', { execCommand: noopExec, writeClipboard: clipboard });
    expect(outcome).toBe('clipboard');
    expect(clipboard).toHaveBeenCalledWith('lost text');
  });

  it('null target copies to clipboard and clipboard failure reports failed', async () => {
    expect(await insertText(null, 't', { execCommand: noopExec, writeClipboard: vi.fn(async () => {}) })).toBe('clipboard');
    expect(await insertText(null, 't', { execCommand: noopExec, writeClipboard: vi.fn(async () => { throw new Error('denied'); }) })).toBe('failed');
  });

  it('does nothing for empty text', async () => {
    const el = textarea('keep');
    expect(await insertText(el, '', { execCommand: realisticExec, writeClipboard: vi.fn() })).toBe('failed');
    expect(el.value).toBe('keep');
  });

  it('readValue reads value for fields and textContent for editables', () => {
    document.body.innerHTML = '<input id="i" value="v"><div id="d">t</div>';
    expect(readValue(document.getElementById('i'))).toBe('v');
    expect(readValue(document.getElementById('d'))).toBe('t');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npx vitest run test/unit/content
```

Expected: both fail with "Failed to resolve import".

- [ ] **Step 4: Create `src/content/fields.js`**

```js
export const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel']);

/**
 * True for elements VoiceType may dictate into. Password fields are excluded on purpose:
 * their audio would otherwise be sent to a cloud API.
 * @param {Element|null|undefined} el
 */
export function isValidInput(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return !el.disabled && !el.readOnly;
  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return TEXT_INPUT_TYPES.has(type) && !el.disabled && !el.readOnly;
  }
  if (el.isContentEditable) return true;
  return el.getAttribute('role') === 'textbox';
}

/**
 * document.activeElement stops at shadow hosts; follow open shadow roots down.
 * @param {Document|ShadowRoot} [root]
 */
export function deepActiveElement(root = document) {
  let el = root.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}
```

- [ ] **Step 5: Create `src/content/insert.js`**

```js
// Insertion ladder. Each rung is verified by reading the field back; the return value
// of execCommand is never trusted because it is false without a user gesture.

/** @param {Element} el */
export function readValue(el) {
  return isFormField(el) ? el.value : el.textContent;
}

function isFormField(el) {
  const tag = el?.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea';
}

/**
 * @param {Element|null} target
 * @param {string} text
 * @param {{ execCommand?: (text: string) => boolean, writeClipboard?: (text: string) => Promise<void> }} [deps]
 * @returns {Promise<'inserted'|'clipboard'|'failed'>}
 */
export async function insertText(target, text, deps = {}) {
  const execCommand = deps.execCommand || ((t) => document.execCommand('insertText', false, t));
  const writeClipboard = deps.writeClipboard || ((t) => navigator.clipboard.writeText(t));
  if (!text) return 'failed';
  if (!target || !target.isConnected) return copy(text, writeClipboard);

  try { target.focus(); } catch { /* some hosts throw on focus */ }
  const before = readValue(target);

  try { execCommand(text); } catch { /* fall through to the next rung */ }
  if (readValue(target) !== before) return 'inserted';

  const changed = isFormField(target) ? setFormValue(target, text) : setEditableText(target, text);
  if (changed && readValue(target) !== before) return 'inserted';

  return copy(text, writeClipboard);
}

async function copy(text, writeClipboard) {
  try {
    await writeClipboard(text);
    return 'clipboard';
  } catch {
    return 'failed';
  }
}

function inputEvent(type, text) {
  const Ctor = typeof InputEvent === 'function' ? InputEvent : Event;
  return new Ctor(type, { bubbles: true, inputType: 'insertText', data: text });
}

function setFormValue(el, text) {
  try {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    const proto = el.tagName.toLowerCase() === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, next); else el.value = next;
    const caret = start + text.length;
    try { el.setSelectionRange(caret, caret); } catch { /* email and number inputs refuse */ }
    el.dispatchEvent(inputEvent('input', text));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  } catch {
    return false;
  }
}

function setEditableText(el, text) {
  try {
    const doc = el.ownerDocument;
    const sel = doc.getSelection();
    let range;
    if (sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      range = sel.getRangeAt(0);
    } else {
      range = doc.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    range.deleteContents();
    const node = doc.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.setEndAfter(node);
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    el.dispatchEvent(inputEvent('input', text));
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run test/unit/content
```

Expected: 2 files, 12 tests passed.

- [ ] **Step 7: Commit**

```bash
git add src/content/fields.js src/content/insert.js test/unit/content
git commit -m "Add field detection without password fields and a verified insertion ladder"
```

---

### Task 11: Content script patches

The content script keeps its v1 structure (the Shadow DOM pill is Phase 1). This task applies eleven targeted edits to `src/content/index.js`. Line numbers refer to the v1 file as moved in Task 1. Work top to bottom; later line numbers shift as you edit, so locate each region by the function name given.

**Files:**
- Modify: `src/content/index.js`

**Interfaces:**
- Consumes: `MSG`, `PROVIDERS`, `formatCost`, `freshSettings`, `isValidInput`, `deepActiveElement`, `insertText`.
- Produces: content script sending v2 messages (`audioBase64`, `mimeType`) and reading settings v2 (`settings.keys`, no `model` fields).

- [ ] **Step 1: Remove the IIFE wrapper and add imports**

Delete line 4 (`(function() {`), line 5 (`'use strict';`) and the closing line 1090 (`})();`). esbuild wraps the bundle. At the top of the file (after the two comment lines) add:

```js
import { MSG } from '../shared/messages.js';
import { PROVIDERS } from '../shared/models.js';
import { formatCost } from '../shared/pricing.js';
import { freshSettings } from '../shared/defaults.js';
import { isValidInput, deepActiveElement } from './fields.js';
import { insertText } from './insert.js';
```

Add one state variable next to the others:

```js
let isStarting = false; // getUserMedia in flight; blocks toggles until it settles
```

- [ ] **Step 2: Add a `send()` helper with orphan detection**

Insert directly after the state block:

```js
// Every message to the service worker goes through here so a reloaded extension
// (orphaned content script) produces one clear notice instead of console noise.
function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          handleRuntimeError(chrome.runtime.lastError);
          resolve(null);
        } else {
          resolve(response);
        }
      });
    } catch (err) {
      handleRuntimeError(err);
      resolve(null);
    }
  });
}

function handleRuntimeError(err) {
  const text = String(err?.message || err);
  if (text.includes('Extension context invalidated') || text.includes('message port closed')) {
    showStatus('VoiceType was updated. Reload this page.', 'error', { sticky: true });
  } else {
    console.error('VoiceType: runtime error', err);
  }
}
```

- [ ] **Step 3: Load settings v2 in `init()`**

Replace the settings load block (v1 lines 35 to 59, from `settings = await new Promise(` through the closing `}` of `if (!settings) { ... }`) with:

```js
settings = (await send({ action: MSG.GET_SETTINGS })) || freshSettings();
```

In the same function, replace the two `document.activeElement` reads (v1 lines 87 and 105) with `deepActiveElement()`. Also in the `toggle-recording` listener add the starting guard: after `if (isRecording) { ... return false; }` insert:

```js
if (isStarting) { sendResponse({ received: true }); return false; }
```

- [ ] **Step 4: Delete the local `isValidInput`**

Remove the whole v1 function `isValidInput` (lines 115 to 137). The import from `./fields.js` replaces it.

- [ ] **Step 5: Remove model selection from the dropdown**

In `updateDropdown()`:
- Delete the `openaiModels` and `geminiModels` template constants (v1 lines 258 to 275).
- Delete the Model section from the `dropdown.innerHTML` template (v1 lines 295 to 300, the `<div class="vt-dropdown-section">` containing `Model`).
- Replace the two provider buttons (v1 lines 287 to 292) with:

```js
${Object.entries(PROVIDERS).map(([id, p]) => `
  <button class="vt-provider-btn ${provider === id ? 'active' : ''}" data-provider="${id}">${p.label}</button>
`).join('')}
```

- Add a 5 minute option to the Max Recording row so it matches the popup: after the `180` button add
  `<button class="vt-time-btn ${maxTime === 300 ? 'active' : ''}" data-time="300">5m</button>`.
- Delete the model click-handler block (v1 lines 358 to 364).
- Delete the final `loadUsageForDropdown();` call (v1 line 382). Usage now loads only when the dropdown opens (`openDropdown` already calls it).

In `loadUsageForDropdown()` replace `chrome.runtime.sendMessage({ action: 'getUsageStats' }, resolve)` with `send({ action: MSG.GET_USAGE }).then(resolve)`, and delete the local `formatCost` function (v1 lines 416 to 419); the import replaces it.

In `selectProvider()` delete everything from `// Update model buttons for new provider` through the end of the `if (modelRow) { ... }` block (v1 lines 432 to 453) and replace the status line with:

```js
showStatus(`Provider: ${PROVIDERS[provider]?.label || provider}`, '');
```

Delete the whole `selectModel` function (v1 lines 458 to 481).

In `saveSettings()` replace the body with `send({ action: MSG.SAVE_SETTINGS, settings });`.

- [ ] **Step 6: Sticky status messages**

Replace `showStatus` (v1 lines 1061 to 1073) with:

```js
function showStatus(message, type = '', { sticky = false } = {}) {
  if (!pill) return;
  const statusEl = pill.querySelector('.vt-status');
  statusEl.textContent = message;
  statusEl.className = `vt-status show ${type}`;
  clearTimeout(statusTimeout);
  if (!sticky) statusTimeout = setTimeout(() => statusEl.classList.remove('show'), 2500);
}
```

- [ ] **Step 7: Fix the start race and lower the bitrate**

Replace `startRecording` (v1 lines 704 to 774) with:

```js
async function startRecording() {
  if (isRecording || isStopping || isStarting) return;
  isStarting = true;
  try {
    const apiCheck = await send({ action: MSG.CHECK_KEY });
    if (!apiCheck?.hasKey) {
      showStatus('Add an API key in the extension settings', 'error');
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = handleRecordingComplete;
    setupAudioAnalyzer(stream);
    mediaRecorder.start(100);
    recordingStartTime = Date.now();
    isRecording = true; // only now: nothing can observe a half-started recorder

    const maxTime = (settings?.maxRecordingTime || 120) * 1000;
    maxRecordingTimer = setTimeout(() => {
      if (isRecording && !isStopping) {
        showStatus('Max time reached', '');
        stopRecording();
      }
    }, maxTime);

    pill.classList.add('recording');
    expandPill();
    updateRecordButton(true);
    startRecordingTimer();
    startVoiceVisualization();
  } catch (err) {
    console.error('VoiceType: Failed to start recording', err);
    showStatus(err?.name === 'NotAllowedError' ? 'Microphone access denied' : 'Could not start the microphone', 'error');
  } finally {
    isStarting = false;
  }
}
```

In `toggleRecording()` change `if (isStopping || isProcessing) return;` to `if (isStopping || isProcessing || isStarting) return;`.

- [ ] **Step 8: Honor `minRecordingTime`, keep the processing notice visible, insert through the ladder**

Replace `handleRecordingComplete` (v1 lines 933 to 1006) with:

```js
async function handleRecordingComplete() {
  if (isProcessing) { isStopping = false; return; }
  isProcessing = true;
  const recordingDuration = recordingStartTime ? (Date.now() - recordingStartTime) / 1000 : 0;
  recordingStartTime = null;
  const minTime = Number(settings?.minRecordingTime ?? 1);

  try {
    if (recordingDuration < minTime) {
      showStatus('Too short, ignored', 'warning');
      collapsePill();
      return;
    }
    if (audioChunks.length === 0) {
      showStatus('No audio recorded', 'warning');
      return;
    }
    showStatus('Processing…', 'processing', { sticky: true });

    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
    const base64 = await blobToBase64(audioBlob);
    const watchdog = new Promise((resolve) => {
      setTimeout(() => resolve({ success: false, error: 'No response from the extension. Try again.' }), 75_000);
    });
    const response = await Promise.race([
      send({
        action: MSG.TRANSCRIBE,
        audioBase64: base64,
        mimeType: 'audio/webm',
        mode: settings?.activeMode || 'default',
        audioDuration: recordingDuration,
      }),
      watchdog,
    ]);
    if (!response) throw new Error('VoiceType is not responding. Reload the page.');
    if (!response.success) throw new Error(response.error || 'Transcription failed');

    const outcome = await insertText(currentInput, response.text);
    if (outcome === 'inserted') showStatus(`Done ${formatCost(response.cost || 0)}`, 'success');
    else if (outcome === 'clipboard') showStatus('Copied to clipboard (field not editable)', 'warning');
    else showStatus('Could not insert or copy the text', 'error');
    setTimeout(collapsePill, 1500);
  } catch (err) {
    console.error('VoiceType: Transcription failed', err);
    showStatus(err.message, 'error');
  } finally {
    audioChunks = [];
    isProcessing = false;
    isStopping = false;
  }
}
```

Delete the v1 `insertText` function (lines 1021 to 1059); the import replaces it.

- [ ] **Step 9: Use the composed focus target and stop rebuilding an open dropdown**

Replace `handleFocusIn` with:

```js
function handleFocusIn(e) {
  const target = e.composedPath ? e.composedPath()[0] : e.target;
  if (isValidInput(target)) {
    currentInput = target;
    showPill(target);
  }
}
```

In `handleFocusOut` replace both `document.activeElement` reads with `deepActiveElement()`.

Replace the `chrome.storage.onChanged` listener body with:

```js
if (namespace === 'local' && changes.settings) {
  settings = changes.settings.newValue;
  if (dropdownOpen) updateModeButton(); else updateDropdown();
}
```

- [ ] **Step 10: Strip emoji from status strings**

Search the file for `showStatus('` and remove leading emoji from every literal (`⚠️`, `❌`, `✓`, `⏳`, `⏱️`, `📋`). Mode icons in the menu stay (they are user data and Phase 1 replaces the pill).

- [ ] **Step 11: Build and smoke**

```bash
npm run build
```

Reload the unpacked extension. On `test/fixtures/fields.html` (open it via `file://` after enabling "Allow access to file URLs" for the extension, or serve it with `npx serve test/fixtures`):
- Focus the textarea, click REC, speak 3 seconds, click stop. Expected: "Processing…" stays visible until "Done <cost>" appears and the text is inserted.
- Focus the password field. Expected: no pill.
- Record for under one second. Expected: "Too short, ignored".
- Reload the extension from `chrome://extensions` without reloading the page, then click REC. Expected: "VoiceType was updated. Reload this page."

- [ ] **Step 12: Commit**

```bash
git add src/content/index.js
git commit -m "Patch content script for settings v2, start race, sticky status and insertion ladder"
```

---

### Task 12: Popup for settings v2 with autosave

The popup is small enough to rewrite. Replace `popup.html` and `popup.js` entirely; append a few rules to `popup.css`.

**Files:**
- Rewrite: `src/popup/popup.html`, `src/popup/popup.js`
- Modify: `src/popup/popup.css` (append only)

**Interfaces:**
- Consumes: `MSG`, `PROVIDERS`, `formatCost`, `freshSettings`.
- Produces: a popup that reads and writes settings v2, saves on every change, validates keys via `MSG.VALIDATE_KEY`, and never shows a Save or Start Recording button.

- [ ] **Step 1: Replace `src/popup/popup.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>VoiceType</title>
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div class="container">
    <header class="header">
      <div class="logo">
        <span class="logo-icon" aria-hidden="true">🎙️</span>
        <div class="logo-text">
          <h1>VoiceType</h1>
          <span class="tagline">BYOK speech to text</span>
        </div>
      </div>
      <div class="status-indicator" id="status-indicator" role="status">
        <span class="status-dot"></span>
        <span class="status-text">Add API key</span>
      </div>
    </header>

    <div class="tabs" role="tablist">
      <button class="tab active" data-tab="settings" role="tab">Settings</button>
      <button class="tab" data-tab="modes" role="tab">Modes</button>
      <button class="tab" data-tab="usage" role="tab">Usage</button>
    </div>

    <div class="tab-content active" id="tab-settings">
      <section class="section">
        <div class="form-group">
          <label>Provider</label>
          <div class="provider-tabs">
            <button class="provider-tab" data-provider="openai">OpenAI</button>
            <button class="provider-tab" data-provider="gemini">Gemini</button>
          </div>
        </div>

        <div class="provider-settings" id="openai-settings">
          <div class="form-group">
            <label for="api-key">OpenAI API key</label>
            <div class="key-row">
              <input type="text" id="api-key" class="key-input" autocomplete="off" spellcheck="false" placeholder="sk-...">
              <button type="button" class="btn btn-secondary btn-small" id="test-key">Test</button>
              <button type="button" class="btn btn-secondary btn-small" id="clear-key" title="Clear key">Clear</button>
            </div>
          </div>
        </div>

        <div class="provider-settings" id="gemini-settings" style="display: none;">
          <div class="form-group">
            <label for="gemini-key">Gemini API key</label>
            <div class="key-row">
              <input type="text" id="gemini-key" class="key-input" autocomplete="off" spellcheck="false" placeholder="AQ.... or AIza...">
              <button type="button" class="btn btn-secondary btn-small" id="test-gemini-key">Test</button>
              <button type="button" class="btn btn-secondary btn-small" id="clear-gemini-key" title="Clear key">Clear</button>
            </div>
          </div>
        </div>

        <p class="help-text warning" id="api-key-warning" style="display: none;">Set a spending limit on your provider account.</p>

        <div class="form-row">
          <div class="form-group compact">
            <label for="min-time">Min recording</label>
            <select id="min-time">
              <option value="0.5">0.5 s</option>
              <option value="1">1 s</option>
              <option value="2">2 s</option>
              <option value="3">3 s</option>
            </select>
          </div>
          <div class="form-group compact">
            <label for="max-time">Max recording</label>
            <select id="max-time">
              <option value="30">30 s</option>
              <option value="60">1 min</option>
              <option value="120">2 min</option>
              <option value="180">3 min</option>
              <option value="300">5 min</option>
            </select>
          </div>
        </div>
      </section>

      <div class="shortcut-row">
        <span><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> toggles recording</span>
        <a href="#" id="shortcuts-link">change</a>
      </div>

      <p class="help-text">Settings save automatically.</p>
      <button class="btn-text" id="reset-defaults">Reset settings to defaults (keys are kept)</button>
    </div>

    <div class="tab-content" id="tab-modes">
      <section class="section">
        <h2 class="section-title">
          Modes
          <button class="btn-icon" id="add-mode" title="Add custom mode" aria-label="Add custom mode">+</button>
        </h2>
        <div class="modes-list" id="modes-list"></div>
      </section>

      <section class="section" id="mode-editor" style="display: none;">
        <h2 class="section-title"><span id="editor-title">Edit mode</span></h2>
        <div class="form-group">
          <label for="mode-name">Name</label>
          <input type="text" id="mode-name" placeholder="e.g. Meeting notes">
        </div>
        <div class="form-group">
          <label for="mode-icon">Icon (emoji)</label>
          <input type="text" id="mode-icon" placeholder="e.g. 📝" maxlength="8">
        </div>
        <div class="form-group">
          <label for="mode-prompt">Instructions for the text model</label>
          <textarea id="mode-prompt" rows="5" placeholder="Leave empty for raw transcription."></textarea>
          <p class="help-text">Applied to the transcript after speech recognition. Empty means insert the transcript as is.</p>
        </div>
        <div class="button-group">
          <button class="btn btn-secondary" id="cancel-edit">Cancel</button>
          <button class="btn btn-danger" id="delete-mode" style="display: none;">Delete</button>
          <button class="btn btn-primary" id="save-mode">Save mode</button>
        </div>
      </section>
    </div>

    <div class="tab-content" id="tab-usage">
      <section class="section">
        <div class="stats-compact">
          <div class="stats-row-header"><span></span><span>Sessions</span><span>Audio</span><span>Cost</span></div>
          <div class="stats-row-data"><span class="stats-period">Today</span><span id="today-sessions">0</span><span id="today-time">0:00</span><span id="today-cost">$0.00</span></div>
          <div class="stats-row-data"><span class="stats-period">7 days</span><span id="week-sessions">0</span><span id="week-time">0:00</span><span id="week-cost">$0.00</span></div>
          <div class="stats-row-data highlight"><span class="stats-period">All time</span><span id="total-sessions">0</span><span id="total-time">0:00</span><span id="total-cost">$0.00</span></div>
        </div>
        <div class="provider-breakdown">
          <div class="provider-stat"><span class="provider-name">OpenAI</span><span class="provider-data"><span id="openai-sessions">0</span> sessions, <span id="openai-time">0:00</span></span><span class="provider-cost" id="openai-cost">$0.00</span></div>
          <div class="provider-stat"><span class="provider-name">Gemini</span><span class="provider-data"><span id="gemini-sessions">0</span> sessions, <span id="gemini-time">0:00</span></span><span class="provider-cost" id="gemini-cost">$0.00</span></div>
        </div>
        <p class="help-text center">Estimates from list prices. Check your provider dashboard for billing.</p>
        <div class="usage-actions">
          <button class="btn-text" id="refresh-stats">Refresh</button>
          <button class="btn-text danger" id="clear-stats">Clear history</button>
        </div>
      </section>
    </div>

    <footer class="footer">
      <span class="version-text" id="version-text"></span>
      <span class="credits-text">by K. S. Karakostas</span>
    </footer>
  </div>
  <div class="toast" id="toast" role="status"></div>
  <script src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 2: Append to `src/popup/popup.css`**

```css
/* v2 additions */
.key-row { display: flex; gap: 4px; align-items: center; }
.key-row .key-input { flex: 1; min-width: 0; font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace; }
.btn-small { padding: 6px 8px; font-size: 10px; white-space: nowrap; }
.btn-secondary:disabled { opacity: 0.6; cursor: wait; }
#reset-defaults { display: block; margin: 6px auto 0; }
.mode-item .mode-badge { font-size: 9px; color: var(--text-muted); margin-left: 4px; }
.mode-item.active .mode-badge { color: rgba(255, 255, 255, 0.8); }
```

- [ ] **Step 3: Replace `src/popup/popup.js`**

```js
// VoiceType popup. Reads settings v2, saves on every change.
import { MSG } from '../shared/messages.js';
import { PROVIDERS } from '../shared/models.js';
import { formatCost } from '../shared/pricing.js';
import { freshSettings } from '../shared/defaults.js';

/** @type {import('../shared/defaults.js').Settings} */
let settings;
let editingMode = null;
let isNewMode = false;

const $ = (id) => document.getElementById(id);
const el = {
  providerSections: { openai: $('openai-settings'), gemini: $('gemini-settings') },
  keyInput: { openai: $('api-key'), gemini: $('gemini-key') },
  testKey: { openai: $('test-key'), gemini: $('test-gemini-key') },
  clearKey: { openai: $('clear-key'), gemini: $('clear-gemini-key') },
  keyWarning: $('api-key-warning'),
  minTime: $('min-time'),
  maxTime: $('max-time'),
  modesList: $('modes-list'),
  modeEditor: $('mode-editor'),
  editorTitle: $('editor-title'),
  modeName: $('mode-name'),
  modeIcon: $('mode-icon'),
  modePrompt: $('mode-prompt'),
  addMode: $('add-mode'),
  saveMode: $('save-mode'),
  cancelEdit: $('cancel-edit'),
  deleteMode: $('delete-mode'),
  resetDefaults: $('reset-defaults'),
  statusIndicator: $('status-indicator'),
  shortcutsLink: $('shortcuts-link'),
  toast: $('toast'),
  versionText: $('version-text'),
  refreshStats: $('refresh-stats'),
  clearStats: $('clear-stats'),
};

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(chrome.runtime.lastError ? null : response));
  });
}

async function persist() {
  await send({ action: MSG.SAVE_SETTINGS, settings });
}

async function init() {
  settings = (await send({ action: MSG.GET_SETTINGS })) || freshSettings();
  el.versionText.textContent = `v${chrome.runtime.getManifest().version}`;
  populateUI();
  setupTabs();
  setupEventListeners();
  await loadUsageStats();
}

function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  const contents = document.querySelectorAll('.tab-content');
  tabs.forEach((tab) => tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.toggle('active', t === tab));
    contents.forEach((c) => c.classList.toggle('active', c.id === `tab-${tab.dataset.tab}`));
  }));
}

function maskKey(key) {
  return key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)} (saved)` : 'saved';
}

function populateUI() {
  const provider = settings.provider;
  document.querySelectorAll('.provider-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.provider === provider));
  for (const id of Object.keys(PROVIDERS)) {
    el.providerSections[id].style.display = id === provider ? 'block' : 'none';
    const key = settings.keys[id] || '';
    el.keyInput[id].value = '';
    el.keyInput[id].placeholder = key ? maskKey(key) : PROVIDERS[id].keyPlaceholder;
  }
  el.keyWarning.style.display = Object.values(settings.keys).some(Boolean) ? 'block' : 'none';
  el.minTime.value = String(settings.minRecordingTime ?? 1);
  el.maxTime.value = String(settings.maxRecordingTime ?? 120);
  renderModesList();
  updateStatus();
}

function updateStatus() {
  const hasKey = Boolean(settings.keys[settings.provider]);
  el.statusIndicator.classList.toggle('ready', hasKey);
  el.statusIndicator.querySelector('.status-text').textContent = hasKey ? 'Ready' : 'Add API key';
}

function renderModesList() {
  el.modesList.replaceChildren();
  for (const [key, mode] of Object.entries(settings.modes)) {
    const item = document.createElement('div');
    item.className = `mode-item ${settings.activeMode === key ? 'active' : ''}`;
    item.dataset.mode = key;

    const icon = document.createElement('span');
    icon.className = 'mode-icon';
    icon.textContent = mode.icon || '🎯';

    const info = document.createElement('div');
    info.className = 'mode-info';
    const name = document.createElement('div');
    name.className = 'mode-name';
    name.textContent = mode.name;
    if (mode.builtIn) {
      const badge = document.createElement('span');
      badge.className = 'mode-badge';
      badge.textContent = 'built-in';
      name.append(badge);
    }
    const preview = document.createElement('div');
    preview.className = 'mode-prompt-preview';
    preview.textContent = (mode.prompt || '').trim() ? mode.prompt.slice(0, 60) : 'Raw transcription';
    info.append(name, preview);

    const edit = document.createElement('button');
    edit.className = 'mode-action-btn';
    edit.title = 'Edit';
    edit.setAttribute('aria-label', `Edit ${mode.name}`);
    edit.textContent = '✎';
    edit.addEventListener('click', (e) => { e.stopPropagation(); openModeEditor(key); });

    item.append(icon, info, edit);
    item.addEventListener('click', () => selectMode(key));
    el.modesList.append(item);
  }
}

async function selectMode(key) {
  settings.activeMode = key;
  renderModesList();
  await persist();
  showToast(`Mode: ${settings.modes[key].name}`);
}

function openModeEditor(key = null) {
  isNewMode = !key;
  editingMode = key;
  if (isNewMode) {
    el.editorTitle.textContent = 'New mode';
    el.modeName.value = '';
    el.modeIcon.value = '🎯';
    el.modePrompt.value = '';
    el.deleteMode.style.display = 'none';
  } else {
    const mode = settings.modes[key];
    el.editorTitle.textContent = 'Edit mode';
    el.modeName.value = mode.name;
    el.modeIcon.value = mode.icon;
    el.modePrompt.value = mode.prompt || '';
    el.deleteMode.style.display = mode.builtIn ? 'none' : 'block';
  }
  el.modeEditor.style.display = 'block';
  el.modeName.focus();
}

function closeModeEditor() {
  el.modeEditor.style.display = 'none';
  editingMode = null;
  isNewMode = false;
}

async function saveModeChanges() {
  const name = el.modeName.value.trim();
  const icon = el.modeIcon.value.trim() || '🎯';
  const prompt = el.modePrompt.value.trim();
  if (!name) { showToast('Enter a mode name', 'error'); return; }
  const key = isNewMode ? `custom_${Date.now()}` : editingMode;
  const existing = settings.modes[key] || { builtIn: false };
  settings.modes[key] = { ...existing, name, icon, prompt };
  renderModesList();
  closeModeEditor();
  await persist();
  showToast(isNewMode ? 'Mode created' : 'Mode updated', 'success');
}

async function deleteCurrentMode() {
  if (!editingMode || settings.modes[editingMode]?.builtIn) return;
  delete settings.modes[editingMode];
  if (settings.activeMode === editingMode) settings.activeMode = 'default';
  renderModesList();
  closeModeEditor();
  await persist();
  showToast('Mode deleted', 'success');
}

async function resetToDefaults() {
  if (!confirm('Reset all settings to defaults? Your API keys are kept.')) return;
  const keys = { ...settings.keys };
  settings = { ...freshSettings(), keys };
  populateUI();
  await persist();
  showToast('Settings reset', 'success');
}

function showToast(message, type = '') {
  el.toast.textContent = message;
  el.toast.className = `toast ${type} show`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.toast.classList.remove('show'), 2500);
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mmss = `${m}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : mmss;
}

async function loadUsageStats() {
  const stats = await send({ action: MSG.GET_USAGE });
  if (!stats) return;
  const fill = (prefix, bucket) => {
    $(`${prefix}-sessions`).textContent = bucket.sessions || 0;
    $(`${prefix}-time`).textContent = formatTime(bucket.audioSeconds || 0);
    $(`${prefix}-cost`).textContent = formatCost(bucket.estimatedCost || 0);
  };
  fill('today', stats.today);
  fill('week', stats.last7Days);
  fill('total', stats.total);
  for (const id of Object.keys(PROVIDERS)) {
    const p = stats.total.byProvider?.[id] || { sessions: 0, audioSeconds: 0, cost: 0 };
    $(`${id}-sessions`).textContent = p.sessions;
    $(`${id}-time`).textContent = formatTime(p.audioSeconds);
    $(`${id}-cost`).textContent = formatCost(p.cost);
  }
}

async function testKey(provider) {
  const typed = el.keyInput[provider].value.trim();
  const key = typed || settings.keys[provider];
  if (!key) { showToast('Enter a key first', 'error'); return; }
  const button = el.testKey[provider];
  button.disabled = true;
  button.textContent = 'Testing…';
  const result = await send({ action: MSG.VALIDATE_KEY, provider, key });
  button.disabled = false;
  button.textContent = 'Test';
  if (result?.ok) showToast(`${PROVIDERS[provider].label} key works`, 'success');
  else showToast(result?.error || 'Could not reach the provider', 'error');
}

function setupEventListeners() {
  document.querySelectorAll('.provider-tab').forEach((tab) => tab.addEventListener('click', async () => {
    settings.provider = tab.dataset.provider;
    populateUI();
    await persist();
  }));

  for (const provider of Object.keys(PROVIDERS)) {
    el.keyInput[provider].addEventListener('change', async () => {
      const value = el.keyInput[provider].value.trim();
      if (!value) return;
      settings.keys[provider] = value;
      populateUI();
      await persist();
      showToast('Key saved', 'success');
    });
    el.testKey[provider].addEventListener('click', () => testKey(provider));
    el.clearKey[provider].addEventListener('click', async () => {
      settings.keys[provider] = '';
      populateUI();
      await persist();
      showToast('Key cleared', 'success');
    });
  }

  el.minTime.addEventListener('change', async () => { settings.minRecordingTime = Number(el.minTime.value) || 1; await persist(); });
  el.maxTime.addEventListener('change', async () => { settings.maxRecordingTime = Number(el.maxTime.value) || 120; await persist(); });

  el.addMode.addEventListener('click', () => openModeEditor());
  el.saveMode.addEventListener('click', saveModeChanges);
  el.cancelEdit.addEventListener('click', closeModeEditor);
  el.deleteMode.addEventListener('click', deleteCurrentMode);
  el.resetDefaults.addEventListener('click', resetToDefaults);

  el.refreshStats.addEventListener('click', loadUsageStats);
  el.clearStats.addEventListener('click', async () => {
    if (!confirm('Clear all usage history? This cannot be undone.')) return;
    await send({ action: MSG.CLEAR_USAGE });
    await loadUsageStats();
    showToast('Usage history cleared', 'success');
  });

  el.shortcutsLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
}

document.addEventListener('DOMContentLoaded', init);
```

- [ ] **Step 4: Build and smoke the popup**

```bash
npm run build
```

Reload the extension and open the popup:
- Paste a Gemini key that starts with `AQ.`, press Tab. Expected: toast "Key saved", placeholder shows the masked key, status turns Ready.
- Click Test. Expected: "Gemini key works" or a friendly error, never a raw provider body.
- Switch to the Modes tab, click Email. Close the popup, reopen: Email is still active (autosave).
- Edit the Translate mode's name and save; the built-in badge stays and Delete is hidden.
- Reset settings to defaults: both keys survive.
- Regression for the v1 corruption bug: change max recording twice across two popup sessions, then dictate. Expected: transcription works.

- [ ] **Step 5: Commit**

```bash
git add src/popup
git commit -m "Rewrite popup for settings v2 with autosave, key test and built-in mode protection"
```

---

### Task 13: Manifest, README, privacy policy and changelog

**Files:**
- Rewrite: `manifest.json`
- Modify: `README.md`, `PRIVACY.md`
- Create: `CHANGELOG.md`

- [ ] **Step 1: Replace `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "VoiceType - BYOK Speech to Text",
  "short_name": "VoiceType",
  "version": "2.0.0",
  "description": "Dictate into any text field with your own OpenAI or Gemini API key. Modes for transcription, email, translation and instructions. Every session priced.",
  "author": "K. S. Karakostas",
  "permissions": ["storage", "activeTab", "scripting"],
  "host_permissions": [
    "https://api.openai.com/*",
    "https://generativelanguage.googleapis.com/*"
  ],
  "background": { "service_worker": "background.js" },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "css": ["content.css"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_popup": "popup.html",
    "default_title": "VoiceType",
    "default_icon": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
  },
  "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" },
  "commands": {
    "toggle-recording": {
      "suggested_key": { "default": "Ctrl+Shift+Space", "mac": "Command+Shift+Space" },
      "description": "Start or stop voice recording"
    }
  },
  "minimum_chrome_version": "116"
}
```

Removed on purpose: `web_accessible_resources` (let sites fingerprint the extension) and the `<all_urls>` host permission (the content script match already covers injection; API fetches need only the two origins above).

- [ ] **Step 2: Update `README.md`**

Apply these replacements:
1. Version badge: `version-1.7.5-purple` becomes `version-2.0.0-purple`.
2. Tagline line "🎙️ AI-Powered Speech to Text for Chrome" becomes "BYOK dictation for Chrome with cost transparency".
3. Feature cell "Multi-Provider Support": replace the body with "Bring your own OpenAI or Gemini key. Speech recognition uses `gpt-transcribe` or `gemini-3.5-transcribe`; modes such as Email run the transcript through `gpt-6-luna` or `gemini-3.8-flash`."
4. Feature cell "Privacy First": replace the body with "Keys stay in your browser's local extension storage, never synced. Audio goes straight to the provider you chose. No server of ours exists."
5. Quick Start "Install the Extension": after the clone step add
   ```bash
   npm install
   npm run build
   ```
   and change "Select the extension folder" to "Select the `dist/` folder".
6. Pricing table: replace rows with `OpenAI | gpt-transcribe | ~$0.0045 per minute`, `OpenAI | gpt-6-luna (modes) | $0.10 in / $0.50 out per 1M tokens`, `Gemini | gemini-3.5-transcribe | ~$0.005 per minute`, `Gemini | gemini-3.8-flash (modes) | $0.75 in / $3.75 out per 1M tokens`.
7. FAQ "Which provider should I use?": replace the body with "Both are accurate for dictation. Gemini's transcribe model removes filler words on its own. OpenAI is the default. Costs are comparable; see the Usage tab."
8. FAQ "Why are short recordings ignored?": replace with "Recordings shorter than the minimum you set (default 1 second) are treated as accidental clicks. Change it in Settings."
9. Privacy section bullets: replace "API keys encrypted locally in your browser" with "API keys stored in plain text in Chrome's local extension storage, never synced, never sent anywhere but the provider".
10. Replace both `YOUR_USERNAME` placeholders with the real GitHub handle. If it is not known to the implementer, leave them and list this in the handback.

- [ ] **Step 3: Update `PRIVACY.md`**

1. "Last Updated: January 2025" becomes "Last Updated: September 2026".
2. Under "What We Collect", item 2 becomes "**API Keys**: Your OpenAI or Google Gemini API keys, stored in plain text in Chrome's local extension storage".
3. Under "Data Storage", replace "API keys are encrypted using XOR encryption before storage" with "API keys are stored in plain text in `chrome.storage.local`. They are never written to `chrome.storage.sync`, so they do not leave this browser profile. Anyone with access to your browser profile on disk can read them; this is the same protection level as a saved website password without a master password."
4. Under "Third-Party Services", list the four model names from the registry and note that mode processing sends the transcript text, not the audio, to the text model of the same provider.
5. Under "Security", replace "API keys are encrypted before storage" with "API keys are sent only over HTTPS in request headers, never in URLs".

- [ ] **Step 4: Create `CHANGELOG.md`**

```markdown
# Changelog

## 2.0.0 (unreleased)

### Fixed
- Email, Translate and Instruct modes now work on OpenAI. Speech is transcribed first, then the mode prompt is applied by a text model. Previously the prompt was sent to the transcription endpoint, which ignores instructions.
- API keys are no longer corrupted by saving settings a second time.
- New Gemini keys (prefix `AQ.`) are accepted; the key travels in a header, not the URL.
- The processing indicator stays visible until the result or error arrives; requests time out after 60 seconds.
- Recording cannot start twice or leak a live microphone when the permission prompt is open.
- Password fields never show the pill.
- Usage dates use local time; costs use per-model audio and text rates.

### Changed
- Models: `gpt-transcribe` and `gpt-6-luna` (OpenAI), `gemini-3.5-transcribe` and `gemini-3.8-flash` (Gemini). The model picker is gone; one model per role per provider.
- Settings save automatically. The Save and Start Recording buttons are gone.
- Keys are stored in plain text in local extension storage (the previous XOR scheme was obfuscation, not encryption).
- Minimum recording length is configurable (default 1 second, previously a fixed 3 seconds).
- Audio is recorded at 32 kbps Opus.
- Usage history from 1.x is reset; its cost basis was wrong.
- Build step: `npm install && npm run build`, load `dist/`.

### Removed
- `web_accessible_resources` entry and the `<all_urls>` host permission.
- Pill distance slider.
```

- [ ] **Step 5: Build and commit**

```bash
npm run build && npx vitest run
git add manifest.json README.md PRIVACY.md CHANGELOG.md
git commit -m "Update manifest permissions, docs and changelog for 2.0.0"
```

Expected: 13 test files, 89 tests passed; extension loads from `dist/` with no manifest warnings.

---

### Task 14: End-to-end smoke and tag

**Files:** none created. This task runs the acceptance list from spec section 5 and records the outcome in the handback.

- [ ] **Step 1: Fresh-profile install**

Create a new Chrome profile, load `dist/`, open the popup. Expected: status "Add API key", OpenAI tab active, no console errors in the service worker or popup.

- [ ] **Step 2: Provider matrix on the fixtures page**

For each provider (enter its key, Test, then):

| Mode | Say | Expected in the textarea |
|---|---|---|
| Default | "The meeting is at three, bring the Palowise deck." | The sentence, punctuated |
| Email | "Tell Maria the report is late and I will send it Friday." | Greeting, body, sign-off, no placeholders |
| Translate to Greek | "Good morning, how are you?" | Greek text only |
| Instruct | "What is the capital of Portugal?" | "Lisbon" or a one-line answer |

Record the cost shown in "Done <cost>" for each row.

- [ ] **Step 3: Failure paths**

- Set a wrong key, dictate. Expected: "OpenAI rejected the API key. Check it in the extension settings." No key fragment on screen.
- Disable the network, dictate. Expected: "Network error. Check your connection."
- Record under the minimum. Expected: "Too short, ignored".
- Record silence for 3 seconds. Expected: "No speech detected."
- Focus the password field. Expected: no pill.
- Focus the contenteditable and role=textbox fields; dictate into each. Expected: text appears, Ctrl+Z removes it.

- [ ] **Step 4: Upgrade path**

In a profile that still has v1.7.6 installed with both keys set and a custom mode: replace it with `dist/` (same extension id via load-unpacked from the same folder, or "Update" in `chrome://extensions`). Expected: both keys work, the custom mode is present, built-in prompts are the v2 texts, usage shows zero.

- [ ] **Step 5: Corruption regression**

Open the popup, change max recording, close. Open again, change min recording, close. Dictate with each provider. Expected: both work.

- [ ] **Step 6: Tag**

```bash
npx vitest run
git tag -a v2.0.0 -m "VoiceType 2.0.0: two-stage pipeline, current models, tested core"
```

Report in the handback: test count as `N/N`, the provider matrix with observed costs, any row that failed, and the README placeholder status from Task 13.

---

## Self-review notes

**Spec coverage (section 5 scope items 1 to 11):** 1 Task 1; 2 Tasks 2 to 4; 3 Tasks 5, 6; 4 Task 7; 5 Task 8; 6 Task 9; 7 Task 11; 8 Task 12; 9 Task 13; 10 Task 13; 11 Tasks 1 and 14. Acceptance bullets map to Task 14 steps 2 to 5.

**Type consistency:** `SttUsage` and `TextUsage` are defined in `pricing.js` and referenced by both adapters and the pipeline. `DictationResult` fields (`raw, text, provider, sttModel, textModel, audioSeconds, cost`) match what `router.js` reads. Message payload names (`audioBase64`, `mimeType`, `mode`, `audioDuration`) match between `content/index.js` (Task 11 step 8) and `router.js` (Task 9). Settings v2 field names match between `defaults.js`, `pipeline.js`, `content/index.js` and `popup.js`.

**Review Focus pins:** item 1 in Task 7 ("empty transcript throws and skips refine"); item 2 in Task 5 ("401 redacts key", twice); item 3 in Task 10 ("disconnected target copies to clipboard"); item 4 in Task 7 ("translate with empty target falls back to English"); item 5 in Task 4 ("flagged plaintext key survives").

**Known deferrals (Phase 1):** Shadow DOM pill, offscreen recorder, positioning, `all_frames`, hotkey hold-to-talk, popup visual redesign, Playwright.
