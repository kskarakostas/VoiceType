# SDD ledger — plan: docs/superpowers/plans/2026-09-26-phase-0-foundation-and-fixes.md
Spec: docs/superpowers/specs/2026-09-26-voicetype-roadmap.md (read; binding authority)
Branch: phase-0 (off main at 379a6c4); models: all subagents on Opus per Kostas
Ruling: no separate worktree directory; branch phase-0 in place — repo was created by this plan and lives in Dropbox, a second checkout would double-sync — cost if wrong: none, branch isolation is what the skill needs

## Pre-flight conflict scan
| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T2 models <-> T5,T6 adapters | PROVIDERS ids vs URLs/body asserted in adapter tests | consistent |
| T2 pricing <-> T5,T6 normalizeSttUsage <-> T7 pipeline | SttUsage/TextUsage shapes | consistent |
| T3 sanitizeHint <-> T5,T6 keyword tests | 'bad<kw>'->'bad kw', 'Topic:\nAI'->'Topic: AI' | consistent |
| T4 defaults <-> T7,T8,T11,T12 | keys, modes[].prompt, translateTargetLang, min/maxRecordingTime | consistent |
| T7 pipeline <-> T9 router | runDictation args and DictationResult fields | consistent |
| T8 usage <-> T9 router | applyUsage entry shape, summarize, emptyLog import | consistent |
| T9 router <-> T11 content | TRANSCRIBE payload/response, CHECK_KEY, GET_SETTINGS | consistent |
| T9 router <-> T12 popup | VALIDATE_KEY, GET_USAGE total.byProvider | consistent |
| T10 insert/fields <-> T11 content | insertText outcomes, isValidInput, deepActiveElement | consistent |
| T1 build <-> T9 index.js, T13 manifest | dist file names incl. content.css | consistent |
| T1 self | Step 1 git init | done by controller as setup; implementer skips it |
| T2 self | pricing test arithmetic | checked, consistent |
| T4 self | recoverKey flagged-plaintext expectations | matches earlier simulation |
| T5 self | redact/friendly expectations vs regex | consistent |
| T7 self | cost sums in tests | consistent |
| T8 self | prune and 7-day window arithmetic | consistent |
| T9 self | mock call expectations vs router code | consistent |
| T10 self | jsdom lacks isContentEditable; InputEvent.inputType support uncertain | see rulings |
| T13 self | cumulative counts 11 files/77, 13 files/89 | consistent |
| Rubric conflicts | assert-nothing tests, verbatim duplication mandated | none found |

Ruling: T10 isValidInput also accepts contenteditable attribute values '', 'true', 'plaintext-only' when isContentEditable is not true — jsdom does not implement isContentEditable and real pages use contenteditable="" — cost if wrong: a non-editable element with a stray attribute gets a pill
Ruling: T10 if jsdom InputEvent ignores inputType, the test asserts the event type 'input' instead and the inputType assertion is dropped from the test only, not the code — cost if wrong: weaker test, same runtime behavior

## Progress
Task 1: implementer DONE_WITH_CONCERNS (0b30165); review: spec ok, 1 Important plan-mandated (watch mode stale statics), 4 Minor
Ruling: build.mjs watch mode re-copies statics via fs.watch on manifest.json, src/popup/popup.html, src/popup/popup.css, src/content/content.css, icons/ — watch is the dev loop for Phases 1 and 2 popup/CSS work, dropping it costs more than 6 lines — cost if wrong: a slightly chattier watch script
Ruling: add `.superpowers/` to root .gitignore in the same fix round — protects the process artefacts from `git add -A`, controller-scope setup gap — cost if wrong: none
Task 1: minor (deferred): package.json engines ">=20" looser than jsdom/vite need; suggested "^20.19.0 || ^22.13.0 || >=24"
Task 1: minor (deferred): build.mjs paths depend on cwd; add process.chdir(import.meta.dirname)
Task 1: minor (deferred): no vitest.config.js; default include wider than test/unit/**/*.test.js
Task 1: verified by controller: commit body has no trailers
Task 1: fix round 1 in progress (10b3594 watch statics + .gitignore); implementer concern: per-file fs.watch dies after atomic-rename saves, no try/catch
Ruling: harden the watcher before re-review: watch parent directories, filter by basename, try/catch around copyStatic — a watch mode that silently stops is worse than none — cost if wrong: a few extra lines in build.mjs
Task 1: fix round 1/5 (2 addressed, 0 open — watch statics via dir watch + try/catch; .superpowers ignored; commits 0b30165..cc0ee51)
Task 1: minor (deferred): build.mjs FSWatcher instances have no 'error' listener
Task 1: minor (deferred): copyStatic copies icons/ wholesale and never prunes dist/ (editor temp files can land in dist/icons)
Task 1: complete (commits 379a6c4..cc0ee51, review clean)
Task 2: implementer DONE_WITH_CONCERNS (016e4d9, 12/12); review: spec ok, Approved, 7 Minor
Task 2: minor (deferred): pricing NaN on incomplete usage hidden as $0.00 by formatCost; adapters must default fields to 0 (Tasks 5/6 normalizeSttUsage already use || 0)
Task 2: minor (deferred): MODELS/LEGACY lookups treat inherited keys ('constructor') as ids; use Object.hasOwn
Task 2: minor (deferred): Gemini model given duration usage ignores usage.seconds
Task 2: minor (deferred, plan-mandated): Gemini STT textTokens never priced
Task 2: minor (deferred): GEMINI_AUDIO_TOKENS_PER_SECOND global rather than per model
Task 2: minor (deferred): shallow Object.freeze on registries
Task 2: minor (deferred): test gaps (3.8-flash output price, formatCost(0.01) boundary, legacy ids absent from MODELS)
Task 2: complete (commits cc0ee51..016e4d9, review clean)
Task 3: implementer DONE_WITH_CONCERNS (eb6b73f, 18/18); concern: fillTemplate resolves inherited names ('{{constructor}}')
Ruling: fix fillTemplate with Object.hasOwn plus a test before review — user-editable prompts are the template source, inherited names must blank — cost if wrong: one extra test
Task 3: minor (deferred): sanitizeHint trims before truncating, so a cut can end in a space
Task 3: fix (pre-review) cce3053 fillTemplate own-properties only; review: spec ok, Approved, 7 Minor
Task 3: minor (deferred): text.js JSDoc does not state own-properties-only contract; no @returns
Task 3: minor (deferred): sanitizeHint negative maxLen slices from end; can split a surrogate pair; \w placeholders ASCII-only
Task 3: minor (deferred): test gaps (falsy values, vars null, known name with inner spaces)
Task 3: note: manifest `commands` key `toggle-recording` equals MSG.TOGGLE_RECORDING by value; the manifest cannot import MSG, permanent exception to "names only in messages.js"
Task 3: complete (commits 016e4d9..cce3053, review clean)
Task 4: implementer DONE_WITH_CONCERNS (ec75c51, 29/29); concerns: settingsVersion>2 falls into v1 path and wipes keys; v2 object missing keys passes through
Ruling: harden migrateSettings before review: versions >= 2 take the v2 path; v2 path also restores a missing keys object — both are key-loss paths on malformed storage, two lines each — cost if wrong: two extra tests
Task 4: minor (deferred): shallow freeze on DEFAULT_SETTINGS/BUILTIN_MODES (callers use freshSettings)
Task 4: review (cce3053..c6a6504): Needs fixes; 1 Important plan-mandated (fast path throws on non-object modes), 8 Minor
Ruling: fix non-object modes on the fast path (treat as {}) and add the partial-keys test — same standard as the keys ruling, a throw at the load gate makes settings unloadable — cost if wrong: two extra tests
Task 4: minor (deferred): fast path does not validate activeMode (popup delete resets it; Task 12)
Task 4: minor (deferred): built-in presence check on fast path is truthiness only
Task 4: minor (deferred): loose value types on v1 path (non-string name/icon, negative pillGap)
Task 4: minor (deferred): BUILTIN_MODES[key] resolves inherited names; use Object.hasOwn
Task 4: minor (deferred): shallow freeze; string settingsVersion goes to v1 path; downgrade write-back writes v2 shape into v3 storage
Task 4: note: v1 DEFAULT_SETTINGS still live in background/index.js and popup.js until Tasks 9 and 12 rewire them
Task 4: fix round 1/5 (2 addressed, 0 open — non-object modes repaired, partial-keys test; commits c6a6504..afc23a2)
Task 4: complete (commits cce3053..afc23a2, review clean)
Task 5: implementer DONE_WITH_CONCERNS (c6f1f7a, 45/45); review: spec ok, Approved, 7 Minor
Task 5: minor (deferred, plan-mandated): "401 redacts key" test reuses a consumed Response; no adapter test of the 400 redact path
Task 5: minor (deferred): signal/method/header untested on refine and validateKey; 64-char keyword cap untested
Task 5: minor (deferred): null entry in languages throws TypeError (use l?.code); token usage drops input_tokens when input_token_details missing
Task 5: minor (deferred): redact is pattern-only, \b misses '_sk-'; AQ. pattern stops at a second dot; AbortError swallowed in readErrorMessage
Ruling: Task 6 Gemini adapter maps an HTTP 400 whose body says the API key is invalid (API_KEY_INVALID / "API key not valid") to a ProviderError with code 'auth' and the standard "Gemini rejected the API key" sentence, with a test — Gemini signals bad keys as 400, and the popup Test button and users need the auth classification — cost if wrong: one extra branch in gemini.js
Task 5: complete (commits afc23a2..c6f1f7a, review clean)
Task 6: implementer DONE_WITH_CONCERNS (5bc64ea, 54/54; live Step 5 skipped by ruling, runs in Task 14); review: spec ok, Approved, 7 Minor
Task 6: minor (deferred): auth sentence duplicated between errors.js and gemini.js; export authError(provider) from errors.js
Task 6: minor (deferred): invalid-key 400 tested only via transcribe with both message and reason; add reason-only test via validateKey; widen to API_KEY_(INVALID|EXPIRED)
Task 6: minor (deferred): normalizeSttUsage throws on non-array promptTokensDetails or null entries after a 200
Task 6: minor (deferred): signal and header untested on refine; JSDoc advertises unused prompt; 403 fixture body is really a 400 body
Task 6: complete (commits c6f1f7a..5bc64ea, review clean)
Task 7: implementer DONE_WITH_CONCERNS (f19b35e, 62/62); review: spec ok, Approved, 6 Minor (all plan-mandated)
Ruling: refine failure must not discard the paid raw transcript: runDictation catches a refine error, returns raw text with a `warning` string, textModel null, cost from STT only; router passes `warning` through (Task 9); content shows it as a warning status (Task 11) — a thrown refine error after a successful STT loses money and text — cost if wrong: one extra optional field
Ruling: provider selection uses Object.hasOwn and the Gemini email path is pinned with key 'AQ.test', refine signal identity and textModel — the untested key routing would let a regression send the OpenAI key to Google — cost if wrong: three extra tests
Task 7: minor (deferred): timeoutMs untested; non-string prompt or text throws TypeError; whitespace-only key or target language passes guards; textModel keyed on usage presence rather than refine having run
Task 7: fix round 1/5 (2 addressed, 0 open — refine fallback with warning, hasOwn provider guard, 4 tests; commits f19b35e..a53e080)
Task 7: minor (deferred): empty ProviderError message gives "Mode not applied ()."; double punctuation in warning template; fallback test fakes ProviderError by name
Task 7: minor (deferred): refine returning empty text falls back silently with no warning; shared 60s budget across STT and refine
Task 7: note for Tasks 9 and 11: DictationResult now carries `warning: string|null`; router must pass it through and content must show it
Task 7: complete (commits 5bc64ea..a53e080, review clean)
Task 8: implementer DONE_WITH_CONCERNS (35a069d, 77/77); review: Needs fixes; 1 Important plan-mandated (local-date test vacuous under TZ=UTC), 6 Minor
Ruling: local-date test uses a duck-typed date whose local and UTC getters disagree, so it discriminates on any machine — the only guard for the "never UTC" constraint must not depend on the runner's timezone — cost if wrong: none
Ruling: addTo coerces non-finite numbers to 0 and date arithmetic anchors at noon — both protect the never-pruned total from a NaN or a DST double count, two lines each — cost if wrong: two extra tests
Task 8: minor (deferred): mode/provider keys not validated against Object.prototype (mode ids are generated, provider validated by pipeline)
Task 8: minor (deferred): partial v2 log with missing bucket fields throws in addTo; normalize buckets on read; two validity definitions (storage version check vs isV2)
Task 8: minor (deferred): test gaps (prune boundary, summarize on v1 log, fakeArea returns references)
Task 8: fix round 1/5 (3 addressed, 0 open — machine-independent TZ test, NaN coercion, noon-anchored day arithmetic; commits 35a069d..813c27f)
Task 8: minor (deferred): DST test as ruled does not discriminate without a pinned TZ; consider a vitest setup pinning TZ=Europe/Athens
Task 8: minor (deferred): unused cutoff variable in prune test; no prune boundary assertion; unknown provider creates a byProvider entry
Task 8: complete (commits a53e080..813c27f, review clean)
Task 9: implementer DONE_WITH_CONCERNS (b76a0bc, 90/90, build ok); review: Needs fixes; 1 Important plan-mandated (saveSettings with non-object wipes keys, reports success), 9 Minor
Ruling: saveSettings rejects a missing or non-object settings payload with { success: false, error: 'Invalid settings.' } — a message-boundary typo must not destroy keys — cost if wrong: one extra test
Ruling: usage logging after a successful dictation runs in its own try/catch and never turns the response into a failure — same standard as the Task 7 refine ruling, paid transcripts are not discarded — cost if wrong: an unlogged session
Ruling: onCommand toggle gets .catch(() => {}); clearUsageStats test seeds a non-empty log first — trivial, in files this task owns — cost if wrong: none
Task 9: minor (deferred): GET_USAGE/CHECK_KEY/transcribe tests assert only one side; AbortError branch untested
Task 9: minor (deferred): usage log read-modify-write has no serialization across concurrent transcriptions
Task 9: minor (deferred): ADAPTERS[provider] in validateKey resolves inherited names; timeout wording "Try a shorter recording" wrong for key validation; every TypeError reads as network error, no console.warn of raw error
Task 9: minor (deferred): TOGGLE_RECORDING always reports success even on non-http tab
Task 9: note for Task 11: TranscribeResponse typedef in messages.js lacks warning; content script registers onMessage after async getSettings (double-inject race via toggleActiveTab)
Task 9: fix round 1/5 (4 addressed, 0 open — saveSettings guard, logging isolated, onCommand catch, clear test seeded; commits b76a0bc..f288594)
Task 9: minor (deferred): saveSettings guard is type-only; a partial object still overwrites keys (consider shape check or merge)
Task 9: minor (deferred): warn.mockRestore not in finally
Task 9: note for Task 12: popup must handle { success: false, error } from SAVE_SETTINGS
Task 9: complete (commits 813c27f..f288594, review clean)
Task 10: implementer BLOCKED: focus() places the caret at the start of a contenteditable (jsdom, likely Chrome when selection is elsewhere), so the append-at-end branch never runs and the brief test fails
Ruling: insertText captures the selection before focus(); for editables, restores it when it was inside the target, else collapses the selection to the end of the target before any rung runs — inserting at the user's caret or at the end beats inserting at the start — cost if wrong: ~25 lines in insert.js, tests unchanged
Task 10: implementer DONE after caret ruling (a268cc4, 104/104); review: spec ❌, 3 Important (shadow-root selection retargeted, restore branch untested, sync read-back after execCommand plan-mandated), 8 Minor
Ruling: selection is read from el.getRootNode().getSelection() when available, else ownerDocument — Chrome retargets document selection to the shadow host — cost if wrong: one helper
Ruling: read-back after execCommand waits one macrotask (setTimeout 0) — Lexical/Slate commit in a microtask and a sync read would trigger rung 2 and duplicate text — cost if wrong: a few ms per insertion
Ruling: setEditableText returns false unless the target is contenteditable (attribute or isContentEditable), so role=textbox without editing falls to clipboard; rung 1 runs only when target.getRootNode().activeElement === target — prevents writing into a node the page cannot edit and double insertion into two fields — cost if wrong: rung 1 skipped when a page refuses focus, rung 2 still inserts
Task 10: minor (deferred): end-of-contents caret lands at editor root rather than last text node; invalid input types rejected (use el.type); revealed password fields accepted; ruling 1 attribute forms untested; "never trust return value" unpinned; report noise
Task 10: fix round 1/5 (5 addressed, 0 open — selectionFor helper, restore tests, macrotask wait, isEditableElement gate, focus gate; commits a268cc4..9e5ae95)
Task 10: minor (deferred): no automated test for macrotask wait, focus gate, post-wait disconnected branch; textarea rung-1 test does not pin rung 1 ran; setTimeout(0) throttled in hidden tabs; shadow selection path needs a browser check
Task 10: complete (commits f288594..9e5ae95, review clean)
Ruling: Task 11 registers chrome.runtime.onMessage synchronously at module load (before awaiting settings) and handles toggle by deferring until init completes — the async registration let toggleActiveTab double-inject content.js — cost if wrong: a small init-ordering change
Task 11: implementer DONE_WITH_CONCERNS (5a12f9a, build ok, 107/107); concern: content script saves full settings incl. keys, fallback state could blank stored keys
Ruling: content script strips `keys` before SAVE_SETTINGS and the router merges stored keys when the payload has no keys object — the content script has no business writing keys, and a fallback-state save must not erase them — cost if wrong: one router test, one content edit
Ruling: pipeline warning status shows for 6 s instead of 2.5 s — a one-line mode-failure notice is unreadable in 2.5 s — cost if wrong: none
Task 11: minor (deferred): shortcut before document_idle can still inject a second copy (pre-existing); reload during processing overwrites the sticky reload notice
Task 11: fix (pre-review) b182df8 keys stripped in content, router merges stored keys; review (9e5ae95..b182df8): spec ok, Approved, 8 Minor
Task 11: minor (deferred): shortcut path still force-resets isProcessing (obsolete now that the watchdog releases it); toggleRecording and handleToggleCommand apply different guards
Task 11: minor (deferred): watchdog timer never cleared on success; reload during processing overwrites sticky notice; non-reload runtime error is silent on REC
Task 11: minor (deferred): MediaRecorder construction failure leaves tracks open; stale comment about second-copy injection
Task 11: minor (deferred): router keys merge replaces wholesale on a partial keys object (use spread) and is not atomic
Task 11: minor (deferred, Phase 1): hidePill never clears currentInput; focusout during processing hides result; recorder self-stop leaves isRecording true
Task 11: complete (commits 9e5ae95..b182df8, review clean)
Task 12: implementer DONE_WITH_CONCERNS (ba6f64f, build ok, id diff clean, 109/109); concerns: fallback settings would autosave empty keys; loadUsageStats throws on error response
Ruling: popup never persists from a fallback state: when getSettings fails, persist() is disabled, controls are left readable, and a sticky error toast tells the user to reopen the popup — a popup must not write blanks over real keys — cost if wrong: a disabled popup until reopened
Ruling: loadUsageStats returns early unless the response has a total bucket — trivial guard — cost if wrong: none
Task 12: fix (pre-review) c436e6b no autosave from fallback; review (b182df8..c436e6b): spec ok, Approved, 6 Minor
Task 12: minor (deferred): reset does not close the mode editor; failed save leaves in-memory settings and UI changed; Clear history toast unconditional; non-persist toasts replace the sticky load error
Task 12: note for Task 14 smoke: paste key then click outside the popup (change event may not fire); confirm() must not dismiss the popup
Task 12: complete (commits b182df8..c436e6b, review clean)
Ruling: CHANGELOG gains a Fixed line for the refine fallback ("If the mode step fails, the raw transcript is inserted with a notice") — the behaviour was added by ruling after the brief was written — cost if wrong: one line
Task 13: implementer DONE_WITH_CONCERNS (c32ad9a); review: Needs fixes; 1 Important plan-mandated (Gemini ~$0.005/min low vs estimator ~$0.006), 7 Minor
Ruling: docs fix round folds in the Minor items too (dated 3.8-flash price, shortcut wording, retention wording, manifest description under 132 chars, ZIP path, accuracy wording, pre-existing em dashes) — all docs, all cheap, and the no-dash rule is global — cost if wrong: none
Task 13: open item for Kostas: YOUR_USERNAME at README.md 113, 246, 248
Task 13: fix round 1/5 (8 addressed, 0 open — Gemini cost, dated price, shortcut wording, ZIP path, accuracy wording, dashes, retention, description length; commits c32ad9a..4225008)
Task 13: minor (deferred): shortcut text says "or the page" (a page cannot take a chrome.commands chord); Gemini free-tier claim unverified for gemini-3.5-transcribe; dead .pill-gap-control CSS; v1 screenshots
Task 13: complete (commits c436e6b..4225008, review clean)
Ruling: Task 14 (end-to-end smoke and tag) is handed to Kostas as a checklist — it needs Chrome, real API keys and a microphone, which no agent in this session has; the v2.0.0 tag is his call after the smoke passes — cost if wrong: none, nothing is tagged until he runs it
Task 14: handed off (no commits; brief at .superpowers/sdd/.../task-14-brief.md, additions from Tasks 6, 12: live Gemini field-name check, paste key then click outside popup, confirm() must not dismiss popup)
Final review (379a6c4..4225008, Opus): With fixes; 0 Critical, 6 Important (I1 fixture layout hides pill, I2 shortcut ignored on file:// and missing tab.url, I3 'failed' outcome discards transcript, I4 TypeError mapped to network error and nothing logged, I5 smoke brief lacks ledgered additions, I6 PRIVACY overstates key protection), 12 Minor, ledger triaged
Ruling: final fix wave = I1, I2, I3, I4, I6, M1, M4 to M12, plus ledger fix-now items (T5 consumed Response + 400 redact test, T11 MediaRecorder failure stops tracks and non-reload error visible, T13 wording and free-tier claim); I5 is a controller artefact and is folded into the Task 14 checklist by the controller — one wave, one scoped re-review — cost if wrong: one more review round
Ruling: declined-to-judge items 1 to 18 stand as is (spec, plan, or v1 behaviour retained); items 6 (refocus during processing redirects transcript), 7 (left-edge pill), 10 (shortcut during processing) and M2, M3 are carried as notes into the Phase 1 plan — cost if wrong: Phase 1 scope grows by known items
Final wave: re-review (4225008..b022cb9): all 20 items addressed, no new Critical/Important; 1 Minor (sticky click-to-copy status overlaps an open dropdown by ~25 px)
Final wave: parked — C3 scope: the four non-dictation error statuses (no key, microphone, settings not loaded, runtime error) still show 2.5 s — Ruling: Phase 1 pill rewrite standardises status durations; not worth another round now
Final wave: parked — status/dropdown overlap — Ruling: cosmetic, Phase 1 pill rewrite
Final wave: Phase 1 notes: clipboard API absent on plain-http pages (localhost is secure, fixtures unaffected); onChanged with undefined newValue leaves settings undefined; reset confirm text omits languages/keywords/target; mid-dictation reload notice overwritten
Phase 0: all 13 code tasks complete, Task 14 handed off; branch phase-0 at b022cb9, 32 commits, 123/123 tests
