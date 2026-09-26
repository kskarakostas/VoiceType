# VoiceType 2.0 Roadmap and Design Spec

Prepared 2026-09-26 for K. S. Karakostas. Source: the code and UX audit of v1.7.6, the API verification pass of the same date, and the four decisions recorded in section 2.

Companion documents:
- Phase 0 executable plan: `docs/superpowers/plans/2026-09-26-phase-0-foundation-and-fixes.md`
- Phase 1 and Phase 2 executable plans are written when each phase starts, from the code as it then exists. Their designs, file maps, interfaces and acceptance criteria are fixed here.

## 1. Positioning

**One line:** BYOK dictation for Chrome with cost transparency.

**Who it is for:** people who already hold an OpenAI or Gemini API key, want dictation in any web field, refuse another subscription, and want to see what each utterance cost.

**Why this gap is real (Sept 2026 landscape):**
- Leading native dictation apps (Wispr Flow, Typeless, Willow, Monologue) ship no Chrome extension.
- Bring-your-own-key exists only in Superwhisper (desktop), VoxWrite and small OSS projects.
- Nobody shows per-provider cost. Top complaints in the category are subscription fatigue, over-editing, insertion failures and privacy incidents.

**What VoiceType promises:** your key, your provider, no server in between, every session priced, raw transcript always recoverable, MIT.

**Distribution:** GitHub releases, load-unpacked. No Chrome Web Store submission in this roadmap. Consequences: `<all_urls>` content script is acceptable; onboarding targets developers; store assets are out of scope.

## 2. Decisions locked

| # | Decision | Choice | Consequence |
|---|---|---|---|
| D1 | Publication target | GitHub release only | Keep `<all_urls>` content script; ship `dist/` zip per tag |
| D2 | API key storage | Plaintext in `chrome.storage.local`, never `sync` | Delete XOR scheme; one-time recovery migration; PRIVACY.md states it plainly |
| D3 | Tooling | Node toolchain: esbuild bundling, Vitest tests, plain JS with JSDoc types | `src/` layout, `dist/` output, `npm test` gate |
| D4 | Mode processing | Two-stage on both providers: dedicated STT model, then a text model applies the mode prompt | Default mode is STT only (one round trip); raw transcript is kept for undo |
| D5 | Model choice per provider | One STT model and one text model per provider, fixed in a registry | Model selector removed from UI; registry is the single place to change IDs and prices |
| D6 | Gemini STT mode | `audioTranscriptionConfig.mode: "SMART"` | Fillers and self-corrections removed by the provider; verbatim toggle deferred |
| D7 | Hotkey ownership (Phase 1) | Content script captures the chord; `commands` entry removed | Enables hold-to-talk; popup gets a key recorder |
| D8 | Recording location (Phase 1) | Offscreen document under the extension origin | One mic grant for all sites; content script never calls `getUserMedia` |
| D9 | In-page UI isolation (Phase 1) | Shadow DOM host on `document.documentElement`, `position: fixed` | Page CSS cannot leak in; `content.css` and `web_accessible_resources` removed |

## 3. Global constraints

- Manifest V3. `minimum_chrome_version: "116"` (needed by `chrome.runtime.getContexts` and the offscreen mic sample; adopted from Phase 0 to avoid a later bump).
- Node 20 or newer for the toolchain. No TypeScript compile step. JSDoc `@typedef` for shared shapes.
- Dependencies: `esbuild`, `vitest`, `jsdom` as devDependencies only. Zero runtime dependencies.
- Model IDs, labels and list prices live only in `src/shared/models.js`.
- Message action names live only in `src/shared/messages.js`.
- Default settings and migrations live only in `src/shared/defaults.js`.
- Never put a key in a URL. OpenAI: `Authorization: Bearer`. Gemini: `x-goog-api-key` header.
- Never show a provider's raw error body to the user; map to a friendly message and redact anything matching a key pattern.
- Never treat `input[type=password]` as a dictation target.
- All user-visible prose in English. No em dashes or en dashes anywhere in code comments, UI copy or docs.
- Commit messages carry the change description only. No AI attribution trailers.
- Every phase ends with `npm test` green and a manual smoke pass on `test/fixtures/fields.html`.

## 4. Target architecture

### 4.1 File map (end state after Phase 2)

```
manifest.json                      copied to dist/ unchanged
package.json, build.mjs            esbuild entries + static copy
src/
  shared/
    defaults.js                    DEFAULT_SETTINGS, BUILTIN_MODES, migrateSettings, recoverKey
    models.js                      MODELS, PROVIDERS, LEGACY_PROVIDER_OF_MODEL
    pricing.js                     estimateSttCost, estimateTextCost, formatCost
    messages.js                    MSG constants, JSDoc typedefs for payloads
    text.js                        sanitizeHint, fillTemplate
  background/
    index.js                       SW entry: listeners only, wires router
    router.js                      createRouter(deps), userMessage(err)
    pipeline.js                    runDictation(): transcribe, refine, price
    storage.js                     createStorage(area): settings + usage log
    usage.js                       localDateKey, applyUsage, summarize (pure)
    recorder.js                    (P1) offscreen lifecycle: ensure, start, stop
    providers/
      errors.js                    ProviderError, friendlyHttpError, redact
      openai.js                    transcribe, refine, validateKey, extractOutputText
      gemini.js                    transcribe, refine, validateKey, joinParts
  offscreen/                       (P1)
    offscreen.html, offscreen.js   MediaRecorder + level meter under extension origin
    permission.html, permission.js one-time mic grant page
  content/
    index.js                       entry: focus tracking, orphan guard, message glue
    fields.js                      isValidInput, deepActiveElement
    insert.js                      insertText ladder
    pill.js                        (P1) Shadow DOM component
    pill.css                       (P1) bundled as text into the shadow root
    position.js                    (P1) computePillPosition (pure)
    hotkey.js                      (P1) chord capture, tap vs hold
    content.css                    (P0 only; deleted in P1)
  popup/
    popup.html, popup.js, popup.css
  onboarding/                      (P2)
    onboarding.html, onboarding.js
test/
  fixtures/fields.html             manual + Playwright target page
  unit/**/*.test.js                Vitest
  e2e/                             (P1) Playwright extension smoke
docs/
  superpowers/specs/, superpowers/plans/
```

### 4.2 Runtime flow (end state)

1. User focuses a field. Content script shows the pill anchored to it.
2. User taps or holds the hotkey, or clicks REC. Content asks the service worker to start recording.
3. Service worker ensures the offscreen document exists. Offscreen checks mic permission; if not yet granted, the SW opens `permission.html` once. Offscreen records WebM/Opus at 32 kbps and streams RMS levels to the tab for the glow.
4. Stop. Offscreen posts the audio to the SW.
5. SW runs the pipeline: STT (with language and vocabulary hints), then, when the active mode has a prompt, the text model applies it. Both usage objects are priced from the registry.
6. SW logs usage and returns `{ raw, text, cost }` to the tab.
7. Content inserts via the ladder: `execCommand('insertText')` with verification, then native setter plus `InputEvent`, then paste-event simulation, then clipboard with a notice.
8. Pill shows the outcome and, in Phase 2, the streaming interim text before the final.

### 4.3 Message contract

All messages are `{ action: MSG.X, ...payload }` and answered with a single JSON-serialisable object.

| Action | From | Payload | Response |
|---|---|---|---|
| `getSettings` | popup, content | none | `Settings` (v2) |
| `saveSettings` | popup, content | `{ settings }` | `{ success }` |
| `checkApiKey` | content | none | `{ hasKey }` |
| `validateKey` | popup | `{ provider, key }` | `{ ok, error? }` |
| `transcribe` | content (P0) / offscreen (P1) | `{ audioBase64, mimeType, mode, audioDuration }` | `{ success, text?, raw?, cost?, error? }` |
| `getUsageStats` | popup, content | none | `{ today, last7Days, total }` |
| `clearUsageStats` | popup | none | `{ success }` |
| `toggle-recording` | SW to content | none | `{ received }` |
| `startRecording` / `stopRecording` | content to SW (P1) | none | `{ ok, needsPermission? }` |
| `audioLevel` | offscreen to tab (P1) | `{ level }` | none |
| `dictationResult` | SW to tab (P1) | same as `transcribe` response | none |

### 4.4 Settings schema v2

```js
{
  settingsVersion: 2,
  provider: 'openai' | 'gemini',
  keys: { openai: string, gemini: string },      // plaintext, storage.local only
  activeMode: string,                            // key into modes
  minRecordingTime: number,                      // seconds, default 1
  maxRecordingTime: number,                      // seconds, default 120
  translateTargetLang: string,                   // default 'English'
  languages: string[],                           // ISO 639-1 hints, [] = auto
  keywords: string[],                            // custom vocabulary
  pillGap: number,                               // px, default 8, no UI
  modes: {
    [key]: { name, icon, prompt, builtIn: boolean, hasLanguageOption?: boolean }
  }
}
```

Rules: a mode with an empty `prompt` is STT only. Built-in modes cannot be deleted; their names and icons can be edited; their prompts are user-editable and reset with "Reset to defaults". `{{targetLanguage}}` is the only template variable.

Migration from v1: keys recovered (XOR-decoded when the decode is printable ASCII, otherwise kept as stored), provider preserved, custom modes preserved, built-in prompts replaced (v1 prompts addressed audio; v2 prompts address a transcript), model fields dropped, usage log reset (v1 cost basis was wrong).

### 4.5 Model registry

| Provider | Role | ID | List price used for estimates |
|---|---|---|---|
| OpenAI | STT | `gpt-transcribe` | $0.0045 per minute |
| OpenAI | text | `gpt-6-luna` | $0.10 in / $0.50 out per 1M tokens |
| Gemini | STT | `gemini-3.5-transcribe` | $2.00 audio in / $12.00 out per 1M tokens |
| Gemini | text | `gemini-3.8-flash` | $0.75 in / $3.75 out per 1M through 2026-12-31, then $1.50 / $7.50 |

Legacy IDs (`gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gemini-2.5-flash`, `gemini-3-flash-preview`) are mapped to their provider during migration and never sent again.

## 5. Phase 0: Foundation and fixes

**Goal:** the advertised product works on both providers with current model IDs, keys cannot be corrupted, failures are visible and recoverable, and pure logic is under test. Delivered as v2.0.0.

**Scope:**
1. Toolchain: git init, `package.json`, `build.mjs`, Vitest, `src/` layout, `dist/` output, `.gitignore`.
2. Shared modules: `models.js`, `pricing.js`, `defaults.js` with migration and key recovery, `messages.js`, `text.js`.
3. Providers: OpenAI (`gpt-transcribe`, Responses API with `gpt-6-luna`), Gemini (`gemini-3.5-transcribe` SMART mode, `gemini-3.8-flash`), header auth, friendly errors with key redaction, `validateKey`.
4. Pipeline: transcribe, conditional refine, cost, 60 s timeout, empty-transcript guard.
5. Usage log v2: local dates, per-provider, 90-day retention, `<$0.01` formatting.
6. Background router with injected dependencies; plaintext key storage; lazy migration.
7. Content script patches: start race fix, `isStarting` guard, 32 kbps, `minRecordingTime` honored with a visible "Too short" notice, sticky processing status, 75 s watchdog, insertion ladder with clipboard fallback, password fields excluded, `composedPath` focus target, orphan detection, no eager usage fetch, model row removed.
8. Popup patches: settings v2, autosave on every change, Save and Start Recording buttons removed, pill-gap slider removed, model selects removed, per-provider Test key, any non-empty key accepted, reset preserves both keys, mode editor preserves `builtIn` and `hasLanguageOption`, delete only for custom modes, version from manifest.
9. Manifest: version 2.0.0, min Chrome 116, `web_accessible_resources` removed, `host_permissions` narrowed to the two API origins.
10. Docs: README (versions, model names, honest storage statement, GitHub link placeholder flagged), PRIVACY.md (plaintext statement, date), CHANGELOG.md started.
11. Fixtures page and manual smoke checklist.

**Acceptance:**
- `npm test` green; `npm run build` produces a loadable `dist/`.
- On the fixtures page, with each provider: Default inserts a transcript; Email produces an email; Translate to Greek produces Greek; Instruct answers.
- A wrong key produces "rejected the API key" with no key fragment on screen.
- Network off produces "Network error"; a recording under `minRecordingTime` shows "Too short".
- The password field shows no pill.
- Open popup, change max time, close, reopen, record: key still works (regression for the corruption bug).
- Processing indicator stays visible until the result or error arrives.

## 6. Phase 1: Core rebuild

**Goal:** recording, UI and insertion are robust on real sites. Delivered as v2.1.0.

### 6.1 Offscreen recorder (D8)
- Files: `src/offscreen/offscreen.html|js`, `src/offscreen/permission.html|js`, `src/background/recorder.js`.
- Manifest: add `"offscreen"` permission.
- `recorder.js`: `ensureOffscreen()` uses `chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] })` and a single in-flight `createDocument` promise with `reasons: ['USER_MEDIA']`. `start({ tabId, settings })` and `stop()` relay to the offscreen document.
- Offscreen: on start, `navigator.permissions.query({ name: 'microphone' })`. If `prompt`, reply `{ needsPermission: true }`; the SW opens `permission.html` in a tab, which calls `getUserMedia`, stops tracks, closes itself. Otherwise record WebM/Opus at 32 kbps with a 100 ms timeslice, run an `AnalyserNode`, post `audioLevel` to the tab at 10 Hz, honor `maxRecordingTime`, and post the base64 audio to the SW on stop.
- Content script stops calling `getUserMedia`. Its REC control sends `startRecording` / `stopRecording`.
- Acceptance: mic prompt appears exactly once per profile; dictation works in a page whose `Permissions-Policy` denies microphone; the tab's mic indicator turns on only while recording.

### 6.2 Shadow DOM pill (D9)
- Files: `src/content/pill.js`, `src/content/pill.css` (imported as text via esbuild `loader: { '.css': 'text' }`), remove `content.css` from the manifest.
- `class Pill { mount(); show(anchorRect); hide(); setState(state); setLevel(level); setStatus(text, { sticky, tone }); renderMenu(settings, handlers); }` with states `idle | recording | processing | done | error`.
- Host: `<voicetype-host>` on `document.documentElement`, `position: fixed`, `all: initial`, `z-index: 2147483647`, `attachShadow({ mode: 'closed' })`, styles via `adoptedStyleSheets`.
- Icons: inline SVG (mic, stop, dots, check, alert, globe). No emoji in the pill.
- Acceptance: identical rendering on a fixture page with `button { all: unset } * { font-size: 30px !important }`.

### 6.3 Positioning
- File: `src/content/position.js`, pure `computePillPosition({ anchor, pill, viewport, gap }) => { top, left, placement }` with placements `left | right | above`; menu placement `below | above`.
- Content repositions on `scroll` (capture, passive), `resize`, and a `ResizeObserver` on the target, throttled by `requestAnimationFrame`.
- Acceptance: pill follows a field inside a scrolling container; a left-flush field gets the pill on its right; a bottom-edge field opens the menu upward.

### 6.4 Frames and shadow hosts
- Manifest: `all_frames: true`, `match_about_blank: true`.
- `focusin` handler uses `e.composedPath()[0]`; only the frame containing the focused field shows a pill.
- Acceptance: fields inside a same-origin and a cross-origin iframe on the fixtures page get a pill; a field inside an open shadow root gets a pill.

### 6.5 Insertion ladder v2
- Rungs: `execCommand('insertText')` with value verification; native setter plus `beforeinput` and `input` `InputEvent`s with `inputType: 'insertText'`; synthetic `paste` `ClipboardEvent` with `DataTransfer` text; clipboard write with notice.
- Site matrix for manual sign-off: Gmail compose, Google Docs (clipboard expected), Notion, Slack, ChatGPT, GitHub issue textarea, X, LinkedIn.
- Acceptance: Ctrl+Z after a dictation in a textarea removes exactly the dictated text.

### 6.6 Popup rework
- Layout: one column, 320 px, 12 px minimum type, contrast tokens meeting 4.5:1, dark mode via `prefers-color-scheme`, visible focus rings, SVG icons.
- Sections: Provider (segmented) with key field, Test, Clear; Recording (min, max, silence auto-stop); Speech (spoken languages multi-select: auto, en, el, es, fr, de, it, pt; vocabulary textarea, one term per line into `keywords`); Modes (list, editor); Usage (table, per provider); About (version, links).
- Autosave everywhere; no Save button.
- Acceptance: every control persists on change and is reflected by the pill menu within one second.

### 6.7 Orphan handling
- Content: every `chrome.runtime.sendMessage` goes through `send()`, which detects "Extension context invalidated" and replaces the pill with a "VoiceType updated, reload the page" notice.
- New content script dispatches `document.dispatchEvent(new CustomEvent('voicetype:teardown'))` on start; old instances listen and remove their host.
- SW `onInstalled` re-injects `content.js` into all `http(s)` tabs via `chrome.scripting.executeScript`.
- Acceptance: reload the unpacked extension with three tabs open; each tab has exactly one working pill without a page reload.

### 6.8 Hotkey with hold-to-talk (D7)
- File: `src/content/hotkey.js`. Default chord `Ctrl+Shift+Space`. Tap (release under 300 ms) toggles; hold records until release.
- `commands` entry removed from the manifest. Popup gets a key recorder that stores `settings.hotkey`.
- Acceptance: hold for 4 s and release inserts a transcript; two taps start and stop.

### 6.9 Silence auto-stop
- Setting `autoStopSilenceSec: 0 | 2 | 3 | 5`, default 0. Offscreen RMS below threshold for that long after speech has been detected stops the recording.

### 6.10 Playwright smoke
- `test/e2e/smoke.spec.js`: launch Chromium with `--load-extension=dist`, open the fixtures page, stub the provider endpoints via `page.route`, click REC twice, assert the textarea contains the stubbed transcript.

## 7. Phase 2: Differentiators

**Goal:** the features that make BYOK dictation feel better than a subscription app. Delivered as v2.2.0.

### 7.1 Streaming interim text
- OpenAI only: `stream=true` on the transcriptions endpoint; SW parses SSE `transcript.text.delta` and forwards deltas to the tab; the pill shows ghost text; `transcript.text.done` supplies the final text and usage. Gemini keeps batch (Live API needs PCM and ephemeral tokens; out of scope).

### 7.2 Command mode
- If a non-empty selection exists inside the target when recording starts, the mode becomes "Edit selection": the text model receives the selection and the spoken instruction and returns the replacement; insertion replaces the range. Raw instruction kept in history.

### 7.3 History and undo AI edit
- `chrome.storage.session` keeps the last 20 `{ raw, text, mode, host, ts }`.
- Pill menu: Insert last, Copy last, Undo AI edit (replaces the inserted text with `raw` when it is still present at the insertion point, else copies `raw`).

### 7.4 Onboarding page
- Opened on first install: choose provider, paste key, Test, grant mic (satisfies the offscreen requirement), try a textarea, show the hotkey. Reachable later from the popup About section.

### 7.5 Accessibility and visual polish
- 24 px minimum targets, `role="status"` `aria-live="polite"` on the pill status, `aria-label`s, roving tabindex in the menu, `prefers-reduced-motion` respected, glow capped.

### 7.6 Release engineering
- GitHub Actions on tag: `npm ci`, `npm test`, `npm run build`, `npx web-ext lint --source-dir dist`, zip `dist/` as the release asset. CHANGELOG maintained. README rewritten around the positioning line.

## 8. Out of scope

- Chrome Web Store submission and its permission-narrowing variant.
- Local or offline models.
- Third provider (Anthropic has no STT; a refine-only adapter fits the registry if wanted later).
- Gemini Live streaming; OpenAI Realtime WebRTC.
- Team features, sync, dictionary sharing.
- Verbatim toggle for Gemini SMART mode (revisit if users report meaning changes).

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Gemini `audioTranscriptionConfig` field names differ from the verification pass | Phase 0 Task 5 includes a live smoke call against the docs URL before the adapter is committed |
| `gpt-transcribe` returns token usage instead of duration | `normalizeSttUsage` handles both; cost falls back to client-measured seconds |
| `execCommand` returns false without a user gesture | Ladder verifies the field value changed and never trusts the return value |
| Offscreen `getUserMedia` cannot prompt | Permission page flow per the official sample |
| SMART mode alters meaning | Raw transcript kept; Undo AI edit in Phase 2; verbatim toggle listed for later |
| Gemini 3.8 Flash price step on 2027-01-01 | Registry comment carries the date; estimates are labelled as estimates |

## 10. Verification strategy

- Unit: Vitest over `shared/`, `background/` (fetch stubbed, storage faked, chrome APIs injected) and `content/insert.js`, `content/fields.js`, `content/position.js` under jsdom.
- Manual: `test/fixtures/fields.html` matrix per phase acceptance lists above.
- End to end: Playwright extension smoke from Phase 1.
- Lint: `web-ext lint` from Phase 2.
- Reporting: every handback states the test count as `N/N` and the manual checklist results.
