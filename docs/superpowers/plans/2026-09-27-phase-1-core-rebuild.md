# VoiceType Phase 1: Core Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make recording, the in-page UI and insertion robust on real sites: offscreen recorder, Shadow DOM pill, frames and shadow hosts, insertion ladder v2, hold-to-talk hotkey, silence auto-stop, orphan recovery, reworked popup, keys isolated from web pages, and an end-to-end Playwright smoke. Ships as v2.1.0.

**Architecture:** Recording moves to an offscreen document under the extension origin; the service worker owns a single recording session, relays levels and results to the exact tab frame, and runs the existing two-stage pipeline. The content script becomes a thin entry around a testable controller, a closed Shadow DOM pill, a pure positioning module, a chord tracker and a verified insertion ladder. Keys live only where trusted contexts can read them (service worker, popup): `storage.local` is restricted to trusted contexts and content scripts receive key-free settings by message and push.

**Tech Stack:** Chrome Manifest V3 (minimum Chrome 140), plain JavaScript with JSDoc, esbuild, Vitest with jsdom, Playwright 1.63 (`@playwright/test`) with bundled Chromium, Node `^20.19.0 || ^22.13.0 || >=24`.

**Spec:** `docs/superpowers/specs/2026-09-26-voicetype-roadmap.md`, sections 2 to 4 and 6. Section 6.0 (amendments of 2026-09-27) and decisions D10 to D12 override older text. Research behind the amendments: Chrome offscreen and storage docs, Chromium source, Lexical 0.51 and prosemirror-view 1.41.7 source, Playwright 1.63 probes (summarised where each task needs it).

**Author:** K. S. Karakostas. Prepared 2026-09-27.

## Global Constraints

- Manifest V3, `minimum_chrome_version: "140"`. `host_permissions: ["<all_urls>"]`. Permissions exactly `["storage", "scripting", "offscreen"]` after Task 6 (`activeTab` and `commands` removed).
- Node `^20.19.0 || ^22.13.0 || >=24`. No TypeScript compile step. JSDoc `@typedef` for shared shapes.
- devDependencies only: `esbuild`, `vitest`, `jsdom`, `@playwright/test`. Zero runtime dependencies.
- Model IDs, labels and prices only in `src/shared/models.js`. Message action names only in `src/shared/messages.js`. Default settings, migrations and settings validation only in `src/shared/defaults.js`.
- API keys: plaintext in `chrome.storage.local`, restricted with `setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`. Only the service worker and the popup ever hold a key. No message to a content script or the offscreen document carries a key. Content scripts never call `chrome.storage` and never write settings wholesale.
- Never put a key in a URL. OpenAI: `Authorization: Bearer`. Gemini: `x-goog-api-key` header.
- Never show a provider's raw error body; map it and redact key patterns.
- Never treat `input[type=password]`, or an input whose `autocomplete` ends in `-password`, as a dictation target.
- No `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` anywhere under `src/content/` or `src/offscreen/`. User data (mode names, icons, target language, statuses) is rendered with `textContent` only.
- A paid transcript is never discarded while the requesting frame exists: after a successful STT call the text reaches the field, the clipboard, or a click-to-copy status. (A tab closed during processing drops its result; the Phase 2 history in spec 7.3 covers that case.)
- The insertion ladder never inserts twice: an ambiguous read-back ends at the clipboard with a notice.
- All user-visible prose in English. No em dashes or en dashes anywhere: code, comments, UI copy, docs, commit messages.
- Commit messages carry the change description only. No trailers, no AI attribution.
- Every task ends with `npm test` green, reported as `N/N`, before its commit. Tasks that touch the build, manifest or any entry point also run `npm run build` clean.

## Review Focus

1. The extension is reloaded or updated while a tab is recording or processing. Expected: the old instance is torn down by the new one (or shows the terminal notice "VoiceType was updated. Reload this page." when it cannot be replaced), no pill stays stuck in recording, the microphone is released, and the next dictation in that tab works. Pinned in Task 11 (`controller.test.js`, "orphan notice is terminal"; "teardown removes the pill and listeners") and Task 6 (`recorder.test.js`, "undeliverable level cancels the session").
2. The tab is closed or navigates away while recording. Expected: the session is cancelled, the offscreen tracks stop (tray indicator off), no provider call is made, and a start from another tab succeeds instead of reporting busy. Pinned in Task 6 (`recorder.test.js`, "tab removed while recording frees the session").
3. Microphone permission is missing, dismissed or blocked. Expected: missing opens the permission page once per start attempt and the pill explains the next step; blocked names chrome://settings/content/microphone; the session is always freed. Pinned in Task 6 (`recorder.test.js`, "needsPermission opens the page once and frees the session"; "denied frees the session with the settings hint") and Task 5 (`capture.test.js`, "prompt state never calls getUserMedia").
4. The start field loses focus or is removed (SPA re-render) before the text arrives. Expected: the text goes to the clipboard with a notice, never into another field; if the clipboard write fails, a click-to-copy status keeps it. Pinned in Task 11 (`controller.test.js`, "focus moved: clipboard, not the focused field"; "removed target and failed copy: click-to-copy").
5. Hold-to-talk edge cases: key auto-repeat, modifiers released before the main key, and the window losing focus mid-hold (Alt+Tab). Expected: one start per press, the release is detected whichever key goes up first, and a blur ends the hold so recording stops instead of hanging. Pinned in Task 10 (`hotkey.test.js`, "repeat keydowns are not presses"; "modifier released first ends the press"; "blur during hold ends the hold").

## Decisions and rulings for this plan

- D10, D11, D12 in the spec (minimum Chrome 140; `<all_urls>` host permission; result bound to the start field, else clipboard). Kostas, 2026-09-27.
- Phase 0 smoke: passed everything (Kostas, 2026-09-27). `v2.0.0` is tagged.
- Content scripts change settings only through `updateSettings` with a whitelist (`activeMode`, `provider`, `translateTargetLang`). Whole-settings saves are for trusted pages only. This also stops a stale in-tab copy from overwriting popup edits.
- One recording session per profile. A start while another tab records or processes answers `busy`. Pressing the hotkey while this tab processes shows "Still processing".
- No auto-start after the microphone grant. The pill says "Microphone allowed. Press REC again."
- The pill's own controls use inline SVG icons. Mode icons are user data (emoji allowed) and render as text.
- The pill menu holds modes, the translate target (when the active mode has a language option), the provider switch, a usage line and the hotkey hint. Recording limits move to the popup only.
- The offscreen document stays open after first use (a `USER_MEDIA` document never auto-closes); tracks stop after every recording.
- Settings stay at `settingsVersion: 2`. New fields (`hotkey`, `autoStopSilenceSec`) are filled by the v2 path of `migrateSettings`, which also validates every scalar.
- Playwright runs separately (`npm run test:e2e`), never inside `npm test`.

## Ledger intake (Phase 0 deferred items, audited against `main` at 9cadd0a)

Fixed already: ledger rows for NaN cost, legacy lookups, consumed Response, null language entry, `normalizeSttUsage`, refine warnings, warning passthrough, AbortError wording, message typedef, popup save errors, MediaRecorder track release, reset closing the editor, README wording. M3 was fixed in v2.0 (c43699b); its invariant carries into the new pill (Global Constraints).
Obsolete in Phase 1: toggle-command success reporting, second-copy injection and toggle guards, the content watchdog, dead pill-gap CSS, the left-edge pill (replaced by `position.js`).
Declined: Gemini duration usage (unreachable), Gemini STT text tokens (none sent), global audio tokens per second (one model), non-ASCII template placeholders, downgrade re-stamp (migrations are additive), STT input tokens (priced per minute), AbortError swallowed in `readErrorMessage`, shared 60 s pipeline budget (ruled in Phase 0), report noise.
Open items are folded into Tasks 1, 2, 4, 7, 11 and 12; each appears in that task's steps with its test.

## File structure (end of Phase 1)

```
manifest.json                         2.1.0, min Chrome 140, <all_urls>, offscreen, all_frames, no commands, no content.css
package.json, build.mjs, vitest.config.js, playwright.config.js
src/
  shared/
    defaults.js      DEFAULT_SETTINGS (+hotkey, +autoStopSilenceSec), migrateSettings, toPublicSettings, applySettingsPatch
    chord.js         (new) isValidChord, matchesChord, chordFromEvent, formatChord
    messages.js      MSG (Phase 1 contract below) and payload typedefs
    models.js, pricing.js, text.js   hardening only
  background/
    index.js         SW entry: access level, listeners, broadcast, re-injection, wiring
    router.js        createRouter(deps), senderKind, userMessage
    dictate.js       (new) createDictate: pipeline + usage logging -> DictationMessage
    tabs.js          (new) broadcast, sendToFrame, reinject
    recorder.js      (new) createRecorder: the single recording session
    offscreen-client.js (new) createOffscreenClient: race-safe ensure + send
    storage.js       createStorage: serialized updates
    usage.js, pipeline.js, providers/*   hardening only
  offscreen/
    offscreen.html, offscreen.js   (new) entry wiring chrome.runtime to capture
    capture.js       (new) createCapture(deps): permission check, MediaRecorder, levels, max time, silence stop
    audio.js         (new) rms, levelFromRms, createSilenceDetector, bytesToBase64, RECORDING_MIME
    permission.html, permission.js (new) one-time microphone grant page
  content/
    index.js         (rewritten) entry: teardown handshake, listeners, send() with orphan detection, wiring
    controller.js    (new) createController(deps): the in-page state machine
    pill.js, pill.css (new) closed Shadow DOM pill
    position.js      (new) computePillPosition, computeMenuPlacement (pure)
    anchor.js        (new) watchAnchor: scroll, resize, ResizeObserver, rAF throttle
    hotkey.js        (new) createChordTracker (tap vs hold)
    insert.js        (rewritten) ladder v2, copyText, normalizeForCompare
    fields.js        fixes
    content.css      deleted
  popup/
    popup.html, popup.css, popup.js   (reworked)
    form.js          (new) pure helpers: keywords, languages, inline confirm, SPOKEN_LANGUAGES
test/
  unit/**            Vitest (node or jsdom per file)
  e2e/smoke.spec.js, e2e/wav.js       Playwright
  fixtures/fields.html (extended), frame.html, hostile.html, pp-denied.html, serve.mjs
docs/superpowers/plans/2026-09-27-phase-1-smoke-checklist.md
```

## Message contract (supersedes spec 4.3)

All messages are `{ action: MSG.X, ...payload }`. "Trusted" means `senderKind(sender) === 'extension'` (popup or permission page). Requests a sender may not make are answered `{ success: false, error: 'Not allowed.' }`.

| MSG key | Value | From to | Payload | Response |
|---|---|---|---|---|
| GET_SETTINGS | `getSettings` | popup, content to SW | none | trusted: `Settings`; content: `PublicSettings` |
| SAVE_SETTINGS | `saveSettings` | popup to SW (trusted only) | `{ settings }` | `{ success, error? }` |
| UPDATE_SETTINGS | `updateSettings` | content, popup to SW | `{ patch }` (whitelist) | `{ success, error? }` |
| VALIDATE_KEY | `validateKey` | popup (trusted only) | `{ provider, key }` | `{ ok, error? }` |
| GET_USAGE | `getUsageStats` | popup, content | none | `{ today, last7Days, total }` |
| CLEAR_USAGE | `clearUsageStats` | popup (trusted only) | none | `{ success }` |
| START_RECORDING | `startRecording` | content only | none | `StartResponse` |
| STOP_RECORDING | `stopRecording` | content only | none | `{ ok }` |
| CANCEL_RECORDING | `cancelRecording` | content only | none | `{ ok }` |
| SETTINGS_CHANGED | `settingsChanged` | SW to every tab (all frames) | `{ settings: PublicSettings }` | none |
| AUDIO_LEVEL | `audioLevel` | SW to session frame | `{ level }` (0 to 1) | none |
| RECORDING_STATE | `recordingState` | SW to a frame | `RecordingStatePayload` | none |
| DICTATION_RESULT | `dictationResult` | SW to session frame | `DictationMessage` | none |
| OFFSCREEN_START | `offscreenStart` | SW to offscreen | `{ maxSec, silenceSec }` | `OffscreenStartResponse` |
| OFFSCREEN_STOP | `offscreenStop` | SW to offscreen | `{ discard }` | `{ ok }` |
| OFFSCREEN_LEVEL | `offscreenLevel` | offscreen to SW | `{ level }` | `{ ok: true }` |
| OFFSCREEN_DONE | `offscreenDone` | offscreen to SW | `OffscreenDone` | `{ ok: true }` |
| OFFSCREEN_ERROR | `offscreenError` | offscreen to SW | `{ error }` | `{ ok: true }` |
| PERMISSION_RESULT | `permissionResult` | permission page to SW (trusted) | `{ granted }` | `{ ok: true }` |

Removed from v2.0: `checkApiKey`, `transcribe`, `toggle-recording`.

Typedefs (live in `src/shared/messages.js`, Task 3):

```js
/**
 * @typedef {'noKey'|'busy'|'needsPermission'|'denied'|'micError'} StartFailure
 * @typedef {{ ok: true } | { ok: false, reason: StartFailure, error: string }} StartResponse
 * @typedef {{ text: string, tone: 'info'|'success'|'warning'|'error' }} Notice
 * @typedef {{ state: 'idle'|'processing', reason?: 'maxTime'|'silence'|'ended'|'error'|'permission', notice?: Notice }} RecordingStatePayload
 * @typedef {{ success: true, text: string, raw: string, cost: number, warning: string|null }
 *   | { success: false, error: string, tone: 'warning'|'error' }} DictationMessage
 * @typedef {{ ok: true } | { ok: false, reason: 'needsPermission'|'denied'|'micError', error: string }} OffscreenStartResponse
 * @typedef {{ audioBase64: string, mimeType: string, durationSec: number, reason: 'user'|'maxTime'|'silence'|'ended' }} OffscreenDone
 */
```

---

### Task 1: Build and test tooling

**Files:**
- Modify: `build.mjs`, `package.json`
- Create: `vitest.config.js`, `test/unit/build/css-text.test.js`, `test/unit/build/fixture.css`

**Interfaces:**
- Produces:
  - `build.mjs`: `process.chdir(import.meta.dirname)` first; entries declared in one `ENTRIES` object (`background`, `content`, `popup` now; Tasks 5 add `offscreen`, `permission`); `loader: { '.css': 'text' }`; statics declared in one `STATICS` list of `[from, to]` pairs copied by `copyStatic()`; icons copied as `icons/*.png` only; every `fs.watch` has an `'error'` listener; `content.css` stays in `STATICS` until Task 11 deletes it.
  - `vitest.config.js`: `test.include: ['test/unit/**/*.test.js']`; `process.env.TZ = 'Europe/Athens'` set at config load; a `css-text` plugin (resolveId to a `\0css-text:` virtual id, load returns `export default <JSON string of file>`) so `import css from './x.css'` yields the file text in tests exactly as esbuild's text loader does in the bundle.
  - `package.json`: `engines.node` `"^20.19.0 || ^22.13.0 || >=24"`; scripts unchanged here (Task 13 adds `test:e2e`).
- Ledger: T1 engines, cwd, vitest config, watcher error listener, icons wholesale copy; T8 DST test TZ pin.

WRITER NOTES

- `process.chdir(import.meta.dirname)` alone does not fix the cwd dependency: esbuild's JS API captures `process.cwd()` when the module is imported (`var defaultWD = process.cwd()` in `esbuild/lib/main.js`), and ES imports run before the `chdir`. Verified: with only the `chdir`, `node ../../build.mjs` run from `src/content` fails with `Could not resolve "src/background/index.js"`. The build options therefore also set `absWorkingDir: import.meta.dirname`.
- A `\0css-text:` id that still ends in `.css` does not work: Vitest's `vitest:css-disable` plugin matches any id ending in `.css` (or `.css?...`) and replaces the module with `export default ""`. Verified. The virtual id drops the `.css` extension and `load` adds it back.
- The existing DST test in `usage.test.js` does not discriminate even with the zone pinned: at 23:30 on 29 March a 24-hour step back lands on 28 March 22:30, which is still the right date. Verified by mutating `daysAgo` to millisecond arithmetic: 9/9 pass pinned and unpinned. Step 3 moves `now` to 00:30 on 30 March (mutation then fails with `expected 6 to be 7`) and adds a precondition test that fails whenever the pin is missing on a non-Athens machine. Task 4 also edits `usage.test.js`; it must apply its changes on top of this version, not the 9cadd0a text.
- `target: 'chrome116'` is left as is; Task 6 raises `minimum_chrome_version` and may raise the target with it.

- [ ] **Step 1: Write the failing CSS-as-text test and its fixture**

`test/unit/build/fixture.css`:

```css
/* Fixture for the css-text import tests. Quotes, backslashes and non-ASCII must survive. */
:host { all: initial; }
.pill::before { content: "\201C quoted \201D"; }
.label::after { content: 'Ελληνικά'; }
```

`test/unit/build/css-text.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import css from './fixture.css';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixtureText = readFileSync(new URL('./fixture.css', import.meta.url), 'utf8');

describe('CSS imported as text', () => {
  it('yields the file text under Vitest', () => {
    expect(typeof css).toBe('string');
    expect(css).toBe(fixtureText);
  });

  it('yields the same text through the esbuild text loader the bundle uses', async () => {
    const result = await build({
      stdin: { contents: "export { default } from './fixture.css';", resolveDir: here },
      bundle: true,
      write: false,
      format: 'iife',
      globalName: 'bundled',
      loader: { '.css': 'text' },
      logLevel: 'silent',
    });
    const bundled = new Function(`${result.outputFiles[0].text}\nreturn bundled;`)();
    expect(bundled.default).toBe(fixtureText);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/build
```

Expected: 1 failed, 1 passed. "yields the file text under Vitest" fails with `AssertionError: expected '' to be '/* Fixture for the css-text import te…'` (Vitest replaces every `.css` module with an empty string). The esbuild test passes: it pins the loader the bundle will use.

- [ ] **Step 3: Make the DST test discriminate and state its zone precondition**

In `test/unit/background/usage.test.js`, replace:

```js
  it('counts seven distinct days across a DST-like boundary', () => {
    const now = new Date(2026, 2, 29, 23, 30);
    let log = emptyLog();
    for (let i = 0; i < 7; i++) log = applyUsage(log, entry('openai', 1, 0.001), new Date(2026, 2, 29 - i, 12));
    expect(summarize(log, now).last7Days.sessions).toBe(7);
  });
```

with:

```js
  it('runs where 29 March 2026 lasts 23 hours (vitest.config.js pins Europe/Athens)', () => {
    expect(new Date(2026, 2, 30) - new Date(2026, 2, 29)).toBe(23 * 60 * 60 * 1000);
  });

  it('counts seven distinct days across a DST-like boundary', () => {
    // Half past midnight on the first full day of summer time in Athens: stepping back
    // 24 hours from here lands on 28 March and would skip the 23-hour 29 March.
    const now = new Date(2026, 2, 30, 0, 30);
    let log = emptyLog();
    for (let i = 0; i < 7; i++) log = applyUsage(log, entry('openai', 1, 0.001), new Date(2026, 2, 30 - i, 12));
    expect(summarize(log, now).last7Days.sessions).toBe(7);
  });
```

Run it in a zone without daylight saving time:

```bash
TZ=UTC npx vitest run test/unit/background/usage.test.js
```

Expected: 1 failed, 9 passed. "runs where 29 March 2026 lasts 23 hours" fails with `expected 86400000 to be 82800000`.

- [ ] **Step 4: Create `vitest.config.js`**

```js
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Date tests need a zone with daylight saving time; Athens is also ahead of UTC.
process.env.TZ = 'Europe/Athens';

// Virtual module id for a CSS file imported as text. The `.css` extension is dropped
// from the id because Vitest empties any module whose id ends in `.css`.
const CSS_TEXT_PREFIX = '\0css-text:';

/** Mirror esbuild's `loader: { '.css': 'text' }`: `import css from './x.css'` yields the file text. */
function cssText() {
  return {
    name: 'css-text',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!source.endsWith('.css')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || !resolved.id.endsWith('.css')) return null;
      return CSS_TEXT_PREFIX + resolved.id.slice(0, -'.css'.length);
    },
    load(id) {
      if (!id.startsWith(CSS_TEXT_PREFIX)) return null;
      const file = `${id.slice(CSS_TEXT_PREFIX.length)}.css`;
      this.addWatchFile(file);
      return `export default ${JSON.stringify(readFileSync(file, 'utf8'))};`;
    },
  };
}

export default defineConfig({
  plugins: [cssText()],
  test: {
    include: ['test/unit/**/*.test.js'],
  },
});
```

- [ ] **Step 5: Run both files to verify they pass, even from a UTC shell**

```bash
npx vitest run test/unit/build
TZ=UTC npx vitest run test/unit/background/usage.test.js
```

Expected: `test/unit/build` 2 passed; `usage.test.js` 10 passed (the config overrides the shell's `TZ`).

- [ ] **Step 6: Confirm the DST test catches 24-hour day arithmetic (mutation check, nothing committed)**

```bash
sed -i 's/return new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 12);/return new Date(now.getTime() - n * 86400000);/' src/background/usage.js
npx vitest run test/unit/background/usage.test.js
git checkout -- src/background/usage.js
```

Expected: the middle command reports 1 failed, 9 passed: "counts seven distinct days across a DST-like boundary" with `expected 6 to be 7`. `git status --short src` is empty afterwards.

- [ ] **Step 7: Commit the test tooling**

```bash
npm test
git add vitest.config.js test/unit/build/css-text.test.js test/unit/build/fixture.css test/unit/background/usage.test.js
git commit -m "Add the Vitest config with CSS text imports and a pinned time zone"
```

Expected before the commit: 14 files, 126/126 passed.

- [ ] **Step 8: Rewrite `build.mjs`**

```js
// esbuild build script. Bundles the entry points and copies static assets into dist/.
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync, watch as watchPath } from 'node:fs';
import { basename, dirname } from 'node:path';

// Every path below is relative to the repository root, wherever the script is run from.
// esbuild captured the old cwd when it was imported, so the options also pass absWorkingDir.
process.chdir(import.meta.dirname);

const watch = process.argv.includes('--watch');
const OUTDIR = 'dist';

/** Bundle name (dist/<name>.js) to source entry. */
const ENTRIES = {
  background: 'src/background/index.js',
  content: 'src/content/index.js',
  popup: 'src/popup/popup.js',
};

/** Static files as [source, path under dist/] pairs. */
const STATICS = [
  ['manifest.json', 'manifest.json'],
  ['src/popup/popup.html', 'popup.html'],
  ['src/popup/popup.css', 'popup.css'],
  ['src/content/content.css', 'content.css'],
  ['icons/icon16.png', 'icons/icon16.png'],
  ['icons/icon48.png', 'icons/icon48.png'],
  ['icons/icon128.png', 'icons/icon128.png'],
];

rmSync(OUTDIR, { recursive: true, force: true });
mkdirSync(OUTDIR, { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const options = {
  absWorkingDir: import.meta.dirname,
  entryPoints: ENTRIES,
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  outdir: OUTDIR,
  // `import css from './x.css'` yields the file text (Shadow DOM styles); vitest.config.js mirrors this.
  loader: { '.css': 'text' },
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

function copyStatic() {
  for (const [from, to] of STATICS) cpSync(from, `${OUTDIR}/${to}`);
}

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  copyStatic();
  // esbuild only watches the JS graph; re-copy statics when any of them changes.
  // Watch parent directories, not files, so atomic-rename saves stay visible.
  const watched = new Map();
  for (const [from] of STATICS) {
    const dir = dirname(from);
    if (!watched.has(dir)) watched.set(dir, new Set());
    watched.get(dir).add(basename(from));
  }
  for (const [dir, names] of watched) {
    const watcher = watchPath(dir, (_event, filename) => {
      if (!filename || !names.has(filename)) return;
      console.log(`static changed: ${dir === '.' ? filename : `${dir}/${filename}`}`);
      try {
        copyStatic();
      } catch (err) {
        console.error(`static copy failed: ${err.message}`);
      }
    });
    watcher.on('error', (err) => console.error(`watch failed for ${dir}: ${err.message}`));
  }
  console.log('watching for changes');
} else {
  await build(options);
  copyStatic();
}
```

- [ ] **Step 9: Tighten the Node engine range in `package.json`**

Replace:

```json
    "node": ">=20"
```

with:

```json
    "node": "^20.19.0 || ^22.13.0 || >=24"
```

- [ ] **Step 10: Build from the root and from a subdirectory**

```bash
npm run build
(cd src/content && node ../../build.mjs)
find dist -type f | sort
ls src/content
```

Expected: both builds list the three bundles (`dist/content.js`, `dist/background.js`, `dist/popup.js`; the subdirectory run prints them as `../../dist/...`) and `Done`, with no `Could not resolve` error. `find` lists exactly:

```
dist/background.js
dist/content.css
dist/content.js
dist/icons/icon128.png
dist/icons/icon16.png
dist/icons/icon48.png
dist/manifest.json
dist/popup.css
dist/popup.html
dist/popup.js
```

`ls src/content` shows no `dist` directory.

- [ ] **Step 11: Check watch mode starts and re-copies a static**

```bash
(timeout 4 node build.mjs --watch &) ; sleep 2; touch src/popup/popup.css; sleep 3
```

Expected output includes `watching for changes` and `static changed: src/popup/popup.css`, and no `watch failed` line; `timeout` ends the watcher.

- [ ] **Step 12: Run the full suite and commit**

```bash
npm test
npm run build
git add build.mjs package.json
git commit -m "Run the build from any directory with declared entries, statics and a CSS text loader"
```

Expected: 14 files, 126/126 passed; the build is clean.

---

### Task 2: Hardening sweep (shared, providers, pipeline)

**Files:**
- Modify: `src/shared/models.js`, `src/shared/pricing.js`, `src/shared/text.js`, `src/background/providers/errors.js`, `src/background/providers/gemini.js`, `src/background/providers/openai.js` (tests only unless a fix lands there), `src/background/pipeline.js`
- Test: `test/unit/shared/{models,pricing,text}.test.js`, `test/unit/background/providers/{errors,openai,gemini}.test.js`, `test/unit/background/pipeline.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces (behaviour changes other tasks may rely on):
  - `deepFreeze(obj)` exported from `src/shared/models.js`; `MODELS`, `PROVIDERS`, `LEGACY_PROVIDER_OF_MODEL` deep-frozen.
  - `pricing.js` lookups use `Object.hasOwn(MODELS, id)`; unknown or inherited ids price at 0.
  - `sanitizeHint(value, maxLen)` slices by code point, clamps `maxLen` to at least 0, trims the end after cutting.
  - `authError(provider, status)` exported from `errors.js`, returns the standard `ProviderError` with code `'auth'`; `gemini.js` uses it and matches `API_KEY_(INVALID|EXPIRED)`.
  - `redact` uses `(?<![A-Za-z0-9])` in place of `\b` and allows `.` inside the `AQ.` key class.
  - `runDictation` rejects a non-string mode prompt as STT-only, trims the key and the target language before its guards, and words a blank refine failure as "Text model failed.".
- Ledger: rows 7, 12, 13, 14, 15, 17 (shared) and 21, 22, 25, 27, 28, 30, 31, 32 (providers, pipeline). Each step names its exact failing case.

WRITER NOTES

- `redact`: the `AQ.` alternative allows dots between segments (`AQ\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]+)*`) rather than a bare `.` in the character class, so the period that ends a sentence after a key is kept. The contract cases (`token_sk-abcdef123456`, `AQ.Ab8Rn2.xyz98765`) are fully redacted; the trailing-period case is pinned.
- Rows 13, 17, 31 and parts of 21, 22 and 28 are coverage gaps: their tests pin behaviour that is already correct and pass on first run. Each "verify it fails" step names exactly which tests fail and which are pins.
- `openai.js` needs no source change; only its tests grow.

- [ ] **Step 1: Write the failing registry and pricing tests (rows 7, 12, 13)**

Replace `test/unit/shared/models.test.js` with:

```js
import { describe, it, expect } from 'vitest';
import { MODELS, PROVIDERS, LEGACY_PROVIDER_OF_MODEL, deepFreeze } from '../../../src/shared/models.js';

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

  it('keeps legacy ids out of the priced registry', () => {
    for (const id of Object.keys(LEGACY_PROVIDER_OF_MODEL)) expect(Object.hasOwn(MODELS, id), id).toBe(false);
  });

  it('deep-freezes every registry', () => {
    expect(Object.isFrozen(MODELS)).toBe(true);
    expect(Object.isFrozen(MODELS['gpt-transcribe'])).toBe(true);
    expect(Object.isFrozen(MODELS['gpt-transcribe'].pricing)).toBe(true);
    expect(Object.isFrozen(PROVIDERS.openai)).toBe(true);
    expect(Object.isFrozen(LEGACY_PROVIDER_OF_MODEL)).toBe(true);
    expect(() => { MODELS['gemini-3.8-flash'].pricing.outputPerM = 0; }).toThrow(TypeError);
  });
});

describe('deepFreeze', () => {
  it('freezes nested objects and arrays and returns its argument', () => {
    const value = { a: { b: [1, { c: 2 }] } };
    expect(deepFreeze(value)).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.a)).toBe(true);
    expect(Object.isFrozen(value.a.b)).toBe(true);
    expect(Object.isFrozen(value.a.b[1])).toBe(true);
  });

  it('passes primitives and null through', () => {
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(3)).toBe(3);
    expect(deepFreeze('x')).toBe('x');
  });
});
```

Replace `test/unit/shared/pricing.test.js` with:

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
  it('prices inherited property names at 0 instead of throwing', () => {
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(estimateSttCost(id, null, 1), id).toBe(0);
    }
  });
});

describe('estimateTextCost', () => {
  it('prices input and output tokens', () => {
    expect(estimateTextCost('gpt-6-luna', { inputTokens: 1000, outputTokens: 200 })).toBeCloseTo(0.0001 + 0.0001, 9);
    expect(estimateTextCost('gemini-3.8-flash', { inputTokens: 1e6, outputTokens: 0 })).toBeCloseTo(0.75, 9);
  });
  it('prices Gemini 3.8 Flash output tokens', () => {
    expect(estimateTextCost('gemini-3.8-flash', { inputTokens: 0, outputTokens: 1e6 })).toBeCloseTo(3.75, 9);
  });
  it('returns 0 without usage', () => {
    expect(estimateTextCost('gpt-6-luna', null)).toBe(0);
  });
  it('prices unknown and inherited model ids at 0 instead of throwing', () => {
    for (const id of ['nope', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(estimateTextCost(id, { inputTokens: 1, outputTokens: 1 }), id).toBe(0);
    }
  });
});

describe('formatCost', () => {
  it('formats zero, sub-cent and normal amounts', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(0.1234)).toBe('$0.12');
  });
  it('shows exactly one cent as $0.01', () => {
    expect(formatCost(0.01)).toBe('$0.01');
    expect(formatCost(0.0099)).toBe('<$0.01');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/unit/shared/models.test.js test/unit/shared/pricing.test.js
```

Expected: 5 failed, 15 passed. Failing: "deep-freezes every registry" (`expected false to be true`), both `deepFreeze` tests (`deepFreeze is not a function`), "prices inherited property names at 0 instead of throwing" (`Cannot use 'in' operator to search for 'perMinute' in undefined`) and "prices unknown and inherited model ids at 0 instead of throwing" (`... 'inputPerM' in undefined`). The legacy-id, 3.8 Flash output and one-cent tests are pins and pass.

- [ ] **Step 3: Deep-freeze the registries in `src/shared/models.js`**

Replace the whole file with:

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

/**
 * Freeze a value and everything reachable through its own enumerable properties.
 * Shared registries and defaults must fail loudly on a stray write. The value must be acyclic.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** @type {Record<string, ModelInfo>} */
export const MODELS = deepFreeze({
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

export const PROVIDERS = deepFreeze({
  openai: { label: 'OpenAI', stt: 'gpt-transcribe', text: 'gpt-6-luna', keyPlaceholder: 'sk-...' },
  gemini: { label: 'Gemini', stt: 'gemini-3.5-transcribe', text: 'gemini-3.8-flash', keyPlaceholder: 'AQ.... or AIza...' },
});

/** v1 model ids, kept only so migration can recover the provider. Never sent to an API. */
export const LEGACY_PROVIDER_OF_MODEL = deepFreeze({
  'gpt-4o-transcribe': 'openai',
  'gpt-4o-mini-transcribe': 'openai',
  'gemini-2.5-flash': 'gemini',
  'gemini-3-flash-preview': 'gemini',
});
```

- [ ] **Step 4: Price only own model ids in `src/shared/pricing.js`**

Replace the whole file with:

```js
import { MODELS, GEMINI_AUDIO_TOKENS_PER_SECOND } from './models.js';

/**
 * @typedef {{ kind: 'duration', seconds: number }
 *         | { kind: 'tokens', audioTokens: number, textTokens: number, outputTokens: number }} SttUsage
 * @typedef {{ inputTokens: number, outputTokens: number }} TextUsage
 */

/**
 * Unknown model ids, inherited names such as `constructor` included, price at 0.
 * @param {string} modelId
 * @param {SttUsage|null} usage
 * @param {number} fallbackSeconds client-measured recording length
 * @returns {number} USD
 */
export function estimateSttCost(modelId, usage, fallbackSeconds) {
  if (!Object.hasOwn(MODELS, modelId)) return 0;
  const p = MODELS[modelId].pricing;
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
 * Unknown model ids, inherited names such as `constructor` included, price at 0.
 * @param {string} modelId
 * @param {TextUsage|null} usage
 * @returns {number} USD
 */
export function estimateTextCost(modelId, usage) {
  if (!usage || !Object.hasOwn(MODELS, modelId)) return 0;
  const p = MODELS[modelId].pricing;
  if (!('inputPerM' in p)) return 0;
  return (usage.inputTokens / 1e6) * p.inputPerM + (usage.outputTokens / 1e6) * p.outputPerM;
}

/** @param {number} cost */
export function formatCost(cost) {
  if (!cost) return '$0.00';
  if (cost < 0.01) return '<$0.01';
  return '$' + cost.toFixed(2);
}
```

- [ ] **Step 5: Run the tests, then the suite, and commit**

```bash
npx vitest run test/unit/shared/models.test.js test/unit/shared/pricing.test.js
npm test
git add src/shared/models.js src/shared/pricing.js test/unit/shared/models.test.js test/unit/shared/pricing.test.js
git commit -m "Deep-freeze the model registries and price only own model ids"
```

Expected: 20 passed; suite 14 files, 134/134.

- [ ] **Step 6: Write the failing text tests (rows 14, 17)**

Replace `test/unit/shared/text.test.js` with:

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
  it('trims a space left at the end of the cut', () => {
    expect(sanitizeHint('ab cd', 3)).toBe('ab');
  });
  it('treats a negative maxLen as 0', () => {
    expect(sanitizeHint('abc', -1)).toBe('');
  });
  it('cuts by code point, never inside a surrogate pair', () => {
    expect(sanitizeHint('a😀b', 2)).toBe('a😀');
  });
});

describe('fillTemplate', () => {
  it('replaces known variables and blanks unknown ones', () => {
    expect(fillTemplate('to {{targetLanguage}} and {{ other }} end', { targetLanguage: 'Greek' })).toBe('to Greek and  end');
  });
  it('returns the template untouched when it has no variables', () => {
    expect(fillTemplate('plain', {})).toBe('plain');
  });
  it('does not resolve inherited object properties', () => {
    expect(fillTemplate('{{constructor}}{{toString}}', {})).toBe('');
  });
  it('keeps falsy values that are not null or undefined', () => {
    expect(fillTemplate('{{a}}|{{b}}|{{c}}', { a: 0, b: false, c: '' })).toBe('0|false|');
  });
  it('blanks every placeholder when vars is null', () => {
    expect(fillTemplate('x{{a}}y', null)).toBe('xy');
  });
  it('fills a known name written with inner spaces', () => {
    expect(fillTemplate('Into {{ targetLanguage }}.', { targetLanguage: 'Greek' })).toBe('Into Greek.');
  });
});
```

- [ ] **Step 7: Run the tests to verify they fail**

```bash
npx vitest run test/unit/shared/text.test.js
```

Expected: 3 failed, 10 passed. "trims a space left at the end of the cut" (`expected 'ab ' to be 'ab'`), "treats a negative maxLen as 0" (`expected 'ab' to be ''`), "cuts by code point, never inside a surrogate pair" (`expected 'a\uD83D' to be 'a😀'`, printed with a replacement character). The three new `fillTemplate` tests are pins (row 17) and pass.

- [ ] **Step 8: Cut by code point and document the template contract (rows 14, 15)**

Replace the whole of `src/shared/text.js` with:

```js
/**
 * Make a string safe for OpenAI `prompt` and `keywords[]` fields, which reject
 * `<`, `>`, CR and LF, and keep hints short.
 * @param {unknown} text
 * @param {number} [maxLen] maximum length in code points; a negative value counts as 0
 * @returns {string}
 */
export function sanitizeHint(text, maxLen = 1000) {
  const clean = String(text ?? '')
    .replace(/[<>\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const limit = Math.max(0, maxLen);
  if (clean.length <= limit) return clean;
  // Cut by code point so an emoji is never split, then drop a space the cut exposed.
  return Array.from(clean).slice(0, limit).join('').trimEnd();
}

/**
 * Replace `{{name}}` placeholders (spaces inside the braces allowed) with values from `vars`.
 * Only own properties of `vars` count: inherited names such as `constructor`, unknown
 * names and null or undefined values all become empty strings. Other values are
 * converted with `String`, so `0` and `false` are kept.
 * @param {string} template
 * @param {Record<string, unknown>|null|undefined} vars
 * @returns {string}
 */
export function fillTemplate(template, vars) {
  return String(template ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) =>
    vars && typeof vars === 'object' && Object.hasOwn(vars, name) && vars[name] != null
      ? String(vars[name])
      : '');
}
```

- [ ] **Step 9: Run the tests, then the suite, and commit**

```bash
npx vitest run test/unit/shared/text.test.js
npm test
git add src/shared/text.js test/unit/shared/text.test.js
git commit -m "Cut hints by code point and pin the template contract"
```

Expected: 13 passed; suite 14 files, 140/140.

- [ ] **Step 10: Write the failing redaction and auth error tests (rows 25, 27)**

Replace `test/unit/background/providers/errors.test.js` with:

```js
import { describe, it, expect } from 'vitest';
import { ProviderError, friendlyHttpError, redact, authError } from '../../../../src/background/providers/errors.js';

describe('redact', () => {
  it('replaces OpenAI and Gemini key patterns', () => {
    expect(redact('Incorrect API key provided: sk-proj-abcdef123456.')).toBe('Incorrect API key provided: [key].');
    expect(redact('bad AIzaSyD9x2KqL0mN3p and AQ.Ab8Rn2xyz')).toBe('bad [key] and [key]');
  });
  it('caps length', () => {
    expect(redact('x'.repeat(500)).length).toBe(160);
  });
  it('redacts a key glued to a word by an underscore', () => {
    expect(redact('token_sk-abcdef123456')).toBe('token_[key]');
  });
  it('redacts an AQ. key with inner dots but keeps the sentence period after it', () => {
    expect(redact('AQ.Ab8Rn2.xyz98765')).toBe('[key]');
    expect(redact('Key AQ.Ab8Rn2.xyz98765.')).toBe('Key [key].');
  });
  it('leaves key-like text inside a longer word alone', () => {
    expect(redact('task-abcdef and mask-12345')).toBe('task-abcdef and mask-12345');
  });
});

describe('authError', () => {
  it('builds the standard auth error for either provider', () => {
    const e = authError('gemini', 400);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toMatchObject({ name: 'ProviderError', code: 'auth', status: 400, message: 'Gemini rejected the API key. Check it in the extension settings.' });
    expect(authError('openai', 401)).toMatchObject({ code: 'auth', status: 401, message: 'OpenAI rejected the API key. Check it in the extension settings.' });
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
  it('OpenAI 403 is a permissions or region denial, not a bad key', () => {
    const e = friendlyHttpError('openai', 403, 'unsupported_country_region_territory');
    expect(e.code).toBe('forbidden');
    expect(e.status).toBe(403);
    expect(e.message).toBe("OpenAI denied access (HTTP 403). Check the key's permissions or your region.");
    expect(friendlyHttpError('openai', 401, '').code).toBe('auth');
  });
  it('Gemini 403 stays an auth error', () => {
    const e = friendlyHttpError('gemini', 403, '');
    expect(e.code).toBe('auth');
    expect(e.message).toBe('Gemini rejected the API key. Check it in the extension settings.');
  });
  it('maps rate limits, bad requests and server errors', () => {
    expect(friendlyHttpError('gemini', 429, '').message).toContain('Gemini rate limit or quota');
    expect(friendlyHttpError('gemini', 400, 'Unsupported MIME type').message).toBe('Gemini rejected the request: Unsupported MIME type');
    expect(friendlyHttpError('openai', 503, '').message).toContain('HTTP 503');
    expect(friendlyHttpError('openai', 418, '').message).toBe('OpenAI error (HTTP 418).');
  });
});
```

- [ ] **Step 11: Run the tests to verify they fail**

```bash
npx vitest run test/unit/background/providers/errors.test.js
```

Expected: 3 failed, 7 passed. "redacts a key glued to a word by an underscore" (`expected 'token_sk-abcdef123456' to be 'token_[key]'`), "redacts an AQ. key with inner dots but keeps the sentence period after it" (`expected '[key].xyz98765' to be '[key]'`), "builds the standard auth error for either provider" (`authError is not a function`).

- [ ] **Step 12: Rewrite `src/background/providers/errors.js`**

Replace the whole file with:

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

// A key starts after any character that is not a letter or digit, so `token_sk-...` is caught
// where `\b` would miss it. AQ. keys may contain inner dots; a trailing sentence period is kept.
const KEY_PATTERN = /(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{4,}|AIza[A-Za-z0-9_-]{4,}|AQ\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]+)*)/g;

/** Strip anything that looks like an API key and cap the length. */
export function redact(text) {
  return String(text ?? '').replace(KEY_PATTERN, '[key]').slice(0, 160);
}

/** @param {'openai'|'gemini'} provider */
function providerLabel(provider) {
  return provider === 'openai' ? 'OpenAI' : 'Gemini';
}

/**
 * The standard error for a key the provider refused.
 * @param {'openai'|'gemini'} provider
 * @param {number} status
 * @returns {ProviderError}
 */
export function authError(provider, status) {
  return new ProviderError(`${providerLabel(provider)} rejected the API key. Check it in the extension settings.`, { status, code: 'auth' });
}

/**
 * @param {'openai'|'gemini'} provider
 * @param {number} status
 * @param {string} apiMessage message from the provider body, may be empty
 */
export function friendlyHttpError(provider, status, apiMessage) {
  const label = providerLabel(provider);
  // OpenAI answers 403 for a valid key without access (project permissions, unsupported region).
  if (status === 403 && provider === 'openai') {
    return new ProviderError("OpenAI denied access (HTTP 403). Check the key's permissions or your region.", { status, code: 'forbidden' });
  }
  if (status === 401 || status === 403) return authError(provider, status);
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

- [ ] **Step 13: Run the tests, then the suite, and commit**

```bash
npx vitest run test/unit/background/providers/errors.test.js
npm test
git add src/background/providers/errors.js test/unit/background/providers/errors.test.js
git commit -m "Redact keys glued to words and share the provider auth error"
```

Expected: 10 passed; suite 14 files, 144/144.

- [ ] **Step 14: Write the failing Gemini tests and the adapter request pins (rows 21, 22, 27, 28)**

Replace `test/unit/background/providers/gemini.test.js` with (the 403 fixture is now a real `PERMISSION_DENIED` body):

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { transcribe, refine, validateKey, joinParts, normalizeSttUsage, toBcp47 } from '../../../../src/background/providers/gemini.js';

const AUDIO = btoa('fake-webm-bytes');
const AUTH_MESSAGE = 'Gemini rejected the API key. Check it in the extension settings.';
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
    const controller = new AbortController();
    const result = await transcribe({ audioBase64: AUDIO, mimeType: 'audio/webm', key: 'AQ.secret', languages: ['el'], keywords: ['Palowise', 'x<y>'], signal: controller.signal });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent');
    expect(url).not.toContain('key=');
    expect(init.method).toBe('POST');
    expect(init.headers['x-goog-api-key']).toBe('AQ.secret');
    expect(init.signal).toBe(controller.signal);
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

  it('caps each vocabulary term at 64 characters', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }));
    await transcribe({ audioBase64: AUDIO, key: 'k', keywords: ['x'.repeat(70)] });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.generationConfig.audioTranscriptionConfig.customVocabulary).toEqual(['x'.repeat(64)]);
  });

  it('maps a 403 to a friendly auth error without echoing the body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      error: {
        code: 403,
        message: "Permission denied: Consumer 'api_key:AIzaSyD9x2KqL0mN3pQ7rS8t' has been suspended.",
        status: 'PERMISSION_DENIED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'CONSUMER_SUSPENDED', domain: 'googleapis.com' }],
      },
    }, 403));
    const err = await transcribe({ audioBase64: AUDIO, key: 'AIzaSyD9x2KqL0mN3pQ7rS8t' }).catch((e) => e);
    expect(err).toMatchObject({ name: 'ProviderError', code: 'auth', status: 403, message: AUTH_MESSAGE });
  });

  it('maps a 400 invalid-key body to an auth error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }, 400));
    await expect(transcribe({ audioBase64: AUDIO, key: 'AQ.bad' })).rejects.toMatchObject({ name: 'ProviderError', code: 'auth', message: AUTH_MESSAGE });
  });

  it('maps a 400 expired-key message to an auth error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 400, message: 'API key expired. Please renew the API key.', status: 'INVALID_ARGUMENT' } }, 400));
    await expect(transcribe({ audioBase64: AUDIO, key: 'AQ.old' })).rejects.toMatchObject({ name: 'ProviderError', code: 'auth', status: 400, message: AUTH_MESSAGE });
  });

  it('keeps an ordinary 400 a bad request', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 400, message: 'Unsupported MIME type: audio/xyz', status: 'INVALID_ARGUMENT' } }, 400));
    await expect(transcribe({ audioBase64: AUDIO, key: 'AQ.ok' })).rejects.toMatchObject({ code: 'bad_request', message: 'Gemini rejected the request: Unsupported MIME type: audio/xyz' });
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

  it('posts with the key header only and passes the abort signal', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    const controller = new AbortController();
    await refine({ key: 'AQ.secret', instructions: 'x', text: 'y', signal: controller.signal });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).not.toContain('key=');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'x-goog-api-key': 'AQ.secret', 'Content-Type': 'application/json' });
    expect(init.signal).toBe(controller.signal);
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

  it('sends a GET with the abort signal and no body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ models: [] }));
    const controller = new AbortController();
    await validateKey({ key: 'AQ.ok', signal: controller.signal });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.signal).toBe(controller.signal);
  });

  it('maps a 400 whose only invalid-key signal is the reason to an auth error', async () => {
    for (const reason of ['API_KEY_INVALID', 'API_KEY_EXPIRED']) {
      fetchMock.mockResolvedValueOnce(jsonResponse({
        error: {
          code: 400,
          message: 'Request contains an invalid argument.',
          status: 'INVALID_ARGUMENT',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com' }],
        },
      }, 400));
      await expect(validateKey({ key: 'AQ.bad' }), reason).rejects.toMatchObject({ name: 'ProviderError', code: 'auth', status: 400, message: AUTH_MESSAGE });
    }
  });
});

describe('helpers', () => {
  it('joinParts tolerates missing candidates', () => {
    expect(joinParts({})).toBe('');
  });
  it('normalizeSttUsage handles missing details', () => {
    expect(normalizeSttUsage(undefined)).toBeNull();
    // No prompt count at all: null, so pricing falls back to the recording length.
    expect(normalizeSttUsage({ candidatesTokenCount: 3 })).toBeNull();
  });
  it('normalizeSttUsage derives audio tokens from the prompt count when details lack AUDIO', () => {
    expect(normalizeSttUsage({ promptTokenCount: 200, candidatesTokenCount: 3 })).toEqual({ kind: 'tokens', audioTokens: 200, textTokens: 0, outputTokens: 3 });
    expect(normalizeSttUsage({ promptTokenCount: 200, candidatesTokenCount: 3, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 8 }] }))
      .toEqual({ kind: 'tokens', audioTokens: 192, textTokens: 8, outputTokens: 3 });
  });
  it('normalizeSttUsage tolerates malformed details', () => {
    expect(normalizeSttUsage({ promptTokensDetails: 'oops' })).toBeNull();
    expect(normalizeSttUsage({ promptTokensDetails: [null, { modality: 'AUDIO', tokenCount: 5 }] })).toEqual({ kind: 'tokens', audioTokens: 5, textTokens: 0, outputTokens: 0 });
  });
  it('toBcp47 maps known codes and passes others through', () => {
    expect(toBcp47('el')).toBe('el-GR');
    expect(toBcp47('en')).toBe('en-US');
    expect(toBcp47('ja')).toBe('ja');
    expect(toBcp47('pt-BR')).toBe('pt-BR');
  });
});
```

In `test/unit/background/providers/openai.test.js`, replace:

```js
  it('passes the abort signal through', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: 'x' }));
    const controller = new AbortController();
    await transcribe({ audioBase64: AUDIO, key: 'k', signal: controller.signal });
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });
});
```

with:

```js
  it('passes the abort signal through', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: 'x' }));
    const controller = new AbortController();
    await transcribe({ audioBase64: AUDIO, key: 'k', signal: controller.signal });
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('caps each keyword at 64 characters', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: 'x' }));
    await transcribe({ audioBase64: AUDIO, key: 'k', keywords: ['k'.repeat(70)] });
    expect(fetchMock.mock.calls[0][1].body.getAll('keywords[]')).toEqual(['k'.repeat(64)]);
  });
});
```

replace:

```js
    expect(result).toEqual({ text: 'Dear team, hello.', usage: { inputTokens: 120, outputTokens: 30 } });
  });
});
```

with:

```js
    expect(result).toEqual({ text: 'Dear team, hello.', usage: { inputTokens: 120, outputTokens: 30 } });
  });

  it('posts with bearer auth and passes the abort signal', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ output: [] }));
    const controller = new AbortController();
    await refine({ key: 'sk-test', instructions: 'x', text: 'y', signal: controller.signal });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(init.signal).toBe(controller.signal);
  });
});
```

and replace:

```js
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'nope' } }, 401));
    await expect(validateKey({ key: 'sk-bad' })).rejects.toMatchObject({ code: 'auth' });
  });
});
```

with:

```js
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'nope' } }, 401));
    await expect(validateKey({ key: 'sk-bad' })).rejects.toMatchObject({ code: 'auth' });
  });

  it('sends a GET with bearer auth, the abort signal and no body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    const controller = new AbortController();
    await validateKey({ key: 'sk-ok', signal: controller.signal });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).not.toContain('sk-ok');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers.Authorization).toBe('Bearer sk-ok');
    expect(init.signal).toBe(controller.signal);
  });
});
```

- [ ] **Step 15: Run the tests to verify they fail**

```bash
npx vitest run test/unit/background/providers
```

Expected: 2 failed, 39 passed. Failing: "maps a 400 expired-key message to an auth error" and "maps a 400 whose only invalid-key signal is the reason to an auth error" (message `API_KEY_EXPIRED: expected ProviderError: Gemini rejected the reques…`; the expired key is still a `bad_request`). The OpenAI additions, the Gemini signal, method, header and 64-character tests, the realistic 403 and the ordinary 400 are pins and pass.

- [ ] **Step 16: Use `authError` in `src/background/providers/gemini.js` and match expired keys (rows 27, 30)**

Replace:

```js
import { friendlyHttpError, ProviderError } from './errors.js';
```

with:

```js
import { authError, friendlyHttpError } from './errors.js';
```

Replace the `transcribe` JSDoc parameter line (the unused `prompt` goes):

```js
 * @param {{ audioBase64: string, mimeType?: string, key: string, languages?: string[], keywords?: string[], prompt?: string, signal?: AbortSignal }} args
```

with:

```js
 * @param {{ audioBase64: string, mimeType?: string, key: string, languages?: string[], keywords?: string[], signal?: AbortSignal }} args
```

Replace:

```js
const INVALID_KEY = /api key not valid|API_KEY_INVALID/i;

/** Map a failed response to a ProviderError. Gemini reports a bad key as HTTP 400, not 401 or 403. */
```

with:

```js
const INVALID_KEY = /api key not valid|api key expired|API_KEY_(?:INVALID|EXPIRED)/i;

/** Map a failed response to a ProviderError. Gemini reports a bad or expired key as HTTP 400, not 401 or 403. */
```

Replace:

```js
    return new ProviderError('Gemini rejected the API key. Check it in the extension settings.', { status: 400, code: 'auth' });
```

with:

```js
    return authError('gemini', 400);
```

- [ ] **Step 17: Run the tests, then the suite, and commit**

```bash
npx vitest run test/unit/background/providers
npm test
git add src/background/providers/gemini.js test/unit/background/providers/gemini.test.js test/unit/background/providers/openai.test.js
git commit -m "Map expired Gemini keys to auth errors and pin adapter request details"
```

Expected: 41 passed (errors 10, gemini 17, openai 14); suite 14 files, 153/153.

- [ ] **Step 18: Write the failing pipeline tests (rows 31, 32)**

In `test/unit/background/pipeline.test.js`, replace:

```js
import { freshSettings } from '../../../src/shared/defaults.js';
```

with:

```js
import { freshSettings } from '../../../src/shared/defaults.js';
import { ProviderError } from '../../../src/background/providers/errors.js';
```

In the test "falls back to the raw transcript with a warning when refine fails", replace:

```js
    adapters.openai.refine.mockRejectedValueOnce(Object.assign(new Error('OpenAI rate limit or quota reached.'), { name: 'ProviderError' }));
```

with:

```js
    adapters.openai.refine.mockRejectedValueOnce(new ProviderError('OpenAI rate limit or quota reached.', { status: 429, code: 'rate_limit' }));
```

In the test "adds a period to a refine failure reason that lacks one", replace:

```js
    adapters.openai.refine.mockRejectedValueOnce(Object.assign(new Error('OpenAI rejected the request: Unsupported model'), { name: 'ProviderError' }));
```

with:

```js
    adapters.openai.refine.mockRejectedValueOnce(new ProviderError('OpenAI rejected the request: Unsupported model', { status: 400, code: 'bad_request' }));
```

Replace the last test and the closing of the `describe`:

```js
  it('ignores inherited property names as providers', async () => {
    const adapters = fakeAdapters();
    const settings = settingsWith({ provider: 'toString' });
    await runDictation({ ...base, modeKey: 'default', settings }, adapters);
    expect(adapters.openai.transcribe).toHaveBeenCalledTimes(1);
  });
});
```

with:

```js
  it('ignores inherited property names as providers', async () => {
    const adapters = fakeAdapters();
    const settings = settingsWith({ provider: 'toString' });
    await runDictation({ ...base, modeKey: 'default', settings }, adapters);
    expect(adapters.openai.transcribe).toHaveBeenCalledTimes(1);
  });

  it('aborts the provider call after timeoutMs', async () => {
    const adapters = fakeAdapters();
    adapters.openai.transcribe.mockImplementationOnce(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    }));
    await expect(runDictation({ ...base, modeKey: 'default', settings: settingsWith() }, adapters, 5)).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('treats a non-string mode prompt as STT only', async () => {
    const adapters = fakeAdapters();
    const settings = settingsWith();
    settings.modes.odd = { name: 'Odd', icon: 'x', prompt: 42, builtIn: false };
    const result = await runDictation({ ...base, modeKey: 'odd', settings }, adapters);
    expect(adapters.openai.refine).not.toHaveBeenCalled();
    expect(result.text).toBe('raw words');
    expect(result.warning).toBeNull();
  });

  it('treats a whitespace-only key as missing', async () => {
    const adapters = fakeAdapters();
    const settings = settingsWith(); settings.keys.openai = '   ';
    await expect(runDictation({ ...base, modeKey: 'default', settings }, adapters)).rejects.toMatchObject({ code: 'no_key' });
    expect(adapters.openai.transcribe).not.toHaveBeenCalled();
  });

  it('sends the trimmed key on both calls', async () => {
    const adapters = fakeAdapters();
    const settings = settingsWith(); settings.keys.openai = '  sk-test \n';
    await runDictation({ ...base, modeKey: 'email', settings }, adapters);
    expect(adapters.openai.transcribe.mock.calls[0][0].key).toBe('sk-test');
    expect(adapters.openai.refine.mock.calls[0][0].key).toBe('sk-test');
  });

  it('trims the target language before falling back to English', async () => {
    const adapters = fakeAdapters();
    await runDictation({ ...base, modeKey: 'translate', settings: settingsWith({ translateTargetLang: '   ' }) }, adapters);
    expect(adapters.openai.refine.mock.calls[0][0].instructions).toContain('Translate it into English.');
    await runDictation({ ...base, modeKey: 'translate', settings: settingsWith({ translateTargetLang: ' Greek ' }) }, adapters);
    expect(adapters.openai.refine.mock.calls[1][0].instructions).toContain('Translate it into Greek.');
  });

  it('words a blank refine failure as Text model failed.', async () => {
    const adapters = fakeAdapters();
    adapters.openai.refine.mockRejectedValueOnce(new ProviderError('   '));
    const result = await runDictation({ ...base, modeKey: 'email', settings: settingsWith() }, adapters);
    expect(result.text).toBe('raw words');
    expect(result.warning).toBe('Mode not applied: Text model failed. Raw transcript inserted.');
  });
});
```

- [ ] **Step 19: Run the tests to verify they fail**

```bash
npx vitest run test/unit/background/pipeline.test.js
```

Expected: 5 failed, 15 passed. "treats a non-string mode prompt as STT only" (`(mode.prompt || "").trim is not a function`), "treats a whitespace-only key as missing" (`promise resolved ... instead of rejecting`), "sends the trimmed key on both calls" (`expected '  sk-test \n' to be 'sk-test'`), "trims the target language before falling back to English", "words a blank refine failure as Text model failed." (`expected 'Mode not applied: . Raw transcript in…'`). The timeout test and the two real-`ProviderError` tests are pins and pass.

- [ ] **Step 20: Harden `runDictation` in `src/background/pipeline.js` (row 32)**

Replace:

```js
/** @param {unknown} err */
function refineFailureMessage(err) {
  const e = /** @type {{ name?: string, message?: string }} */ (err);
  if (e?.name === 'ProviderError') return e.message;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'Request timed out.';
  return 'Text model failed.';
}
```

with:

```js
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
```

Replace:

```js
  const key = settings.keys?.[provider] || '';
```

with:

```js
  const key = trimmed(settings.keys?.[provider]);
```

Replace:

```js
  const instructions = (mode.prompt || '').trim();
  if (instructions) {
    const filled = fillTemplate(instructions, { targetLanguage: settings.translateTargetLang || 'English' });
```

with:

```js
  // A non-string prompt (hand-edited or corrupt storage) means STT only, like an empty one.
  const instructions = trimmed(mode.prompt);
  if (instructions) {
    const filled = fillTemplate(instructions, { targetLanguage: trimmed(settings.translateTargetLang) || 'English' });
```

- [ ] **Step 21: Run the tests, then the suite, and commit**

```bash
npx vitest run test/unit/background/pipeline.test.js
npm test
git add src/background/pipeline.js test/unit/background/pipeline.test.js
git commit -m "Treat blank keys, non-string prompts and empty refine errors safely in the pipeline"
```

Expected: 20 passed; suite 14 files, 159/159.

---

### Task 3: Settings, chord helpers and the message contract

**Files:**
- Modify: `src/shared/defaults.js`, `src/shared/messages.js`
- Create: `src/shared/chord.js`
- Test: `test/unit/shared/defaults.test.js`, `test/unit/shared/chord.test.js`, `test/unit/shared/messages.test.js`

**Interfaces:**
- Produces:
  - `src/shared/chord.js`:
    - `@typedef {{ code: string, ctrl: boolean, shift: boolean, alt: boolean, meta: boolean }} Chord`
    - `isValidChord(value: unknown): boolean`: object with a non-empty string `code` that is not a modifier code (`ControlLeft|ControlRight|ShiftLeft|ShiftRight|AltLeft|AltRight|MetaLeft|MetaRight`), boolean flags, and at least one of `ctrl`, `alt`, `meta` true.
    - `matchesChord(event: { code, ctrlKey, shiftKey, altKey, metaKey }, chord: Chord): boolean`: exact code and exact modifier set.
    - `chordFromEvent(event): Chord|null`: null for modifier-only keys, `Escape`, `Tab`, or no `ctrl`/`alt`/`meta`.
    - `formatChord(chord: Chord, { mac = false } = {}): string`: `Ctrl+Shift+Space`; on mac `Ctrl`, `Option`, `Shift`, `Cmd`; `Key*` codes shown as the letter, `Digit*` as the digit, other codes as is.
  - `src/shared/defaults.js`:
    - `DEFAULT_SETTINGS` gains `hotkey: { code: 'Space', ctrl: true, shift: true, alt: false, meta: false }` and `autoStopSilenceSec: 0`; `Settings` typedef updated.
    - `AUTO_STOP_CHOICES = Object.freeze([0, 2, 3, 5])`.
    - `migrateSettings(stored)`: v2 path when `Number(stored.settingsVersion) >= 2`; fills or repairs every field: `provider` (must be an own key of `PROVIDERS`), `keys` (strings), `modes` (object; built-ins present and objects; `Object.hasOwn` everywhere), `activeMode` (own key of `modes`, else `'default'`), `minRecordingTime` and `maxRecordingTime` (finite, > 0), `translateTargetLang` (non-empty string), `languages` and `keywords` (arrays of strings), `pillGap` (finite, >= 0), `hotkey` (`isValidChord`), `autoStopSilenceSec` (member of `AUTO_STOP_CHOICES`). Returns the same reference when nothing changed. v1 path: `Object.hasOwn(BUILTIN_MODES, key)`; only string `name` and `icon` kept; `pillGap >= 0`.
    - `@typedef {Omit<Settings, 'keys'> & { hasKey: { openai: boolean, gemini: boolean } }} PublicSettings`
    - `toPublicSettings(settings: Settings): PublicSettings`: deep copy without `keys`; `hasKey` from trimmed keys.
    - `CONTENT_PATCH_FIELDS = Object.freeze(['activeMode', 'provider', 'translateTargetLang'])`.
    - `applySettingsPatch(settings: Settings, patch: unknown): { ok: true, settings: Settings } | { ok: false, error: string }`: rejects non-objects and any field outside `CONTENT_PATCH_FIELDS` (`'Invalid settings.'`); `activeMode` must be an own key of `settings.modes`; `provider` an own key of `PROVIDERS`; `translateTargetLang` a trimmed non-empty string of at most 40 characters. Never mutates the input.
    - `DEFAULT_SETTINGS` and `BUILTIN_MODES` deep-frozen (use `deepFreeze` from `models.js`).
  - `src/shared/messages.js`: `MSG` holds every key of the Message contract table plus the three legacy keys `CHECK_KEY: 'checkApiKey'`, `TRANSCRIBE: 'transcribe'`, `TOGGLE_RECORDING: 'toggle-recording'` grouped under the comment `// Legacy v2.0 content path; removed in Task 11.`; the typedefs block above. `test/unit/shared/messages.test.js` pins that every value is unique and that every contract key exists.
- Ledger: row 18 (migration hardening), row 12 (freeze).
- Note: between Tasks 4 and 11 the v2.0 content script still sends the legacy actions, which the rewritten router no longer serves; in-browser dictation is expected to be broken on this branch until Task 11 lands. `npm test` and `npm run build` stay green throughout.

WRITER NOTES

- `formatChord`: the contract names the mac labels only. Off mac, Meta is shown as `Meta`; the order is Ctrl, Alt (Option), Shift, Meta (Cmd) on both platforms.
- `applySettingsPatch` answers `'Invalid settings.'` for every rejection, bad values included (the contract names that text only for non-objects and foreign fields).
- `isValidChord` accepts `Escape` or `Tab` as the main key (the contract lists only modifier codes); `chordFromEvent` never produces them, so only hand-edited storage could hold one.
- The v2 path also drops mode entries that are not objects (a `null` custom mode would crash every renderer) and re-stamps a non-number `settingsVersion` (for example `'2'`) as the number 2.
- No existing test breaks: deep-freezing is safe because every caller copies through `freshSettings()`, and the v1 output is already v2-valid, so the storage "writes back once" test holds. The v1 migration and `freshSettings` tests gain assertions for the new fields.

- [ ] **Step 1: Write the failing chord tests**

`test/unit/shared/chord.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { isValidChord, matchesChord, chordFromEvent, formatChord } from '../../../src/shared/chord.js';

const CTRL_SHIFT_SPACE = { code: 'Space', ctrl: true, shift: true, alt: false, meta: false };

/** A keydown-like object; only the fields the helpers read. */
function key(code, { ctrl = false, shift = false, alt = false, meta = false } = {}) {
  return { code, ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: meta };
}

describe('isValidChord', () => {
  it('accepts a main key with at least one of Ctrl, Alt or Meta', () => {
    expect(isValidChord(CTRL_SHIFT_SPACE)).toBe(true);
    expect(isValidChord({ code: 'KeyD', ctrl: false, shift: false, alt: true, meta: false })).toBe(true);
    expect(isValidChord({ code: 'Digit5', ctrl: false, shift: true, alt: false, meta: true })).toBe(true);
  });

  it('rejects Shift alone or no modifier', () => {
    expect(isValidChord({ code: 'KeyA', ctrl: false, shift: true, alt: false, meta: false })).toBe(false);
    expect(isValidChord({ code: 'KeyA', ctrl: false, shift: false, alt: false, meta: false })).toBe(false);
  });

  it('rejects a modifier as the main key', () => {
    for (const code of ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']) {
      expect(isValidChord({ code, ctrl: true, shift: false, alt: true, meta: false }), code).toBe(false);
    }
  });

  it('rejects a missing or empty code and non-boolean flags', () => {
    expect(isValidChord({ ctrl: true, shift: false, alt: false, meta: false })).toBe(false);
    expect(isValidChord({ ...CTRL_SHIFT_SPACE, code: '' })).toBe(false);
    expect(isValidChord({ ...CTRL_SHIFT_SPACE, code: 32 })).toBe(false);
    expect(isValidChord({ ...CTRL_SHIFT_SPACE, ctrl: 1 })).toBe(false);
    expect(isValidChord({ code: 'Space', ctrl: true })).toBe(false);
  });

  it('rejects non-objects', () => {
    for (const value of [null, undefined, 'Ctrl+Shift+Space', 5, true, []]) expect(isValidChord(value), String(value)).toBe(false);
  });
});

describe('matchesChord', () => {
  it('matches the exact code and modifier set', () => {
    expect(matchesChord(key('Space', { ctrl: true, shift: true }), CTRL_SHIFT_SPACE)).toBe(true);
  });

  it('rejects a missing or an extra modifier', () => {
    expect(matchesChord(key('Space', { ctrl: true }), CTRL_SHIFT_SPACE)).toBe(false);
    expect(matchesChord(key('Space', { ctrl: true, shift: true, alt: true }), CTRL_SHIFT_SPACE)).toBe(false);
    expect(matchesChord(key('Space', { ctrl: true, shift: true, meta: true }), CTRL_SHIFT_SPACE)).toBe(false);
  });

  it('rejects another key with the same modifiers', () => {
    expect(matchesChord(key('KeyS', { ctrl: true, shift: true }), CTRL_SHIFT_SPACE)).toBe(false);
  });

  it('never matches an invalid chord or a missing event', () => {
    expect(matchesChord(key('Space', { shift: true }), { code: 'Space', ctrl: false, shift: true, alt: false, meta: false })).toBe(false);
    expect(matchesChord(key('Space', { ctrl: true, shift: true }), null)).toBe(false);
    expect(matchesChord(null, CTRL_SHIFT_SPACE)).toBe(false);
  });
});

describe('chordFromEvent', () => {
  it('builds a chord from a key with Ctrl, Alt or Meta held', () => {
    expect(chordFromEvent(key('Space', { ctrl: true, shift: true }))).toEqual(CTRL_SHIFT_SPACE);
    expect(chordFromEvent(key('KeyD', { alt: true }))).toEqual({ code: 'KeyD', ctrl: false, shift: false, alt: true, meta: false });
    expect(chordFromEvent(key('KeyK', { meta: true, shift: true }))).toEqual({ code: 'KeyK', ctrl: false, shift: true, alt: false, meta: true });
  });

  it('returns null for modifier-only keys', () => {
    expect(chordFromEvent(key('ControlLeft', { ctrl: true }))).toBeNull();
    expect(chordFromEvent(key('ShiftRight', { ctrl: true, shift: true }))).toBeNull();
    expect(chordFromEvent(key('MetaLeft', { meta: true }))).toBeNull();
  });

  it('returns null for Escape and Tab even with modifiers', () => {
    expect(chordFromEvent(key('Escape', { ctrl: true }))).toBeNull();
    expect(chordFromEvent(key('Tab', { alt: true }))).toBeNull();
  });

  it('returns null without Ctrl, Alt or Meta', () => {
    expect(chordFromEvent(key('KeyA'))).toBeNull();
    expect(chordFromEvent(key('KeyA', { shift: true }))).toBeNull();
  });

  it('returns null for an event without a code', () => {
    expect(chordFromEvent(key('', { ctrl: true }))).toBeNull();
    expect(chordFromEvent(null)).toBeNull();
  });
});

describe('formatChord', () => {
  it('formats the default chord', () => {
    expect(formatChord(CTRL_SHIFT_SPACE)).toBe('Ctrl+Shift+Space');
    expect(formatChord(CTRL_SHIFT_SPACE, { mac: true })).toBe('Ctrl+Shift+Space');
  });

  it('orders modifiers Ctrl, Alt, Shift, Meta and names them per platform', () => {
    const all = { code: 'KeyV', ctrl: true, shift: true, alt: true, meta: true };
    expect(formatChord(all)).toBe('Ctrl+Alt+Shift+Meta+V');
    expect(formatChord(all, { mac: true })).toBe('Ctrl+Option+Shift+Cmd+V');
  });

  it('shows letters and digits bare and other codes as is', () => {
    expect(formatChord({ code: 'KeyD', ctrl: false, shift: false, alt: true, meta: false })).toBe('Alt+D');
    expect(formatChord({ code: 'KeyD', ctrl: false, shift: false, alt: true, meta: false }, { mac: true })).toBe('Option+D');
    expect(formatChord({ code: 'Digit7', ctrl: true, shift: false, alt: false, meta: false })).toBe('Ctrl+7');
    expect(formatChord({ code: 'KeyK', ctrl: false, shift: true, alt: false, meta: true }, { mac: true })).toBe('Shift+Cmd+K');
    expect(formatChord({ code: 'F5', ctrl: true, shift: false, alt: false, meta: false })).toBe('Ctrl+F5');
    expect(formatChord({ code: 'Backquote', ctrl: false, shift: false, alt: true, meta: false })).toBe('Alt+Backquote');
    expect(formatChord({ code: 'Numpad1', ctrl: true, shift: false, alt: false, meta: false })).toBe('Ctrl+Numpad1');
  });

  it('returns an empty string for an invalid chord', () => {
    expect(formatChord(null)).toBe('');
    expect(formatChord({ code: 'KeyA', ctrl: false, shift: true, alt: false, meta: false })).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/shared/chord.test.js
```

Expected: FAIL with `Cannot find module '../../../src/shared/chord.js'`.

- [ ] **Step 3: Create `src/shared/chord.js`**

```js
// Keyboard chords for the hotkey: validation, matching, capture and display. Pure functions.

/**
 * A main key (`KeyboardEvent.code`) plus the exact set of modifiers held with it.
 * @typedef {{ code: string, ctrl: boolean, shift: boolean, alt: boolean, meta: boolean }} Chord
 */

const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
]);

// Escape cancels the popup recorder and Tab moves focus; neither may become the hotkey.
const RESERVED_CODES = new Set(['Escape', 'Tab']);

const FLAGS = ['ctrl', 'shift', 'alt', 'meta'];

/**
 * True for a usable chord: a non-modifier `code`, four boolean flags and at least one of
 * Ctrl, Alt or Meta (Shift alone would fire while typing capitals).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidChord(value) {
  if (!value || typeof value !== 'object') return false;
  const c = /** @type {Record<string, unknown>} */ (value);
  if (typeof c.code !== 'string' || c.code === '' || MODIFIER_CODES.has(c.code)) return false;
  if (!FLAGS.every((flag) => typeof c[flag] === 'boolean')) return false;
  return Boolean(c.ctrl || c.alt || c.meta);
}

/**
 * Exact match: same code and exactly the same modifiers. An invalid chord matches nothing.
 * @param {{ code: string, ctrlKey: boolean, shiftKey: boolean, altKey: boolean, metaKey: boolean }|null|undefined} event
 * @param {Chord|null|undefined} chord
 * @returns {boolean}
 */
export function matchesChord(event, chord) {
  if (!event || !isValidChord(chord)) return false;
  return event.code === chord.code
    && Boolean(event.ctrlKey) === chord.ctrl
    && Boolean(event.shiftKey) === chord.shift
    && Boolean(event.altKey) === chord.alt
    && Boolean(event.metaKey) === chord.meta;
}

/**
 * The chord a keydown would record, or null for modifier-only keys, Escape, Tab, or a
 * key pressed without Ctrl, Alt or Meta.
 * @param {{ code: string, ctrlKey: boolean, shiftKey: boolean, altKey: boolean, metaKey: boolean }|null|undefined} event
 * @returns {Chord|null}
 */
export function chordFromEvent(event) {
  if (!event || RESERVED_CODES.has(event.code)) return null;
  const chord = {
    code: event.code,
    ctrl: Boolean(event.ctrlKey),
    shift: Boolean(event.shiftKey),
    alt: Boolean(event.altKey),
    meta: Boolean(event.metaKey),
  };
  return isValidChord(chord) ? chord : null;
}

/** @param {string} code */
function keyLabel(code) {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  return code;
}

/**
 * Human label such as `Ctrl+Shift+Space`. Modifiers in the order Ctrl, Alt, Shift, Meta;
 * on mac Alt is `Option` and Meta is `Cmd`. Empty for an invalid chord.
 * @param {Chord} chord
 * @param {{ mac?: boolean }} [options]
 * @returns {string}
 */
export function formatChord(chord, { mac = false } = {}) {
  if (!isValidChord(chord)) return '';
  const parts = [];
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push(mac ? 'Option' : 'Alt');
  if (chord.shift) parts.push('Shift');
  if (chord.meta) parts.push(mac ? 'Cmd' : 'Meta');
  parts.push(keyLabel(chord.code));
  return parts.join('+');
}
```

- [ ] **Step 4: Run the test to verify it passes, then commit**

```bash
npx vitest run test/unit/shared/chord.test.js
npm test
git add src/shared/chord.js test/unit/shared/chord.test.js
git commit -m "Add pure chord helpers for the hotkey"
```

Expected: 18 passed; suite 15 files, 177/177.

- [ ] **Step 5: Write the failing message contract test**

`test/unit/shared/messages.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { MSG } from '../../../src/shared/messages.js';

// The Message contract table of the Phase 1 plan, key by key.
const CONTRACT = {
  GET_SETTINGS: 'getSettings',
  SAVE_SETTINGS: 'saveSettings',
  UPDATE_SETTINGS: 'updateSettings',
  VALIDATE_KEY: 'validateKey',
  GET_USAGE: 'getUsageStats',
  CLEAR_USAGE: 'clearUsageStats',
  START_RECORDING: 'startRecording',
  STOP_RECORDING: 'stopRecording',
  CANCEL_RECORDING: 'cancelRecording',
  SETTINGS_CHANGED: 'settingsChanged',
  AUDIO_LEVEL: 'audioLevel',
  RECORDING_STATE: 'recordingState',
  DICTATION_RESULT: 'dictationResult',
  OFFSCREEN_START: 'offscreenStart',
  OFFSCREEN_STOP: 'offscreenStop',
  OFFSCREEN_LEVEL: 'offscreenLevel',
  OFFSCREEN_DONE: 'offscreenDone',
  OFFSCREEN_ERROR: 'offscreenError',
  PERMISSION_RESULT: 'permissionResult',
};

describe('MSG', () => {
  it('holds every key of the message contract with its value', () => {
    expect(MSG).toMatchObject(CONTRACT);
  });

  it('gives every action a unique value', () => {
    const values = Object.values(MSG);
    expect(new Set(values).size).toBe(values.length);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(MSG)).toBe(true);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

```bash
npx vitest run test/unit/shared/messages.test.js
```

Expected: 1 failed, 2 passed. "holds every key of the message contract with its value" fails with `expected { GET_SETTINGS: 'getSettings', …(7) } to match object { GET_SETTINGS: 'getSettings', …(18) }`.

- [ ] **Step 7: Rewrite `src/shared/messages.js`**

The old `TranscribeRequest`, `TranscribeResponse` and `ValidateKeyRequest` typedefs are referenced nowhere and are replaced by the contract typedefs.

```js
// Message action names shared by background, offscreen, content and popup.
// Every message is { action: MSG.X, ...payload }; the plan's Message contract lists who sends what.
export const MSG = Object.freeze({
  GET_SETTINGS: 'getSettings',
  SAVE_SETTINGS: 'saveSettings',
  UPDATE_SETTINGS: 'updateSettings',
  VALIDATE_KEY: 'validateKey',
  GET_USAGE: 'getUsageStats',
  CLEAR_USAGE: 'clearUsageStats',
  START_RECORDING: 'startRecording',
  STOP_RECORDING: 'stopRecording',
  CANCEL_RECORDING: 'cancelRecording',
  SETTINGS_CHANGED: 'settingsChanged',
  AUDIO_LEVEL: 'audioLevel',
  RECORDING_STATE: 'recordingState',
  DICTATION_RESULT: 'dictationResult',
  OFFSCREEN_START: 'offscreenStart',
  OFFSCREEN_STOP: 'offscreenStop',
  OFFSCREEN_LEVEL: 'offscreenLevel',
  OFFSCREEN_DONE: 'offscreenDone',
  OFFSCREEN_ERROR: 'offscreenError',
  PERMISSION_RESULT: 'permissionResult',
  // Legacy v2.0 content path; removed in Task 11.
  CHECK_KEY: 'checkApiKey',
  TRANSCRIBE: 'transcribe',
  TOGGLE_RECORDING: 'toggle-recording',
});

/**
 * @typedef {'noKey'|'busy'|'needsPermission'|'denied'|'micError'} StartFailure
 * @typedef {{ ok: true } | { ok: false, reason: StartFailure, error: string }} StartResponse
 * @typedef {{ text: string, tone: 'info'|'success'|'warning'|'error' }} Notice
 * @typedef {{ state: 'idle'|'processing', reason?: 'maxTime'|'silence'|'ended'|'error'|'permission', notice?: Notice }} RecordingStatePayload
 * @typedef {{ success: true, text: string, raw: string, cost: number, warning: string|null }
 *   | { success: false, error: string, tone: 'warning'|'error' }} DictationMessage
 * @typedef {{ ok: true } | { ok: false, reason: 'needsPermission'|'denied'|'micError', error: string }} OffscreenStartResponse
 * @typedef {{ audioBase64: string, mimeType: string, durationSec: number, reason: 'user'|'maxTime'|'silence'|'ended' }} OffscreenDone
 */
```

- [ ] **Step 8: Run the test, the suite and the build, then commit**

```bash
npx vitest run test/unit/shared/messages.test.js
npm test
npm run build
git add src/shared/messages.js test/unit/shared/messages.test.js
git commit -m "Define the Phase 1 message contract and payload types"
```

Expected: 3 passed; suite 16 files, 180/180; the build is clean (the v2.0 content script and router still use the three legacy keys).

- [ ] **Step 9: Write the failing settings tests**

Replace `test/unit/shared/defaults.test.js` with (the existing tests are kept; "freshSettings returns an independent deep copy" and "migrates a v1 object" gain assertions for the new fields):

```js
import { describe, it, expect } from 'vitest';
import {
  SETTINGS_VERSION, BUILTIN_MODES, DEFAULT_SETTINGS, AUTO_STOP_CHOICES, CONTENT_PATCH_FIELDS,
  freshSettings, recoverKey, migrateSettings, toPublicSettings, applySettingsPatch,
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
```

- [ ] **Step 10: Run the tests to verify they fail**

```bash
npx vitest run test/unit/shared/defaults.test.js
```

Expected: 24 failed, 18 passed. Among the failures: "gives a Phase 0 v2 record the new defaults and keeps its keys and custom modes" (the old fast path returns the same reference), "takes the v2 path for a string settings version and stores it as a number" (`expected { openai: '', gemini: '' } to deeply equal { openai: 'sk-proj-abc123', …(1) }`: the keys are blanked today), "v1: keeps a mode keyed constructor as a custom mode instead of throwing" (`DataCloneError`), and every `toPublicSettings` and `applySettingsPatch` test (`... is not a function`). "returns the same reference for a fully populated v2 record and leaves it untouched", "keeps valid edge values", "repairs keys that are not strings", "never mutates the stored object while repairing it" and "v1: produces a record the v2 path accepts unchanged" are pins and pass.

- [ ] **Step 11: Rewrite `src/shared/defaults.js`**

```js
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
```

- [ ] **Step 12: Run the tests to verify they pass**

```bash
npx vitest run test/unit/shared/defaults.test.js
```

Expected: 42 passed.

- [ ] **Step 13: Run the suite and the build, then commit**

```bash
npm test
npm run build
git add src/shared/defaults.js test/unit/shared/defaults.test.js
git commit -m "Validate every settings field, add hotkey and auto-stop defaults, and derive key-free public settings"
```

Expected: 16 files, 207/207 (storage, router and pipeline tests pass unchanged); the build is clean.

---

### Task 4: Router, storage, usage and dictation (M2)

**Files:**
- Modify: `src/background/router.js`, `src/background/storage.js`, `src/background/usage.js`, `src/background/index.js`
- Create: `src/background/dictate.js`, `src/background/tabs.js` (`broadcast`; Task 6 adds `sendToFrame` and `reinject`)
- Test: `test/unit/background/router.test.js`, `test/unit/background/storage.test.js`, `test/unit/background/usage.test.js`, `test/unit/background/dictate.test.js`, `test/unit/background/tabs.test.js`, `test/unit/background/index.test.js` (entry wiring with a fake `chrome`)

**Interfaces:**
- Consumes: Task 3 `MSG`, `toPublicSettings`, `applySettingsPatch`, `migrateSettings`.
- Produces:
  - `src/background/storage.js` `createStorage(area)` returns `{ getSettings(), saveSettings(settings), updateSettings(fn), getUsageLog(), setUsageLog(log), updateUsageLog(fn) }`. `updateSettings(fn: (current: Settings) => Settings|null): Promise<Settings>` and `updateUsageLog(fn: (log: UsageLog) => UsageLog): Promise<UsageLog>` run through one internal promise queue shared with `saveSettings` and `setUsageLog`, so read-modify-write sequences never interleave. A `null` return from the `updateSettings` callback writes nothing. `getUsageLog()` returns `normalizeLog(stored)`.
  - `src/background/usage.js` adds `normalizeLog(value: unknown): UsageLog` (v2 with every bucket field defaulted to 0; anything else is `emptyLog()`); `applyUsage` counts modes with `Object.hasOwn`, and only `'openai'` and `'gemini'` get a `byProvider` entry.
  - `src/background/dictate.js` `createDictate({ storage, runDictation, applyUsage, userMessage }) => (input: { audioBase64: string, mimeType: string, modeKey: string, durationSec: number }) => Promise<DictationMessage>`: reads settings fresh, runs the pipeline, logs usage through `storage.updateUsageLog` inside its own try/catch (logging never turns success into failure), maps errors with `userMessage` to `{ success: false, error, tone: 'error' }`, logs failures with the key-safe `warnFailure`.
  - `src/background/router.js`:
    - `senderKind(sender, { extensionId, extensionOrigin, offscreenUrl }): 'offscreen'|'extension'|'content'|'unknown'`: `sender.id !== extensionId` is `'unknown'`; `sender.origin === extensionOrigin` is `'offscreen'` when `sender.url` starts with `offscreenUrl`, else `'extension'`; otherwise `'content'` when `sender.tab` has a numeric `id`; otherwise `'unknown'`.
    - `createRouter({ storage, validateKey, summarize, recorder, identify })` returns `handle(request, sender)`. `identify(sender)` returns a `senderKind` result (index.js binds the real ids). Access table and responses exactly as the Message contract. `SAVE_SETTINGS` merges `{ ...current, ...next, keys: { ...current.keys, ...(valid next.keys) } }` through `storage.updateSettings`, then `migrateSettings`. `UPDATE_SETTINGS` uses `applySettingsPatch` through `storage.updateSettings`. `GET_SETTINGS` returns `toPublicSettings` to content. Recording actions and offscreen and permission actions delegate to `recorder` (Task 6 supplies it; until then index.js passes a stub whose methods resolve `{ ok: false, reason: 'micError', error: 'Recording is not available yet.' }`). Endpoints for recording actions are `{ tabId: sender.tab.id, frameId: sender.frameId ?? 0 }`.
    - `userMessage(err, { context })` unchanged in behaviour.
  - `src/background/index.js`: calls `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })` at top level (catch and `console.warn`); passes `sender` to the router; registers `chrome.storage.onChanged` and broadcasts `{ action: MSG.SETTINGS_CHANGED, settings: toPublicSettings(migrateSettings(newValue)) }` to every tab with `chrome.tabs.sendMessage(tab.id, message).catch(() => {})` whenever `changes.settings.newValue` is an object; `validateKey` uses `Object.hasOwn(ADAPTERS, provider)`. The `chrome.commands` listener and `toggleActiveTab` stay until Task 6.
- Ledger: rows 36, 37, 38, 41, 42, 45, 64 (M2 service worker side).

**Writer notes (verified during planning):**

- `validateKey` is `createValidateKey(adapters)` exported from `router.js` (own-property lookup, injectable so `'constructor'` is testable); `index.js` calls `createValidateKey(ADAPTERS)`. `warnFailure` is exported from `router.js` for `dictate.js`.
- `index.js` builds the extension origin as `` `chrome-extension://${chrome.runtime.id}` ``. `new URL(chrome.runtime.getURL('/')).origin` is `'null'` in Node (non-special scheme), the same value content scripts in sandboxed or `about:blank` frames report, so the research recipe would classify those frames as trusted anywhere the URL parser treats the scheme as opaque.
- `SAVE_SETTINGS` forces `settingsVersion: SETTINGS_VERSION` into the merge before `migrateSettings`, so a stray `settingsVersion: 1` in a payload can never run the v1 path over stored keys.
- `createDictate` also passes the mapped error through `redact` (Global Constraint: no message to a content script carries a key; `userMessage` returns `ProviderError` text verbatim).
- `storage.updateSettings` treats any non-object callback result (not only `null`) as "write nothing"; `getSettings` and `getUsageLog` also run through the queue, so the migration write-back cannot race an update.
- Verified on a scratch copy with the final task-01, task-02 and task-03 parts applied first (suite 257/257 after this task; the `usage.test.js` replacement keeps Task 1's two DST tests verbatim). Tests rely on these Task 3 behaviours: `migrateSettings` resets an unknown `activeMode` to `'default'` and returns the same reference for `freshSettings()`; `applySettingsPatch` answers `'Invalid settings.'` for a non-object patch or a non-whitelisted field; `toPublicSettings` sets `hasKey` from trimmed keys.

- [ ] **Step 1: Write the failing usage tests**

Replace the whole of `test/unit/background/usage.test.js` with (the Task 1 tests, "runs where 29 March 2026 lasts 23 hours" and the midnight DST case, are kept unchanged):

```js
import { describe, it, expect } from 'vitest';
import { localDateKey, emptyLog, normalizeLog, applyUsage, summarize, RETENTION_DAYS } from '../../../src/background/usage.js';

const entry = (provider, audioSeconds, cost, mode = 'default') => ({ provider, audioSeconds, cost, mode });

describe('localDateKey', () => {
  it('uses local calendar date, not UTC', () => {
    const lateLocal = {
      getFullYear: () => 2026, getMonth: () => 8, getDate: () => 26,
      getUTCFullYear: () => 2026, getUTCMonth: () => 8, getUTCDate: () => 27,
      toISOString: () => '2026-09-27T02:00:00.000Z',
    };
    expect(localDateKey(lateLocal)).toBe('2026-09-26');
    expect(localDateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('normalizeLog', () => {
  it('turns anything that is not a v2 log into an empty log', () => {
    for (const value of [undefined, null, 'x', 42, [], { daily: {}, total: { sessions: 9 } }, { version: 1, daily: {}, total: {} }]) {
      expect(normalizeLog(value), JSON.stringify(value)).toEqual(emptyLog());
    }
  });

  it('defaults every missing or non-finite bucket field to 0', () => {
    const log = normalizeLog({
      version: 2,
      daily: { '2026-09-26': { sessions: 2, audioSeconds: 'x', modes: { email: 2, bad: 'y' } }, '2026-09-25': 'junk' },
      total: { sessions: 2, estimatedCost: NaN, byProvider: { openai: { sessions: 2 }, gemini: null } },
    });
    expect(log.daily['2026-09-26']).toEqual({
      sessions: 2, audioSeconds: 0, estimatedCost: 0,
      byProvider: { openai: { sessions: 0, audioSeconds: 0, cost: 0 }, gemini: { sessions: 0, audioSeconds: 0, cost: 0 } },
      modes: { email: 2 },
    });
    expect(log.daily['2026-09-25']).toBeUndefined();
    expect(log.total.estimatedCost).toBe(0);
    expect(log.total.byProvider.openai).toEqual({ sessions: 2, audioSeconds: 0, cost: 0 });
    expect(log.total.byProvider.gemini).toEqual({ sessions: 0, audioSeconds: 0, cost: 0 });
  });

  it('keeps only the openai and gemini provider buckets', () => {
    const log = normalizeLog({ version: 2, daily: {}, total: { byProvider: { openai: { sessions: 1 }, azure: { sessions: 5 } } } });
    expect(Object.keys(log.total.byProvider)).toEqual(['openai', 'gemini']);
  });

  it('returns a fresh object that shares nothing with its input', () => {
    const input = { version: 2, daily: {}, total: { sessions: 1, modes: { email: 1 } } };
    const log = normalizeLog(input);
    log.total.modes.email = 99;
    expect(input.total.modes.email).toBe(1);
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

  it('counts a mode named constructor as an ordinary mode', () => {
    const now = new Date(2026, 8, 26, 12);
    const log = applyUsage(emptyLog(), entry('openai', 5, 0.001, 'constructor'), now);
    expect(Object.hasOwn(log.total.modes, 'constructor')).toBe(true);
    expect(log.total.modes.constructor).toBe(1);
    expect(log.daily['2026-09-26'].modes.constructor).toBe(1);
    expect(summarize(log, now).today.modes.constructor).toBe(1);
  });

  it('gives only openai and gemini a byProvider entry', () => {
    const log = applyUsage(emptyLog(), entry('azure', 5, 0.001), new Date(2026, 8, 26));
    expect(Object.keys(log.total.byProvider)).toEqual(['openai', 'gemini']);
    expect(log.total.sessions).toBe(1);
    expect(log.total.byProvider.openai.sessions).toBe(0);
  });

  it('accepts a v2 log whose buckets are missing fields', () => {
    const log = applyUsage({ version: 2, daily: {}, total: {} }, entry('openai', 3, 0.001), new Date(2026, 8, 26));
    expect(log.total.sessions).toBe(1);
    expect(log.total.byProvider.openai).toEqual({ sessions: 1, audioSeconds: 3, cost: 0.001 });
  });

  it('keeps the day 90 days back and prunes the day 91 days back, but keeps totals', () => {
    const now = new Date(2026, 8, 26, 12);
    const day90 = new Date(2026, 8, 26 - RETENTION_DAYS, 12);
    const day91 = new Date(2026, 8, 26 - RETENTION_DAYS - 1, 12);
    let log = applyUsage(emptyLog(), entry('openai', 10, 0.001), day91);
    log = applyUsage(log, entry('openai', 10, 0.001), day90);
    log = applyUsage(log, entry('openai', 10, 0.001), now);
    expect(RETENTION_DAYS).toBe(90);
    expect(log.daily[localDateKey(day90)].sessions).toBe(1);
    expect(log.daily[localDateKey(day91)]).toBeUndefined();
    expect(log.total.sessions).toBe(3);
  });

  it('treats a non-finite audioSeconds or cost as zero', () => {
    const log = applyUsage(emptyLog(), { provider: 'openai', audioSeconds: NaN, cost: undefined, mode: 'default' }, new Date(2026, 8, 26));
    expect(log.total.audioSeconds).toBe(0);
    expect(log.total.estimatedCost).toBe(0);
    expect(log.total.sessions).toBe(1);
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

  it('runs where 29 March 2026 lasts 23 hours (vitest.config.js pins Europe/Athens)', () => {
    expect(new Date(2026, 2, 30) - new Date(2026, 2, 29)).toBe(23 * 60 * 60 * 1000);
  });

  it('counts seven distinct days across a DST-like boundary', () => {
    // Half past midnight on the first full day of summer time in Athens: stepping back
    // 24 hours from here lands on 28 March and would skip the 23-hour 29 March.
    const now = new Date(2026, 2, 30, 0, 30);
    let log = emptyLog();
    for (let i = 0; i < 7; i++) log = applyUsage(log, entry('openai', 1, 0.001), new Date(2026, 2, 30 - i, 12));
    expect(summarize(log, now).last7Days.sessions).toBe(7);
  });

  it('returns empty buckets for a missing log', () => {
    const s = summarize(undefined);
    expect(s.today.sessions).toBe(0);
    expect(s.total.byProvider.openai.cost).toBe(0);
  });

  it('returns empty buckets for a v1 log', () => {
    const now = new Date(2026, 8, 26, 12);
    const v1 = { daily: { '2026-09-26': { sessions: 5, audioSeconds: 50, estimatedCost: 1 } }, total: { sessions: 5, audioSeconds: 50, estimatedCost: 1 } };
    const s = summarize(v1, now);
    expect(s.today).toEqual(emptyLog().total);
    expect(s.last7Days).toEqual(emptyLog().total);
    expect(s.total).toEqual(emptyLog().total);
  });

  it('sums a partial v2 day bucket without throwing', () => {
    const now = new Date(2026, 8, 26, 12);
    const s = summarize({ version: 2, daily: { '2026-09-26': { sessions: 2 } }, total: {} }, now);
    expect(s.today.sessions).toBe(2);
    expect(s.today.byProvider.gemini.sessions).toBe(0);
  });
});
```

- [ ] **Step 2: Run the usage tests to verify they fail**

```bash
npx vitest run test/unit/background/usage.test.js
```

Expected: 7 failed, 12 passed. Four fail with `TypeError: normalizeLog is not a function`; "counts a mode named constructor" fails with `expected 'function Object() { [native code] }1' to be 1`; "gives only openai and gemini a byProvider entry" fails with `[ 'openai', 'gemini', 'azure' ]`; "accepts a v2 log whose buckets are missing fields" fails with `Cannot read properties of undefined (reading 'openai')`.

- [ ] **Step 3: Rewrite `src/background/usage.js`**

Replace the whole file with:

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

/** Local noon n calendar days before `now`; noon keeps DST shifts from skipping or doubling a day. */
function daysAgo(now, n) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 12);
}

/** @returns {ProviderBucket} */
function emptyProviderBucket() {
  return { sessions: 0, audioSeconds: 0, cost: 0 };
}

/** @returns {Bucket} */
function emptyBucket() {
  return {
    sessions: 0, audioSeconds: 0, estimatedCost: 0,
    byProvider: { openai: emptyProviderBucket(), gemini: emptyProviderBucket() },
    modes: {},
  };
}

/** @returns {UsageLog} */
export function emptyLog() {
  return { version: 2, daily: {}, total: emptyBucket() };
}

const finite = (v) => (Number.isFinite(v) ? v : 0);
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Add n to record[key], reading own properties only so a mode named 'constructor' counts from 0. */
function bump(record, key, n) {
  record[key] = (Object.hasOwn(record, key) ? record[key] : 0) + n;
}

/**
 * @param {unknown} value
 * @returns {Bucket}
 */
function normalizeBucket(value) {
  const src = isObject(value) ? /** @type {any} */ (value) : {};
  const bucket = emptyBucket();
  bucket.sessions = finite(src.sessions);
  bucket.audioSeconds = finite(src.audioSeconds);
  bucket.estimatedCost = finite(src.estimatedCost);
  const byProvider = isObject(src.byProvider) ? src.byProvider : {};
  for (const p of PROVIDER_KEYS) {
    const b = Object.hasOwn(byProvider, p) && isObject(byProvider[p]) ? byProvider[p] : {};
    bucket.byProvider[p] = { sessions: finite(b.sessions), audioSeconds: finite(b.audioSeconds), cost: finite(b.cost) };
  }
  if (isObject(src.modes)) {
    for (const [mode, n] of Object.entries(src.modes)) if (Number.isFinite(n)) bump(bucket.modes, mode, n);
  }
  return bucket;
}

/**
 * The one validator for stored usage data. A v2 log keeps its data with every bucket field
 * defaulted to 0 and only the openai and gemini provider buckets; anything else is an empty
 * log. Always returns a fresh object.
 * @param {unknown} value
 * @returns {UsageLog}
 */
export function normalizeLog(value) {
  if (!isObject(value) || /** @type {any} */ (value).version !== 2) return emptyLog();
  const v = /** @type {any} */ (value);
  const log = emptyLog();
  if (isObject(v.daily)) {
    for (const [day, bucket] of Object.entries(v.daily)) if (isObject(bucket)) log.daily[day] = normalizeBucket(bucket);
  }
  log.total = normalizeBucket(v.total);
  return log;
}

function addTo(bucket, entry) {
  const audioSeconds = finite(entry.audioSeconds);
  const cost = finite(entry.cost);
  bucket.sessions += 1;
  bucket.audioSeconds += audioSeconds;
  bucket.estimatedCost += cost;
  if (PROVIDER_KEYS.includes(entry.provider)) {
    const p = bucket.byProvider[entry.provider];
    p.sessions += 1;
    p.audioSeconds += audioSeconds;
    p.cost += cost;
  }
  bump(bucket.modes, String(entry.mode), 1);
}

/**
 * @param {unknown} log
 * @param {UsageEntry} entry
 * @param {Date} [now]
 * @returns {UsageLog}
 */
export function applyUsage(log, entry, now = new Date()) {
  const next = normalizeLog(log);
  const key = localDateKey(now);
  const day = Object.hasOwn(next.daily, key) ? next.daily[key] : (next.daily[key] = emptyBucket());
  addTo(day, entry);
  addTo(next.total, entry);

  const cutoffKey = localDateKey(daysAgo(now, RETENTION_DAYS));
  for (const k of Object.keys(next.daily)) if (k < cutoffKey) delete next.daily[k];
  return next;
}

function sumDays(log, keys) {
  const acc = emptyBucket();
  for (const k of keys) {
    if (!Object.hasOwn(log.daily, k)) continue;
    const d = log.daily[k];
    acc.sessions += d.sessions;
    acc.audioSeconds += d.audioSeconds;
    acc.estimatedCost += d.estimatedCost;
    for (const p of PROVIDER_KEYS) {
      acc.byProvider[p].sessions += d.byProvider[p].sessions;
      acc.byProvider[p].audioSeconds += d.byProvider[p].audioSeconds;
      acc.byProvider[p].cost += d.byProvider[p].cost;
    }
    for (const [mode, n] of Object.entries(d.modes)) bump(acc.modes, mode, n);
  }
  return acc;
}

/**
 * @param {unknown} log
 * @param {Date} [now]
 * @returns {{ today: Bucket, last7Days: Bucket, total: Bucket }}
 */
export function summarize(log, now = new Date()) {
  const src = normalizeLog(log);
  const keys = (n) => Array.from({ length: n }, (_, i) => localDateKey(daysAgo(now, i)));
  return { today: sumDays(src, keys(1)), last7Days: sumDays(src, keys(7)), total: src.total };
}
```

- [ ] **Step 4: Run the usage tests to verify they pass**

```bash
npx vitest run test/unit/background/usage.test.js
```

Expected: 19 passed.

- [ ] **Step 5: Write the failing storage tests**

Replace the whole of `test/unit/background/storage.test.js` with:

```js
import { describe, it, expect, vi } from 'vitest';
import { createStorage } from '../../../src/background/storage.js';
import { applyUsage } from '../../../src/background/usage.js';
import { freshSettings, SETTINGS_VERSION } from '../../../src/shared/defaults.js';

/** chrome.storage stand-in: values are cloned both ways, like the real structured-clone boundary. */
function fakeArea(initial = {}) {
  const store = structuredClone(initial);
  return {
    store,
    get: vi.fn(async (key) => ({ [key]: structuredClone(store[key]) })),
    set: vi.fn(async (items) => { Object.assign(store, structuredClone(items)); }),
  };
}

const entry = { provider: 'openai', audioSeconds: 10, cost: 0.001, mode: 'default' };
const now = new Date(2026, 8, 26, 12);

describe('createStorage settings', () => {
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

  it('updateSettings writes the callback result and returns it', async () => {
    const area = fakeArea({ settings: freshSettings() });
    const storage = createStorage(area);
    const result = await storage.updateSettings((current) => ({ ...current, activeMode: 'email' }));
    expect(result.activeMode).toBe('email');
    expect(result.settingsVersion).toBe(SETTINGS_VERSION);
    expect(area.store.settings.activeMode).toBe('email');
  });

  it('updateSettings writes nothing when the callback returns null', async () => {
    const area = fakeArea({ settings: freshSettings() });
    const storage = createStorage(area);
    const result = await storage.updateSettings(() => null);
    expect(result.activeMode).toBe('default');
    expect(area.set).not.toHaveBeenCalled();
  });

  it('two concurrent settings updates both land', async () => {
    const area = fakeArea({ settings: freshSettings() });
    const storage = createStorage(area);
    await Promise.all([
      storage.updateSettings((s) => ({ ...s, activeMode: 'email' })),
      storage.updateSettings((s) => ({ ...s, provider: 'gemini' })),
    ]);
    expect(area.store.settings.activeMode).toBe('email');
    expect(area.store.settings.provider).toBe('gemini');
  });
});

describe('createStorage usage', () => {
  it('replaces a v1 usage log with an empty v2 log', async () => {
    const storage = createStorage(fakeArea({ usageLog: { daily: {}, total: { sessions: 9 } } }));
    const log = await storage.getUsageLog();
    expect(log.version).toBe(2);
    expect(log.total.sessions).toBe(0);
  });

  it('normalizes a partial v2 usage log on read', async () => {
    const storage = createStorage(fakeArea({ usageLog: { version: 2, daily: { '2026-09-26': { sessions: 2 } }, total: { sessions: 2 } } }));
    const log = await storage.getUsageLog();
    expect(log.daily['2026-09-26'].estimatedCost).toBe(0);
    expect(log.daily['2026-09-26'].byProvider.openai).toEqual({ sessions: 0, audioSeconds: 0, cost: 0 });
    expect(log.total.sessions).toBe(2);
    expect(log.total.audioSeconds).toBe(0);
  });

  it('two concurrent updateUsageLog calls both land: 2 sessions', async () => {
    const area = fakeArea();
    const storage = createStorage(area);
    await Promise.all([
      storage.updateUsageLog((log) => applyUsage(log, entry, now)),
      storage.updateUsageLog((log) => applyUsage(log, entry, now)),
    ]);
    expect(area.store.usageLog.total.sessions).toBe(2);
    expect((await storage.getUsageLog()).total.sessions).toBe(2);
  });

  it('serializes usage updates with plain writes', async () => {
    const area = fakeArea();
    const storage = createStorage(area);
    const logged = storage.updateUsageLog((log) => applyUsage(log, entry, now));
    const cleared = storage.setUsageLog({ version: 2, daily: {}, total: {} });
    await Promise.all([logged, cleared]);
    expect((await storage.getUsageLog()).total.sessions).toBe(0);
  });

  it('a failed update does not block later calls', async () => {
    const storage = createStorage(fakeArea());
    await expect(storage.updateUsageLog(() => { throw new Error('boom'); })).rejects.toThrow('boom');
    const log = await storage.updateUsageLog((l) => applyUsage(l, entry, now));
    expect(log.total.sessions).toBe(1);
  });
});
```

- [ ] **Step 6: Run the storage tests to verify they fail**

```bash
npx vitest run test/unit/background/storage.test.js
```

Expected: 7 failed, 4 passed: `storage.updateSettings is not a function` (3), `storage.updateUsageLog is not a function` (3), and "normalizes a partial v2 usage log on read" (`expected undefined to be +0`).

- [ ] **Step 7: Rewrite `src/background/storage.js`**

Replace the whole file with:

```js
import { migrateSettings, SETTINGS_VERSION } from '../shared/defaults.js';
import { normalizeLog } from './usage.js';

/**
 * Settings and usage log persistence. Every call runs through one promise queue, so a
 * read-modify-write (usage logging, a settings patch) never interleaves with another write.
 * Update callbacks must be synchronous and must not call back into this storage object.
 * @param {{ get: (key: string) => Promise<Record<string, unknown>>, set: (items: Record<string, unknown>) => Promise<void> }} area
 */
export function createStorage(area) {
  let tail = Promise.resolve();

  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function enqueue(task) {
    const run = tail.then(task);
    tail = run.catch(() => {}); // a failed task must not block the ones queued after it
    return run;
  }

  /** @returns {Promise<import('../shared/defaults.js').Settings>} */
  async function readSettings() {
    const { settings } = await area.get('settings');
    const migrated = migrateSettings(settings);
    if (migrated !== settings) await area.set({ settings: migrated });
    return migrated;
  }

  /** @param {import('../shared/defaults.js').Settings} settings */
  async function writeSettings(settings) {
    const stamped = { ...settings, settingsVersion: SETTINGS_VERSION };
    await area.set({ settings: stamped });
    return stamped;
  }

  /** @returns {Promise<import('./usage.js').UsageLog>} */
  async function readUsageLog() {
    const { usageLog } = await area.get('usageLog');
    return normalizeLog(usageLog);
  }

  return {
    /** @returns {Promise<import('../shared/defaults.js').Settings>} */
    getSettings() {
      return enqueue(readSettings);
    },
    /**
     * @param {import('../shared/defaults.js').Settings} settings
     * @returns {Promise<void>}
     */
    saveSettings(settings) {
      return enqueue(async () => { await writeSettings(settings); });
    },
    /**
     * Read, transform and write the settings as one queued step. A callback result that is
     * not an object (null) writes nothing and resolves with the current settings.
     * @param {(current: import('../shared/defaults.js').Settings) => import('../shared/defaults.js').Settings|null} fn
     * @returns {Promise<import('../shared/defaults.js').Settings>}
     */
    updateSettings(fn) {
      return enqueue(async () => {
        const current = await readSettings();
        const next = fn(current);
        if (!next || typeof next !== 'object') return current;
        return writeSettings(next);
      });
    },
    /** @returns {Promise<import('./usage.js').UsageLog>} */
    getUsageLog() {
      return enqueue(readUsageLog);
    },
    /**
     * @param {import('./usage.js').UsageLog} usageLog
     * @returns {Promise<void>}
     */
    setUsageLog(usageLog) {
      return enqueue(() => area.set({ usageLog }));
    },
    /**
     * @param {(log: import('./usage.js').UsageLog) => import('./usage.js').UsageLog} fn
     * @returns {Promise<import('./usage.js').UsageLog>}
     */
    updateUsageLog(fn) {
      return enqueue(async () => {
        const next = fn(await readUsageLog());
        await area.set({ usageLog: next });
        return next;
      });
    },
  };
}
```

- [ ] **Step 8: Run the storage tests to verify they pass, then the suite**

```bash
npx vitest run test/unit/background/storage.test.js
npm test
```

Expected: 11 passed; the suite is all green (the old router still uses `getUsageLog` and `setUsageLog`, which keep their signatures). Report N/N.

- [ ] **Step 9: Commit**

```bash
git add src/background/usage.js src/background/storage.js test/unit/background/usage.test.js test/unit/background/storage.test.js
git commit -m "Normalize usage logs on read and serialize storage updates through one queue"
```

- [ ] **Step 10: Write the failing dictation tests**

Create `test/unit/background/dictate.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDictate } from '../../../src/background/dictate.js';
import { createStorage } from '../../../src/background/storage.js';
import { applyUsage } from '../../../src/background/usage.js';
import { userMessage } from '../../../src/background/router.js';
import { freshSettings } from '../../../src/shared/defaults.js';
import { ProviderError } from '../../../src/background/providers/errors.js';

const input = { audioBase64: 'QUJD', mimeType: 'audio/webm', modeKey: 'email', durationSec: 12.4 };
const result = { raw: 'raw', text: 'final', provider: 'openai', sttModel: 'gpt-transcribe', textModel: 'gpt-6-luna', audioSeconds: 12, cost: 0.0009, warning: null };

let settings, deps, dictate;
beforeEach(() => {
  settings = freshSettings();
  settings.keys.openai = 'sk-test-secret-123';
  deps = {
    storage: {
      getSettings: vi.fn(async () => settings),
      updateUsageLog: vi.fn(async (fn) => fn({ version: 2, daily: {}, total: {} })),
    },
    runDictation: vi.fn(async () => ({ ...result })),
    applyUsage: vi.fn((log, entry) => ({ ...log, lastEntry: entry })),
    userMessage,
  };
  dictate = createDictate(deps);
});
afterEach(() => vi.restoreAllMocks());

describe('createDictate', () => {
  it('runs the pipeline with fresh settings, logs usage and returns the dictation', async () => {
    const message = await dictate(input);
    expect(message).toEqual({ success: true, text: 'final', raw: 'raw', cost: 0.0009, warning: null });
    expect(deps.runDictation).toHaveBeenCalledWith({ ...input, settings });
    expect(deps.storage.updateUsageLog).toHaveBeenCalledTimes(1);
    expect(deps.applyUsage).toHaveBeenCalledWith(expect.anything(), { provider: 'openai', audioSeconds: 12, cost: 0.0009, mode: 'email' });
  });

  it('reads the settings again on every call', async () => {
    await dictate(input);
    settings = { ...settings, provider: 'gemini' };
    await dictate(input);
    expect(deps.storage.getSettings).toHaveBeenCalledTimes(2);
    expect(deps.runDictation.mock.calls[1][0].settings.provider).toBe('gemini');
  });

  it('passes the mode warning through', async () => {
    deps.runDictation.mockResolvedValueOnce({ ...result, text: 'raw', warning: 'Mode not applied: x. Raw transcript inserted.' });
    const message = await dictate(input);
    expect(message).toEqual({ success: true, text: 'raw', raw: 'raw', cost: 0.0009, warning: 'Mode not applied: x. Raw transcript inserted.' });
  });

  it('usage logging failure still succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.storage.updateUsageLog.mockRejectedValueOnce(new Error('quota'));
    const message = await dictate(input);
    expect(message).toEqual({ success: true, text: 'final', raw: 'raw', cost: 0.0009, warning: null });
    expect(warn).toHaveBeenCalledWith('VoiceType: usage logging failed', expect.any(Error));
  });

  it('maps a provider error with tone error and logs nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.runDictation.mockRejectedValueOnce(new ProviderError('No speech detected.', { code: 'empty' }));
    expect(await dictate(input)).toEqual({ success: false, error: 'No speech detected.', tone: 'error' });
    expect(deps.storage.updateUsageLog).not.toHaveBeenCalled();
  });

  it('maps a settings read failure to the generic message', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.storage.getSettings.mockRejectedValueOnce(new Error('storage down'));
    expect(await dictate(input)).toEqual({ success: false, error: 'Something went wrong. Try again.', tone: 'error' });
    expect(deps.runDictation).not.toHaveBeenCalled();
  });

  it('never writes the key to the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.runDictation.mockRejectedValueOnce(new ProviderError('Upstream echoed sk-test-secret-123 back'));
    const message = await dictate(input);
    expect(warn).toHaveBeenCalledWith('VoiceType: ProviderError: Upstream echoed [key] back');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('sk-test');
    expect(JSON.stringify(message)).not.toContain('sk-test');
  });

  it('two concurrent dictations log 2 sessions', async () => {
    const store = {};
    const area = {
      get: async (key) => ({ [key]: structuredClone(store[key]) }),
      set: async (items) => { Object.assign(store, structuredClone(items)); },
    };
    const storage = createStorage(area);
    await storage.saveSettings(settings);
    const real = createDictate({ storage, runDictation: deps.runDictation, applyUsage, userMessage });
    await Promise.all([real(input), real(input)]);
    expect((await storage.getUsageLog()).total.sessions).toBe(2);
  });
});
```

- [ ] **Step 11: Run the dictation tests to verify they fail**

```bash
npx vitest run test/unit/background/dictate.test.js
```

Expected: FAIL with `Cannot find module '../../../src/background/dictate.js'`.

- [ ] **Step 12: Export `warnFailure` and create `src/background/dictate.js`**

In `src/background/router.js`, replace

```js
function warnFailure(err) {
```

with

```js
export function warnFailure(err) {
```

Create `src/background/dictate.js`:

```js
import { redact } from './providers/errors.js';
import { warnFailure } from './router.js';

/**
 * One dictation from recorded audio to the message the tab receives. Never throws.
 * @param {{
 *   storage: Pick<ReturnType<import('./storage.js').createStorage>, 'getSettings'|'updateUsageLog'>,
 *   runDictation: typeof import('./pipeline.js').runDictation,
 *   applyUsage: typeof import('./usage.js').applyUsage,
 *   userMessage: typeof import('./router.js').userMessage,
 * }} deps
 * @returns {(input: { audioBase64: string, mimeType: string, modeKey: string, durationSec: number }) => Promise<import('../shared/messages.js').DictationMessage>}
 */
export function createDictate({ storage, runDictation, applyUsage, userMessage }) {
  return async function dictate({ audioBase64, mimeType, modeKey, durationSec }) {
    let result;
    try {
      const settings = await storage.getSettings();
      result = await runDictation({ audioBase64, mimeType, modeKey, durationSec, settings });
    } catch (err) {
      warnFailure(err);
      // The text goes to a web page: redact again in case a provider echoed a key.
      return { success: false, error: redact(userMessage(err)), tone: 'error' };
    }
    try {
      await storage.updateUsageLog((log) => applyUsage(log, {
        provider: result.provider, audioSeconds: result.audioSeconds, cost: result.cost, mode: modeKey,
      }));
    } catch (err) {
      // Logging is bookkeeping; never lose a paid transcript over it.
      console.warn('VoiceType: usage logging failed', err);
    }
    return { success: true, text: result.text, raw: result.raw, cost: result.cost, warning: result.warning ?? null };
  };
}
```

- [ ] **Step 13: Run the dictation tests to verify they pass, then the suite**

```bash
npx vitest run test/unit/background/dictate.test.js
npm test
```

Expected: 8 passed; the suite is all green. Report N/N.

- [ ] **Step 14: Commit**

```bash
git add src/background/dictate.js src/background/router.js test/unit/background/dictate.test.js
git commit -m "Add the dictation step that logs usage through the storage queue"
```

- [ ] **Step 15: Write the failing router tests**

Replace the whole of `test/unit/background/router.test.js` with:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRouter, createValidateKey, senderKind, userMessage } from '../../../src/background/router.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings, SETTINGS_VERSION } from '../../../src/shared/defaults.js';
import { emptyLog } from '../../../src/background/usage.js';
import { ProviderError } from '../../../src/background/providers/errors.js';

// identify() is injected, so test senders carry their kind directly.
const POPUP = { kind: 'extension' };
const OFFSCREEN = { kind: 'offscreen' };
const STRANGER = { kind: 'unknown' };
const CONTENT = { kind: 'content', tab: { id: 7 }, frameId: 3 };
const TOP_FRAME = { kind: 'content', tab: { id: 7 } };
const NOT_ALLOWED = { success: false, error: 'Not allowed.' };

let stored, usageLog, deps, handle;
beforeEach(() => {
  stored = freshSettings();
  stored.keys = { openai: 'sk-test-123456', gemini: '' };
  stored.modes.custom_1 = { name: 'Notes', icon: '📝', prompt: 'Bullet notes.', builtIn: false };
  usageLog = emptyLog();
  deps = {
    storage: {
      getSettings: vi.fn(async () => stored),
      updateSettings: vi.fn(async (fn) => {
        const next = fn(structuredClone(stored));
        if (next) stored = next;
        return stored;
      }),
      getUsageLog: vi.fn(async () => usageLog),
      setUsageLog: vi.fn(async (log) => { usageLog = log; }),
    },
    validateKey: vi.fn(async () => true),
    summarize: vi.fn(() => ({ today: 'today', last7Days: 'week', total: 'total' })),
    recorder: {
      start: vi.fn(async () => ({ ok: true })),
      stop: vi.fn(async () => ({ ok: true })),
      cancel: vi.fn(async () => ({ ok: true })),
      onLevel: vi.fn(),
      onDone: vi.fn(async () => {}),
      onOffscreenError: vi.fn(async () => {}),
      onPermissionResult: vi.fn(async () => {}),
    },
    identify: vi.fn((sender) => sender?.kind ?? 'unknown'),
  };
  handle = createRouter(deps);
});
afterEach(() => vi.restoreAllMocks());

describe('senderKind', () => {
  const ids = { extensionId: 'abc', extensionOrigin: 'chrome-extension://abc', offscreenUrl: 'chrome-extension://abc/offscreen.html' };
  const rows = [
    ['offscreen document', { id: 'abc', origin: 'chrome-extension://abc', url: 'chrome-extension://abc/offscreen.html' }, 'offscreen'],
    ['offscreen document with a query', { id: 'abc', origin: 'chrome-extension://abc', url: 'chrome-extension://abc/offscreen.html?x=1' }, 'offscreen'],
    ['popup', { id: 'abc', origin: 'chrome-extension://abc', url: 'chrome-extension://abc/popup.html' }, 'extension'],
    ['permission page in a tab', { id: 'abc', origin: 'chrome-extension://abc', url: 'chrome-extension://abc/permission.html', tab: { id: 4 } }, 'extension'],
    ['extension page without a url', { id: 'abc', origin: 'chrome-extension://abc' }, 'extension'],
    ['content script', { id: 'abc', origin: 'https://example.com', url: 'https://example.com/', tab: { id: 4 }, frameId: 0 }, 'content'],
    ['content script in an opaque-origin frame', { id: 'abc', origin: 'null', tab: { id: 4 }, frameId: 2 }, 'content'],
    ['another extension', { id: 'evil', origin: 'chrome-extension://abc', url: 'chrome-extension://abc/offscreen.html' }, 'unknown'],
    ['another extension in a tab', { id: 'evil', origin: 'https://example.com', tab: { id: 4 } }, 'unknown'],
    ['page origin without a tab', { id: 'abc', origin: 'https://example.com' }, 'unknown'],
    ['tab without a numeric id', { id: 'abc', origin: 'https://example.com', tab: { id: '4' } }, 'unknown'],
    ['missing sender', undefined, 'unknown'],
  ];
  for (const [name, sender, kind] of rows) {
    it(`${name} is ${kind}`, () => {
      expect(senderKind(sender, ids)).toBe(kind);
    });
  }
});

describe('router access', () => {
  it('content cannot SAVE_SETTINGS, VALIDATE_KEY or CLEAR_USAGE', async () => {
    expect(await handle({ action: MSG.SAVE_SETTINGS, settings: { provider: 'gemini' } }, CONTENT)).toEqual(NOT_ALLOWED);
    expect(await handle({ action: MSG.VALIDATE_KEY, provider: 'openai', key: 'sk-x' }, CONTENT)).toEqual(NOT_ALLOWED);
    expect(await handle({ action: MSG.CLEAR_USAGE }, CONTENT)).toEqual(NOT_ALLOWED);
    expect(deps.storage.updateSettings).not.toHaveBeenCalled();
    expect(deps.validateKey).not.toHaveBeenCalled();
    expect(deps.storage.setUsageLog).not.toHaveBeenCalled();
    expect(deps.identify).toHaveBeenCalledWith(CONTENT);
  });

  it('content gets no keys from GET_SETTINGS; the popup gets them', async () => {
    const pub = await handle({ action: MSG.GET_SETTINGS }, CONTENT);
    expect(pub).not.toHaveProperty('keys');
    expect(pub.hasKey).toEqual({ openai: true, gemini: false });
    expect(pub.modes.custom_1.name).toBe('Notes');
    expect(JSON.stringify(pub)).not.toContain('sk-test');
    const full = await handle({ action: MSG.GET_SETTINGS }, POPUP);
    expect(full.keys.openai).toBe('sk-test-123456');
  });

  it('offscreen actions only from offscreen', async () => {
    for (const sender of [CONTENT, POPUP, STRANGER]) {
      expect(await handle({ action: MSG.OFFSCREEN_LEVEL, level: 0.5 }, sender)).toEqual(NOT_ALLOWED);
      expect(await handle({ action: MSG.OFFSCREEN_DONE, audioBase64: 'QUJD', mimeType: 'audio/webm', durationSec: 2, reason: 'user' }, sender)).toEqual(NOT_ALLOWED);
      expect(await handle({ action: MSG.OFFSCREEN_ERROR, error: 'x' }, sender)).toEqual(NOT_ALLOWED);
    }
    expect(deps.recorder.onLevel).not.toHaveBeenCalled();
    expect(deps.recorder.onDone).not.toHaveBeenCalled();
    expect(deps.recorder.onOffscreenError).not.toHaveBeenCalled();
  });

  it('recording actions only from content', async () => {
    for (const sender of [POPUP, OFFSCREEN, STRANGER]) {
      expect(await handle({ action: MSG.START_RECORDING }, sender)).toEqual(NOT_ALLOWED);
      expect(await handle({ action: MSG.STOP_RECORDING }, sender)).toEqual(NOT_ALLOWED);
      expect(await handle({ action: MSG.CANCEL_RECORDING }, sender)).toEqual(NOT_ALLOWED);
    }
    expect(deps.recorder.start).not.toHaveBeenCalled();
    expect(deps.recorder.stop).not.toHaveBeenCalled();
    expect(deps.recorder.cancel).not.toHaveBeenCalled();
  });

  it('PERMISSION_RESULT only from extension pages', async () => {
    expect(await handle({ action: MSG.PERMISSION_RESULT, granted: true }, CONTENT)).toEqual(NOT_ALLOWED);
    expect(await handle({ action: MSG.PERMISSION_RESULT, granted: true }, OFFSCREEN)).toEqual(NOT_ALLOWED);
    expect(deps.recorder.onPermissionResult).not.toHaveBeenCalled();
  });

  it('the offscreen document and unknown senders get no settings or usage', async () => {
    for (const sender of [OFFSCREEN, STRANGER]) {
      expect(await handle({ action: MSG.GET_SETTINGS }, sender)).toEqual(NOT_ALLOWED);
      expect(await handle({ action: MSG.UPDATE_SETTINGS, patch: { activeMode: 'email' } }, sender)).toEqual(NOT_ALLOWED);
      expect(await handle({ action: MSG.GET_USAGE }, sender)).toEqual(NOT_ALLOWED);
    }
    expect(deps.storage.getSettings).not.toHaveBeenCalled();
  });

  it('returns undefined for unknown actions, including inherited names', async () => {
    expect(await handle({ action: 'nope' }, POPUP)).toBeUndefined();
    expect(await handle({ action: 'constructor' }, POPUP)).toBeUndefined();
    expect(await handle({ action: 'transcribe' }, CONTENT)).toBeUndefined(); // removed v2.0 actions
    expect(await handle({ action: 'checkApiKey' }, CONTENT)).toBeUndefined();
    expect(await handle(undefined, POPUP)).toBeUndefined();
  });
});

describe('settings', () => {
  it('SAVE_SETTINGS { provider: gemini } keeps custom modes and both keys', async () => {
    stored.keys.gemini = 'AQ.gem-key';
    expect(await handle({ action: MSG.SAVE_SETTINGS, settings: { provider: 'gemini' } }, POPUP)).toEqual({ success: true });
    expect(stored.provider).toBe('gemini');
    expect(stored.modes.custom_1).toEqual({ name: 'Notes', icon: '📝', prompt: 'Bullet notes.', builtIn: false });
    expect(stored.keys).toEqual({ openai: 'sk-test-123456', gemini: 'AQ.gem-key' });
  });

  it('SAVE_SETTINGS merges string keys, so the popup can clear one', async () => {
    stored.keys.gemini = 'AQ.gem-key';
    await handle({ action: MSG.SAVE_SETTINGS, settings: { keys: { openai: '' } } }, POPUP);
    expect(stored.keys).toEqual({ openai: '', gemini: 'AQ.gem-key' });
    await handle({ action: MSG.SAVE_SETTINGS, settings: { keys: { openai: 42, gemini: null } } }, POPUP);
    expect(stored.keys).toEqual({ openai: '', gemini: 'AQ.gem-key' });
  });

  it('SAVE_SETTINGS runs migrateSettings over the merge and never the v1 path', async () => {
    await handle({ action: MSG.SAVE_SETTINGS, settings: { settingsVersion: 1, activeMode: 'missing' } }, POPUP);
    expect(stored.settingsVersion).toBe(SETTINGS_VERSION);
    expect(stored.activeMode).toBe('default');
    expect(stored.keys.openai).toBe('sk-test-123456');
  });

  it('SAVE_SETTINGS rejects a missing or non-object payload without touching storage', async () => {
    for (const settings of [undefined, null, [], 'x']) {
      expect(await handle({ action: MSG.SAVE_SETTINGS, settings }, POPUP)).toEqual({ success: false, error: 'Invalid settings.' });
    }
    expect(deps.storage.updateSettings).not.toHaveBeenCalled();
  });

  it('UPDATE_SETTINGS applies whitelisted fields from content', async () => {
    expect(await handle({ action: MSG.UPDATE_SETTINGS, patch: { activeMode: 'custom_1', translateTargetLang: 'Greek' } }, CONTENT)).toEqual({ success: true });
    expect(stored.activeMode).toBe('custom_1');
    expect(stored.translateTargetLang).toBe('Greek');
    expect(stored.keys.openai).toBe('sk-test-123456');
    expect(await handle({ action: MSG.UPDATE_SETTINGS, patch: { provider: 'gemini' } }, POPUP)).toEqual({ success: true });
    expect(stored.provider).toBe('gemini');
  });

  it('UPDATE_SETTINGS rejects anything outside the whitelist and writes nothing', async () => {
    const before = stored;
    expect(await handle({ action: MSG.UPDATE_SETTINGS, patch: { keys: { openai: 'sk-evil' } } }, CONTENT)).toEqual({ success: false, error: 'Invalid settings.' });
    expect(await handle({ action: MSG.UPDATE_SETTINGS, patch: { activeMode: 'email', modes: {} } }, CONTENT)).toEqual({ success: false, error: 'Invalid settings.' });
    expect(await handle({ action: MSG.UPDATE_SETTINGS, patch: null }, CONTENT)).toEqual({ success: false, error: 'Invalid settings.' });
    const unknownMode = await handle({ action: MSG.UPDATE_SETTINGS, patch: { activeMode: 'missing' } }, CONTENT);
    expect(unknownMode.success).toBe(false);
    expect(typeof unknownMode.error).toBe('string');
    expect(stored).toBe(before);
  });
});

describe('keys and usage', () => {
  it('validates a key and maps failures to friendly text', async () => {
    expect(await handle({ action: MSG.VALIDATE_KEY, provider: 'openai', key: 'sk-x' }, POPUP)).toEqual({ ok: true });
    expect(deps.validateKey).toHaveBeenCalledWith('openai', 'sk-x');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.validateKey.mockRejectedValueOnce(new ProviderError('OpenAI rejected the API key.', { code: 'auth' }));
    expect(await handle({ action: MSG.VALIDATE_KEY, provider: 'openai', key: 'sk-bad' }, POPUP)).toEqual({ ok: false, error: 'OpenAI rejected the API key.' });
  });

  it('warns about a failed key check with any key redacted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.validateKey.mockRejectedValueOnce(new ProviderError('Upstream echoed sk-abc123456 back'));
    await handle({ action: MSG.VALIDATE_KEY, provider: 'openai', key: 'sk-abc123456' }, POPUP);
    expect(warn).toHaveBeenCalledWith('VoiceType: ProviderError: Upstream echoed [key] back');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('sk-abc');
  });

  it('reports a key check timeout as a key check timeout', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    deps.validateKey.mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'));
    expect(await handle({ action: MSG.VALIDATE_KEY, provider: 'gemini', key: 'AQ.x' }, POPUP)).toEqual({ ok: false, error: 'Key check timed out. Try again.' });
    deps.validateKey.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    expect(await handle({ action: MSG.VALIDATE_KEY, provider: 'gemini', key: 'AQ.x' }, POPUP)).toEqual({ ok: false, error: 'Key check timed out. Try again.' });
  });

  it('GET_USAGE returns the summary of the stored log to the popup and content', async () => {
    usageLog.total.sessions = 3;
    expect(await handle({ action: MSG.GET_USAGE }, POPUP)).toEqual({ today: 'today', last7Days: 'week', total: 'total' });
    expect(deps.summarize).toHaveBeenCalledWith(usageLog);
    expect(await handle({ action: MSG.GET_USAGE }, CONTENT)).toEqual({ today: 'today', last7Days: 'week', total: 'total' });
  });

  it('CLEAR_USAGE writes an empty log', async () => {
    usageLog.total.sessions = 3;
    expect(await handle({ action: MSG.CLEAR_USAGE }, POPUP)).toEqual({ success: true });
    expect(deps.storage.setUsageLog).toHaveBeenCalledTimes(1);
    expect(usageLog).toEqual(emptyLog());
  });
});

describe('recorder delegation', () => {
  it('recording actions go to the recorder with the sender frame as the endpoint', async () => {
    deps.recorder.start.mockResolvedValueOnce({ ok: false, reason: 'busy', error: 'VoiceType is busy in another tab. Try again in a moment.' });
    expect(await handle({ action: MSG.START_RECORDING }, CONTENT)).toEqual({ ok: false, reason: 'busy', error: 'VoiceType is busy in another tab. Try again in a moment.' });
    expect(deps.recorder.start).toHaveBeenCalledWith({ tabId: 7, frameId: 3 });
    expect(await handle({ action: MSG.STOP_RECORDING }, TOP_FRAME)).toEqual({ ok: true });
    expect(deps.recorder.stop).toHaveBeenCalledWith({ tabId: 7, frameId: 0 });
    expect(await handle({ action: MSG.CANCEL_RECORDING }, CONTENT)).toEqual({ ok: true });
    expect(deps.recorder.cancel).toHaveBeenCalledWith({ tabId: 7, frameId: 3 });
  });

  it('offscreen events go to the recorder and are acknowledged', async () => {
    expect(await handle({ action: MSG.OFFSCREEN_LEVEL, level: 0.5 }, OFFSCREEN)).toEqual({ ok: true });
    expect(deps.recorder.onLevel).toHaveBeenCalledWith(0.5);
    const done = { audioBase64: 'QUJD', mimeType: 'audio/webm', durationSec: 2.5, reason: 'silence' };
    expect(await handle({ action: MSG.OFFSCREEN_DONE, ...done }, OFFSCREEN)).toEqual({ ok: true });
    expect(deps.recorder.onDone).toHaveBeenCalledWith(done);
    expect(await handle({ action: MSG.OFFSCREEN_ERROR, error: 'Recording failed.' }, OFFSCREEN)).toEqual({ ok: true });
    expect(deps.recorder.onOffscreenError).toHaveBeenCalledWith({ error: 'Recording failed.' });
  });

  it('the permission page result goes to the recorder as a boolean', async () => {
    expect(await handle({ action: MSG.PERMISSION_RESULT, granted: true }, POPUP)).toEqual({ ok: true });
    expect(deps.recorder.onPermissionResult).toHaveBeenLastCalledWith({ granted: true });
    await handle({ action: MSG.PERMISSION_RESULT, granted: 'yes' }, POPUP);
    expect(deps.recorder.onPermissionResult).toHaveBeenLastCalledWith({ granted: false });
  });
});

describe('createValidateKey', () => {
  it('calls the provider adapter with the key and a timeout signal', async () => {
    const adapters = { openai: { validateKey: vi.fn(async () => true) }, gemini: { validateKey: vi.fn() } };
    await createValidateKey(adapters)('openai', 'sk-x');
    expect(adapters.openai.validateKey).toHaveBeenCalledWith({ key: 'sk-x', signal: expect.any(AbortSignal) });
    expect(adapters.gemini.validateKey).not.toHaveBeenCalled();
  });

  it('rejects inherited names such as constructor without calling an adapter', async () => {
    const adapters = { openai: { validateKey: vi.fn() }, gemini: { validateKey: vi.fn() } };
    const validate = createValidateKey(adapters);
    await expect(validate('constructor', 'k')).rejects.toThrow('Unknown provider.');
    await expect(validate('__proto__', 'k')).rejects.toBeInstanceOf(ProviderError);
    expect(adapters.openai.validateKey).not.toHaveBeenCalled();
  });
});

describe('userMessage', () => {
  it('maps timeouts, provider errors, network errors and the rest', () => {
    expect(userMessage(new DOMException('x', 'TimeoutError'))).toBe('Request timed out. Try a shorter recording.');
    expect(userMessage(new ProviderError('Gemini rejected the API key.'))).toBe('Gemini rejected the API key.');
    expect(userMessage(new TypeError('fetch failed'))).toBe('Network error. Check your connection.');
    expect(userMessage(new TypeError('Failed to fetch'))).toBe('Network error. Check your connection.');
    expect(userMessage(new TypeError('x is not a function'))).toBe('Something went wrong. Try again.');
    expect(userMessage(new Error('boom'))).toBe('Something went wrong. Try again.');
    expect(userMessage('weird')).toBe('Something went wrong. Try again.');
  });

  it('words timeouts for the key check context', () => {
    expect(userMessage(new DOMException('x', 'TimeoutError'), { context: 'validate' })).toBe('Key check timed out. Try again.');
    expect(userMessage(new ProviderError('OpenAI rejected the API key.'), { context: 'validate' })).toBe('OpenAI rejected the API key.');
  });
});
```

- [ ] **Step 16: Run the router tests to verify they fail**

```bash
npx vitest run test/unit/background/router.test.js
```

Expected: 29 failed, 8 passed. Among the failures: `TypeError: senderKind is not a function`, `TypeError: createValidateKey is not a function`, `storage.saveSettings is not a function` (the fake storage no longer has it), and access-table assertions such as `expected { settingsVersion: 2, ... } to not have property "keys"`.

- [ ] **Step 17: Rewrite `src/background/router.js`**

Replace the whole file with:

```js
import { MSG } from '../shared/messages.js';
import { applySettingsPatch, migrateSettings, toPublicSettings, SETTINGS_VERSION } from '../shared/defaults.js';
import { PROVIDERS } from '../shared/models.js';
import { emptyLog } from './usage.js';
import { ProviderError, redact } from './providers/errors.js';

/**
 * @typedef {'offscreen'|'extension'|'content'|'unknown'} SenderKind
 * @typedef {{ tabId: number, frameId: number }} Endpoint
 * @typedef {{
 *   start: (endpoint: Endpoint) => Promise<import('../shared/messages.js').StartResponse>,
 *   stop: (endpoint: Endpoint) => Promise<{ ok: boolean }>,
 *   cancel: (endpoint: Endpoint) => Promise<{ ok: boolean }>,
 *   onLevel: (level: number) => void,
 *   onDone: (payload: import('../shared/messages.js').OffscreenDone) => Promise<void>,
 *   onOffscreenError: (payload: { error: string }) => Promise<void>,
 *   onPermissionResult: (payload: { granted: boolean }) => Promise<void>,
 * }} RecorderPort
 */

/**
 * Turn any thrown value into text safe to show on a web page.
 * @param {unknown} err
 * @param {{ context?: 'validate' }} [options] 'validate' words timeouts for the popup key check.
 */
export function userMessage(err, { context } = {}) {
  if (err && typeof err === 'object') {
    const e = /** @type {{ name?: string, message?: string }} */ (err);
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return context === 'validate' ? 'Key check timed out. Try again.' : 'Request timed out. Try a shorter recording.';
    }
    if (e.name === 'ProviderError') return String(e.message);
    // fetch() rejects with a TypeError on network failure; other TypeErrors are bugs.
    if (err instanceof TypeError && /fetch|network/i.test(err.message)) return 'Network error. Check your connection.';
  }
  return 'Something went wrong. Try again.';
}

/**
 * Log a failure for debugging without ever writing a key to the console.
 * @param {unknown} err
 */
export function warnFailure(err) {
  const e = /** @type {{ name?: string, message?: string }} */ (err);
  console.warn('VoiceType: ' + redact(e?.name + ': ' + e?.message));
}

/**
 * Classify a runtime.onMessage sender. Content scripts report the page's origin, so only the
 * extension's own origin marks a trusted page; sender.tab alone proves nothing (the permission
 * page runs in a tab).
 * @param {chrome.runtime.MessageSender|undefined} sender
 * @param {{ extensionId: string, extensionOrigin: string, offscreenUrl: string }} ids
 * @returns {SenderKind}
 */
export function senderKind(sender, { extensionId, extensionOrigin, offscreenUrl }) {
  if (!sender || sender.id !== extensionId) return 'unknown';
  if (sender.origin === extensionOrigin) {
    return typeof sender.url === 'string' && sender.url.startsWith(offscreenUrl) ? 'offscreen' : 'extension';
  }
  return typeof sender.tab?.id === 'number' ? 'content' : 'unknown';
}

/**
 * Key check with an own-property provider lookup, so 'constructor' is an unknown provider.
 * @param {Record<string, { validateKey: (args: { key: string, signal: AbortSignal }) => Promise<boolean> }>} adapters
 * @param {{ timeoutMs?: number }} [options]
 * @returns {(provider: string, key: string) => Promise<boolean>}
 */
export function createValidateKey(adapters, { timeoutMs = 15_000 } = {}) {
  return async (provider, key) => {
    if (typeof provider !== 'string' || !Object.hasOwn(adapters, provider)) {
      throw new ProviderError('Unknown provider.', { code: 'bad_request' });
    }
    return adapters[provider].validateKey({ key, signal: AbortSignal.timeout(timeoutMs) });
  };
}

/** Who may send each request (the Message contract). Anything else is not a router action. */
const ACCESS = new Map([
  [MSG.GET_SETTINGS, ['extension', 'content']],
  [MSG.SAVE_SETTINGS, ['extension']],
  [MSG.UPDATE_SETTINGS, ['extension', 'content']],
  [MSG.VALIDATE_KEY, ['extension']],
  [MSG.GET_USAGE, ['extension', 'content']],
  [MSG.CLEAR_USAGE, ['extension']],
  [MSG.START_RECORDING, ['content']],
  [MSG.STOP_RECORDING, ['content']],
  [MSG.CANCEL_RECORDING, ['content']],
  [MSG.OFFSCREEN_LEVEL, ['offscreen']],
  [MSG.OFFSCREEN_DONE, ['offscreen']],
  [MSG.OFFSCREEN_ERROR, ['offscreen']],
  [MSG.PERMISSION_RESULT, ['extension']],
]);

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** String keys for known providers only; anything else leaves the stored key alone. */
function pickKeys(keys) {
  const out = {};
  if (!isPlainObject(keys)) return out;
  for (const id of Object.keys(PROVIDERS)) if (Object.hasOwn(keys, id) && typeof keys[id] === 'string') out[id] = keys[id];
  return out;
}

/**
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Endpoint}
 */
function endpointOf(sender) {
  return { tabId: sender.tab.id, frameId: sender.frameId ?? 0 };
}

/**
 * @param {{
 *   storage: ReturnType<import('./storage.js').createStorage>,
 *   validateKey: (provider: string, key: string) => Promise<boolean>,
 *   summarize: typeof import('./usage.js').summarize,
 *   recorder: RecorderPort,
 *   identify: (sender: chrome.runtime.MessageSender|undefined) => SenderKind,
 * }} deps
 * @returns {(request: any, sender: chrome.runtime.MessageSender|undefined) => Promise<any>}
 */
export function createRouter({ storage, validateKey, summarize, recorder, identify }) {
  return async function handle(request, sender) {
    const action = request?.action;
    const allowed = ACCESS.get(action);
    if (!allowed) return undefined;
    const kind = identify(sender);
    if (!allowed.includes(kind)) return { success: false, error: 'Not allowed.' };

    switch (action) {
      case MSG.GET_SETTINGS: {
        const settings = await storage.getSettings();
        return kind === 'extension' ? settings : toPublicSettings(settings);
      }

      case MSG.SAVE_SETTINGS: {
        const next = request.settings;
        if (!isPlainObject(next)) return { success: false, error: 'Invalid settings.' };
        // Merge so a partial payload never drops custom modes or a key the popup did not send.
        await storage.updateSettings((current) => migrateSettings({
          ...current,
          ...next,
          settingsVersion: SETTINGS_VERSION,
          keys: { ...current.keys, ...pickKeys(next.keys) },
        }));
        return { success: true };
      }

      case MSG.UPDATE_SETTINGS: {
        let error = null;
        await storage.updateSettings((current) => {
          const result = applySettingsPatch(current, request.patch);
          if (result.ok) return result.settings;
          error = result.error;
          return null;
        });
        return error === null ? { success: true } : { success: false, error };
      }

      case MSG.VALIDATE_KEY:
        try {
          await validateKey(request.provider, request.key);
          return { ok: true };
        } catch (err) {
          warnFailure(err);
          return { ok: false, error: userMessage(err, { context: 'validate' }) };
        }

      case MSG.GET_USAGE:
        return summarize(await storage.getUsageLog());

      case MSG.CLEAR_USAGE:
        await storage.setUsageLog(emptyLog());
        return { success: true };

      case MSG.START_RECORDING:
        return recorder.start(endpointOf(sender));

      case MSG.STOP_RECORDING:
        return recorder.stop(endpointOf(sender));

      case MSG.CANCEL_RECORDING:
        return recorder.cancel(endpointOf(sender));

      case MSG.OFFSCREEN_LEVEL:
        recorder.onLevel(Number(request.level));
        return { ok: true };

      case MSG.OFFSCREEN_DONE: {
        const { audioBase64, mimeType, durationSec, reason } = request;
        await recorder.onDone({ audioBase64, mimeType, durationSec, reason });
        return { ok: true };
      }

      case MSG.OFFSCREEN_ERROR:
        await recorder.onOffscreenError({ error: request.error });
        return { ok: true };

      case MSG.PERMISSION_RESULT:
        await recorder.onPermissionResult({ granted: request.granted === true });
        return { ok: true };

      default:
        return undefined;
    }
  };
}
```

- [ ] **Step 18: Run the router and dictation tests to verify they pass**

```bash
npx vitest run test/unit/background/router.test.js test/unit/background/dictate.test.js
```

Expected: 45 passed (37 router, 8 dictation).

- [ ] **Step 19: Write the failing tab helper tests**

Create `test/unit/background/tabs.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { broadcast } from '../../../src/background/tabs.js';

describe('broadcast', () => {
  it('sends the message to every tab with an id, all frames', async () => {
    const tabsApi = {
      query: vi.fn(async () => [{ id: 1 }, { id: 2 }, {}]),
      sendMessage: vi.fn(async () => undefined),
    };
    const message = { action: 'settingsChanged', settings: { provider: 'openai' } };
    await broadcast(tabsApi, message);
    expect(tabsApi.query).toHaveBeenCalledWith({});
    expect(tabsApi.sendMessage.mock.calls).toEqual([[1, message], [2, message]]);
  });

  it('a tab without a receiver does not stop the others', async () => {
    const tabsApi = {
      query: vi.fn(async () => [{ id: 1 }, { id: 2 }]),
      sendMessage: vi.fn(async (id) => { if (id === 1) throw new Error('Could not establish connection. Receiving end does not exist.'); }),
    };
    await expect(broadcast(tabsApi, { action: 'x' })).resolves.toBeUndefined();
    expect(tabsApi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('resolves when the tab query fails', async () => {
    const tabsApi = { query: vi.fn(async () => { throw new Error('no'); }), sendMessage: vi.fn() };
    await expect(broadcast(tabsApi, { action: 'x' })).resolves.toBeUndefined();
    expect(tabsApi.sendMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 20: Run the tab helper tests to verify they fail**

```bash
npx vitest run test/unit/background/tabs.test.js
```

Expected: FAIL with `Cannot find module '../../../src/background/tabs.js'`.

- [ ] **Step 21: Create `src/background/tabs.js`**

```js
// Service worker helpers for talking to tabs. The chrome.tabs API is passed in so they stay testable.

/**
 * Send a message to every frame of every tab. Tabs without a receiver are skipped; never rejects.
 * @param {{ query: (info: object) => Promise<Array<{ id?: number }>>, sendMessage: (tabId: number, message: unknown) => Promise<unknown> }} tabsApi
 * @param {unknown} message
 * @returns {Promise<void>}
 */
export async function broadcast(tabsApi, message) {
  let tabs;
  try {
    tabs = await tabsApi.query({});
  } catch {
    return;
  }
  const ids = tabs.map((tab) => tab.id).filter((id) => typeof id === 'number');
  await Promise.all(ids.map((id) => tabsApi.sendMessage(id, message).catch(() => {})));
}
```

- [ ] **Step 22: Run the tab helper tests to verify they pass**

```bash
npx vitest run test/unit/background/tabs.test.js
```

Expected: 3 passed.

- [ ] **Step 23: Write the failing service worker entry tests**

Create `test/unit/background/index.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings } from '../../../src/shared/defaults.js';

/** Minimal chrome stand-in: records listeners and keeps storage.local in memory. */
function fakeChrome({ accessLevel = true } = {}) {
  const listeners = {};
  const on = (name) => ({ addListener: vi.fn((fn) => { listeners[name] = fn; }) });
  const store = {};
  const chrome = {
    runtime: {
      id: 'abc',
      getURL: (path) => `chrome-extension://abc/${path.replace(/^\//, '')}`,
      onMessage: on('message'),
      onInstalled: on('installed'),
      onStartup: on('startup'),
    },
    commands: { onCommand: on('command') },
    storage: {
      local: {
        get: vi.fn(async (key) => ({ [key]: structuredClone(store[key]) })),
        set: vi.fn(async (items) => { Object.assign(store, structuredClone(items)); }),
        setAccessLevel: accessLevel ? vi.fn(async () => {}) : undefined,
      },
      onChanged: on('storageChanged'),
    },
    tabs: { query: vi.fn(async () => [{ id: 1 }, { id: 2 }]), sendMessage: vi.fn(async () => undefined) },
    scripting: { executeScript: vi.fn(async () => []), insertCSS: vi.fn(async () => {}) },
  };
  return { chrome, listeners, store };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const PAGE = { id: 'abc', origin: 'https://example.com', url: 'https://example.com/', tab: { id: 1 }, frameId: 0 };
const POPUP = { id: 'abc', origin: 'chrome-extension://abc', url: 'chrome-extension://abc/popup.html' };

async function load(options) {
  const fake = fakeChrome(options);
  vi.stubGlobal('chrome', fake.chrome);
  vi.resetModules();
  await import('../../../src/background/index.js');
  return fake;
}

/** Call the onMessage listener the way Chrome does and wait for the async response. */
async function send(listeners, request, sender) {
  const sendResponse = vi.fn();
  expect(listeners.message(request, sender, sendResponse)).toBe(true);
  await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
  return sendResponse.mock.calls[0][0];
}

let fake;
beforeEach(async () => { fake = await load(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('service worker entry', () => {
  it('restricts storage.local to trusted contexts at load', () => {
    expect(fake.chrome.storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  });

  it('only warns when setAccessLevel is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await load({ accessLevel: false });
    await flush();
    expect(warn).toHaveBeenCalledWith('VoiceType: could not restrict storage access', expect.any(TypeError));
  });

  it('pushes key-free settings to every tab when settings change', async () => {
    const settings = freshSettings();
    settings.keys.openai = 'sk-secret-123456';
    fake.listeners.storageChanged({ settings: { newValue: settings } }, 'local');
    await flush();
    expect(fake.chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    const [tabId, message] = fake.chrome.tabs.sendMessage.mock.calls[0];
    expect(tabId).toBe(1);
    expect(message.action).toBe(MSG.SETTINGS_CHANGED);
    expect(message.settings).not.toHaveProperty('keys');
    expect(message.settings.hasKey).toEqual({ openai: true, gemini: false });
    expect(JSON.stringify(fake.chrome.tabs.sendMessage.mock.calls)).not.toContain('sk-secret');
  });

  it('ignores removed settings, usage writes and other areas', async () => {
    fake.listeners.storageChanged({ settings: { oldValue: freshSettings() } }, 'local');
    fake.listeners.storageChanged({ usageLog: { newValue: { version: 2 } } }, 'local');
    fake.listeners.storageChanged({ settings: { newValue: freshSettings() } }, 'sync');
    await flush();
    expect(fake.chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('routes messages with the real sender: pages get public settings, the popup gets keys', async () => {
    fake.store.settings = { ...freshSettings(), keys: { openai: 'sk-secret-123456', gemini: '' } };
    const pub = await send(fake.listeners, { action: MSG.GET_SETTINGS }, PAGE);
    expect(pub).not.toHaveProperty('keys');
    const full = await send(fake.listeners, { action: MSG.GET_SETTINGS }, POPUP);
    expect(full.keys.openai).toBe('sk-secret-123456');
    expect(await send(fake.listeners, { action: MSG.SAVE_SETTINGS, settings: {} }, PAGE)).toEqual({ success: false, error: 'Not allowed.' });
    expect(await send(fake.listeners, { action: 'nope' }, POPUP)).toEqual({ success: false, error: 'Unknown action' });
  });
});
```

- [ ] **Step 24: Run the entry tests to verify they fail**

```bash
npx vitest run test/unit/background/index.test.js
```

Expected: 5 failed: `setAccessLevel` not called, no warning, `fake.listeners.storageChanged is not a function` (2), and the popup sender not receiving keys (`TypeError: Cannot read properties of undefined (reading 'openai')`, because the old entry passes no `identify`).

- [ ] **Step 25: Rewrite `src/background/index.js`**

Replace the whole file with (the `chrome.commands` listener and `toggleActiveTab` stay until Task 6; recording requests fail cleanly through the stub until then):

```js
// VoiceType service worker. Listeners and wiring only; logic lives in the imported modules.
import { MSG } from '../shared/messages.js';
import { migrateSettings, toPublicSettings } from '../shared/defaults.js';
import { createStorage } from './storage.js';
import { createRouter, createValidateKey, senderKind, userMessage } from './router.js';
import { ADAPTERS } from './pipeline.js';
import { summarize } from './usage.js';
import { broadcast } from './tabs.js';

// Keys live in storage.local; only the service worker and extension pages may read it.
(async () => {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch (err) {
    console.warn('VoiceType: could not restrict storage access', err);
  }
})();

const storage = createStorage(chrome.storage.local);

// Recording moves to the offscreen recorder; until it is wired every recording request fails cleanly.
const unavailable = async () => ({ ok: false, reason: 'micError', error: 'Recording is not available yet.' });
const recorder = {
  start: unavailable, stop: unavailable, cancel: unavailable, onLevel: unavailable,
  onDone: unavailable, onOffscreenError: unavailable, onPermissionResult: unavailable, onTabRemoved: unavailable,
};

// Built from the id: URL parsers outside Chrome give chrome-extension: URLs an opaque 'null' origin,
// which content scripts in sandboxed frames also report.
const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
const offscreenUrl = chrome.runtime.getURL('offscreen.html');
const handle = createRouter({
  storage,
  validateKey: createValidateKey(ADAPTERS),
  summarize,
  recorder,
  identify: (sender) => senderKind(sender, { extensionId: chrome.runtime.id, extensionOrigin, offscreenUrl }),
});

/** Send toggle to the active tab, injecting the content script if it is not there. */
async function toggleActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return false;
  try {
    // Always ask first: tab.url can be missing without a host permission for the page.
    await chrome.tabs.sendMessage(tab.id, { action: MSG.TOGGLE_RECORDING });
  } catch {
    // No content script answered. Inject only into pages content scripts can run on.
    if (!/^(https?|file):/.test(tab.url || '')) return false;
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

chrome.runtime.onInstalled.addListener(() => { storage.getSettings().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { storage.getSettings().catch(() => {}); });

chrome.commands.onCommand.addListener((command) => {
  if (command === MSG.TOGGLE_RECORDING) toggleActiveTab().catch(() => {});
});

// Content scripts cannot read storage any more, so push key-free settings to every frame.
chrome.storage.onChanged.addListener((changes, areaName) => {
  const next = changes.settings?.newValue;
  if (areaName !== 'local' || !next || typeof next !== 'object') return;
  broadcast(chrome.tabs, { action: MSG.SETTINGS_CHANGED, settings: toPublicSettings(migrateSettings(next)) });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handle(request, sender).then(
    (response) => sendResponse(response ?? { success: false, error: 'Unknown action' }),
    (err) => sendResponse({ success: false, error: userMessage(err) }),
  );
  return true; // keep the channel open for the async response
});
```

- [ ] **Step 26: Run the entry tests to verify they pass**

```bash
npx vitest run test/unit/background/index.test.js
```

Expected: 5 passed.

- [ ] **Step 27: Run the full suite and the build**

```bash
npm test
npm run build
```

Expected: all green (report N/N); the build writes `dist/background.js` without errors. In-browser dictation stays broken until Task 11 (the v2.0 content script still sends the removed legacy actions and `SAVE_SETTINGS`, which content may no longer send).

- [ ] **Step 28: Commit**

```bash
git add src/background/router.js src/background/tabs.js src/background/index.js test/unit/background/router.test.js test/unit/background/tabs.test.js test/unit/background/index.test.js
git commit -m "Route messages by sender kind, keep keys out of content and restrict storage to trusted contexts"
```

---

### Task 5: Offscreen capture and the permission page

**Files:**
- Create: `src/offscreen/audio.js`, `src/offscreen/capture.js`, `src/offscreen/offscreen.js`, `src/offscreen/offscreen.html`, `src/offscreen/permission.js`, `src/offscreen/permission.html`
- Modify: `build.mjs` (entries `offscreen`, `permission`; statics `offscreen.html`, `permission.html`)
- Test: `test/unit/offscreen/audio.test.js`, `test/unit/offscreen/capture.test.js`

**Interfaces:**
- Consumes: Task 3 `MSG`.
- Produces:
  - `src/offscreen/audio.js`:
    - `RECORDING_MIME = 'audio/webm;codecs=opus'`, `LEVEL_INTERVAL_MS = 100`, `SPEECH_RMS = 0.02`, `SILENCE_RMS = 0.01`.
    - `rms(samples: Float32Array|number[]): number` (0 for empty input).
    - `levelFromRms(value: number): number` in [0, 1]: `Math.min(1, Math.sqrt(Math.max(0, value)) * 2.5)`.
    - `createSilenceDetector({ silenceSec, intervalMs = LEVEL_INTERVAL_MS, speechRms = SPEECH_RMS, silenceRms = SILENCE_RMS }) => { push(value: number): boolean, readonly heardSpeech: boolean }`: `push` returns true (stop now) only when `silenceSec > 0`, speech has been heard (a sample `>= speechRms`), and consecutive samples `< silenceRms` span at least `silenceSec * 1000` ms; any sample `>= silenceRms` resets the run.
    - `bytesToBase64(bytes: Uint8Array): string` (chunked `String.fromCharCode`, 0x8000 per chunk, then `btoa`).
  - `src/offscreen/capture.js` `createCapture(deps)` with `deps = { queryPermission: () => Promise<'granted'|'prompt'|'denied'>, getUserMedia: (constraints) => Promise<MediaStream>, createMediaRecorder: (stream, options) => MediaRecorderLike, createAnalyser: (stream) => Promise<{ read(): Float32Array, close(): Promise<void> }>, send: (message) => void, now: () => number, setInterval, clearInterval, setTimeout, clearTimeout }` returns `{ start({ maxSec, silenceSec }): Promise<OffscreenStartResponse>, stop({ discard }): Promise<{ ok: boolean }>, readonly active: boolean }`.
    - `start`: `'prompt'` returns `{ ok: false, reason: 'needsPermission', error: 'Microphone permission needed.' }` without calling `getUserMedia`; `'denied'` returns reason `'denied'`; a `NotAllowedError` from `getUserMedia` is `'denied'`; `NotFoundError` is `'micError'` with "No microphone found."; any other failure is `'micError'` with "Could not start the microphone.". Every failure path stops any acquired tracks. On success: `MediaRecorder` with `{ mimeType: RECORDING_MIME, audioBitsPerSecond: 32000 }`, `start(100)`; levels sent as `{ action: MSG.OFFSCREEN_LEVEL, level }` every `LEVEL_INTERVAL_MS` via `setInterval` (never `requestAnimationFrame`); max-time timer at `maxSec * 1000`; the silence detector fed each interval; a track `ended` event stops with reason `'ended'`. A second `start` while active returns `{ ok: false, reason: 'micError', error: 'Already recording.' }`.
    - Finishing (user stop, max time, silence, ended): stop timers, stop the recorder, stop tracks, close the analyser, then send `{ action: MSG.OFFSCREEN_DONE, audioBase64, mimeType: 'audio/webm', durationSec, reason }`. `stop({ discard: true })` finishes without sending `OFFSCREEN_DONE`. A `MediaRecorder` `error` event sends `{ action: MSG.OFFSCREEN_ERROR, error: 'Recording failed.' }` and cleans up.
  - `src/offscreen/offscreen.js`: builds real deps (`navigator.permissions.query({ name: 'microphone' })`, `navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`, `AudioContext` created after `getUserMedia` resolves and `await ctx.resume()`, `AnalyserNode` `fftSize 2048`, `getFloatTimeDomainData`), `send = (m) => chrome.runtime.sendMessage(m).catch(() => {})`, and a `chrome.runtime.onMessage` listener that answers only `OFFSCREEN_START` and `OFFSCREEN_STOP` (returns `false` for anything else so it never steals other responses).
  - `src/offscreen/permission.html|js`: calls `getUserMedia({ audio: true })` on load; on success stops tracks, sends `{ action: MSG.PERMISSION_RESULT, granted: true }`, shows "Microphone allowed. You can close this tab and press REC again." and closes itself after 1.5 s; on failure sends `granted: false` and shows how to reset (chrome://settings/content/microphone). Copy tells the user to choose "Allow while visiting the site" (an "Allow this time" grant may expire). Static markup only; dynamic text via `textContent`.
- Research to honour: offscreen documents can call only `chrome.runtime`; `requestAnimationFrame` does not run there; the `AudioContext` must be created after `getUserMedia` and resumed.

WRITER NOTES

- Additive exports in `capture.js` beyond the Interfaces block: `AUDIO_CONSTRAINTS` (what `offscreen.js` passes to `getUserMedia`), `AUDIO_BITS_PER_SECOND`, `TIMESLICE_MS`, `STOP_TIMEOUT_MS`.
- Contract gap, filled: `stop()` while `start()` is still opening the microphone cancels it. `stop` resolves `{ ok: true }`, the pending `start` resolves `{ ok: false, reason: 'micError', error: 'Recording cancelled.' }` and the tracks are stopped. Without this, a tab closed while the service worker is still starting (Review Focus 2) leaves the microphone open until max time. Task 6 must ignore a start response for a session it has already freed.
- Unspecified texts chosen: `'denied'` carries `'Microphone access is blocked.'` (the service worker shows its own text); a cancelled start carries `'Recording cancelled.'`.
- Robustness choices the contract leaves open: an analyser that cannot start (an `AudioContext` not `running` within 1 s) records without levels or silence stop instead of failing; a recorder whose `stop` event never arrives is finished after `STOP_TIMEOUT_MS` with the chunks already received; a recording with no data sends `OFFSCREEN_ERROR`; `levelFromRms(NaN)` is 0 so the result stays in [0, 1].
- `offscreen.js` ignores messages whose sender has a tab: content-script `runtime.sendMessage` calls reach every extension context, the offscreen document included.
- Step 11 quotes the post-Task-1 `build.mjs` (verified by applying the Task 1 to 4 plan parts, then this one: the replacements match once each, the build lists five bundles; replayed on the full plan the suite is 301/301).
- Verified beyond the unit tests (scratch harness, Chromium 153, fake microphone): levels every 100 ms with a tone, WebM output starting with the EBML magic `1a 45 df a3`, `maxTime` at 1.0 s, silence stop at 3.1 s for 1 s of tone then silence with `silenceSec: 2`, `needsPermission` without `--use-fake-ui-for-media-stream`, and the permission page reporting `granted: true` and closing itself after 1.5 s.

- [ ] **Step 1: Write the failing audio helper tests**

`test/unit/offscreen/audio.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  RECORDING_MIME, LEVEL_INTERVAL_MS, SPEECH_RMS, SILENCE_RMS,
  rms, levelFromRms, createSilenceDetector, bytesToBase64,
} from '../../../src/offscreen/audio.js';

describe('constants', () => {
  it('match the recording contract', () => {
    expect(RECORDING_MIME).toBe('audio/webm;codecs=opus');
    expect(LEVEL_INTERVAL_MS).toBe(100);
    expect(SPEECH_RMS).toBe(0.02);
    expect(SILENCE_RMS).toBe(0.01);
  });
});

describe('rms', () => {
  it('is 0 for empty or missing input', () => {
    expect(rms(new Float32Array(0))).toBe(0);
    expect(rms([])).toBe(0);
    expect(rms(undefined)).toBe(0);
  });
  it('is the root mean square of the samples', () => {
    expect(rms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5, 10);
    expect(rms(Float32Array.from([3, 4]))).toBeCloseTo(Math.sqrt(12.5), 6);
    expect(rms(new Float32Array(2048))).toBe(0);
  });
});

describe('levelFromRms', () => {
  it('stays within [0, 1]', () => {
    expect(levelFromRms(0)).toBe(0);
    expect(levelFromRms(-0.3)).toBe(0);
    expect(levelFromRms(0.16)).toBeCloseTo(1, 10);
    expect(levelFromRms(0.5)).toBe(1);
    expect(levelFromRms(Infinity)).toBe(1);
    expect(levelFromRms(Number.NaN)).toBe(0);
  });
  it('follows sqrt(rms) * 2.5 below the cap', () => {
    expect(levelFromRms(0.01)).toBeCloseTo(0.25, 10);
    expect(levelFromRms(0.04)).toBeCloseTo(0.5, 10);
  });
});

describe('createSilenceDetector', () => {
  const quiet = 0.001;
  const loud = 0.1;
  const push = (detector, value, times) => {
    let stop = false;
    for (let i = 0; i < times; i++) stop = detector.push(value);
    return stop;
  };

  it('stops once silence after speech spans silenceSec', () => {
    const detector = createSilenceDetector({ silenceSec: 2 });
    expect(detector.push(loud)).toBe(false);
    expect(detector.heardSpeech).toBe(true);
    expect(push(detector, quiet, 19)).toBe(false);
    expect(detector.push(quiet)).toBe(true);
  });

  it('never stops before speech was heard', () => {
    const detector = createSilenceDetector({ silenceSec: 2 });
    expect(push(detector, quiet, 100)).toBe(false);
    expect(detector.heardSpeech).toBe(false);
  });

  it('counts only silence that follows speech', () => {
    const detector = createSilenceDetector({ silenceSec: 2 });
    push(detector, quiet, 50);
    detector.push(loud);
    expect(push(detector, quiet, 19)).toBe(false);
    expect(detector.push(quiet)).toBe(true);
  });

  it('a sample at or above the silence threshold resets the run', () => {
    const detector = createSilenceDetector({ silenceSec: 2 });
    detector.push(loud);
    push(detector, quiet, 19);
    expect(detector.push(SILENCE_RMS)).toBe(false);
    expect(push(detector, quiet, 19)).toBe(false);
    expect(detector.push(quiet)).toBe(true);
  });

  it('a sample between the thresholds is not speech', () => {
    const detector = createSilenceDetector({ silenceSec: 2 });
    detector.push(0.015);
    expect(detector.heardSpeech).toBe(false);
    expect(push(detector, quiet, 40)).toBe(false);
  });

  it('silenceSec 0 never stops', () => {
    const detector = createSilenceDetector({ silenceSec: 0 });
    detector.push(loud);
    expect(push(detector, quiet, 10_000)).toBe(false);
    expect(detector.heardSpeech).toBe(true);
  });

  it('honours a custom interval and thresholds', () => {
    const detector = createSilenceDetector({ silenceSec: 1, intervalMs: 250, speechRms: 0.5, silenceRms: 0.2 });
    detector.push(0.4);
    expect(detector.heardSpeech).toBe(false);
    detector.push(0.5);
    expect(push(detector, 0.1, 3)).toBe(false);
    expect(detector.push(0.1)).toBe(true);
  });
});

describe('bytesToBase64', () => {
  /** Deterministic pseudo-random bytes so every byte value appears. */
  function bytes(length) {
    const out = new Uint8Array(length);
    let x = 12345;
    for (let i = 0; i < length; i++) {
      x = (x * 1103515245 + 12345) >>> 0;
      out[i] = x >>> 24;
    }
    return out;
  }

  it('encodes the empty array as the empty string', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
  });

  it.each([1, 2, 3, 0x7fff, 0x8000, 0x8001, 0x10000, 0x10002, 0x18000 + 7])('matches Buffer for %i bytes', (length) => {
    const data = bytes(length);
    expect(bytesToBase64(data)).toBe(Buffer.from(data).toString('base64'));
  });

  it('encodes a subarray view by its own bytes only', () => {
    const data = bytes(0x8000 + 10);
    const view = data.subarray(5, 0x8000 + 5);
    expect(bytesToBase64(view)).toBe(Buffer.from(view).toString('base64'));
  });
});
```

- [ ] **Step 2: Run the audio tests to verify they fail**

```bash
npx vitest run test/unit/offscreen/audio.test.js
```

Expected: FAIL with `Cannot find module '../../../src/offscreen/audio.js'`.

- [ ] **Step 3: Create `src/offscreen/audio.js`**

```js
// Pure audio helpers for the offscreen recorder: level metering, silence detection, encoding.

export const RECORDING_MIME = 'audio/webm;codecs=opus';
export const LEVEL_INTERVAL_MS = 100;
export const SPEECH_RMS = 0.02;
export const SILENCE_RMS = 0.01;

const BASE64_CHUNK = 0x8000;

/**
 * Root mean square of time-domain samples in [-1, 1].
 * @param {Float32Array|number[]} samples
 * @returns {number} 0 for empty input
 */
export function rms(samples) {
  const n = samples?.length ?? 0;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / n);
}

/**
 * Map an RMS value to a display level. The square root lifts quiet speech into view.
 * @param {number} value
 * @returns {number} in [0, 1]
 */
export function levelFromRms(value) {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.sqrt(Math.max(0, value)) * 2.5);
}

/**
 * Decides when a recording has gone quiet after speech. Feed one RMS value per interval.
 * @param {{ silenceSec: number, intervalMs?: number, speechRms?: number, silenceRms?: number }} options
 * @returns {{ push(value: number): boolean, readonly heardSpeech: boolean }}
 */
export function createSilenceDetector({ silenceSec, intervalMs = LEVEL_INTERVAL_MS, speechRms = SPEECH_RMS, silenceRms = SILENCE_RMS }) {
  const limitMs = Number(silenceSec) > 0 ? Number(silenceSec) * 1000 : 0;
  let heardSpeech = false;
  let quietMs = 0;
  return {
    push(value) {
      if (value >= speechRms) heardSpeech = true;
      if (value < silenceRms) quietMs += intervalMs;
      else quietMs = 0;
      return limitMs > 0 && heardSpeech && quietMs >= limitMs;
    },
    get heardSpeech() {
      return heardSpeech;
    },
  };
}

/**
 * Base64 without spreading the whole buffer into one call (large arrays overflow the stack).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}
```

- [ ] **Step 4: Run the audio tests to verify they pass**

```bash
npx vitest run test/unit/offscreen/audio.test.js
```

Expected: 1 file, 23 tests passed.

- [ ] **Step 5: Write the failing capture tests**

Fakes only: a `MediaRecorder` with `ondataavailable`/`onstop`/`onerror` that delivers its last chunk and the stop event in a microtask, a stream whose track records `stop()` and fires `ended`, an analyser that reads scripted sample arrays, and Vitest fake timers behind the injected `setInterval`/`setTimeout`/`now`.

`test/unit/offscreen/capture.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCapture, AUDIO_CONSTRAINTS, STOP_TIMEOUT_MS } from '../../../src/offscreen/capture.js';
import { RECORDING_MIME, LEVEL_INTERVAL_MS } from '../../../src/offscreen/audio.js';
import { MSG } from '../../../src/shared/messages.js';

const LOUD = Float32Array.from([0.5, -0.5, 0.5, -0.5]); // rms 0.5, level 1
const MID = Float32Array.from([0.0625, -0.0625]); // rms 1/16, level 0.625
const QUIET = new Float32Array(4); // rms 0, level 0
const OPTS = { maxSec: 60, silenceSec: 0 };
const GENERIC = { ok: false, reason: 'micError', error: 'Could not start the microphone.' };

class FakeRecorder {
  constructor(stream, options, log) {
    this.stream = stream;
    this.options = options;
    this.log = log;
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    this.stopsItself = true;
    this.start = vi.fn(() => { this.state = 'recording'; });
    this.stop = vi.fn(() => {
      this.log.push('recorder.stop');
      this.state = 'inactive';
      if (!this.stopsItself) return;
      // Chrome delivers the last chunk and then the stop event asynchronously.
      queueMicrotask(() => {
        this.emit(Uint8Array.of(4, 5));
        this.onstop?.({ type: 'stop' });
      });
    });
  }
  emit(bytes) { this.ondataavailable?.({ data: new Blob([bytes]) }); }
  fail() { this.onerror?.({ type: 'error' }); }
}

function fakeStream(log) {
  const listeners = new Set();
  const track = {
    stop: vi.fn(() => { log.push('track.stop'); }),
    addEventListener: vi.fn((type, fn) => { if (type === 'ended') listeners.add(fn); }),
    removeEventListener: vi.fn((type, fn) => { if (type === 'ended') listeners.delete(fn); }),
  };
  return {
    track,
    getTracks: () => [track],
    end: () => { for (const fn of [...listeners]) fn({ type: 'ended' }); },
    listenerCount: () => listeners.size,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Fresh capture with fakes; `samples` scripts the analyser (an empty queue reads silence). */
function setup(overrides = {}, { recorderStartThrows = false } = {}) {
  const log = [];
  const stream = fakeStream(log);
  const recorders = [];
  const samples = [];
  const analyser = {
    read: vi.fn(() => samples.shift() ?? QUIET),
    close: vi.fn(async () => { log.push('analyser.close'); }),
  };
  const sent = [];
  const waiters = [];
  const deps = {
    queryPermission: vi.fn(async () => 'granted'),
    getUserMedia: vi.fn(async () => stream),
    createMediaRecorder: vi.fn((s, options) => {
      const recorder = new FakeRecorder(s, options, log);
      if (recorderStartThrows) recorder.start.mockImplementation(() => { throw new Error('start failed'); });
      recorders.push(recorder);
      return recorder;
    }),
    createAnalyser: vi.fn(async () => analyser),
    send: vi.fn((message) => {
      sent.push(message);
      log.push(message.action);
      for (const wake of waiters.splice(0)) wake();
    }),
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    ...overrides,
  };
  const capture = createCapture(deps);
  const of = (action) => sent.filter((m) => m.action === action);
  /** Resolves with the first message of `action`, waiting for it when needed. */
  async function until(action) {
    while (of(action).length === 0) await new Promise((resolve) => waiters.push(resolve));
    return of(action)[0];
  }
  return { capture, deps, stream, analyser, samples, sent, log, of, until, recorder: () => recorders.at(-1) };
}

function domError(name) {
  return new DOMException(`${name} message`, name);
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('start failures', () => {
  it('prompt state never calls getUserMedia', async () => {
    const h = setup({ queryPermission: vi.fn(async () => 'prompt') });
    await expect(h.capture.start(OPTS)).resolves.toEqual({ ok: false, reason: 'needsPermission', error: 'Microphone permission needed.' });
    expect(h.deps.getUserMedia).not.toHaveBeenCalled();
    expect(h.deps.createMediaRecorder).not.toHaveBeenCalled();
    expect(h.capture.active).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it('denied state is denied without calling getUserMedia', async () => {
    const h = setup({ queryPermission: vi.fn(async () => 'denied') });
    await expect(h.capture.start(OPTS)).resolves.toEqual({ ok: false, reason: 'denied', error: 'Microphone access is blocked.' });
    expect(h.deps.getUserMedia).not.toHaveBeenCalled();
    expect(h.capture.active).toBe(false);
  });

  it('NotAllowedError from getUserMedia is denied', async () => {
    const h = setup({ getUserMedia: vi.fn(async () => { throw domError('NotAllowedError'); }) });
    await expect(h.capture.start(OPTS)).resolves.toEqual({ ok: false, reason: 'denied', error: 'Microphone access is blocked.' });
    expect(h.capture.active).toBe(false);
  });

  it('NotFoundError is micError with "No microphone found."', async () => {
    const h = setup({ getUserMedia: vi.fn(async () => { throw domError('NotFoundError'); }) });
    await expect(h.capture.start(OPTS)).resolves.toEqual({ ok: false, reason: 'micError', error: 'No microphone found.' });
    expect(h.capture.active).toBe(false);
  });

  it('any other failure is micError with the generic text', async () => {
    const busy = setup({ getUserMedia: vi.fn(async () => { throw domError('NotReadableError'); }) });
    await expect(busy.capture.start(OPTS)).resolves.toEqual(GENERIC);
    const query = setup({ queryPermission: vi.fn(async () => { throw new TypeError('bad name'); }) });
    await expect(query.capture.start(OPTS)).resolves.toEqual(GENERIC);
    expect(query.deps.getUserMedia).not.toHaveBeenCalled();
    expect(busy.capture.active).toBe(false);
    expect(query.capture.active).toBe(false);
  });

  it('tracks stopped on every failure path', async () => {
    // The recorder cannot be created (unsupported mime type).
    let h = setup({ createMediaRecorder: vi.fn(() => { throw domError('NotSupportedError'); }) });
    await expect(h.capture.start(OPTS)).resolves.toEqual(GENERIC);
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(h.analyser.close).toHaveBeenCalledTimes(1);
    expect(h.capture.active).toBe(false);

    // The recorder refuses to start.
    h = setup({}, { recorderStartThrows: true });
    await expect(h.capture.start(OPTS)).resolves.toEqual(GENERIC);
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(h.analyser.close).toHaveBeenCalledTimes(1);
    expect(h.stream.listenerCount()).toBe(0);
    expect(h.capture.active).toBe(false);

    // Cancelled while getUserMedia was pending.
    const gum = deferred();
    h = setup({ getUserMedia: vi.fn(() => gum.promise) });
    const starting = h.capture.start(OPTS);
    await h.capture.stop({ discard: true });
    gum.resolve(h.stream);
    await expect(starting).resolves.toEqual({ ok: false, reason: 'micError', error: 'Recording cancelled.' });
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(h.capture.active).toBe(false);

    // The recorder fails while recording.
    h = setup();
    await h.capture.start(OPTS);
    h.recorder().fail();
    await h.until(MSG.OFFSCREEN_ERROR);
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(h.analyser.close).toHaveBeenCalledTimes(1);
    expect(h.capture.active).toBe(false);
  });

  it('a stop while starting cancels the start and records nothing', async () => {
    const gum = deferred();
    const h = setup({ getUserMedia: vi.fn(() => gum.promise) });
    const starting = h.capture.start(OPTS);
    expect(h.capture.active).toBe(true);
    await expect(h.capture.stop({ discard: true })).resolves.toEqual({ ok: true });
    gum.resolve(h.stream);
    await expect(starting).resolves.toEqual({ ok: false, reason: 'micError', error: 'Recording cancelled.' });
    expect(h.deps.createMediaRecorder).not.toHaveBeenCalled();
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(h.sent).toEqual([]);
    expect(h.capture.active).toBe(false);
    await expect(h.capture.start(OPTS)).resolves.toEqual({ ok: true });
  });
});

describe('recording', () => {
  it('starts an opus recorder at 32 kbps with a 100 ms timeslice', async () => {
    const h = setup();
    await expect(h.capture.start(OPTS)).resolves.toEqual({ ok: true });
    expect(AUDIO_CONSTRAINTS).toEqual({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    expect(h.deps.getUserMedia).toHaveBeenCalledWith(AUDIO_CONSTRAINTS);
    expect(h.deps.createAnalyser).toHaveBeenCalledWith(h.stream);
    expect(h.deps.createMediaRecorder).toHaveBeenCalledWith(h.stream, { mimeType: RECORDING_MIME, audioBitsPerSecond: 32000 });
    expect(h.recorder().start).toHaveBeenCalledWith(100);
    expect(h.stream.listenerCount()).toBe(1);
    expect(h.capture.active).toBe(true);
  });

  it('levels sent every interval', async () => {
    const h = setup();
    h.samples.push(LOUD, MID);
    await h.capture.start(OPTS);
    expect(h.of(MSG.OFFSCREEN_LEVEL)).toEqual([]);
    await vi.advanceTimersByTimeAsync(LEVEL_INTERVAL_MS);
    expect(h.of(MSG.OFFSCREEN_LEVEL)).toEqual([{ action: MSG.OFFSCREEN_LEVEL, level: 1 }]);
    await vi.advanceTimersByTimeAsync(LEVEL_INTERVAL_MS);
    expect(h.of(MSG.OFFSCREEN_LEVEL)[1]).toEqual({ action: MSG.OFFSCREEN_LEVEL, level: 0.625 });
    await vi.advanceTimersByTimeAsync(LEVEL_INTERVAL_MS * 3);
    expect(h.of(MSG.OFFSCREEN_LEVEL)).toHaveLength(5);
    expect(h.of(MSG.OFFSCREEN_LEVEL)[4].level).toBe(0);
  });

  it('second start while active', async () => {
    const gum = deferred();
    const h = setup({ getUserMedia: vi.fn(() => gum.promise) });
    const first = h.capture.start(OPTS);
    await expect(h.capture.start(OPTS)).resolves.toEqual({ ok: false, reason: 'micError', error: 'Already recording.' });
    gum.resolve(h.stream);
    await expect(first).resolves.toEqual({ ok: true });
    await expect(h.capture.start(OPTS)).resolves.toEqual({ ok: false, reason: 'micError', error: 'Already recording.' });
    expect(h.deps.getUserMedia).toHaveBeenCalledTimes(1);
    expect(h.stream.track.stop).not.toHaveBeenCalled();
    expect(h.capture.active).toBe(true);
    await vi.advanceTimersByTimeAsync(LEVEL_INTERVAL_MS * 2);
    expect(h.of(MSG.OFFSCREEN_LEVEL)).toHaveLength(2);
  });

  it('records without levels when the analyser cannot be created', async () => {
    const h = setup({ createAnalyser: vi.fn(async () => { throw new Error('no audio context'); }) });
    await expect(h.capture.start({ maxSec: 60, silenceSec: 2 })).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.of(MSG.OFFSCREEN_LEVEL)).toEqual([]);
    expect(h.capture.active).toBe(true);
    await h.capture.stop({ discard: false });
    expect(h.of(MSG.OFFSCREEN_DONE)).toHaveLength(1);
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
  });
});

describe('finishing', () => {
  it('user stop sends OFFSCREEN_DONE with base64 and duration', async () => {
    const h = setup();
    await h.capture.start(OPTS);
    h.recorder().emit(Uint8Array.of(1, 2, 3));
    await vi.advanceTimersByTimeAsync(1500);
    await expect(h.capture.stop({ discard: false })).resolves.toEqual({ ok: true });
    expect(h.of(MSG.OFFSCREEN_DONE)).toEqual([{
      action: MSG.OFFSCREEN_DONE,
      audioBase64: 'AQIDBAU=', // bytes 1 to 5: the chunk above plus the final chunk
      mimeType: 'audio/webm',
      durationSec: 1.5,
      reason: 'user',
    }]);
    expect(h.log.filter((entry) => entry !== MSG.OFFSCREEN_LEVEL))
      .toEqual(['recorder.stop', 'track.stop', 'analyser.close', MSG.OFFSCREEN_DONE]);
    expect(h.stream.listenerCount()).toBe(0);
    expect(h.capture.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    const levels = h.of(MSG.OFFSCREEN_LEVEL).length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.of(MSG.OFFSCREEN_LEVEL)).toHaveLength(levels);
    await expect(h.capture.start(OPTS)).resolves.toEqual({ ok: true });
  });

  it('max time finishes with reason maxTime', async () => {
    const h = setup();
    await h.capture.start({ maxSec: 5, silenceSec: 0 });
    await vi.advanceTimersByTimeAsync(4999);
    expect(h.of(MSG.OFFSCREEN_DONE)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const done = await h.until(MSG.OFFSCREEN_DONE);
    expect(done).toMatchObject({ reason: 'maxTime', durationSec: 5, mimeType: 'audio/webm' });
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(h.analyser.close).toHaveBeenCalledTimes(1);
    expect(h.capture.active).toBe(false);
  });

  it('silence detector stops with reason silence only after speech', async () => {
    const h = setup();
    await h.capture.start({ maxSec: 60, silenceSec: 2 });
    await vi.advanceTimersByTimeAsync(3000); // 3 s of silence before any speech
    expect(h.of(MSG.OFFSCREEN_DONE)).toEqual([]);
    expect(h.capture.active).toBe(true);
    h.samples.push(LOUD);
    await vi.advanceTimersByTimeAsync(LEVEL_INTERVAL_MS); // speech
    await vi.advanceTimersByTimeAsync(1900); // 19 quiet samples
    expect(h.of(MSG.OFFSCREEN_DONE)).toEqual([]);
    await vi.advanceTimersByTimeAsync(LEVEL_INTERVAL_MS); // the 20th quiet sample
    const done = await h.until(MSG.OFFSCREEN_DONE);
    expect(done).toMatchObject({ reason: 'silence', durationSec: 5.1 });
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(h.capture.active).toBe(false);
  });

  it('silenceSec 0 never auto-stops', async () => {
    const h = setup();
    await h.capture.start({ maxSec: 600, silenceSec: 0 });
    h.samples.push(LOUD);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.of(MSG.OFFSCREEN_DONE)).toEqual([]);
    expect(h.capture.active).toBe(true);
  });

  it('track ended finishes with reason ended', async () => {
    const h = setup();
    await h.capture.start(OPTS);
    await vi.advanceTimersByTimeAsync(700);
    h.stream.end();
    const done = await h.until(MSG.OFFSCREEN_DONE);
    expect(done).toMatchObject({ reason: 'ended', durationSec: 0.7 });
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(h.capture.active).toBe(false);
  });

  it('discard sends nothing', async () => {
    const h = setup();
    await h.capture.start(OPTS);
    h.recorder().emit(Uint8Array.of(1, 2, 3));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(h.capture.stop({ discard: true })).resolves.toEqual({ ok: true });
    expect(h.of(MSG.OFFSCREEN_DONE)).toEqual([]);
    expect(h.of(MSG.OFFSCREEN_ERROR)).toEqual([]);
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(h.analyser.close).toHaveBeenCalledTimes(1);
    expect(h.capture.active).toBe(false);
  });

  it('recorder error sends OFFSCREEN_ERROR', async () => {
    const h = setup();
    await h.capture.start(OPTS);
    await vi.advanceTimersByTimeAsync(300);
    h.recorder().fail();
    await h.until(MSG.OFFSCREEN_ERROR);
    expect(h.of(MSG.OFFSCREEN_ERROR)).toEqual([{ action: MSG.OFFSCREEN_ERROR, error: 'Recording failed.' }]);
    expect(h.of(MSG.OFFSCREEN_DONE)).toEqual([]);
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(h.analyser.close).toHaveBeenCalledTimes(1);
    expect(h.capture.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const levels = h.of(MSG.OFFSCREEN_LEVEL).length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.of(MSG.OFFSCREEN_LEVEL)).toHaveLength(levels);
  });

  it('a recorder that never fires stop is released after the stop timeout', async () => {
    const h = setup();
    await h.capture.start(OPTS);
    h.recorder().emit(Uint8Array.of(1, 2, 3));
    h.recorder().stopsItself = false;
    await vi.advanceTimersByTimeAsync(2000);
    const stopping = h.capture.stop({ discard: false });
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS);
    await expect(stopping).resolves.toEqual({ ok: true });
    expect(h.of(MSG.OFFSCREEN_DONE)).toEqual([{
      action: MSG.OFFSCREEN_DONE, audioBase64: 'AQID', mimeType: 'audio/webm', durationSec: 2, reason: 'user',
    }]);
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(h.capture.active).toBe(false);
  });

  it('a recording without any audio data is an error', async () => {
    const h = setup();
    await h.capture.start(OPTS);
    h.recorder().stopsItself = false;
    const stopping = h.capture.stop({ discard: false });
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS);
    await stopping;
    expect(h.of(MSG.OFFSCREEN_DONE)).toEqual([]);
    expect(h.of(MSG.OFFSCREEN_ERROR)).toEqual([{ action: MSG.OFFSCREEN_ERROR, error: 'Recording failed.' }]);
  });

  it('stop without a recording answers ok false', async () => {
    const h = setup();
    await expect(h.capture.stop({ discard: false })).resolves.toEqual({ ok: false });
    await expect(h.capture.stop({ discard: true })).resolves.toEqual({ ok: false });
    expect(h.sent).toEqual([]);
  });
});
```

- [ ] **Step 6: Run the capture tests to verify they fail**

```bash
npx vitest run test/unit/offscreen/capture.test.js
```

Expected: FAIL with `Cannot find module '../../../src/offscreen/capture.js'`.

- [ ] **Step 7: Create `src/offscreen/capture.js`**

```js
// Microphone capture for the offscreen document. Every browser API arrives through deps,
// so the whole lifecycle runs under unit tests with fakes.
import { MSG } from '../shared/messages.js';
import { RECORDING_MIME, LEVEL_INTERVAL_MS, rms, levelFromRms, createSilenceDetector, bytesToBase64 } from './audio.js';

export const AUDIO_CONSTRAINTS = Object.freeze({
  audio: Object.freeze({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }),
});
export const AUDIO_BITS_PER_SECOND = 32000;
export const TIMESLICE_MS = 100;
/** How long to wait for the recorder's stop event before finishing with the chunks we have. */
export const STOP_TIMEOUT_MS = 2000;

const DENIED = 'Microphone access is blocked.';
const GENERIC = 'Could not start the microphone.';
const FAILED = 'Recording failed.';

/**
 * @typedef {{ state: string, start(timeslice?: number): void, stop(): void,
 *   ondataavailable: ((event: { data: Blob }) => void)|null,
 *   onstop: ((event?: unknown) => void)|null, onerror: ((event?: unknown) => void)|null }} MediaRecorderLike
 * @typedef {{ read(): Float32Array, close(): Promise<void> }} AnalyserLike
 * @typedef {{
 *   queryPermission: () => Promise<'granted'|'prompt'|'denied'>,
 *   getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
 *   createMediaRecorder: (stream: MediaStream, options: MediaRecorderOptions) => MediaRecorderLike,
 *   createAnalyser: (stream: MediaStream) => Promise<AnalyserLike>,
 *   send: (message: object) => void,
 *   now: () => number,
 *   setInterval: (fn: () => void, ms: number) => any,
 *   clearInterval: (id: any) => void,
 *   setTimeout: (fn: () => void, ms: number) => any,
 *   clearTimeout: (id: any) => void,
 * }} CaptureDeps
 * @typedef {'user'|'maxTime'|'silence'|'ended'} FinishReason
 */

/**
 * @param {string} reason
 * @param {string} error
 * @returns {import('../shared/messages.js').OffscreenStartResponse}
 */
function failure(reason, error) {
  return /** @type {any} */ ({ ok: false, reason, error });
}

/** @param {MediaStream|null} stream */
function stopTracks(stream) {
  for (const track of stream?.getTracks() ?? []) {
    try { track.stop(); } catch { /* already stopped */ }
  }
}

/** @param {AnalyserLike|null} analyser */
async function closeAnalyser(analyser) {
  try { await analyser?.close(); } catch { /* the context is gone either way */ }
}

/**
 * One recording at a time: permission check, MediaRecorder, levels, max time, silence stop.
 * @param {CaptureDeps} deps
 */
export function createCapture(deps) {
  const { send, now } = deps;
  let starting = false;
  let cancelStart = false;
  /** @type {any} */
  let session = null;

  /**
   * @param {{ maxSec: number, silenceSec: number }} options
   * @returns {Promise<import('../shared/messages.js').OffscreenStartResponse>}
   */
  async function start({ maxSec, silenceSec } = {}) {
    if (starting || session) return failure('micError', 'Already recording.');
    starting = true;
    cancelStart = false;
    let stream = null;
    let analyser = null;
    try {
      const state = await deps.queryPermission();
      // Offscreen documents cannot show a permission prompt; the service worker opens the grant page.
      if (state === 'prompt') return failure('needsPermission', 'Microphone permission needed.');
      if (state === 'denied') return failure('denied', DENIED);
      try {
        stream = await deps.getUserMedia(AUDIO_CONSTRAINTS);
      } catch (err) {
        if (err?.name === 'NotAllowedError') return failure('denied', DENIED);
        if (err?.name === 'NotFoundError') return failure('micError', 'No microphone found.');
        return failure('micError', GENERIC);
      }
      if (!cancelStart) analyser = await deps.createAnalyser(stream).catch(() => null);
      if (cancelStart) {
        stopTracks(stream);
        await closeAnalyser(analyser);
        return failure('micError', 'Recording cancelled.');
      }
      begin(stream, analyser, { maxSec, silenceSec });
      return { ok: true };
    } catch {
      stopTracks(stream);
      await closeAnalyser(analyser);
      return failure('micError', GENERIC);
    } finally {
      starting = false;
    }
  }

  function begin(stream, analyser, { maxSec, silenceSec }) {
    const recorder = deps.createMediaRecorder(stream, { mimeType: RECORDING_MIME, audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
    const s = {
      stream,
      analyser,
      recorder,
      chunks: [],
      startedAt: 0,
      detector: createSilenceDetector({ silenceSec }),
      levelTimer: null,
      maxTimer: null,
      finishing: null,
      discard: false,
      errored: false,
      resolveStopped: () => {},
      stopped: null,
      onEnded: () => { void finish(s, 'ended'); },
    };
    s.stopped = new Promise((resolve) => { s.resolveStopped = resolve; });
    recorder.ondataavailable = (event) => {
      if (event?.data && event.data.size > 0) s.chunks.push(event.data);
    };
    recorder.onstop = () => s.resolveStopped();
    recorder.onerror = () => {
      if (s !== session) return;
      s.errored = true;
      s.resolveStopped();
      void finish(s, null);
    };
    recorder.start(TIMESLICE_MS);
    s.startedAt = now();
    session = s;
    for (const track of stream.getTracks()) track.addEventListener('ended', s.onEnded);
    // setInterval, not requestAnimationFrame: an offscreen document is never rendered.
    if (analyser) s.levelTimer = deps.setInterval(() => tick(s), LEVEL_INTERVAL_MS);
    if (Number.isFinite(maxSec) && maxSec > 0) {
      s.maxTimer = deps.setTimeout(() => { void finish(s, 'maxTime'); }, maxSec * 1000);
    }
  }

  function tick(s) {
    if (s !== session || s.finishing) return;
    let value = 0;
    try { value = rms(s.analyser.read()); } catch { value = 0; }
    send({ action: MSG.OFFSCREEN_LEVEL, level: levelFromRms(value) });
    if (s.detector.push(value)) void finish(s, 'silence');
  }

  function clearTimers(s) {
    if (s.levelTimer !== null) deps.clearInterval(s.levelTimer);
    if (s.maxTimer !== null) deps.clearTimeout(s.maxTimer);
    s.levelTimer = null;
    s.maxTimer = null;
  }

  function releaseTracks(s) {
    for (const track of s.stream.getTracks()) track.removeEventListener('ended', s.onEnded);
    stopTracks(s.stream);
  }

  /**
   * Stop timers, the recorder, the tracks and the analyser, then report. Idempotent.
   * @param {any} s
   * @param {FinishReason|null} reason null after a recorder error (the report is an error)
   * @param {boolean} [discard]
   */
  function finish(s, reason, discard = false) {
    if (discard) s.discard = true;
    if (s.finishing) return s.finishing;
    s.finishing = (async () => {
      const durationSec = Math.max(0, (now() - s.startedAt) / 1000);
      clearTimers(s);
      try {
        if (s.recorder.state !== 'inactive') s.recorder.stop();
        else s.resolveStopped();
      } catch {
        s.resolveStopped();
      }
      releaseTracks(s);
      let timer = null;
      await Promise.race([s.stopped, new Promise((resolve) => { timer = deps.setTimeout(resolve, STOP_TIMEOUT_MS); })]);
      deps.clearTimeout(timer);
      await closeAnalyser(s.analyser);
      if (session === s) session = null;
      if (s.discard) return;
      if (s.errored || s.chunks.length === 0) {
        send({ action: MSG.OFFSCREEN_ERROR, error: FAILED });
        return;
      }
      try {
        const buffer = await new Blob(s.chunks, { type: 'audio/webm' }).arrayBuffer();
        send({ action: MSG.OFFSCREEN_DONE, audioBase64: bytesToBase64(new Uint8Array(buffer)), mimeType: 'audio/webm', durationSec, reason });
      } catch {
        send({ action: MSG.OFFSCREEN_ERROR, error: FAILED });
      }
    })();
    return s.finishing;
  }

  /**
   * @param {{ discard?: boolean }} [options]
   * @returns {Promise<{ ok: boolean }>}
   */
  async function stop({ discard = false } = {}) {
    if (starting) {
      // The service worker cancelled while the microphone was still opening.
      cancelStart = true;
      return { ok: true };
    }
    if (!session) return { ok: false };
    await finish(session, 'user', discard === true);
    return { ok: true };
  }

  return {
    start,
    stop,
    get active() {
      return starting || session !== null;
    },
  };
}
```

- [ ] **Step 8: Run the offscreen tests to verify they pass**

```bash
npx vitest run test/unit/offscreen
```

Expected: 2 files, 44 tests passed (audio 23, capture 21).

- [ ] **Step 9: Create the offscreen document**

`src/offscreen/offscreen.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>VoiceType recorder</title>
</head>
<body>
  <script src="offscreen.js"></script>
</body>
</html>
```

`src/offscreen/offscreen.js`:

```js
// Offscreen document entry. Only chrome.runtime exists here: levels and results go to the
// service worker, which relays them to the recording tab.
import { MSG } from '../shared/messages.js';
import { createCapture } from './capture.js';

const FFT_SIZE = 2048;
const RESUME_TIMEOUT_MS = 1000;

/** @returns {Promise<'granted'|'prompt'|'denied'>} */
async function queryPermission() {
  try {
    const status = await navigator.permissions.query({ name: /** @type {PermissionName} */ ('microphone') });
    return status.state;
  } catch {
    // Unknown state: the permission page asks, and closes at once when access is already granted.
    return 'prompt';
  }
}

/**
 * @param {MediaStream} stream
 * @param {MediaRecorderOptions} options
 */
function createMediaRecorder(stream, options) {
  const supported = MediaRecorder.isTypeSupported(options.mimeType);
  return new MediaRecorder(stream, supported ? options : { audioBitsPerSecond: options.audioBitsPerSecond });
}

/**
 * Called after getUserMedia resolves: an AudioContext created earlier can stay suspended.
 * @param {MediaStream} stream
 */
async function createAnalyser(stream) {
  const ctx = new AudioContext();
  try {
    let timer;
    await Promise.race([ctx.resume(), new Promise((resolve) => { timer = setTimeout(resolve, RESUME_TIMEOUT_MS); })]);
    clearTimeout(timer);
    if (ctx.state !== 'running') throw new Error(`AudioContext is ${ctx.state}`);
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    return {
      read() {
        analyser.getFloatTimeDomainData(buffer);
        return buffer;
      },
      async close() {
        source.disconnect();
        await ctx.close();
      },
    };
  } catch (err) {
    ctx.close().catch(() => {});
    throw err;
  }
}

const capture = createCapture({
  queryPermission,
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  createMediaRecorder,
  createAnalyser,
  send: (message) => { chrome.runtime.sendMessage(message).catch(() => {}); },
  now: () => performance.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Content scripts broadcast to every extension context; only the service worker drives capture.
  if (sender.tab) return false;
  if (message?.action === MSG.OFFSCREEN_START) {
    capture.start({ maxSec: Number(message.maxSec), silenceSec: Number(message.silenceSec) || 0 }).then(sendResponse);
    return true;
  }
  if (message?.action === MSG.OFFSCREEN_STOP) {
    capture.stop({ discard: message.discard === true }).then(sendResponse);
    return true;
  }
  return false;
});
```

- [ ] **Step 10: Create the permission page**

`src/offscreen/permission.html` (static markup; the only dynamic text is set with `textContent`):

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VoiceType: allow the microphone</title>
  <style>
    :root { color-scheme: light dark; --text: #1e293b; --muted: #475569; --bg: #ffffff; --panel: #f1f5f9; --accent: #4f46e5; }
    @media (prefers-color-scheme: dark) {
      :root { --text: #e2e8f0; --muted: #cbd5e1; --bg: #0f172a; --panel: #1e293b; --accent: #a5b4fc; }
    }
    body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
    main { max-width: 560px; margin: 64px auto; padding: 0 24px; }
    h1 { font-size: 24px; margin: 0 0 16px; }
    p { margin: 0 0 12px; }
    .choice { font-weight: 600; color: var(--accent); }
    #status { margin-top: 24px; padding: 12px 16px; border-radius: 8px; background: var(--panel); font-weight: 600; }
    #help { color: var(--muted); }
    code { font-size: 15px; }
  </style>
</head>
<body>
  <main>
    <h1>Allow the microphone for VoiceType</h1>
    <p>VoiceType records inside the extension, so Chrome asks once for microphone access for VoiceType itself, not for each site.</p>
    <p>When Chrome asks, choose <span class="choice">Allow while visiting the site</span>. An "Allow this time" answer can expire when this tab closes, and Chrome would ask again on the next dictation.</p>
    <p id="status" role="status" aria-live="polite">Waiting for your answer in the Chrome prompt.</p>
    <p id="help" hidden>To change this later, open <code>chrome://settings/content/microphone</code>, find VoiceType under "Not allowed to use your microphone" and set it to Allow. Then press REC again.</p>
  </main>
  <script src="permission.js"></script>
</body>
</html>
```

`src/offscreen/permission.js`:

```js
// One-time microphone grant page. The offscreen document cannot show Chrome's permission
// prompt, so this tab asks once for the extension origin and reports the answer.
import { MSG } from '../shared/messages.js';

const CLOSE_DELAY_MS = 1500;

const statusEl = /** @type {HTMLElement} */ (document.getElementById('status'));
const helpEl = /** @type {HTMLElement} */ (document.getElementById('help'));

/** @param {boolean} granted */
function report(granted) {
  chrome.runtime.sendMessage({ action: MSG.PERMISSION_RESULT, granted }).catch(() => {});
}

async function requestMicrophone() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    report(true);
    statusEl.textContent = 'Microphone allowed. You can close this tab and press REC again.';
    setTimeout(() => window.close(), CLOSE_DELAY_MS);
  } catch (err) {
    report(false);
    statusEl.textContent = err?.name === 'NotFoundError'
      ? 'No microphone found. Connect one, then press REC again.'
      : 'Microphone not allowed.';
    helpEl.hidden = false;
  }
}

requestMicrophone();
```

- [ ] **Step 11: Add the two entries and the two pages to `build.mjs`**

These edits apply to the `build.mjs` that Task 1 wrote. In it, replace the `ENTRIES` declaration:

```js
const ENTRIES = {
  background: 'src/background/index.js',
  content: 'src/content/index.js',
  popup: 'src/popup/popup.js',
};
```

with:

```js
const ENTRIES = {
  background: 'src/background/index.js',
  content: 'src/content/index.js',
  popup: 'src/popup/popup.js',
  offscreen: 'src/offscreen/offscreen.js',
  permission: 'src/offscreen/permission.js',
};
```

In `STATICS`, replace:

```js
  ['src/popup/popup.html', 'popup.html'],
  ['src/popup/popup.css', 'popup.css'],
```

with:

```js
  ['src/popup/popup.html', 'popup.html'],
  ['src/popup/popup.css', 'popup.css'],
  ['src/offscreen/offscreen.html', 'offscreen.html'],
  ['src/offscreen/permission.html', 'permission.html'],
```

Nothing else changes: `entryPoints: ENTRIES` and `absWorkingDir` already cover the new bundles, `copyStatic()` copies every `STATICS` pair, and the watcher derives its directories from `STATICS`, so `--watch` picks up `src/offscreen`.

- [ ] **Step 12: Build and check the output**

```bash
npm run build
ls dist
grep -rn "innerHTML\|outerHTML\|insertAdjacentHTML\|document.write" src/offscreen
```

Expected: the build lists `dist/offscreen.js` and `dist/permission.js` next to the three existing bundles and ends with `Done`; `ls dist` shows `offscreen.html` and `permission.html`; the grep prints nothing.

- [ ] **Step 13: Run the full suite**

```bash
npm test
```

Expected: all green; report `N/N`, the Task 4 total plus 44. Replayed on the full plan: 21 files, 301/301 (Task 4 ends at 257/257).

- [ ] **Step 14: Commit**

```bash
git add src/offscreen test/unit/offscreen build.mjs
git commit -m "Add the offscreen capture with silence auto-stop and the microphone permission page"
```

---

### Task 6: Service worker recorder and wiring

**Files:**
- Create: `src/background/recorder.js`, `src/background/offscreen-client.js`
- Modify: `src/background/index.js`, `src/background/tabs.js`, `manifest.json`, `build.mjs` (esbuild target `chrome140`)
- Test: `test/unit/background/recorder.test.js`, `test/unit/background/offscreen-client.test.js`, `test/unit/background/tabs.test.js`, `test/unit/background/index.test.js`, `test/unit/manifest.test.js`

**Interfaces:**
- Consumes: Task 3 `MSG` and typedefs; Task 4 `createRouter`, `createDictate`, `createStorage`; Task 5 offscreen messages.
- Produces:
  - `src/background/offscreen-client.js` `createOffscreenClient({ runtime, offscreen, path = 'offscreen.html' }) => { ensure(): Promise<void>, send(message): Promise<any> }`. `ensure` checks `runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })`, shares one in-flight `offscreen.createDocument({ url: runtime.getURL(path), reasons: ['USER_MEDIA'], justification: 'Record dictation audio from the microphone.' })` promise reset in `finally`, and treats a rejection whose message matches `/single offscreen document/i` as success. `send` is `runtime.sendMessage(message)`.
  - `src/background/recorder.js` `createRecorder(deps)`, `deps = { ensureOffscreen: () => Promise<void>, toOffscreen: (message) => Promise<any>, toTab: (endpoint: { tabId: number, frameId: number }, message) => Promise<boolean>, openPermissionPage: () => Promise<void>, getSettings: () => Promise<Settings>, dictate: (input) => Promise<DictationMessage> }`. `toTab` resolves `false` when no receiver exists. Returns:
    - `start(endpoint): Promise<StartResponse>`: busy when a session exists for another endpoint or is processing (`'VoiceType is busy in another tab. Try again in a moment.'`); idempotent `{ ok: true }` when this endpoint is already recording; `noKey` when the active provider's key is blank after trim (`'Add an API key in the VoiceType popup.'`); otherwise creates the session `{ endpoint, state: 'starting', modeKey: settings.activeMode, minSec: settings.minRecordingTime }`, ensures the offscreen document, sends `OFFSCREEN_START { maxSec: settings.maxRecordingTime, silenceSec: settings.autoStopSilenceSec }`. On `needsPermission`: frees the session, remembers `pendingPermission = endpoint`, calls `openPermissionPage()` once, returns `{ ok: false, reason: 'needsPermission', error: 'Allow the microphone in the VoiceType tab that just opened, then press REC again.' }`. On `denied`: frees the session, returns `'Microphone blocked for VoiceType. Allow it at chrome://settings/content/microphone.'`. On `micError` or a thrown send: frees the session and returns the offscreen error text or `'Could not start the microphone.'`. On success: state `'recording'`; if a stop arrived while starting, stops immediately.
    - `stop(endpoint): Promise<{ ok: boolean }>`: `{ ok: false }` unless the endpoint owns the session; while starting, records the stop request; while recording, sets state `'processing'` and sends `OFFSCREEN_STOP { discard: false }`.
    - `cancel(endpoint): Promise<{ ok: boolean }>`: owner only; sends `OFFSCREEN_STOP { discard: true }` (errors swallowed) and frees the session.
    - `onLevel(level: number): void`: relays `{ action: MSG.AUDIO_LEVEL, level }` to the session frame while recording; a `false` delivery cancels the session (the frame navigated or closed).
    - `onDone(payload: OffscreenDone): Promise<void>`: ignored without a session. For `reason !== 'user'` first sends `RECORDING_STATE { state: 'processing', reason }`. If `durationSec < minSec` the message is `{ success: false, error: 'Too short, ignored', tone: 'warning' }` and no provider call is made; otherwise `await dictate({ audioBase64, mimeType, modeKey, durationSec })`. The session is freed before delivery, then `DICTATION_RESULT` goes to the session frame.
    - `onOffscreenError({ error }): Promise<void>`: frees the session and sends `RECORDING_STATE { state: 'idle', reason: 'error', notice: { text: 'Recording failed. Try again.', tone: 'error' } }`.
    - `onPermissionResult({ granted }): Promise<void>`: to `pendingPermission` sends `RECORDING_STATE { state: 'idle', reason: 'permission', notice: granted ? { text: 'Microphone allowed. Press REC again.', tone: 'success' } : { text: 'Microphone not allowed.', tone: 'error' } }`, then clears it.
    - `onTabRemoved(tabId: number): Promise<void>`: cancels a starting or recording session in that tab (a processing session finishes and its result is dropped by `toTab`); clears a matching `pendingPermission`.
    - `readonly session: null | { endpoint, state: 'starting'|'recording'|'processing', modeKey: string, minSec: number }`.
  - `src/background/index.js`: builds `offscreenClient`, `recorder` (with `toTab` wrapping `chrome.tabs.sendMessage(tabId, message, { frameId })` to `true`/`false`, `openPermissionPage` as `chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') })`), `dictate`, router with `identify` bound to `chrome.runtime.id`, the extension origin and `chrome.runtime.getURL('offscreen.html')`. Adds `chrome.tabs.onRemoved` to `recorder.onTabRemoved`. `chrome.runtime.onInstalled` re-injects `content.js` into every tab matching `['http://*/*', 'https://*/*', 'file:///*']` with `chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] })`, each call caught. Removes the `chrome.commands` listener and `toggleActiveTab`.
  - `manifest.json`: `permissions: ["storage", "scripting", "offscreen"]`, `host_permissions: ["<all_urls>"]`, `minimum_chrome_version: "140"`, `commands` removed. (Content script keys change in Task 11; version in Task 14.)
  - `test/unit/manifest.test.js` pins the permission set, host permission, minimum version and the absence of `commands`.

**Writer notes (verified during planning):**

- `toTab` is `sendToFrame(chrome.tabs, endpoint, message)`: it resolves `false` only for "Receiving end does not exist" or "No tab with id"; any other rejection (for example "The message port closed before a response was received.", which some Chrome paths raise when a listener returns `false` without answering) counts as delivered. Treating every rejection as undeliverable would cancel every session on its first level if Chrome rejects that case.
- Cancel during `'starting'` follows Task 5: `cancel()` and `onTabRemoved()` free the session and send `OFFSCREEN_STOP { discard: true }` at once (the offscreen capture aborts a pending start on it); the late start reply, whatever it says, resolves `{ ok: false, reason: 'micError', error: 'Recording cancelled.' }` without touching a newer session, opening the permission page or sending anything. A cancel that lands before `OFFSCREEN_START` is sent skips the start.
- Recorder behaviour the contract leaves open, now pinned: the same frame starting again while starting shares the in-flight result; the owner's `stop` while processing answers `{ ok: true }`; a failed `OFFSCREEN_STOP` send frees the session with the "Recording failed. Try again." notice; an undeliverable auto-stop notice drops the audio without a provider call; a throwing `dictate` delivers "Something went wrong. Try again." (tone error).
- Contract gap, not fixable here: a tab closed while processing loses its paid transcript (`toTab` drops it), so the "paid transcript is never discarded" constraint holds only while the frame exists.
- Verified on a scratch copy with task-01 to task-05 applied first: suite 360/360 after this task, build clean with the Task 5 entries.
- Controller: Step 16 also raises the esbuild target to `chrome140`.

- [ ] **Step 1: Write the failing offscreen client tests**

Create `test/unit/background/offscreen-client.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { createOffscreenClient } from '../../../src/background/offscreen-client.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakes({ contexts = [] } = {}) {
  const runtime = {
    getContexts: vi.fn(async () => contexts),
    getURL: (path) => `chrome-extension://abc/${path}`,
    sendMessage: vi.fn(async () => ({ ok: true })),
  };
  const offscreen = { createDocument: vi.fn(async () => {}) };
  return { runtime, offscreen, client: createOffscreenClient({ runtime, offscreen }) };
}

describe('createOffscreenClient', () => {
  it('creates the USER_MEDIA document from the full extension URL', async () => {
    const { runtime, offscreen, client } = fakes();
    await client.ensure();
    expect(runtime.getContexts).toHaveBeenCalledWith({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    expect(offscreen.createDocument).toHaveBeenCalledWith({
      url: 'chrome-extension://abc/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Record dictation audio from the microphone.',
    });
  });

  it('skips creation when an offscreen document already exists', async () => {
    const { offscreen, client } = fakes({ contexts: [{ contextType: 'OFFSCREEN_DOCUMENT' }] });
    await client.ensure();
    expect(offscreen.createDocument).not.toHaveBeenCalled();
  });

  it('shares one in-flight create between concurrent callers', async () => {
    const { offscreen, client } = fakes();
    const pending = deferred();
    offscreen.createDocument.mockImplementation(() => pending.promise);
    const first = client.ensure();
    const second = client.ensure();
    await vi.waitFor(() => expect(offscreen.createDocument).toHaveBeenCalledTimes(1));
    pending.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(offscreen.createDocument).toHaveBeenCalledTimes(1);
  });

  it('treats the "single offscreen document" rejection as success', async () => {
    const { offscreen, client } = fakes();
    offscreen.createDocument.mockRejectedValueOnce(new Error('Only a single offscreen document may be created.'));
    await expect(client.ensure()).resolves.toBeUndefined();
  });

  it('rethrows other creation errors and tries again on the next call', async () => {
    const { offscreen, client } = fakes();
    offscreen.createDocument.mockRejectedValueOnce(new Error('Invalid reason'));
    await expect(client.ensure()).rejects.toThrow('Invalid reason');
    await expect(client.ensure()).resolves.toBeUndefined();
    expect(offscreen.createDocument).toHaveBeenCalledTimes(2);
  });

  it('honours a custom document path', async () => {
    const { runtime, offscreen } = fakes();
    await createOffscreenClient({ runtime, offscreen, path: 'rec.html' }).ensure();
    expect(offscreen.createDocument.mock.calls[0][0].url).toBe('chrome-extension://abc/rec.html');
  });

  it('send forwards the message to runtime.sendMessage', async () => {
    const { runtime, client } = fakes();
    const message = { action: 'offscreenStop', discard: true };
    await expect(client.send(message)).resolves.toEqual({ ok: true });
    expect(runtime.sendMessage).toHaveBeenCalledWith(message);
  });
});
```

- [ ] **Step 2: Run the offscreen client tests to verify they fail**

```bash
npx vitest run test/unit/background/offscreen-client.test.js
```

Expected: FAIL with `Cannot find module '../../../src/background/offscreen-client.js'`.

- [ ] **Step 3: Create `src/background/offscreen-client.js`**

```js
const JUSTIFICATION = 'Record dictation audio from the microphone.';

/**
 * The one offscreen document that records audio. Chrome allows a single offscreen document per
 * extension, so creation is shared between concurrent callers, and the "single offscreen document"
 * rejection (a create that raced ours, or one this worker forgot after a restart) counts as success.
 * @param {{
 *   runtime: Pick<typeof chrome.runtime, 'getContexts'|'getURL'|'sendMessage'>,
 *   offscreen: Pick<typeof chrome.offscreen, 'createDocument'>,
 *   path?: string,
 * }} deps
 * @returns {{ ensure: () => Promise<void>, send: (message: object) => Promise<any> }}
 */
export function createOffscreenClient({ runtime, offscreen, path = 'offscreen.html' }) {
  /** @type {Promise<void>|null} */
  let creating = null;

  async function ensure() {
    const contexts = await runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length > 0) return;
    if (!creating) {
      creating = offscreen
        .createDocument({ url: runtime.getURL(path), reasons: ['USER_MEDIA'], justification: JUSTIFICATION })
        .catch((err) => {
          if (!/single offscreen document/i.test(String(err?.message ?? err))) throw err;
        })
        .finally(() => { creating = null; });
    }
    await creating;
  }

  return {
    ensure,
    send: (message) => runtime.sendMessage(message),
  };
}
```

- [ ] **Step 4: Run the offscreen client tests to verify they pass**

```bash
npx vitest run test/unit/background/offscreen-client.test.js
```

Expected: 7 passed.

- [ ] **Step 5: Write the failing recorder tests**

Create `test/unit/background/recorder.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { createRecorder } from '../../../src/background/recorder.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings } from '../../../src/shared/defaults.js';

const A = { tabId: 1, frameId: 0 };
const A_CHILD = { tabId: 1, frameId: 5 };
const B = { tabId: 2, frameId: 0 };

const BUSY = { ok: false, reason: 'busy', error: 'VoiceType is busy in another tab. Try again in a moment.' };
const NEEDS_PERMISSION = { ok: false, reason: 'needsPermission', error: 'Allow the microphone in the VoiceType tab that just opened, then press REC again.' };
const DENIED = { ok: false, reason: 'denied', error: 'Microphone blocked for VoiceType. Allow it at chrome://settings/content/microphone.' };
const DICTATION = { success: true, text: 'final', raw: 'raw', cost: 0.001, warning: null };
const STOP = { action: MSG.OFFSCREEN_STOP, discard: false };
const DISCARD = { action: MSG.OFFSCREEN_STOP, discard: true };
const done = (over = {}) => ({ audioBase64: 'QUJD', mimeType: 'audio/webm', durationSec: 4.2, reason: 'user', ...over });

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Recorder over fake deps. `startReply` answers OFFSCREEN_START (a value, or a function returning one). */
function setup({ startReply = { ok: true }, settings: patch = {} } = {}) {
  const settings = { ...freshSettings(), activeMode: 'email', autoStopSilenceSec: 3, ...patch };
  if (!patch.keys) settings.keys = { openai: 'sk-test-123456', gemini: '' };
  const deps = {
    ensureOffscreen: vi.fn(async () => {}),
    toOffscreen: vi.fn(async (message) => {
      if (message.action !== MSG.OFFSCREEN_START) return { ok: true };
      return typeof startReply === 'function' ? startReply() : startReply;
    }),
    toTab: vi.fn(async () => true),
    openPermissionPage: vi.fn(async () => {}),
    getSettings: vi.fn(async () => settings),
    dictate: vi.fn(async () => ({ ...DICTATION })),
  };
  const recorder = createRecorder(deps);
  const offscreenMessages = () => deps.toOffscreen.mock.calls.map(([message]) => message);
  const tabMessages = () => deps.toTab.mock.calls.map(([endpoint, message]) => ({ endpoint, ...message }));
  return { deps, recorder, settings, offscreenMessages, tabMessages };
}

describe('start', () => {
  it('starts the offscreen capture with the recording limits and records the session', async () => {
    const { deps, recorder } = setup();
    expect(await recorder.start(A)).toEqual({ ok: true });
    expect(deps.ensureOffscreen.mock.invocationCallOrder[0]).toBeLessThan(deps.toOffscreen.mock.invocationCallOrder[0]);
    expect(deps.toOffscreen).toHaveBeenCalledWith({ action: MSG.OFFSCREEN_START, maxSec: 120, silenceSec: 3 });
    expect(recorder.session).toEqual({ endpoint: A, state: 'recording', modeKey: 'email', minSec: 1 });
  });

  it('busy from another endpoint', async () => {
    const { deps, recorder } = setup();
    await recorder.start(A);
    expect(await recorder.start(B)).toEqual(BUSY);
    expect(await recorder.start(A_CHILD)).toEqual(BUSY);
    expect(deps.toOffscreen).toHaveBeenCalledTimes(1);
    expect(recorder.session.endpoint).toEqual(A);
  });

  it('concurrent starts from two tabs: one records, the other is busy', async () => {
    const { deps, recorder } = setup();
    expect(await Promise.all([recorder.start(A), recorder.start(B)])).toEqual([{ ok: true }, BUSY]);
    expect(deps.toOffscreen).toHaveBeenCalledTimes(1);
  });

  it('busy while processing, even for the frame that recorded', async () => {
    const { recorder } = setup();
    await recorder.start(A);
    await recorder.stop(A);
    expect(await recorder.start(A)).toEqual(BUSY);
    expect(await recorder.start(B)).toEqual(BUSY);
  });

  it('idempotent start', async () => {
    const { deps, recorder } = setup();
    const [first, second] = await Promise.all([recorder.start(A), recorder.start(A)]);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(await recorder.start(A)).toEqual({ ok: true });
    expect(deps.toOffscreen).toHaveBeenCalledTimes(1);
  });

  it('noKey when the active provider has only whitespace', async () => {
    const { deps, recorder } = setup({ settings: { keys: { openai: '   ', gemini: 'AQ.gemini-key' } } });
    expect(await recorder.start(A)).toEqual({ ok: false, reason: 'noKey', error: 'Add an API key in the VoiceType popup.' });
    expect(recorder.session).toBeNull();
    expect(deps.ensureOffscreen).not.toHaveBeenCalled();
    expect(deps.toOffscreen).not.toHaveBeenCalled();
  });

  it('uses the key of the active provider', async () => {
    const { recorder } = setup({ settings: { provider: 'gemini', keys: { openai: '', gemini: 'AQ.gemini-key' } } });
    expect(await recorder.start(A)).toEqual({ ok: true });
  });

  it('needsPermission opens the page once and frees the session', async () => {
    const { deps, recorder } = setup({ startReply: { ok: false, reason: 'needsPermission', error: 'Microphone permission needed.' } });
    expect(await recorder.start(A)).toEqual(NEEDS_PERMISSION);
    expect(deps.openPermissionPage).toHaveBeenCalledTimes(1);
    expect(recorder.session).toBeNull();
    expect(await recorder.start(B)).toEqual(NEEDS_PERMISSION);
    expect(deps.openPermissionPage).toHaveBeenCalledTimes(2);
  });

  it('needsPermission still answers when the page cannot open', async () => {
    const { deps, recorder } = setup({ startReply: { ok: false, reason: 'needsPermission', error: 'Microphone permission needed.' } });
    deps.openPermissionPage.mockRejectedValueOnce(new Error('no tabs'));
    expect(await recorder.start(A)).toEqual(NEEDS_PERMISSION);
    expect(recorder.session).toBeNull();
  });

  it('denied frees the session with the settings hint', async () => {
    const { deps, recorder } = setup({ startReply: { ok: false, reason: 'denied', error: 'Microphone blocked.' } });
    expect(await recorder.start(A)).toEqual(DENIED);
    expect(recorder.session).toBeNull();
    expect(deps.openPermissionPage).not.toHaveBeenCalled();
    expect((await recorder.start(B)).reason).toBe('denied');
  });

  it('micError passes the offscreen text through and frees the session', async () => {
    const { recorder } = setup({ startReply: { ok: false, reason: 'micError', error: 'No microphone found.' } });
    expect(await recorder.start(A)).toEqual({ ok: false, reason: 'micError', error: 'No microphone found.' });
    expect(recorder.session).toBeNull();
  });

  it('a failed offscreen send or document creation frees the session', async () => {
    const { deps, recorder } = setup();
    deps.toOffscreen.mockRejectedValueOnce(new Error('Could not establish connection. Receiving end does not exist.'));
    expect(await recorder.start(A)).toEqual({ ok: false, reason: 'micError', error: 'Could not start the microphone.' });
    expect(recorder.session).toBeNull();
    deps.ensureOffscreen.mockRejectedValueOnce(new Error('Invalid reason'));
    expect(await recorder.start(A)).toEqual({ ok: false, reason: 'micError', error: 'Could not start the microphone.' });
    expect(recorder.session).toBeNull();
  });

  it('a failed settings read frees the session', async () => {
    const { deps, recorder } = setup();
    deps.getSettings.mockRejectedValueOnce(new Error('storage down'));
    expect(await recorder.start(A)).toEqual({ ok: false, reason: 'micError', error: 'Could not start the microphone.' });
    expect(recorder.session).toBeNull();
    expect(await recorder.start(A)).toEqual({ ok: true });
  });

  it('stop while starting stops as soon as the capture is up', async () => {
    const pending = deferred();
    const { recorder, offscreenMessages } = setup({ startReply: () => pending.promise });
    const started = recorder.start(A);
    await vi.waitFor(() => expect(offscreenMessages()).toHaveLength(1));
    expect(await recorder.stop(A)).toEqual({ ok: true });
    expect(recorder.session.state).toBe('starting');
    pending.resolve({ ok: true });
    expect(await started).toEqual({ ok: true });
    expect(offscreenMessages()).toContainEqual(STOP);
    expect(recorder.session.state).toBe('processing');
  });

  it('cancel while starting ignores the late start response', async () => {
    const replies = [deferred(), deferred()];
    let calls = 0;
    const { deps, recorder, offscreenMessages } = setup({ startReply: () => replies[calls++].promise });
    const startedA = recorder.start(A);
    await vi.waitFor(() => expect(offscreenMessages()).toHaveLength(1));
    expect(await recorder.cancel(A)).toEqual({ ok: true });
    expect(recorder.session).toBeNull();
    expect(offscreenMessages()).toEqual([expect.objectContaining({ action: MSG.OFFSCREEN_START }), DISCARD]);
    const startedB = recorder.start(B);
    await vi.waitFor(() => expect(offscreenMessages()).toHaveLength(3));
    replies[1].resolve({ ok: true });
    expect(await startedB).toEqual({ ok: true });
    replies[0].resolve({ ok: false, reason: 'needsPermission', error: 'Microphone permission needed.' });
    expect(await startedA).toEqual({ ok: false, reason: 'micError', error: 'Recording cancelled.' });
    expect(recorder.session).toEqual({ endpoint: B, state: 'recording', modeKey: 'email', minSec: 1 });
    expect(deps.openPermissionPage).not.toHaveBeenCalled();
    expect(offscreenMessages()).toHaveLength(3);
  });

  it('a cancel before the offscreen start is sent skips the start', async () => {
    const pending = deferred();
    const { deps, recorder, offscreenMessages } = setup();
    deps.ensureOffscreen.mockImplementationOnce(() => pending.promise);
    const started = recorder.start(A);
    await vi.waitFor(() => expect(deps.ensureOffscreen).toHaveBeenCalled());
    expect(await recorder.cancel(A)).toEqual({ ok: true });
    pending.resolve();
    expect(await started).toEqual({ ok: false, reason: 'micError', error: 'Recording cancelled.' });
    expect(offscreenMessages()).toEqual([DISCARD]);
  });
});

describe('stop and cancel', () => {
  it('stop sends the offscreen stop and moves to processing', async () => {
    const { recorder, offscreenMessages } = setup();
    await recorder.start(A);
    expect(await recorder.stop(A)).toEqual({ ok: true });
    expect(offscreenMessages()).toContainEqual(STOP);
    expect(recorder.session.state).toBe('processing');
    expect(await recorder.stop(A)).toEqual({ ok: true });
    expect(offscreenMessages().filter((m) => m.action === MSG.OFFSCREEN_STOP)).toHaveLength(1);
  });

  it('stop and cancel from anyone but the owner are refused', async () => {
    const { recorder } = setup();
    expect(await recorder.stop(A)).toEqual({ ok: false });
    expect(await recorder.cancel(A)).toEqual({ ok: false });
    await recorder.start(A);
    expect(await recorder.stop(B)).toEqual({ ok: false });
    expect(await recorder.cancel(A_CHILD)).toEqual({ ok: false });
    expect(recorder.session.state).toBe('recording');
  });

  it('cancel discards the capture and frees the session', async () => {
    const { deps, recorder, offscreenMessages } = setup();
    await recorder.start(A);
    expect(await recorder.cancel(A)).toEqual({ ok: true });
    expect(offscreenMessages()).toContainEqual(DISCARD);
    expect(recorder.session).toBeNull();
    expect(await recorder.start(B)).toEqual({ ok: true });
    expect(deps.dictate).not.toHaveBeenCalled();
  });

  it('cancel swallows an offscreen send failure', async () => {
    const { deps, recorder } = setup();
    await recorder.start(A);
    deps.toOffscreen.mockRejectedValueOnce(new Error('gone'));
    expect(await recorder.cancel(A)).toEqual({ ok: true });
    expect(recorder.session).toBeNull();
  });

  it('a failed offscreen stop frees the session with the error notice', async () => {
    const { deps, recorder, tabMessages } = setup();
    await recorder.start(A);
    deps.toOffscreen.mockRejectedValueOnce(new Error('gone'));
    expect(await recorder.stop(A)).toEqual({ ok: true });
    expect(recorder.session).toBeNull();
    expect(tabMessages()).toEqual([{
      endpoint: A, action: MSG.RECORDING_STATE, state: 'idle', reason: 'error',
      notice: { text: 'Recording failed. Try again.', tone: 'error' },
    }]);
  });
});

describe('levels', () => {
  it('relays levels to the session frame only while recording', async () => {
    const { deps, recorder, tabMessages } = setup();
    recorder.onLevel(0.3);
    await recorder.start(A_CHILD);
    recorder.onLevel(0.4);
    await flush();
    expect(tabMessages()).toEqual([{ endpoint: A_CHILD, action: MSG.AUDIO_LEVEL, level: 0.4 }]);
    await recorder.stop(A_CHILD);
    recorder.onLevel(0.5);
    await flush();
    expect(deps.toTab).toHaveBeenCalledTimes(1);
  });

  it('undeliverable level cancels the session', async () => {
    const { deps, recorder, offscreenMessages } = setup();
    await recorder.start(A);
    deps.toTab.mockResolvedValueOnce(false);
    recorder.onLevel(0.2);
    await vi.waitFor(() => expect(recorder.session).toBeNull());
    await vi.waitFor(() => expect(offscreenMessages()).toContainEqual(DISCARD));
    expect(deps.dictate).not.toHaveBeenCalled();
    expect(await recorder.start(B)).toEqual({ ok: true });
  });
});

describe('results', () => {
  it('delivers the dictation to the session frame after freeing the session', async () => {
    const { deps, recorder, tabMessages } = setup();
    await recorder.start(A_CHILD);
    await recorder.stop(A_CHILD);
    let sessionAtDelivery = 'unset';
    deps.toTab.mockImplementation(async () => { sessionAtDelivery = recorder.session; return true; });
    await recorder.onDone(done());
    expect(deps.dictate).toHaveBeenCalledWith({ audioBase64: 'QUJD', mimeType: 'audio/webm', modeKey: 'email', durationSec: 4.2 });
    expect(tabMessages()).toEqual([{ endpoint: A_CHILD, action: MSG.DICTATION_RESULT, ...DICTATION }]);
    expect(sessionAtDelivery).toBeNull();
    expect(recorder.session).toBeNull();
  });

  it('too-short without a provider call', async () => {
    const { deps, recorder, tabMessages } = setup();
    await recorder.start(A);
    await recorder.stop(A);
    await recorder.onDone(done({ durationSec: 0.4 }));
    expect(deps.dictate).not.toHaveBeenCalled();
    expect(tabMessages()).toEqual([{ endpoint: A, action: MSG.DICTATION_RESULT, success: false, error: 'Too short, ignored', tone: 'warning' }]);
    expect(recorder.session).toBeNull();
  });

  for (const reason of ['maxTime', 'silence', 'ended']) {
    it(`auto-stop reason ${reason} sends RECORDING_STATE processing before the result`, async () => {
      const { deps, recorder, tabMessages } = setup();
      await recorder.start(A);
      await recorder.onDone(done({ reason }));
      expect(tabMessages()).toEqual([
        { endpoint: A, action: MSG.RECORDING_STATE, state: 'processing', reason },
        { endpoint: A, action: MSG.DICTATION_RESULT, ...DICTATION },
      ]);
      expect(deps.toTab.mock.invocationCallOrder[0]).toBeLessThan(deps.dictate.mock.invocationCallOrder[0]);
      expect(recorder.session).toBeNull();
    });
  }

  it('an undeliverable auto-stop notice drops the audio without a provider call', async () => {
    const { deps, recorder } = setup();
    await recorder.start(A);
    deps.toTab.mockResolvedValueOnce(false);
    await recorder.onDone(done({ reason: 'silence' }));
    expect(deps.dictate).not.toHaveBeenCalled();
    expect(recorder.session).toBeNull();
  });

  it('ignores a result without a session', async () => {
    const { deps, recorder } = setup();
    await recorder.onDone(done());
    expect(deps.dictate).not.toHaveBeenCalled();
    expect(deps.toTab).not.toHaveBeenCalled();
  });

  it('a throwing dictate still frees the session and reports an error', async () => {
    const { deps, recorder, tabMessages } = setup();
    await recorder.start(A);
    await recorder.stop(A);
    deps.dictate.mockRejectedValueOnce(new Error('bug'));
    await recorder.onDone(done());
    expect(tabMessages()).toEqual([{ endpoint: A, action: MSG.DICTATION_RESULT, success: false, error: 'Something went wrong. Try again.', tone: 'error' }]);
    expect(recorder.session).toBeNull();
  });

  it('offscreen error frees the session and tells the frame', async () => {
    const { recorder, tabMessages } = setup();
    await recorder.onOffscreenError({ error: 'Recording failed.' });
    expect(tabMessages()).toEqual([]);
    await recorder.start(A);
    await recorder.onOffscreenError({ error: 'Recording failed.' });
    expect(tabMessages()).toEqual([{
      endpoint: A, action: MSG.RECORDING_STATE, state: 'idle', reason: 'error',
      notice: { text: 'Recording failed. Try again.', tone: 'error' },
    }]);
    expect(recorder.session).toBeNull();
    expect(await recorder.start(B)).toEqual({ ok: true });
  });
});

describe('permission and tabs', () => {
  it('permission result delivery', async () => {
    const { recorder, tabMessages } = setup({ startReply: { ok: false, reason: 'needsPermission', error: 'Microphone permission needed.' } });
    await recorder.onPermissionResult({ granted: true });
    expect(tabMessages()).toEqual([]);
    await recorder.start(A_CHILD);
    await recorder.onPermissionResult({ granted: true });
    await recorder.onPermissionResult({ granted: true });
    expect(tabMessages()).toEqual([{
      endpoint: A_CHILD, action: MSG.RECORDING_STATE, state: 'idle', reason: 'permission',
      notice: { text: 'Microphone allowed. Press REC again.', tone: 'success' },
    }]);
  });

  it('a refused permission tells the frame', async () => {
    const { recorder, tabMessages } = setup({ startReply: { ok: false, reason: 'needsPermission', error: 'Microphone permission needed.' } });
    await recorder.start(B);
    await recorder.onPermissionResult({ granted: false });
    expect(tabMessages()).toEqual([{
      endpoint: B, action: MSG.RECORDING_STATE, state: 'idle', reason: 'permission',
      notice: { text: 'Microphone not allowed.', tone: 'error' },
    }]);
  });

  it('tab removed while recording frees the session', async () => {
    const { deps, recorder, offscreenMessages } = setup();
    await recorder.start(A);
    await recorder.onTabRemoved(2);
    expect(recorder.session.state).toBe('recording');
    await recorder.onTabRemoved(1);
    expect(recorder.session).toBeNull();
    expect(offscreenMessages()).toContainEqual(DISCARD);
    await recorder.onDone(done());
    expect(deps.dictate).not.toHaveBeenCalled();
    expect(await recorder.start(B)).toEqual({ ok: true });
  });

  it('tab removed while starting stops the capture and ignores the late start response', async () => {
    const pending = deferred();
    const { recorder, offscreenMessages } = setup({ startReply: () => pending.promise });
    const started = recorder.start(A);
    await vi.waitFor(() => expect(offscreenMessages()).toHaveLength(1));
    await recorder.onTabRemoved(1);
    expect(recorder.session).toBeNull();
    expect(offscreenMessages()).toEqual([expect.objectContaining({ action: MSG.OFFSCREEN_START }), DISCARD]);
    pending.resolve({ ok: true });
    expect(await started).toEqual({ ok: false, reason: 'micError', error: 'Recording cancelled.' });
    expect(offscreenMessages()).toHaveLength(2);
    expect(recorder.session).toBeNull();
  });

  it('tab removed while processing lets the dictation finish', async () => {
    const { deps, recorder } = setup();
    await recorder.start(A);
    await recorder.stop(A);
    await recorder.onTabRemoved(1);
    expect(recorder.session.state).toBe('processing');
    await recorder.onDone(done());
    expect(deps.dictate).toHaveBeenCalledTimes(1);
  });

  it('tab removed clears a pending permission for that tab', async () => {
    const { recorder, tabMessages } = setup({ startReply: { ok: false, reason: 'needsPermission', error: 'Microphone permission needed.' } });
    await recorder.start(A);
    await recorder.onTabRemoved(1);
    await recorder.onPermissionResult({ granted: true });
    expect(tabMessages()).toEqual([]);
  });
});
```

- [ ] **Step 6: Run the recorder tests to verify they fail**

```bash
npx vitest run test/unit/background/recorder.test.js
```

Expected: FAIL with `Cannot find module '../../../src/background/recorder.js'`.

- [ ] **Step 7: Create `src/background/recorder.js`**

```js
// The single recording session. The offscreen document captures audio; this module decides who
// may record, relays levels and results to the exact frame that asked, and frees the session on
// every path so a closed tab or a lost frame never leaves the microphone on or the next start busy.
import { MSG } from '../shared/messages.js';

const BUSY = 'VoiceType is busy in another tab. Try again in a moment.';
const NO_KEY = 'Add an API key in the VoiceType popup.';
const NEEDS_PERMISSION = 'Allow the microphone in the VoiceType tab that just opened, then press REC again.';
const DENIED = 'Microphone blocked for VoiceType. Allow it at chrome://settings/content/microphone.';
const MIC_ERROR = 'Could not start the microphone.';
const CANCELLED = 'Recording cancelled.';
const FAILED_NOTICE = Object.freeze({ text: 'Recording failed. Try again.', tone: 'error' });

/**
 * @typedef {{ tabId: number, frameId: number }} Endpoint
 * @typedef {{ endpoint: Endpoint, state: 'starting'|'recording'|'processing', modeKey: string, minSec: number }} Session
 * @typedef {import('../shared/messages.js').StartResponse} StartResponse
 */

/**
 * @param {{
 *   ensureOffscreen: () => Promise<void>,
 *   toOffscreen: (message: object) => Promise<any>,
 *   toTab: (endpoint: Endpoint, message: object) => Promise<boolean>,
 *   openPermissionPage: () => Promise<void>,
 *   getSettings: () => Promise<import('../shared/defaults.js').Settings>,
 *   dictate: (input: { audioBase64: string, mimeType: string, modeKey: string, durationSec: number }) => Promise<import('../shared/messages.js').DictationMessage>,
 * }} deps
 */
export function createRecorder({ ensureOffscreen, toOffscreen, toTab, openPermissionPage, getSettings, dictate }) {
  /** @type {null | (Session & { stopRequested: boolean, starting: Promise<StartResponse>|null })} */
  let session = null;
  /** @type {Endpoint|null} */
  let pendingPermission = null;

  const fail = (reason, error) => ({ ok: false, reason, error });
  const owns = (endpoint) => session !== null
    && session.endpoint.tabId === endpoint.tabId && session.endpoint.frameId === endpoint.frameId;

  /** Stop the capture without a result. The microphone is released; errors are irrelevant here. */
  async function discard() {
    try {
      await toOffscreen({ action: MSG.OFFSCREEN_STOP, discard: true });
    } catch {
      // No offscreen document means no capture to stop.
    }
  }

  /**
   * Free a session that will produce no result. The offscreen document also aborts a start that
   * is still opening the microphone when this stop arrives, so it covers every state.
   */
  async function drop(s) {
    if (session !== s) return;
    session = null;
    await discard();
  }

  /** Free the session and tell its frame that the recording failed. */
  async function failSession(s) {
    if (session !== s) return;
    session = null;
    await toTab(s.endpoint, { action: MSG.RECORDING_STATE, state: 'idle', reason: 'error', notice: FAILED_NOTICE });
  }

  /** Ask the offscreen document for the audio; it arrives as OFFSCREEN_DONE. */
  async function finish(s) {
    s.state = 'processing';
    try {
      await toOffscreen({ action: MSG.OFFSCREEN_STOP, discard: false });
    } catch {
      // The offscreen document is gone, so no audio will ever arrive.
      await failSession(s);
    }
  }

  /** @returns {Promise<StartResponse>} */
  async function begin(s) {
    let settings;
    try {
      settings = await getSettings();
    } catch {
      settings = null;
    }
    if (session !== s) return fail('micError', CANCELLED);
    if (!settings) {
      session = null;
      return fail('micError', MIC_ERROR);
    }
    const key = settings.keys?.[settings.provider];
    if (typeof key !== 'string' || !key.trim()) {
      session = null;
      return fail('noKey', NO_KEY);
    }
    s.modeKey = settings.activeMode;
    s.minSec = settings.minRecordingTime;

    let reply = null;
    try {
      await ensureOffscreen();
      if (session === s) {
        reply = await toOffscreen({ action: MSG.OFFSCREEN_START, maxSec: settings.maxRecordingTime, silenceSec: settings.autoStopSilenceSec });
      }
    } catch {
      reply = null;
    }
    // Freed while starting (CANCEL, tab closed): drop() already stopped the capture, and this late
    // reply must not touch a newer session, open the permission page or send anything.
    if (session !== s) return fail('micError', CANCELLED);
    if (reply?.ok) {
      s.state = 'recording';
      if (s.stopRequested) await finish(s);
      return { ok: true };
    }
    session = null;
    if (reply?.reason === 'needsPermission') {
      pendingPermission = s.endpoint;
      try {
        await openPermissionPage();
      } catch {
        // The start response still tells the user what to do.
      }
      return fail('needsPermission', NEEDS_PERMISSION);
    }
    if (reply?.reason === 'denied') return fail('denied', DENIED);
    return fail('micError', typeof reply?.error === 'string' && reply.error ? reply.error : MIC_ERROR);
  }

  return {
    /**
     * @param {Endpoint} endpoint
     * @returns {Promise<StartResponse>}
     */
    async start(endpoint) {
      if (session) {
        if (!owns(endpoint) || session.state === 'processing') return fail('busy', BUSY);
        // The same frame asked again: recording already, or share the start in flight.
        return session.state === 'recording' ? { ok: true } : session.starting;
      }
      // Reserve synchronously so a start from another frame during the awaits below is busy.
      const s = { endpoint: { ...endpoint }, state: 'starting', modeKey: 'default', minSec: 0, stopRequested: false, starting: null };
      session = s;
      s.starting = begin(s);
      return s.starting;
    },

    /**
     * @param {Endpoint} endpoint
     * @returns {Promise<{ ok: boolean }>}
     */
    async stop(endpoint) {
      if (!owns(endpoint)) return { ok: false };
      const s = session;
      if (s.state === 'starting') s.stopRequested = true;
      else if (s.state === 'recording') await finish(s);
      return { ok: true };
    },

    /**
     * @param {Endpoint} endpoint
     * @returns {Promise<{ ok: boolean }>}
     */
    async cancel(endpoint) {
      if (!owns(endpoint)) return { ok: false };
      await drop(session);
      return { ok: true };
    },

    /** @param {number} level */
    onLevel(level) {
      const s = session;
      if (!s || s.state !== 'recording') return;
      toTab(s.endpoint, { action: MSG.AUDIO_LEVEL, level }).then((delivered) => {
        // No receiver: the frame navigated or closed, so nobody is left to stop this recording.
        if (!delivered && session === s && s.state === 'recording') return drop(s);
      }, () => {});
    },

    /** @param {import('../shared/messages.js').OffscreenDone} payload */
    async onDone(payload) {
      const s = session;
      if (!s) return;
      if (payload?.reason !== 'user') {
        s.state = 'processing';
        const delivered = await toTab(s.endpoint, { action: MSG.RECORDING_STATE, state: 'processing', reason: payload?.reason });
        if (!delivered && session === s) session = null;
        if (session !== s) return; // the frame is gone or the owner cancelled: no provider call
      }
      s.state = 'processing';
      const durationSec = Number(payload?.durationSec) || 0;
      /** @type {import('../shared/messages.js').DictationMessage} */
      let message;
      if (durationSec < s.minSec) {
        message = { success: false, error: 'Too short, ignored', tone: 'warning' };
      } else {
        try {
          message = await dictate({ audioBase64: payload.audioBase64, mimeType: payload.mimeType, modeKey: s.modeKey, durationSec });
        } catch {
          message = { success: false, error: 'Something went wrong. Try again.', tone: 'error' };
        }
      }
      if (session === s) session = null;
      await toTab(s.endpoint, { action: MSG.DICTATION_RESULT, ...message });
    },

    /** @param {{ error?: string }} _payload */
    async onOffscreenError(_payload) {
      if (session) await failSession(session);
    },

    /** @param {{ granted: boolean }} payload */
    async onPermissionResult({ granted }) {
      const endpoint = pendingPermission;
      if (!endpoint) return;
      pendingPermission = null;
      const notice = granted
        ? { text: 'Microphone allowed. Press REC again.', tone: 'success' }
        : { text: 'Microphone not allowed.', tone: 'error' };
      await toTab(endpoint, { action: MSG.RECORDING_STATE, state: 'idle', reason: 'permission', notice });
    },

    /** @param {number} tabId */
    async onTabRemoved(tabId) {
      if (pendingPermission?.tabId === tabId) pendingPermission = null;
      const s = session;
      // A processing session finishes; its result is simply undeliverable.
      if (s && s.endpoint.tabId === tabId && s.state !== 'processing') await drop(s);
    },

    /** @returns {Session|null} */
    get session() {
      if (!session) return null;
      const { endpoint, state, modeKey, minSec } = session;
      return { endpoint: { ...endpoint }, state, modeKey, minSec };
    },
  };
}
```

- [ ] **Step 8: Run the recorder tests to verify they pass**

```bash
npx vitest run test/unit/background/recorder.test.js
```

Expected: 38 passed, including "undeliverable level cancels the session", "tab removed while recording frees the session", "needsPermission opens the page once and frees the session", "denied frees the session with the settings hint" and "cancel while starting ignores the late start response".

- [ ] **Step 9: Run the suite and commit**

```bash
npm test
git add src/background/offscreen-client.js src/background/recorder.js test/unit/background/offscreen-client.test.js test/unit/background/recorder.test.js
git commit -m "Add the offscreen client and the single recording session"
```

Expected: all green before the commit. Report N/N.

- [ ] **Step 10: Write the failing tab helper tests**

Replace the whole of `test/unit/background/tabs.test.js` with:

```js
import { describe, it, expect, vi } from 'vitest';
import { broadcast, sendToFrame, reinject, REINJECT_URLS } from '../../../src/background/tabs.js';

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';

describe('broadcast', () => {
  it('sends the message to every tab with an id, all frames', async () => {
    const tabsApi = {
      query: vi.fn(async () => [{ id: 1 }, { id: 2 }, {}]),
      sendMessage: vi.fn(async () => undefined),
    };
    const message = { action: 'settingsChanged', settings: { provider: 'openai' } };
    await broadcast(tabsApi, message);
    expect(tabsApi.query).toHaveBeenCalledWith({});
    expect(tabsApi.sendMessage.mock.calls).toEqual([[1, message], [2, message]]);
  });

  it('a tab without a receiver does not stop the others', async () => {
    const tabsApi = {
      query: vi.fn(async () => [{ id: 1 }, { id: 2 }]),
      sendMessage: vi.fn(async (id) => { if (id === 1) throw new Error(NO_RECEIVER); }),
    };
    await expect(broadcast(tabsApi, { action: 'x' })).resolves.toBeUndefined();
    expect(tabsApi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('resolves when the tab query fails', async () => {
    const tabsApi = { query: vi.fn(async () => { throw new Error('no'); }), sendMessage: vi.fn() };
    await expect(broadcast(tabsApi, { action: 'x' })).resolves.toBeUndefined();
    expect(tabsApi.sendMessage).not.toHaveBeenCalled();
  });
});

describe('sendToFrame', () => {
  it('sends to one frame and reports delivery', async () => {
    const tabsApi = { sendMessage: vi.fn(async () => undefined) };
    const message = { action: 'audioLevel', level: 0.5 };
    expect(await sendToFrame(tabsApi, { tabId: 4, frameId: 2 }, message)).toBe(true);
    expect(tabsApi.sendMessage).toHaveBeenCalledWith(4, message, { frameId: 2 });
  });

  it('reports false when the frame or tab has no receiver', async () => {
    const tabsApi = { sendMessage: vi.fn(async () => { throw new Error(NO_RECEIVER); }) };
    expect(await sendToFrame(tabsApi, { tabId: 4, frameId: 0 }, { action: 'x' })).toBe(false);
    tabsApi.sendMessage.mockRejectedValueOnce(new Error('No tab with id: 4.'));
    expect(await sendToFrame(tabsApi, { tabId: 4, frameId: 0 }, { action: 'x' })).toBe(false);
  });

  it('counts a receiver that sent no response as delivered', async () => {
    const tabsApi = { sendMessage: vi.fn(async () => { throw new Error('The message port closed before a response was received.'); }) };
    expect(await sendToFrame(tabsApi, { tabId: 4, frameId: 0 }, { action: 'x' })).toBe(true);
  });
});

describe('reinject', () => {
  it('injects content.js into every frame of every web and file tab', async () => {
    const tabsApi = { query: vi.fn(async () => [{ id: 1 }, { id: 2 }, {}]) };
    const scriptingApi = { executeScript: vi.fn(async () => []) };
    await reinject(tabsApi, scriptingApi);
    expect(REINJECT_URLS).toEqual(['http://*/*', 'https://*/*', 'file:///*']);
    expect(tabsApi.query).toHaveBeenCalledWith({ url: REINJECT_URLS });
    expect(scriptingApi.executeScript.mock.calls).toEqual([
      [{ target: { tabId: 1, allFrames: true }, files: ['content.js'] }],
      [{ target: { tabId: 2, allFrames: true }, files: ['content.js'] }],
    ]);
  });

  it('a tab that refuses injection does not stop the others', async () => {
    const tabsApi = { query: vi.fn(async () => [{ id: 1 }, { id: 2 }]) };
    const scriptingApi = {
      executeScript: vi.fn(async ({ target }) => { if (target.tabId === 1) throw new Error('Cannot access contents of the page.'); return []; }),
    };
    await expect(reinject(tabsApi, scriptingApi)).resolves.toBeUndefined();
    expect(scriptingApi.executeScript).toHaveBeenCalledTimes(2);
  });

  it('resolves when the tab query fails', async () => {
    const tabsApi = { query: vi.fn(async () => { throw new Error('no'); }) };
    const scriptingApi = { executeScript: vi.fn() };
    await expect(reinject(tabsApi, scriptingApi)).resolves.toBeUndefined();
    expect(scriptingApi.executeScript).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 11: Run the tab helper tests to verify they fail**

```bash
npx vitest run test/unit/background/tabs.test.js
```

Expected: 6 failed, 3 passed: `TypeError: sendToFrame is not a function` (3) and `TypeError: reinject is not a function` (3); the `broadcast` tests still pass.

- [ ] **Step 12: Rewrite `src/background/tabs.js`**

Replace the whole file with:

```js
// Service worker helpers for talking to tabs. The chrome APIs are passed in so they stay testable.

/** Tabs whose content scripts are orphaned by an install or update and can take the new one. */
export const REINJECT_URLS = Object.freeze(['http://*/*', 'https://*/*', 'file:///*']);

/** Errors that mean nobody is listening in that frame (it navigated, closed or never had us). */
const NO_RECEIVER = /Receiving end does not exist|No tab with id/i;

/**
 * Send a message to every frame of every tab. Tabs without a receiver are skipped; never rejects.
 * @param {{ query: (info: object) => Promise<Array<{ id?: number }>>, sendMessage: (tabId: number, message: unknown) => Promise<unknown> }} tabsApi
 * @param {unknown} message
 * @returns {Promise<void>}
 */
export async function broadcast(tabsApi, message) {
  let tabs;
  try {
    tabs = await tabsApi.query({});
  } catch {
    return;
  }
  const ids = tabs.map((tab) => tab.id).filter((id) => typeof id === 'number');
  await Promise.all(ids.map((id) => tabsApi.sendMessage(id, message).catch(() => {})));
}

/**
 * Send a message to one frame. Resolves false only when the frame has no receiver; a listener
 * that answers nothing still counts as delivered.
 * @param {{ sendMessage: (tabId: number, message: unknown, options: { frameId: number }) => Promise<unknown> }} tabsApi
 * @param {{ tabId: number, frameId: number }} endpoint
 * @param {unknown} message
 * @returns {Promise<boolean>}
 */
export async function sendToFrame(tabsApi, { tabId, frameId }, message) {
  try {
    await tabsApi.sendMessage(tabId, message, { frameId });
    return true;
  } catch (err) {
    return !NO_RECEIVER.test(String(err?.message ?? err));
  }
}

/**
 * Inject content.js into every frame of every open web and file tab. Pages that refuse
 * injection (the Web Store, file URLs without access) are skipped; never rejects.
 * @param {{ query: (info: { url: string[] }) => Promise<Array<{ id?: number }>> }} tabsApi
 * @param {{ executeScript: (injection: { target: { tabId: number, allFrames: boolean }, files: string[] }) => Promise<unknown> }} scriptingApi
 * @returns {Promise<void>}
 */
export async function reinject(tabsApi, scriptingApi) {
  let tabs;
  try {
    tabs = await tabsApi.query({ url: REINJECT_URLS });
  } catch {
    return;
  }
  const ids = tabs.map((tab) => tab.id).filter((id) => typeof id === 'number');
  await Promise.all(ids.map((tabId) => scriptingApi
    .executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] })
    .catch(() => {})));
}
```

- [ ] **Step 13: Run the tab helper tests to verify they pass**

```bash
npx vitest run test/unit/background/tabs.test.js
```

Expected: 9 passed.

- [ ] **Step 14: Write the failing manifest test**

Create `test/unit/manifest.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));

describe('manifest', () => {
  it('asks for exactly storage, scripting and offscreen', () => {
    expect([...manifest.permissions].sort()).toEqual(['offscreen', 'scripting', 'storage']);
  });

  it('holds the all-URLs host permission used to re-inject content scripts', () => {
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
  });

  it('requires Chrome 140 for storage access levels', () => {
    expect(manifest.minimum_chrome_version).toBe('140');
  });

  it('declares no commands; the hotkey lives in the content script', () => {
    expect(manifest).not.toHaveProperty('commands');
  });
});
```

- [ ] **Step 15: Run the manifest test to verify it fails**

```bash
npx vitest run test/unit/manifest.test.js
```

Expected: 4 failed (`activeTab` present and `offscreen` missing, the two provider host permissions, `"116"`, and the `commands` key).

- [ ] **Step 16: Update `manifest.json`**

Replace

```json
  "permissions": ["storage", "activeTab", "scripting"],
  "host_permissions": [
    "https://api.openai.com/*",
    "https://generativelanguage.googleapis.com/*"
  ],
```

with

```json
  "permissions": ["storage", "scripting", "offscreen"],
  "host_permissions": ["<all_urls>"],
```

Replace

```json
  "commands": {
    "toggle-recording": {
      "suggested_key": { "default": "Ctrl+Shift+Space", "mac": "Command+Shift+Space" },
      "description": "Start or stop voice recording"
    }
  },
  "minimum_chrome_version": "116"
```

with

```json
  "minimum_chrome_version": "140"
```

In `build.mjs`, raise the bundle target with the manifest. Replace

```js
  target: 'chrome116',
```

with

```js
  target: 'chrome140',
```

- [ ] **Step 17: Run the manifest test to verify it passes**

```bash
npx vitest run test/unit/manifest.test.js
```

Expected: 4 passed.

- [ ] **Step 18: Write the failing entry wiring tests**

Replace the whole of `test/unit/background/index.test.js` with:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings } from '../../../src/shared/defaults.js';

/**
 * Minimal chrome stand-in: records listeners and keeps storage.local in memory. It has no
 * `commands` namespace, so an entry that still registers a command listener fails to load.
 */
function fakeChrome({ accessLevel = true } = {}) {
  const listeners = {};
  const on = (name) => ({ addListener: vi.fn((fn) => { listeners[name] = fn; }) });
  const store = {};
  const chrome = {
    runtime: {
      id: 'abc',
      getURL: (path) => `chrome-extension://abc/${path.replace(/^\//, '')}`,
      getContexts: vi.fn(async () => []),
      sendMessage: vi.fn(async () => ({ ok: true })),
      onMessage: on('message'),
      onInstalled: on('installed'),
      onStartup: on('startup'),
    },
    offscreen: { createDocument: vi.fn(async () => {}) },
    storage: {
      local: {
        get: vi.fn(async (key) => ({ [key]: structuredClone(store[key]) })),
        set: vi.fn(async (items) => { Object.assign(store, structuredClone(items)); }),
        setAccessLevel: accessLevel ? vi.fn(async () => {}) : undefined,
      },
      onChanged: on('storageChanged'),
    },
    tabs: {
      query: vi.fn(async () => [{ id: 1 }, { id: 2 }]),
      sendMessage: vi.fn(async () => undefined),
      create: vi.fn(async () => ({ id: 9 })),
      onRemoved: on('tabRemoved'),
    },
    scripting: { executeScript: vi.fn(async () => []) },
  };
  return { chrome, listeners, store };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const PAGE = { id: 'abc', origin: 'https://example.com', url: 'https://example.com/', tab: { id: 1 }, frameId: 0 };
const OTHER_PAGE = { id: 'abc', origin: 'https://example.org', url: 'https://example.org/', tab: { id: 2 }, frameId: 0 };
const POPUP = { id: 'abc', origin: 'chrome-extension://abc', url: 'chrome-extension://abc/popup.html' };
const OFFSCREEN = { id: 'abc', origin: 'chrome-extension://abc', url: 'chrome-extension://abc/offscreen.html' };

async function load(options) {
  const fake = fakeChrome(options);
  vi.stubGlobal('chrome', fake.chrome);
  vi.resetModules();
  await import('../../../src/background/index.js');
  return fake;
}

/** Call the onMessage listener the way Chrome does and wait for the async response. */
async function send(listeners, request, sender) {
  const sendResponse = vi.fn();
  expect(listeners.message(request, sender, sendResponse)).toBe(true);
  await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
  return sendResponse.mock.calls[0][0];
}

let fake;
beforeEach(async () => { fake = await load(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('service worker entry', () => {
  it('restricts storage.local to trusted contexts at load', () => {
    expect(fake.chrome.storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  });

  it('only warns when setAccessLevel is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await load({ accessLevel: false });
    await flush();
    expect(warn).toHaveBeenCalledWith('VoiceType: could not restrict storage access', expect.any(TypeError));
  });

  it('pushes key-free settings to every tab when settings change', async () => {
    const settings = freshSettings();
    settings.keys.openai = 'sk-secret-123456';
    fake.listeners.storageChanged({ settings: { newValue: settings } }, 'local');
    await flush();
    expect(fake.chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    const [tabId, message] = fake.chrome.tabs.sendMessage.mock.calls[0];
    expect(tabId).toBe(1);
    expect(message.action).toBe(MSG.SETTINGS_CHANGED);
    expect(message.settings).not.toHaveProperty('keys');
    expect(message.settings.hasKey).toEqual({ openai: true, gemini: false });
    expect(JSON.stringify(fake.chrome.tabs.sendMessage.mock.calls)).not.toContain('sk-secret');
  });

  it('ignores removed settings, usage writes and other areas', async () => {
    fake.listeners.storageChanged({ settings: { oldValue: freshSettings() } }, 'local');
    fake.listeners.storageChanged({ usageLog: { newValue: { version: 2 } } }, 'local');
    fake.listeners.storageChanged({ settings: { newValue: freshSettings() } }, 'sync');
    await flush();
    expect(fake.chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('routes messages with the real sender: pages get public settings, the popup gets keys', async () => {
    fake.store.settings = { ...freshSettings(), keys: { openai: 'sk-secret-123456', gemini: '' } };
    const pub = await send(fake.listeners, { action: MSG.GET_SETTINGS }, PAGE);
    expect(pub).not.toHaveProperty('keys');
    const full = await send(fake.listeners, { action: MSG.GET_SETTINGS }, POPUP);
    expect(full.keys.openai).toBe('sk-secret-123456');
    expect(await send(fake.listeners, { action: MSG.SAVE_SETTINGS, settings: {} }, PAGE)).toEqual({ success: false, error: 'Not allowed.' });
    expect(await send(fake.listeners, { action: 'nope' }, POPUP)).toEqual({ success: false, error: 'Unknown action' });
  });
});

describe('recording wiring', () => {
  beforeEach(() => {
    fake.store.settings = { ...freshSettings(), keys: { openai: 'sk-secret-123456', gemini: '' } };
  });

  it('re-injects content scripts into open tabs on install', async () => {
    fake.listeners.installed({ reason: 'update' });
    await flush();
    expect(fake.chrome.tabs.query).toHaveBeenCalledWith({ url: ['http://*/*', 'https://*/*', 'file:///*'] });
    expect(fake.chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 1, allFrames: true }, files: ['content.js'] });
    expect(fake.chrome.scripting.executeScript).toHaveBeenCalledTimes(2);
  });

  it('starts a recording through the offscreen document and relays levels to the frame', async () => {
    expect(await send(fake.listeners, { action: MSG.START_RECORDING }, PAGE)).toEqual({ ok: true });
    expect(fake.chrome.offscreen.createDocument).toHaveBeenCalledWith(expect.objectContaining({
      url: 'chrome-extension://abc/offscreen.html', reasons: ['USER_MEDIA'],
    }));
    expect(fake.chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: MSG.OFFSCREEN_START, maxSec: 120, silenceSec: 0 });
    expect(JSON.stringify(fake.chrome.runtime.sendMessage.mock.calls)).not.toContain('sk-secret');
    expect(await send(fake.listeners, { action: MSG.OFFSCREEN_LEVEL, level: 0.5 }, OFFSCREEN)).toEqual({ ok: true });
    await vi.waitFor(() => expect(fake.chrome.tabs.sendMessage).toHaveBeenCalledWith(1, { action: MSG.AUDIO_LEVEL, level: 0.5 }, { frameId: 0 }));
  });

  it('a removed tab frees its recording for the next tab', async () => {
    await send(fake.listeners, { action: MSG.START_RECORDING }, PAGE);
    await fake.listeners.tabRemoved(1);
    await vi.waitFor(() => expect(fake.chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: MSG.OFFSCREEN_STOP, discard: true }));
    expect(await send(fake.listeners, { action: MSG.START_RECORDING }, OTHER_PAGE)).toEqual({ ok: true });
  });

  it('opens the permission page when the microphone needs permission', async () => {
    fake.chrome.runtime.sendMessage.mockResolvedValueOnce({ ok: false, reason: 'needsPermission', error: 'Microphone permission needed.' });
    const res = await send(fake.listeners, { action: MSG.START_RECORDING }, PAGE);
    expect(res.reason).toBe('needsPermission');
    expect(fake.chrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome-extension://abc/permission.html' });
  });
});
```

- [ ] **Step 19: Run the entry tests to verify they fail**

```bash
npx vitest run test/unit/background/index.test.js
```

Expected: 9 failed, each with `TypeError: Cannot read properties of undefined (reading 'onCommand')` (the entry still registers the command listener).

- [ ] **Step 20: Rewrite `src/background/index.js`**

Replace the whole file with (removes `toggleActiveTab`, the `chrome.commands` listener and the recording stub):

```js
// VoiceType service worker. Listeners and wiring only; logic lives in the imported modules.
import { MSG } from '../shared/messages.js';
import { migrateSettings, toPublicSettings } from '../shared/defaults.js';
import { createStorage } from './storage.js';
import { createRouter, createValidateKey, senderKind, userMessage } from './router.js';
import { runDictation, ADAPTERS } from './pipeline.js';
import { applyUsage, summarize } from './usage.js';
import { createDictate } from './dictate.js';
import { createRecorder } from './recorder.js';
import { createOffscreenClient } from './offscreen-client.js';
import { broadcast, reinject, sendToFrame } from './tabs.js';

// Keys live in storage.local; only the service worker and extension pages may read it.
(async () => {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch (err) {
    console.warn('VoiceType: could not restrict storage access', err);
  }
})();

const storage = createStorage(chrome.storage.local);
const offscreenClient = createOffscreenClient({ runtime: chrome.runtime, offscreen: chrome.offscreen });
const recorder = createRecorder({
  ensureOffscreen: () => offscreenClient.ensure(),
  toOffscreen: (message) => offscreenClient.send(message),
  toTab: (endpoint, message) => sendToFrame(chrome.tabs, endpoint, message),
  openPermissionPage: async () => { await chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') }); },
  getSettings: () => storage.getSettings(),
  dictate: createDictate({ storage, runDictation, applyUsage, userMessage }),
});

// Built from the id: URL parsers outside Chrome give chrome-extension: URLs an opaque 'null' origin,
// which content scripts in sandboxed frames also report.
const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
const offscreenUrl = chrome.runtime.getURL('offscreen.html');
const handle = createRouter({
  storage,
  validateKey: createValidateKey(ADAPTERS),
  summarize,
  recorder,
  identify: (sender) => senderKind(sender, { extensionId: chrome.runtime.id, extensionOrigin, offscreenUrl }),
});

chrome.runtime.onInstalled.addListener(() => {
  storage.getSettings().catch(() => {});
  // Content scripts already in open tabs belong to the old version; give every frame the new one.
  reinject(chrome.tabs, chrome.scripting);
});
chrome.runtime.onStartup.addListener(() => { storage.getSettings().catch(() => {}); });

chrome.tabs.onRemoved.addListener((tabId) => { recorder.onTabRemoved(tabId); });

// Content scripts cannot read storage any more, so push key-free settings to every frame.
chrome.storage.onChanged.addListener((changes, areaName) => {
  const next = changes.settings?.newValue;
  if (areaName !== 'local' || !next || typeof next !== 'object') return;
  broadcast(chrome.tabs, { action: MSG.SETTINGS_CHANGED, settings: toPublicSettings(migrateSettings(next)) });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handle(request, sender).then(
    (response) => sendResponse(response ?? { success: false, error: 'Unknown action' }),
    (err) => sendResponse({ success: false, error: userMessage(err) }),
  );
  return true; // keep the channel open for the async response
});
```

- [ ] **Step 21: Run the entry tests to verify they pass**

```bash
npx vitest run test/unit/background/index.test.js
```

Expected: 9 passed.

- [ ] **Step 22: Run the full suite and the build**

```bash
npm test
npm run build
grep -c "onCommand" dist/background.js
```

Expected: all green (report N/N); the build succeeds; the grep prints `0`.

- [ ] **Step 23: Commit**

```bash
git add manifest.json build.mjs src/background/tabs.js src/background/index.js test/unit/manifest.test.js test/unit/background/tabs.test.js test/unit/background/index.test.js
git commit -m "Wire the offscreen recorder, drop the command shortcut and re-inject content scripts on install"
```

---

### Task 7: Insertion ladder v2

**Files:**
- Modify: `src/content/insert.js`, `src/content/fields.js`
- Test: `test/unit/content/insert.test.js`, `test/unit/content/fields.test.js`

**Interfaces:**
- Produces:
  - `insertText(target: Element|null, text: string, deps?: { execCommand?: (text: string) => boolean, dispatch?: (el: Element, event: Event) => boolean, writeClipboard?: (text: string) => Promise<void>, settle?: (check: () => boolean) => Promise<boolean>, hostname?: string }): Promise<'inserted'|'unverified'|'clipboard'|'failed'>`.
    - `'inserted'`: verified in the field. `'unverified'`: a rung may have inserted but read-back was ambiguous; the text was also copied. `'clipboard'`: nothing was inserted; the text was copied. `'failed'`: nothing was inserted and the copy failed.
  - `copyText(text: string, deps?: { writeClipboard?, execCopy? }): Promise<boolean>`: `navigator.clipboard.writeText` when available, else a hidden-textarea `execCommand('copy')` fallback (plain http pages have no Clipboard API).
  - `normalizeForCompare(s: string): string`: newlines normalized to `\n`, then spaces, `\n`, NBSP, U+200B, U+FEFF removed.
  - `readValue(el)` unchanged.
  - `CLIPBOARD_ONLY_HOSTS = new Set(['docs.google.com'])`.
  - `fields.js`: `isValidInput` uses `el.type` (unknown types count as text), rejects inputs whose `autocomplete` ends in `-password`; `isFrameworkEditor(el): boolean` true when `el` or an ancestor carries `data-lexical-editor`, class `ProseMirror`, `data-slate-editor`, class `ql-editor`, `data-contents` (Draft.js) or class `cm-content`.
- Ladder (from the spec 6.0 amendment and the Chromium, Lexical and ProseMirror source reading):
  - Before any rung: capture the selection inside the target; focus; restore it or place the caret at the end of the last text node (not the editor root). Capture `before = readValue(target)`. Install a capture-phase `input` listener on the target's window that records trusted `input` events for the duration of the call.
  - A rung succeeds when, after `settle`, the value equals the expected splice or `count(N(after), N(text)) > count(N(before), N(text))` (N is `normalizeForCompare`). The ladder advances only when `N(after) === N(before)`, no trusted `input` fired, and no paste or beforeinput was `defaultPrevented`. Any other outcome stops the ladder: copy, return `'unverified'` (or `'failed'` if the copy fails).
  - Form fields (`input`, `textarea`): rung 0 `setSelectionRange(start, end)` on the current offsets (breaks the typing run so Ctrl+Z removes exactly the dictation); rung 1 `execCommand('insertText')` only when the target is the active element of its root (a `false` return skips the settle); rung 2 dispatch a cancelable, composed `beforeinput` (`inputType: 'insertText'`, `data: text`); if not prevented, native value setter at the caret plus a composed `input` event; rung 3 clipboard.
  - Contenteditable: single-line text tries `execCommand` first and synthetic `paste` second; multi-line text tries `paste` first and `execCommand` second. Paste is a `ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData })` with a `DataTransfer` holding only `text/plain`. Rung 3 is a cancelable composed `beforeinput` counted only if the editor prevents it. Rung 4 is a raw DOM insert at the caret only when `isFrameworkEditor(target)` is false. Rung 5 clipboard.
  - `CLIPBOARD_ONLY_HOSTS` members skip straight to the clipboard.
  - The default `settle(check)` waits one macrotask via `MessageChannel`, then one animation frame raced with a 50 ms timer, then polls `check()` every 16 ms up to 100 ms total; resolves `true` as soon as `check()` is true.
- Ledger: rows 47, 48, 50, 67; the Lexical bug (raw insert removed by Lexical after a synchronous read-back reported success).

WRITER NOTES

- Added optional deps beyond the Interfaces signature: `createPasteEvent(text) => Event|null` (default builds `ClipboardEvent` plus `DataTransfer`, returns null when either is missing), `isTrusted(event) => boolean` (default `event.isTrusted === true`), and `execCopy(text) => boolean` (passed through to `copyText`). jsdom has none of `execCommand`, `DataTransfer`, `ClipboardEvent` or trusted events.
- Contract flaw: Draft.js puts `data-contents` on a child of its contenteditable, so "el or an ancestor carries `data-contents`" never matches the focused Draft editor. `.DraftEditor-root` is added to the marker list; `data-contents` stays.
- The autocomplete check is per token: `current-password webauthn` is valid HTML and does not literally end in `-password`.
- One judge for every rung. A contenteditable `beforeinput` the editor does not prevent but that still puts the text in the field counts as inserted; advancing would type the text twice.
- Text that normalizes to empty (only spaces or zero-width characters) is copied, never typed: read-back cannot verify it. The pipeline trims, so this is defensive.
- Default `hostname` falls back to `location.ancestorOrigins[0]` in about:blank frames: Google Docs types into one, and Task 11 adds `match_about_blank`.
- Until Task 11 lands, the v2.0 `index.js` treats `'unverified'` like `'failed'` (click-to-copy status). The text is also on the clipboard.
- A no-change path under fake timers needs the timers advanced (the 100 ms poll is timer based by design); a verified insert resolves without advancing them.

- [ ] **Step 1: Write the failing field tests**

Replace `test/unit/content/fields.test.js` with:

```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  isValidInput, isEditableElement, isFrameworkEditor, deepActiveElement, TEXT_INPUT_TYPES,
} from '../../../src/content/fields.js';

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
  it('reads el.type, so unknown types count as text and the attribute case does not matter', () => {
    expect(isValidInput(make('<input type="bogus">'))).toBe(true);
    expect(isValidInput(make('<input type="PASSWORD">'))).toBe(false);
    expect(isValidInput(make('<input type="Email">'))).toBe(true);
  });
  it('rejects inputs whose autocomplete ends in -password (revealed password fields)', () => {
    expect(isValidInput(make('<input type="text" autocomplete="current-password">'))).toBe(false);
    expect(isValidInput(make('<input type="text" autocomplete="new-password">'))).toBe(false);
    expect(isValidInput(make('<input type="text" autocomplete="section-login current-password webauthn">'))).toBe(false);
    expect(isValidInput(make('<input type="text" autocomplete="username">'))).toBe(true);
    expect(isValidInput(make('<input type="text" autocomplete="off">'))).toBe(true);
  });
  it('accepts contenteditable and role=textbox, rejects plain elements and null', () => {
    expect(isValidInput(make('<div contenteditable="true"></div>'))).toBe(true);
    expect(isValidInput(make('<div role="textbox"></div>'))).toBe(true);
    expect(isValidInput(make('<div></div>'))).toBe(false);
    expect(isValidInput(null)).toBe(false);
    expect(isValidInput(document.createTextNode('x'))).toBe(false);
  });
});

describe('isEditableElement', () => {
  it("accepts contenteditable '' and 'plaintext-only', rejects 'false'", () => {
    expect(isEditableElement(make('<div contenteditable=""></div>'))).toBe(true);
    expect(isEditableElement(make('<div contenteditable="plaintext-only"></div>'))).toBe(true);
    expect(isEditableElement(make('<div contenteditable="false"></div>'))).toBe(false);
    expect(isValidInput(make('<div contenteditable=""></div>'))).toBe(true);
    expect(isValidInput(make('<div contenteditable="plaintext-only"></div>'))).toBe(true);
  });
});

describe('isFrameworkEditor', () => {
  it('recognises each editor marker on the element itself', () => {
    const roots = [
      '<div contenteditable="true" data-lexical-editor="true"></div>',
      '<div contenteditable="true" class="ProseMirror"></div>',
      '<div contenteditable="true" data-slate-editor="true"></div>',
      '<div contenteditable="true" class="ql-editor"></div>',
      '<div contenteditable="true" data-contents="true"></div>',
      '<div contenteditable="true" class="cm-content"></div>',
    ];
    for (const html of roots) expect(isFrameworkEditor(make(html)), html).toBe(true);
  });
  it('recognises a marker on an ancestor', () => {
    const root = make('<div class="ProseMirror" contenteditable="true"><p><span id="inner">x</span></p></div>');
    expect(isFrameworkEditor(root.querySelector('#inner'))).toBe(true);
  });
  it('recognises the Draft.js contenteditable, whose data-contents sits on a child', () => {
    make('<div class="DraftEditor-root"><div class="DraftEditor-editorContainer">'
      + '<div id="ce" class="public-DraftEditor-content" contenteditable="true"><div data-contents="true"></div></div>'
      + '</div></div>');
    expect(isFrameworkEditor(document.getElementById('ce'))).toBe(true);
  });
  it('is false for plain editables, form fields, text nodes and null', () => {
    expect(isFrameworkEditor(make('<div contenteditable="true"><p>Hi</p></div>'))).toBe(false);
    expect(isFrameworkEditor(make('<textarea></textarea>'))).toBe(false);
    expect(isFrameworkEditor(document.createTextNode('x'))).toBe(false);
    expect(isFrameworkEditor(null)).toBe(false);
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

- [ ] **Step 2: Run the field tests to verify they fail**

```bash
npx vitest run test/unit/content/fields.test.js
```

Expected: 6 failed, 6 passed (12). The four `isFrameworkEditor` tests fail with `TypeError: isFrameworkEditor is not a function`; "reads el.type, so unknown types count as text ..." fails with `expected false to be true` (`type="bogus"` is rejected today); "rejects inputs whose autocomplete ends in -password ..." fails with `expected true to be false`.

- [ ] **Step 3: Rewrite `src/content/fields.js`**

```js
/** Input types VoiceType may dictate into. `password` is deliberately absent. */
export const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel']);

/** `contenteditable` attribute values that make an element editable (empty means true). */
const EDITABLE_ATTR_VALUES = new Set(['', 'true', 'plaintext-only']);

/**
 * Roots of editors that keep their own document model and revert foreign DOM writes:
 * Lexical, ProseMirror (and Tiptap), Slate, Quill, Draft.js, CodeMirror 6. Draft.js puts
 * `data-contents` on a child of its contenteditable, so its outer root class is listed too.
 */
const FRAMEWORK_EDITOR_SELECTOR = [
  '[data-lexical-editor]',
  '.ProseMirror',
  '[data-slate-editor]',
  '.ql-editor',
  '[data-contents]',
  '.DraftEditor-root',
  '.cm-content',
].join(', ');

/**
 * True for elements VoiceType may dictate into. Password fields are excluded on purpose:
 * their audio would otherwise be sent to a cloud API. `el.type` is used because browsers
 * report unknown type attributes as `text`; an `autocomplete` token ending in `-password`
 * marks a password field that a page has revealed as plain text.
 * @param {Element|null|undefined} el
 * @returns {boolean}
 */
export function isValidInput(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return !el.disabled && !el.readOnly;
  if (tag === 'input') {
    const type = String(el.type || 'text').toLowerCase();
    if (!TEXT_INPUT_TYPES.has(type) || hasPasswordAutocomplete(el)) return false;
    return !el.disabled && !el.readOnly;
  }
  if (isEditableElement(el)) return true;
  return el.getAttribute('role') === 'textbox';
}

/** @param {Element} el */
function hasPasswordAutocomplete(el) {
  const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
  return tokens.some((token) => token.endsWith('-password'));
}

/**
 * True for contenteditable elements. jsdom lacks `isContentEditable`, and pages also use
 * `contenteditable=""`, so the attribute is checked as well.
 * @param {Element|null|undefined} el
 * @returns {boolean}
 */
export function isEditableElement(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable === true) return true;
  const editable = el.getAttribute('contenteditable');
  return editable !== null && EDITABLE_ATTR_VALUES.has(editable.toLowerCase());
}

/**
 * True when el belongs to a framework editor, which must never receive a raw DOM insert:
 * the editor reverts it after a microtask and the text is lost.
 * @param {Element|null|undefined} el
 * @returns {boolean}
 */
export function isFrameworkEditor(el) {
  if (!el || el.nodeType !== 1) return false;
  return el.closest(FRAMEWORK_EDITOR_SELECTOR) !== null;
}

/**
 * document.activeElement stops at shadow hosts; follow open shadow roots down.
 * @param {Document|ShadowRoot} [root]
 * @returns {Element|null}
 */
export function deepActiveElement(root = document) {
  let el = root.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}
```

- [ ] **Step 4: Run the field tests to verify they pass**

```bash
npx vitest run test/unit/content/fields.test.js
```

Expected: 12 passed.

- [ ] **Step 5: Write the failing insertion tests**

Replace `test/unit/content/insert.test.js` with:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  insertText, copyText, readValue, normalizeForCompare, CLIPBOARD_ONLY_HOSTS,
} from '../../../src/content/insert.js';

// jsdom has no execCommand, DataTransfer or ClipboardEvent, and every event a script
// dispatches is untrusted. The stand-ins below mimic Chrome; events they mark count as trusted.
const trustedEvents = new WeakSet();
const isTrusted = (event) => trustedEvents.has(event);

function trustedInput(text) {
  const event = new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text });
  trustedEvents.add(event);
  return event;
}

/** One macrotask, then a single read-back: enough for microtask commits and fast. */
async function quickSettle(check) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  return check();
}

/** execCommand('insertText') as Chrome runs it in a focused form field. */
function formExec(text) {
  const el = document.activeElement;
  if (!el || !('value' in el)) return false;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  el.setSelectionRange(start + text.length, start + text.length);
  el.dispatchEvent(trustedInput(text));
  return true;
}

/** execCommand('insertText') as Chrome runs it in a focused contenteditable. */
function editableExec(text) {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  document.activeElement.dispatchEvent(trustedInput(text));
  return true;
}

/** A paste event jsdom can build: plain Event plus a text/plain clipboardData. */
function fakePasteEvent(text) {
  const event = new Event('paste', { bubbles: true, cancelable: true, composed: true });
  event.clipboardData = { types: ['text/plain'], getData: (type) => (type === 'text/plain' ? text : '') };
  return event;
}

/** What an editor's paste or beforeinput handler does: insert at the caret itself. */
function insertAtCaret(text) {
  const sel = document.getSelection();
  const range = sel.getRangeAt(0);
  range.insertNode(document.createTextNode(text));
}

function deps(overrides = {}) {
  return {
    execCommand: vi.fn(() => false),
    writeClipboard: vi.fn(async () => {}),
    settle: quickSettle,
    isTrusted,
    createPasteEvent: () => null,
    hostname: 'example.com',
    ...overrides,
  };
}

function textarea(value = '', caret = value.length) {
  document.body.innerHTML = '<textarea id="ta"></textarea>';
  const el = document.getElementById('ta');
  el.value = value;
  el.focus();
  el.setSelectionRange(caret, caret);
  return el;
}

function editable(html, attrs = 'contenteditable="true"') {
  document.body.innerHTML = `<div id="ce" ${attrs}>${html}</div>`;
  document.getSelection().removeAllRanges();
  return document.getElementById('ce');
}

function setCaret(node, offset) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * Lexical stand-in: its MutationObserver sees a foreign DOM change and the editor restores
 * its own DOM a microtask after that, well before any timer fires.
 */
function revertForeignWrites(el) {
  const snapshot = [...el.childNodes].map((node) => node.cloneNode(true));
  const seen = [];
  const observer = new MutationObserver((records) => {
    seen.push(...records);
    observer.disconnect();
    queueMicrotask(() => el.replaceChildren(...snapshot.map((node) => node.cloneNode(true))));
  });
  observer.observe(el, { childList: true, characterData: true, subtree: true });
  return seen;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete document.execCommand;
  document.body.innerHTML = '';
});

describe('normalizeForCompare', () => {
  it('normalizes newlines, then drops spaces, newlines, NBSP, U+200B and U+FEFF', () => {
    expect(normalizeForCompare('a b\r\nc\rd\u00A0e\u200Bf\uFEFFg\n')).toBe('abcdefg');
    expect(normalizeForCompare('a\tb')).toBe('a\tb');
  });
});

describe('readValue', () => {
  it('reads value for fields and textContent for editables', () => {
    document.body.innerHTML = '<input id="i" value="v"><div id="d">t</div>';
    expect(readValue(document.getElementById('i'))).toBe('v');
    expect(readValue(document.getElementById('d'))).toBe('t');
  });
});

describe('insertText in form fields', () => {
  it('re-applies the selection before execCommand and inserts once', async () => {
    const el = textarea('Hello ', 6);
    const select = vi.spyOn(el, 'setSelectionRange');
    const exec = vi.fn(formExec);
    const d = deps({ execCommand: exec });
    expect(await insertText(el, 'world', d)).toBe('inserted');
    expect(el.value).toBe('Hello world');
    expect(select).toHaveBeenNthCalledWith(1, 6, 6);
    expect(select.mock.invocationCallOrder[0]).toBeLessThan(exec.mock.invocationCallOrder[0]);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(d.writeClipboard).not.toHaveBeenCalled();
  });

  it('never trusts the execCommand return value: true without a change falls to beforeinput and the setter', async () => {
    const el = textarea('ab', 1);
    const events = [];
    el.addEventListener('beforeinput', (e) => events.push(['beforeinput', el.value, e.cancelable, e.composed, e.inputType, e.data]));
    el.addEventListener('input', (e) => events.push(['input', el.value, e.composed, e.inputType, e.data]));
    el.addEventListener('change', () => events.push(['change', el.value]));
    const d = deps({ execCommand: vi.fn(() => true) });
    expect(await insertText(el, 'X', d)).toBe('inserted');
    expect(el.value).toBe('aXb');
    expect(el.selectionStart).toBe(2);
    expect(events).toEqual([
      ['beforeinput', 'ab', true, true, 'insertText', 'X'],
      ['input', 'aXb', true, 'insertText', 'X'],
      ['change', 'aXb'],
    ]);
    expect(d.writeClipboard).not.toHaveBeenCalled();
  });

  it('a false execCommand skips the settle', async () => {
    const el = textarea('ab', 2);
    const settle = vi.fn(quickSettle);
    const d = deps({ settle });
    expect(await insertText(el, 'c', d)).toBe('inserted');
    expect(d.execCommand).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(el.value).toBe('abc');
  });

  it('a trusted input without a change stops the ladder: unverified, copied, no setter', async () => {
    const el = textarea('ab', 2);
    const beforeinput = vi.fn();
    el.addEventListener('beforeinput', beforeinput);
    const exec = vi.fn((text) => el.dispatchEvent(trustedInput(text)));
    const d = deps({ execCommand: exec });
    expect(await insertText(el, 'X', d)).toBe('unverified');
    expect(el.value).toBe('ab');
    expect(d.writeClipboard).toHaveBeenCalledWith('X');
    expect(beforeinput).not.toHaveBeenCalled();
  });

  it('an ambiguous execCommand (partial text) is unverified, copied and never followed by another rung', async () => {
    const el = textarea('', 0);
    const dispatch = vi.fn((target, event) => target.dispatchEvent(event));
    const exec = vi.fn(() => formExec('hello'));
    const d = deps({ execCommand: exec, dispatch });
    expect(await insertText(el, 'hello world', d)).toBe('unverified');
    expect(el.value).toBe('hello');
    expect(d.writeClipboard).toHaveBeenCalledWith('hello world');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('an unverified insert whose copy fails reports failed', async () => {
    const el = textarea('', 0);
    const d = deps({
      execCommand: () => formExec('hello'),
      writeClipboard: vi.fn(async () => { throw new Error('denied'); }),
    });
    expect(await insertText(el, 'hello world', d)).toBe('failed');
  });

  it('an execCommand that commits in a microtask inserts exactly once (default settle)', async () => {
    const el = textarea('Hi', 2);
    const exec = vi.fn((text) => {
      queueMicrotask(() => { el.value += text; });
      return true;
    });
    expect(await insertText(el, ' there', deps({ execCommand: exec, settle: undefined }))).toBe('inserted');
    expect(el.value).toBe('Hi there');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('an editor that renders the insert 20 ms later still gets it exactly once (default settle)', async () => {
    const el = textarea('Hi', 2);
    const exec = vi.fn((text) => {
      setTimeout(() => { el.value += text; }, 20);
      return true;
    });
    expect(await insertText(el, ' there', deps({ execCommand: exec, settle: undefined }))).toBe('inserted');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(el.value).toBe('Hi there');
  });

  it('a prevented beforeinput stops before the setter', async () => {
    const el = textarea('ab', 2);
    const input = vi.fn();
    el.addEventListener('beforeinput', (e) => e.preventDefault());
    el.addEventListener('input', input);
    const d = deps();
    expect(await insertText(el, 'X', d)).toBe('unverified');
    expect(el.value).toBe('ab');
    expect(input).not.toHaveBeenCalled();
    expect(d.writeClipboard).toHaveBeenCalledWith('X');
  });

  it('a page that prevents beforeinput and inserts itself counts as inserted', async () => {
    const el = textarea('ab', 2);
    el.addEventListener('beforeinput', (e) => {
      e.preventDefault();
      el.value += e.data;
    });
    const d = deps();
    expect(await insertText(el, 'X', d)).toBe('inserted');
    expect(el.value).toBe('abX');
    expect(d.writeClipboard).not.toHaveBeenCalled();
  });

  it('refused focus skips execCommand; the setter still inserts', async () => {
    document.body.innerHTML = '<input id="other"><textarea id="ta"></textarea>';
    const other = document.getElementById('other');
    const el = document.getElementById('ta');
    el.value = 'ab';
    el.setSelectionRange(2, 2);
    other.focus();
    el.focus = () => {};
    const d = deps({ execCommand: vi.fn(formExec) });
    expect(await insertText(el, 'X', d)).toBe('inserted');
    expect(d.execCommand).not.toHaveBeenCalled();
    expect(el.value).toBe('abX');
    expect(other.value).toBe('');
  });

  it('inputs without selection support (email) get the text appended', async () => {
    document.body.innerHTML = '<input id="em" type="email" value="a@b">';
    const el = document.getElementById('em');
    expect(await insertText(el, '.com', deps())).toBe('inserted');
    expect(el.value).toBe('a@b.com');
  });

  it('replacing a selection with identical text reads as inserted', async () => {
    const el = textarea('hello', 0);
    el.setSelectionRange(0, 5);
    const d = deps({ execCommand: vi.fn(formExec) });
    expect(await insertText(el, 'hello', d)).toBe('inserted');
    expect(el.value).toBe('hello');
    expect(d.writeClipboard).not.toHaveBeenCalled();
  });
});

describe('insertText in contenteditable', () => {
  function recordRungs(el, order) {
    el.addEventListener('paste', () => order.push('paste'));
    el.addEventListener('beforeinput', () => order.push('beforeinput'));
    return vi.fn(() => {
      order.push('exec');
      return false;
    });
  }

  it('single-line text tries execCommand before paste', async () => {
    const el = editable('Hi');
    const order = [];
    const d = deps({ execCommand: recordRungs(el, order), createPasteEvent: fakePasteEvent });
    expect(await insertText(el, ' there', d)).toBe('inserted');
    expect(order).toEqual(['exec', 'paste', 'beforeinput']);
    expect(el.textContent).toBe('Hi there');
  });

  it('multi-line text tries paste before execCommand', async () => {
    const el = editable('Hi');
    const order = [];
    const d = deps({ execCommand: recordRungs(el, order), createPasteEvent: fakePasteEvent });
    expect(await insertText(el, 'one\ntwo', d)).toBe('inserted');
    expect(order).toEqual(['paste', 'exec', 'beforeinput']);
    expect(el.textContent).toBe('Hione\ntwo');
  });

  it('a paste the editor handles (prevented, text inserted) counts as inserted', async () => {
    const el = editable('<p>Hi</p>');
    const beforeinput = vi.fn();
    el.addEventListener('beforeinput', beforeinput);
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      insertAtCaret(e.clipboardData.getData('text/plain'));
    });
    const d = deps({ execCommand: vi.fn(editableExec), createPasteEvent: fakePasteEvent });
    expect(await insertText(el, ' one\ntwo', d)).toBe('inserted');
    expect(el.textContent).toBe('Hi one\ntwo');
    expect(d.execCommand).not.toHaveBeenCalled();
    expect(beforeinput).not.toHaveBeenCalled();
    expect(d.writeClipboard).not.toHaveBeenCalled();
  });

  it('a prevented paste that inserts nothing is unverified and stops the ladder', async () => {
    const el = editable('Hi');
    el.addEventListener('paste', (e) => e.preventDefault());
    const d = deps({ execCommand: vi.fn(editableExec), createPasteEvent: fakePasteEvent });
    expect(await insertText(el, 'one\ntwo', d)).toBe('unverified');
    expect(el.textContent).toBe('Hi');
    expect(d.execCommand).not.toHaveBeenCalled();
    expect(d.writeClipboard).toHaveBeenCalledWith('one\ntwo');
  });

  it('beforeinput counts when the editor prevents it and inserts', async () => {
    const el = editable('Hi', 'contenteditable="true" class="ProseMirror"');
    el.addEventListener('beforeinput', (e) => {
      e.preventDefault();
      insertAtCaret(e.data);
    });
    const d = deps();
    expect(await insertText(el, ' there', d)).toBe('inserted');
    expect(el.textContent).toBe('Hi there');
    expect(d.writeClipboard).not.toHaveBeenCalled();
  });

  it('a Lexical-like editor never gets a raw DOM insert and ends at the clipboard', async () => {
    const el = editable('<p>Hi</p>', 'contenteditable="true" data-lexical-editor="true"');
    const seen = revertForeignWrites(el);
    const d = deps({ createPasteEvent: fakePasteEvent });
    expect(await insertText(el, ' there', d)).toBe('clipboard');
    expect(seen).toHaveLength(0);
    expect(el.innerHTML).toBe('<p>Hi</p>');
    expect(d.writeClipboard).toHaveBeenCalledWith(' there');
  });

  it('a raw insert that the page reverts in a microtask is not reported as inserted', async () => {
    const el = editable('<p>Hi</p>');
    const seen = revertForeignWrites(el);
    const d = deps({ settle: undefined });
    expect(await insertText(el, ' there', d)).toBe('clipboard');
    expect(seen.length).toBeGreaterThan(0);
    expect(el.innerHTML).toBe('<p>Hi</p>');
    expect(d.writeClipboard).toHaveBeenCalledWith(' there');
  });

  it('the caret at the end lands inside the last text node, not at the editor root', async () => {
    const el = editable('<p>Hi</p>\n');
    const p = el.querySelector('p');
    let caret = null;
    const exec = vi.fn((text) => {
      const sel = document.getSelection();
      caret = [sel.anchorNode, sel.anchorOffset];
      return editableExec(text);
    });
    expect(await insertText(el, ' there', deps({ execCommand: exec }))).toBe('inserted');
    expect(caret).toEqual([p.firstChild, 2]);
    expect(p.textContent).toBe('Hi there');
  });

  it('the raw insert also lands inside the last text node', async () => {
    const el = editable('<p>Hi</p>');
    expect(await insertText(el, ' there', deps())).toBe('inserted');
    expect(el.innerHTML).toBe('<p>Hi there</p>');
  });

  it('restores a caret that was inside the contenteditable', async () => {
    const el = editable('Hello');
    setCaret(el.firstChild, 2);
    expect(await insertText(el, 'X', deps())).toBe('inserted');
    expect(el.textContent).toBe('HeXllo');
  });

  it('execCommand inserts at the restored caret', async () => {
    const el = editable('Hello');
    setCaret(el.firstChild, 2);
    const d = deps({ execCommand: vi.fn(editableExec) });
    expect(await insertText(el, 'X', d)).toBe('inserted');
    expect(d.execCommand).toHaveBeenCalledTimes(1);
    expect(el.textContent).toBe('HeXllo');
  });

  it("contenteditable '' and 'plaintext-only' are written", async () => {
    for (const attrs of ['contenteditable=""', 'contenteditable="plaintext-only"']) {
      const el = editable('Hi', attrs);
      expect(await insertText(el, ' there', deps()), attrs).toBe('inserted');
      expect(el.textContent).toBe('Hi there');
    }
  });

  it('a role=textbox that is not editable is never written', async () => {
    document.body.innerHTML = '<div id="tb" role="textbox">x</div>';
    const el = document.getElementById('tb');
    const d = deps();
    expect(await insertText(el, 'Y', d)).toBe('clipboard');
    expect(d.writeClipboard).toHaveBeenCalledWith('Y');
    expect(el.textContent).toBe('x');
  });

  it('builds the default paste as a cancelable, composed ClipboardEvent holding only text/plain', async () => {
    class FakeDataTransfer {
      constructor() { this.store = new Map(); }
      setData(type, value) { this.store.set(type, value); }
      getData(type) { return this.store.get(type) ?? ''; }
      get types() { return [...this.store.keys()]; }
    }
    class FakeClipboardEvent extends Event {
      constructor(type, init = {}) {
        super(type, init);
        this.clipboardData = init.clipboardData ?? null;
      }
    }
    vi.stubGlobal('DataTransfer', FakeDataTransfer);
    vi.stubGlobal('ClipboardEvent', FakeClipboardEvent);
    const el = editable('Hi');
    let pasted = null;
    el.addEventListener('paste', (e) => {
      pasted = e;
      e.preventDefault();
      insertAtCaret(e.clipboardData.getData('text/plain'));
    });
    expect(await insertText(el, 'one\ntwo', deps({ createPasteEvent: undefined }))).toBe('inserted');
    expect(pasted).toBeInstanceOf(FakeClipboardEvent);
    expect([pasted.bubbles, pasted.cancelable, pasted.composed]).toEqual([true, true, true]);
    expect(pasted.clipboardData.types).toEqual(['text/plain']);
    expect(el.textContent).toBe('Hione\ntwo');
  });
});

describe('insertText guards', () => {
  it('docs.google.com goes straight to the clipboard', async () => {
    expect(CLIPBOARD_ONLY_HOSTS.has('docs.google.com')).toBe(true);
    const el = textarea('ab', 2);
    const dispatch = vi.fn();
    const d = deps({ execCommand: vi.fn(formExec), dispatch, hostname: 'docs.google.com' });
    expect(await insertText(el, 'X', d)).toBe('clipboard');
    expect(d.execCommand).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(el.value).toBe('ab');
    expect(d.writeClipboard).toHaveBeenCalledWith('X');
  });

  it('a detached or missing target copies', async () => {
    const d = deps();
    expect(await insertText(document.createElement('textarea'), 'lost text', d)).toBe('clipboard');
    expect(d.writeClipboard).toHaveBeenCalledWith('lost text');
    expect(await insertText(null, 't', deps())).toBe('clipboard');
    expect(await insertText(null, 't', deps({ writeClipboard: vi.fn(async () => { throw new Error('denied'); }) }))).toBe('failed');
  });

  it('an execCommand that detaches the target copies without another rung', async () => {
    const el = textarea('ab', 2);
    const dispatch = vi.fn((target, event) => target.dispatchEvent(event));
    const exec = vi.fn(() => {
      el.remove();
      return true;
    });
    const d = deps({ execCommand: exec, dispatch });
    expect(await insertText(el, 'X', d)).toBe('clipboard');
    expect(dispatch).not.toHaveBeenCalled();
    expect(d.writeClipboard).toHaveBeenCalledWith('X');
  });

  it('empty text does nothing; whitespace-only text is copied, never typed', async () => {
    const el = textarea('keep');
    const d = deps({ execCommand: vi.fn(formExec) });
    expect(await insertText(el, '', d)).toBe('failed');
    expect(await insertText(el, ' \n\u00A0', d)).toBe('clipboard');
    expect(d.execCommand).not.toHaveBeenCalled();
    expect(el.value).toBe('keep');
  });

  it('removes its capture-phase input listener when done', async () => {
    const win = document.defaultView;
    const add = vi.spyOn(win, 'addEventListener');
    const remove = vi.spyOn(win, 'removeEventListener');
    await insertText(textarea('a', 1), 'b', deps());
    const added = add.mock.calls.find(([type]) => type === 'input');
    expect(added[2]).toBe(true);
    expect(remove).toHaveBeenCalledWith('input', added[1], true);
  });
});

describe('insertText with the default settle under fake timers', () => {
  it('resolves without advancing timers once the insert verifies', async () => {
    vi.useFakeTimers();
    const viaExec = textarea('Hi', 2);
    expect(await insertText(viaExec, ' there', deps({ execCommand: formExec, settle: undefined }))).toBe('inserted');
    const viaSetter = textarea('Hi', 2);
    expect(await insertText(viaSetter, ' there', deps({ settle: undefined }))).toBe('inserted');
    expect(viaSetter.value).toBe('Hi there');
  });

  it('gives up after about 100 ms of fake time when nothing changes', async () => {
    vi.useFakeTimers();
    const el = editable('Hi', 'contenteditable="true" data-lexical-editor="true"');
    const started = performance.now();
    let outcome = null;
    const pending = insertText(el, ' there', deps({ settle: undefined })).then((value) => { outcome = value; });
    for (let i = 0; i < 40 && outcome === null; i += 1) await vi.advanceTimersByTimeAsync(16);
    await pending;
    expect(outcome).toBe('clipboard');
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(200);
  });
});

describe('copyText', () => {
  it('uses navigator.clipboard.writeText when available', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const execCopy = vi.fn(() => true);
    expect(await copyText('hi', { execCopy })).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hi');
    expect(execCopy).not.toHaveBeenCalled();
  });

  it('falls back to execCopy when navigator.clipboard is missing (plain http)', async () => {
    expect(navigator.clipboard).toBeUndefined();
    const execCopy = vi.fn(() => true);
    expect(await copyText('hi', { execCopy })).toBe(true);
    expect(execCopy).toHaveBeenCalledWith('hi');
    expect(await copyText('hi', { execCopy: () => false })).toBe(false);
  });

  it('a rejected clipboard write reports false without the fallback', async () => {
    const execCopy = vi.fn(() => true);
    expect(await copyText('hi', { writeClipboard: async () => { throw new Error('denied'); }, execCopy })).toBe(false);
    expect(execCopy).not.toHaveBeenCalled();
  });

  it('the default fallback copies from a hidden readonly textarea and restores focus', async () => {
    document.body.innerHTML = '<input id="field">';
    const field = document.getElementById('field');
    field.focus();
    let seen = null;
    document.execCommand = vi.fn((command) => {
      const helper = document.activeElement;
      seen = { command, tag: helper.tagName, value: helper.value, readOnly: helper.readOnly, selected: [helper.selectionStart, helper.selectionEnd] };
      return true;
    });
    expect(await copyText('copied text')).toBe(true);
    expect(seen).toEqual({ command: 'copy', tag: 'TEXTAREA', value: 'copied text', readOnly: true, selected: [0, 11] });
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(field);
  });

  it('insertText copies through the fallback when the page has no Clipboard API', async () => {
    const execCopy = vi.fn(() => true);
    expect(await insertText(null, 'text', deps({ writeClipboard: undefined, execCopy }))).toBe('clipboard');
    expect(execCopy).toHaveBeenCalledWith('text');
  });
});
```

- [ ] **Step 6: Run the insertion tests to verify they fail**

```bash
npx vitest run test/unit/content/insert.test.js
```

Expected: 29 failed, 12 passed (41). Failures include `TypeError: copyText is not a function`, `TypeError: normalizeForCompare is not a function`, order and outcome assertions from the v2.0 ladder (for example "multi-line text tries paste before execCommand" and "a Lexical-like editor never gets a raw DOM insert"), and "resolves without advancing timers once the insert verifies" fails with `Test timed out in 5000ms` (the v2.0 `setTimeout(0)` wait never fires under fake timers).

- [ ] **Step 7: Rewrite `src/content/insert.js`**

```js
// Insertion ladder v2. Every rung is read back only after the page had time to react,
// because editors such as Lexical and ProseMirror commit in a microtask or later. The ladder
// advances only when a rung provably did nothing; any other result ends at the clipboard,
// so the text is never inserted twice.
import { deepActiveElement, isEditableElement, isFrameworkEditor } from './fields.js';

/** Hosts whose editors ignore synthetic input (Google Docs types into a hidden iframe). */
export const CLIPBOARD_ONLY_HOSTS = new Set(['docs.google.com']);

const FRAME_WAIT_MS = 50;
const POLL_MS = 16;
const SETTLE_MS = 100;

/**
 * @typedef {'inserted'|'unverified'|'clipboard'|'failed'} InsertOutcome
 * @typedef {{
 *   execCommand?: (text: string) => boolean,
 *   dispatch?: (el: Element, event: Event) => boolean,
 *   writeClipboard?: (text: string) => Promise<void>,
 *   execCopy?: (text: string) => boolean,
 *   settle?: (check: () => boolean) => Promise<boolean>,
 *   hostname?: string,
 *   createPasteEvent?: (text: string) => Event|null,
 *   isTrusted?: (event: Event) => boolean,
 * }} InsertDeps
 */

/**
 * @param {Element} el
 * @returns {string}
 */
export function readValue(el) {
  return isFormField(el) ? el.value : el.textContent;
}

function isFormField(el) {
  const tag = el?.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea';
}

/**
 * Comparison form for read-backs. Editors turn spaces into NBSP, add zero-width characters
 * and split lines into paragraphs, so all of those are dropped.
 * @param {string} s
 * @returns {string}
 */
export function normalizeForCompare(s) {
  return String(s).replace(/\r\n?/g, '\n').replace(/[ \n\u00A0\u200B\uFEFF]/g, '');
}

/**
 * Copies text. Uses the Clipboard API when the page has one; plain http pages do not, so a
 * hidden textarea and `execCommand('copy')` stand in there.
 * @param {string} text
 * @param {{ writeClipboard?: (text: string) => Promise<void>, execCopy?: (text: string) => boolean }} [deps]
 * @returns {Promise<boolean>}
 */
export async function copyText(text, deps = {}) {
  const write = deps.writeClipboard ?? clipboardWriter();
  if (write) {
    try {
      await write(text);
      return true;
    } catch {
      return false;
    }
  }
  try {
    return (deps.execCopy ?? execCopy)(text) === true;
  } catch {
    return false;
  }
}

function clipboardWriter() {
  const clipboard = globalThis.navigator?.clipboard;
  return typeof clipboard?.writeText === 'function' ? (text) => clipboard.writeText(text) : null;
}

function execCopy(text) {
  const doc = globalThis.document;
  const active = deepActiveElement(doc);
  const selection = active && !isFormField(active) ? selectionFor(active) : null;
  const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  const area = doc.createElement('textarea');
  area.value = text;
  // readonly keeps the helper out of isValidInput, so the pill never moves to it.
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.cssText = 'position: fixed; top: 0; left: 0; width: 1px; height: 1px; opacity: 0;';
  doc.documentElement.append(area);
  try {
    area.focus({ preventScroll: true });
    area.select();
    return doc.execCommand('copy') === true;
  } finally {
    area.remove();
    try {
      active?.focus?.({ preventScroll: true });
      if (range) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    } catch { /* restoring focus is best effort */ }
  }
}

/**
 * Inserts text at the caret of target and verifies that it landed.
 * 'inserted': verified in the field. 'unverified': a rung may have inserted but the
 * read-back was ambiguous; the text was also copied. 'clipboard': nothing was inserted; the
 * text was copied. 'failed': nothing was inserted and the copy failed (or text was empty).
 * @param {Element|null} target
 * @param {string} text
 * @param {InsertDeps} [deps]
 * @returns {Promise<InsertOutcome>}
 */
export async function insertText(target, text, deps = {}) {
  if (typeof text !== 'string' || text === '') return 'failed';
  const copyAs = async (outcome) => ((await copyText(text, deps)) ? outcome : 'failed');
  const hostname = deps.hostname ?? frameHostname(target?.ownerDocument);
  if (!target || !target.isConnected || CLIPBOARD_ONLY_HOSTS.has(hostname)) return copyAs('clipboard');
  // Whitespace-only text cannot be verified by read-back, so it is never typed.
  if (normalizeForCompare(text) === '') return copyAs('clipboard');

  const run = prepare(target, text, deps);
  const stopWatching = watchTrustedInput(run);
  let verdict;
  try {
    verdict = isFormField(target) ? await formLadder(run) : await editableLadder(run);
  } catch {
    verdict = 'ambiguous';
  } finally {
    stopWatching();
  }
  if (verdict === 'inserted') return 'inserted';
  return copyAs(verdict === 'ambiguous' ? 'unverified' : 'clipboard');
}

/** Focuses the target, fixes the caret and records the state every rung is judged against. */
function prepare(target, text, deps) {
  const editable = !isFormField(target);
  const prior = editable ? rangeInside(target) : null;
  try { target.focus({ preventScroll: true }); } catch { /* some hosts throw on focus */ }
  if (editable) placeCaret(target, prior);
  const before = readValue(target);
  return {
    target,
    text,
    before,
    nBefore: normalizeForCompare(before),
    nText: normalizeForCompare(text),
    nExpected: null,
    trusted: false,
    prevented: false,
    exec: deps.execCommand ?? ((t) => target.ownerDocument.execCommand('insertText', false, t)),
    dispatch: deps.dispatch ?? ((el, event) => el.dispatchEvent(event)),
    settle: deps.settle ?? defaultSettle,
    createPasteEvent: deps.createPasteEvent ?? createPasteEvent,
    isTrusted: deps.isTrusted ?? ((event) => event.isTrusted === true),
  };
}

async function formLadder(run) {
  const el = run.target;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  // Inputs without selection support (email) report null offsets; the text is appended.
  const from = typeof start === 'number' ? start : run.before.length;
  const to = typeof end === 'number' ? end : from;
  const expected = run.before.slice(0, from) + run.text + run.before.slice(to);
  run.nExpected = normalizeForCompare(expected);

  // Rung 0: re-applying the same offsets ends the page's typing run, so one Ctrl+Z
  // removes exactly the dictation.
  if (typeof start === 'number') {
    try { el.setSelectionRange(start, end); } catch { /* no selection support */ }
  }
  // Rung 1 only when focus really reached the target, so a focus trap cannot redirect it.
  if (isFocused(el)) {
    const verdict = await attempt(run, () => runExec(run));
    if (verdict !== 'advance') return verdict;
  }
  // Rung 2: a page that prevents beforeinput takes over; otherwise the native setter.
  return attempt(run, () => {
    const allowed = fire(run, beforeInputEvent(run.text));
    if (allowed && el.isConnected && normalizeForCompare(readValue(el)) === run.nBefore) {
      setNativeValue(run, expected, from + run.text.length);
    }
    return true;
  });
}

async function editableLadder(run) {
  const el = run.target;
  const expected = editableSplice(el, run.before, run.text);
  run.nExpected = expected === null ? null : normalizeForCompare(expected);

  const exec = () => attempt(run, () => isFocused(el) && runExec(run));
  const paste = () => attempt(run, () => {
    const event = run.createPasteEvent(run.text);
    if (!event) return false;
    fire(run, event);
    return true;
  });
  // Chrome turns each newline of execCommand into a separate paragraph step, which Lexical
  // may drop after the first line; editors take a multi-line paste whole.
  const rungs = /[\r\n]/.test(run.text) ? [paste, exec] : [exec, paste];
  // A synthetic beforeinput has no default action: it counts only when the editor handles it.
  rungs.push(() => attempt(run, () => {
    fire(run, beforeInputEvent(run.text));
    return true;
  }));
  // Framework editors revert foreign DOM writes one microtask later (the Lexical bug).
  if (isEditableElement(el) && !isFrameworkEditor(el)) rungs.push(() => attempt(run, () => rawInsert(run)));

  for (const rung of rungs) {
    const verdict = await rung();
    if (verdict !== 'advance') return verdict;
  }
  return 'advance';
}

/**
 * Runs one rung. `act` returns false when it did nothing observable, which skips the wait;
 * otherwise the page gets `settle` to react before the read-back.
 */
async function attempt(run, act) {
  run.trusted = false;
  run.prevented = false;
  if (act()) await run.settle(() => judge(run) === 'inserted');
  return judge(run);
}

/**
 * 'inserted' when verified; 'advance' only when the rung provably did nothing; 'untouched'
 * when the target left the document without a sign of an insert; 'ambiguous' otherwise.
 */
function judge(run) {
  const after = normalizeForCompare(readValue(run.target));
  const touched = after !== run.nBefore || run.trusted || run.prevented;
  if (!run.target.isConnected) return touched ? 'ambiguous' : 'untouched';
  if (after === run.nExpected || count(after, run.nText) > count(run.nBefore, run.nText)) return 'inserted';
  return touched ? 'ambiguous' : 'advance';
}

function count(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n += 1;
  return n;
}

function runExec(run) {
  try {
    return run.exec(run.text) === true;
  } catch {
    return false;
  }
}

/** Dispatches a synthetic event at the target; returns false when the page prevented it. */
function fire(run, event) {
  const notCancelled = run.dispatch(run.target, event);
  if (notCancelled === false || event.defaultPrevented) run.prevented = true;
  return !run.prevented;
}

function beforeInputEvent(text) {
  return new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: text });
}

function inputEvent(text) {
  return new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text });
}

function createPasteEvent(text) {
  const { ClipboardEvent: Clipboard, DataTransfer: Transfer } = globalThis;
  if (typeof Clipboard !== 'function' || typeof Transfer !== 'function') return null;
  const clipboardData = new Transfer();
  clipboardData.setData('text/plain', text);
  return new Clipboard('paste', { bubbles: true, cancelable: true, composed: true, clipboardData });
}

function setNativeValue(run, value, caret) {
  const el = run.target;
  const setter = valueSetter(el);
  if (setter) setter.call(el, value); else el.value = value;
  try { el.setSelectionRange(caret, caret); } catch { /* no selection support */ }
  run.dispatch(el, inputEvent(run.text));
  run.dispatch(el, new Event('change', { bubbles: true }));
}

/** The prototype's value setter, found on the element's own realm (frames have their own). */
function valueSetter(el) {
  for (let proto = Object.getPrototypeOf(el); proto; proto = Object.getPrototypeOf(proto)) {
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) return setter;
  }
  return null;
}

function rawInsert(run) {
  const el = run.target;
  const sel = selectionFor(el);
  let range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  if (!range || !el.contains(range.commonAncestorContainer)) range = endOfContents(el);
  range.deleteContents();
  const node = el.ownerDocument.createTextNode(run.text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
  run.dispatch(el, inputEvent(run.text));
  return true;
}

/** Records trusted input events in the target's window for the duration of the call. */
function watchTrustedInput(run) {
  const win = run.target.ownerDocument?.defaultView;
  if (!win) return () => {};
  const onInput = (event) => {
    if (run.isTrusted(event)) run.trusted = true;
  };
  win.addEventListener('input', onInput, true);
  return () => win.removeEventListener('input', onInput, true);
}

function isFocused(el) {
  return el.getRootNode().activeElement === el;
}

/** The field's value with text spliced over the current selection, or null when unknown. */
function editableSplice(el, before, text) {
  try {
    const sel = selectionFor(el);
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return null;
    const prefix = el.ownerDocument.createRange();
    prefix.selectNodeContents(el);
    prefix.setEnd(range.startContainer, range.startOffset);
    const from = prefix.toString().length;
    prefix.setEnd(range.endContainer, range.endOffset);
    return before.slice(0, from) + text + before.slice(prefix.toString().length);
  } catch {
    return null;
  }
}

/**
 * Selection that sees into el's shadow root; Chrome retargets document.getSelection() to the host.
 * @param {Element} el
 */
function selectionFor(el) {
  const root = el.getRootNode();
  return (typeof root.getSelection === 'function' && root.getSelection()) || el.ownerDocument.getSelection();
}

/** Clone of the selection range when it lies inside el, taken before focus() can move it. */
function rangeInside(el) {
  const sel = selectionFor(el);
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  return el.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
}

/** focus() puts the caret at the start of an editable; restore the prior caret or go to the end. */
function placeCaret(el, prior) {
  try {
    const sel = selectionFor(el);
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(prior ?? endOfContents(el));
  } catch { /* keep whatever selection focus() left */ }
}

/**
 * Collapsed range at the end of the last non-blank text node, so text typed "at the end"
 * joins the last paragraph instead of landing after it at the editor root.
 */
function endOfContents(el) {
  const doc = el.ownerDocument;
  const range = doc.createRange();
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let last = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (/\S/.test(node.data)) last = node;
  }
  if (last) {
    range.setStart(last, last.data.length);
    range.collapse(true);
  } else {
    range.selectNodeContents(el);
    range.collapse(false);
  }
  return range;
}

function frameHostname(doc) {
  const loc = doc?.location;
  if (!loc) return '';
  if (loc.hostname) return loc.hostname;
  // about:blank frames inherit their parent's origin; Google Docs types into one.
  try {
    return new URL(loc.ancestorOrigins?.[0] ?? '').hostname;
  } catch {
    return '';
  }
}

/**
 * Waits for the page to react: one macrotask (MessageChannel, which hidden tabs do not
 * throttle and fake timers do not replace), then one animation frame raced with 50 ms, then
 * polls every 16 ms up to 100 ms in total. Resolves true as soon as check() is true.
 * @param {() => boolean} check
 * @returns {Promise<boolean>}
 */
async function defaultSettle(check) {
  const started = performance.now();
  await nextMacrotask();
  if (check()) return true;
  await nextFrame();
  if (check()) return true;
  while (performance.now() - started < SETTLE_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (check()) return true;
  }
  return false;
}

function nextMacrotask() {
  if (typeof MessageChannel !== 'function') return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

function nextFrame() {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FRAME_WAIT_MS);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      });
    }
  });
}
```

- [ ] **Step 8: Run the content tests to verify they pass**

```bash
npx vitest run test/unit/content/fields.test.js test/unit/content/insert.test.js
```

Expected: 2 files, 53 passed. "a raw insert that the page reverts in a microtask is not reported as inserted" takes about 250 ms: it runs the real default settle through two 100 ms rungs.

- [ ] **Step 9: Run the full suite and the build**

```bash
npm test
npm run build
```

Expected: every file passes; report the count as N/N (this task adds 38 tests: fields 5 to 12, insert 10 to 41). The build is clean: the v2.0 content entry still bundles `insert.js` and `fields.js`.

- [ ] **Step 10: Commit**

```bash
git add src/content/fields.js src/content/insert.js test/unit/content/fields.test.js test/unit/content/insert.test.js
git commit -m "Rebuild the insertion ladder with settled read-backs, editor detection and a copy fallback"
```

---

### Task 8: Positioning and anchor tracking

**Files:**
- Create: `src/content/position.js`, `src/content/anchor.js`
- Test: `test/unit/content/position.test.js`, `test/unit/content/anchor.test.js`

**Interfaces:**
- Produces:
  - `@typedef {{ top: number, left: number, width: number, height: number }} Box` (viewport coordinates) and `@typedef {{ width: number, height: number }} Size`.
  - `EDGE = 4` (minimum distance to the viewport edge), `CORNER_MARGIN = 16`.
  - `computePillPosition({ anchor: Box|null, pill: Size, viewport: Size, gap: number }): { top: number, left: number, placement: 'left'|'right'|'above'|'below'|'inside'|'corner'|'hidden' }`:
    - `anchor === null`: `'corner'`, bottom right, `CORNER_MARGIN` from both edges.
    - Anchor entirely outside the viewport: `'hidden'`.
    - Else the first that fits, in order: `'left'` (`left = anchor.left - gap - pill.width >= EDGE`), `'right'` (`anchor.left + anchor.width + gap + pill.width <= viewport.width - EDGE`), both vertically centred on the anchor and clamped to `[EDGE, viewport.height - pill.height - EDGE]`; `'above'` (`top = anchor.top - gap - pill.height >= EDGE`), `'below'` (`top = anchor.top + anchor.height + gap` and `top + pill.height <= viewport.height - EDGE`), both with `left` clamped from `anchor.left` into `[EDGE, viewport.width - pill.width - EDGE]`; otherwise `'inside'` (full-page editors): the anchor's visible top-right corner, `top = clamp(max(anchor.top, 0) + gap)`, `left = clamp(min(anchor.left + anchor.width, viewport.width) - gap - pill.width)`, both clamped into the viewport with `EDGE`.
  - `computeMenuPlacement({ pill: Box, menu: Size, viewport: Size, gap: number }): { top: number, left: number, placement: 'below'|'above' }`: below when `pill.top + pill.height + gap + menu.height <= viewport.height - EDGE`, else above with `top` clamped to at least `EDGE`; `left` aligned to `pill.left` and clamped.
  - `watchAnchor(el: Element, onChange: () => void, { win = window } = {}): () => void`: `scroll` on `win` (capture, passive), `resize` on `win`, a `ResizeObserver` on `el` when `win.ResizeObserver` exists; calls coalesced to one per animation frame; the returned function removes everything and cancels a pending frame.
- Acceptance mapping (spec 6.3): a field inside a scrolling container follows; a left-flush field gets `'right'`; a bottom-edge field opens the menu `'above'`.

WRITER NOTES

- Written to the amended contract: `'below'` only when the pill fits under the anchor, then `'inside'` at the anchor's visible top-right corner (full-page editors), both coordinates clamped into the viewport with `EDGE`; the menu's `'above'` top is clamped to at least `EDGE`.
- `'hidden'` uses `<=`/`>=` comparisons, so the all-zero box of a `display: none` field hides the pill.
- `watchAnchor` ignores signals after it is stopped (a queued ResizeObserver delivery cannot schedule a frame) and stopping twice is harmless.

- [ ] **Step 1: Write the failing position tests**

`test/unit/content/position.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { computePillPosition, computeMenuPlacement, EDGE, CORNER_MARGIN } from '../../../src/content/position.js';

const viewport = { width: 1000, height: 800 };
const pill = { width: 100, height: 40 };
const gap = 8;

function box(left, top, width, height) {
  return { left, top, width, height };
}

describe('constants', () => {
  it('keeps 4 px from the viewport edge and 16 px in the corner', () => {
    expect(EDGE).toBe(4);
    expect(CORNER_MARGIN).toBe(16);
  });
});

describe('computePillPosition', () => {
  it('without an anchor sits in the bottom right corner', () => {
    expect(computePillPosition({ anchor: null, pill, viewport, gap })).toEqual({
      top: 800 - 40 - CORNER_MARGIN, left: 1000 - 100 - CORNER_MARGIN, placement: 'corner',
    });
  });

  it('hides when the anchor is entirely outside the viewport on any side', () => {
    const outside = [
      box(300, -60, 200, 50), // above
      box(300, 800, 200, 50), // below
      box(-250, 300, 200, 50), // left
      box(1000, 300, 200, 50), // right
      box(0, 0, 0, 0), // display: none reports an empty box at the origin
    ];
    for (const anchor of outside) {
      expect(computePillPosition({ anchor, pill, viewport, gap }).placement, JSON.stringify(anchor)).toBe('hidden');
    }
  });

  it('prefers the left side, vertically centred on the anchor', () => {
    expect(computePillPosition({ anchor: box(300, 200, 400, 100), pill, viewport, gap })).toEqual({
      top: 200 + (100 - 40) / 2, left: 300 - 8 - 100, placement: 'left',
    });
  });

  it('uses the left side when it lands exactly on EDGE', () => {
    const anchor = box(EDGE + 100 + gap, 200, 300, 40);
    expect(computePillPosition({ anchor, pill, viewport, gap })).toMatchObject({ left: EDGE, placement: 'left' });
  });

  it('falls to the right side when the left does not fit', () => {
    const anchor = box(50, 200, 400, 40);
    expect(computePillPosition({ anchor, pill, viewport, gap })).toEqual({ top: 200, left: 50 + 400 + 8, placement: 'right' });
  });

  it('uses the right side when it ends exactly EDGE from the viewport edge', () => {
    const anchor = box(0, 200, 1000 - EDGE - 100 - gap, 40);
    expect(computePillPosition({ anchor, pill, viewport, gap })).toMatchObject({ left: 1000 - EDGE - 100, placement: 'right' });
  });

  it('clamps the side placements vertically into the viewport', () => {
    const nearTop = computePillPosition({ anchor: box(300, -10, 200, 20), pill, viewport, gap });
    expect(nearTop).toMatchObject({ top: EDGE, placement: 'left' });
    const nearBottom = computePillPosition({ anchor: box(300, 790, 200, 30), pill, viewport, gap });
    expect(nearBottom).toMatchObject({ top: 800 - 40 - EDGE, placement: 'left' });
  });

  it('goes above a full-width anchor, with left clamped from anchor.left', () => {
    expect(computePillPosition({ anchor: box(0, 300, 1000, 100), pill, viewport, gap })).toEqual({
      top: 300 - 8 - 40, left: EDGE, placement: 'above',
    });
    const wideRight = computePillPosition({ anchor: box(950, 300, 50, 100), pill: { width: 990, height: 40 }, viewport, gap });
    expect(wideRight).toMatchObject({ left: 1000 - 990 - EDGE, placement: 'above' });
  });

  it('goes below a full-width anchor at the top of the viewport', () => {
    expect(computePillPosition({ anchor: box(0, 20, 1000, 100), pill, viewport, gap })).toEqual({
      top: 20 + 100 + 8, left: EDGE, placement: 'below',
    });
  });

  it('uses below only when the pill fits under the anchor', () => {
    const fits = computePillPosition({ anchor: box(0, 20, 1000, 728), pill, viewport, gap });
    expect(fits).toEqual({ top: 20 + 728 + 8, left: EDGE, placement: 'below' });
    expect(fits.top + pill.height).toBe(800 - EDGE);
    const tooTall = computePillPosition({ anchor: box(0, 20, 1000, 729), pill, viewport, gap });
    expect(tooTall.placement).toBe('inside');
  });

  it('a full-viewport anchor gets inside, fully on screen', () => {
    const position = computePillPosition({ anchor: box(0, 0, 1000, 800), pill, viewport, gap });
    expect(position).toEqual({ top: 0 + 8, left: 1000 - 8 - 100, placement: 'inside' });
    expect(position.top).toBeGreaterThanOrEqual(EDGE);
    expect(position.top + pill.height).toBeLessThanOrEqual(800 - EDGE);
    expect(position.left).toBeGreaterThanOrEqual(EDGE);
    expect(position.left + pill.width).toBeLessThanOrEqual(1000 - EDGE);
  });

  it('an anchor larger than the viewport gets inside within the viewport', () => {
    const position = computePillPosition({ anchor: box(-50, -300, 1200, 2000), pill, viewport, gap });
    expect(position).toEqual({ top: 8, left: 1000 - 8 - 100, placement: 'inside' });
  });

  it('inside sits at the visible top-right corner of the anchor', () => {
    expect(computePillPosition({ anchor: box(60, 30, 900, 900), pill, viewport, gap })).toEqual({
      top: 30 + 8, left: 60 + 900 - 8 - 100, placement: 'inside',
    });
  });

  it('inside is clamped into the viewport with EDGE', () => {
    const narrow = { width: 104, height: 800 };
    expect(computePillPosition({ anchor: box(0, 0, 104, 800), pill, viewport: narrow, gap })).toEqual({
      top: 8, left: EDGE, placement: 'inside',
    });
    expect(computePillPosition({ anchor: box(0, 0, 1000, 800), pill, viewport, gap: 0 })).toEqual({
      top: EDGE, left: 1000 - 100 - EDGE, placement: 'inside',
    });
  });

  it('spec 6.3: follows a field inside a scrolling container', () => {
    const before = computePillPosition({ anchor: box(400, 500, 300, 40), pill, viewport, gap });
    const scrolled = computePillPosition({ anchor: box(400, 380, 300, 40), pill, viewport, gap });
    expect(scrolled.placement).toBe(before.placement);
    expect(scrolled.left).toBe(before.left);
    expect(scrolled.top).toBe(before.top - 120);
    const scrolledOut = computePillPosition({ anchor: box(400, -45, 300, 40), pill, viewport, gap });
    expect(scrolledOut.placement).toBe('hidden');
  });

  it('spec 6.3: a left-flush field gets the pill on its right', () => {
    expect(computePillPosition({ anchor: box(0, 300, 500, 40), pill, viewport, gap })).toEqual({
      top: 300, left: 500 + 8, placement: 'right',
    });
  });
});

describe('computeMenuPlacement', () => {
  const menu = { width: 240, height: 300 };

  it('opens below the pill when it fits, aligned to the pill', () => {
    expect(computeMenuPlacement({ pill: box(200, 100, 100, 40), menu, viewport, gap })).toEqual({
      top: 100 + 40 + 8, left: 200, placement: 'below',
    });
  });

  it('opens below when it ends exactly EDGE from the bottom', () => {
    const top = 800 - EDGE - 300 - 8 - 40;
    expect(computeMenuPlacement({ pill: box(200, top, 100, 40), menu, viewport, gap }).placement).toBe('below');
    expect(computeMenuPlacement({ pill: box(200, top + 1, 100, 40), menu, viewport, gap }).placement).toBe('above');
  });

  it('spec 6.3: a bottom-edge field opens the menu above', () => {
    expect(computeMenuPlacement({ pill: box(200, 740, 100, 40), menu, viewport, gap })).toEqual({
      top: 740 - 8 - 300, left: 200, placement: 'above',
    });
  });

  it('clamps the above placement to EDGE near the top', () => {
    const short = { width: 1000, height: 400 };
    expect(computeMenuPlacement({ pill: box(200, 200, 100, 40), menu, viewport: short, gap })).toEqual({
      top: EDGE, left: 200, placement: 'above',
    });
  });

  it('clamps left into the viewport', () => {
    expect(computeMenuPlacement({ pill: box(900, 100, 100, 40), menu, viewport, gap }).left).toBe(1000 - 240 - EDGE);
    expect(computeMenuPlacement({ pill: box(-20, 100, 100, 40), menu, viewport, gap }).left).toBe(EDGE);
  });
});
```

- [ ] **Step 2: Write the failing anchor tests**

`test/unit/content/anchor.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { watchAnchor } from '../../../src/content/anchor.js';

const captureOf = (options) => (typeof options === 'object' ? Boolean(options?.capture) : Boolean(options));

/** A window stand-in with listener, animation frame and ResizeObserver bookkeeping. */
function fakeWin({ resizeObserver = true } = {}) {
  const listeners = [];
  const frames = new Map();
  const observers = [];
  let nextFrame = 1;
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      this.disconnected = false;
      observers.push(this);
    }
    observe(el) { this.targets.push(el); }
    disconnect() { this.disconnected = true; }
  }
  const win = {
    addEventListener: vi.fn((type, fn, options) => listeners.push({ type, fn, options })),
    // Like the DOM: a listener is identified by type, callback and capture flag.
    removeEventListener: vi.fn((type, fn, options) => {
      const index = listeners.findIndex((l) => l.type === type && l.fn === fn && captureOf(l.options) === captureOf(options));
      if (index !== -1) listeners.splice(index, 1);
    }),
    requestAnimationFrame: vi.fn((callback) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, callback);
      return id;
    }),
    cancelAnimationFrame: vi.fn((id) => frames.delete(id)),
  };
  if (resizeObserver) win.ResizeObserver = FakeResizeObserver;
  return {
    win,
    listeners,
    observers,
    frames,
    fire(type) {
      for (const l of listeners.filter((entry) => entry.type === type)) l.fn({ type });
    },
    flushFrames() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(16);
    },
  };
}

const el = { id: 'field' };

describe('watchAnchor', () => {
  it('listens for scroll (capture, passive) and resize on the window and observes the element', () => {
    const fake = fakeWin();
    watchAnchor(el, () => {}, { win: fake.win });
    expect(fake.listeners.map(({ type, options }) => [type, options])).toEqual([
      ['scroll', { capture: true, passive: true }],
      ['resize', undefined],
    ]);
    expect(fake.observers).toHaveLength(1);
    expect(fake.observers[0].targets).toEqual([el]);
  });

  it('spec 6.3: a scroll inside a nested container reaches the capture listener and repositions', () => {
    const fake = fakeWin();
    const onChange = vi.fn();
    watchAnchor(el, onChange, { win: fake.win });
    // Scroll events do not bubble; only a capture listener on the window sees a container scroll.
    expect(fake.listeners.find((l) => l.type === 'scroll').options.capture).toBe(true);
    fake.fire('scroll');
    expect(onChange).not.toHaveBeenCalled();
    fake.flushFrames();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('coalesces scroll, resize and resize-observer signals into one callback per frame', () => {
    const fake = fakeWin();
    const onChange = vi.fn();
    watchAnchor(el, onChange, { win: fake.win });
    fake.fire('scroll');
    fake.fire('scroll');
    fake.fire('resize');
    fake.observers[0].callback([]);
    expect(fake.win.requestAnimationFrame).toHaveBeenCalledTimes(1);
    fake.flushFrames();
    expect(onChange).toHaveBeenCalledTimes(1);
    fake.fire('resize');
    fake.flushFrames();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(fake.win.requestAnimationFrame).toHaveBeenCalledTimes(2);
  });

  it('works without ResizeObserver', () => {
    const fake = fakeWin({ resizeObserver: false });
    const onChange = vi.fn();
    const stop = watchAnchor(el, onChange, { win: fake.win });
    fake.fire('resize');
    fake.flushFrames();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(() => stop()).not.toThrow();
  });

  it('the returned function removes every listener, disconnects the observer and cancels a pending frame', () => {
    const fake = fakeWin();
    const onChange = vi.fn();
    const stop = watchAnchor(el, onChange, { win: fake.win });
    fake.fire('scroll');
    const pending = [...fake.frames.keys()][0];
    stop();
    expect(fake.listeners).toEqual([]);
    expect(fake.observers[0].disconnected).toBe(true);
    expect(fake.win.cancelAnimationFrame).toHaveBeenCalledWith(pending);
    expect(fake.frames.size).toBe(0);
    fake.observers[0].callback([]);
    fake.flushFrames();
    expect(onChange).not.toHaveBeenCalled();
    expect(fake.win.requestAnimationFrame).toHaveBeenCalledTimes(1);
  });

  it('stopping twice is harmless', () => {
    const fake = fakeWin();
    const stop = watchAnchor(el, () => {}, { win: fake.win });
    stop();
    expect(() => stop()).not.toThrow();
    expect(fake.win.cancelAnimationFrame).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npx vitest run test/unit/content/position.test.js test/unit/content/anchor.test.js
```

Expected: both files fail with `Error: Cannot find module '../../../src/content/position.js'` and `Error: Cannot find module '../../../src/content/anchor.js'`; no tests run.

- [ ] **Step 4: Create `src/content/position.js`**

```js
// Pure placement math for the pill and its menu. All boxes are in viewport coordinates
// (getBoundingClientRect), so the pill host can use position: fixed.

/**
 * @typedef {{ top: number, left: number, width: number, height: number }} Box
 * @typedef {{ width: number, height: number }} Size
 */

/** Minimum distance between the pill or menu and the viewport edge. */
export const EDGE = 4;
/** Distance from the bottom right corner when there is no field to anchor to. */
export const CORNER_MARGIN = 16;

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

/**
 * Places the pill next to its field: left, else right, else above, else below, else inside
 * the field's visible top-right corner (full-page editors). Without a field it sits in the
 * bottom right corner; a field scrolled out of view hides it.
 * @param {{ anchor: Box|null, pill: Size, viewport: Size, gap: number }} input
 * @returns {{ top: number, left: number, placement: 'left'|'right'|'above'|'below'|'inside'|'corner'|'hidden' }}
 */
export function computePillPosition({ anchor, pill, viewport, gap }) {
  if (anchor === null) {
    return {
      top: viewport.height - pill.height - CORNER_MARGIN,
      left: viewport.width - pill.width - CORNER_MARGIN,
      placement: 'corner',
    };
  }
  const outside = anchor.top + anchor.height <= 0 || anchor.top >= viewport.height
    || anchor.left + anchor.width <= 0 || anchor.left >= viewport.width;
  if (outside) return { top: 0, left: 0, placement: 'hidden' };

  const middle = clamp(anchor.top + (anchor.height - pill.height) / 2, EDGE, viewport.height - pill.height - EDGE);
  const leftSide = anchor.left - gap - pill.width;
  if (leftSide >= EDGE) return { top: middle, left: leftSide, placement: 'left' };
  const rightSide = anchor.left + anchor.width + gap;
  if (rightSide + pill.width <= viewport.width - EDGE) return { top: middle, left: rightSide, placement: 'right' };

  const maxTop = viewport.height - pill.height - EDGE;
  const maxLeft = viewport.width - pill.width - EDGE;
  const left = clamp(anchor.left, EDGE, maxLeft);
  const above = anchor.top - gap - pill.height;
  if (above >= EDGE) return { top: above, left, placement: 'above' };
  const below = anchor.top + anchor.height + gap;
  if (below + pill.height <= viewport.height - EDGE) return { top: below, left, placement: 'below' };

  return {
    top: clamp(Math.max(anchor.top, 0) + gap, EDGE, maxTop),
    left: clamp(Math.min(anchor.left + anchor.width, viewport.width) - gap - pill.width, EDGE, maxLeft),
    placement: 'inside',
  };
}

/**
 * Opens the menu below the pill when it fits, else above (never past the top edge);
 * left-aligned with the pill.
 * @param {{ pill: Box, menu: Size, viewport: Size, gap: number }} input
 * @returns {{ top: number, left: number, placement: 'below'|'above' }}
 */
export function computeMenuPlacement({ pill, menu, viewport, gap }) {
  const left = clamp(pill.left, EDGE, viewport.width - menu.width - EDGE);
  const below = pill.top + pill.height + gap;
  if (below + menu.height <= viewport.height - EDGE) return { top: below, left, placement: 'below' };
  return { top: Math.max(EDGE, pill.top - gap - menu.height), left, placement: 'above' };
}
```

- [ ] **Step 5: Create `src/content/anchor.js`**

```js
// Keeps the pill attached to its field: any scroll (including inside nested containers),
// window resize or field resize schedules one callback on the next animation frame.

/**
 * @param {Element} el the field the pill is anchored to
 * @param {() => void} onChange called at most once per animation frame
 * @param {{ win?: Window }} [options]
 * @returns {() => void} stops watching and cancels a pending frame
 */
export function watchAnchor(el, onChange, { win = window } = {}) {
  let frame = null;
  let stopped = false;
  const schedule = () => {
    if (stopped || frame !== null) return;
    frame = win.requestAnimationFrame(() => {
      frame = null;
      if (!stopped) onChange();
    });
  };
  // Scroll events do not bubble; a capture listener on the window sees every container scroll.
  const scrollOptions = { capture: true, passive: true };
  win.addEventListener('scroll', schedule, scrollOptions);
  win.addEventListener('resize', schedule);
  const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(schedule) : null;
  observer?.observe(el);

  return () => {
    if (stopped) return;
    stopped = true;
    win.removeEventListener('scroll', schedule, scrollOptions);
    win.removeEventListener('resize', schedule);
    observer?.disconnect();
    if (frame !== null) {
      win.cancelAnimationFrame(frame);
      frame = null;
    }
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run test/unit/content/position.test.js test/unit/content/anchor.test.js
```

Expected: 2 files, 28 passed (position 22, anchor 6).

- [ ] **Step 7: Run the full suite**

```bash
npm test
```

Expected: every file passes; report the count as N/N (this task adds 28 tests).

- [ ] **Step 8: Commit**

```bash
git add src/content/position.js src/content/anchor.js test/unit/content/position.test.js test/unit/content/anchor.test.js
git commit -m "Add pill positioning and anchor tracking"
```

---

### Task 9: Shadow DOM pill

**Files:**
- Create: `src/content/pill.js`, `src/content/pill.css`
- Test: `test/unit/content/pill.test.js` (jsdom)

**Interfaces:**
- Consumes: Task 8 `computePillPosition`, `computeMenuPlacement`; Task 3 `PublicSettings`, `formatChord`; `formatCost` from `pricing.js`.
- Produces:
  - `@typedef {'idle'|'recording'|'processing'|'done'|'error'} PillState`
  - `@typedef {{ onRec: () => void, onStatusClick: () => void, onMenuOpen: () => void, onMode: (key: string) => void, onProvider: (id: string) => void, onTargetLang: (lang: string) => void }} PillHandlers`
  - `class Pill`:
    - `constructor(handlers: PillHandlers, { doc = document, shadowMode = 'closed' } = {})`
    - `mount(): void`: idempotent; creates `<voicetype-host>` appended to `doc.documentElement`, host `style.cssText` begins `all: initial;` then `position: fixed; top: 0; left: 0; z-index: 2147483647;`; `attachShadow({ mode: shadowMode })`; styles from `pill.css` (imported as text) through `adoptedStyleSheets` when `CSSStyleSheet.prototype.replaceSync` exists, else a `<style>` element.
    - `readonly root: ShadowRoot` (test hook; the page cannot reach it from its own world).
    - `readonly host: HTMLElement`
    - `show(anchor: Box|null, { gap = 8 } = {}): void` positions with `computePillPosition`; `'hidden'` placement hides. `reposition(anchor)` recomputes without other changes. `hide(): void` (also closes the menu). `readonly visible: boolean`.
    - `setState(state: PillState): void`: sets `data-state` on the pill root element and the REC button's `aria-label` (`Start recording` or `Stop recording`); recording shows a mm:ss timer driven by `setInterval(250)` from the moment the state becomes `'recording'`.
    - `setLevel(level: number): void`: clamps to [0, 1] and sets a CSS custom property `--vt-level`; glow capped in CSS.
    - `setStatus(text: string, { tone = 'info', sticky = false, clickable = false, terminal = false } = {}): void`: `textContent` only; non-sticky messages clear after 6000 ms for `'error'` and `'warning'`, 2500 ms for `'info'` and `'success'`; `clickable` makes a click call `handlers.onStatusClick`; `terminal` locks the status so later `setStatus` calls are ignored. The status element has `role="status"` and `aria-live="polite"` and is placed on the side opposite an open menu.
    - `clearStatus(): void` (ignored when terminal).
    - `renderMenu(settings: PublicSettings, usage: { todayCost: number, todaySessions: number, totalCost: number } | null): void`: builds modes (active marked with `aria-checked`), the translate row (`English, Greek, Spanish, French, German`) only when the active mode has `hasLanguageOption`, a provider segmented control (a provider without a key shows "no key"), the usage line (`Today $0.004 (3), all time $0.21`), and the hotkey hint (`formatChord(settings.hotkey)` plus "tap to toggle, hold to talk"). All labels via `textContent`; controls are buttons with `type="button"`.
    - `openMenu()`, `closeMenu()`, `readonly menuOpen: boolean`; opening calls `handlers.onMenuOpen`; menu placement from `computeMenuPlacement`.
    - `destroy(): void` removes the host and clears every timer.
  - Behaviour: every `mousedown` inside the shadow root calls `preventDefault()` so focus never leaves the page field; `Escape` closes the menu; icons are inline SVG built with `createElementNS` from path constants (mic, stop, dots, check, alert, globe); no emoji in the pill's own controls.
- Ledger: parked C3 (status durations standardised), parked status and menu overlap, M3 invariant (a mode named `<img src=x onerror=alert(1)>` renders literally and creates no element).
- Spec 6.2 acceptance: `test/fixtures/hostile.html` (Task 13) renders the pill identically.

WRITER NOTES

- Usage line: the Interfaces example `Today $0.004 (3)` cannot come from `formatCost`, which the block also names and which prints `<$0.01` below one cent. The pill uses `formatCost`; the test pins `Today $0.01 (3), all time $0.21` and `Today <$0.01 (1), all time $0.00`. Change `formatCost` (or add a finer formatter) if sub-cent figures are wanted.
- Additions Task 11 relies on: exports `PILL_SIZE` (140 x 30, the expanded pill; `.pill` in `pill.css` has the same size), `STATUS_MS` (the controller times its own hide check with it) and `TARGET_LANGUAGES`. `show()` mounts lazily, so frames without a focused field never get a host. The menu also closes on a mousedown outside the pill, and Escape is consumed only while the menu is open.
- Placement is an open union: the pill is placed from `top`/`left` for every value and hides only for `'hidden'`. Two refinements: `'left'`, `'inside'` and `'corner'` right-align the pill in its slot (it grows away from the field or the viewport edge, and the status aligns to that side); `'above'` and `'corner'` put the status above the pill. Any other value gets the defaults.
- jsdom test files: Vite's web transform rewrites `new URL('<literal>', import.meta.url)` to `http://localhost:3000/...` and jsdom replaces `URL`, so the test reads files through a small path helper.

- [ ] **Step 1: Write the failing pill tests**

`test/unit/content/pill.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pill, PILL_SIZE, STATUS_MS, TARGET_LANGUAGES } from '../../../src/content/pill.js';
import { computePillPosition } from '../../../src/content/position.js';

// A path, not a URL literal: jsdom replaces the global URL, and the web transform rewrites
// `new URL('<literal>', import.meta.url)` into a dev-server address.
const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url).href), 'utf8');
const CSS_TEXT = read('../../../src/content/pill.css');
const VIEWPORT = { width: 1024, height: 768 }; // jsdom's innerWidth and innerHeight
const FIELD = { top: 100, left: 400, width: 300, height: 30 };
const BOTTOM_FIELD = { top: 730, left: 400, width: 300, height: 30 };
const HOSTILE = '<img src=x onerror=alert(1)>';

function handlers() {
  return {
    onRec: vi.fn(), onStatusClick: vi.fn(), onMenuOpen: vi.fn(),
    onMode: vi.fn(), onProvider: vi.fn(), onTargetLang: vi.fn(),
  };
}

function makePill() {
  const h = handlers();
  const pill = new Pill(h, { shadowMode: 'open' });
  return { pill, h };
}

function settings(overrides = {}) {
  return {
    provider: 'openai',
    hasKey: { openai: true, gemini: false },
    activeMode: 'default',
    translateTargetLang: 'Greek',
    hotkey: { code: 'Space', ctrl: true, shift: true, alt: false, meta: false },
    pillGap: 8,
    modes: {
      default: { name: 'Default', icon: '🎤', prompt: '', builtIn: true },
      translate: { name: 'Translate', icon: '🌐', prompt: 'x', builtIn: true, hasLanguageOption: true },
    },
    ...overrides,
  };
}

const q = (pill, selector) => pill.root.querySelector(selector);
const statusEl = (pill) => q(pill, '[role="status"]');

beforeEach(() => {
  document.documentElement.querySelectorAll('voicetype-host').forEach((el) => el.remove());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('mount', () => {
  it('appends one host to documentElement with the all: initial prefix and the top z-index', () => {
    const { pill } = makePill();
    pill.mount();
    pill.mount();
    const hosts = document.documentElement.querySelectorAll('voicetype-host');
    expect(hosts).toHaveLength(1);
    expect(pill.host).toBe(hosts[0]);
    expect(pill.host.parentNode).toBe(document.documentElement);
    expect(pill.host.style.cssText).toMatch(/^all: initial; position: fixed; top: 0(px)?; left: 0(px)?; z-index: 2147483647;/);
    expect(pill.root.mode).toBe('open');
  });

  it('uses a closed shadow root by default', () => {
    const pill = new Pill(handlers());
    pill.mount();
    expect(pill.host.shadowRoot).toBeNull();
    expect(pill.root.mode).toBe('closed');
  });

  it('adopts the stylesheet when constructable sheets are supported', () => {
    const { pill } = makePill();
    pill.mount();
    expect(pill.root.adoptedStyleSheets).toHaveLength(1);
    expect(pill.root.querySelector('style')).toBeNull();
  });

  it('falls back to a style element holding pill.css when replaceSync is missing', () => {
    const replaceSync = CSSStyleSheet.prototype.replaceSync;
    delete CSSStyleSheet.prototype.replaceSync;
    try {
      const { pill } = makePill();
      pill.mount();
      expect(pill.root.querySelector('style').textContent).toBe(CSS_TEXT);
    } finally {
      CSSStyleSheet.prototype.replaceSync = replaceSync;
    }
  });

  it('keeps the host invisible until show()', () => {
    const { pill } = makePill();
    pill.mount();
    expect(pill.visible).toBe(false);
    expect(q(pill, '.vt').hidden).toBe(true);
  });
});

describe('placement', () => {
  it('positions the pill with computePillPosition and mounts on first show', () => {
    const { pill } = makePill();
    pill.show(FIELD, { gap: 12 });
    const expected = computePillPosition({ anchor: FIELD, pill: PILL_SIZE, viewport: VIEWPORT, gap: 12 });
    const el = q(pill, '.pill');
    expect(pill.visible).toBe(true);
    expect(el.dataset.placement).toBe(expected.placement);
    expect(el.style.top).toBe(`${Math.round(expected.top)}px`);
    expect(el.style.left).toBe(`${Math.round(expected.left)}px`);
  });

  it('uses the corner without an anchor', () => {
    const { pill } = makePill();
    pill.show(null);
    expect(q(pill, '.pill').dataset.placement).toBe('corner');
  });

  it('hides for an anchor outside the viewport and comes back on reposition', () => {
    const { pill } = makePill();
    pill.show({ top: -500, left: 400, width: 300, height: 30 });
    expect(pill.visible).toBe(false);
    expect(q(pill, '.vt').hidden).toBe(true);
    pill.reposition(FIELD);
    expect(pill.visible).toBe(true);
  });

  it('hide() hides, and reposition() does not bring it back', () => {
    const { pill } = makePill();
    pill.show(FIELD);
    pill.hide();
    expect(pill.visible).toBe(false);
    pill.reposition(FIELD);
    expect(pill.visible).toBe(false);
  });
});

describe('state and level', () => {
  it('sets data-state and the REC aria-label', () => {
    const { pill } = makePill();
    pill.show(FIELD);
    const rec = q(pill, '.rec');
    expect(rec.getAttribute('aria-label')).toBe('Start recording');
    for (const state of ['recording', 'processing', 'done', 'error', 'idle']) {
      pill.setState(state);
      expect(q(pill, '.pill').dataset.state).toBe(state);
      expect(rec.getAttribute('aria-label')).toBe(state === 'recording' ? 'Stop recording' : 'Start recording');
    }
    pill.setState('bogus');
    expect(q(pill, '.pill').dataset.state).toBe('idle');
  });

  it('shows an mm:ss timer from the moment recording starts', () => {
    vi.useFakeTimers();
    const { pill } = makePill();
    pill.show(FIELD);
    const label = q(pill, '.rec-label');
    expect(label.textContent).toBe('REC');
    pill.setState('recording');
    expect(label.textContent).toBe('00:00');
    vi.advanceTimersByTime(3000);
    expect(label.textContent).toBe('00:03');
    vi.advanceTimersByTime(62000);
    expect(label.textContent).toBe('01:05');
    pill.setState('processing');
    expect(vi.getTimerCount()).toBe(0);
    pill.setState('idle');
    expect(label.textContent).toBe('REC');
  });

  it('uses inline SVG icons for its own controls and swaps mic for stop', () => {
    const { pill } = makePill();
    pill.show(FIELD);
    const icon = () => q(pill, '.rec svg').getAttribute('data-icon');
    expect(q(pill, '.rec svg').namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(icon()).toBe('mic');
    pill.setState('recording');
    expect(icon()).toBe('stop');
    expect(q(pill, '.more svg').getAttribute('data-icon')).toBe('dots');
  });

  it('clamps the level into --vt-level', () => {
    const { pill } = makePill();
    pill.show(FIELD);
    const level = () => q(pill, '.pill').style.getPropertyValue('--vt-level');
    pill.setLevel(0.5);
    expect(level()).toBe('0.5');
    pill.setLevel(7);
    expect(level()).toBe('1');
    pill.setLevel(-1);
    expect(level()).toBe('0');
    pill.setLevel(Number.NaN);
    expect(level()).toBe('0');
  });
});

describe('status', () => {
  it('is a polite live region', () => {
    const { pill } = makePill();
    pill.mount();
    expect(statusEl(pill).getAttribute('aria-live')).toBe('polite');
  });

  it.each([
    ['error', 6000],
    ['warning', 6000],
    ['info', 2500],
    ['success', 2500],
  ])('clears a %s status after %i ms', (tone, ms) => {
    vi.useFakeTimers();
    const { pill } = makePill();
    pill.show(FIELD);
    pill.setStatus('Hello', { tone });
    expect(STATUS_MS[tone]).toBe(ms);
    expect(statusEl(pill).textContent).toBe('Hello');
    expect(statusEl(pill).dataset.tone).toBe(tone);
    vi.advanceTimersByTime(ms - 1);
    expect(statusEl(pill).textContent).toBe('Hello');
    vi.advanceTimersByTime(1);
    expect(statusEl(pill).textContent).toBe('');
    expect(statusEl(pill).hasAttribute('data-empty')).toBe(true);
  });

  it('keeps a sticky status until it is replaced or cleared', () => {
    vi.useFakeTimers();
    const { pill } = makePill();
    pill.show(FIELD);
    pill.setStatus('Stay', { tone: 'error', sticky: true });
    vi.advanceTimersByTime(60000);
    expect(statusEl(pill).textContent).toBe('Stay');
    pill.clearStatus();
    expect(statusEl(pill).textContent).toBe('');
  });

  it('locks a terminal status against later updates', () => {
    vi.useFakeTimers();
    const { pill } = makePill();
    pill.show(FIELD);
    pill.setStatus('VoiceType was updated. Reload this page.', { tone: 'error', terminal: true });
    pill.setStatus('Done $0.01', { tone: 'success' });
    pill.clearStatus();
    vi.advanceTimersByTime(60000);
    expect(statusEl(pill).textContent).toBe('VoiceType was updated. Reload this page.');
    expect(statusEl(pill).dataset.tone).toBe('error');
  });

  it('calls onStatusClick only while the status is clickable', () => {
    const { pill, h } = makePill();
    pill.show(FIELD);
    pill.setStatus('Plain', { tone: 'info' });
    statusEl(pill).click();
    expect(h.onStatusClick).not.toHaveBeenCalled();
    pill.setStatus('Could not insert. Click here to copy the text.', { tone: 'error', sticky: true, clickable: true });
    statusEl(pill).click();
    expect(h.onStatusClick).toHaveBeenCalledTimes(1);
    pill.setStatus('Copied to clipboard.', { tone: 'success' });
    statusEl(pill).click();
    expect(h.onStatusClick).toHaveBeenCalledTimes(1);
  });

  it('renders markup in a status as literal text', () => {
    const { pill } = makePill();
    pill.show(FIELD);
    pill.setStatus(HOSTILE, { tone: 'error' });
    expect(statusEl(pill).textContent).toBe(HOSTILE);
    expect(pill.root.querySelector('img')).toBeNull();
  });

  it('aligns the status with the side the pill grows from', () => {
    const { pill } = makePill();
    pill.show(FIELD);
    pill.setStatus('Hello');
    const slot = q(pill, '.pill');
    const px = (value) => `${value}px`;
    // jsdom has no layout, so the status is 0 px wide and its left edge lands on the aligned slot edge.
    expect(slot.dataset.placement).toBe('left');
    expect(statusEl(pill).style.left).toBe(px(parseInt(slot.style.left, 10) + PILL_SIZE.width));
    pill.show({ top: 0, left: 0, width: 1024, height: 768 });
    expect(slot.dataset.placement).toBe('inside');
    expect(statusEl(pill).style.left).toBe(px(parseInt(slot.style.left, 10) + PILL_SIZE.width));
    pill.show({ top: 100, left: 10, width: 300, height: 30 });
    expect(slot.dataset.placement).toBe('right');
    expect(statusEl(pill).style.left).toBe(slot.style.left);
  });

  it('sits on the side opposite an open menu', () => {
    const { pill } = makePill();
    pill.renderMenu(settings(), null);
    pill.show(FIELD);
    pill.setStatus('Hello');
    expect(statusEl(pill).dataset.side).toBe('below');
    pill.openMenu();
    expect(q(pill, '.menu').dataset.placement).toBe('below');
    expect(statusEl(pill).dataset.side).toBe('above');
    pill.closeMenu();
    expect(statusEl(pill).dataset.side).toBe('below');

    q(pill, '.menu').getBoundingClientRect = () => ({ top: 0, left: 0, right: 248, bottom: 300, width: 248, height: 300 });
    pill.show(BOTTOM_FIELD);
    pill.openMenu();
    expect(q(pill, '.menu').dataset.placement).toBe('above');
    expect(statusEl(pill).dataset.side).toBe('below');
  });
});

describe('menu', () => {
  it('renders a mode named like markup as literal text and creates no element (M3)', () => {
    const { pill } = makePill();
    const s = settings({
      activeMode: 'evil',
      modes: { ...settings().modes, evil: { name: HOSTILE, icon: '<b>x</b>', prompt: 'p', builtIn: false } },
    });
    pill.renderMenu(s, null);
    pill.show(FIELD);
    const names = [...pill.root.querySelectorAll('.item-name')].map((el) => el.textContent);
    expect(names).toContain(HOSTILE);
    expect(q(pill, '.mode-icon').textContent).toBe('<b>x</b>');
    expect(pill.root.querySelector('img')).toBeNull();
    expect(pill.root.querySelector('b')).toBeNull();
  });

  it('marks the active mode with aria-checked and reports clicks', () => {
    const { pill, h } = makePill();
    pill.renderMenu(settings({ activeMode: 'translate' }), null);
    pill.show(FIELD);
    const items = [...pill.root.querySelectorAll('[data-mode]')];
    expect(items.map((el) => el.dataset.mode)).toEqual(['default', 'translate']);
    expect(items.map((el) => el.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(q(pill, '.mode-icon').textContent).toBe('🌐');
    items[0].click();
    expect(h.onMode).toHaveBeenCalledWith('default');
  });

  it('shows the translate row only when the active mode has a language option', () => {
    const { pill, h } = makePill();
    pill.renderMenu(settings({ activeMode: 'default' }), null);
    pill.show(FIELD);
    expect(pill.root.querySelectorAll('[data-lang]')).toHaveLength(0);

    pill.renderMenu(settings({ activeMode: 'translate', translateTargetLang: 'Greek' }), null);
    const chips = [...pill.root.querySelectorAll('[data-lang]')];
    expect(chips.map((el) => el.dataset.lang)).toEqual(['English', 'Greek', 'Spanish', 'French', 'German']);
    expect(chips.map((el) => el.dataset.lang)).toEqual(TARGET_LANGUAGES.map((l) => l.name));
    expect(chips.find((el) => el.getAttribute('aria-checked') === 'true').dataset.lang).toBe('Greek');
    chips[3].click();
    expect(h.onTargetLang).toHaveBeenCalledWith('French');
  });

  it('shows "no key" on a provider without a key and reports clicks', () => {
    const { pill, h } = makePill();
    pill.renderMenu(settings({ provider: 'openai', hasKey: { openai: true, gemini: false } }), null);
    pill.show(FIELD);
    const openai = q(pill, '[data-provider="openai"]');
    const gemini = q(pill, '[data-provider="gemini"]');
    expect(openai.getAttribute('aria-checked')).toBe('true');
    expect(openai.textContent).toBe('OpenAI');
    expect(gemini.getAttribute('aria-checked')).toBe('false');
    expect(gemini.textContent).toBe('Geminino key');
    expect(q(pill, '[data-provider="gemini"] .chip-hint').textContent).toBe('no key');
    gemini.click();
    expect(h.onProvider).toHaveBeenCalledWith('gemini');
  });

  it('formats the usage line with formatCost and omits it without usage', () => {
    const { pill } = makePill();
    pill.renderMenu(settings(), { todayCost: 0.012, todaySessions: 3, totalCost: 0.21 });
    pill.show(FIELD);
    expect(q(pill, '.usage').textContent).toBe('Today $0.01 (3), all time $0.21');
    pill.renderMenu(settings(), { todayCost: 0.004, todaySessions: 1, totalCost: 0 });
    expect(q(pill, '.usage').textContent).toBe('Today <$0.01 (1), all time $0.00');
    pill.renderMenu(settings(), null);
    expect(q(pill, '.usage')).toBeNull();
  });

  it('shows the hotkey hint', () => {
    const { pill } = makePill();
    pill.renderMenu(settings(), null);
    pill.show(FIELD);
    expect(q(pill, '.hint kbd').textContent).toBe('Ctrl+Shift+Space');
    expect(q(pill, '.hint span').textContent).toBe('tap to toggle, hold to talk');
  });

  it('makes every control a type=button button', () => {
    const { pill } = makePill();
    pill.renderMenu(settings({ activeMode: 'translate' }), { todayCost: 0, todaySessions: 0, totalCost: 0 });
    pill.show(FIELD);
    const buttons = [...pill.root.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(10);
    for (const button of buttons) expect(button.getAttribute('type')).toBe('button');
  });

  it('opens from the menu button, calls onMenuOpen, and closes on Escape', () => {
    const { pill, h } = makePill();
    pill.renderMenu(settings(), null);
    pill.show(FIELD);
    q(pill, '.more').click();
    expect(pill.menuOpen).toBe(true);
    expect(h.onMenuOpen).toHaveBeenCalledTimes(1);
    expect(q(pill, '.more').getAttribute('aria-expanded')).toBe('true');
    expect(q(pill, '.menu').hidden).toBe(false);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(escape);
    expect(pill.menuOpen).toBe(false);
    expect(escape.defaultPrevented).toBe(true);
    expect(q(pill, '.menu').hidden).toBe(true);
    const later = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
  });

  it('closes on a mousedown outside the pill but not inside it', () => {
    const { pill } = makePill();
    pill.renderMenu(settings(), null);
    pill.show(FIELD);
    pill.openMenu();
    q(pill, '[data-mode="default"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
    expect(pill.menuOpen).toBe(true);
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(pill.menuOpen).toBe(false);
  });

  it('does not open while hidden, and hide() closes it', () => {
    const { pill, h } = makePill();
    pill.renderMenu(settings(), null);
    pill.mount();
    pill.openMenu();
    expect(pill.menuOpen).toBe(false);
    pill.show(FIELD);
    pill.openMenu();
    pill.hide();
    expect(pill.menuOpen).toBe(false);
    expect(h.onMenuOpen).toHaveBeenCalledTimes(1);
  });
});

describe('page isolation', () => {
  it('prevents the default of every mousedown inside the root', () => {
    const { pill } = makePill();
    pill.renderMenu(settings(), null);
    pill.show(FIELD);
    pill.openMenu();
    for (const selector of ['.rec', '.more', '[data-mode="default"]', '[role="status"]']) {
      const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true });
      q(pill, selector).dispatchEvent(down);
      expect(down.defaultPrevented, selector).toBe(true);
    }
    const outside = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(outside);
    expect(outside.defaultPrevented).toBe(false);
  });

  it('calls onRec from the REC button', () => {
    const { pill, h } = makePill();
    pill.show(FIELD);
    q(pill, '.rec').click();
    expect(h.onRec).toHaveBeenCalledTimes(1);
  });

  it('never uses an HTML string sink', () => {
    const source = read('../../../src/content/pill.js');
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});

describe('destroy', () => {
  it('clears every timer, removes the host and turns later calls into no-ops', () => {
    vi.useFakeTimers();
    const { pill, h } = makePill();
    pill.renderMenu(settings(), null);
    pill.show(FIELD);
    pill.setState('recording');
    pill.setStatus('Hello', { tone: 'info' });
    pill.openMenu();
    expect(vi.getTimerCount()).toBe(2);
    const host = pill.host;
    pill.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(host.isConnected).toBe(false);
    expect(pill.visible).toBe(false);
    expect(pill.menuOpen).toBe(false);
    pill.show(FIELD);
    pill.setStatus('Again', { tone: 'error' });
    pill.setState('recording');
    expect(vi.getTimerCount()).toBe(0);
    expect(document.documentElement.querySelector('voicetype-host')).toBeNull();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
    expect(h.onMenuOpen).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/content/pill.test.js
```

Expected: the file fails with `Error: Failed to resolve import "../../../src/content/pill.js" from "test/unit/content/pill.test.js". Does the file exist?`; no tests run.

- [ ] **Step 3: Create `src/content/pill.css`**

The v2.0 look (a dot that expands on hover into mode icon, REC with timer and menu button; a red glow while recording) with light and dark tokens, 24 px minimum targets, visible focus rings, reduced motion and a capped glow. The `:host` block is `!important` so page rules such as `* { font-size: 30px !important }` or `voicetype-host { display: none !important }` lose to it.

```css
/* VoiceType pill. Rendered in a closed shadow root on <voicetype-host>.
   The :host rules are !important on purpose: across a shadow boundary, important
   declarations from the inner tree beat the page's own important declarations. */

:host {
  all: initial !important;
  display: block !important;
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  width: 0 !important;
  height: 0 !important;
  overflow: visible !important;
  z-index: 2147483647 !important;
  pointer-events: none !important;
}

[hidden] {
  display: none !important;
}

/* Tokens live on .vt, not :host, so page rules that target the host cannot change them. */
.vt {
  --vt-font: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --vt-emoji: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', system-ui, sans-serif;
  --vt-surface: #ffffff;
  --vt-hover: #f0f0f3;
  --vt-selected: #eef0ff;
  --vt-text: #18181b;
  --vt-muted: #52525b;
  --vt-border: #d4d4d8;
  --vt-accent: #4f46e5;
  --vt-accent-hover: #4338ca;
  --vt-accent-text: #4338ca;
  --vt-on-accent: #ffffff;
  --vt-rec: #dc2626;
  --vt-rec-hover: #b91c1c;
  --vt-glow: 239 68 68;
  --vt-success: #047857;
  --vt-warning: #b45309;
  --vt-error: #b91c1c;
  --vt-focus: #4f46e5;
  --vt-shadow: 0 1px 2px rgb(0 0 0 / 0.08), 0 4px 16px rgb(0 0 0 / 0.14);
  --vt-dot-shadow: 0 0 0 1px rgb(0 0 0 / 0.06), 0 1px 4px rgb(0 0 0 / 0.22);
  --vt-ease: cubic-bezier(0.2, 0, 0, 1);
  /* Collapse waits a little after the pointer leaves; expanding overrides this with a shorter delay. */
  --vt-delay: 0.3s;

  color-scheme: light;
  font: 500 12px/1.35 var(--vt-font);
  color: var(--vt-text);
  font-style: normal;
  letter-spacing: normal;
  text-align: left;
  text-transform: none;
  white-space: normal;
  -webkit-font-smoothing: antialiased;
}

@media (prefers-color-scheme: dark) {
  .vt {
    --vt-surface: #1f1f1f;
    --vt-hover: #2d2d2d;
    --vt-selected: #2b2d4a;
    --vt-text: #f4f4f5;
    --vt-muted: #b4b4bb;
    --vt-border: #3f3f46;
    --vt-accent-text: #a5b4fc;
    --vt-success: #34d399;
    --vt-warning: #fbbf24;
    --vt-error: #f87171;
    --vt-focus: #a5b4fc;
    --vt-shadow: 0 1px 2px rgb(0 0 0 / 0.4), 0 6px 20px rgb(0 0 0 / 0.45);
    --vt-dot-shadow: 0 0 0 1px rgb(255 255 255 / 0.12), 0 1px 4px rgb(0 0 0 / 0.5);

    color-scheme: dark;
  }
}

.vt *,
.vt *::before,
.vt *::after {
  box-sizing: border-box;
}

svg {
  flex: none;
  width: 14px;
  height: 14px;
  fill: currentColor;
}

button {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 24px;
  min-height: 24px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: none;
  color: inherit;
  font: inherit;
  letter-spacing: inherit;
  text-transform: none;
  cursor: pointer;
  transition: background-color 0.12s ease, color 0.12s ease;
}

button:focus {
  outline: none;
}

button:focus-visible {
  outline: 2px solid var(--vt-focus);
  outline-offset: 1px;
}

/* The menu scrolls, so its rings go inside the control. */
.menu button:focus-visible {
  outline-offset: -2px;
}

/* The slot the expanded pill occupies (PILL_SIZE in pill.js). The visible body grows inside it:
   away from the field or the viewport edge for the left, inside and corner placements. */
.pill {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  width: 140px;
  height: 30px;
}

.pill[data-placement='left'],
.pill[data-placement='inside'],
.pill[data-placement='corner'] {
  justify-content: flex-end;
}

.body {
  display: flex;
  align-items: center;
  height: 24px;
  padding: 0;
  border-radius: 999px;
  background: transparent;
  pointer-events: auto;
  transition-property: height, padding, background-color, box-shadow;
  transition-duration: 0.18s;
  transition-timing-function: var(--vt-ease);
  transition-delay: var(--vt-delay);
}

.body:is(:hover, :focus-within),
.pill:is([data-state='recording'], [data-state='processing'], [data-menu='open']) .body {
  --vt-delay: 0.1s;

  height: 30px;
  padding: 0 3px;
  background: var(--vt-surface);
  box-shadow: var(--vt-shadow);
}

/* Collapsed: a 16 px dot inside a 24 px target. No overflow clipping: it would cut the dot's shadow into a square. */
.dot {
  display: grid;
  place-items: center;
  flex: none;
  width: 24px;
  height: 24px;
  transition: width 0.18s var(--vt-ease) var(--vt-delay), opacity 0.12s ease var(--vt-delay);
}

.dot::before,
.dot::after {
  content: '';
  grid-area: 1 / 1;
  border-radius: 50%;
}

.dot::before {
  width: 16px;
  height: 16px;
  background: var(--vt-surface);
  box-shadow: var(--vt-dot-shadow);
}

.dot::after {
  width: 8px;
  height: 8px;
  background: linear-gradient(135deg, #6366f1, #4f46e5);
}

.pill[data-state='done'] .dot::after {
  background: var(--vt-success);
}

.pill[data-state='error'] .dot::after {
  background: var(--vt-error);
}

.bar {
  display: flex;
  align-items: center;
  max-width: 0;
  /* Clip for the width transition, but leave room for focus rings. */
  overflow: clip;
  overflow-clip-margin: 4px;
  opacity: 0;
  transition: max-width 0.18s var(--vt-ease) var(--vt-delay), opacity 0.12s ease var(--vt-delay);
}

.body:is(:hover, :focus-within) .dot,
.pill:is([data-state='recording'], [data-state='processing'], [data-menu='open']) .dot {
  width: 0;
  opacity: 0;
}

.body:is(:hover, :focus-within) .bar,
.pill:is([data-state='recording'], [data-state='processing'], [data-menu='open']) .bar {
  max-width: 134px;
  opacity: 1;
}

.sep {
  flex: none;
  width: 1px;
  height: 14px;
  margin: 0 2px;
  background: var(--vt-border);
}

.mode {
  flex: none;
  width: 28px;
  height: 24px;
  overflow: hidden;
  border-radius: 12px;
  font: 14px/1 var(--vt-emoji);
  white-space: nowrap;
}

.mode-icon {
  max-width: 24px;
  overflow: hidden;
}

.mode:hover,
.more:hover {
  background: var(--vt-hover);
}

.rec {
  flex: none;
  width: 72px;
  height: 24px;
  padding: 0 10px;
  border-radius: 12px;
  background: var(--vt-accent);
  color: var(--vt-on-accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
}

.rec:hover {
  background: var(--vt-accent-hover);
}

.rec-label {
  font-variant-numeric: tabular-nums;
}

.pill[data-state='recording'] .rec {
  background: var(--vt-rec);
  font-size: 12px;
  letter-spacing: 0.02em;
}

.pill[data-state='recording'] .rec:hover {
  background: var(--vt-rec-hover);
}

.pill[data-state='processing'] .rec svg {
  animation: vt-pulse 1s ease-in-out infinite;
}

.more {
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: 12px;
  color: var(--vt-muted);
}

.more:hover,
.more[aria-expanded='true'] {
  color: var(--vt-text);
}

/* Level glow while recording. setLevel() clamps to [0, 1]; the clamp here caps it regardless. */
.pill[data-state='recording'] .body {
  --vt-l: clamp(0, var(--vt-level, 0), 1);

  box-shadow:
    var(--vt-shadow),
    0 0 calc(6px + var(--vt-l) * 14px) calc(1px + var(--vt-l) * 3px) rgb(var(--vt-glow) / calc(0.45 + var(--vt-l) * 0.4));
  transition: box-shadow 0.1s linear;
}

.status {
  position: absolute;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  width: max-content;
  max-width: min(320px, calc(100vw - 8px));
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--vt-surface);
  color: var(--vt-text);
  box-shadow: var(--vt-shadow);
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
  pointer-events: auto;
  animation: vt-fade 0.15s ease-out;
}

.status[data-side='above'] {
  transform: translateY(-100%);
}

.status[data-empty] {
  padding: 0;
  opacity: 0;
  pointer-events: none;
  animation: none;
}

.status-icon {
  margin-top: 1px;
}

.status[data-tone='info'] .status-icon {
  display: none;
}

.status[data-tone='success'] .status-icon {
  color: var(--vt-success);
}

.status[data-tone='warning'] .status-icon {
  color: var(--vt-warning);
}

.status[data-tone='error'] .status-icon {
  color: var(--vt-error);
}

.status[data-clickable] {
  cursor: pointer;
}

.status[data-clickable] .status-text {
  text-decoration: underline;
  text-underline-offset: 2px;
}

.status[data-clickable]:hover {
  background: var(--vt-hover);
}

.menu {
  position: absolute;
  width: 248px;
  max-height: calc(100vh - 8px);
  padding: 6px;
  overflow-y: auto;
  overscroll-behavior: contain;
  border-radius: 10px;
  background: var(--vt-surface);
  color: var(--vt-text);
  box-shadow: var(--vt-shadow), 0 0 0 1px var(--vt-border);
  pointer-events: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--vt-border) transparent;
  animation: vt-fade 0.12s ease-out;
}

.section + .section {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--vt-border);
}

.label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 2px 6px 4px;
  color: var(--vt-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.label svg {
  width: 12px;
  height: 12px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 196px;
  overflow-y: auto;
}

.item {
  justify-content: flex-start;
  gap: 8px;
  width: 100%;
  min-height: 30px;
  padding: 4px 8px;
  font-size: 13px;
  text-align: left;
}

.item:hover {
  background: var(--vt-hover);
}

.item[aria-checked='true'] {
  background: var(--vt-selected);
}

.item-icon {
  flex: none;
  width: 20px;
  overflow: hidden;
  font: 15px/1 var(--vt-emoji);
  text-align: center;
  white-space: nowrap;
}

.item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-check {
  color: var(--vt-accent-text);
  visibility: hidden;
}

.item[aria-checked='true'] .item-check {
  visibility: visible;
}

.seg {
  display: flex;
  gap: 4px;
  padding: 0 2px;
}

.chip {
  flex: 1 1 0;
  flex-direction: column;
  gap: 0;
  min-width: 0;
  min-height: 30px;
  padding: 3px 4px;
  border: 1px solid var(--vt-border);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.2;
}

.chip:hover {
  background: var(--vt-hover);
}

.chip[aria-checked='true'] {
  border-color: var(--vt-accent);
  background: var(--vt-accent);
  color: var(--vt-on-accent);
}

.chip[aria-checked='true']:focus-visible {
  outline-color: var(--vt-on-accent);
}

.chip-hint {
  color: var(--vt-muted);
  font-size: 11px;
  font-weight: 500;
}

.chip[aria-checked='true'] .chip-hint {
  color: inherit;
}

.footer p {
  margin: 0;
  padding: 2px 6px;
  color: var(--vt-muted);
}

.usage {
  font-variant-numeric: tabular-nums;
}

.hint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

kbd {
  padding: 3px 6px;
  border: 1px solid var(--vt-border);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--vt-hover);
  color: var(--vt-text);
  font: 600 11px/1 var(--vt-font);
}

@keyframes vt-fade {
  from {
    opacity: 0;
  }
}

@keyframes vt-pulse {
  50% {
    opacity: 0.35;
  }
}

@media (prefers-reduced-motion: reduce) {
  .vt *,
  .vt *::before,
  .vt *::after {
    transition: none !important;
    animation: none !important;
  }

  .pill[data-state='recording'] .body {
    box-shadow: var(--vt-shadow), 0 0 0 2px rgb(var(--vt-glow) / 0.8);
  }
}
```

- [ ] **Step 4: Create `src/content/pill.js`**

```js
// The in-page UI: a closed Shadow DOM pill with its status line and menu.
// User data (mode names and icons, statuses) is only ever set with textContent.
import css from './pill.css';
import { computePillPosition, computeMenuPlacement, EDGE } from './position.js';
import { formatChord } from '../shared/chord.js';
import { formatCost } from '../shared/pricing.js';
import { PROVIDERS } from '../shared/models.js';

/**
 * @typedef {import('./position.js').Box} Box
 * @typedef {import('../shared/defaults.js').PublicSettings} PublicSettings
 * @typedef {'idle'|'recording'|'processing'|'done'|'error'} PillState
 * @typedef {{ onRec: () => void, onStatusClick: () => void, onMenuOpen: () => void,
 *   onMode: (key: string) => void, onProvider: (id: string) => void, onTargetLang: (lang: string) => void }} PillHandlers
 * @typedef {{ todayCost: number, todaySessions: number, totalCost: number }} PillUsage
 */

/** Size of the expanded pill; `.pill` in pill.css has the same width and height. */
export const PILL_SIZE = Object.freeze({ width: 140, height: 30 });

/** How long a non-sticky status stays, by tone. */
export const STATUS_MS = Object.freeze({ error: 6000, warning: 6000, info: 2500, success: 2500 });

/** Translate targets offered in the menu. */
export const TARGET_LANGUAGES = Object.freeze([
  Object.freeze({ code: 'EN', name: 'English' }),
  Object.freeze({ code: 'EL', name: 'Greek' }),
  Object.freeze({ code: 'ES', name: 'Spanish' }),
  Object.freeze({ code: 'FR', name: 'French' }),
  Object.freeze({ code: 'DE', name: 'German' }),
]);

const HOST_CSS = 'all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647; '
  + 'display: block; width: 0; height: 0; overflow: visible; pointer-events: none;';
const STATES = new Set(['idle', 'recording', 'processing', 'done', 'error']);
/** Placements whose slot is right-aligned (pill.css): the pill grows and the status extends leftwards. */
const GROWS_LEFT = new Set(['left', 'inside', 'corner']);
const MENU_GAP = 6;
const MENU_WIDTH = 248;
const STATUS_GAP = 6;
/** Room a one-line status needs below the pill before it flips above. */
const STATUS_ROOM = 40;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Material Symbols paths on a 24 x 24 grid (Apache License 2.0). */
const ICONS = Object.freeze({
  mic: 'M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z',
  stop: 'M7 7h10v10H7z',
  dots: 'M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  alert: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
  globe: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm6.93 6h-2.95c-.32-1.25-.78-2.45-1.38-3.56 1.84.63 3.37 1.91 4.33 3.56zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2s.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56-1.84-.63-3.37-1.9-4.33-3.56zm2.95-8H5.08c.96-1.66 2.49-2.93 4.33-3.56C8.81 5.55 8.35 6.75 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2s.07-1.35.16-2h4.68c.09.65.16 1.32.16 2s-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95c-.96 1.65-2.49 2.93-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2s-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z',
});

/** @param {number} value */
const finite = (value) => (Number.isFinite(value) ? value : 0);

/** @param {number} ms */
function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** @param {Window|null} win */
function isMac(win) {
  const nav = win?.navigator;
  return /mac/i.test(nav?.userAgentData?.platform || nav?.platform || '');
}

export class Pill {
  #handlers;
  #doc;
  #shadowMode;
  #els;
  #host = null;
  #root = null;
  #destroyed = false;
  #shown = false;
  #offscreen = false;
  /** @type {(Box & { placement: string })|null} */
  #box = null;
  #gap = 8;
  #state = 'idle';
  #startedAt = 0;
  #timerId = null;
  #statusTimer = null;
  #statusClickable = false;
  #terminal = false;
  #menuOpen = false;
  #menuPlacement = 'below';

  /**
   * @param {PillHandlers} handlers
   * @param {{ doc?: Document, shadowMode?: 'open'|'closed' }} [options] `open` is for tests only.
   */
  constructor(handlers, { doc = document, shadowMode = 'closed' } = {}) {
    this.#handlers = handlers;
    this.#doc = doc;
    this.#shadowMode = shadowMode;
    this.#els = this.#build();
  }

  /** @returns {ShadowRoot|null} test hook; the page cannot reach a closed root from its own world. */
  get root() {
    return this.#root;
  }

  /** @returns {HTMLElement|null} */
  get host() {
    return this.#host;
  }

  /** @returns {boolean} */
  get visible() {
    return this.#shown && !this.#offscreen && !this.#destroyed;
  }

  /** @returns {boolean} */
  get menuOpen() {
    return this.#menuOpen;
  }

  /** Create the host and its shadow root. Idempotent; show() calls it. */
  mount() {
    if (this.#host || this.#destroyed) return;
    const doc = this.#doc;
    const host = doc.createElement('voicetype-host');
    host.style.cssText = HOST_CSS;
    const root = host.attachShadow({ mode: this.#shadowMode });
    const Sheet = doc.defaultView?.CSSStyleSheet;
    if (typeof Sheet?.prototype?.replaceSync === 'function') {
      const sheet = new Sheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
    } else {
      const style = doc.createElement('style');
      style.textContent = css;
      root.append(style);
    }
    root.append(this.#els.wrap);
    // Keep focus (and the caret) in the page field whatever is clicked in the pill.
    root.addEventListener('mousedown', (event) => event.preventDefault());
    doc.documentElement.append(host);
    this.#host = host;
    this.#root = root;
  }

  /**
   * @param {Box|null} anchor viewport box of the field, or null for the bottom-right corner
   * @param {{ gap?: number }} [options]
   */
  show(anchor, { gap = 8 } = {}) {
    if (this.#destroyed) return;
    this.mount();
    this.#gap = Number.isFinite(gap) && gap >= 0 ? gap : 8;
    this.#shown = true;
    this.#place(anchor);
  }

  /** @param {Box|null} anchor */
  reposition(anchor) {
    if (this.#destroyed || !this.#shown) return;
    this.#place(anchor);
  }

  hide() {
    if (this.#destroyed) return;
    this.closeMenu();
    this.#shown = false;
    this.#els.wrap.hidden = true;
  }

  /** @param {PillState} state */
  setState(state) {
    if (this.#destroyed || !STATES.has(state)) return;
    const previous = this.#state;
    this.#state = state;
    const { pill, rec, recIcon, recLabel } = this.#els;
    pill.dataset.state = state;
    rec.setAttribute('aria-label', state === 'recording' ? 'Stop recording' : 'Start recording');
    if (state === 'recording') {
      setIcon(recIcon, 'stop');
      if (previous !== 'recording') {
        this.#startedAt = Date.now();
        recLabel.textContent = formatElapsed(0);
        clearInterval(this.#timerId);
        this.#timerId = setInterval(() => {
          recLabel.textContent = formatElapsed(Date.now() - this.#startedAt);
        }, 250);
      }
      return;
    }
    clearInterval(this.#timerId);
    this.#timerId = null;
    this.setLevel(0);
    setIcon(recIcon, state === 'processing' ? 'dots' : 'mic');
    recLabel.textContent = state === 'processing' ? '' : 'REC';
  }

  /** @param {number} level 0 to 1; anything else is clamped */
  setLevel(level) {
    if (this.#destroyed) return;
    const value = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
    this.#els.pill.style.setProperty('--vt-level', String(Math.round(value * 1000) / 1000));
  }

  /**
   * @param {string} text
   * @param {{ tone?: 'info'|'success'|'warning'|'error', sticky?: boolean, clickable?: boolean, terminal?: boolean }} [options]
   */
  setStatus(text, { tone = 'info', sticky = false, clickable = false, terminal = false } = {}) {
    if (this.#destroyed || this.#terminal) return;
    const safeTone = Object.hasOwn(STATUS_MS, tone) ? tone : 'info';
    const { status, statusText, statusIcon } = this.#els;
    clearTimeout(this.#statusTimer);
    this.#statusTimer = null;
    statusText.textContent = String(text ?? '');
    status.dataset.tone = safeTone;
    setIcon(statusIcon, safeTone === 'success' ? 'check' : 'alert');
    status.removeAttribute('data-empty');
    this.#statusClickable = Boolean(clickable);
    status.toggleAttribute('data-clickable', this.#statusClickable);
    if (terminal) this.#terminal = true;
    else if (!sticky) this.#statusTimer = setTimeout(() => this.#resetStatus(), STATUS_MS[safeTone]);
    this.#placeStatus();
  }

  clearStatus() {
    if (this.#destroyed || this.#terminal) return;
    this.#resetStatus();
  }

  /**
   * @param {PublicSettings} settings
   * @param {PillUsage|null} usage
   */
  renderMenu(settings, usage) {
    if (this.#destroyed || !settings || typeof settings !== 'object') return;
    const modes = settings.modes && typeof settings.modes === 'object' ? settings.modes : {};
    const active = Object.hasOwn(modes, settings.activeMode) ? settings.activeMode : 'default';
    const activeMode = Object.hasOwn(modes, active) && modes[active] && typeof modes[active] === 'object' ? modes[active] : null;
    const { mode, modeIcon, menu } = this.#els;
    const modeName = typeof activeMode?.name === 'string' ? activeMode.name : active;
    modeIcon.textContent = typeof activeMode?.icon === 'string' ? activeMode.icon : '';
    mode.title = modeName;
    mode.setAttribute('aria-label', `Mode: ${modeName}. Open the VoiceType menu`);

    const sections = [this.#modesSection(modes, active)];
    if (activeMode?.hasLanguageOption) sections.push(this.#translateSection(settings.translateTargetLang));
    sections.push(this.#providerSection(settings), this.#footerSection(settings, usage));
    menu.replaceChildren(...sections);
    if (this.#menuOpen) {
      this.#placeMenu();
      this.#placeStatus();
    }
  }

  openMenu() {
    if (this.#destroyed || this.#menuOpen || !this.visible) return;
    this.#menuOpen = true;
    const { pill, menu, mode, more } = this.#els;
    pill.dataset.menu = 'open';
    menu.hidden = false;
    mode.setAttribute('aria-expanded', 'true');
    more.setAttribute('aria-expanded', 'true');
    const win = this.#doc.defaultView;
    win.addEventListener('keydown', this.#onKeyDown, true);
    win.addEventListener('mousedown', this.#onOutsideDown, true);
    this.#placeMenu();
    this.#placeStatus();
    this.#handlers.onMenuOpen();
  }

  closeMenu() {
    if (!this.#menuOpen) return;
    this.#menuOpen = false;
    const { pill, menu, mode, more } = this.#els;
    delete pill.dataset.menu;
    menu.hidden = true;
    mode.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-expanded', 'false');
    const win = this.#doc.defaultView;
    win.removeEventListener('keydown', this.#onKeyDown, true);
    win.removeEventListener('mousedown', this.#onOutsideDown, true);
    this.#placeStatus();
  }

  /** Remove the host and stop every timer and listener. The instance is inert afterwards. */
  destroy() {
    if (this.#destroyed) return;
    this.closeMenu();
    clearInterval(this.#timerId);
    clearTimeout(this.#statusTimer);
    this.#timerId = null;
    this.#statusTimer = null;
    this.#host?.remove();
    this.#shown = false;
    this.#destroyed = true;
  }

  #onKeyDown = (event) => {
    if (event.key !== 'Escape' || !this.#menuOpen) return;
    event.preventDefault();
    event.stopPropagation();
    this.closeMenu();
  };

  #onOutsideDown = (event) => {
    if (!event.composedPath().includes(this.#host)) this.closeMenu();
  };

  #toggleMenu() {
    if (this.#menuOpen) this.closeMenu();
    else this.openMenu();
  }

  #viewport() {
    const win = this.#doc.defaultView;
    const de = this.#doc.documentElement;
    // clientWidth leaves out a page scrollbar; innerWidth is the fallback where layout is unavailable.
    return {
      width: Math.min(win.innerWidth, de.clientWidth || win.innerWidth),
      height: Math.min(win.innerHeight, de.clientHeight || win.innerHeight),
    };
  }

  /** @param {Box|null} anchor */
  #place(anchor) {
    const { wrap, pill } = this.#els;
    const pos = computePillPosition({ anchor, pill: PILL_SIZE, viewport: this.#viewport(), gap: this.#gap });
    if (pos.placement === 'hidden') {
      this.#offscreen = true;
      this.closeMenu();
      wrap.hidden = true;
      return;
    }
    this.#offscreen = false;
    this.#box = { top: pos.top, left: pos.left, width: PILL_SIZE.width, height: PILL_SIZE.height, placement: pos.placement };
    pill.dataset.placement = pos.placement;
    pill.style.top = `${Math.round(pos.top)}px`;
    pill.style.left = `${Math.round(pos.left)}px`;
    wrap.hidden = false;
    if (this.#menuOpen) this.#placeMenu();
    this.#placeStatus();
  }

  #placeMenu() {
    const box = this.#box;
    if (!box) return;
    const { menu } = this.#els;
    const rect = menu.getBoundingClientRect();
    const pos = computeMenuPlacement({
      pill: box,
      menu: { width: rect.width || MENU_WIDTH, height: rect.height },
      viewport: this.#viewport(),
      gap: MENU_GAP,
    });
    this.#menuPlacement = pos.placement;
    menu.dataset.placement = pos.placement;
    menu.style.top = `${Math.round(Math.max(EDGE, pos.top))}px`;
    menu.style.left = `${Math.round(pos.left)}px`;
  }

  /** The status goes on the side opposite an open menu, else below unless there is no room. */
  #placeStatus() {
    const box = this.#box;
    if (!box) return;
    const { status } = this.#els;
    const viewport = this.#viewport();
    let side;
    if (this.#menuOpen) side = this.#menuPlacement === 'below' ? 'above' : 'below';
    else if (box.placement === 'above' || box.placement === 'corner') side = 'above';
    else side = box.top + box.height + STATUS_GAP + STATUS_ROOM <= viewport.height - EDGE ? 'below' : 'above';
    status.dataset.side = side;
    const width = status.getBoundingClientRect().width;
    const wanted = GROWS_LEFT.has(box.placement) ? box.left + box.width - width : box.left;
    const left = Math.max(EDGE, Math.min(wanted, viewport.width - width - EDGE));
    status.style.left = `${Math.round(left)}px`;
    // "above" is lifted by its own height in CSS (translateY(-100%)).
    status.style.top = `${Math.round(side === 'below' ? box.top + box.height + STATUS_GAP : box.top - STATUS_GAP)}px`;
  }

  #resetStatus() {
    clearTimeout(this.#statusTimer);
    this.#statusTimer = null;
    const { status, statusText } = this.#els;
    statusText.textContent = '';
    status.setAttribute('data-empty', '');
    status.removeAttribute('data-clickable');
    this.#statusClickable = false;
  }

  #build() {
    const el = (tag, className, attrs = {}) => this.#el(tag, className, attrs);
    const wrap = el('div', 'vt');
    wrap.hidden = true;

    const pill = el('div', 'pill');
    pill.dataset.state = 'idle';
    const body = el('div', 'body');
    const dot = el('span', 'dot', { 'aria-hidden': 'true' });
    const bar = el('div', 'bar');
    const mode = el('button', 'mode', { type: 'button', 'aria-label': 'Open the VoiceType menu', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'vt-menu' });
    const modeIcon = el('span', 'mode-icon', { 'aria-hidden': 'true' });
    mode.append(modeIcon);
    const rec = el('button', 'rec', { type: 'button', 'aria-label': 'Start recording' });
    const recIcon = this.#icon('mic');
    const recLabel = el('span', 'rec-label', { 'aria-hidden': 'true' });
    recLabel.textContent = 'REC';
    rec.append(recIcon, recLabel);
    const more = el('button', 'more', { type: 'button', 'aria-label': 'VoiceType menu', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'vt-menu' });
    more.append(this.#icon('dots'));
    bar.append(mode, el('span', 'sep', { 'aria-hidden': 'true' }), rec, el('span', 'sep', { 'aria-hidden': 'true' }), more);
    body.append(dot, bar);
    pill.append(body);

    const status = el('div', 'status', { role: 'status', 'aria-live': 'polite', 'data-empty': '' });
    status.dataset.tone = 'info';
    status.dataset.side = 'below';
    const statusIcon = this.#icon('alert', 'status-icon');
    const statusText = el('span', 'status-text');
    status.append(statusIcon, statusText);

    const menu = el('div', 'menu', { id: 'vt-menu', role: 'group', 'aria-label': 'VoiceType menu' });
    menu.hidden = true;

    wrap.append(pill, status, menu);

    rec.addEventListener('click', () => this.#handlers.onRec());
    mode.addEventListener('click', () => this.#toggleMenu());
    more.addEventListener('click', () => this.#toggleMenu());
    status.addEventListener('click', () => {
      if (this.#statusClickable) this.#handlers.onStatusClick();
    });
    menu.addEventListener('click', (event) => {
      const button = event.target?.closest?.('button');
      if (!button || !menu.contains(button)) return;
      const { mode: modeKey, provider, lang } = button.dataset;
      if (modeKey !== undefined) this.#handlers.onMode(modeKey);
      else if (provider !== undefined) this.#handlers.onProvider(provider);
      else if (lang !== undefined) this.#handlers.onTargetLang(lang);
    });

    return { wrap, pill, mode, modeIcon, rec, recIcon, recLabel, more, status, statusIcon, statusText, menu };
  }

  #modesSection(modes, active) {
    const section = this.#section('Mode');
    const list = this.#el('div', 'list', { role: 'radiogroup', 'aria-label': 'Mode' });
    for (const [key, mode] of Object.entries(modes)) {
      if (!mode || typeof mode !== 'object') continue;
      const item = this.#el('button', 'item', { type: 'button', role: 'radio', 'aria-checked': String(key === active) });
      item.dataset.mode = key;
      const icon = this.#el('span', 'item-icon', { 'aria-hidden': 'true' });
      icon.textContent = typeof mode.icon === 'string' ? mode.icon : '';
      const name = this.#el('span', 'item-name');
      name.textContent = typeof mode.name === 'string' ? mode.name : key;
      item.append(icon, name, this.#icon('check', 'item-check'));
      list.append(item);
    }
    section.append(list);
    return section;
  }

  #translateSection(current) {
    const section = this.#section('Translate to', 'globe');
    const row = this.#el('div', 'seg', { role: 'radiogroup', 'aria-label': 'Translate to' });
    for (const { code, name } of TARGET_LANGUAGES) {
      const chip = this.#el('button', 'chip', { type: 'button', role: 'radio', 'aria-checked': String(current === name), 'aria-label': name, title: name });
      chip.dataset.lang = name;
      chip.textContent = code;
      row.append(chip);
    }
    section.append(row);
    return section;
  }

  #providerSection(settings) {
    const section = this.#section('Provider');
    const row = this.#el('div', 'seg', { role: 'radiogroup', 'aria-label': 'Provider' });
    const hasKey = settings.hasKey && typeof settings.hasKey === 'object' ? settings.hasKey : {};
    for (const [id, provider] of Object.entries(PROVIDERS)) {
      const chip = this.#el('button', 'chip', { type: 'button', role: 'radio', 'aria-checked': String(settings.provider === id) });
      chip.dataset.provider = id;
      const name = this.#el('span', 'chip-name');
      name.textContent = provider.label;
      chip.append(name);
      if (hasKey[id] !== true) {
        const hint = this.#el('span', 'chip-hint');
        hint.textContent = 'no key';
        chip.append(hint);
      }
      row.append(chip);
    }
    section.append(row);
    return section;
  }

  #footerSection(settings, usage) {
    const section = this.#el('div', 'section footer');
    if (usage && typeof usage === 'object') {
      const line = this.#el('p', 'usage');
      line.textContent = `Today ${formatCost(finite(usage.todayCost))} (${finite(usage.todaySessions)}), all time ${formatCost(finite(usage.totalCost))}`;
      section.append(line);
    }
    const hotkey = settings.hotkey;
    if (hotkey && typeof hotkey === 'object' && typeof hotkey.code === 'string') {
      const hint = this.#el('p', 'hint');
      const keys = this.#el('kbd');
      keys.textContent = formatChord(hotkey, { mac: isMac(this.#doc.defaultView) });
      const text = this.#el('span');
      text.textContent = 'tap to toggle, hold to talk';
      hint.append(keys, text);
      section.append(hint);
    }
    return section;
  }

  #section(title, iconName) {
    const section = this.#el('div', 'section');
    const label = this.#el('p', 'label');
    if (iconName) label.append(this.#icon(iconName));
    label.append(title);
    section.append(label);
    return section;
  }

  #el(tag, className, attrs = {}) {
    const node = this.#doc.createElement(tag);
    if (className) node.className = className;
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    return node;
  }

  #icon(name, className) {
    const svg = this.#doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (className) svg.setAttribute('class', className);
    svg.append(this.#doc.createElementNS(SVG_NS, 'path'));
    setIcon(svg, name);
    return svg;
  }
}

/** @param {SVGSVGElement} svg @param {keyof typeof ICONS} name */
function setIcon(svg, name) {
  svg.setAttribute('data-icon', name);
  svg.firstChild.setAttribute('d', ICONS[name]);
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run test/unit/content/pill.test.js
```

Expected: 38 passed.

- [ ] **Step 6: Check that esbuild bundles the pill with its stylesheet as text, then run the full suite**

```bash
npx esbuild src/content/pill.js --bundle --format=iife --loader:.css=text --log-level=warning | grep -c 'prefers-reduced-motion'
npm test
```

Expected: `1` (the stylesheet text is inlined in the bundle; no warnings). The suite passes; report it as N/N (this task adds 38 tests; replayed on the full plan after Task 8 that is 27 files, 464/464). The extension bundle does not import the pill until Task 11, so `npm run build` is unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/content/pill.js src/content/pill.css test/unit/content/pill.test.js
git commit -m "Add the closed Shadow DOM pill with its own stylesheet"
```

---

### Task 10: Hotkey tracker

**Files:**
- Create: `src/content/hotkey.js`
- Test: `test/unit/content/hotkey.test.js`

**Interfaces:**
- Consumes: Task 3 `matchesChord`, `Chord`.
- Produces:
  - `HOLD_MS = 300`.
  - `createChordTracker({ getChord: () => Chord, holdMs = HOLD_MS, now = () => performance.now() })` returns:
    - `keydown(event): 'press'|'repeat'|null`: `'press'` on the first keydown matching the chord while not pressed (`event.repeat` false); `'repeat'` for any matching keydown while pressed (auto-repeat); `null` otherwise. The caller calls `preventDefault()` and `stopPropagation()` for `'press'` and `'repeat'`.
    - `keyup(event): { held: boolean }|null`: while pressed, the keyup of the chord's `code` or of any modifier the chord requires ends the press; `held` is `now() - pressedAt >= holdMs`. `null` otherwise.
    - `blur(): { held: boolean }|null`: ends a press in progress (window lost focus).
    - `readonly pressed: boolean`.
- Semantics consumed by Task 11: press when idle starts recording; release with `held: true` stops it (hold-to-talk); release with `held: false` leaves it recording (tap toggles on); a press while recording stops it.

WRITER NOTES

- Verified against a stand-in `matchesChord` written to the Task 3 Interfaces block (exact `code`, exact `ctrlKey`/`shiftKey`/`altKey`/`metaKey` set). The tracker never passes a null chord to it: `getChord()` returning null or undefined (settings not loaded yet) ignores the key.
- The chord is read on each new press and kept for that press, so repeats and releases are matched against the chord that started it.
- `keyup` of a right-hand modifier (`ControlRight`, `ShiftRight`, ...) ends the press as well.

- [ ] **Step 1: Write the failing tracker tests**

`test/unit/content/hotkey.test.js`:

```js
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createChordTracker, HOLD_MS } from '../../../src/content/hotkey.js';

const CHORD = { code: 'Space', ctrl: true, shift: true, alt: false, meta: false };
const HELD = { ctrlKey: true, shiftKey: true };

function key(code, mods = {}, repeat = false) {
  return { code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods, repeat };
}

function setup({ chord = CHORD, holdMs } = {}) {
  const clock = { t: 1000 };
  const options = { getChord: () => chord, now: () => clock.t };
  if (holdMs !== undefined) options.holdMs = holdMs;
  return { tracker: createChordTracker(options), clock };
}

/** Ctrl, then Shift, then Space, in the order a keyboard delivers them. */
function pressChord(tracker) {
  expect(tracker.keydown(key('ControlLeft', { ctrlKey: true }))).toBeNull();
  expect(tracker.keydown(key('ShiftLeft', HELD))).toBeNull();
  return tracker.keydown(key('Space', HELD));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createChordTracker', () => {
  it('holds for 300 ms by default', () => {
    expect(HOLD_MS).toBe(300);
  });

  it('the first matching keydown is a press', () => {
    const { tracker } = setup();
    expect(tracker.pressed).toBe(false);
    expect(pressChord(tracker)).toBe('press');
    expect(tracker.pressed).toBe(true);
  });

  it('repeat keydowns are not presses', () => {
    const { tracker, clock } = setup();
    expect(pressChord(tracker)).toBe('press');
    for (let i = 0; i < 3; i += 1) {
      clock.t += 30;
      expect(tracker.keydown(key('Space', HELD, true))).toBe('repeat');
    }
    expect(tracker.keydown(key('Space', HELD))).toBe('repeat');
    expect(tracker.keyup(key('Space', HELD))).toEqual({ held: false });
    // Auto-repeat that outlives the press never starts a new one.
    expect(tracker.keydown(key('Space', HELD, true))).toBeNull();
    expect(tracker.pressed).toBe(false);
  });

  it('modifier released first ends the press', () => {
    const { tracker, clock } = setup();
    expect(pressChord(tracker)).toBe('press');
    clock.t += 500;
    expect(tracker.keyup(key('ControlLeft', { shiftKey: true }))).toEqual({ held: true });
    expect(tracker.pressed).toBe(false);
    expect(tracker.keyup(key('Space', { shiftKey: true }))).toBeNull();
    expect(tracker.keyup(key('ShiftLeft'))).toBeNull();
  });

  it('a right-hand modifier released first also ends the press', () => {
    const { tracker, clock } = setup();
    expect(tracker.keydown(key('Space', HELD))).toBe('press');
    clock.t += 100;
    expect(tracker.keyup(key('ShiftRight', { ctrlKey: true }))).toEqual({ held: false });
    expect(tracker.pressed).toBe(false);
  });

  it('the main key released first ends the press; later modifier keyups are ignored', () => {
    const { tracker, clock } = setup();
    expect(pressChord(tracker)).toBe('press');
    clock.t += 1000;
    expect(tracker.keyup(key('Space', HELD))).toEqual({ held: true });
    expect(tracker.keyup(key('ShiftLeft', { ctrlKey: true }))).toBeNull();
    expect(tracker.keyup(key('ControlLeft'))).toBeNull();
  });

  it('releasing a modifier the chord does not use keeps the press', () => {
    const { tracker } = setup();
    expect(pressChord(tracker)).toBe('press');
    expect(tracker.keyup(key('AltLeft', HELD))).toBeNull();
    expect(tracker.keyup(key('MetaLeft', HELD))).toBeNull();
    expect(tracker.pressed).toBe(true);
  });

  it('blur during hold ends the hold', () => {
    const { tracker, clock } = setup();
    expect(pressChord(tracker)).toBe('press');
    clock.t += 2000;
    expect(tracker.blur()).toEqual({ held: true });
    expect(tracker.pressed).toBe(false);
    // Keys released while the window was unfocused may still arrive later.
    expect(tracker.keyup(key('Space'))).toBeNull();
    expect(tracker.blur()).toBeNull();
  });

  it('tap versus hold at the 300 ms boundary', () => {
    const { tracker, clock } = setup();
    tracker.keydown(key('Space', HELD));
    clock.t += 299;
    expect(tracker.keyup(key('Space', HELD))).toEqual({ held: false });
    tracker.keydown(key('Space', HELD));
    clock.t += 300;
    expect(tracker.keyup(key('Space', HELD))).toEqual({ held: true });
    tracker.keydown(key('Space', HELD));
    clock.t += 299;
    expect(tracker.blur()).toEqual({ held: false });
  });

  it('honours a custom holdMs', () => {
    const { tracker, clock } = setup({ holdMs: 500 });
    tracker.keydown(key('Space', HELD));
    clock.t += 400;
    expect(tracker.keyup(key('Space', HELD))).toEqual({ held: false });
  });

  it('non-matching keys are ignored', () => {
    const { tracker } = setup();
    expect(tracker.keydown(key('Space', { ctrlKey: true }))).toBeNull();
    expect(tracker.keydown(key('Space', { ...HELD, altKey: true }))).toBeNull();
    expect(tracker.keydown(key('KeyA', HELD))).toBeNull();
    expect(tracker.keydown(key('Space'))).toBeNull();
    expect(tracker.pressed).toBe(false);
    expect(pressChord(tracker)).toBe('press');
    expect(tracker.keydown(key('KeyA', HELD))).toBeNull();
    expect(tracker.pressed).toBe(true);
  });

  it('keyup without a press is ignored', () => {
    const { tracker } = setup();
    expect(tracker.keyup(key('Space', HELD))).toBeNull();
    expect(tracker.keyup(key('ControlLeft', { shiftKey: true }))).toBeNull();
    expect(tracker.blur()).toBeNull();
    expect(tracker.pressed).toBe(false);
  });

  it('reads the current chord on every new press', () => {
    let chord = CHORD;
    const tracker = createChordTracker({ getChord: () => chord, now: () => 0 });
    expect(tracker.keydown(key('Space', HELD))).toBe('press');
    tracker.keyup(key('Space', HELD));
    chord = { code: 'KeyD', ctrl: false, shift: false, alt: true, meta: false };
    expect(tracker.keydown(key('Space', HELD))).toBeNull();
    expect(tracker.keydown(key('KeyD', { altKey: true }))).toBe('press');
    expect(tracker.keyup(key('AltLeft'))).toEqual({ held: false });
  });

  it('ignores every key while no chord is configured', () => {
    const tracker = createChordTracker({ getChord: () => null, now: () => 0 });
    expect(tracker.keydown(key('Space', HELD))).toBeNull();
    expect(tracker.pressed).toBe(false);
  });

  it('times presses with performance.now by default', () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(400);
    const tracker = createChordTracker({ getChord: () => CHORD });
    expect(tracker.keydown(key('Space', HELD))).toBe('press');
    expect(tracker.keyup(key('Space', HELD))).toEqual({ held: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/unit/content/hotkey.test.js
```

Expected: the file fails with `Error: Cannot find module '../../../src/content/hotkey.js'`; no tests run.

- [ ] **Step 3: Create `src/content/hotkey.js`**

```js
// Hold-to-talk chord tracking. Pure: the entry feeds it window keydown, keyup and blur
// events and acts on the results; a release under HOLD_MS is a tap.
import { matchesChord } from '../shared/chord.js';

/** A press held at least this long is a hold (record until release); shorter is a tap. */
export const HOLD_MS = 300;

/** Key codes that release each modifier flag of a chord. */
const MODIFIER_CODES = Object.freeze({
  ctrl: ['ControlLeft', 'ControlRight'],
  shift: ['ShiftLeft', 'ShiftRight'],
  alt: ['AltLeft', 'AltRight'],
  meta: ['MetaLeft', 'MetaRight'],
});

/** True when keyup of `code` breaks the chord: its main key or a modifier it requires. */
function releases(code, chord) {
  if (code === chord.code) return true;
  return Object.entries(MODIFIER_CODES).some(([flag, codes]) => chord[flag] === true && codes.includes(code));
}

/**
 * @param {{ getChord: () => import('../shared/chord.js').Chord, holdMs?: number, now?: () => number }} options
 * @returns {{
 *   keydown(event: KeyboardEvent): 'press'|'repeat'|null,
 *   keyup(event: KeyboardEvent): { held: boolean }|null,
 *   blur(): { held: boolean }|null,
 *   readonly pressed: boolean,
 * }}
 */
export function createChordTracker({ getChord, holdMs = HOLD_MS, now = () => performance.now() }) {
  /** @type {{ chord: import('../shared/chord.js').Chord, at: number }|null} */
  let press = null;

  function end() {
    const held = now() - press.at >= holdMs;
    press = null;
    return { held };
  }

  return {
    keydown(event) {
      // While pressed, matching keydowns are auto-repeat: swallowed, never a second press.
      if (press) return matchesChord(event, press.chord) ? 'repeat' : null;
      const chord = getChord();
      if (!chord || event.repeat || !matchesChord(event, chord)) return null;
      press = { chord, at: now() };
      return 'press';
    },
    keyup(event) {
      // Whichever key of the chord goes up first ends the press.
      if (!press || !releases(event.code, press.chord)) return null;
      return end();
    },
    blur() {
      // Keyups are lost while the window is unfocused (Alt+Tab), so a blur ends the hold.
      return press ? end() : null;
    },
    get pressed() {
      return press !== null;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/unit/content/hotkey.test.js
```

Expected: 15 passed, including "repeat keydowns are not presses", "modifier released first ends the press" and "blur during hold ends the hold".

- [ ] **Step 5: Run the full suite**

```bash
npm test
```

Expected: every file passes; report the count as N/N (this task adds 15 tests).

- [ ] **Step 6: Commit**

```bash
git add src/content/hotkey.js test/unit/content/hotkey.test.js
git commit -m "Add the hold-to-talk chord tracker"
```

---

### Task 11: Content controller and entry rewrite

**Files:**
- Create: `src/content/controller.js`
- Rewrite: `src/content/index.js`
- Delete: `src/content/content.css`
- Modify: `build.mjs` (drop the `content.css` static), `manifest.json` (content script: `"all_frames": true`, `"match_about_blank": true`, no `css`), `src/shared/messages.js` (delete the three legacy keys and their comment; `grep -rn "CHECK_KEY\|TRANSCRIBE\|TOGGLE_RECORDING" src test` must return nothing)
- Test: `test/unit/content/controller.test.js` (jsdom), `test/unit/content/index.test.js` (jsdom, teardown handshake and orphan wiring), `test/unit/manifest.test.js` (extend), `test/unit/shared/messages.test.js` (legacy keys absent)

**Interfaces:**
- Consumes: Task 3 `MSG`, `PublicSettings`; Task 7 `insertText`, `copyText`; Task 8 `watchAnchor`; Task 9 `Pill`; Task 10 `createChordTracker`; `isValidInput`, `deepActiveElement` from `fields.js`.
- Produces:
  - `createController(deps)`, `deps = { pill: PillLike, send: (message) => Promise<any|null>, insertText, copyText, isValidInput, deepActiveElement, rectOf: (el: Element) => Box|null, watchAnchor, setTimeout, clearTimeout }` where `PillLike` is the Task 9 public surface. Returns:
    - `setSettings(settings: unknown): void`: ignored unless a non-null object with an object `modes`; re-renders the menu.
    - `focusIn(el: Element|null): void`: a valid field becomes the current field; when idle the pill shows at it and follows it via `watchAnchor`.
    - `focusOut(): void`: after 200 ms, hides the pill only when idle, no sticky status is showing, and focus is not on a valid field.
    - `toggle(): Promise<void>`: one path for REC clicks and hotkey taps. idle: binds `target` to the focused valid field or `null` (then the pill shows at the corner), state `'starting'`, sends `START_RECORDING`; `{ ok: true }` makes it `'recording'`; a failure returns to idle and shows `error` (tone `'info'` and sticky for `needsPermission`, else `'error'`). starting: queues a stop. recording: state `'processing'`, pill processing, sends `STOP_RECORDING`. processing: status "Still processing".
    - `press(): Promise<void>` and `release({ held }: { held: boolean }): Promise<void>`: hold-to-talk semantics from Task 10.
    - `handleMessage(message): void`: `SETTINGS_CHANGED` calls `setSettings`; `AUDIO_LEVEL` sets the pill level while recording; `RECORDING_STATE` `'processing'` moves to processing with "Max time reached" or "Stopped after silence" or "Microphone disconnected" for `maxTime`, `silence`, `ended`; `'idle'` returns to idle and shows the notice; `DICTATION_RESULT` delivers.
    - Delivery: `success` with `target` connected and `deepActiveElement() === target` runs `insertText(target, text)`: `'inserted'` shows the warning (6 s, tone warning) when present, else `Done <formatCost(cost)>` (success); `'unverified'` shows "Could not confirm the insert. The text is also on the clipboard." (warning); `'clipboard'` shows "Copied to clipboard. The field could not be edited." (warning); `'failed'` shows "Could not insert. Click here to copy the text." (sticky, clickable). Without a usable target: `copyText(text)`; true shows "Copied to clipboard." (info) or, when a target existed, "The field lost focus. Text copied to clipboard." (warning); false shows the sticky click-to-copy status. `success: false` shows `error` with its `tone`. The last `{ text, raw }` is kept for click-to-copy.
    - `orphaned(): void`: terminal status "VoiceType was updated. Reload this page." (tone error); every later call is a no-op.
    - `teardown(): void`: cancels a recording (`CANCEL_RECORDING`, fire and forget), stops anchor watching, destroys the pill.
    - `readonly state: 'idle'|'starting'|'recording'|'processing'`.
    - `setUsage(usage)`, `copyLast()` (status click), `choose(patch)` (menu choices sent as `UPDATE_SETTINGS`), the paths the pill handlers call.
  - `src/content/index.js` (entry, registers everything synchronously at load):
    - First dispatches `document.dispatchEvent(new CustomEvent('voicetype:teardown'))`, then listens for the same event (`{ once: true }`) to tear itself down.
    - `send(message)` wraps `chrome.runtime.sendMessage` (promise form); an error whose text contains `Extension context invalidated` calls `controller.orphaned()` and resolves `null`; other errors log and resolve `null`.
    - `focusin` (capture) uses `e.composedPath()[0]`; `focusout` (capture); `keydown`/`keyup` on `window` (capture) feed the tracker; `blur` on `window` feeds `tracker.blur()`; `pagehide` sends `CANCEL_RECORDING` when recording.
    - `chrome.runtime.onMessage` registered at load, forwards to `controller.handleMessage`, returns `false`.
    - Loads settings with `GET_SETTINGS` at start and refetches on menu open (usage via `GET_USAGE`).
    - Never calls `chrome.storage`.
  - `manifest.json` content script entry: `{ "matches": ["<all_urls>"], "js": ["content.js"], "run_at": "document_idle", "all_frames": true, "match_about_blank": true }`.
- Ledger: rows 53, 56, 62 (final-review items 6 and 10), 64 (M2 content side), 66, 68; carries the 6 s warning status and the M3 invariant.

WRITER NOTES

- The Interfaces block gives the controller no path for status clicks, menu choices or usage, so it gains three methods: `setUsage(stats)` (maps the `GET_USAGE` reply to the pill's usage shape), `copyLast()` (click-to-copy, wired to `onStatusClick`) and `choose(patch)` (sends `UPDATE_SETTINGS`; the menu re-renders from the service worker's `SETTINGS_CHANGED` push). `index.js` still does the fetching: `GET_SETTINGS` at load, `GET_SETTINGS` plus `GET_USAGE` on menu open.
- `teardown()` still works after `orphaned()`: Review Focus 1 needs a newer copy to remove an orphaned pill. Every other call is a no-op after either.
- Choices the contract leaves open: permission notices (`RECORDING_STATE` reason `'permission'`) stay until the next REC, because they arrive while the user is in the permission tab, and are ignored while this frame records again; "Microphone disconnected" is a warning, the other auto-stop notices are info; a `STOP_RECORDING` reply other than `{ ok: true }` returns to idle (a result that still arrives goes to the bound field); a `START_RECORDING` reply that arrives after a reset is dropped; an idle pill hides only once its status has expired (ledger 56: no hide while done or error) and moves to a newly focused field; `focusOut` also keeps the pill while focus is inside it.
- `pagehide` while starting or recording sends `CANCEL_RECORDING` and resets the controller with `handleMessage({ action: RECORDING_STATE, state: 'idle' })`, so a page restored from the back-forward cache shows no stale recording.
- `index.js` keeps the hotkey for the tracker (from `GET_SETTINGS` and `SETTINGS_CHANGED`); the default chord works before settings arrive.
- `index.test.js` forces open shadow roots by wrapping `Element.prototype.attachShadow`, and gives the fields a layout box because Task 8 treats jsdom's all-zero box as offscreen.
- The legacy-key grep in Step 12 comes back empty only because Tasks 4 and 6 already rewrote the router and the background entry.

- [ ] **Step 1: Write the failing controller tests**

`test/unit/content/controller.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createController, FOCUS_OUT_MS } from '../../../src/content/controller.js';
import { isValidInput, deepActiveElement } from '../../../src/content/fields.js';
import { MSG } from '../../../src/shared/messages.js';

const RECT = { top: 100, left: 400, width: 300, height: 30 };
const ORPHAN = 'VoiceType was updated. Reload this page.';
const CLICK_TO_COPY = 'Could not insert. Click here to copy the text.';

/** Records every call the controller makes on the pill; tracks visibility like the real one. */
function fakePill() {
  const pill = {
    host: document.createElement('voicetype-host'),
    visible: false,
    show: vi.fn(() => { pill.visible = true; }),
    reposition: vi.fn(),
    hide: vi.fn(() => { pill.visible = false; }),
    setState: vi.fn(),
    setLevel: vi.fn(),
    setStatus: vi.fn(),
    clearStatus: vi.fn(),
    renderMenu: vi.fn(),
    destroy: vi.fn(() => { pill.visible = false; }),
  };
  return pill;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function setup({ replies = {}, insert = 'inserted', copy = true } = {}) {
  const pill = fakePill();
  const sent = [];
  const table = {
    [MSG.START_RECORDING]: { ok: true },
    [MSG.STOP_RECORDING]: { ok: true },
    [MSG.CANCEL_RECORDING]: { ok: true },
    [MSG.UPDATE_SETTINGS]: { success: true },
    ...replies,
  };
  const send = vi.fn(async (message) => {
    sent.push(message);
    const reply = table[message.action];
    return typeof reply === 'function' ? reply(message) : (reply ?? null);
  });
  const unwatch = vi.fn();
  const deps = {
    pill,
    send,
    insertText: vi.fn(async () => insert),
    copyText: vi.fn(async () => copy),
    isValidInput,
    deepActiveElement: () => deepActiveElement(document),
    rectOf: (el) => (el?.isConnected ? { ...RECT } : null),
    watchAnchor: vi.fn(() => unwatch),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
  const controller = createController(deps);
  return { controller, pill, send, deps, unwatch, actions: () => sent.map((m) => m.action), sent };
}

/** Let pending promise chains (send, insertText, copyText) settle under fake timers. */
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const $ = (id) => document.getElementById(id);
const lastStatus = (pill) => pill.setStatus.mock.calls.at(-1);

function settings(overrides = {}) {
  return {
    provider: 'openai',
    hasKey: { openai: true, gemini: false },
    activeMode: 'default',
    pillGap: 12,
    modes: { default: { name: 'Default', icon: '🎤', prompt: '', builtIn: true } },
    ...overrides,
  };
}

/** Focus field a, start, and stop: the controller is processing with a bound to it. */
async function recordAndStop(t, id = 'a') {
  $(id).focus();
  t.controller.focusIn($(id));
  await t.controller.toggle();
  await t.controller.toggle();
  expect(t.controller.state).toBe('processing');
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<textarea id="a"></textarea><textarea id="b"></textarea><button id="plain">x</button>';
});

afterEach(() => {
  document.activeElement?.blur?.();
  vi.useRealTimers();
});

describe('toggle', () => {
  it('tap start and stop', async () => {
    const t = setup();
    $('a').focus();
    t.controller.focusIn($('a'));
    expect(t.pill.show).toHaveBeenLastCalledWith(RECT, { gap: 8 });
    expect(t.deps.watchAnchor).toHaveBeenCalledWith($('a'), expect.any(Function));

    await t.controller.toggle();
    expect(t.actions()).toEqual([MSG.START_RECORDING]);
    expect(t.controller.state).toBe('recording');
    expect(t.pill.setState).toHaveBeenLastCalledWith('recording');
    expect(t.pill.clearStatus).toHaveBeenCalled();

    await t.controller.toggle();
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING]);
    expect(t.controller.state).toBe('processing');
    expect(t.pill.setState).toHaveBeenLastCalledWith('processing');
  });

  it('stop queued while starting', async () => {
    const start = deferred();
    const t = setup({ replies: { [MSG.START_RECORDING]: () => start.promise } });
    $('a').focus();
    const pending = t.controller.toggle();
    expect(t.controller.state).toBe('starting');
    await t.controller.toggle();
    await t.controller.toggle();
    expect(t.actions()).toEqual([MSG.START_RECORDING]);
    start.resolve({ ok: true });
    await pending;
    await flush();
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING]);
    expect(t.controller.state).toBe('processing');
  });

  it('drops a start reply that arrives after a reset', async () => {
    const start = deferred();
    const t = setup({ replies: { [MSG.START_RECORDING]: () => start.promise } });
    $('a').focus();
    const pending = t.controller.toggle();
    t.controller.handleMessage({ action: MSG.RECORDING_STATE, state: 'idle' });
    start.resolve({ ok: true });
    await pending;
    expect(t.controller.state).toBe('idle');
    expect(t.pill.setState).not.toHaveBeenCalledWith('recording');
  });

  it('start failure tones (needsPermission sticky info)', async () => {
    const permission = 'Allow the microphone in the VoiceType tab that just opened, then press REC again.';
    let reply = { ok: false, reason: 'needsPermission', error: permission };
    const t = setup({ replies: { [MSG.START_RECORDING]: () => reply } });
    $('a').focus();
    await t.controller.toggle();
    expect(t.controller.state).toBe('idle');
    expect(t.pill.setState).toHaveBeenLastCalledWith('idle');
    expect(lastStatus(t.pill)).toEqual([permission, { tone: 'info', sticky: true, clickable: false }]);

    reply = { ok: false, reason: 'noKey', error: 'Add an API key in the VoiceType popup.' };
    await t.controller.toggle();
    expect(lastStatus(t.pill)).toEqual(['Add an API key in the VoiceType popup.', { tone: 'error', sticky: false, clickable: false }]);

    reply = { ok: false, reason: 'busy', error: 'VoiceType is busy in another tab. Try again in a moment.' };
    await t.controller.toggle();
    expect(lastStatus(t.pill)[1].tone).toBe('error');
    expect(t.controller.state).toBe('idle');
  });

  it('a start without a reply reports the background service', async () => {
    const t = setup({ replies: { [MSG.START_RECORDING]: null } });
    $('a').focus();
    await t.controller.toggle();
    expect(t.controller.state).toBe('idle');
    expect(lastStatus(t.pill)[0]).toBe('VoiceType could not reach its background service. Try again.');
  });

  it('"Still processing" during processing', async () => {
    const t = setup();
    await recordAndStop(t);
    t.send.mockClear();
    await t.controller.toggle();
    expect(t.send).not.toHaveBeenCalled();
    expect(lastStatus(t.pill)).toEqual(['Still processing', { tone: 'info', sticky: false, clickable: false }]);
    expect(t.controller.state).toBe('processing');
  });

  it('a refused stop returns to idle instead of hanging in processing', async () => {
    const t = setup({ replies: { [MSG.STOP_RECORDING]: { ok: false } } });
    $('a').focus();
    await t.controller.toggle();
    await t.controller.toggle();
    expect(t.controller.state).toBe('idle');
    expect(t.pill.setState).toHaveBeenLastCalledWith('idle');
    t.controller.handleMessage({ action: MSG.DICTATION_RESULT, success: true, text: 'late', raw: 'late', cost: 0, warning: null });
    await flush();
    expect(t.deps.insertText).toHaveBeenCalledWith($('a'), 'late');
  });

  it('no-target start shows the pill at the corner and copies the result', async () => {
    const t = setup();
    await t.controller.toggle();
    expect(t.pill.show).toHaveBeenLastCalledWith(null, { gap: 8 });
    expect(t.deps.watchAnchor).not.toHaveBeenCalled();
    await t.controller.toggle();
    t.controller.handleMessage({ action: MSG.DICTATION_RESULT, success: true, text: 'hello', raw: 'hello', cost: 0.01, warning: null });
    await flush();
    expect(t.deps.insertText).not.toHaveBeenCalled();
    expect(t.deps.copyText).toHaveBeenCalledWith('hello');
    expect(lastStatus(t.pill)).toEqual(['Copied to clipboard.', { tone: 'info', sticky: false, clickable: false }]);
    expect(t.controller.state).toBe('idle');
    vi.advanceTimersByTime(2499);
    expect(t.pill.hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(t.pill.hide).toHaveBeenCalled();
  });
});

describe('hotkey', () => {
  it('hold-to-talk press and release', async () => {
    const t = setup();
    $('a').focus();
    await t.controller.press();
    expect(t.controller.state).toBe('recording');
    await t.controller.release({ held: true });
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING]);
    expect(t.controller.state).toBe('processing');
  });

  it('a tap keeps recording and the next press stops', async () => {
    const t = setup();
    $('a').focus();
    await t.controller.press();
    await t.controller.release({ held: false });
    expect(t.controller.state).toBe('recording');
    expect(t.actions()).toEqual([MSG.START_RECORDING]);
    await t.controller.press();
    await t.controller.release({ held: false });
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING]);
    expect(t.controller.state).toBe('processing');
  });

  it('press while recording stops', async () => {
    const t = setup();
    $('a').focus();
    await t.controller.toggle();
    await t.controller.press();
    await t.controller.release({ held: true });
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING]);
  });

  it('a held release while starting queues the stop', async () => {
    const start = deferred();
    const t = setup({ replies: { [MSG.START_RECORDING]: () => start.promise } });
    $('a').focus();
    const pending = t.controller.press();
    await t.controller.release({ held: true });
    start.resolve({ ok: true });
    await pending;
    await flush();
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING]);
  });

  it('press during processing shows "Still processing"', async () => {
    const t = setup();
    await recordAndStop(t);
    await t.controller.press();
    expect(lastStatus(t.pill)[0]).toBe('Still processing');
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING]);
  });
});

describe('service worker messages', () => {
  it.each([
    ['maxTime', 'Max time reached', 'info'],
    ['silence', 'Stopped after silence', 'info'],
    ['ended', 'Microphone disconnected', 'warning'],
  ])('RECORDING_STATE auto-stop messages: %s', async (reason, text, tone) => {
    const t = setup();
    $('a').focus();
    await t.controller.toggle();
    t.controller.handleMessage({ action: MSG.RECORDING_STATE, state: 'processing', reason });
    expect(t.controller.state).toBe('processing');
    expect(t.pill.setState).toHaveBeenLastCalledWith('processing');
    expect(lastStatus(t.pill)).toEqual([text, { tone, sticky: false, clickable: false }]);
    await t.controller.toggle();
    expect(t.actions()).toEqual([MSG.START_RECORDING]);
  });

  it('RECORDING_STATE idle returns to idle and shows the notice', async () => {
    const t = setup();
    $('a').focus();
    await t.controller.toggle();
    t.controller.handleMessage({
      action: MSG.RECORDING_STATE, state: 'idle', reason: 'error',
      notice: { text: 'Recording failed. Try again.', tone: 'error' },
    });
    expect(t.controller.state).toBe('idle');
    expect(lastStatus(t.pill)).toEqual(['Recording failed. Try again.', { tone: 'error', sticky: false, clickable: false }]);
  });

  it('keeps a permission notice until the next REC and ignores it while recording', async () => {
    const t = setup();
    t.controller.handleMessage({
      action: MSG.RECORDING_STATE, state: 'idle', reason: 'permission',
      notice: { text: 'Microphone allowed. Press REC again.', tone: 'success' },
    });
    expect(lastStatus(t.pill)).toEqual(['Microphone allowed. Press REC again.', { tone: 'success', sticky: true, clickable: false }]);
    $('a').focus();
    await t.controller.toggle();
    const calls = t.pill.setStatus.mock.calls.length;
    t.controller.handleMessage({ action: MSG.RECORDING_STATE, state: 'idle', reason: 'permission', notice: { text: 'late', tone: 'success' } });
    expect(t.controller.state).toBe('recording');
    expect(t.pill.setStatus.mock.calls).toHaveLength(calls);
  });

  it('passes AUDIO_LEVEL to the pill only while recording', async () => {
    const t = setup();
    t.controller.handleMessage({ action: MSG.AUDIO_LEVEL, level: 0.4 });
    expect(t.pill.setLevel).not.toHaveBeenCalled();
    $('a').focus();
    await t.controller.toggle();
    t.controller.handleMessage({ action: MSG.AUDIO_LEVEL, level: 0.4 });
    expect(t.pill.setLevel).toHaveBeenCalledWith(0.4);
  });

  it('settings updates ignored when not objects', () => {
    const t = setup();
    for (const bad of [null, undefined, 'x', 42, [], {}, { modes: null }, { modes: 'x' }]) {
      t.controller.setSettings(bad);
      t.controller.handleMessage({ action: MSG.SETTINGS_CHANGED, settings: bad });
    }
    expect(t.pill.renderMenu).not.toHaveBeenCalled();
    const good = settings();
    t.controller.handleMessage({ action: MSG.SETTINGS_CHANGED, settings: good });
    expect(t.pill.renderMenu).toHaveBeenLastCalledWith(good, null);
    t.controller.setSettings('still not settings');
    expect(t.pill.renderMenu).toHaveBeenCalledTimes(1);
  });

  it('maps the usage summary for the menu', () => {
    const t = setup();
    t.controller.setUsage({ today: { sessions: 2, estimatedCost: 0.01 }, total: { sessions: 9, estimatedCost: 0.5 } });
    expect(t.pill.renderMenu).not.toHaveBeenCalled();
    const good = settings();
    t.controller.setSettings(good);
    t.controller.setUsage({ today: { sessions: 2, estimatedCost: 0.01 }, last7Days: {}, total: { sessions: 9, estimatedCost: 0.5 } });
    expect(t.pill.renderMenu).toHaveBeenLastCalledWith(good, { todayCost: 0.01, todaySessions: 2, totalCost: 0.5 });
    t.controller.setUsage(null);
    t.controller.setUsage({ today: 1 });
    expect(t.pill.renderMenu).toHaveBeenCalledTimes(2);
  });

  it('uses the settings pill gap', () => {
    const t = setup();
    t.controller.setSettings(settings({ pillGap: 12 }));
    $('a').focus();
    t.controller.focusIn($('a'));
    expect(t.pill.show).toHaveBeenLastCalledWith(RECT, { gap: 12 });
  });
});

describe('delivery', () => {
  const result = (extra = {}) => ({ action: MSG.DICTATION_RESULT, success: true, text: 'hello', raw: 'hello raw', cost: 0.012, warning: null, ...extra });

  it.each([
    ['inserted', 'Done $0.01', { tone: 'success', sticky: false, clickable: false }, 'done'],
    ['unverified', 'Could not confirm the insert. The text is also on the clipboard.', { tone: 'warning', sticky: false, clickable: false }, 'done'],
    ['clipboard', 'Copied to clipboard. The field could not be edited.', { tone: 'warning', sticky: false, clickable: false }, 'done'],
    ['failed', CLICK_TO_COPY, { tone: 'error', sticky: true, clickable: true }, 'error'],
  ])('DICTATION_RESULT for each insert outcome: %s', async (outcome, text, options, pillState) => {
    const t = setup({ insert: outcome });
    await recordAndStop(t);
    t.controller.handleMessage(result());
    await flush();
    expect(t.deps.insertText).toHaveBeenCalledWith($('a'), 'hello');
    expect(t.deps.copyText).not.toHaveBeenCalled();
    expect(lastStatus(t.pill)).toEqual([text, options]);
    expect(t.pill.setState).toHaveBeenLastCalledWith(pillState);
    expect(t.controller.state).toBe('idle');
  });

  it('warning shown 6 s', async () => {
    const t = setup();
    await recordAndStop(t);
    t.controller.handleMessage(result({ warning: 'Text model failed. Inserted the raw transcript.' }));
    await flush();
    expect(lastStatus(t.pill)).toEqual(['Text model failed. Inserted the raw transcript.', { tone: 'warning', sticky: false, clickable: false }]);
    $('a').blur();
    t.controller.focusOut();
    vi.advanceTimersByTime(FOCUS_OUT_MS);
    expect(t.pill.hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(6000 - FOCUS_OUT_MS - 1);
    expect(t.pill.hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(t.pill.hide).toHaveBeenCalledTimes(1);
  });

  it('shows a failed result with its tone and touches no field', async () => {
    const t = setup();
    await recordAndStop(t);
    t.controller.handleMessage({ action: MSG.DICTATION_RESULT, success: false, error: 'Too short, ignored', tone: 'warning' });
    await flush();
    expect(lastStatus(t.pill)).toEqual(['Too short, ignored', { tone: 'warning', sticky: false, clickable: false }]);
    t.controller.handleMessage({ action: MSG.DICTATION_RESULT, success: false, error: 'Invalid API key.', tone: 'error' });
    await flush();
    expect(lastStatus(t.pill)[1].tone).toBe('error');
    expect(t.deps.insertText).not.toHaveBeenCalled();
    expect(t.deps.copyText).not.toHaveBeenCalled();
    expect(t.controller.state).toBe('idle');
  });

  it('focus moved: clipboard, not the focused field', async () => {
    const t = setup();
    await recordAndStop(t, 'a');
    $('b').focus();
    t.controller.focusIn($('b'));
    t.controller.handleMessage(result());
    await flush();
    expect(t.deps.insertText).not.toHaveBeenCalled();
    expect(t.deps.copyText).toHaveBeenCalledWith('hello');
    expect($('b').value).toBe('');
    expect(lastStatus(t.pill)).toEqual(['The field lost focus. Text copied to clipboard.', { tone: 'warning', sticky: false, clickable: false }]);
  });

  it('removed target and failed copy: click-to-copy', async () => {
    const t = setup({ copy: false });
    await recordAndStop(t, 'a');
    $('a').remove();
    t.controller.handleMessage(result());
    await flush();
    expect(t.deps.insertText).not.toHaveBeenCalled();
    expect(lastStatus(t.pill)).toEqual([CLICK_TO_COPY, { tone: 'error', sticky: true, clickable: true }]);
    vi.advanceTimersByTime(60000);
    expect(t.pill.hide).not.toHaveBeenCalled();

    t.deps.copyText.mockResolvedValueOnce(false);
    await t.controller.copyLast();
    expect(lastStatus(t.pill)).toEqual(['Copy failed. Click here to try again.', { tone: 'error', sticky: true, clickable: true }]);
    t.deps.copyText.mockResolvedValueOnce(true);
    await t.controller.copyLast();
    expect(t.deps.copyText).toHaveBeenLastCalledWith('hello');
    expect(lastStatus(t.pill)).toEqual(['Copied to clipboard.', { tone: 'success', sticky: false, clickable: false }]);
  });

  it('copyLast does nothing before a result', async () => {
    const t = setup();
    await t.controller.copyLast();
    expect(t.deps.copyText).not.toHaveBeenCalled();
  });
});

describe('focus', () => {
  it('focusIn shows the pill at a valid field and follows it', () => {
    const t = setup();
    t.controller.focusIn($('plain'));
    t.controller.focusIn(null);
    expect(t.pill.show).not.toHaveBeenCalled();
    $('a').focus();
    t.controller.focusIn($('a'));
    expect(t.pill.show).toHaveBeenCalledWith(RECT, { gap: 8 });
    const onChange = t.deps.watchAnchor.mock.calls[0][1];
    onChange();
    expect(t.pill.reposition).toHaveBeenCalledWith(RECT);
    t.controller.focusIn($('b'));
    expect(t.unwatch).toHaveBeenCalledTimes(1);
    expect(t.deps.watchAnchor).toHaveBeenLastCalledWith($('b'), expect.any(Function));
  });

  it('hides an idle pill whose field left the page', () => {
    const t = setup();
    $('a').focus();
    t.controller.focusIn($('a'));
    const onChange = t.deps.watchAnchor.mock.calls[0][1];
    $('a').remove();
    onChange();
    expect(t.pill.hide).toHaveBeenCalled();
    expect(t.unwatch).toHaveBeenCalled();
  });

  it('keeps a recording pill at the corner when its field leaves the page', async () => {
    const t = setup();
    $('a').focus();
    await t.controller.toggle();
    const onChange = t.deps.watchAnchor.mock.calls[0][1];
    $('a').remove();
    onChange();
    expect(t.pill.hide).not.toHaveBeenCalled();
    expect(t.pill.reposition).toHaveBeenLastCalledWith(null);
  });

  it('does not move the pill while recording', async () => {
    const t = setup();
    $('a').focus();
    await t.controller.toggle();
    const shows = t.pill.show.mock.calls.length;
    $('b').focus();
    t.controller.focusIn($('b'));
    expect(t.pill.show.mock.calls).toHaveLength(shows);
  });

  it('focusOut hides only when idle', async () => {
    const t = setup();
    $('a').focus();
    t.controller.focusIn($('a'));
    $('a').blur();
    t.controller.focusOut();
    vi.advanceTimersByTime(FOCUS_OUT_MS - 1);
    expect(t.pill.hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(t.pill.hide).toHaveBeenCalledTimes(1);
    expect(t.unwatch).toHaveBeenCalledTimes(1);

    // Focus moved to another valid field: stay.
    $('a').focus();
    t.controller.focusIn($('a'));
    $('b').focus();
    t.controller.focusOut();
    vi.advanceTimersByTime(FOCUS_OUT_MS);
    expect(t.pill.hide).toHaveBeenCalledTimes(1);

    // Recording: stay.
    await t.controller.toggle();
    $('b').blur();
    t.controller.focusOut();
    vi.advanceTimersByTime(FOCUS_OUT_MS);
    expect(t.pill.hide).toHaveBeenCalledTimes(1);

    // Processing: stay.
    await t.controller.toggle();
    t.controller.focusOut();
    vi.advanceTimersByTime(FOCUS_OUT_MS);
    expect(t.pill.hide).toHaveBeenCalledTimes(1);
  });

  it('focusOut keeps the pill while a sticky status shows', async () => {
    const t = setup({ replies: { [MSG.START_RECORDING]: { ok: false, reason: 'needsPermission', error: 'Allow the microphone.' } } });
    $('a').focus();
    t.controller.focusIn($('a'));
    await t.controller.toggle();
    $('a').blur();
    t.controller.focusOut();
    vi.advanceTimersByTime(60000);
    expect(t.pill.hide).not.toHaveBeenCalled();
  });

  it('focusOut keeps the pill while focus is inside it', () => {
    const t = setup();
    $('a').focus();
    t.controller.focusIn($('a'));
    t.pill.host.tabIndex = 0;
    document.body.append(t.pill.host);
    t.pill.host.focus();
    t.controller.focusOut();
    vi.advanceTimersByTime(FOCUS_OUT_MS);
    expect(t.pill.hide).not.toHaveBeenCalled();
  });
});

describe('menu choices', () => {
  it('sends a whitelisted patch and shows a refusal', async () => {
    const t = setup({ replies: { [MSG.UPDATE_SETTINGS]: { success: false, error: 'Invalid settings.' } } });
    await t.controller.choose({ activeMode: 'email' });
    expect(t.sent.at(-1)).toEqual({ action: MSG.UPDATE_SETTINGS, patch: { activeMode: 'email' } });
    expect(lastStatus(t.pill)).toEqual(['Invalid settings.', { tone: 'error', sticky: false, clickable: false }]);
  });

  it('shows nothing when the save succeeds', async () => {
    const t = setup();
    await t.controller.choose({ provider: 'gemini' });
    expect(t.sent.at(-1)).toEqual({ action: MSG.UPDATE_SETTINGS, patch: { provider: 'gemini' } });
    expect(t.pill.setStatus).not.toHaveBeenCalled();
  });
});

describe('lifecycle', () => {
  it('orphan notice is terminal', async () => {
    const t = setup();
    $('a').focus();
    t.controller.focusIn($('a'));
    await t.controller.toggle();
    t.controller.orphaned();
    expect(lastStatus(t.pill)).toEqual([ORPHAN, { tone: 'error', sticky: true, terminal: true }]);
    expect(t.controller.state).toBe('idle');
    expect(t.pill.setState).toHaveBeenLastCalledWith('idle');
    const statuses = t.pill.setStatus.mock.calls.length;
    t.send.mockClear();

    t.controller.orphaned();
    await t.controller.toggle();
    await t.controller.press();
    await t.controller.release({ held: true });
    await t.controller.choose({ provider: 'gemini' });
    await t.controller.copyLast();
    t.controller.handleMessage({ action: MSG.DICTATION_RESULT, success: false, error: 'late', tone: 'error' });
    t.controller.handleMessage({ action: MSG.RECORDING_STATE, state: 'idle', notice: { text: 'late', tone: 'info' } });
    t.controller.setSettings(settings());
    t.controller.focusIn($('b'));
    t.controller.focusOut();
    vi.advanceTimersByTime(60000);
    await flush();

    expect(t.send).not.toHaveBeenCalled();
    expect(t.pill.setStatus.mock.calls).toHaveLength(statuses);
    expect(t.pill.hide).not.toHaveBeenCalled();
    expect(t.pill.renderMenu).not.toHaveBeenCalled();
  });

  it('shows the orphan notice at the corner when the pill was hidden', () => {
    const t = setup();
    t.controller.orphaned();
    expect(t.pill.show).toHaveBeenCalledWith(null, { gap: 8 });
    expect(lastStatus(t.pill)[0]).toBe(ORPHAN);
  });

  it('teardown removes the pill and listeners', async () => {
    const t = setup();
    $('a').focus();
    t.controller.focusIn($('a'));
    await t.controller.toggle();
    t.controller.focusOut();
    t.controller.teardown();
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.CANCEL_RECORDING]);
    expect(t.unwatch).toHaveBeenCalledTimes(1);
    expect(t.pill.destroy).toHaveBeenCalledTimes(1);
    // The pending focus-out timer is cleared: nothing hides a destroyed pill later.
    vi.advanceTimersByTime(60000);
    expect(t.pill.hide).not.toHaveBeenCalled();

    t.controller.teardown();
    await t.controller.toggle();
    t.controller.handleMessage({ action: MSG.AUDIO_LEVEL, level: 1 });
    t.controller.orphaned();
    expect(t.pill.destroy).toHaveBeenCalledTimes(1);
    expect(t.pill.setLevel).not.toHaveBeenCalled();
    expect(t.pill.setStatus).not.toHaveBeenCalled();
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.CANCEL_RECORDING]);
  });

  it('teardown when idle sends nothing, and still works after orphaned', () => {
    const t = setup();
    $('a').focus();
    t.controller.focusIn($('a'));
    t.controller.orphaned();
    t.controller.teardown();
    expect(t.send).not.toHaveBeenCalled();
    expect(t.pill.destroy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/content/controller.test.js
```

Expected: the file fails with `Error: Failed to resolve import "../../../src/content/controller.js" from "test/unit/content/controller.test.js". Does the file exist?`; no tests run.

- [ ] **Step 3: Create `src/content/controller.js`**

```js
// The in-page state machine: which field the pill follows, the recording state as this frame
// sees it, and where a finished transcript goes. Side effects arrive through deps.
import { MSG } from '../shared/messages.js';
import { formatCost } from '../shared/pricing.js';
import { STATUS_MS } from './pill.js';

/**
 * @typedef {import('./position.js').Box} Box
 * @typedef {Pick<import('./pill.js').Pill, 'show'|'reposition'|'hide'|'visible'|'host'|'setState'|'setLevel'
 *   |'setStatus'|'clearStatus'|'renderMenu'|'destroy'>} PillLike
 * @typedef {'idle'|'starting'|'recording'|'processing'} ControllerState
 * @typedef {{
 *   pill: PillLike,
 *   send: (message: object) => Promise<any|null>,
 *   insertText: typeof import('./insert.js').insertText,
 *   copyText: typeof import('./insert.js').copyText,
 *   isValidInput: (el: Element|null) => boolean,
 *   deepActiveElement: () => Element|null,
 *   rectOf: (el: Element) => Box|null,
 *   watchAnchor: (el: Element, onChange: () => void) => () => void,
 *   setTimeout: (fn: () => void, ms: number) => any,
 *   clearTimeout: (id: any) => void,
 * }} ControllerDeps
 */

/** Delay before a focus-out hides the pill, so a click that moves focus can land first. */
export const FOCUS_OUT_MS = 200;

const ORPHAN_NOTICE = 'VoiceType was updated. Reload this page.';
const NO_REPLY = 'VoiceType could not reach its background service. Try again.';
const CLICK_TO_COPY = 'Could not insert. Click here to copy the text.';
const AUTO_STOP = Object.freeze({
  maxTime: { text: 'Max time reached', tone: 'info' },
  silence: { text: 'Stopped after silence', tone: 'info' },
  ended: { text: 'Microphone disconnected', tone: 'warning' },
});
const DEFAULT_GAP = 8;

const finite = (value) => (Number.isFinite(value) ? value : 0);
const textOr = (value, fallback) => (typeof value === 'string' && value ? value : fallback);

/**
 * @param {ControllerDeps} deps
 */
export function createController(deps) {
  const { pill, send, insertText, copyText, isValidInput, deepActiveElement, rectOf, watchAnchor } = deps;

  /** @type {ControllerState} */
  let state = 'idle';
  let settings = null;
  let usage = null;
  /** Element the pill is placed at (null: the corner or not shown). */
  let anchorEl = null;
  let unwatch = null;
  /** Field bound at REC start (D12): the text goes here only if it still has focus. */
  let target = null;
  let stopQueued = false;
  /** The current hotkey press started this recording, so a held release stops it. */
  let pressStarted = false;
  let lastResult = null;
  /** A status is showing; the pill is not hidden under it. */
  let statusBusy = false;
  let statusTimer = null;
  let focusTimer = null;
  let orphan = false;
  let dead = false;

  const inactive = () => orphan || dead;
  const gap = () => (Number.isFinite(settings?.pillGap) && settings.pillGap >= 0 ? settings.pillGap : DEFAULT_GAP);

  /** Show the pill at el (null: the corner) and follow it. */
  function anchorTo(el) {
    if (el !== anchorEl) {
      unwatch?.();
      unwatch = null;
      anchorEl = el;
      if (el) unwatch = watchAnchor(el, onAnchorChange);
    }
    pill.show(el ? rectOf(el) : null, { gap: gap() });
  }

  function onAnchorChange() {
    if (dead || !anchorEl) return;
    const box = rectOf(anchorEl);
    if (!box && state === 'idle' && !orphan) hide();
    else pill.reposition(box);
  }

  function hide() {
    unwatch?.();
    unwatch = null;
    anchorEl = null;
    pill.hide();
  }

  /** After focus or a status changes: follow the focused field, or hide an idle pill with nothing to show. */
  function settle() {
    if (inactive() || state !== 'idle' || statusBusy) return;
    const active = deepActiveElement();
    if (isValidInput(active)) {
      if (active !== anchorEl) anchorTo(active);
      return;
    }
    if (active && active === pill.host) return;
    if (pill.visible) hide();
  }

  function notify(text, { tone = 'info', sticky = false, clickable = false } = {}) {
    pill.setStatus(text, { tone, sticky, clickable });
    deps.clearTimeout(statusTimer);
    statusTimer = null;
    statusBusy = true;
    if (sticky) return;
    statusTimer = deps.setTimeout(() => {
      statusTimer = null;
      statusBusy = false;
      if (state === 'idle') pill.setState('idle');
      settle();
    }, STATUS_MS[tone] ?? STATUS_MS.info);
  }

  function clearNotice() {
    deps.clearTimeout(statusTimer);
    statusTimer = null;
    statusBusy = false;
    pill.clearStatus();
  }

  function render() {
    if (settings) pill.renderMenu(settings, usage);
  }

  /** @param {unknown} next */
  function setSettings(next) {
    if (inactive()) return;
    if (!next || typeof next !== 'object' || !next.modes || typeof next.modes !== 'object') return;
    settings = next;
    render();
  }

  /** @param {unknown} stats the GET_USAGE reply ({ today, last7Days, total }) */
  function setUsage(stats) {
    if (inactive() || !stats || typeof stats !== 'object') return;
    const { today, total } = /** @type {any} */ (stats);
    if (!today || typeof today !== 'object' || !total || typeof total !== 'object') return;
    usage = { todayCost: finite(today.estimatedCost), todaySessions: finite(today.sessions), totalCost: finite(total.estimatedCost) };
    render();
  }

  /** @param {Element|null} el */
  function focusIn(el) {
    if (inactive() || !isValidInput(el)) return;
    if (state === 'idle') anchorTo(el);
  }

  function focusOut() {
    if (inactive()) return;
    deps.clearTimeout(focusTimer);
    focusTimer = deps.setTimeout(() => {
      focusTimer = null;
      settle();
    }, FOCUS_OUT_MS);
  }

  async function start() {
    const active = deepActiveElement();
    target = isValidInput(active) ? active : null;
    stopQueued = false;
    state = 'starting';
    clearNotice();
    anchorTo(target);
    const reply = await send({ action: MSG.START_RECORDING });
    // Torn down, orphaned, or reset meanwhile (pagehide): this reply is stale.
    if (inactive() || state !== 'starting') return;
    if (reply?.ok === true) {
      state = 'recording';
      pill.setState('recording');
      if (stopQueued) await stop();
      return;
    }
    state = 'idle';
    target = null;
    stopQueued = false;
    pressStarted = false;
    pill.setState('idle');
    if (reply && reply.ok === false) {
      const text = textOr(reply.error, 'Could not start the microphone.');
      notify(text, reply.reason === 'needsPermission' ? { tone: 'info', sticky: true } : { tone: 'error' });
    } else {
      notify(NO_REPLY, { tone: 'error' });
    }
  }

  async function stop() {
    stopQueued = false;
    state = 'processing';
    pill.setState('processing');
    const reply = await send({ action: MSG.STOP_RECORDING });
    if (inactive() || state !== 'processing' || reply?.ok === true) return;
    // The service worker holds no session for this frame, so no result is coming for a stop.
    // A result that does arrive is still delivered: target stays bound until then.
    state = 'idle';
    pill.setState('idle');
    if (!reply) notify(NO_REPLY, { tone: 'error' });
    else settle();
  }

  /** One path for REC clicks and hotkey taps. */
  async function toggle() {
    if (inactive()) return;
    if (state === 'idle') return start();
    if (state === 'starting') {
      stopQueued = true;
      return;
    }
    if (state === 'recording') return stop();
    notify('Still processing', { tone: 'info' });
  }

  async function press() {
    if (inactive()) return;
    if (state === 'idle') {
      pressStarted = true;
      return start();
    }
    pressStarted = false;
    return toggle();
  }

  /** @param {{ held: boolean }} release */
  async function release({ held } = { held: false }) {
    if (inactive()) return;
    const started = pressStarted;
    pressStarted = false;
    if (!started || !held) return;
    if (state === 'starting') stopQueued = true;
    else if (state === 'recording') await stop();
  }

  function onRecordingState(message) {
    if (message.state === 'processing') {
      state = 'processing';
      stopQueued = false;
      pill.setState('processing');
      const notice = Object.hasOwn(AUTO_STOP, message.reason) ? AUTO_STOP[message.reason] : null;
      if (notice) notify(notice.text, { tone: notice.tone });
      return;
    }
    if (message.state !== 'idle') return;
    // A permission result only concerns a frame that is not recording again already.
    if (message.reason === 'permission' && state !== 'idle') return;
    state = 'idle';
    target = null;
    stopQueued = false;
    pressStarted = false;
    pill.setState('idle');
    const notice = message.notice;
    if (notice && typeof notice === 'object' && typeof notice.text === 'string' && notice.text) {
      const tone = Object.hasOwn(STATUS_MS, notice.tone) ? notice.tone : 'info';
      // Permission notices arrive while the user is in the permission tab; keep them until the next REC.
      notify(notice.text, { tone, sticky: message.reason === 'permission' });
    } else {
      settle();
    }
  }

  async function deliver(message) {
    const bound = target;
    target = null;
    stopQueued = false;
    pressStarted = false;
    if (state === 'processing') state = 'idle';
    if (!message.success) {
      pill.setState('error');
      notify(textOr(message.error, 'Transcription failed.'), { tone: message.tone === 'warning' ? 'warning' : 'error' });
      return;
    }
    const text = typeof message.text === 'string' ? message.text : '';
    lastResult = { text, raw: typeof message.raw === 'string' ? message.raw : text };

    if (bound && bound.isConnected && deepActiveElement() === bound) {
      const outcome = await insertText(bound, text);
      if (inactive()) return;
      if (outcome === 'inserted') {
        pill.setState('done');
        if (typeof message.warning === 'string' && message.warning) notify(message.warning, { tone: 'warning' });
        else notify(`Done ${formatCost(finite(message.cost))}`, { tone: 'success' });
      } else if (outcome === 'unverified') {
        pill.setState('done');
        notify('Could not confirm the insert. The text is also on the clipboard.', { tone: 'warning' });
      } else if (outcome === 'clipboard') {
        pill.setState('done');
        notify('Copied to clipboard. The field could not be edited.', { tone: 'warning' });
      } else {
        pill.setState('error');
        notify(CLICK_TO_COPY, { tone: 'error', sticky: true, clickable: true });
      }
      return;
    }

    // D12: never insert into a field other than the one bound at REC start.
    const copied = await copyText(text);
    if (inactive()) return;
    if (!copied) {
      pill.setState('error');
      notify(CLICK_TO_COPY, { tone: 'error', sticky: true, clickable: true });
    } else if (bound) {
      pill.setState('done');
      notify('The field lost focus. Text copied to clipboard.', { tone: 'warning' });
    } else {
      pill.setState('done');
      notify('Copied to clipboard.', { tone: 'info' });
    }
  }

  /** @param {unknown} message a runtime message from the service worker */
  function handleMessage(message) {
    if (inactive() || !message || typeof message !== 'object') return;
    const m = /** @type {any} */ (message);
    switch (m.action) {
      case MSG.SETTINGS_CHANGED:
        setSettings(m.settings);
        break;
      case MSG.AUDIO_LEVEL:
        if (state === 'recording') pill.setLevel(Number(m.level));
        break;
      case MSG.RECORDING_STATE:
        onRecordingState(m);
        break;
      case MSG.DICTATION_RESULT:
        deliver(m);
        break;
      default:
        break;
    }
  }

  /** Click-to-copy: the click is a user gesture, so the clipboard write is allowed now. */
  async function copyLast() {
    if (inactive() || !lastResult) return;
    const copied = await copyText(lastResult.text);
    if (inactive()) return;
    if (copied) {
      pill.setState('idle');
      notify('Copied to clipboard.', { tone: 'success' });
    } else {
      notify('Copy failed. Click here to try again.', { tone: 'error', sticky: true, clickable: true });
    }
  }

  /**
   * A menu choice. The menu re-renders from the SETTINGS_CHANGED push that follows a save.
   * @param {{ activeMode?: string, provider?: string, translateTargetLang?: string }} patch
   */
  async function choose(patch) {
    if (inactive()) return;
    const reply = await send({ action: MSG.UPDATE_SETTINGS, patch });
    if (inactive()) return;
    if (!reply) notify(NO_REPLY, { tone: 'error' });
    else if (reply.success !== true) notify(textOr(reply.error, 'Could not save the setting.'), { tone: 'error' });
  }

  /** The extension was reloaded or updated under this page: say so, then do nothing more. */
  function orphaned() {
    if (inactive()) return;
    orphan = true;
    deps.clearTimeout(focusTimer);
    deps.clearTimeout(statusTimer);
    focusTimer = null;
    statusTimer = null;
    state = 'idle';
    target = null;
    stopQueued = false;
    pressStarted = false;
    pill.setState('idle');
    if (!pill.visible) {
      const active = deepActiveElement();
      anchorTo(isValidInput(active) ? active : null);
    }
    pill.setStatus(ORPHAN_NOTICE, { tone: 'error', sticky: true, terminal: true });
  }

  /** Remove everything this instance added. Also runs after orphaned(): a newer copy replaces this one. */
  function teardown() {
    if (dead) return;
    if (!orphan && (state === 'starting' || state === 'recording')) send({ action: MSG.CANCEL_RECORDING });
    dead = true;
    deps.clearTimeout(focusTimer);
    deps.clearTimeout(statusTimer);
    focusTimer = null;
    statusTimer = null;
    unwatch?.();
    unwatch = null;
    anchorEl = null;
    target = null;
    pill.destroy();
  }

  return {
    setSettings,
    setUsage,
    focusIn,
    focusOut,
    toggle,
    press,
    release,
    handleMessage,
    copyLast,
    choose,
    orphaned,
    teardown,
    get state() {
      return state;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/unit/content/controller.test.js
```

Expected: 44 passed, including "orphan notice is terminal", "teardown removes the pill and listeners", "focus moved: clipboard, not the focused field" and "removed target and failed copy: click-to-copy".

- [ ] **Step 5: Commit the controller**

```bash
npm test
git add src/content/controller.js test/unit/content/controller.test.js
git commit -m "Add the content controller for recording state, focus and delivery"
```

Expected: the suite passes; report it as N/N (44 more tests than after Task 10).

- [ ] **Step 6: Write the failing entry tests**

`test/unit/content/index.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MSG } from '../../../src/shared/messages.js';

// A path, not a URL literal: jsdom replaces the global URL, and the web transform rewrites
// `new URL('<literal>', import.meta.url)` into a dev-server address.
const fromHere = (relative) => fileURLToPath(new URL(relative, import.meta.url).href);
const CONTENT_DIR = fromHere('../../../src/content/');
const readContent = (name) => readFileSync(`${CONTENT_DIR}${name}`, 'utf8');

const SETTINGS = {
  settingsVersion: 2,
  provider: 'openai',
  hasKey: { openai: true, gemini: false },
  activeMode: 'default',
  translateTargetLang: 'English',
  pillGap: 8,
  hotkey: { code: 'Space', ctrl: true, shift: true, alt: false, meta: false },
  modes: {
    default: { name: 'Default', icon: '🎤', prompt: '', builtIn: true },
    email: { name: 'Email', icon: '📧', prompt: 'p', builtIn: true },
  },
};
const USAGE = {
  today: { sessions: 2, audioSeconds: 20, estimatedCost: 0.012 },
  last7Days: { sessions: 5, audioSeconds: 50, estimatedCost: 0.03 },
  total: { sessions: 9, audioSeconds: 90, estimatedCost: 0.5 },
};

function reply(message) {
  switch (message.action) {
    case MSG.GET_SETTINGS: return structuredClone(SETTINGS);
    case MSG.GET_USAGE: return structuredClone(USAGE);
    case MSG.UPDATE_SETTINGS: return { success: true };
    default: return { ok: true };
  }
}

/** A fake `chrome` with only what a content script may use; any chrome.storage access is recorded. */
function installChrome(respond = reply) {
  const listeners = new Set();
  const storageAccess = [];
  const chrome = {
    runtime: {
      id: 'voicetype-test',
      sendMessage: vi.fn(async (message) => respond(message)),
      onMessage: {
        addListener: vi.fn((fn) => listeners.add(fn)),
        removeListener: vi.fn((fn) => listeners.delete(fn)),
      },
    },
  };
  Object.defineProperty(chrome, 'storage', {
    get() {
      storageAccess.push('chrome.storage');
      return undefined;
    },
  });
  globalThis.chrome = chrome;
  return { chrome, listeners, storageAccess, sent: () => chrome.runtime.sendMessage.mock.calls.map(([m]) => m.action) };
}

/** Evaluate a fresh copy of the entry, as Chrome does when it injects content.js again. */
async function loadInstance() {
  vi.resetModules();
  await import('../../../src/content/index.js');
  await flush();
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const hosts = () => document.documentElement.querySelectorAll('voicetype-host');
const shadow = () => hosts()[0].shadowRoot;
const hotkey = (type, extra = {}) => new KeyboardEvent(type, {
  code: 'Space', key: ' ', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true, ...extra,
});

const attachShadow = Element.prototype.attachShadow;

beforeEach(() => {
  // Open roots so the test can look inside the pill; production uses closed ones.
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function attachOpen(init) {
    return attachShadow.call(this, { ...init, mode: 'open' });
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  document.body.innerHTML = '<textarea id="field"></textarea><input id="other">';
  // jsdom has no layout; an all-zero box counts as offscreen and would hide the pill.
  for (const el of document.querySelectorAll('#field, #other')) {
    el.getBoundingClientRect = () => ({ top: 100, left: 400, width: 300, height: 30, right: 700, bottom: 130, x: 400, y: 100 });
  }
});

afterEach(() => {
  document.dispatchEvent(new CustomEvent('voicetype:teardown'));
  hosts().forEach((el) => el.remove());
  document.activeElement?.blur?.();
  vi.restoreAllMocks();
  delete globalThis.chrome;
});

describe('teardown handshake', () => {
  it('a new instance removes the old host, listeners and hotkey', async () => {
    const t = installChrome();
    document.getElementById('field').focus();
    await loadInstance();
    const first = hosts()[0];
    expect(first).toBeDefined();
    expect(t.listeners.size).toBe(1);
    const [firstListener] = t.listeners;

    await loadInstance();
    expect(first.isConnected).toBe(false);
    expect(hosts()).toHaveLength(1);
    expect(hosts()[0]).not.toBe(first);
    expect(t.chrome.runtime.onMessage.removeListener).toHaveBeenCalledWith(firstListener);
    expect(t.listeners.size).toBe(1);
    expect(t.listeners.has(firstListener)).toBe(false);

    document.getElementById('field').dispatchEvent(hotkey('keydown'));
    await flush();
    expect(t.sent().filter((a) => a === MSG.START_RECORDING)).toHaveLength(1);
  });

  it('the old instance cancels its recording when it is replaced', async () => {
    const t = installChrome();
    document.getElementById('field').focus();
    await loadInstance();
    shadow().querySelector('.rec').click();
    await flush();
    await loadInstance();
    expect(t.sent()).toContain(MSG.CANCEL_RECORDING);
  });
});

describe('orphan detection', () => {
  it('an "Extension context invalidated" rejection shows the terminal notice', async () => {
    const t = installChrome((message) => {
      if (message.action === MSG.START_RECORDING) throw new Error('Extension context invalidated.');
      return reply(message);
    });
    document.getElementById('field').focus();
    await loadInstance();
    const root = shadow();
    root.querySelector('.rec').click();
    await flush();
    expect(root.querySelector('[role="status"]').textContent).toBe('VoiceType was updated. Reload this page.');
    expect(console.warn).not.toHaveBeenCalled();

    root.querySelector('.rec').click();
    document.getElementById('field').dispatchEvent(hotkey('keydown'));
    await flush();
    expect(t.sent().filter((a) => a === MSG.START_RECORDING)).toHaveLength(1);
    expect(root.querySelector('[role="status"]').textContent).toBe('VoiceType was updated. Reload this page.');
  });

  it('a synchronous throw is treated the same way', async () => {
    const t = installChrome();
    document.getElementById('field').focus();
    await loadInstance();
    t.chrome.runtime.sendMessage.mockImplementation(() => { throw new Error('Extension context invalidated.'); });
    shadow().querySelector('.rec').click();
    await flush();
    expect(shadow().querySelector('[role="status"]').textContent).toBe('VoiceType was updated. Reload this page.');
  });

  it('other errors are logged and are not terminal', async () => {
    let fail = true;
    const t = installChrome((message) => {
      if (message.action === MSG.START_RECORDING && fail) throw new Error('Could not establish connection. Receiving end does not exist.');
      return reply(message);
    });
    document.getElementById('field').focus();
    await loadInstance();
    shadow().querySelector('.rec').click();
    await flush();
    expect(console.warn).toHaveBeenCalledWith('VoiceType: Could not establish connection. Receiving end does not exist.');
    expect(shadow().querySelector('[role="status"]').textContent).toBe('VoiceType could not reach its background service. Try again.');
    fail = false;
    shadow().querySelector('.rec').click();
    await flush();
    expect(t.sent().filter((a) => a === MSG.START_RECORDING)).toHaveLength(2);
    expect(shadow().querySelector('.rec').getAttribute('aria-label')).toBe('Stop recording');
  });
});

describe('wiring', () => {
  it('loads settings at start and refetches settings and usage when the menu opens', async () => {
    const t = installChrome();
    document.getElementById('field').focus();
    await loadInstance();
    expect(t.sent()).toEqual([MSG.GET_SETTINGS]);
    expect(shadow().querySelector('.mode-icon').textContent).toBe('🎤');
    shadow().querySelector('.more').click();
    await flush();
    expect(t.sent()).toEqual([MSG.GET_SETTINGS, MSG.GET_SETTINGS, MSG.GET_USAGE]);
    expect(shadow().querySelector('.usage').textContent).toBe('Today $0.01 (2), all time $0.50');
  });

  it('shows the pill when a field gains focus, using the composed path', async () => {
    installChrome();
    await loadInstance();
    expect(hosts()).toHaveLength(0);
    document.getElementById('field').focus();
    expect(hosts()).toHaveLength(1);
    expect(shadow().querySelector('.vt').hidden).toBe(false);
  });

  it('consumes the hotkey press and its repeats, and nothing else', async () => {
    const t = installChrome();
    const field = document.getElementById('field');
    field.focus();
    await loadInstance();
    const down = hotkey('keydown');
    field.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    await flush();
    const repeat = hotkey('keydown', { repeat: true });
    field.dispatchEvent(repeat);
    expect(repeat.defaultPrevented).toBe(true);
    const other = new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true, cancelable: true });
    field.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
    expect(t.sent().filter((a) => a === MSG.START_RECORDING)).toHaveLength(1);
  });

  it('a window blur during a hold ends the press', async () => {
    const t = installChrome();
    const field = document.getElementById('field');
    field.focus();
    await loadInstance();
    field.dispatchEvent(hotkey('keydown'));
    await flush();
    window.dispatchEvent(new Event('blur'));
    await flush();
    // A tap (released at once) keeps recording; nothing else is sent.
    expect(t.sent()).toEqual([MSG.GET_SETTINGS, MSG.START_RECORDING]);
    field.dispatchEvent(hotkey('keydown'));
    await flush();
    expect(t.sent()).toEqual([MSG.GET_SETTINGS, MSG.START_RECORDING, MSG.STOP_RECORDING]);
  });

  it('pagehide while recording cancels the session', async () => {
    const t = installChrome();
    const field = document.getElementById('field');
    field.focus();
    await loadInstance();
    window.dispatchEvent(new Event('pagehide'));
    expect(t.sent()).not.toContain(MSG.CANCEL_RECORDING);
    field.dispatchEvent(hotkey('keydown'));
    await flush();
    window.dispatchEvent(new Event('pagehide'));
    expect(t.sent()).toContain(MSG.CANCEL_RECORDING);
    expect(shadow().querySelector('.rec').getAttribute('aria-label')).toBe('Start recording');
  });

  it('forwards runtime messages to the controller and returns false', async () => {
    const t = installChrome();
    document.getElementById('field').focus();
    await loadInstance();
    const [listener] = t.listeners;
    const next = { ...structuredClone(SETTINGS), activeMode: 'email', hotkey: { code: 'KeyD', ctrl: false, shift: false, alt: true, meta: false } };
    expect(listener({ action: MSG.SETTINGS_CHANGED, settings: next }, {}, () => {})).toBe(false);
    expect(shadow().querySelector('.mode-icon').textContent).toBe('📧');

    // The pushed hotkey replaces the default chord.
    const field = document.getElementById('field');
    const oldChord = hotkey('keydown');
    field.dispatchEvent(oldChord);
    expect(oldChord.defaultPrevented).toBe(false);
    const newChord = new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', altKey: true, bubbles: true, cancelable: true });
    field.dispatchEvent(newChord);
    expect(newChord.defaultPrevented).toBe(true);
  });

  it('menu choices send a whitelisted patch', async () => {
    const t = installChrome();
    document.getElementById('field').focus();
    await loadInstance();
    shadow().querySelector('.more').click();
    await flush();
    shadow().querySelector('[data-provider="gemini"]').click();
    shadow().querySelector('[data-mode="email"]').click();
    await flush();
    const patches = t.chrome.runtime.sendMessage.mock.calls.map(([m]) => m).filter((m) => m.action === MSG.UPDATE_SETTINGS);
    expect(patches).toEqual([
      { action: MSG.UPDATE_SETTINGS, patch: { provider: 'gemini' } },
      { action: MSG.UPDATE_SETTINGS, patch: { activeMode: 'email' } },
    ]);
  });
});

describe('page and key isolation', () => {
  it('never touches chrome.storage', async () => {
    const t = installChrome();
    document.getElementById('field').focus();
    await loadInstance();
    shadow().querySelector('.more').click();
    shadow().querySelector('.rec').click();
    await flush();
    expect(t.storageAccess).toEqual([]);
    for (const name of ['index.js', 'controller.js', 'pill.js']) expect(readContent(name), name).not.toMatch(/chrome\.storage/);
  });

  it('no file under src/content uses an HTML string sink', () => {
    const files = readdirSync(CONTENT_DIR).filter((name) => name.endsWith('.js'));
    expect(files).toContain('index.js');
    for (const name of files) {
      expect(readContent(name), name).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    }
  });
});
```

- [ ] **Step 7: Extend the manifest and message tests**

Append to the end of `test/unit/manifest.test.js` (the block reuses the file's `manifest` constant and imports):

```js
describe('content script', () => {
  it('runs content.js in every frame, about:blank frames included, with no stylesheet', () => {
    expect(manifest.content_scripts).toEqual([
      { matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_idle', all_frames: true, match_about_blank: true },
    ]);
  });

  it('exposes no web accessible resources to pages', () => {
    expect(manifest).not.toHaveProperty('web_accessible_resources');
  });
});
```

In `test/unit/shared/messages.test.js`, replace:

```js
  it('is frozen', () => {
    expect(Object.isFrozen(MSG)).toBe(true);
  });
});
```

with:

```js
  it('is frozen', () => {
    expect(Object.isFrozen(MSG)).toBe(true);
  });

  it('holds exactly the contract: the legacy v2.0 content actions are gone', () => {
    expect(MSG).toEqual(CONTRACT);
    for (const legacy of ['checkApiKey', 'transcribe', 'toggle-recording']) expect(Object.values(MSG)).not.toContain(legacy);
  });
});
```

- [ ] **Step 8: Run the tests to verify they fail**

```bash
npx vitest run test/unit/content/index.test.js test/unit/manifest.test.js test/unit/shared/messages.test.js
```

Expected: 16 failed, 8 passed. All 14 entry tests fail: the 13 that load the v2.0 entry stop at `TypeError: Cannot read properties of undefined (reading 'onChanged')` (it registers `chrome.storage.onChanged`, and the fake `chrome` has no storage), and "no file under src/content uses an HTML string sink" finds its `innerHTML`. "runs content.js in every frame, about:blank frames included, with no stylesheet" fails on the `css` key and the missing frame flags; "holds exactly the contract: the legacy v2.0 content actions are gone" fails on the three legacy keys.

- [ ] **Step 9: Rewrite `src/content/index.js`**

Replace the whole file with:

```js
// VoiceType content script entry. Runs in every frame; wires the page, the service worker
// and the controller. Everything is registered synchronously at load.
import { MSG } from '../shared/messages.js';
import { DEFAULT_SETTINGS } from '../shared/defaults.js';
import { isValidChord } from '../shared/chord.js';
import { isValidInput, deepActiveElement } from './fields.js';
import { insertText, copyText } from './insert.js';
import { watchAnchor } from './anchor.js';
import { createChordTracker } from './hotkey.js';
import { Pill } from './pill.js';
import { createController } from './controller.js';

const TEARDOWN_EVENT = 'voicetype:teardown';

// A copy injected before an extension reload or update is still listening: remove it first.
document.dispatchEvent(new CustomEvent(TEARDOWN_EVENT));

let chord = DEFAULT_SETTINGS.hotkey;

const pill = new Pill({
  onRec: () => { controller.toggle(); },
  onStatusClick: () => { controller.copyLast(); },
  onMenuOpen: () => { loadSettings({ withUsage: true }); },
  onMode: (key) => { controller.choose({ activeMode: key }); },
  onProvider: (id) => { controller.choose({ provider: id }); },
  onTargetLang: (lang) => { controller.choose({ translateTargetLang: lang }); },
});

const controller = createController({
  pill,
  send,
  insertText,
  copyText,
  isValidInput,
  deepActiveElement: () => deepActiveElement(document),
  rectOf,
  watchAnchor,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
});

const tracker = createChordTracker({ getChord: () => chord });

/**
 * Message the service worker. Resolves null on any failure; an invalidated extension
 * context (reloaded or updated extension) turns this copy into the terminal notice.
 * @param {object} message
 * @returns {Promise<any|null>}
 */
async function send(message) {
  try {
    return (await chrome.runtime.sendMessage(message)) ?? null;
  } catch (err) {
    const text = String(err?.message ?? err);
    if (text.includes('Extension context invalidated')) controller.orphaned();
    else console.warn(`VoiceType: ${text}`);
    return null;
  }
}

/** @param {Element} el @returns {import('./position.js').Box|null} */
function rectOf(el) {
  if (!el?.isConnected) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

/** The chord tracker reads the hotkey from here; the controller keeps the rest of the settings. */
function trackHotkey(settings) {
  if (settings && typeof settings === 'object' && isValidChord(settings.hotkey)) chord = settings.hotkey;
}

async function loadSettings({ withUsage = false } = {}) {
  const [settings, usage] = await Promise.all([
    send({ action: MSG.GET_SETTINGS }),
    withUsage ? send({ action: MSG.GET_USAGE }) : null,
  ]);
  trackHotkey(settings);
  controller.setSettings(settings);
  if (withUsage) controller.setUsage(usage);
}

function onFocusIn(event) {
  controller.focusIn(event.composedPath()[0] ?? null);
}

function onFocusOut() {
  controller.focusOut();
}

function onKeyDown(event) {
  const kind = tracker.keydown(event);
  if (!kind) return;
  event.preventDefault();
  event.stopPropagation();
  if (kind === 'press') controller.press();
}

function onKeyUp(event) {
  const released = tracker.keyup(event);
  if (released) controller.release(released);
}

function onWindowBlur() {
  const released = tracker.blur();
  if (released) controller.release(released);
}

function onPageHide() {
  if (controller.state !== 'starting' && controller.state !== 'recording') return;
  send({ action: MSG.CANCEL_RECORDING });
  // The page may come back from the back-forward cache; do not leave it showing a recording.
  controller.handleMessage({ action: MSG.RECORDING_STATE, state: 'idle' });
}

function onMessage(message) {
  if (message?.action === MSG.SETTINGS_CHANGED) trackHotkey(message.settings);
  controller.handleMessage(message);
  return false;
}

function teardown() {
  controller.teardown();
  document.removeEventListener('focusin', onFocusIn, true);
  document.removeEventListener('focusout', onFocusOut, true);
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('keyup', onKeyUp, true);
  window.removeEventListener('blur', onWindowBlur);
  window.removeEventListener('pagehide', onPageHide);
  try {
    chrome.runtime.onMessage.removeListener(onMessage);
  } catch {
    // An orphaned context may refuse; its listener is dead anyway.
  }
}

document.addEventListener(TEARDOWN_EVENT, teardown, { once: true });
document.addEventListener('focusin', onFocusIn, true);
document.addEventListener('focusout', onFocusOut, true);
window.addEventListener('keydown', onKeyDown, true);
window.addEventListener('keyup', onKeyUp, true);
// Not capture: element blur events would reach a capturing window listener too.
window.addEventListener('blur', onWindowBlur);
window.addEventListener('pagehide', onPageHide);
chrome.runtime.onMessage.addListener(onMessage);

loadSettings();
// Injected after an update, or at document_idle after the user already clicked into a field.
controller.focusIn(deepActiveElement(document));
```

- [ ] **Step 10: Remove `content.css` and the legacy keys, and run the script in every frame**

```bash
git rm src/content/content.css
```

In `build.mjs`, replace:

```js
  ['src/content/content.css', 'content.css'],
  ['icons/icon16.png', 'icons/icon16.png'],
```

with:

```js
  ['icons/icon16.png', 'icons/icon16.png'],
```

In `manifest.json`, replace:

```json
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "css": ["content.css"],
      "run_at": "document_idle"
    }
  ],
```

with:

```json
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle",
      "all_frames": true,
      "match_about_blank": true
    }
  ],
```

In `src/shared/messages.js`, replace:

```js
  PERMISSION_RESULT: 'permissionResult',
  // Legacy v2.0 content path; removed in Task 11.
  CHECK_KEY: 'checkApiKey',
  TRANSCRIBE: 'transcribe',
  TOGGLE_RECORDING: 'toggle-recording',
});
```

with:

```js
  PERMISSION_RESULT: 'permissionResult',
});
```

- [ ] **Step 11: Run the tests to verify they pass**

```bash
npx vitest run test/unit/content test/unit/manifest.test.js test/unit/shared/messages.test.js
```

Expected: every file passes; `index.test.js` 14 passed, `controller.test.js` 44 passed, `pill.test.js` 38 passed, `manifest.test.js` 6 passed, `messages.test.js` 4 passed.

- [ ] **Step 12: Confirm nothing uses the legacy keys or the old stylesheet**

```bash
grep -rn "CHECK_KEY\|TRANSCRIBE\|TOGGLE_RECORDING" src test
grep -rn "content\.css" build.mjs manifest.json src test
```

Expected: both print nothing.

- [ ] **Step 13: Run the full suite and the build, and check the bundle**

```bash
npm test
npm run build
ls dist
grep -c "prefers-reduced-motion" dist/content.js
grep -cE "innerHTML|outerHTML|insertAdjacentHTML|chrome\.storage" dist/content.js
```

Expected: the suite passes; report it as N/N (this task adds 44 + 14 + 2 + 1 tests). The build is clean; `dist` holds no `content.css`. The first `grep -c` prints `1` (pill.css is inlined as text); the second prints `0`.

- [ ] **Step 14: Commit**

```bash
git add src/content/index.js build.mjs manifest.json src/shared/messages.js test/unit/content/index.test.js test/unit/manifest.test.js test/unit/shared/messages.test.js
git commit -m "Rewrite the content entry around the controller and run it in every frame"
```

---

### Task 12: Popup rework

**Files:**
- Rewrite: `src/popup/popup.html`, `src/popup/popup.css`, `src/popup/popup.js`
- Create: `src/popup/form.js`
- Test: `test/unit/popup/form.test.js`, `test/unit/popup/popup.test.js` (jsdom, loads `popup.html` and a fake `chrome`)

**Interfaces:**
- Consumes: Task 3 `MSG`, `formatChord`, `chordFromEvent`, `AUTO_STOP_CHOICES`, `freshSettings`; `PROVIDERS`; `formatCost`.
- Produces:
  - `src/popup/form.js`:
    - `SPOKEN_LANGUAGES = [{ code: 'en', label: 'English' }, { code: 'el', label: 'Greek' }, { code: 'es', label: 'Spanish' }, { code: 'fr', label: 'French' }, { code: 'de', label: 'German' }, { code: 'it', label: 'Italian' }, { code: 'pt', label: 'Portuguese' }]` (an "Auto" option means `languages: []`).
    - `parseKeywords(text: string): string[]`: one term per line, trimmed, empty lines dropped, case-insensitive duplicates dropped (first kept), at most 100 terms.
    - `formatKeywords(list: string[]): string` joins with `\n`.
    - `toggleLanguage(list: string[], code: string, checked: boolean): string[]`: `'auto'` checked returns `[]`; others add or remove preserving `SPOKEN_LANGUAGES` order.
    - `createInlineConfirm(button: HTMLButtonElement, { prompt = 'Click again to confirm', ms = 3000, onConfirm, setTimeout, clearTimeout })`: first click swaps the label to `prompt`; a second click within `ms` calls `onConfirm`; otherwise the label reverts. Replaces `confirm()`.
  - `src/popup/popup.js` exports `initPopup({ chrome, document, window })` (auto-invoked on `DOMContentLoaded` when `globalThis.chrome?.runtime` exists) and behaves as:
    - Layout (spec 6.6): one column, 320 px, 12 px minimum type, contrast tokens meeting 4.5:1, dark mode via `prefers-color-scheme`, visible focus rings, inline SVG icons. Sections in order: Provider (segmented OpenAI or Gemini; key field, Test, Clear), Recording (min, max, silence auto-stop `Off, 2 s, 3 s, 5 s`, hotkey recorder), Speech (spoken languages as checkboxes including Auto; vocabulary textarea, one term per line), Modes (list, editor), Usage (table, per provider, Refresh, Clear history), About (version from the manifest, GitHub link `https://github.com/kskarakostas/VoiceType`, privacy link).
    - Autosave on every change through `SAVE_SETTINGS`; no Save button. A failed save restores the previous in-memory settings and re-renders the affected controls, then shows the error.
    - Keys save on `change`, on `blur`, and 800 ms after the last `input` event (paste then click outside must save). Keys are shown masked.
    - Load failure shows a persistent banner (not a toast) and disables persistence; later toasts never replace it.
    - Clear history and Reset use `createInlineConfirm`; the "Usage history cleared" toast shows only on `{ success: true }`. Reset keeps both keys, the provider, `languages` and `keywords`, and its prompt names what resets (modes, prompts, recording limits, silence auto-stop, hotkey).
    - Hotkey recorder: a button showing `formatChord(settings.hotkey)`; click arms it ("Press keys"); the next keydown with a valid `chordFromEvent` saves `settings.hotkey`; `Escape` cancels; an invalid chord shows "Use Ctrl, Alt or Cmd with a key".
- Spec 6.6 acceptance: every control persists on change and is reflected by the pill menu within one second (the SW broadcast from Task 4 carries it).
- Ledger: row 58 (popup persistence and dialogs), 151a-b smoke notes.

WRITER NOTES
- `initPopup` resolves to `{ settings, loaded }` (read-only getters). The contract leaves the return value open; the tests use it to observe the in-memory settings after a rollback.
- `form.js` also exports `MAX_KEYWORDS = 100` so the popup's "N of 100 terms" hint and `parseKeywords` share one limit.
- Clear sends `keys: { ..., openai: '' }` inside the full settings; it relies on Task 4 merging string keys (its test "SAVE_SETTINGS merges string keys, so the popup can clear one").
- The hotkey recorder cannot know which chords the browser reserves (`Ctrl+T`, `Ctrl+W`); it saves them and pages never see them. The README and the Task 14 checklist say so; no code guard, since any list would be incomplete and OS specific.
- The recorder listens on its own button (focus stays there while armed), so no document-level listener survives a popup re-init.
- Escape while armed calls `preventDefault()`, which is what keeps a Chrome popup open; jsdom cannot show that, so the Task 14 checklist verifies it in Chrome.

- [ ] **Step 1: Write the failing form helper tests**

`test/unit/popup/form.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SPOKEN_LANGUAGES, MAX_KEYWORDS, parseKeywords, formatKeywords, toggleLanguage, createInlineConfirm,
} from '../../../src/popup/form.js';

afterEach(() => { vi.useRealTimers(); });

describe('SPOKEN_LANGUAGES', () => {
  it('lists the seven spoken-language hints in order', () => {
    expect(SPOKEN_LANGUAGES.map((l) => l.code)).toEqual(['en', 'el', 'es', 'fr', 'de', 'it', 'pt']);
    expect(SPOKEN_LANGUAGES.map((l) => l.label)).toEqual(['English', 'Greek', 'Spanish', 'French', 'German', 'Italian', 'Portuguese']);
  });
  it('is frozen', () => {
    expect(Object.isFrozen(SPOKEN_LANGUAGES)).toBe(true);
    expect(Object.isFrozen(SPOKEN_LANGUAGES[0])).toBe(true);
  });
});

describe('parseKeywords', () => {
  it('keeps one trimmed term per line and drops empty lines', () => {
    expect(parseKeywords('  Palowise \n\n Kubernetes\r\n\t\nK. S. Karakostas  ')).toEqual(['Palowise', 'Kubernetes', 'K. S. Karakostas']);
  });
  it('drops case-insensitive duplicates and keeps the first spelling', () => {
    expect(parseKeywords('OpenAI\nopenai\nOPENAI\nGemini')).toEqual(['OpenAI', 'Gemini']);
  });
  it('keeps at most 100 terms', () => {
    const text = Array.from({ length: 130 }, (_, i) => `term${i}`).join('\n');
    const out = parseKeywords(text);
    expect(MAX_KEYWORDS).toBe(100);
    expect(out).toHaveLength(100);
    expect(out[99]).toBe('term99');
  });
  it('returns an empty list for blank or non-string input', () => {
    expect(parseKeywords('')).toEqual([]);
    expect(parseKeywords(' \n \n')).toEqual([]);
    expect(parseKeywords(undefined)).toEqual([]);
  });
});

describe('formatKeywords', () => {
  it('joins terms with newlines', () => {
    expect(formatKeywords(['a', 'b c'])).toBe('a\nb c');
    expect(formatKeywords([])).toBe('');
  });
  it('round-trips through parseKeywords', () => {
    const list = ['Palowise', 'Commetric'];
    expect(parseKeywords(formatKeywords(list))).toEqual(list);
  });
});

describe('toggleLanguage', () => {
  it('checking Auto returns an empty list', () => {
    expect(toggleLanguage(['en', 'el'], 'auto', true)).toEqual([]);
  });
  it('unchecking Auto leaves the list as it was', () => {
    expect(toggleLanguage([], 'auto', false)).toEqual([]);
    expect(toggleLanguage(['el'], 'auto', false)).toEqual(['el']);
  });
  it('adds a language in SPOKEN_LANGUAGES order', () => {
    expect(toggleLanguage(['de'], 'en', true)).toEqual(['en', 'de']);
    expect(toggleLanguage(['en', 'de'], 'el', true)).toEqual(['en', 'el', 'de']);
  });
  it('removes a language and never duplicates one', () => {
    expect(toggleLanguage(['en', 'el'], 'en', false)).toEqual(['el']);
    expect(toggleLanguage(['en'], 'en', true)).toEqual(['en']);
  });
  it('ignores unknown codes and does not mutate the input', () => {
    const list = ['en'];
    expect(toggleLanguage(list, 'xx', true)).toEqual(['en']);
    toggleLanguage(list, 'el', true);
    expect(list).toEqual(['en']);
  });
});

describe('createInlineConfirm', () => {
  function setup(options = {}) {
    vi.useFakeTimers();
    document.body.innerHTML = '<button type="button" id="b">Clear history</button>';
    const button = document.getElementById('b');
    const onConfirm = vi.fn();
    createInlineConfirm(button, { onConfirm, setTimeout, clearTimeout, ...options });
    return { button, onConfirm };
  }

  it('first click swaps the label to the prompt without confirming', () => {
    const { button, onConfirm } = setup();
    button.click();
    expect(button.textContent).toBe('Click again to confirm');
    expect(button.dataset.confirming).toBe('true');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('a second click within the window confirms once and restores the label', () => {
    const { button, onConfirm } = setup({ prompt: 'Click again to clear usage history' });
    button.click();
    expect(button.textContent).toBe('Click again to clear usage history');
    vi.advanceTimersByTime(2999);
    button.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(button.textContent).toBe('Clear history');
    expect(button.dataset.confirming).toBeUndefined();
  });

  it('the label reverts after the window and the next click starts over', () => {
    const { button, onConfirm } = setup({ ms: 1000 });
    button.click();
    vi.advanceTimersByTime(1000);
    expect(button.textContent).toBe('Clear history');
    button.click();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(button.textContent).toBe('Click again to confirm');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/popup/form.test.js
```

Expected: FAIL with `Failed to resolve import "../../../src/popup/form.js"`.

- [ ] **Step 3: Create `src/popup/form.js`**

```js
// Pure popup form helpers. No chrome APIs, so every function is testable in isolation.

/** Spoken-language hints offered in the popup. `languages: []` in settings means Auto. */
export const SPOKEN_LANGUAGES = Object.freeze([
  { code: 'en', label: 'English' },
  { code: 'el', label: 'Greek' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
].map((entry) => Object.freeze(entry)));

export const MAX_KEYWORDS = 100;

/**
 * Vocabulary textarea to `keywords`: one term per line, trimmed, empty lines dropped,
 * case-insensitive duplicates dropped (first spelling kept), at most MAX_KEYWORDS terms.
 * @param {string} text
 * @returns {string[]}
 */
export function parseKeywords(text) {
  const seen = new Set();
  const terms = [];
  for (const line of String(text ?? '').split(/\r\n|\r|\n/)) {
    const term = line.trim();
    const folded = term.toLowerCase();
    if (!term || seen.has(folded)) continue;
    seen.add(folded);
    terms.push(term);
    if (terms.length === MAX_KEYWORDS) break;
  }
  return terms;
}

/**
 * @param {string[]} list
 * @returns {string}
 */
export function formatKeywords(list) {
  return list.join('\n');
}

/**
 * Apply one checkbox change to the spoken-language list. Checking 'auto' clears the list;
 * any other code is added or removed and the result follows SPOKEN_LANGUAGES order.
 * @param {string[]} list
 * @param {string} code
 * @param {boolean} checked
 * @returns {string[]}
 */
export function toggleLanguage(list, code, checked) {
  if (code === 'auto') return checked ? [] : [...list];
  const chosen = new Set(list);
  if (checked) chosen.add(code); else chosen.delete(code);
  return SPOKEN_LANGUAGES.map((l) => l.code).filter((c) => chosen.has(c));
}

/**
 * Two-click confirmation on a button, replacing window.confirm() (which can dismiss the popup).
 * The first click swaps the label to `prompt`; a second click within `ms` calls `onConfirm`;
 * otherwise the label reverts.
 * @param {HTMLButtonElement} button
 * @param {{ prompt?: string, ms?: number, onConfirm: () => unknown,
 *           setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} options
 */
export function createInlineConfirm(button, {
  prompt = 'Click again to confirm', ms = 3000, onConfirm, setTimeout: setTimer, clearTimeout: clearTimer,
}) {
  const label = button.textContent;
  let armed = false;
  let timer;

  const disarm = () => {
    armed = false;
    clearTimer(timer);
    button.textContent = label;
    delete button.dataset.confirming;
  };

  button.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      button.textContent = prompt;
      button.dataset.confirming = 'true';
      timer = setTimer(disarm, ms);
      return;
    }
    disarm();
    onConfirm();
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/unit/popup/form.test.js
```

Expected: 1 file, 16 tests passed.

- [ ] **Step 5: Write the failing popup tests**

The harness loads the body of `src/popup/popup.html` into jsdom, passes a fake `chrome` (`runtime.sendMessage` answers from per-action queues filled by `script(action, ...responses)`, else a success default; `runtime.getManifest`; `tabs.create`) and awaits `initPopup`. Ledger row 58 maps to: "failed save reverts the control and in-memory value", "paste then blur saves the key", "a key also saves 800 ms after the last input", "shows a persistent banner and disables saving", "a later toast does not remove the banner", "Clear history needs two clicks", "Clear history toasts success only on { success: true }", "reset keeps keys, provider, languages and keywords". The spec 6.6 layout rules are pinned from the stylesheet itself ("contrast tokens meet 4.5:1 in light and dark", "uses no font size under 12 px", "draws visible focus rings and follows the dark scheme") and the markup ("popup.html carries no emoji and no inline handlers").

`test/unit/popup/popup.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initPopup } from '../../../src/popup/popup.js';
import { parseKeywords } from '../../../src/popup/form.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings, AUTO_STOP_CHOICES } from '../../../src/shared/defaults.js';
import { formatChord } from '../../../src/shared/chord.js';

// jsdom replaces the global URL, so resolve paths with node:path rather than new URL().
const POPUP_DIR = join(import.meta.dirname, '../../../src/popup');
const HTML = readFileSync(join(POPUP_DIR, 'popup.html'), 'utf8');
const CSS = readFileSync(join(POPUP_DIR, 'popup.css'), 'utf8');
const LOAD_ERROR = 'Could not load settings. Close and reopen the popup.';

function bucket(sessions, audioSeconds, cost) {
  return {
    sessions, audioSeconds, estimatedCost: cost, modes: {},
    byProvider: { openai: { sessions, audioSeconds, cost }, gemini: { sessions: 0, audioSeconds: 0, cost: 0 } },
  };
}
const USAGE = { today: bucket(1, 30, 0.002), last7Days: bucket(3, 95, 0.02), total: bucket(12, 610, 0.21) };

function storedSettings(keys = {}) {
  const s = freshSettings();
  s.keys = { openai: 'sk-proj-abcdefgh1234', gemini: '', ...keys };
  return s;
}

/**
 * Fake chrome for the popup. `script(action, ...responses)` queues one-shot answers;
 * without a queued answer each action gets a success default.
 */
function fakeChrome(stored = storedSettings()) {
  const queues = new Map();
  const sent = [];
  const defaults = {
    [MSG.GET_SETTINGS]: () => structuredClone(stored),
    [MSG.SAVE_SETTINGS]: () => ({ success: true }),
    [MSG.GET_USAGE]: () => structuredClone(USAGE),
    [MSG.CLEAR_USAGE]: () => ({ success: true }),
    [MSG.VALIDATE_KEY]: () => ({ ok: true }),
  };
  return {
    sent,
    saves: () => sent.filter((m) => m.action === MSG.SAVE_SETTINGS).map((m) => m.settings),
    count: (action) => sent.filter((m) => m.action === action).length,
    script(action, ...responses) { queues.set(action, [...(queues.get(action) || []), ...responses]); },
    runtime: {
      sendMessage: vi.fn(async (message) => {
        sent.push(structuredClone(message));
        const queue = queues.get(message.action);
        if (queue?.length) return queue.shift();
        return defaults[message.action]?.(message);
      }),
      getManifest: () => ({ version: '2.1.0' }),
    },
    tabs: { create: vi.fn(async () => ({})) },
  };
}

const $ = (id) => document.getElementById(id);
const flush = () => (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(0) : new Promise((r) => setTimeout(r, 0)));
const start = (chrome) => initPopup({ chrome, document, window });

function change(el, value) {
  if (value !== undefined) el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function typeInto(el, value) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function keydown(target, init) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('popup layout', () => {
  it('renders the sections in spec order with the version', async () => {
    await start(fakeChrome());
    const titles = [...document.querySelectorAll('main > section h2')].map((h) => h.textContent.trim());
    expect(titles).toEqual(['Provider', 'Recording', 'Speech', 'Modes', 'Usage', 'About']);
    expect($('version').textContent).toBe('Version 2.1.0');
    expect($('status-text').textContent).toBe('Ready');
    expect($('banner').hidden).toBe(true);
  });

  it('fills the usage table per period and per provider', async () => {
    await start(fakeChrome());
    expect($('usage-today-sessions').textContent).toBe('1');
    expect($('usage-today-audio').textContent).toBe('0:30');
    expect($('usage-week-cost').textContent).toBe('$0.02');
    expect($('usage-total-audio').textContent).toBe('10:10');
    expect($('usage-total-cost').textContent).toBe('$0.21');
    expect($('usage-openai-sessions').textContent).toBe('12');
    expect($('usage-gemini-cost').textContent).toBe('$0.00');
  });

  it('opens the About links in a new tab', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    const github = document.querySelector('a[href="https://github.com/kskarakostas/VoiceType"]');
    github.click();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://github.com/kskarakostas/VoiceType' });
    expect(document.querySelector('a[href$="/PRIVACY.md"]')).not.toBeNull();
  });
});

describe('popup autosave', () => {
  it('failed save reverts the control and in-memory value', async () => {
    const chrome = fakeChrome();
    chrome.script(MSG.SAVE_SETTINGS, { success: false, error: 'Storage is full.' }, { success: false, error: 'Storage is full.' });
    const popup = await start(chrome);

    change($('max-time'), '300');
    expect(popup.settings.maxRecordingTime).toBe(300);
    await flush();
    expect($('max-time').value).toBe('120');
    expect(popup.settings.maxRecordingTime).toBe(120);
    expect($('toast').textContent).toBe('Storage is full.');
    expect($('toast').dataset.tone).toBe('error');

    const gemini = document.querySelector('input[name="provider"][value="gemini"]');
    gemini.checked = true;
    change(gemini);
    await flush();
    expect(document.querySelector('input[name="provider"]:checked').value).toBe('openai');
    expect(popup.settings.provider).toBe('openai');
    expect($('key-row-gemini').hidden).toBe(true);
  });

  it('switching provider saves and shows that key row', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    const gemini = document.querySelector('input[name="provider"][value="gemini"]');
    gemini.checked = true;
    change(gemini);
    await flush();
    expect(chrome.saves().at(-1).provider).toBe('gemini');
    expect($('key-row-gemini').hidden).toBe(false);
    expect($('key-row-openai').hidden).toBe(true);
    expect($('status-text').textContent).toBe('Add API key');
  });

  it('min and max recording save as numbers', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    change($('min-time'), '0.5');
    await flush();
    change($('max-time'), '60');
    await flush();
    expect(chrome.saves().at(-1)).toMatchObject({ minRecordingTime: 0.5, maxRecordingTime: 60 });
  });

  it('silence auto-stop saves numbers from AUTO_STOP_CHOICES', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    const select = $('auto-stop');
    expect([...select.options].map((o) => o.value)).toEqual(AUTO_STOP_CHOICES.map(String));
    expect([...select.options].map((o) => o.textContent)).toEqual(['Off', '2 s', '3 s', '5 s']);
    expect(select.value).toBe('0');
    for (const seconds of AUTO_STOP_CHOICES.slice(1)) {
      change(select, String(seconds));
      await flush();
      expect(chrome.saves().at(-1).autoStopSilenceSec).toBe(seconds);
    }
  });
});

describe('popup keys', () => {
  it('paste then blur saves the key', async () => {
    const chrome = fakeChrome(storedSettings({ openai: '' }));
    const popup = await start(chrome);
    expect($('status-text').textContent).toBe('Add API key');
    const input = $('key-openai');
    input.focus();
    typeInto(input, '  sk-proj-new-key-5678  ');
    input.blur();
    await flush();
    expect(chrome.saves()).toHaveLength(1);
    expect(chrome.saves()[0].keys.openai).toBe('sk-proj-new-key-5678');
    expect(popup.settings.keys.openai).toBe('sk-proj-new-key-5678');
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('sk-p…5678 (saved)');
    expect($('toast').textContent).toBe('Key saved');
    expect($('status-text').textContent).toBe('Ready');
  });

  it('a key also saves 800 ms after the last input', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome(storedSettings({ openai: '' }));
    await start(chrome);
    const input = $('key-openai');
    input.focus();
    typeInto(input, 'sk-proj-typed');
    await vi.advanceTimersByTimeAsync(500);
    typeInto(input, 'sk-proj-typed-9999');
    await vi.advanceTimersByTimeAsync(799);
    expect(chrome.saves()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(chrome.saves()).toHaveLength(1);
    expect(chrome.saves()[0].keys.openai).toBe('sk-proj-typed-9999');
    expect(input.value).toBe('sk-proj-typed-9999');
    input.blur();
    await flush();
    expect(chrome.saves()).toHaveLength(1);
    expect(input.value).toBe('');
  });

  it('Clear empties the key and Test validates the typed key', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    typeInto($('key-openai'), 'sk-proj-candidate');
    $('test-openai').click();
    await flush();
    expect(chrome.sent.find((m) => m.action === MSG.VALIDATE_KEY)).toEqual({ action: MSG.VALIDATE_KEY, provider: 'openai', key: 'sk-proj-candidate' });
    expect($('toast').textContent).toBe('OpenAI key works');
    $('clear-openai').click();
    await flush();
    expect(chrome.saves().at(-1).keys.openai).toBe('');
    expect($('key-openai').placeholder).toBe('sk-...');
    expect($('status-text').textContent).toBe('Add API key');
  });
});

describe('popup load failure', () => {
  it('shows a persistent banner and disables saving', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome();
    chrome.script(MSG.GET_SETTINGS, null);
    const popup = await start(chrome);
    expect(popup.loaded).toBe(false);
    expect($('banner').hidden).toBe(false);
    expect($('banner-text').textContent).toBe(LOAD_ERROR);

    change($('max-time'), '300');
    await flush();
    expect(chrome.saves()).toHaveLength(0);
    expect($('max-time').value).toBe('120');
    expect($('toast').hidden).toBe(false);
    expect($('toast').textContent).toBe('Settings are not loaded. Nothing was saved.');

    await vi.advanceTimersByTimeAsync(10_000);
    expect($('toast').hidden).toBe(true);
    expect($('banner').hidden).toBe(false);
    expect($('banner-text').textContent).toBe(LOAD_ERROR);
  });

  it('a later toast does not remove the banner', async () => {
    const chrome = fakeChrome();
    chrome.script(MSG.GET_SETTINGS, undefined);
    await start(chrome);
    typeInto($('key-openai'), 'sk-proj-candidate');
    $('test-openai').click();
    await flush();
    expect($('toast').textContent).toBe('OpenAI key works');
    expect($('banner').hidden).toBe(false);
    expect($('banner-text').textContent).toBe(LOAD_ERROR);
  });
});

describe('popup inline confirms', () => {
  it('Clear history needs two clicks', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    const button = $('clear-usage');
    button.click();
    await flush();
    expect(chrome.count(MSG.CLEAR_USAGE)).toBe(0);
    expect(button.textContent).toBe('Click again to clear usage history');
    button.click();
    await flush();
    expect(chrome.count(MSG.CLEAR_USAGE)).toBe(1);
    expect(chrome.count(MSG.GET_USAGE)).toBe(2);
    expect($('toast').textContent).toBe('Usage history cleared');
    expect(button.textContent).toBe('Clear history');
  });

  it('Clear history toasts success only on { success: true }', async () => {
    const chrome = fakeChrome();
    chrome.script(MSG.CLEAR_USAGE, { success: false }, undefined);
    await start(chrome);
    const button = $('clear-usage');
    button.click();
    button.click();
    await flush();
    expect($('toast').textContent).toBe('Could not clear usage history.');
    expect($('toast').dataset.tone).toBe('error');
    button.click();
    button.click();
    await flush();
    expect($('toast').textContent).toBe('Could not clear usage history.');
    expect(chrome.count(MSG.GET_USAGE)).toBe(1);
  });

  it('reset keeps keys, provider, languages and keywords', async () => {
    const stored = storedSettings({ gemini: 'AQ.gemini-key-0001' });
    Object.assign(stored, {
      provider: 'gemini', languages: ['en', 'el'], keywords: ['Palowise'], maxRecordingTime: 300, autoStopSilenceSec: 3,
      hotkey: { code: 'KeyD', ctrl: false, shift: false, alt: true, meta: false }, activeMode: 'custom_1',
    });
    stored.modes.custom_1 = { name: 'Notes', icon: 'N', prompt: 'Bullet notes.', builtIn: false };
    stored.modes.email.prompt = 'My own email prompt';
    const chrome = fakeChrome(stored);
    await start(chrome);

    const button = $('reset');
    button.click();
    expect(button.textContent).toBe('Click again to reset modes, prompts, recording limits, silence auto-stop and hotkey');
    expect(chrome.saves()).toHaveLength(0);
    button.click();
    await flush();
    expect(chrome.saves().at(-1)).toEqual({
      ...freshSettings(),
      keys: { openai: 'sk-proj-abcdefgh1234', gemini: 'AQ.gemini-key-0001' },
      provider: 'gemini', languages: ['en', 'el'], keywords: ['Palowise'],
    });
    expect($('max-time').value).toBe('120');
    expect($('hotkey').textContent).toBe(formatChord(freshSettings().hotkey));
    expect($('toast').textContent).toBe('Settings reset');
  });
});

describe('popup hotkey recorder', () => {
  it('saves a valid chord', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    const button = $('hotkey');
    expect(button.textContent).toBe(formatChord(freshSettings().hotkey));
    button.click();
    expect(button.textContent).toBe('Press keys');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(keydown(button, { code: 'ControlLeft', key: 'Control', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(keydown(button, { code: 'AltLeft', key: 'Alt', ctrlKey: true, altKey: true }).defaultPrevented).toBe(true);
    expect($('hotkey-hint').textContent).toBe('Press the new hotkey. Esc cancels.');
    expect(chrome.saves()).toHaveLength(0);
    keydown(button, { code: 'KeyD', key: 'd', ctrlKey: true, altKey: true });
    await flush();
    const chord = { code: 'KeyD', ctrl: true, shift: false, alt: true, meta: false };
    expect(chrome.saves().at(-1).hotkey).toEqual(chord);
    expect(button.textContent).toBe(formatChord(chord));
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('rejects Shift+Space with the hint', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    const button = $('hotkey');
    button.click();
    keydown(button, { code: 'ShiftLeft', key: 'Shift', shiftKey: true });
    keydown(button, { code: 'Space', key: ' ', shiftKey: true });
    await flush();
    expect($('hotkey-hint').textContent).toBe('Use Ctrl, Alt or Cmd with a key');
    expect(chrome.saves()).toHaveLength(0);
    expect(button.textContent).toBe('Press keys');
  });

  it('Escape cancels', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    const button = $('hotkey');
    button.click();
    expect(keydown(button, { code: 'Escape', key: 'Escape' }).defaultPrevented).toBe(true);
    expect(button.textContent).toBe(formatChord(freshSettings().hotkey));
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect($('hotkey-hint').textContent).toBe('Tap to toggle, hold to talk.');
    keydown(button, { code: 'KeyK', key: 'k', ctrlKey: true });
    await flush();
    expect(chrome.saves()).toHaveLength(0);
  });
});

describe('popup speech', () => {
  it('languages Auto clears the list', async () => {
    const stored = storedSettings();
    stored.languages = ['en', 'el'];
    const chrome = fakeChrome(stored);
    await start(chrome);
    const auto = $('lang-auto');
    expect(auto.checked).toBe(false);
    expect($('lang-en').checked).toBe(true);
    auto.checked = true;
    change(auto);
    await flush();
    expect(chrome.saves().at(-1).languages).toEqual([]);
    expect($('lang-en').checked).toBe(false);
    expect($('lang-el').checked).toBe(false);

    const german = $('lang-de');
    german.checked = true;
    change(german);
    await flush();
    expect(chrome.saves().at(-1).languages).toEqual(['de']);
    expect(auto.checked).toBe(false);
  });

  it('vocabulary textarea saves parseKeywords output', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    const area = $('keywords');
    const text = ' Palowise \n\npalowise\nCommetric\n';
    area.focus();
    area.value = text;
    change(area);
    area.blur();
    await flush();
    expect(chrome.saves().at(-1).keywords).toEqual(parseKeywords(text));
    expect(area.value).toBe('Palowise\nCommetric');
    expect($('keyword-count').textContent).toBe('2 of 100 terms');
  });
});

describe('popup modes', () => {
  it('mode names and icons render as text', async () => {
    const stored = storedSettings();
    stored.modes.custom_x = { name: '<img src=x onerror=alert(1)>', icon: '<b>', prompt: '', builtIn: false };
    await start(fakeChrome(stored));
    expect(document.querySelector('#mode-list img, #mode-list b')).toBeNull();
    expect($('mode-list').textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('choosing a mode saves activeMode', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    const email = document.querySelector('[data-focus-key="select:email"]');
    email.click();
    await flush();
    expect(chrome.saves().at(-1).activeMode).toBe('email');
    expect(document.querySelector('[data-focus-key="select:email"]').getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-focus-key="select:default"]').getAttribute('aria-pressed')).toBe('false');
  });

  it('the editor creates and deletes a custom mode', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    $('add-mode').click();
    expect($('mode-editor').hidden).toBe(false);
    expect($('delete-mode').hidden).toBe(true);
    $('mode-name').value = 'Notes';
    $('mode-icon').value = 'N';
    $('mode-prompt').value = 'Turn this into bullet notes.';
    $('save-mode').click();
    await flush();
    const modes = chrome.saves().at(-1).modes;
    const key = Object.keys(modes).find((k) => k.startsWith('custom_'));
    expect(modes[key]).toEqual({ name: 'Notes', icon: 'N', prompt: 'Turn this into bullet notes.', builtIn: false });
    expect($('mode-editor').hidden).toBe(true);

    document.querySelector(`[data-focus-key="edit:${key}"]`).click();
    expect($('delete-mode').hidden).toBe(false);
    $('delete-mode').click();
    await flush();
    expect(Object.hasOwn(chrome.saves().at(-1).modes, key)).toBe(false);
  });

  it('built-in modes have no delete button', async () => {
    await start(fakeChrome());
    document.querySelector('[data-focus-key="edit:email"]').click();
    expect($('mode-editor').hidden).toBe(false);
    expect($('delete-mode').hidden).toBe(true);
    expect($('mode-name').value).toBe('Email');
  });
});

describe('popup stylesheet and markup', () => {
  function tokens(block) {
    return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]));
  }
  function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }
  const PAIRS = [
    ['text', 'bg'], ['text', 'surface'], ['text', 'surface-2'], ['text', 'accent-soft'],
    ['text-2', 'surface'], ['text-2', 'surface-2'],
    ['muted', 'bg'], ['muted', 'surface'], ['muted', 'surface-2'], ['muted', 'accent-soft'],
    ['accent', 'surface'], ['accent', 'accent-soft'], ['on-accent', 'accent'], ['on-accent', 'accent-hover'],
    ['danger', 'surface'], ['danger', 'danger-soft'], ['on-accent', 'danger'],
    ['success', 'surface'], ['on-accent', 'success'], ['warning', 'surface'], ['surface', 'text'],
  ];

  it('contrast tokens meet 4.5:1 in light and dark', () => {
    const light = tokens(CSS.slice(CSS.indexOf(':root {'), CSS.indexOf('}', CSS.indexOf(':root {'))));
    const darkStart = CSS.indexOf('@media (prefers-color-scheme: dark)');
    const dark = { ...light, ...tokens(CSS.slice(darkStart, CSS.indexOf('}', darkStart))) };
    expect(darkStart).toBeGreaterThan(0);
    for (const [scheme, t] of [['light', light], ['dark', dark]]) {
      for (const [fg, bg] of PAIRS) {
        expect(t[fg], `${scheme} --${fg}`).toBeDefined();
        expect(t[bg], `${scheme} --${bg}`).toBeDefined();
        expect(contrast(t[fg], t[bg]), `${scheme} --${fg} on --${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('uses no font size under 12 px', () => {
    const sizes = [...CSS.matchAll(/font(?:-size)?:\s*([^;]+);/g)].flatMap((m) => [...m[1].matchAll(/([\d.]+)px/g)].map((n) => Number(n[1])));
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(12);
    expect(CSS).not.toMatch(/font(?:-size)?:[^;]*\d(?:em|rem|pt)\b/);
  });

  it('draws visible focus rings and follows the dark scheme', () => {
    expect(CSS).toMatch(/:focus-visible\s*{[^}]*outline:\s*2px solid var\(--focus\)/);
    expect(CSS).toContain('@media (prefers-color-scheme: dark)');
  });

  it('popup.html carries no emoji and no inline handlers', () => {
    expect(HTML).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(HTML).not.toMatch(/\son[a-z]+=/i);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

```bash
npx vitest run test/unit/popup/popup.test.js
```

Expected: 28 failed. 24 fail with `TypeError: initPopup is not a function` (the v2.0 `popup.js` exports nothing); the other 4 are the stylesheet and markup checks ("contrast tokens meet 4.5:1 in light and dark" finds no `--surface` token, "uses no font size under 12 px" finds 9, 10 and 11 px, "draws visible focus rings and follows the dark scheme" finds no `:focus-visible` rule, "popup.html carries no emoji and no inline handlers" finds the header emoji).

- [ ] **Step 7: Rewrite `src/popup/popup.html`**

Replace the whole file with:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="color-scheme" content="light dark">
  <title>VoiceType</title>
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M19 11a7 7 0 0 1-14 0"/><path d="M12 18v3"/></svg>
      </span>
      <div>
        <h1>VoiceType</h1>
        <p class="tagline">BYOK dictation</p>
      </div>
    </div>
    <p class="status" id="status" data-ready="false"><span class="status-dot" aria-hidden="true"></span><span id="status-text">Add API key</span></p>
  </header>

  <div class="banner" id="banner" role="alert" hidden>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>
    <p id="banner-text"></p>
  </div>

  <main>
    <section class="card" aria-labelledby="h-provider">
      <h2 id="h-provider"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.2-8.2"/><path d="m17 6 2 2"/><path d="m14 9 2 2"/></svg>Provider</h2>
      <div class="segmented" role="radiogroup" aria-labelledby="h-provider">
        <label class="segment"><input type="radio" name="provider" value="openai"><span>OpenAI</span></label>
        <label class="segment"><input type="radio" name="provider" value="gemini"><span>Gemini</span></label>
      </div>
      <div class="key-row" id="key-row-openai">
        <label class="field-label" for="key-openai">OpenAI API key</label>
        <div class="key-controls">
          <input type="password" id="key-openai" class="key-input" autocomplete="new-password" spellcheck="false">
          <button type="button" class="btn" id="test-openai">Test</button>
          <button type="button" class="btn btn-quiet" id="clear-openai">Clear</button>
        </div>
      </div>
      <div class="key-row" id="key-row-gemini" hidden>
        <label class="field-label" for="key-gemini">Gemini API key</label>
        <div class="key-controls">
          <input type="password" id="key-gemini" class="key-input" autocomplete="new-password" spellcheck="false">
          <button type="button" class="btn" id="test-gemini">Test</button>
          <button type="button" class="btn btn-quiet" id="clear-gemini">Clear</button>
        </div>
      </div>
      <p class="hint hint-warning" id="spend-hint" hidden>Set a spending limit on your provider account.</p>
    </section>

    <section class="card" aria-labelledby="h-recording">
      <h2 id="h-recording"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M9 2h6"/></svg>Recording</h2>
      <div class="grid-2">
        <div class="field">
          <label class="field-label" for="min-time">Minimum length</label>
          <select id="min-time">
            <option value="0.5">0.5 s</option>
            <option value="1">1 s</option>
            <option value="2">2 s</option>
            <option value="3">3 s</option>
          </select>
        </div>
        <div class="field">
          <label class="field-label" for="max-time">Maximum length</label>
          <select id="max-time">
            <option value="30">30 s</option>
            <option value="60">1 min</option>
            <option value="120">2 min</option>
            <option value="180">3 min</option>
            <option value="300">5 min</option>
          </select>
        </div>
        <div class="field">
          <label class="field-label" for="auto-stop">Silence auto-stop</label>
          <select id="auto-stop"></select>
        </div>
        <div class="field">
          <label class="field-label" for="hotkey">Hotkey</label>
          <button type="button" class="hotkey" id="hotkey" aria-pressed="false" aria-describedby="hotkey-hint"></button>
        </div>
      </div>
      <p class="hint" id="hotkey-hint" aria-live="polite">Tap to toggle, hold to talk.</p>
    </section>

    <section class="card" aria-labelledby="h-speech">
      <h2 id="h-speech"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z"/></svg>Speech</h2>
      <fieldset class="languages">
        <legend class="field-label">Spoken languages</legend>
        <div class="check-grid" id="languages"></div>
      </fieldset>
      <p class="hint">Auto detects the language. Pick languages to steer recognition.</p>
      <div class="field field-spaced">
        <label class="field-label" for="keywords">Vocabulary</label>
        <textarea id="keywords" rows="4" spellcheck="false" placeholder="One term per line: names, jargon, product names" aria-describedby="keyword-count"></textarea>
        <p class="hint" id="keyword-count">0 of 100 terms</p>
      </div>
    </section>

    <section class="card" aria-labelledby="h-modes">
      <div class="card-head">
        <h2 id="h-modes"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/></svg>Modes</h2>
        <button type="button" class="btn btn-quiet" id="add-mode"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>Add mode</button>
      </div>
      <ul class="mode-list" id="mode-list" aria-labelledby="h-modes"></ul>
      <div class="editor" id="mode-editor" hidden>
        <h3 id="editor-title">Edit mode</h3>
        <div class="editor-row">
          <div class="field">
            <label class="field-label" for="mode-icon">Icon</label>
            <input type="text" id="mode-icon" maxlength="8" placeholder="Emoji">
          </div>
          <div class="field">
            <label class="field-label" for="mode-name">Name</label>
            <input type="text" id="mode-name" maxlength="40" placeholder="Meeting notes">
          </div>
        </div>
        <div class="field">
          <label class="field-label" for="mode-prompt">Instructions for the text model</label>
          <textarea id="mode-prompt" rows="5" placeholder="Leave empty for raw transcription."></textarea>
          <p class="hint">Applied to the transcript after speech recognition. Empty means the transcript is inserted as is.</p>
        </div>
        <div class="editor-actions">
          <button type="button" class="btn btn-danger" id="delete-mode" hidden>Delete</button>
          <button type="button" class="btn btn-quiet" id="cancel-mode">Cancel</button>
          <button type="button" class="btn btn-primary" id="save-mode">Save mode</button>
        </div>
      </div>
    </section>

    <section class="card" aria-labelledby="h-usage">
      <div class="card-head">
        <h2 id="h-usage"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V11"/><path d="M10 20V5"/><path d="M16 20v-6"/><path d="M21 20H3"/></svg>Usage</h2>
        <button type="button" class="btn btn-quiet" id="refresh-usage"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>Refresh</button>
      </div>
      <table class="usage">
        <thead>
          <tr><td></td><th scope="col">Sessions</th><th scope="col">Audio</th><th scope="col">Cost</th></tr>
        </thead>
        <tbody>
          <tr><th scope="row">Today</th><td id="usage-today-sessions">0</td><td id="usage-today-audio">0:00</td><td id="usage-today-cost">$0.00</td></tr>
          <tr><th scope="row">7 days</th><td id="usage-week-sessions">0</td><td id="usage-week-audio">0:00</td><td id="usage-week-cost">$0.00</td></tr>
          <tr class="total"><th scope="row">All time</th><td id="usage-total-sessions">0</td><td id="usage-total-audio">0:00</td><td id="usage-total-cost">$0.00</td></tr>
        </tbody>
        <tbody class="by-provider">
          <tr><th scope="row">OpenAI</th><td id="usage-openai-sessions">0</td><td id="usage-openai-audio">0:00</td><td id="usage-openai-cost">$0.00</td></tr>
          <tr><th scope="row">Gemini</th><td id="usage-gemini-sessions">0</td><td id="usage-gemini-audio">0:00</td><td id="usage-gemini-cost">$0.00</td></tr>
        </tbody>
      </table>
      <p class="hint">Estimates from list prices. Provider rows cover all time. Check your provider dashboard for billing.</p>
      <div class="card-actions">
        <button type="button" class="btn btn-danger" id="clear-usage">Clear history</button>
      </div>
    </section>

    <section class="card" aria-labelledby="h-about">
      <h2 id="h-about"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>About</h2>
      <p class="about-line"><span id="version">Version</span><span aria-hidden="true"> · </span><span>by K. S. Karakostas</span></p>
      <p class="links">
        <a href="https://github.com/kskarakostas/VoiceType" data-external>GitHub</a>
        <a href="https://github.com/kskarakostas/VoiceType/blob/main/PRIVACY.md" data-external>Privacy</a>
      </p>
      <button type="button" class="btn btn-danger btn-block" id="reset">Reset to defaults</button>
      <p class="hint">Resets modes, prompts, recording limits, silence auto-stop and the hotkey. Keeps your API keys, provider, spoken languages and vocabulary.</p>
    </section>
  </main>

  <p class="footnote">Changes save automatically.</p>
  <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
  <script src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 8: Rewrite `src/popup/popup.css`**

Replace the whole file with:

```css
/* VoiceType popup. Text tokens meet 4.5:1 in both schemes; popup.test.js pins the pairs. */

:root {
  color-scheme: light dark;
  --bg: #f4f5f7;
  --surface: #ffffff;
  --surface-2: #eef0f3;
  --border: #d0d5dd;
  --border-strong: #8c95a5;
  --text: #101828;
  --text-2: #344054;
  --muted: #475467;
  --accent: #4338ca;
  --accent-hover: #3730a3;
  --on-accent: #ffffff;
  --accent-soft: #eef0ff;
  --danger: #b42318;
  --danger-soft: #fef3f2;
  --success: #067647;
  --warning: #93370d;
  --focus: var(--accent);
  --shadow: 0 1px 2px rgb(16 24 40 / 0.08);
  --radius: 10px;
  --radius-sm: 7px;
  --font: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115;
    --surface: #171a21;
    --surface-2: #1f232c;
    --border: #2e3440;
    --border-strong: #5f6878;
    --text: #f2f4f7;
    --text-2: #d0d5dd;
    --muted: #a6afbd;
    --accent: #a4b0ff;
    --accent-hover: #c0c8ff;
    --on-accent: #0f1115;
    --accent-soft: #252a4a;
    --danger: #ff9b91;
    --danger-soft: #3a1714;
    --success: #6ce0a0;
    --warning: #fdc566;
    --shadow: 0 1px 2px rgb(0 0 0 / 0.4);
  }
}

*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }

body {
  width: 320px;
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}

button, input, select, textarea { font: inherit; color: inherit; }
h1, h2, h3, p { margin: 0; }

svg {
  width: 16px;
  height: 16px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

/* Header */

.topbar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.brand { display: flex; align-items: center; gap: 10px; }

.brand-mark {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: var(--accent);
  color: var(--on-accent);
}

.brand-mark svg { width: 18px; height: 18px; }
.brand h1 { font-size: 15px; font-weight: 700; letter-spacing: -0.01em; }
.tagline { font-size: 12px; color: var(--muted); }

.status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--danger); }
.status[data-ready="true"] .status-dot { background: var(--success); }

.banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 10px 12px 0;
  padding: 10px 12px;
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 12px;
  font-weight: 600;
}

/* Sections */

main { display: grid; gap: 10px; padding: 10px 12px 0; }

.card {
  padding: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.card h2 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.card h2 svg { width: 14px; height: 14px; color: var(--accent); }

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.card-head h2 { margin-bottom: 0; }
.card-actions { display: flex; justify-content: flex-end; margin-top: 10px; }

/* Fields */

.field { display: grid; gap: 4px; min-width: 0; }
.field-spaced { margin-top: 12px; }
.field-label { color: var(--text-2); font-size: 12px; font-weight: 600; }
.hint { margin-top: 6px; color: var(--muted); font-size: 12px; }
.hint[data-tone="error"] { color: var(--danger); font-weight: 600; }
.hint-warning { color: var(--warning); }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

input[type="text"],
input[type="password"],
select,
textarea {
  width: 100%;
  min-height: 32px;
  padding: 6px 9px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
  font-size: 13px;
}

input[type="text"]:focus-visible,
input[type="password"]:focus-visible,
select:focus-visible,
textarea:focus-visible {
  outline-offset: 0;
  border-color: var(--focus);
}

select { cursor: pointer; }
textarea { min-height: 72px; resize: vertical; line-height: 1.4; }
input::placeholder, textarea::placeholder { color: var(--muted); opacity: 1; }

/* Provider */

.segmented {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
  margin-bottom: 12px;
  padding: 3px;
  border-radius: 9px;
  background: var(--surface-2);
}

.segment { position: relative; }

.segment input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.segment span {
  display: block;
  padding: 6px 8px;
  border-radius: 7px;
  color: var(--text-2);
  font-size: 13px;
  font-weight: 600;
  text-align: center;
}

.segment input:checked + span {
  background: var(--surface);
  color: var(--accent);
  box-shadow: var(--shadow), 0 0 0 1px var(--border);
}

.segment input:focus-visible + span { outline: 2px solid var(--focus); outline-offset: 1px; }

.key-row { display: grid; gap: 4px; }
.key-controls { display: flex; gap: 6px; }
.key-input { flex: 1; min-width: 0; font-family: var(--mono); font-size: 12px; }

/* Buttons */

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.btn:hover { background: var(--surface-2); }
.btn:disabled { cursor: default; opacity: 0.6; }
.btn svg { width: 14px; height: 14px; }
.btn-quiet { border-color: transparent; background: transparent; color: var(--text-2); }
.btn-quiet:hover { background: var(--surface-2); color: var(--text); }
.btn-primary { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
.btn-primary:hover { border-color: var(--accent-hover); background: var(--accent-hover); }
.btn-danger { color: var(--danger); }
.btn-block { width: 100%; }

.btn-danger[data-confirming="true"] {
  padding-block: 6px;
  border-color: var(--danger);
  background: var(--danger);
  color: var(--on-accent);
  white-space: normal;
  text-align: center;
}

.hotkey {
  width: 100%;
  min-height: 32px;
  padding: 0 8px;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
  cursor: pointer;
}

.hotkey[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }

/* Speech */

.languages { min-width: 0; margin: 0; padding: 0; border: 0; }
.languages legend { margin-bottom: 6px; padding: 0; }
.check-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px 8px; }

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  font-size: 13px;
  cursor: pointer;
}

.check input { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }

/* Modes */

.mode-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.mode { display: flex; gap: 4px; }

.mode-select {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  text-align: left;
  cursor: pointer;
}

.mode-select:hover { background: var(--surface-2); }
.mode-select[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); }
.mode-icon { width: 22px; font-size: 16px; line-height: 1; text-align: center; }
.mode-text { flex: 1; display: grid; gap: 1px; min-width: 0; }
.mode-name { display: flex; align-items: center; gap: 6px; color: var(--text); font-size: 13px; font-weight: 600; }

.mode-badge {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
}

.mode-preview {
  overflow: hidden;
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.mode-check { color: var(--accent); }

.icon-btn {
  display: grid;
  place-items: center;
  width: 32px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}

.icon-btn:hover { background: var(--surface-2); color: var(--text); }

.editor {
  display: grid;
  gap: 10px;
  margin-top: 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}

.editor h3 { font-size: 13px; font-weight: 700; }
.editor-row { display: grid; grid-template-columns: 64px 1fr; gap: 8px; }
.editor-actions { display: flex; justify-content: flex-end; gap: 6px; }
.editor-actions .btn-danger { margin-right: auto; }

/* Usage */

.usage { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
.usage th, .usage td { padding: 6px 4px; text-align: right; }
.usage thead th { color: var(--muted); font-weight: 600; }
.usage tbody th { color: var(--text-2); font-weight: 600; text-align: left; }
.usage tbody tr + tr > * { border-top: 1px solid var(--border); }
.usage tr.total td { font-weight: 700; }
.usage .by-provider { border-top: 2px solid var(--border); }

/* About and footer */

.about-line { margin-bottom: 8px; color: var(--text-2); font-size: 12px; }
.links { display: flex; gap: 16px; margin-bottom: 12px; }
.links a { color: var(--accent); font-size: 13px; font-weight: 600; text-decoration: none; }
.links a:hover { text-decoration: underline; }
.footnote { margin: 10px 0 12px; color: var(--muted); font-size: 12px; text-align: center; }

/* Toast: independent of the banner, which stays until the popup is reopened. */

.toast {
  position: fixed;
  right: 12px;
  bottom: 12px;
  left: 12px;
  z-index: 3;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--text);
  color: var(--surface);
  font-size: 12px;
  font-weight: 600;
  box-shadow: 0 8px 24px rgb(16 24 40 / 0.24);
  animation: toast-in 160ms ease-out;
}

.toast[data-tone="success"] { background: var(--success); color: var(--on-accent); }
.toast[data-tone="error"] { background: var(--danger); color: var(--on-accent); }

@keyframes toast-in {
  from { opacity: 0; transform: translateY(6px); }
}

@media (prefers-reduced-motion: reduce) {
  .toast { animation: none; }
}
```

- [ ] **Step 9: Rewrite `src/popup/popup.js`**

Replace the whole file with:

```js
// VoiceType popup. A trusted extension page: it reads the full settings (keys included) and
// autosaves every change with SAVE_SETTINGS, rolling the change back when the save fails.
import { MSG } from '../shared/messages.js';
import { PROVIDERS } from '../shared/models.js';
import { formatCost } from '../shared/pricing.js';
import { freshSettings, AUTO_STOP_CHOICES } from '../shared/defaults.js';
import { formatChord, chordFromEvent } from '../shared/chord.js';
import {
  SPOKEN_LANGUAGES, MAX_KEYWORDS, parseKeywords, formatKeywords, toggleLanguage, createInlineConfirm,
} from './form.js';

// Typing pauses this long before a key or the vocabulary saves; blur and change save at once.
const TYPING_SAVE_MS = 800;
const LOAD_ERROR = 'Could not load settings. Close and reopen the popup.';
const NOT_LOADED = 'Settings are not loaded. Nothing was saved.';
const HOTKEY_IDLE_HINT = 'Tap to toggle, hold to talk.';
const HOTKEY_ARMED_HINT = 'Press the new hotkey. Esc cancels.';
const HOTKEY_INVALID_HINT = 'Use Ctrl, Alt or Cmd with a key';
const RESET_PROMPT = 'Click again to reset modes, prompts, recording limits, silence auto-stop and hotkey';
const DEFAULT_MODE_ICON = '🎯';
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'OS']);
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_PATHS = {
  edit: ['M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3Z', 'm13.5 8.5 3 3'],
  check: ['m5 12.5 4.5 4.5L19 7.5'],
};

/** Seconds as m:ss, or h:mm:ss from one hour up. */
function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(Math.floor(seconds % 60)).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function maskKey(key) {
  return key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)} (saved)` : 'Key saved';
}

function isSettings(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Boolean(value.modes) && typeof value.modes === 'object' && !Array.isArray(value.modes)
    && Boolean(value.keys) && typeof value.keys === 'object';
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Wire the popup markup, load settings and usage, and autosave every control.
 * @param {{ chrome: typeof globalThis.chrome, document: Document, window: Window }} env
 * @returns {Promise<{ readonly settings: import('../shared/defaults.js').Settings, readonly loaded: boolean }>}
 */
export async function initPopup({ chrome, document, window }) {
  const $ = (id) => document.getElementById(id);
  const setTimer = (fn, ms) => window.setTimeout(fn, ms);
  const clearTimer = (id) => window.clearTimeout(id);
  const nav = window.navigator;
  const mac = /mac/i.test(nav?.userAgentData?.platform || nav?.platform || '');
  const providerIds = Object.keys(PROVIDERS);

  const el = {
    status: $('status'), statusText: $('status-text'), banner: $('banner'), bannerText: $('banner-text'),
    providerRadios: [...document.querySelectorAll('input[name="provider"]')],
    keyRow: {}, keyInput: {}, testKey: {}, clearKey: {}, spendHint: $('spend-hint'),
    minTime: $('min-time'), maxTime: $('max-time'), autoStop: $('auto-stop'),
    hotkey: $('hotkey'), hotkeyHint: $('hotkey-hint'),
    languages: $('languages'), keywords: $('keywords'), keywordCount: $('keyword-count'),
    modeList: $('mode-list'), addMode: $('add-mode'), editor: $('mode-editor'), editorTitle: $('editor-title'),
    modeName: $('mode-name'), modeIcon: $('mode-icon'), modePrompt: $('mode-prompt'),
    deleteMode: $('delete-mode'), cancelMode: $('cancel-mode'), saveMode: $('save-mode'),
    refreshUsage: $('refresh-usage'), clearUsage: $('clear-usage'),
    version: $('version'), reset: $('reset'), toast: $('toast'),
  };
  for (const id of providerIds) {
    el.keyRow[id] = $(`key-row-${id}`);
    el.keyInput[id] = $(`key-${id}`);
    el.testKey[id] = $(`test-${id}`);
    el.clearKey[id] = $(`clear-${id}`);
  }

  let settings = freshSettings();
  let loaded = false;
  /** @type {{ key: string|null } | null} */
  let editing = null;
  let hotkeyArmed = false;
  let toastTimer;
  let keywordTimer;
  const keyTimers = {};

  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return null;
    }
  }

  function toast(text, tone = 'info') {
    el.toast.textContent = text;
    el.toast.dataset.tone = tone;
    el.toast.hidden = false;
    clearTimer(toastTimer);
    toastTimer = setTimer(() => { el.toast.hidden = true; }, tone === 'error' ? 6000 : 2500);
  }

  /**
   * Apply a change, save the whole settings object, and roll back on failure.
   * @param {(s: import('../shared/defaults.js').Settings) => void} mutate
   * @param {string} [successText]
   * @returns {Promise<boolean>}
   */
  async function commit(mutate, successText) {
    const previous = structuredClone(settings);
    mutate(settings);
    render();
    const response = loaded ? await send({ action: MSG.SAVE_SETTINGS, settings }) : null;
    if (response?.success === true) {
      if (successText) toast(successText, 'success');
      return true;
    }
    settings = previous;
    render();
    toast(loaded ? response?.error || 'Could not save settings.' : NOT_LOADED, 'error');
    return false;
  }

  function svgIcon(name, className) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);
    for (const d of ICON_PATHS[name]) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  function span(className, text) {
    const node = document.createElement('span');
    node.className = className;
    node.textContent = text;
    return node;
  }

  // Rendering. A focused text field is never overwritten, so a save while typing keeps the caret.

  function render() {
    renderProvider();
    renderRecording();
    renderSpeech();
    renderModes();
  }

  function renderProvider() {
    for (const radio of el.providerRadios) radio.checked = radio.value === settings.provider;
    for (const id of providerIds) {
      const key = settings.keys[id] || '';
      el.keyRow[id].hidden = id !== settings.provider;
      el.keyInput[id].placeholder = key ? maskKey(key) : PROVIDERS[id].keyPlaceholder;
      if (document.activeElement !== el.keyInput[id]) el.keyInput[id].value = '';
      el.clearKey[id].disabled = !key;
    }
    const ready = Boolean(settings.keys[settings.provider]?.trim());
    el.status.dataset.ready = String(ready);
    el.statusText.textContent = ready ? 'Ready' : 'Add API key';
    el.spendHint.hidden = !providerIds.some((id) => settings.keys[id]?.trim());
  }

  function setSelect(select, value) {
    const wanted = String(value);
    if (![...select.options].some((o) => o.value === wanted)) {
      const option = document.createElement('option');
      option.value = wanted;
      option.textContent = `${wanted} s`;
      select.append(option);
    }
    select.value = wanted;
  }

  function renderRecording() {
    setSelect(el.minTime, settings.minRecordingTime);
    setSelect(el.maxTime, settings.maxRecordingTime);
    el.autoStop.value = String(settings.autoStopSilenceSec);
    renderHotkey();
  }

  function renderHotkey() {
    el.hotkey.textContent = hotkeyArmed ? 'Press keys' : formatChord(settings.hotkey, { mac });
    el.hotkey.setAttribute('aria-pressed', String(hotkeyArmed));
  }

  function renderSpeech() {
    const chosen = new Set(settings.languages);
    for (const box of el.languages.querySelectorAll('input[type="checkbox"]')) {
      box.checked = box.value === 'auto' ? settings.languages.length === 0 : chosen.has(box.value);
    }
    if (document.activeElement !== el.keywords) el.keywords.value = formatKeywords(settings.keywords);
    el.keywordCount.textContent = `${settings.keywords.length} of ${MAX_KEYWORDS} terms`;
  }

  function renderModes() {
    const focused = el.modeList.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    el.modeList.replaceChildren();
    for (const [key, mode] of Object.entries(settings.modes)) {
      const active = key === settings.activeMode;
      const item = document.createElement('li');
      item.className = 'mode';

      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'mode-select';
      select.dataset.focusKey = `select:${key}`;
      select.setAttribute('aria-pressed', String(active));
      const name = span('mode-name', mode.name);
      if (mode.builtIn) name.append(span('mode-badge', 'Built-in'));
      const text = span('mode-text', '');
      text.append(name, span('mode-preview', mode.prompt?.trim() ? mode.prompt.trim() : 'Raw transcription'));
      select.append(span('mode-icon', mode.icon || DEFAULT_MODE_ICON), text);
      if (active) select.append(svgIcon('check', 'mode-check'));
      select.addEventListener('click', () => selectMode(key));

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'icon-btn';
      edit.dataset.focusKey = `edit:${key}`;
      edit.setAttribute('aria-label', `Edit ${mode.name}`);
      edit.append(svgIcon('edit'));
      edit.addEventListener('click', () => openEditor(key));

      item.append(select, edit);
      el.modeList.append(item);
    }
    if (focused) {
      for (const button of el.modeList.querySelectorAll('button')) {
        if (button.dataset.focusKey === focused) button.focus();
      }
    }
  }

  // Provider and keys.

  async function saveKey(id) {
    clearTimer(keyTimers[id]);
    const value = el.keyInput[id].value.trim();
    if (!value || value === settings.keys[id]) {
      renderProvider();
      return;
    }
    await commit((s) => { s.keys[id] = value; }, 'Key saved');
  }

  async function testKey(id) {
    const key = el.keyInput[id].value.trim() || settings.keys[id]?.trim();
    if (!key) {
      toast('Enter a key first', 'error');
      return;
    }
    const button = el.testKey[id];
    button.disabled = true;
    button.textContent = 'Testing…';
    const result = await send({ action: MSG.VALIDATE_KEY, provider: id, key });
    button.disabled = false;
    button.textContent = 'Test';
    if (result?.ok) toast(`${PROVIDERS[id].label} key works`, 'success');
    else toast(result?.error || 'Could not reach the provider.', 'error');
  }

  for (const radio of el.providerRadios) {
    radio.addEventListener('change', () => {
      if (radio.checked) commit((s) => { s.provider = radio.value; });
    });
  }

  for (const id of providerIds) {
    const input = el.keyInput[id];
    input.addEventListener('input', () => {
      clearTimer(keyTimers[id]);
      keyTimers[id] = setTimer(() => saveKey(id), TYPING_SAVE_MS);
    });
    input.addEventListener('change', () => saveKey(id));
    input.addEventListener('blur', () => saveKey(id));
    el.testKey[id].addEventListener('click', () => testKey(id));
    el.clearKey[id].addEventListener('click', () => {
      clearTimer(keyTimers[id]);
      input.value = '';
      commit((s) => { s.keys[id] = ''; }, 'Key cleared');
    });
  }

  // Recording.

  for (const seconds of AUTO_STOP_CHOICES) {
    const option = document.createElement('option');
    option.value = String(seconds);
    option.textContent = seconds === 0 ? 'Off' : `${seconds} s`;
    el.autoStop.append(option);
  }

  el.minTime.addEventListener('change', () => commit((s) => { s.minRecordingTime = Number(el.minTime.value); }));
  el.maxTime.addEventListener('change', () => commit((s) => { s.maxRecordingTime = Number(el.maxTime.value); }));
  el.autoStop.addEventListener('change', () => commit((s) => { s.autoStopSilenceSec = Number(el.autoStop.value); }));

  function setHotkeyHint(text, tone) {
    el.hotkeyHint.textContent = text;
    if (tone) el.hotkeyHint.dataset.tone = tone;
    else delete el.hotkeyHint.dataset.tone;
  }

  function disarmHotkey() {
    hotkeyArmed = false;
    setHotkeyHint(HOTKEY_IDLE_HINT);
    renderHotkey();
  }

  el.hotkey.addEventListener('click', () => {
    if (hotkeyArmed) {
      disarmHotkey();
      return;
    }
    hotkeyArmed = true;
    setHotkeyHint(HOTKEY_ARMED_HINT);
    renderHotkey();
    el.hotkey.focus();
  });
  el.hotkey.addEventListener('blur', () => { if (hotkeyArmed) disarmHotkey(); });
  el.hotkey.addEventListener('keydown', (event) => {
    if (!hotkeyArmed || event.key === 'Tab') return;
    // Also keeps Escape from closing the popup and Space or Enter from clicking the button.
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      disarmHotkey();
      return;
    }
    if (MODIFIER_KEYS.has(event.key)) return;
    const chord = chordFromEvent(event);
    if (!chord) {
      setHotkeyHint(HOTKEY_INVALID_HINT, 'error');
      return;
    }
    hotkeyArmed = false;
    setHotkeyHint(HOTKEY_IDLE_HINT);
    commit((s) => { s.hotkey = chord; }, `Hotkey: ${formatChord(chord, { mac })}`);
  });

  // Speech.

  for (const { code, label } of [{ code: 'auto', label: 'Auto' }, ...SPOKEN_LANGUAGES]) {
    const wrap = document.createElement('label');
    wrap.className = 'check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = `lang-${code}`;
    box.value = code;
    box.addEventListener('change', () => commit((s) => { s.languages = toggleLanguage(s.languages, code, box.checked); }));
    wrap.append(box, document.createTextNode(label));
    el.languages.append(wrap);
  }

  async function saveKeywords() {
    clearTimer(keywordTimer);
    const next = parseKeywords(el.keywords.value);
    if (sameList(next, settings.keywords)) {
      renderSpeech();
      return;
    }
    await commit((s) => { s.keywords = next; });
  }

  el.keywords.addEventListener('input', () => {
    clearTimer(keywordTimer);
    keywordTimer = setTimer(saveKeywords, TYPING_SAVE_MS);
  });
  el.keywords.addEventListener('change', saveKeywords);
  el.keywords.addEventListener('blur', saveKeywords);

  // Modes.

  function selectMode(key) {
    if (key === settings.activeMode) return;
    commit((s) => { s.activeMode = key; }, `Mode: ${settings.modes[key].name}`);
  }

  function openEditor(key) {
    editing = { key };
    const mode = key ? settings.modes[key] : null;
    el.editorTitle.textContent = key ? 'Edit mode' : 'New mode';
    el.modeName.value = mode?.name ?? '';
    el.modeIcon.value = mode?.icon ?? DEFAULT_MODE_ICON;
    el.modePrompt.value = mode?.prompt ?? '';
    el.deleteMode.hidden = !key || Boolean(mode?.builtIn);
    el.editor.hidden = false;
    el.modeName.focus();
  }

  function closeEditor() {
    editing = null;
    el.editor.hidden = true;
  }

  async function saveEditor() {
    if (!editing) return;
    const name = el.modeName.value.trim();
    if (!name) {
      toast('Enter a mode name', 'error');
      el.modeName.focus();
      return;
    }
    const icon = el.modeIcon.value.trim() || DEFAULT_MODE_ICON;
    const prompt = el.modePrompt.value.trim();
    const created = editing.key === null;
    const key = created ? `custom_${Date.now()}` : editing.key;
    const ok = await commit((s) => {
      s.modes[key] = { ...(s.modes[key] || { builtIn: false }), name, icon, prompt };
    }, created ? 'Mode created' : 'Mode updated');
    if (ok) closeEditor();
  }

  async function deleteEditingMode() {
    const key = editing?.key;
    if (!key || settings.modes[key]?.builtIn) return;
    const ok = await commit((s) => {
      delete s.modes[key];
      if (s.activeMode === key) s.activeMode = 'default';
    }, 'Mode deleted');
    if (ok) closeEditor();
  }

  el.addMode.addEventListener('click', () => openEditor(null));
  el.saveMode.addEventListener('click', saveEditor);
  el.cancelMode.addEventListener('click', closeEditor);
  el.deleteMode.addEventListener('click', deleteEditingMode);

  // Usage.

  function fillUsage(prefix, bucket, costField) {
    $(`usage-${prefix}-sessions`).textContent = String(bucket?.sessions || 0);
    $(`usage-${prefix}-audio`).textContent = formatTime(bucket?.audioSeconds || 0);
    $(`usage-${prefix}-cost`).textContent = formatCost(bucket?.[costField] || 0);
  }

  async function loadUsage() {
    const stats = await send({ action: MSG.GET_USAGE });
    if (!stats?.total || typeof stats.total !== 'object') return false;
    fillUsage('today', stats.today, 'estimatedCost');
    fillUsage('week', stats.last7Days, 'estimatedCost');
    fillUsage('total', stats.total, 'estimatedCost');
    for (const id of providerIds) fillUsage(id, stats.total.byProvider?.[id], 'cost');
    return true;
  }

  el.refreshUsage.addEventListener('click', async () => {
    if (!(await loadUsage())) toast('Could not load usage.', 'error');
  });

  createInlineConfirm(el.clearUsage, {
    prompt: 'Click again to clear usage history',
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    onConfirm: async () => {
      const response = await send({ action: MSG.CLEAR_USAGE });
      if (response?.success !== true) {
        toast('Could not clear usage history.', 'error');
        return;
      }
      await loadUsage();
      toast('Usage history cleared', 'success');
    },
  });

  // About and reset.

  el.version.textContent = `Version ${chrome.runtime.getManifest().version}`;
  for (const link of document.querySelectorAll('a[data-external]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      chrome.tabs.create({ url: link.href });
    });
  }

  createInlineConfirm(el.reset, {
    prompt: RESET_PROMPT,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    onConfirm: () => {
      closeEditor();
      return commit((s) => {
        const kept = { keys: { ...s.keys }, provider: s.provider, languages: [...s.languages], keywords: [...s.keywords] };
        Object.assign(s, freshSettings(), kept);
      }, 'Settings reset');
    },
  });

  // Load.

  const stored = await send({ action: MSG.GET_SETTINGS });
  loaded = isSettings(stored);
  if (loaded) {
    settings = { ...freshSettings(), ...stored };
  } else {
    // Never save from fallback settings: that would write blank keys over the real ones.
    el.bannerText.textContent = LOAD_ERROR;
    el.banner.hidden = false;
  }
  render();
  await loadUsage();

  return {
    get settings() { return settings; },
    get loaded() { return loaded; },
  };
}

if (globalThis.chrome?.runtime) {
  document.addEventListener('DOMContentLoaded', () => {
    initPopup({ chrome: globalThis.chrome, document, window });
  });
}
```

- [ ] **Step 10: Run the popup tests to verify they pass**

```bash
npx vitest run test/unit/popup
```

Expected: 2 files, 44 tests passed.

- [ ] **Step 11: Run the full suite and the build**

```bash
npm test
npm run build
```

Expected: every file passes (Task 12 adds 44 tests; report N/N). The build prints `dist/popup.js` and `Done`, and `dist/popup.html` and `dist/popup.css` are the new files. `popup.js` is an entry point, so the build is part of this task's gate.

- [ ] **Step 12: Commit**

```bash
git add src/popup/form.js src/popup/popup.html src/popup/popup.css src/popup/popup.js test/unit/popup/form.test.js test/unit/popup/popup.test.js
git commit -m "Rework the popup into one autosaving column with a hotkey recorder and inline confirms"
```

---

### Task 13: Fixtures and the Playwright smoke

**Files:**
- Modify: `test/fixtures/fields.html`, `package.json` (devDependency `@playwright/test` pinned to `1.63.0`; scripts `"test:e2e": "npm run build && playwright test"`), `.gitignore` (`test-results/`, `playwright-report/`)
- Create: `test/fixtures/frame.html`, `test/fixtures/hostile.html`, `test/fixtures/pp-denied.html`, `test/fixtures/serve.mjs`, `playwright.config.js`, `test/e2e/wav.js`, `test/e2e/smoke.spec.js`

**Interfaces:**
- Consumes: the built `dist/`; Task 6 recorder, Task 11 content script, Task 7 ladder.
- Produces:
  - `test/fixtures/serve.mjs`: zero-dependency static server (`node:http`) on `PORT` (default 8765) serving `test/fixtures/`; `pp-denied.html` is served with `Permissions-Policy: microphone=()`. The same server answers on `localhost` and `127.0.0.1`, so a frame loaded from the other host name is cross-origin.
  - `fields.html` gains: a field inside a scrolling container, a bottom-edge field, a field inside an open shadow root (with a contenteditable for the caret check), a same-origin iframe (`frame.html`), a cross-origin iframe (`http://127.0.0.1:<port>/frame.html` when the page is on `localhost`, computed in an inline script), and a link to `hostile.html` and `pp-denied.html`.
  - `hostile.html`: `button { all: unset } * { font-size: 30px !important }` plus a textarea (spec 6.2 acceptance, manual).
  - `test/e2e/wav.js` `writeToneWav(path, { seconds = 2, hz = 440, sampleRate = 48000 })` writes 16-bit mono PCM; `writeSilenceWav(path, { seconds })`.
  - `playwright.config.js`: `testDir: 'test/e2e'`, one worker, `timeout: 60_000`.
  - `test/e2e/smoke.spec.js` (recipe verified on Playwright 1.63 and Chromium 153): `chromium.launchPersistentContext('', { channel: 'chromium', headless: true, args: ['--disable-extensions-except=<abs dist>', '--load-extension=<abs dist>', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-audio-capture=<tone wav>%noloop'] })`; extension id from the service worker URL; leak guard `context.route('https://**', r => r.abort())` registered first, then stubs for `api.openai.com` (transcription returns `{ text: 'stubbed transcript', usage: { type: 'duration', seconds: 2 } }`) registered after it; settings seeded with `sw.evaluate(s => chrome.storage.local.set({ settings: s }), settings)` holding a dummy OpenAI key; tests: (1) textarea: click REC, wait for recording, click REC, expect the textarea to contain `stubbed transcript`; (2) the contenteditable inside the open shadow root with the caret after its first word: dictation lands at the caret (ledger row 51); (3) no key: REC shows the "Add an API key" status. Never `page.route` for provider stubs.
- Research to honour: `page.route` does not see service worker fetches; the last registered route wins; do not combine `--use-fake-ui-for-media-stream` with `--auto-accept-camera-and-microphone-capture`.

WRITER NOTES

- The pill sits in a closed shadow root, which Playwright selectors cannot enter. The spec reaches it through the DevTools protocol (`DOM.getDocument` with `pierce: true` lists closed roots; `DOM.querySelector` on the shadow root; `Runtime.callFunctionOn` for the box and text) and clicks with `page.mouse`, a real click that the pill's `mousedown` guard keeps from stealing focus. It depends on Task 9's REC `aria-label` values (`Start recording`, `Stop recording`) and the status element's `role="status"`.
- `serve.mjs` listens on `127.0.0.1` and `::1`, not only `127.0.0.1`: browsers and curl try `::1` first for `localhost`, and on the machine this was verified on an unbound `::1` port accepted and then reset the connection, so a `127.0.0.1`-only server broke every `localhost` URL. A host without IPv6 skips `::1`.
- `playwright.config.js` adds a `webServer` entry (starts `serve.mjs`, `reuseExistingServer: true`) beyond the three listed fields.
- The seeded settings are asserted with `expect(migrateSettings(settings)).toBe(settings)`, which relies on Task 3's "returns the same reference when nothing changed": it proves the object is a complete, valid v2 settings object. Checked against the final Task 3 `defaults.js`: same reference for both seeds, and the key set equals `DEFAULT_SETTINGS` (`hotkey` `{ code: 'Space', ctrl: true, shift: true, alt: false, meta: false }`, `autoStopSilenceSec: 0`).
- Verified: the whole plan was replayed on 2026-09-27 (all 14 tasks, 587/587); with the real Tasks 6, 7, 9 and 11 built, `npm run test:e2e` passed 3/3 on three consecutive runs after two controller fixes: `clickPill` hovers the collapsed pill and waits for its bar to finish expanding before clicking, and `beforeAll` waits for `onInstalled` to store default settings before seeding the key.
- The `package.json` and `.gitignore` replacements were applied on top of Task 1's `package.json` (engines changed, scripts untouched); `npm install --save-exact` then adds `"@playwright/test": "1.63.0"` first in `devDependencies`. `npm test` stays at the pre-task total (584/584 on the full replay): Vitest does not collect `test/e2e`.
- With `%noloop`, the fake track neither ends nor goes silent after the file (levels stayed near 0.56); the spec uses a 10 s tone and `autoStopSilenceSec: 0`, so nothing depends on that behaviour.
- The Files list omits `package-lock.json`; Step 14 commits it with `package.json`.

- [ ] **Step 1: Install Playwright and its Chromium**

```bash
npm install --save-dev --save-exact @playwright/test@1.63.0
npx playwright install --no-shell chromium
```

Expected: `package.json` `devDependencies` gains `"@playwright/test": "1.63.0"` (exact, no caret) and `package-lock.json` changes; the second command downloads Chromium 153 into the Playwright cache. On a Linux machine that lacks the browser's system libraries, run `sudo npx playwright install-deps chromium` once. Headless runs need no display server.

- [ ] **Step 2: Add the e2e script and ignore Playwright output**

In `package.json`, replace:

```json
    "test:watch": "vitest"
```

with:

```json
    "test:watch": "vitest",
    "test:e2e": "npm run build && playwright test"
```

In `.gitignore`, replace:

```
.superpowers/
```

with:

```
.superpowers/
test-results/
playwright-report/
```

- [ ] **Step 3: Create the fixture server**

`test/fixtures/serve.mjs`:

```js
// Zero-dependency static server for the fixture pages (manual smoke and Playwright).
// http://localhost:PORT and http://127.0.0.1:PORT reach the same files as two different
// origins: that is how fields.html gets a cross-origin frame.
//   node test/fixtures/serve.mjs          (PORT defaults to 8765)
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
export const DEFAULT_PORT = 8765;
// Loopback only. Browsers try ::1 first for "localhost", so listen there too when IPv6 exists.
const HOSTS = ['127.0.0.1', '::1'];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wav': 'audio/wav',
  '.png': 'image/png',
};

/** Extra response headers per fixture file. */
const EXTRA_HEADERS = {
  'pp-denied.html': { 'Permissions-Policy': 'microphone=()' },
};

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} text
 */
function plain(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/** @type {import('node:http').RequestListener} */
async function handle(req, res) {
  let name;
  try {
    name = decodeURIComponent(new URL(req.url ?? '/', 'http://fixtures').pathname).replace(/^\/+/, '') || 'fields.html';
  } catch {
    plain(res, 400, 'Bad request');
    return;
  }
  const file = normalize(join(ROOT, name));
  const rel = relative(ROOT, file);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    plain(res, 403, 'Forbidden');
    return;
  }
  let body;
  try {
    body = await readFile(file);
  } catch {
    plain(res, 404, 'Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    ...(EXTRA_HEADERS[rel] ?? {}),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * @param {import('node:http').Server} server
 * @param {number} port
 * @param {string} host
 */
function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
}

/**
 * Serve test/fixtures/ on the loopback addresses.
 * @param {{ port?: number }} [options]
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export async function startFixtureServer({ port = Number(process.env.PORT) || DEFAULT_PORT } = {}) {
  const servers = [];
  for (const host of HOSTS) {
    const server = createServer(handle);
    try {
      await listen(server, port, host);
      servers.push(server);
    } catch (err) {
      // A machine without IPv6 still serves both names over 127.0.0.1.
      if (host === '::1' && ['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(err.code)) continue;
      await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
      throw err;
    }
  }
  return {
    port,
    close: () => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))).then(() => {}),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const { port } = await startFixtureServer();
  console.log(`VoiceType fixtures on http://localhost:${port}/fields.html (cross-origin host http://127.0.0.1:${port})`);
}
```

- [ ] **Step 4: Create the fixture pages**

Replace the whole of `test/fixtures/fields.html` with:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>VoiceType fixtures</title>
  <style>
    body { font: 16px system-ui, sans-serif; margin: 40px; max-width: 720px; padding-bottom: 160px; }
    label, .label { display: block; margin: 18px 0 6px; font-weight: 600; }
    input, textarea, [contenteditable] { width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid #999; border-radius: 4px; }
    [contenteditable] { min-height: 64px; }
    .left-flush { margin-left: -40px; width: 200px; }
    .scroller { height: 140px; overflow: auto; border: 1px dashed #999; padding: 8px; }
    .scroller-inner { height: 420px; padding-top: 180px; box-sizing: border-box; }
    .bottom-edge { position: fixed; bottom: 4px; left: 40px; width: 320px; background: #fff; }
    iframe { width: 100%; height: 170px; border: 1px solid #999; }
    .note { color: #555; font-size: 14px; }
  </style>
</head>
<body>
  <h1>VoiceType fixtures</h1>
  <p class="note">Serve with <code>node test/fixtures/serve.mjs</code> and open <code>http://localhost:8765/fields.html</code>. Other pages: <a href="hostile.html">hostile.html</a> (hostile page CSS), <a href="pp-denied.html">pp-denied.html</a> (microphone denied by Permissions-Policy).</p>

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
  <label for="left">left-flush input (pill expected on the right)</label>
  <input id="left" class="left-flush" type="text">

  <label for="scrolled">input inside a scrolling container (the pill follows it)</label>
  <div class="scroller" id="scroller">
    <div class="scroller-inner">
      <input id="scrolled" type="text" placeholder="scroll the box">
    </div>
  </div>

  <span class="label">open shadow root (input and a contenteditable holding "Hello world")</span>
  <div id="shadow-host"></div>

  <span class="label">same-origin iframe</span>
  <iframe id="same-frame" src="frame.html" title="Same-origin frame"></iframe>

  <span class="label">cross-origin iframe</span>
  <iframe id="cross-frame" title="Cross-origin frame"></iframe>
  <p class="note" id="cross-note"></p>

  <label for="bottom">bottom-edge field (the menu opens above)</label>
  <textarea id="bottom" class="bottom-edge" rows="2" placeholder="bottom edge"></textarea>

  <script>
    // Open shadow root with its own fields; built with DOM calls so the markup stays static.
    (function buildShadowFields() {
      const root = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = 'input, div { display: block; width: 100%; box-sizing: border-box; padding: 8px; margin: 0 0 8px; border: 1px solid #999; border-radius: 4px; font: inherit; } div { min-height: 48px; }';
      const input = document.createElement('input');
      input.id = 'shadow-input';
      input.type = 'text';
      input.placeholder = 'input in a shadow root';
      const editable = document.createElement('div');
      editable.id = 'shadow-ce';
      editable.contentEditable = 'true';
      editable.textContent = 'Hello world';
      root.append(style, input, editable);
    })();

    // The same server answers on localhost and 127.0.0.1, so the other host name is another origin.
    (function pointCrossOriginFrame() {
      const frame = document.getElementById('cross-frame');
      const note = document.getElementById('cross-note');
      if (location.protocol !== 'http:' && location.protocol !== 'https:') {
        note.textContent = 'Open this page through serve.mjs to load the cross-origin frame.';
        return;
      }
      const other = location.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
      frame.src = `${location.protocol}//${other}:${location.port}/frame.html`;
      note.textContent = `Loaded from ${other}.`;
    })();
  </script>
</body>
</html>
```

`test/fixtures/frame.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>VoiceType frame fixture</title>
  <style>
    body { font: 15px system-ui, sans-serif; margin: 12px; }
    label { display: block; margin: 0 0 6px; font-weight: 600; }
    textarea { width: 100%; box-sizing: border-box; padding: 6px; border: 1px solid #999; border-radius: 4px; }
  </style>
</head>
<body>
  <label for="frame-ta">textarea in a frame (<span id="origin"></span>)</label>
  <textarea id="frame-ta" rows="3"></textarea>
  <script>
    document.getElementById('origin').textContent = location.origin;
  </script>
</body>
</html>
```

`test/fixtures/hostile.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>VoiceType hostile CSS fixture</title>
  <style>
    button { all: unset }
    * { font-size: 30px !important }
  </style>
</head>
<body>
  <h1>Hostile page CSS</h1>
  <p>The pill must look exactly as it does on <a href="fields.html">fields.html</a>.</p>
  <label for="hostile-ta">textarea</label>
  <textarea id="hostile-ta" rows="4" cols="40"></textarea>
</body>
</html>
```

`test/fixtures/pp-denied.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>VoiceType Permissions-Policy fixture</title>
  <style>
    body { font: 16px system-ui, sans-serif; margin: 40px; max-width: 720px; }
    textarea { width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid #999; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Microphone denied by Permissions-Policy</h1>
  <p>serve.mjs sends <code>Permissions-Policy: microphone=()</code> with this page. Dictation must still work: VoiceType records in its own extension document, not in the page.</p>
  <p>Page microphone policy: <strong id="policy">unknown</strong></p>
  <label for="pp-ta">textarea</label>
  <textarea id="pp-ta" rows="4"></textarea>
  <script>
    const policy = document.featurePolicy;
    if (policy) document.getElementById('policy').textContent = policy.allowsFeature('microphone') ? 'allowed (header missing?)' : 'blocked';
  </script>
</body>
</html>
```

- [ ] **Step 5: Check the server on both host names and the Permissions-Policy header**

```bash
PORT=8799 node test/fixtures/serve.mjs & SERVER=$!; sleep 1
for url in http://localhost:8799/fields.html http://127.0.0.1:8799/fields.html http://127.0.0.1:8799/frame.html http://localhost:8799/hostile.html http://localhost:8799/nope.html "http://localhost:8799/..%2fserve.mjs"; do
  echo "$(curl -s -o /dev/null -w '%{http_code}' "$url") $url"
done
curl -sI http://localhost:8799/pp-denied.html | grep -i '^permissions-policy'
curl -sI http://localhost:8799/fields.html | grep -ci '^permissions-policy'
kill $SERVER
```

Expected:

```
VoiceType fixtures on http://localhost:8799/fields.html (cross-origin host http://127.0.0.1:8799)
200 http://localhost:8799/fields.html
200 http://127.0.0.1:8799/fields.html
200 http://127.0.0.1:8799/frame.html
200 http://localhost:8799/hostile.html
404 http://localhost:8799/nope.html
403 http://localhost:8799/..%2fserve.mjs
Permissions-Policy: microphone=()
0
```

- [ ] **Step 6: Create the WAV writer**

`test/e2e/wav.js`:

```js
// WAV files for Chromium's fake microphone (--use-file-for-fake-audio-capture): 16-bit mono PCM.
import { writeFileSync } from 'node:fs';

/** Half of full scale: a clear "speech" level without clipping after browser processing. */
const TONE_AMPLITUDE = 0.5;

/**
 * @param {ArrayLike<number>} samples in [-1, 1]
 * @param {number} sampleRate
 * @returns {Buffer} a canonical 44-byte RIFF/WAVE header followed by the PCM data
 */
export function encodeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return buf;
}

/**
 * @param {string} path
 * @param {{ seconds?: number, hz?: number, sampleRate?: number }} [options]
 * @returns {string} the path written
 */
export function writeToneWav(path, { seconds = 2, hz = 440, sampleRate = 48000 } = {}) {
  const samples = new Float64Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = TONE_AMPLITUDE * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  }
  writeFileSync(path, encodeWav(samples, sampleRate));
  return path;
}

/**
 * @param {string} path
 * @param {{ seconds?: number, sampleRate?: number }} [options]
 * @returns {string} the path written
 */
export function writeSilenceWav(path, { seconds = 2, sampleRate = 48000 } = {}) {
  writeFileSync(path, encodeWav(new Float64Array(Math.round(seconds * sampleRate)), sampleRate));
  return path;
}
```

- [ ] **Step 7: Check that the WAV files parse**

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { writeToneWav, writeSilenceWav } from './test/e2e/wav.js';
for (const path of [writeToneWav('/tmp/vt-tone.wav'), writeSilenceWav('/tmp/vt-silence.wav', { seconds: 1 })]) {
  const b = readFileSync(path);
  console.log(b.toString('ascii', 0, 4), b.toString('ascii', 8, 12), b.readUInt16LE(20), b.readUInt16LE(22), b.readUInt32LE(24), b.readUInt16LE(34), b.readUInt32LE(40), b.length);
}"
file /tmp/vt-tone.wav /tmp/vt-silence.wav
```

Expected:

```
RIFF WAVE 1 1 48000 16 192000 192044
RIFF WAVE 1 1 48000 16 96000 96044
/tmp/vt-tone.wav:    RIFF (little-endian) data, WAVE audio, Microsoft PCM, 16 bit, mono 48000 Hz
/tmp/vt-silence.wav: RIFF (little-endian) data, WAVE audio, Microsoft PCM, 16 bit, mono 48000 Hz
```

- [ ] **Step 8: Create the Playwright config**

`playwright.config.js`:

```js
// End-to-end smoke only; unit tests run under Vitest (`npm test`). `npm run test:e2e` builds dist/ first.
import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.PORT) || 8765;

export default defineConfig({
  testDir: 'test/e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  retries: 0,
  reporter: 'list',
  webServer: {
    command: 'node test/fixtures/serve.mjs',
    url: `http://127.0.0.1:${PORT}/fields.html`,
    reuseExistingServer: true,
    timeout: 10_000,
  },
});
```

- [ ] **Step 9: Write the smoke spec**

`test/e2e/smoke.spec.js` (provider stubs use `context.route` only; `page.route` never sees service worker fetches):

```js
// End-to-end smoke: the built extension in Playwright's Chromium with a fake microphone and a
// stubbed provider. Run with `npm run test:e2e`, which builds dist/ first.
import { test, expect, chromium } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshSettings, migrateSettings } from '../../src/shared/defaults.js';
import { writeToneWav } from './wav.js';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));
const PORT = Number(process.env.PORT) || 8765;
const FIELDS_URL = `http://localhost:${PORT}/fields.html`;
const TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';
const TRANSCRIPT = 'stubbed transcript';
const DUMMY_KEY = 'sk-e2e-dummy-key';
const START = 'button[aria-label="Start recording"]';
const STOP = 'button[aria-label="Stop recording"]';
const STATUS = '[role="status"]';
/** Longer than minRecordingTime (1 s), so the recorder does not drop the clip as too short. */
const RECORD_MS = 1500;

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').BrowserContext} */
let context;
/** @type {import('@playwright/test').Worker} */
let serviceWorker;
let extensionId = '';
let workDir = '';
/** @type {{ method: string, auth: string|null }[]} */
const providerCalls = [];

const isExtensionWorker = (worker) => worker.url().startsWith('chrome-extension://');

test.beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'voicetype-e2e-'));
  const tone = writeToneWav(join(workDir, 'tone.wav'), { seconds: 10 });
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${tone}%noloop`,
    ],
  });
  // Leak guard first: any https request that no later route claims is aborted.
  await context.route('https://**', (route) => route.abort());
  // Registered after the guard, so it wins for this URL (the last registered route wins).
  // A context route, never page.route: only context routes see service worker fetches.
  await context.route(TRANSCRIPTION_URL, async (route) => {
    const request = route.request();
    providerCalls.push({ method: request.method(), auth: await request.headerValue('authorization') });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text: TRANSCRIPT, usage: { type: 'duration', seconds: 2 } }),
    });
  });
  serviceWorker = context.serviceWorkers().find(isExtensionWorker)
    ?? await context.waitForEvent('serviceworker', { predicate: isExtensionWorker });
  extensionId = new URL(serviceWorker.url()).host;
  // onInstalled stores the default settings; a seed written before that lands is overwritten.
  await expect.poll(() => serviceWorker.evaluate(async () => Boolean((await chrome.storage.local.get('settings')).settings))).toBe(true);
});

test.afterAll(async () => {
  await context?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  providerCalls.length = 0;
});

test.afterEach(async () => {
  // Closing the tab also cancels a session a failed test left behind.
  for (const page of context.pages()) {
    if (page.url().startsWith('http')) await page.close();
  }
});

/**
 * Store a complete v2 settings object. migrateSettings returning the same reference proves
 * that nothing in it is missing or invalid.
 * @param {string} openaiKey
 */
async function seedSettings(openaiKey) {
  const settings = {
    ...freshSettings(),
    provider: 'openai',
    keys: { openai: openaiKey, gemini: '' },
    activeMode: 'default',
    minRecordingTime: 1,
    maxRecordingTime: 120,
    hotkey: { code: 'Space', ctrl: true, shift: true, alt: false, meta: false },
    autoStopSilenceSec: 0,
  };
  expect(migrateSettings(settings)).toBe(settings);
  await serviceWorker.evaluate((s) => chrome.storage.local.set({ settings: s }), settings);
}

/** @param {any} node CDP DOM.Node */
function findPillHost(node) {
  if (node.localName === 'voicetype-host') return node;
  // children only: frame documents (contentDocument) have pills of their own.
  for (const child of node.children ?? []) {
    const found = findPillHost(child);
    if (found) return found;
  }
  return null;
}

/**
 * The pill lives in a closed shadow root, which page scripts and Playwright selectors cannot
 * enter. The DevTools protocol can: DOM.getDocument with pierce lists closed shadow roots.
 * @param {import('@playwright/test').Page} page
 * @param {string} selector CSS selector inside the top document's pill
 * @returns {Promise<{ x: number, y: number, width: number, height: number, text: string }|null>}
 */
async function pillQuery(page, selector) {
  const cdp = await context.newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const shadow = findPillHost(root)?.shadowRoots?.find((r) => r.shadowRootType !== 'user-agent');
    if (!shadow) return null;
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: shadow.nodeId, selector });
    if (!nodeId) return null;
    const { object } = await cdp.send('DOM.resolveNode', { nodeId });
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function () {
        const r = this.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height, text: this.textContent };
      }`,
      returnByValue: true,
    });
    return result.value;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Waits until `selector` is rendered inside the pill and returns its box. */
async function waitForPill(page, selector, timeout = 10_000) {
  let box = null;
  await expect.poll(async () => {
    box = await pillQuery(page, selector);
    return Boolean(box && box.width > 0 && box.height > 0);
  }, { timeout, message: `pill element ${selector}` }).toBe(true);
  return box;
}

/** A real mouse click, so the pill's mousedown handler keeps focus in the field. */
async function clickPill(page, selector) {
  // Idle, the pill is a dot: its controls sit in a zero-width, clipped bar until hover expands it.
  const body = await waitForPill(page, '.body');
  await page.mouse.move(body.x, body.y);
  // Wait until the bar has expanded and stopped animating: two equal, non-zero widths in a row.
  let lastWidth = -1;
  await expect.poll(async () => {
    const width = (await pillQuery(page, '.bar'))?.width ?? 0;
    const settled = width > 0 && width === lastWidth;
    lastWidth = width;
    return settled;
  }, { message: 'pill bar expanded' }).toBe(true);
  const box = await waitForPill(page, selector);
  await page.mouse.click(box.x, box.y);
}

/** Focuses a field until the idle pill shows (the content script loads at document_idle). */
async function focusField(page, field) {
  await expect(async () => {
    await page.locator('h1').click();
    await field.click();
    const box = await pillQuery(page, START);
    expect(box?.width ?? 0).toBeGreaterThan(0);
  }).toPass({ timeout: 15_000 });
}

async function openFields() {
  const page = await context.newPage();
  await page.goto(FIELDS_URL);
  return page;
}

/** REC, wait for recording, record long enough, REC again. */
async function dictate(page) {
  await clickPill(page, START);
  await waitForPill(page, STOP);
  await page.waitForTimeout(RECORD_MS);
  await clickPill(page, STOP);
}

test('textarea: REC twice inserts the stubbed transcript', async () => {
  await seedSettings(DUMMY_KEY);
  const page = await openFields();
  const textarea = page.locator('#ta');
  await focusField(page, textarea);

  await dictate(page);

  await expect(textarea).toHaveValue(TRANSCRIPT);
  expect(providerCalls).toEqual([{ method: 'POST', auth: `Bearer ${DUMMY_KEY}` }]);
  const documents = await serviceWorker.evaluate(async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.map((c) => c.documentUrl);
  });
  expect(documents).toEqual([`chrome-extension://${extensionId}/offscreen.html`]);
});

test('open shadow root: dictation lands at the caret after the first word', async () => {
  await seedSettings(DUMMY_KEY);
  const page = await openFields();
  const editable = page.locator('#shadow-ce'); // CSS locators pierce open shadow roots
  await focusField(page, editable);
  const caret = await page.evaluate(() => {
    const root = document.getElementById('shadow-host').shadowRoot;
    const el = root.getElementById('shadow-ce');
    const text = el.firstChild; // "Hello world"
    const selection = root.getSelection ? root.getSelection() : document.getSelection();
    selection.collapse(text, 'Hello'.length);
    return { inField: selection.anchorNode === text, offset: selection.anchorOffset, focused: root.activeElement === el };
  });
  expect(caret).toEqual({ inField: true, offset: 5, focused: true });

  await dictate(page);

  await expect(editable).toHaveText(`Hello${TRANSCRIPT} world`);
  expect(providerCalls).toHaveLength(1);
});

test('no key: REC shows the add-a-key status and calls no provider', async () => {
  await seedSettings('');
  const page = await openFields();
  const textarea = page.locator('#ta');
  await focusField(page, textarea);

  await clickPill(page, START);

  await expect.poll(async () => (await pillQuery(page, STATUS))?.text ?? '').toContain('Add an API key');
  await waitForPill(page, START);
  await expect(textarea).toHaveValue('');
  expect(providerCalls).toEqual([]);
});
```

- [ ] **Step 10: Check the new files parse and the spec lists its tests**

```bash
for f in test/fixtures/serve.mjs test/e2e/wav.js test/e2e/smoke.spec.js playwright.config.js; do node --check "$f" && echo "ok $f"; done
npx playwright test --list
```

Expected: four `ok` lines, then:

```
Listing tests:
  smoke.spec.js:<line>:1 › textarea: REC twice inserts the stubbed transcript
  smoke.spec.js:<line>:1 › open shadow root: dictation lands at the caret after the first word
  smoke.spec.js:<line>:1 › no key: REC shows the add-a-key status and calls no provider
Total: 3 tests in 1 file
```

- [ ] **Step 11: Run the smoke**

```bash
npm run test:e2e
```

Expected: the build runs, then `3 passed`. A failure points at the task that owns the behaviour (recorder and offscreen: Tasks 5 and 6; pill labels and status: Task 9; insertion at the caret: Task 7; focus, state and delivery: Task 11). Fix it there; do not loosen the spec. `npx playwright show-report` is not needed: the `list` reporter prints the failing assertion.

- [ ] **Step 12: Run the unit suite and the build**

```bash
npm test
npm run build
```

Expected: `npm test` all green with the same `N/N` as after Task 12 (Vitest includes only `test/unit/**/*.test.js`, so `test/e2e/smoke.spec.js` is not collected); the build ends with `Done`.

- [ ] **Step 13: Check the working tree**

```bash
git status --short
```

Expected: only the files of this task (`test-results/` is ignored).

- [ ] **Step 14: Commit**

```bash
git add package.json package-lock.json .gitignore playwright.config.js test/fixtures test/e2e
git commit -m "Add the fixture server, frame and hostile fixtures and the Playwright extension smoke"
```

---

### Task 14: Release docs, version 2.1.0 and the smoke checklist

**Files:**
- Modify: `manifest.json` and `package.json` (`version: "2.1.0"`), `CHANGELOG.md`, `README.md`, `PRIVACY.md`
- Create: `docs/superpowers/plans/2026-09-27-phase-1-smoke-checklist.md`
- Test: `test/unit/manifest.test.js` (version equals `package.json` version)

**Interfaces:**
- Produces:
  - CHANGELOG `## 2.1.0 (unreleased)` with Added, Changed, Fixed, Removed, in the style of the 2.0.0 entry; covers every task of this plan in user terms.
  - README: minimum Chrome 140; hold-to-talk and tap hotkey with the popup recorder; the one-time microphone permission page and "Allow while visiting the site"; frames and shadow DOM support; clipboard behaviour when focus moves (D12); `npm run test:e2e`.
  - PRIVACY: keys readable only by the service worker and popup (`setAccessLevel`), never sent to web pages; `<all_urls>` host permission used only to re-inject the content script after an update; audio recorded in an extension document and sent only to the chosen provider.
  - Smoke checklist for K. S. Karakostas covering spec 6.1 to 6.10 acceptance items with the 6.0 amendments, the site matrix (Gmail compose, Google Docs expecting clipboard, Notion, Slack, ChatGPT, GitHub issue textarea, X, LinkedIn, plus a Lexical site such as facebook.com and a ProseMirror site such as claude.ai), the "Allow this time" re-prompt check, and the tray indicator check.
- Docs never use em or en dashes.

WRITER NOTES
- The Files list omits `package-lock.json`. Its two `voicetype` version lines are bumped with targeted replacements (nothing else in the lockfile changes, so Task 13's `@playwright/test` entries are untouched), and the release test pins them.
- Task 6 creates `test/unit/manifest.test.js` and Task 11 extends it; this task appends one `describe` block. The block reads files through dynamic imports inside the tests, so it depends only on the file's `describe`, `it` and `expect` imports, whatever else the top of the file declares. Verified with Task 6's file and Task 11's appended block taken from their plan parts: 9 cases pass.
- The dash check builds U+2013 and U+2014 with `String.fromCharCode`: a `\u2013` escape written through the agent file tools came back as the literal character in my scratch copy, which would make the test file itself carry a dash.
- v2.0.0 was tagged on 2026-09-27, so the 2.0.0 changelog heading drops "(unreleased)" and gets that date. The 2.1.0 heading is dated by K. S. Karakostas at tag time (checklist section 14).
- The README screenshots show the v2.0 popup and pill after Tasks 9 and 12; retaking them is checklist section 13 (ledger row 61), not an agent step.
- Whether an "Allow this time" grant survives the permission tab closing is unverified; checklist section 2 records the observed behaviour.

- [ ] **Step 1: Write the failing release tests**

Append this block to the end of `test/unit/manifest.test.js`, after the Task 6 and Task 11 cases (the file already imports `describe`, `it` and `expect` from `vitest`):

```js
describe('release 2.1.0', () => {
  // Reads files itself so this block works whatever the imports at the top of the file are.
  async function readRoot(name) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    return fs.readFileSync(path.join(import.meta.dirname, '..', '..', name), 'utf8');
  }

  it('manifest and package versions are equal', async () => {
    const { version } = JSON.parse(await readRoot('manifest.json'));
    const pkg = JSON.parse(await readRoot('package.json'));
    const lock = JSON.parse(await readRoot('package-lock.json'));
    expect(version).toBe('2.1.0');
    expect(pkg.version).toBe(version);
    expect(lock.version).toBe(version);
    expect(lock.packages[''].version).toBe(version);
  });

  it('the changelog and the README badge name the manifest version', async () => {
    const { version } = JSON.parse(await readRoot('manifest.json'));
    expect((await readRoot('CHANGELOG.md')).match(/^## (\S+)/m)[1]).toBe(version);
    expect(await readRoot('README.md')).toContain(`badge/version-${version}-`);
  });

  it('release docs carry no em or en dashes', async () => {
    const dashes = [0x2013, 0x2014].map((code) => String.fromCharCode(code));
    const docs = ['README.md', 'CHANGELOG.md', 'PRIVACY.md', 'docs/superpowers/plans/2026-09-27-phase-1-smoke-checklist.md'];
    for (const name of docs) {
      const text = await readRoot(name);
      for (const dash of dashes) expect(text.includes(dash), `${name} contains U+${dash.charCodeAt(0).toString(16)}`).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/manifest.test.js
```

Expected: 2 failed, 7 passed. "manifest and package versions are equal" fails with `expected '2.0.0' to be '2.1.0'`; "release docs carry no em or en dashes" fails with `ENOENT` on `docs/superpowers/plans/2026-09-27-phase-1-smoke-checklist.md`. Task 6's four cases and Task 11's two pass, and so does "the changelog and the README badge name the manifest version" (every file still says 2.0.0).

- [ ] **Step 3: Bump the version to 2.1.0**

In `manifest.json`, replace:

```json
  "version": "2.0.0",
```

with:

```json
  "version": "2.1.0",
```

In `package.json` (which by now carries Task 1's `engines` and Task 13's `@playwright/test` and `test:e2e`), replace the version line only:

```json
  "version": "2.0.0",
```

with:

```json
  "version": "2.1.0",
```

In `package-lock.json`, replace the root entry (two-space indent):

```json
  "name": "voicetype",
  "version": "2.0.0",
```

with:

```json
  "name": "voicetype",
  "version": "2.1.0",
```

and the `packages[""]` entry (six-space indent):

```json
      "name": "voicetype",
      "version": "2.0.0",
```

with:

```json
      "name": "voicetype",
      "version": "2.1.0",
```

- [ ] **Step 4: Add the 2.1.0 changelog entry**

In `CHANGELOG.md`, replace:

```markdown
# Changelog

## 2.0.0 (unreleased)
```

with:

```markdown
# Changelog

## 2.1.0 (unreleased)

### Added
- Hold to talk: hold the hotkey while you speak and let go to insert the text. A quick tap starts recording and a second tap stops it. Default `Ctrl+Shift+Space`.
- Hotkey recorder in the popup (Recording, Hotkey): click it and press a new combination with Ctrl, Alt or Cmd; Esc cancels.
- Silence auto-stop: recording stops after 2, 3 or 5 seconds of silence once you have spoken. Off by default.
- Spoken-language hints (Auto, English, Greek, Spanish, French, German, Italian, Portuguese) and a vocabulary list, one term per line, in the popup. Both are sent to the provider with the audio.
- A one-time microphone permission tab. VoiceType records in its own extension page, so one grant covers every site, including pages whose Permissions-Policy blocks the microphone.
- Dictation into fields inside iframes (same-origin and cross-origin) and inside open shadow roots.
- The hotkey works with no field focused; the text goes to the clipboard.
- The pill menu shows the hotkey, and a provider without a key is marked "no key".
- Dark mode for the popup, following the system setting.
- `npm run test:e2e`: an end-to-end Playwright smoke in Chromium with a fake microphone and stubbed provider endpoints.

### Changed
- Minimum Chrome version is 140.
- The text goes to the field that had focus when you started recording. If focus moved or the field disappeared before the text arrived, the text is copied to the clipboard with a notice; it never lands in another field.
- Insertion rebuilt. One `Ctrl+Z` removes exactly the dictated text in text boxes. Rich editors (Gmail, Notion, Slack, ChatGPT, Lexical editors such as Facebook's, ProseMirror editors such as claude.ai) receive multi-line text. When an insert cannot be confirmed, the text is also put on the clipboard with a notice and is never inserted a second time. Google Docs goes straight to the clipboard.
- Recording happens in an extension page instead of the website. The website no longer gets microphone access or shows a microphone prompt; Chrome shows its microphone indicator in the system tray or menu bar while recording, and the microphone is released after every recording.
- The pill is isolated from page styles (closed Shadow DOM) and draws its own icons. It follows the field while you scroll, moves to the other side near the window edges, and opens its menu upward near the bottom.
- Errors and warnings in the pill stay 6 seconds, other messages 2.5 seconds, and never sit under the open menu.
- The popup is one column with Provider, Recording, Speech, Modes, Usage and About sections. Every control saves on change; a save that fails is undone on screen and explained. A key saves when you paste it and click away. Clear history and Reset ask for a second click instead of a browser dialog, and Reset keeps your keys, provider, spoken languages and vocabulary.
- One recording at a time across tabs: another tab gets "VoiceType is busy in another tab. Try again in a moment."
- Settings changed in the popup reach open tabs at once.
- After an install or update, open tabs get the new version without a page reload. A tab that cannot be switched over shows "VoiceType was updated. Reload this page."
- API keys are readable only by the background service worker and the popup. Web pages and the in-page script never receive them.
- Permissions: `offscreen` added; host access is `<all_urls>` again, used to put the in-page script back into open tabs after an install or update. The install warning is unchanged, because the in-page script already ran on all sites.
- Changing the mode, provider or translate target from the pill saves only that field, so it no longer overwrites changes made in the popup.
- Building from source needs Node 20.19+, 22.13+ or 24+.

### Fixed
- Closing or leaving a tab while it records cancels the recording and releases the microphone; nothing is sent to the provider, and another tab can start at once.
- Recording no longer hangs when the window loses focus during hold to talk, or when the extension is reloaded mid-recording.
- Malformed stored settings (a mode named `constructor`, a settings version stored as text, invalid limits) are repaired instead of breaking the popup or blanking the keys.
- Two dictations that finish at the same time are both counted in usage, and a damaged usage history is repaired on read.
- Revealed password fields (inputs whose `autocomplete` ends in `-password`) never show the pill.
- Text dictated at the end of a rich-text field stays inside its last paragraph.
- On plain `http` pages without the Clipboard API, the clipboard fallback still works.
- Vocabulary terms and hints are shortened without splitting emoji or other characters.
- An expired Gemini key is reported as a rejected key, and key redaction also catches keys joined to other text.
- A key or translate language with stray spaces is trimmed before use, and a blank failure from the text model reads "Text model failed.".

### Removed
- The Chrome keyboard shortcut entry (`commands`). VoiceType handles the hotkey itself; set it in the popup.
- The `activeTab` permission.
- `content.css`; the pill's styles live inside its shadow root.
- The maximum recording length in the pill menu; set it in the popup.

## 2.0.0 (2026-09-27)
```

- [ ] **Step 5: Update the README**

Each replacement quotes the current text exactly.

Replace the badges:

````markdown
  <img src="https://img.shields.io/badge/version-2.0.0-purple" alt="Version">
  <img src="https://img.shields.io/badge/platform-Chrome-blue" alt="Platform">
````

with:

````markdown
  <img src="https://img.shields.io/badge/version-2.1.0-purple" alt="Version">
  <img src="https://img.shields.io/badge/Chrome-140%2B-blue" alt="Chrome 140 or newer">
````

Replace the shortcut feature cell:

````markdown
### ⌨️ Keyboard Shortcuts
Start and stop recording without touching your mouse. Customizable hotkey support.
````

with:

````markdown
### ⌨️ Hold to Talk
Hold the hotkey while you speak and let go to insert, or tap to start and tap again to stop. Works in iframes and shadow DOM fields too.
````

Replace the privacy feature cell:

````markdown
Keys stay in your browser's local extension storage, never synced. Audio goes straight to the provider you chose. No server of ours exists.
````

with:

````markdown
Keys stay in your browser's local extension storage, readable only by VoiceType's background and popup, never synced. Audio goes straight to the provider you chose. No server of ours exists.
````

Replace the Node requirement:

````markdown
# Clone the repository and build (requires Node.js 20+)
````

with:

````markdown
# Clone the repository and build (requires Node.js 20.19+, 22.13+ or 24+)
````

Replace the Chrome requirement:

````markdown
Then in Chrome:
1. Go to `chrome://extensions/`
````

with:

````markdown
Then in Chrome 140 or newer:
1. Go to `chrome://extensions/`
````

Replace Configure & Go:

````markdown
1. Click the VoiceType icon in Chrome
2. Paste your API key (settings save automatically)
3. Click into any text field and start talking!
````

with:

````markdown
1. Click the VoiceType icon in Chrome
2. Paste your API key (it saves as soon as you click away)
3. Click into any text field, then click **REC** on the pill or hold `Ctrl+Shift+Space` while you speak
4. The first time, VoiceType opens a tab asking for the microphone. Choose **Allow while visiting the site**, then press REC again
````

Replace the Keyboard Shortcut section (it becomes Hotkey, Microphone and Where the Text Goes):

````markdown
## ⌨️ Keyboard Shortcut

`Ctrl+Shift+Space` (Mac `Command+Shift+Space`) starts and stops recording. Chrome assigns it automatically on install.

If it conflicts with another extension or your system, set a different one:

1. Go to `chrome://extensions/shortcuts`
2. Find **VoiceType**
3. Click the pencil icon ✏️
4. Press your preferred shortcut
````

with:

````markdown
## ⌨️ Hotkey

`Ctrl+Shift+Space` by default (the Control key on a Mac too).

- **Hold** it while you speak and let go: the text is inserted.
- **Tap** it to start recording and tap again to stop.
- Pressed while the text is still being processed, the pill says "Still processing".

To change it, open the popup, click the key under **Recording, Hotkey** and press the new combination. It needs Ctrl, Alt or Cmd plus a key; Esc cancels. Chrome keeps some shortcuts for itself (such as `Ctrl+T` or `Ctrl+W`) and never passes them to a page, so pick something else.

The hotkey works on web pages once they have loaded. Extensions cannot run on `chrome://` pages, the Chrome Web Store or the new tab page, so it does nothing there.

---

## 🎙️ Microphone

VoiceType records in its own extension page, not in the website you are typing on. The website never gets your microphone, and one permission covers every site, including sites whose policy blocks the microphone.

The first recording opens a VoiceType tab that asks for the microphone. Choose **Allow while visiting the site**. "Allow this time" can expire as soon as that tab closes, and then VoiceType has to ask again.

While VoiceType records, Chrome shows its microphone indicator in the system tray or menu bar; the website's tab shows none. The microphone is released after every recording.

Blocked it by mistake? Open `chrome://settings/content/microphone`, remove VoiceType from the blocked list, and press REC again.

---

## 📍 Where the Text Goes

- Into the field that had focus when you started recording, at the caret.
- If you clicked somewhere else before the text arrived, or the field disappeared, the text is copied to the clipboard and the pill says so. It never lands in a different field.
- With no field focused (hotkey only), the text is copied to the clipboard.
- Google Docs does not accept inserted text; VoiceType copies it and you paste with `Ctrl+V`.
- In rich editors (Gmail, Notion, Slack, ChatGPT, Facebook, claude.ai and others), if VoiceType cannot confirm the insert, the text is also on the clipboard. It is never inserted twice.
- In text boxes, one `Ctrl+Z` removes exactly the dictated text.
- Fields inside iframes and open shadow roots work too.
````

Replace the provider FAQ:

````markdown
Both are accurate for dictation. Gemini's transcribe model removes filler words on its own. OpenAI is the default. Costs are comparable; see the Usage tab.
````

with:

````markdown
Both are accurate for dictation. Gemini's transcribe model removes filler words on its own. OpenAI is the default. Costs are comparable; see the Usage section of the popup.
````

Replace the shortcut FAQ (a clipboard FAQ follows it):

````markdown
<summary><b>Why doesn't the shortcut work?</b></summary>
<br>
The shortcut <code>Ctrl+Shift+Space</code> (Mac <code>Command+Shift+Space</code>) is assigned automatically on install. If it conflicts with another extension or your system, set a different one at <code>chrome://extensions/shortcuts</code>.
</details>
````

with:

````markdown
<summary><b>Why doesn't the hotkey work?</b></summary>
<br>
VoiceType listens for the hotkey inside web pages, so click into the page first. It cannot work on <code>chrome://</code> pages, the Chrome Web Store or the new tab page. Chrome keeps some shortcuts such as <code>Ctrl+T</code> for itself; pick another combination in the popup under Recording, Hotkey.
</details>

<details>
<summary><b>Why did my text go to the clipboard?</b></summary>
<br>
The field you started in lost focus or disappeared before the text arrived, no field was focused, or the site (Google Docs) does not accept inserted text. VoiceType never types into a different field. Paste with <code>Ctrl+V</code>.
</details>
````

Replace the short recordings FAQ:

````markdown
Recordings shorter than the minimum you set (default 1 second) are treated as accidental clicks. Change it in Settings.
````

with:

````markdown
Recordings shorter than the minimum you set (default 1 second) are treated as accidental clicks. Change it in the popup under Recording, Minimum length.
````

Replace the troubleshooting rows:

````markdown
| **"Add API key" error** | Click the extension icon → paste your API key (it saves automatically) |
| **Microphone not working** | Click the 🔒 in address bar → Allow microphone |
| **Shortcut doesn't work** | `Ctrl+Shift+Space` (Mac `Command+Shift+Space`) is assigned on install; if it conflicts with another extension or your system, set a different one at `chrome://extensions/shortcuts` |
````

with:

````markdown
| **"Add an API key" message** | Click the extension icon → paste your API key (it saves as soon as you click away) |
| **Microphone not working** | VoiceType asks in its own tab, not in the site's address bar. If the pill says the microphone is blocked, open `chrome://settings/content/microphone`, remove VoiceType from the blocked list, and press REC again |
| **Asked for the microphone every time** | You chose "Allow this time". Reset it at `chrome://settings/content/microphone`, press REC and choose **Allow while visiting the site** |
| **Hotkey doesn't work** | Click into the page first. Browser shortcuts such as `Ctrl+T` never reach a page; set another hotkey in the popup (Recording, Hotkey) |
| **"VoiceType was updated. Reload this page."** | That tab could not be switched to the new version; reload the page |
| **Text went to the clipboard** | Focus moved before the text arrived, or the site does not accept inserted text. Paste with `Ctrl+V` |
````

Replace the first privacy bullet:

````markdown
- ✅ API keys stored in plain text in Chrome's local extension storage, never synced, never sent anywhere but the provider
````

with:

````markdown
- ✅ API keys stored in plain text in Chrome's local extension storage, readable only by VoiceType's background service worker and popup, never synced, never sent anywhere but the provider
- ✅ Web pages never receive your keys or your microphone; audio is recorded in VoiceType's own extension page
````

Replace the License heading (a Development section goes before it):

````markdown
## 📄 License
````

with:

````markdown
## 🧪 Development

```bash
npm install
npm test            # unit tests (Vitest)
npm run build       # bundle into dist/
npm run watch       # rebuild on change
npm run test:e2e    # build, then the Playwright smoke in Chromium
```

The end-to-end smoke loads `dist/` into Playwright's Chromium with a fake microphone, stubs the provider endpoints and blocks every other https request, so it needs no API key. Install its browser once with `npx playwright install --no-shell chromium` (add `--with-deps` on a fresh Linux machine).

---

## 📄 License
````

- [ ] **Step 6: Update the privacy policy**

In `PRIVACY.md` ("Last Updated: September 2026" stays):

Replace the settings item:

```markdown
3. **Settings**: Your preferences (provider, modes, recording limits)
```

with:

```markdown
3. **Settings**: Your preferences (provider, modes, recording limits, silence auto-stop, hotkey, spoken languages, vocabulary)
```

Replace the last "What We Do NOT Collect" item:

```markdown
- Any data for advertising purposes
```

with:

```markdown
- Any data for advertising purposes
- Clipboard contents (VoiceType writes dictated text to the clipboard when it cannot insert it, and never reads the clipboard)
```

Replace the end of the key storage bullet:

```markdown
Anyone, or any program, with access to that folder can read them.
```

with:

```markdown
Anyone, or any program, with access to that folder can read them.
- Inside Chrome, the keys are readable only by VoiceType's own trusted pages: the background service worker and the popup. VoiceType restricts its local storage with `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`, so its in-page script cannot read that storage at all. The in-page script receives settings without keys, and no key is ever sent to a web page.
```

Replace the start of Data Transmission:

```markdown
Audio data is transmitted only to:
```

with:

```markdown
Audio is recorded in an extension document that belongs to VoiceType, not to the website you are on. The website never receives your microphone or your audio. The microphone is released after every recording.

Audio data is transmitted only to:
```

Replace the mode processing sentence:

```markdown
Mode processing sends the transcript text, not the audio, to the text model of the same provider you chose for speech recognition.
```

with:

```markdown
Mode processing sends the transcript text, not the audio, to the text model of the same provider you chose for speech recognition. Your spoken-language hints and vocabulary terms, when set, are sent with the audio to the speech recognition model.
```

Replace the start of Data Retention (a Permissions section goes before it):

```markdown
## Data Retention

- Audio recordings are processed in memory and immediately discarded after transcription
```

with:

```markdown
## Permissions

- **Access to all sites** (`<all_urls>`): the in-page script that shows the pill runs on every site so you can dictate anywhere. VoiceType uses the host permission itself only to put that script back into tabs that are already open when VoiceType is installed or updated. The script looks only at the field you focus and dictate into; it does not read or send page content.
- **scripting**: the re-injection described above.
- **offscreen**: the extension document that records the microphone.
- **storage**: settings, keys and usage statistics on this device.

## Data Retention

- Audio recordings are processed in memory and immediately discarded after transcription. Closing or leaving a tab while it records cancels the recording without sending it
```

Replace the usage statistics right:

```markdown
- **Clear usage statistics** through the Usage tab
```

with:

```markdown
- **Clear usage statistics** through the Usage section of the popup
```

- [ ] **Step 7: Create the smoke checklist**

`docs/superpowers/plans/2026-09-27-phase-1-smoke-checklist.md`:

````markdown
# Phase 1 end-to-end smoke checklist (Task 14, for K. S. Karakostas)

Branch `phase-1`, version 2.1.0. Needs Chrome 140 or newer, a microphone, and a real key for each provider.

Build first:

```bash
npm install
npm test
npm run build
npx playwright install --no-shell chromium   # once
npm run test:e2e
```

Load `dist/` unpacked (chrome://extensions, Developer mode, Load unpacked) in a fresh profile, for example `google-chrome --user-data-dir="$(mktemp -d)"`. After every rebuild, click the reload icon on the VoiceType card.

Serve the fixtures over http in a second terminal: `node test/fixtures/serve.mjs`, then open `http://localhost:8765/fields.html`. Open it on `localhost`, not `127.0.0.1`: the cross-origin iframe on that page loads from `127.0.0.1`. `hostile.html` and `pp-denied.html` are linked from the page.

Note each item as pass, fail (with the exact on-screen text) or n/a.

## 1. Install and popup (spec 6.6)
- Popup: one column with Provider, Recording, Speech, Modes, Usage and About; About shows "Version 2.1.0". No errors in the popup console (right-click the popup, Inspect) or the service worker console (chrome://extensions, "service worker").
- chrome://extensions/shortcuts lists no VoiceType shortcut.
- Paste an OpenAI key, then click on the page so the popup closes, without Tab or Enter. Reopen: the key field shows the masked key ending "(saved)" and the status says Ready.
- Paste a key and wait one second with the cursor still in the field: "Key saved" appears.
- Test: "OpenAI key works". A wrong key: a friendly error with no key fragment on screen.
- Gemini: the same with a key beginning `AQ.`.
- Clear: the status says "Add API key".
- Clear history: the first click changes the button to "Click again to clear usage history"; the second clears and shows "Usage history cleared". Waiting 3 s after the first click reverts the label. The popup never closes on these clicks.
- Reset to defaults: the first click reads "Click again to reset modes, prompts, recording limits, silence auto-stop and hotkey". After the second click the keys, provider, spoken languages and vocabulary are unchanged; modes, limits, silence auto-stop and the hotkey are back to defaults.
- Keyboard: Tab through the whole popup; every control shows a visible focus ring.
- Dark mode: switch the OS (or chrome://settings/appearance) to dark; the popup follows and stays readable, including the usage table and the toasts.
- Pill within one second: in the popup change the active mode, the provider, Silence auto-stop and the hotkey; close the popup and open the pill menu on the fixtures page within a second. The menu shows the new mode, provider and hotkey hint.
- The other direction: change the mode and the translate target from the pill menu, then reopen the popup. It shows the new mode, and every earlier popup edit (limits, vocabulary, languages) is intact.

## 2. Microphone permission (spec 6.1 as amended in 6.0)
Use a fresh profile.
- First REC on the fixtures textarea: the pill shows "Allow the microphone in the VoiceType tab that just opened, then press REC again." and exactly one VoiceType tab opens. Its text asks for "Allow while visiting the site".
- Choose "Allow while visiting the site": the tab shows "Microphone allowed. You can close this tab and press REC again." and closes itself after about 1.5 s. The pill shows "Microphone allowed. Press REC again." and does not start recording by itself.
- REC records. Quit and restart Chrome: REC records with no prompt. The prompt appears once per profile.
- "Allow this time" re-prompt check: in another fresh profile choose "Allow this time". Dictate three times, waiting a minute before the third. Note whether and when the permission tab opens again. If it reopens every time, that is the expected cost of "Allow this time" and the permission page copy covers it. Then reset VoiceType at chrome://settings/content/microphone, press REC, choose "Allow while visiting the site": no further prompts.
- Close the permission tab without choosing: nothing records. The next REC opens the tab once again (one tab per REC press, never a loop).
- Blocked (Review Focus 3): at chrome://settings/content/microphone move VoiceType (`chrome-extension://<id>`) to "Not allowed". REC shows "Microphone blocked for VoiceType. Allow it at chrome://settings/content/microphone." and the pill returns to idle. Allow it again: REC works at once, no "busy" message.
- No microphone (unplug it or disable the input device): "No microphone found." Plug it back: REC works.

## 3. Recording and the tray indicator (spec 6.1)
- Tray check: while recording, Chrome's microphone indicator is present in the system tray (Linux, Windows) or menu bar (macOS). The web page's own tab shows no microphone icon.
- The tray indicator disappears within about a second after each of: stop with REC; release of a held hotkey; a too-short recording (click REC twice quickly: "Too short, ignored"); max time; silence auto-stop; tab closed while recording; a provider error (wrong key).
- Max time: set Maximum length to 30 s and talk for 35 s: "Max time reached", then the transcript.
- The pill's glow follows your voice while recording.
- pp-denied.html (served with `Permissions-Policy: microphone=()`; confirm in DevTools, Network, Response Headers): dictation into its textarea works.
- Busy: start recording in tab A, press REC in tab B: tab B shows "VoiceType is busy in another tab. Try again in a moment."; tab A keeps recording.
- Tab closed while recording (Review Focus 2): record in tab A and close it. The tray indicator goes off; the sessions count in the popup's Usage section does not change (no provider call); REC in tab B starts at once. Repeat by navigating tab A to another URL instead of closing it.

## 4. Pill and positioning (spec 6.2, 6.3)
- hostile.html (`button { all: unset } * { font-size: 30px !important }`): the pill and its menu look the same as on fields.html (size, font, icons, layout).
- DevTools console on the fixtures page: `document.querySelector('voicetype-host').shadowRoot` is `null` (closed root).
- The field inside the scrolling container: the pill follows it while the container scrolls and while the page scrolls.
- The left-flush input: the pill sits on its right.
- The bottom-edge field: the menu opens upward.
- Resize the window: the pill stays attached to the field.
- Status timing: an error (wrong key) stays about 6 s; "Done $0.00x" stays about 2.5 s. With the menu open, the status never covers the menu.
- Literal names: create a custom mode named `<img src=x onerror=alert(1)>` in the popup. The popup list and the pill menu show that text literally and no alert fires. Delete the mode afterwards.
- Menu content: modes with the active one marked; the translate row only when Translate is active; the provider switch with "no key" on a provider without a key; a usage line such as `Today $0.004 (3), all time $0.21`; the hotkey hint.

## 5. Frames and shadow roots (spec 6.4)
- Same-origin iframe field: the pill shows inside the iframe only, and dictation lands in that field.
- Cross-origin iframe field (from `127.0.0.1`): the same.
- Input inside the open shadow root: pill and dictation work.
- Contenteditable inside the open shadow root: put the caret after its first word and dictate. The text lands at the caret, not at the end.
- Only one pill is visible at a time across the page and its frames.

## 6. Insertion (spec 6.5 as amended in 6.0)
- Ctrl+Z exactness: in the textarea type "Hello ", dictate "one two three", press Ctrl+Z once. Only the dictated text disappears; "Hello " stays. Repeat typing right up to the moment you press REC: still exact.
- The same check in the text input and in the fixtures contenteditable.
- Focus moved (Review Focus 4): start in the textarea, click into the text input while it processes. The text input stays untouched and the pill shows "The field lost focus. Text copied to clipboard."; Ctrl+V pastes the text.
- Field removed: start in the textarea, and while it processes run `document.getElementById('ta').remove()` in the console. The pill shows "The field lost focus. Text copied to clipboard." (or "Could not insert. Click here to copy the text.", and clicking copies it).
- No field: click on empty page space, hold the hotkey and speak. The pill appears at the bottom right corner and ends with "Copied to clipboard."
- Hidden tab: switch tabs while it processes and come back. The text is inserted or on the clipboard with a notice, never lost.
- No pill on the password field. In DevTools add `autocomplete="current-password"` to the text input and focus it: no pill.

Site matrix. For each site dictate one sentence in Default mode, then one Email mode dictation (several paragraphs), then press Ctrl+Z once. Expected: the text appears exactly once with its paragraphs, or the pill says "Could not confirm the insert. The text is also on the clipboard." and the field shows the text at most once. Never twice.

| Site | Field | Default | Email (multi-line) | Ctrl+Z | Notes |
|---|---|---|---|---|---|
| Gmail | compose body | | | | |
| Google Docs | document body | expected: "Copied to clipboard. The field could not be edited." | expected: same | n/a | paste with Ctrl+V |
| Notion | page body | | | | |
| Slack | message box | | | | |
| ChatGPT | prompt box | | | | |
| GitHub | issue comment textarea | | | | |
| X | post composer | | | | |
| LinkedIn | post composer | | | | |
| facebook.com (Lexical) | post or comment box | | | | |
| claude.ai (ProseMirror) | prompt box | | | | |

## 7. Update and reload (spec 6.7, Review Focus 1)
- Reload with three tabs open: open fields.html, a GitHub issue and one other site from the matrix, and focus a field in each. Click reload on the VoiceType card. Without reloading any page, each tab shows exactly one pill on focus (`document.querySelectorAll('voicetype-host').length` is `1` in each tab's console) and dictation works in each.
- Reload mid-recording: start recording, then reload the extension. The tray indicator goes off, the pill is not stuck in recording, and the next dictation in that tab works (or the pill shows "VoiceType was updated. Reload this page." and dictation works after a page reload).
- Reload mid-processing: stop a recording and reload the extension before the result arrives. Same expectations.
- Disabled extension: toggle VoiceType off on chrome://extensions, then click REC on a pill that is still on screen. The pill shows "VoiceType was updated. Reload this page." and no later action changes that status. Toggle VoiceType on and reload the page: it works.

## 8. Hotkey (spec 6.8, Review Focus 5)
- Hold Ctrl+Shift+Space for 4 s while speaking, then release: the transcript is inserted.
- Tap, speak, tap: recording starts and stops.
- While holding for 4 s, key auto-repeat neither restarts nor stops the recording (one start per press).
- Hold, release Ctrl first, then Space: recording stops.
- Hold, press Alt+Tab to another window mid-hold: recording stops and processes instead of hanging.
- Press the hotkey while it processes: "Still processing".
- Popup recorder: click the hotkey button ("Press keys") and press Ctrl+Alt+D. It saves; within a second the pill menu hint shows Ctrl+Alt+D; the new chord works on a page and the old one does nothing.
- In the recorder press Shift+Space: "Use Ctrl, Alt or Cmd with a key". Press Esc while it says "Press keys": cancelled, and the popup stays open.
- Set the hotkey back to Ctrl+Shift+Space.
- macOS only: the popup and the pill hint use Ctrl, Option, Shift and Cmd.

## 9. Silence auto-stop (spec 6.9)
- Set Silence auto-stop to 2 s. Speak a sentence, then stay silent: recording stops about 2 s later with "Stopped after silence", then the transcript arrives.
- Stay silent from the start: it does not stop on its own (speech must come first). Stop with REC.
- Off: silence never stops a recording.

## 10. Provider matrix (regression)
| Mode | Say | Expect in the textarea |
|---|---|---|
| Default | "The meeting is at three, bring the Palowise deck." | Sentence, punctuated |
| Email | "Tell Maria the report is late and I will send it Friday." | Greeting, body, sign-off, no placeholders |
| Translate to Greek (target from the pill menu) | "Good morning, how are you?" | Greek only |
| Instruct | "What is the capital of Portugal?" | One-line answer |

Run each row on both providers and note the cost in "Done <cost>". Then set spoken languages to English and Greek and add "Palowise" to the vocabulary: a Default dictation containing the word spells it "Palowise".

## 11. Keys stay out of pages (D10)
- On the fixtures page open DevTools, Console, and pick the VoiceType content script in the context dropdown. `await chrome.storage.local.get('settings')` rejects with "Access to storage is not allowed from this context."
- In the same context, `await chrome.runtime.sendMessage({ action: 'getSettings' })` returns settings with `hasKey` and without `keys`.

## 12. Upgrade from 2.0.0
- A profile running v2.0.0 with both keys and one custom mode: rebuild 2.1.0 into the same `dist/` and reload the extension. Both keys work, the custom mode exists, the hotkey reads Ctrl+Shift+Space, Silence auto-stop is Off, and open tabs get the new pill without a page reload.

## 13. Screenshots (ledger row 61)
Retake the README screenshots from the new UI: `screenshots/in_use.png` (pill recording next to a field), `screenshots/floating_expand.png` (pill menu open), `screenshots/settings.png` (popup Provider and Recording), `screenshots/modes.png` (popup Modes), `screenshots/usage.png` (popup Usage). Then:

```bash
git add screenshots
git commit -m "Retake the screenshots for 2.1.0"
```

## 14. Tag
Only after sections 1 to 12 pass:

```bash
npm test
npm run test:e2e
```

In `CHANGELOG.md` change `## 2.1.0 (unreleased)` to `## 2.1.0 (<today's date>)`, then:

```bash
git add CHANGELOG.md
git commit -m "Date the 2.1.0 changelog entry"
git tag -a v2.1.0 -m "VoiceType 2.1.0: offscreen recorder, Shadow DOM pill, hold to talk, insertion ladder v2"
```
````

- [ ] **Step 8: Run the release tests to verify they pass**

```bash
npx vitest run test/unit/manifest.test.js
```

Expected: 9 passed (Task 6's four, Task 11's two, the three release cases).

- [ ] **Step 9: Run the full suite and the build**

```bash
npm test
npm run build
node -p "require('./dist/manifest.json').version"
```

Expected: every file passes (report N/N); the build ends with `Done`; the last command prints `2.1.0`.

- [ ] **Step 10: Commit**

```bash
git add manifest.json package.json package-lock.json CHANGELOG.md README.md PRIVACY.md docs/superpowers/plans/2026-09-27-phase-1-smoke-checklist.md test/unit/manifest.test.js
git commit -m "Bump to 2.1.0 and document Phase 1 in the changelog, README, privacy policy and smoke checklist"
```

- [ ] **Step 11: Hand the smoke checklist to K. S. Karakostas**

The browser smoke needs Chrome, a microphone and real keys. Report the N/N count, the build result and the checklist path. Do not tag: v2.1.0 is tagged by K. S. Karakostas once the checklist passes (its section 14), as with v2.0.0.

---

## Self-review notes

**Spec coverage (section 6 with the 6.0 amendments, plus M2 and M3):** 6.1 offscreen recorder: Tasks 5 and 6. 6.2 Shadow DOM pill: Task 9 (hostile fixture in Task 13). 6.3 positioning: Tasks 8, 9, 11. 6.4 frames and shadow hosts: Task 11 (manifest `all_frames`, `match_about_blank`, `composedPath`) and Task 13 fixtures. 6.5 insertion ladder v2: Task 7. 6.6 popup: Task 12. 6.7 orphan handling: Task 6 (re-injection) and Task 11 (teardown handshake, terminal notice). 6.8 hotkey: Tasks 3, 10, 11, 12. 6.9 silence auto-stop: Tasks 3, 5, 12. 6.10 Playwright smoke: Task 13. M2: Tasks 4, 6, 11. M3: Task 9 (and the Global Constraint). Version, changelog, README, privacy and the browser checklist: Task 14.

**Placeholder scan:** no TBD, TODO or "similar to" text; every code step carries full file contents or quoted replacements. No em dashes, en dashes or invisible characters in the plan.

**Type consistency:** every `MSG` key used in Tasks 4 to 13 exists in Task 3's `messages.js`; the legacy `TOGGLE_RECORDING` uses are confined to Task 4's interim `index.js` and disappear in Task 6, and Task 11 deletes the legacy keys. Shared symbols map to their producing tasks: `chord.js` (3) to 9, 10, 11, 12; `toPublicSettings` and `applySettingsPatch` (3) to 4 and 6; `createDictate`, `senderKind`, `tabs.js` (4) to 6; `computePillPosition`, `computeMenuPlacement`, `watchAnchor` (8) to 9 and 11; `insertText` outcomes and `copyText` (7) to 11; `createChordTracker` (10) to 11. Each part was verified by its writer against the final text of the tasks it consumes, then the whole plan was replayed from its text alone on a fresh copy: every edit applied exactly once, the suite was green after all 25 commits (ending at 32 files, 587/587), every build was clean, and `npm run test:e2e` passed 3/3 after the two Task 13 fixes recorded in its writer notes.

**Review Focus pins:** all five lines have their named tests: Task 11 `controller.test.js` (items 1, 4), Task 6 `recorder.test.js` (items 1, 2, 3, plus "cancel while starting ignores the late start response"), Task 5 `capture.test.js` (item 3), Task 10 `hotkey.test.js` (item 5).

**Known deferrals:** a tab closed while its dictation is processing drops the result (Phase 2 history, spec 7.3); browser-reserved chords (for example Ctrl+T) can be recorded as the hotkey but never reach a page (documented in the README and the checklist); Ctrl+Z exactness, the tray indicator, the "Allow this time" re-prompt and the real-site matrix are manual checks in the Task 14 checklist.
