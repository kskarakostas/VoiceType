# SDD ledger: plan: docs/superpowers/plans/2026-09-27-phase-1-core-rebuild.md
Spec: docs/superpowers/specs/2026-09-26-voicetype-roadmap.md (read; binding authority; section 6.0 amendments and D10 to D12 of 2026-09-27)
Branch: phase-1 (off main at 9cadd0a); models: all implementers and reviewers on Opus per Kostas
Ruling: no separate worktree directory; branch phase-1 in place; why: repo lives in Dropbox, a second checkout would double-sync (same ruling as Phase 0); cost if wrong: none, branch isolation is what the skill needs
Ruling: execution proceeds without a separate plan-review pause; why: Kostas's kickoff prompt orders plan then execution (A, B, C) and gated only the design questions; cost if wrong: Kostas reviews the plan after the fact and rework lands as fix rounds
Baseline: main 9cadd0a, 123/123 tests, build clean
Plan verification before execution: six writers verified their parts in scratch copies (chain 1 to 11 at 540/540); whole-plan replay dispatched
Plan committed: 42a17eb (spec amendments), 6633dfd (plan)

## Pre-flight conflict scan (evidence: whole-plan replay of 2026-09-27, 14 tasks, 25 commits, 587/587, SCRATCH/replay-report.md)
| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1 <-> T5, T6, T11 | build.mjs ENTRIES/STATICS, absWorkingDir, target | consistent; each replacement matched once |
| T1 <-> T4 | usage.test.js DST edits (T1) under T4 rewrite | consistent; T4 keeps T1's two DST tests verbatim |
| T1 <-> T13 <-> T14 | package.json engines, devDependency, script, version line | consistent |
| T2 <-> T4 | errors.js authError, redact; pipeline hardening vs dictate/router | consistent |
| T3 <-> T4, T6, T9, T10, T11, T12 | MSG, toPublicSettings, applySettingsPatch, chord.js, AUTO_STOP_CHOICES, settings fields | consistent; every MSG key used exists |
| T4 <-> T6 | router recorder stub, tabs.js, index.js, index.test.js | consistent |
| T5 <-> T6 | offscreen messages; stop during pending start answers "Recording cancelled." | consistent after writer alignment |
| T6 <-> T11 <-> T14 | manifest.json and manifest.test.js | consistent (4 + 2 + 3 tests) |
| T7 <-> T11 | insertText outcomes incl. 'unverified', copyText | consistent |
| T8 <-> T9 <-> T11 | computePillPosition ('inside' added), computeMenuPlacement, watchAnchor | consistent |
| T9 <-> T11 | Pill surface, STATUS_MS | consistent |
| T9 <-> T13 | collapsed pill clips REC (zero-width bar), smoke clicked the page | CONFLICT, see ruling |
| T6 <-> T13 | onInstalled default-settings write lands after the smoke's key seed | CONFLICT, see ruling |
| T10 <-> T11 | createChordTracker press/repeat/release/blur | consistent |
| T12 <-> T4 | SAVE_SETTINGS with an empty string key clears it | consistent |
| T14 <-> all | UI strings quoted in README, CHANGELOG, checklist exist in source | consistent |
| Per task self-consistency T1..T14 | tests vs code, files created vs touched | consistent; T1 build output wording, T4 step 24 failure wording, T5/T9/T13 stale counts corrected in the plan |
| Rubric conflicts | assert-nothing tests, mandated duplication | none known; not exhaustively scanned across 16k lines; task reviews are the net |
Ruling: smoke clickPill hovers the collapsed pill and waits for the bar width to settle (two equal non-zero reads) before clicking; why: the Task 9 idle pill clips its controls until hover and a fixed 134 px check would couple the test to pill.css; cost if wrong: a flaky e2e click (verified 3/3 on three runs)
Ruling: smoke beforeAll waits until onInstalled has stored settings before seeding the key; why: the default write otherwise overwrites the seed (4/4 runs); cost if wrong: none, test-only
Ruling: a tab closed while its dictation processes drops the result; Global Constraint narrowed to "while the requesting frame exists"; Phase 2 history (spec 7.3) covers it; cost if wrong: one lost paid transcript per such close
Ruling: browser-reserved chords (e.g. Ctrl+T) are accepted by the hotkey recorder and documented rather than guarded; cost if wrong: a user records a chord that never fires and must re-record
Task 1: dispatched implementer a010cd60f2ad83cb1 (opus), BASE 6633dfd
Task 1: implementer DONE_WITH_CONCERNS (c55c9b6, 35fa33c; 126/126, build clean); concern: package-lock engines stale
Ruling: package-lock.json engines left until Task 13's npm install rewrites the lockfile; why: no runtime effect and Task 13 regenerates it; cost if wrong: one stale lockfile field until Task 13
Task 1: review (6633dfd..35fa33c): spec ok, Approved, 0 Critical/Important, 4 Minor; controller verified commit bodies carry no trailers
Task 1: minor (deferred): css-text esbuild test builds with its own loader, never exercises build.mjs; add a dist/content.js selector smoke once Task 11 imports CSS
Task 1: minor (deferred): package-lock root engines stale until Task 13 npm install (ruled above)
Task 1: minor (deferred): a watcher closed after an FSWatcher error stops re-copying its statics for the session; log says nothing about restarting
Task 1: minor (deferred, plan-mandated): TZ precondition test sits inside describe('summarize')
Task 1: complete (commits 6633dfd..35fa33c, review clean)
Task 2: dispatched implementer a6a8750162452279c (opus), BASE 35fa33c
Task 2: implementer DONE (481c897..ea90ea6, 5 commits; 159/159, build clean)
Task 2: review (35fa33c..ea90ea6): spec ok, Approved, 0 Critical/Important, 4 Minor; controller resolved the ⚠️: gemini.test.js and errors.test.js are verbatim brief blocks
Task 2: minor (deferred, plan-mandated): text.js:15 comment says an emoji is never split; multi-code-point emoji (flags, ZWJ) can be; reword to "never leaves a lone surrogate"
Task 2: minor (deferred, plan-mandated): errors.js providerLabel duplicates PROVIDERS labels and maps unknown providers to 'Gemini'; use PROVIDERS[provider]?.label ?? provider
Task 2: minor (deferred, plan-mandated): deepFreeze lives in models.js; move to a shared util if a third consumer appears
Task 2: minor (deferred): pipeline.js:52 settings.modes?.[modeKey] lacks Object.hasOwn (pre-existing; in Phase 1 modeKey comes from SW settings, not content)
Task 2: complete (commits 35fa33c..ea90ea6, review clean)
Task 3: dispatched implementer a81bbeaf8eca30279 (opus), BASE ea90ea6
Task 3: implementer DONE (4132930, 9dd58d9, 38ef9ad; 207/207, build clean); notes: applySettingsPatch result is a shallow copy sharing keys/modes/hotkey; v2 migration keeps {} custom modes (renderers must tolerate missing strings)
Task 3: review (ea90ea6..38ef9ad): spec ok (six files byte-identical to brief), Approved, 0 Critical/Important, 7 Minor
Task 3: minor (deferred, plan-mandated): toPublicSettings strips only keys and passes every other field (fail-open); a future secret field would reach content; consider allowlisting DEFAULT_SETTINGS fields
Task 3: minor (deferred): v2 record with missing or null settingsVersion goes through migrateV1 and blanks keys (hand-edited storage only); guard: object keys field means v2
Task 3: minor (deferred): string settingsVersion '3' is rewritten to 2
Task 3: minor (deferred): isValidChord accepts Escape and Tab as main key while chordFromEvent rejects them; unpinned
Task 3: minor (deferred): matchesChord ignores AltGr (Ctrl+Alt on Windows), event.repeat, isComposing; relevant to Tasks 10, 11, 12
Task 3: minor (deferred, plan-mandated): formatChord labels by US-QWERTY position
Task 3: minor (deferred): tests: applySettingsPatch custom mode key, non-object settings.modes guard; built-in mode stored as {} keeps no name/prompt/builtIn
Task 3: complete (commits ea90ea6..38ef9ad, review clean)
Task 4: dispatched implementer a2884b98b8d24da58 (opus), BASE 38ef9ad
Task 4: implementer DONE (16ef21f, f87244b, 8273a8b; 257/257, build clean); concerns: dictate not wired until Task 6 (planned); stub has onTabRemoved not in RecorderPort typedef; popup whole-settings save can overwrite a concurrent content patch (stale popup copy)
Task 4: review (38ef9ad..8273a8b): spec ok (12 files match brief), Needs fixes; 1 Important plan-mandated (SAVE_SETTINGS persists unknown fields and toPublicSettings is a denylist, so a stray key-like field reaches content; probe confirmed), 6 Minor
Ruling: fix at both ends in Task 4 round 1: SAVE_SETTINGS keeps only own fields named in DEFAULT_SETTINGS (keys via pickKeys), and toPublicSettings becomes an allowlist of DEFAULT_SETTINGS fields minus keys plus hasKey; tests: an extension SAVE_SETTINGS { apiKey, draftKey } never reaches content GET_SETTINGS or the broadcast, and toPublicSettings drops unknown fields; why: the Global Constraint that no content message carries a key must not rest on a naming convention; cost if wrong: a future legit top-level setting must be added to DEFAULT_SETTINGS to persist (it must be anyway for migration)
Task 4: minor (deferred): senderKind offscreen branch does not require sender.tab undefined
Task 4: minor (deferred): index.js catch-all sends userMessage(err) unredacted to any sender (no current ProviderError path)
Task 4: minor (deferred): usage bump with mode '__proto__' silently drops the count
Task 4: minor (deferred): router access tests assert only content for SAVE/VALIDATE/CLEAR; index.test never sends from offscreen.html URL
Task 4: minor (deferred, carry to Task 12): popup SAVE_SETTINGS snapshot overwrites a concurrent content UPDATE_SETTINGS (lost update); popup should send changed fields only
Task 4: minor (deferred, plan-mandated): isPlainObject duplicates isObject; dictate imports warnFailure from router (belongs in providers/errors.js); RecorderPort typedef omits onTabRemoved
Task 4: fix round 1 implemented (f5db255; 260/260); concern: stray fields already stored persist through later saves (no longer reach pages); migrateV2 still keeps unknown fields
Task 4: minor (deferred): migrateV2 keeps unknown stored fields; they no longer reach pages but are never pruned
Task 4: fix round 1/5 (1 addressed, 0 open: settings allowlists on save and public; commits 8273a8b..f5db255)
Task 4: minor (deferred): nested stray fields (extra props on hotkey, extra props inside a mode object) still reach pages via toPublicSettings deep clone; normalize hotkey to {code,ctrl,shift,alt,meta} and modes to {name,icon,prompt,builtIn,hasLanguageOption}
Task 4: minor (deferred): router allowlist test's content assertion is not independent of the save-side filter (covered by defaults and index tests)
Task 4: complete (commits 38ef9ad..f5db255, review clean)
Task 5: dispatched implementer a545f9cdac115cb69 (opus), BASE f5db255 (suite totals in briefs now +3 from the Task 4 fix round)
Task 5: implementer DONE (3fc7a36; 304/304, build clean, 8 files byte-identical to brief); notes: offscreen.js/permission.js untested until wired; stop during a 'prompt' permission query answers needsPermission; discard during an auto finish suppresses DONE
Task 5: review (f5db255..3fc7a36): spec ok (8 files identical to brief), Needs fixes; 1 Important plan-mandated (analyser failure means no level interval, so no offscreen to SW traffic; SW can die after 30 s with the in-memory session, leaving the mic open and dropping audio), 7 Minor
Ruling: capture always runs the level interval; without an analyser it sends level 0 each tick (silence detector never hears speech, so silence stop stays off); test updated to expect the heartbeat; why: the level stream is the SW keepalive the Task 6 design relies on; cost if wrong: a 10 Hz message of zeros in a rare failure path
Task 5: minor (deferred): cancelStart not checked after queryPermission (mic can open for a cancelled start; prompt state answers needsPermission)
Task 5: minor (deferred): session assigned before listener/timer setup in begin(); a throw leaves a live session
Task 5: minor (deferred): session cleared before the final arrayBuffer await; DONE/ERROR/LEVEL carry no session id (Task 6 busy state prevents overlap)
Task 5: minor (deferred): permission page help text shows the Not allowed hint for NotFoundError and a dismissed prompt; granted:false conflates no mic and denied
Task 5: minor (deferred): no tests for offscreen.js listener routing (sender.tab filter, false for other actions, Number() of maxSec/silenceSec), stop during createAnalyser, discard racing an auto finish
Task 5: minor (deferred): missing or non-numeric maxSec removes the max-time cap (Task 6 always sends a validated value)
Task 5: minor (deferred): DONE mimeType says audio/webm even on MIME fallback; use recorder.mimeType
Task 5: fix round 1/5 (1 addressed, 0 open: level-0 heartbeat without analyser; commits 3fc7a36..ecacd94)
Task 5: complete (commits f5db255..ecacd94, review clean)
Task 6: dispatched implementer a2f39aaebed8a8510 (opus), BASE ecacd94 (brief totals +3)
Task 6: implementer NEEDS_CONTEXT at step 23: brief's index.test.js rewrite drops the Task 4 fix test (stray-field broadcast)
Ruling: restore the Task 4 fix test into the new index.test.js before the step 23 commit; why: the allowlist guarantee must stay pinned at the entry level; cost if wrong: none
Task 6: implementer DONE (e3d7abd, 2c7629a; 363/363, build clean, onCommand 0)
Task 6: review (ecacd94..2c7629a): spec ok (verbatim plus the sanctioned restored test), Approved, 0 Critical/Important, 4 Minor
Task 6: minor (deferred, PRIORITY for final review): stale OFFSCREEN_DONE/ERROR after drop() lands on a new session still 'starting' (probe: tab A transcript delivered to tab B, paid call for cancelled audio, B's capture left running); cheap fix: ignore onDone/onOffscreenError while session.state === 'starting'; durable: capture id echoed in DONE/ERROR/LEVEL (also Task 5 minor)
Task 6: minor (deferred): fast cancel-then-start can show "Already recording." while the offscreen capture is still releasing; begin() could await the in-flight discard
Task 6: minor (deferred, plan-mandated): onInstalled re-injects on every reason incl. chrome_update and shared_module_update; filter to install and update
Task 6: minor (deferred): index.test wiring block never sends OFFSCREEN_DONE/ERROR/PERMISSION_RESULT; recorder.test lacks DONE/ERROR during 'starting' and stop-while-starting then failed start
Task 6: note for Task 11 review: same-frame navigation during recording relies on the content pagehide CANCEL_RECORDING (levels to the new document count as delivered); optional hardening: endpoint documentId
Task 6: complete (commits ecacd94..2c7629a, review clean)
Task 7: dispatched implementer aede89c111ec0dcc1 (opus), BASE 2c7629a
Task 7: implementer DONE (ec792d3; 401/401, build clean, 4 files byte-identical); notes: old content/index.js innerHTML until Task 11 rewrite; isFrameworkEditor closest() stops at shadow boundaries; identical-text selection replace reports inserted
Task 7: review (2c7629a..ec792d3): spec ok (4 files byte-identical; no double-insert path found), Approved, 0 Critical/Important, 8 Minor
Task 7: minor (deferred, PRIORITY): raw DOM rung accepts the first positive read; an unlisted editor reverting after more than one task loses the text without a copy; require the check to still hold after one frame for the raw rung
Task 7: minor (deferred): insertText catch converts exceptions to ambiguous with no log; add console.warn
Task 7: minor (deferred, plan-mandated): copyText never falls back to execCopy after writeText rejects (cross-origin iframes without clipboard-write)
Task 7: minor (deferred): execCopy trusts execCommand('copy') === true; a page copy listener can cancel or rewrite; add a one-shot capture copy listener with setData
Task 7: minor (deferred, constraint): autocomplete new-password on non-password inputs now refuses dictation
Task 7: minor (deferred): identical-text selection replacement reads inserted without verification (harmless)
Task 7: minor (deferred): tests: frameHostname about:blank fallback, trusted input on a different element, empty-editor caret, selection restore after execCopy
Task 7: minor (deferred): endOfContents can land inside a contenteditable=false island
Task 7: complete (commits 2c7629a..ec792d3, review clean)
Task 8: dispatched implementer a5ab8b273d94bef64 (opus), BASE ec792d3
Task 8: implementer DONE (45f07fc; 429/429; 4 files byte-identical)
Task 8: review (ec792d3..45f07fc): spec ok (4 files identical), Needs fixes; 1 Important plan-mandated (scroll is not composed: window capture misses scrollers inside shadow roots, incl. slotted fields; confirmed in Chrome 154 probe), 6 Minor
Ruling: watchAnchor also listens (scroll, capture, passive) on every ShadowRoot met walking up from el (assignedSlot ?? parentNode, stepping from a shadow root to its host), removed in stop; add a fake shadow-root test; why: spec 6.3 and 6.4 (fields in open shadow roots follow scrolling) outrank the plan's window-only design; cost if wrong: a few extra listeners per watched field
Task 8: minor (deferred): 'hidden' only when outside the viewport; a field scrolled out of its container leaves the pill over other content (clip anchor to scroll ancestors in Task 11)
Task 8: minor (deferred, plan-mandated): menu 'above' clamp can cover the pill and overflow when taller than the viewport; cap max-height in Task 9
Task 8: minor (deferred): anchor === null strict check; undefined throws (use == null)
Task 8: minor (deferred): corner placement not clamped in tiny frames
Task 8: minor (deferred): layout shifts without scroll/resize not observed (IntersectionObserver later)
Task 8: minor (deferred, plan-mandated): duplicated clamp expression in position.js
Task 8: fix round 1 implemented (828c272; 433/433); concern: light-DOM field slotted into a CLOSED shadow root still missed (assignedSlot hidden)
Task 8: fix round 1/5 (1 addressed, 0 open: shadow-root scroll listeners; commits 45f07fc..828c272)
Task 8: minor (deferred): light-DOM field slotted into a closed shadow root still missed (assignedSlot null by spec); walk runs once per watch
Task 8: complete (commits ec792d3..828c272, review clean)
Task 9: dispatched implementer a3aabf940c03e940b (opus), BASE 828c272
Task 9: implementer DONE (5502e17; 471/471; 3 files byte-identical)
Task 9: review (828c272..5502e17): spec ok (3 files identical), Needs fixes; 3 Important plan-mandated (status off-screen when the menu is open near the bottom and for 'above'/'corner' near the top; menu height uncapped so it covers the pill; page direction leaks into the shadow tree), 8 Minor
Ruling: fix all three in Task 9 round 1: (a) computeMenuPlacement returns maxHeight: below if it fits, else above if it fits, else the side with more room with maxHeight = that side's space, never overlapping the pill; the pill resets then applies menu.style.maxHeight; (b) status placement checks room on every branch and clamps into the viewport, test asserts on-screen instead of 'below'; (c) .vt sets direction: ltr and unicode-bidi: isolate; why: bottom-of-viewport composers are the main target and spec 6.2 demands identical rendering; cost if wrong: small geometry change in position.js (contract gains maxHeight)
Task 9: minor (deferred): detached host never re-appended (mount returns early); re-append when !isConnected
Task 9: minor (deferred): focus guard relies on mousedown reaching the shadow root; page capture stopPropagation defeats it; composed clicks reach page click-outside handlers
Task 9: minor (deferred): pill tests never destroy instances; a leaked open menu makes a later Escape test pass by accident
Task 9: minor (deferred): coverage: status side under above/corner, on-screen asserts, renderMenu re-places an open menu, invalid-tone fallback
Task 9: minor (deferred): a11y: aria-haspopup=true with role=group; REC aria-label "Start recording" during processing
Task 9: minor (deferred): redundant Math.max(EDGE) after computeMenuPlacement; timer uses Date.now
Task 9: note for Tasks 11/13: z-index max still paints below the top layer; a field in a showModal dialog or fullscreen element gets a hidden, inert pill
Task 9: fix round 1 part A (024af8c; 479/479); implementer concern: opposite-side-else-other-side puts the status under an open menu
Ruling: same round, place the status past the menu's far edge when the side opposite the menu has no room, clamp only if that fails; tests assert on-screen and no overlap with menu or pill; why: the parked C3 overlap item must not return; cost if wrong: none
Task 9: fix round 1/5 (3 addressed, 0 open: status on screen and clear of menu, menu maxHeight, direction isolated; commits 5502e17..e0eb4f6)
Task 9: minor (deferred): #placeMenu clears maxHeight to measure, which resets an open scrolled menu's scrollTop to 0 on every reposition; measure scrollHeight without clearing, or save and restore scrollTop
Task 9: minor (deferred): Math.floor(maxHeight) on an unrounded top can add a needless scroll (sub-pixel)
Task 9: minor (deferred): closed-menu 'above' pill near the top now shows the status over the field top for 2.5 or 6 s
Task 9: complete (commits 828c272..e0eb4f6, review clean)
Task 10: dispatched implementer a920dd408ae75bda1 (opus), BASE e0eb4f6
Task 10: implementer DONE (bb0b02c; 494/494; verbatim)
Task 10: review (e0eb4f6..bb0b02c): spec ok (verbatim), Needs fixes; 1 Important plan-mandated (after a modifier-first release the main key's auto-repeat keydowns fail matchesChord and reach the page: stray spaces with the default chord), 6 Minor
Ruling: tracker keeps draining after a modifier-first end: keydowns of press.chord.code with event.repeat === true return 'repeat' until that code's keyup or a blur; a non-repeat keydown of that code clears draining and is evaluated normally (a lost keyup can never swallow real typing); tests: modifier-first then repeat keydown returns 'repeat', main keyup clears, a later plain keydown returns null, blur clears; why: stray characters in the target field right before insertion; cost if wrong: a few swallowed auto-repeats
Ruling: AltGr (Ctrl+Alt on Windows) and isComposing are not handled in Phase 1; named decisions carried to the final review; why: the default chord is unaffected and both need a cross-cutting change in chord.js and the popup recorder; cost if wrong: Ctrl+Alt chords swallow AltGr characters on Windows, a chord during IME composition starts recording
Task 10: minor (deferred): lost keyup without blur swallows the next real press as 'repeat'; a non-repeat keydown while pressed could end-and-restart
Task 10: minor (deferred): right-hand modifier coverage only ShiftRight; no meta chord test
Task 10: minor (deferred): JSDoc getChord type should be Chord|null|undefined
Task 10: minor (deferred): modifier code table duplicated between hotkey.js and chord.js
Task 10: fix round 1/5 (1 addressed, 0 open: drain the main key's auto-repeat after a modifier-first release; commits bb0b02c..60700de)
Task 10: minor (deferred): no tests for blur-ended press not draining and a full-chord keydown during draining becoming 'press'; draining lacks @type
Task 10: complete (commits e0eb4f6..60700de, review clean)
Task 11: dispatched implementer a7e3c133890885650 (opus), BASE 60700de (brief totals +19)
Task 11: implementer DONE (70fe238, bd7e589; 559/559, build clean, legacy greps empty)
Task 11: review (60700de..bd7e589): spec ok (4 files identical to brief), Needs fixes; 4 Important (1 security: untrusted page keyboard events start the mic; 2 sticky click-to-copy hidden on the next anchor tick when the field is gone; 3 delivery notices on a never-shown pill are invisible; 4 D12 across frames: activeElement persists when focus moves to another frame, so text goes into an unfocused iframe field and steals focus), 9 Minor
Ruling: fix all four in round 1: (1) entry acts only on event.isTrusted for keydown, keyup, window blur, pagehide, focusin, focusout, with an injectable isTrusted seam for tests and one test proving an untrusted chord does nothing; (2) no anchor box plus a busy status means corner placement, never hide; (3) an ensureVisible helper runs before every delivery or notice status; delivery wraps the insert in try/catch and falls back to the click-to-copy status (Global Constraint: paid transcript never discarded); (4) delivery requires hasFocus() as well as deepActiveElement() === target; when the target is still active but the document lacks focus the result is held with a sticky clickable status "Return to the field to insert, or click here to copy." and re-checked once on the next trusted window focus (insert if still active, else the clipboard path); a click on the status copies and drops the hold; why: security first, then the transcript and D12 guarantees; cost if wrong: a held result waits for focus instead of inserting into a background tab
Task 11: minor (deferred): recording pill disappears when its field scrolls out of view (use the corner while not idle)
Task 11: minor (deferred): off-screen idle pill never hidden (settle checks pill.visible)
Task 11: minor (deferred): deliver has no state guard (late result during a new recording)
Task 11: minor (deferred): page can dispatch voicetype:teardown (DoS only; document)
Task 11: minor (deferred): v2.0 orphans keep #voicetype-pill until reload; optionally remove it at entry load
Task 11: minor (deferred): tests: handshake cannot catch a missing removeEventListener; no pagehide-while-starting test; console.warn mocked but rarely asserted
Task 11: minor (deferred): anchor rect not clipped to scroll containers (ledger item not in the brief); top layer: pill inert under showModal/fullscreen (mount inside the dialog)
Task 11: minor (deferred, plan-mandated): every frame sends GET_SETTINGS at load (one SW wake per frame)
Task 11: minor (deferred): session reset code repeated four times
Task 11: fix round 1 implemented (f62ee8e; 572/572, build clean); wiring moved to src/content/boot.js with an isTrusted seam, index.js calls boot()
Ruling: accept the implementer's call that a REC press while a result is held delivers the held result (field if focused now, else clipboard) instead of starting a recording; why: otherwise the paid transcript is dropped or inserted into the next recording's field later; cost if wrong: one extra REC press after a held result
Task 11: minor (deferred): ensureVisible anchors to a field scrolled off screen, so the notice waits until it scrolls back (status kept)
Task 11: fix round 1/5 (4 addressed, 0 open: trusted events only, corner instead of hide for busy status, ensureVisible plus insert try/catch, hold while the page lacks focus; commits bd7e589..f62ee8e)
Task 11: minor (deferred): a pill click in an unfocused frame: place() after its await does not re-check state (can show Done over a new recording); copy in an unfocused frame rejects (text kept in lastResult); manual cross-origin iframe check
Task 11: minor (deferred): ensureVisible can move the pill during recording when its field is scrolled off screen
Task 11: minor (deferred): release({ held }) parameter shadows the controller's held variable
Task 11: note for Task 14: behaviour change: a result arriving while the user is in another window or tab is held until they return (sticky "Return to the field to insert, or click here to copy."); README and smoke checklist must say so; add an untrusted synthetic-chord check and a cross-origin iframe pill-click check to the checklist
Task 11: complete (commits 60700de..f62ee8e, review clean)
Task 12: dispatched implementer ad5aeae7d8942a58a (opus), BASE f62ee8e
Task 12: implementer DONE_WITH_CONCERNS (24554bf; popup 44/44; suite 615/616, build clean, 6 files byte-identical); concern: a Task 11 test fails at clean f62ee8e
Task 11: REOPENED: controller reproduced "holds a result while the page lacks focus and inserts it when the window regains focus" (index.test.js) failing 3/3 runs at HEAD; Task 11 had reported 572/572; likely the test waits one setTimeout(0) while insertText's settle takes a macrotask plus up to 50 ms
Ruling: Task 11 fix round 2 (resume its implementer): make the test wait for the settled outcome (vi.waitFor or equivalent), verify the production hold path is not itself broken, run the file 5 times; Task 12 review proceeds in parallel (disjoint files); why: the suite must be green and the evidence reproducible; cost if wrong: none
Task 12: minor (deferred, plan-mandated): overlapping saves where the first fails can roll back the second change in memory though storage kept it
Task 12: minor (deferred, plan-mandated): reset also resets translateTargetLang and pillGap without saying so
Task 11: fix round 2 implemented (6547bfa, test only: waits for the settled Done; production path verified); controller re-ran index.test.js 17/17 x3, suite 616/616
Task 11: fix round 2/5 (1 addressed, 0 open: held-result test waits for the settled insert; commits 24554bf..6547bfa)
Task 11: complete again (commits 60700de..f62ee8e plus 6547bfa, review clean)
Task 12: review (f62ee8e..24554bf): spec ok vs brief (6 files identical), Needs fixes; 2 Important plan-mandated (double-click or held Enter passes both inline confirms on irreversible Reset and Clear history; mode editor Save button contradicts spec 6.6 autosave, half-written prompts lost when the popup closes), 9 Minor
Ruling: fix both in Task 12 round 1: (1) createInlineConfirm ignores a second activation within 400 ms of arming or with event.detail > 1; form.test covers double-click; (2) edits to an existing mode autosave on change, blur and 800 ms after the last input (same path as vocabulary; empty name is not saved and shows the hint); a new mode keeps an explicit "Create mode" button that saves once and switches the editor to autosave; the "Save mode" button is removed for existing modes; tests cover both; why: spec 6.6 is binding ("Autosave everywhere; no Save button") and destructive actions need a real two-step confirm; cost if wrong: a mode edit persists before the user meant it (undo by editing again)
Task 12: minor (deferred): stale popup snapshot vs pill UPDATE_SETTINGS (minor: action popup closes on focus loss); send only changed fields if the popup ever becomes a tab or options page
Task 12: minor (deferred): overlapping commits can roll back a successful later save in memory (serialize commits)
Task 12: minor (deferred): Reset also resets translateTargetLang and pillGap without naming them
Task 12: minor (deferred): mode list rebuild on every commit can swallow the first click after editing a text field (skip rebuild when modes/activeMode unchanged); checklist item
Task 12: minor (deferred): Test click blurs and saves the candidate key before validation; checklist note
Task 12: minor (deferred): failed first usage load shows zeros silently
Task 12: minor (deferred): coverage: vocabulary debounce, focused field not overwritten, deleting active custom mode, failed Reset; contrast pairs maintained by hand
Task 12: minor (deferred): parseKeywords drops terms past 100 silently
Task 12: minor (deferred, plan-mandated): popup.js 520 lines, one 460-line closure
Task 12: fix round 1 part A (327ce22; 628/628, build clean); additions: pending debounce flushed on Close/switch, failed save reverts editor fields; concern: held Enter still confirms (repeat clicks after the OS delay)
Ruling: same round, createInlineConfirm prevents repeated Enter/Space keydowns (event.repeat) on the button; closing the editor with an empty name discarding its unsaved edits is accepted; why: the finding named held Enter; cost if wrong: none
Task 12: fix round 1 part B (4bc37ec; 630/630): repeated Enter/Space keydowns prevented; real-Chrome effect is a checklist item
Task 12: fix round 1/5 (2 addressed, 0 open: confirm guard incl. key repeat, mode autosave with Create for new modes; commits 6547bfa..4bc37ec)
Task 12: minor (deferred): likely lost first click in the mode list after an unsaved editor edit (blur save rebuilds the list under the pointer); checklist line or update renderModes in place
Task 12: minor (deferred): renderEditor assigns mode.prompt without ?? '' (corrupt data plus failed save shows "undefined")
Task 12: minor (deferred): no test pins the mode editor change listener alone; switching modes flush untested
Task 12: note for Task 14: checklist lines: double click on Reset/Clear does nothing; mode edits save without a button; first click in the mode list after typing in the editor
Task 12: complete (commits f62ee8e..24554bf plus 327ce22, 4bc37ec, review clean)
Task 13: dispatched implementer a79c60319f82c7fb6 (opus), BASE 4bc37ec; browsers via PLAYWRIGHT_BROWSERS_PATH=SCRATCH/browsers (no download)
Task 13: implementer DONE (f0fe87f; unit 630/630; e2e 3/3 on four runs; controller re-ran e2e 3/3); package-lock engines now synced (Task 1 minor resolved)
Task 13: review (4bc37ec..f0fe87f): spec ok (8 files identical; 6.10 met with exact text and exact provider call; leak guard makes a real-provider pass impossible; server loopback-only, traversal-safe), Approved, 0 Critical/Important, 3 Minor
Task 13: minor (deferred): catch-all abort is silent; record aborted URLs and assert none in afterEach
Task 13: minor (deferred): pill clicks use raw mouse.click without a hit test; assert elementFromPoint hits the host
Task 13: minor (deferred, plan-mandated): generic PORT env var with reuseExistingServer; prefer VT_FIXTURE_PORT
Task 13: complete (commits 4bc37ec..f0fe87f, review clean)
Ruling: Task 14 docs cover the fix-round behaviours the brief predates: README and CHANGELOG state that a result arriving while the user is in another window or tab waits for their return (sticky "Return to the field to insert, or click here to copy."), that pages cannot trigger the hotkey with synthetic key events, that Reset and Clear history need two separate clicks, and that mode edits save automatically; the smoke checklist adds: synthetic chord from the DevTools console does nothing; held result inserted on return and copyable by click; cross-origin iframe pill click while the parent is focused; double click and held Enter on Reset do nothing; mode edits survive closing the popup mid-edit; first click in the mode list right after typing in the editor; a dir=rtl page renders the pill identically; a field in a showModal dialog (known limitation: pill inert under the top layer); why: docs must match shipped behaviour; cost if wrong: none
Task 14: dispatched implementer abbea1a75e80b1107 (opus), BASE f0fe87f, with the docs ruling
Task 14: implementer DONE_WITH_CONCERNS (a1c157d; 633/633, build clean, e2e 3/3); concerns for final review: two pills across frames (activeElement persists), held-status click may insert and copy, copyText does not fall back when writeText rejects (cross-origin iframes)
Task 14: review (f0fe87f..a1c157d): spec ok (brief plus ruling; every 6.1 to 6.10 item mapped to the checklist), Approved, 0 Critical/Important, 7 Minor
Task 14: minor (deferred): PRIVACY and CHANGELOG say <all_urls> is used only for re-injection; the provider fetches also run under it
Task 14: minor (deferred): checklist "pills across frames" has no pass criterion (lingering frame pill vs spec 6.4)
Task 14: minor (deferred): frame held-status checklist line lacks "inserted at most once"
Task 14: minor (deferred): README says clicking elsewhere copies; a click into the parent frame holds instead ("or another frame of the page")
Task 14: minor (deferred): CHANGELOG does not tell Mac users the default chord moved from Command+Shift+Space to Control+Shift+Space
Task 14: minor (deferred): checklist key-isolation check does not cover a fresh browser restart before the SW runs
Task 14: minor (deferred): README "shadow DOM fields" should say open shadow roots
Task 14: complete (commits f0fe87f..a1c157d, review clean)
All 14 tasks complete; HEAD a1c157d; unit 633/633; e2e 3/3; build clean
Final review: dispatched a8ec877b3f106b195 (opus) over 6633dfd..a1c157d with ledger triage
Final review (6633dfd..a1c157d, Opus): With fixes; 0 Critical, 5 Important (F1 stale offscreen report accepted by the next session, reproduced; F2 no content processing timeout; F3 copyText no execCopy fallback on reject, reproduced; F4 raw DOM rung accepts first positive read, reproduced; F5 spec 6.4 two pills across frames), minors triaged (fix: v2.0 leftover pill, 7 doc and checklist lines); findings file final-review-findings.md
Ruling: F1 capture id per session echoed in LEVEL/DONE/ERROR, offscreen busy until its report is sent, discard for an ok reply to a freed session, controller ignores results while starting/recording; why: a transcript crossing tabs and a live mic with no UI break load-bearing properties; cost if wrong: small message contract change (captureId field)
Ruling: F2 content watchdog 75 s in processing, re-armed by RECORDING_STATE, idle with "No response from VoiceType. Try again.", bound target kept so a late result still follows D12; why: v2.0 had one and the SW can die mid-fetch; cost if wrong: a spurious reset after 75 s on a very slow provider (result still delivered late)
Ruling: F3 copyText falls back to execCopy when writeText rejects; F4 raw rung confirms after a second window (revert gives clipboard, ambiguous gives unverified); F5 settle hides an idle, non-busy pill when the frame lacks focus; F6 remove the v2.0 #voicetype-pill at boot; F7 doc lines (host permission covers provider fetches, frame hold, open shadow roots, Mac chord change, Windows AltGr warning, checklist pass criteria); why: reviewer reproductions and doc accuracy; cost if wrong: none material
Ruling: every other deferred minor stays as triaged LEAVE by the final reviewer (list in the final report); why: cosmetic, hand-edited storage only, test hygiene, or covered elsewhere; cost if wrong: listed per line in the final review
Final fix wave: dispatched a5a3e39942717d41f (opus), FIX_BASE a1c157d
Final fix wave: implemented (fba5ada..6269269, 8 commits; unit 659/659, build clean, e2e 3/3 x3); NEEDS_CONTEXT on F1.5
Ruling: F1.5 corrected: the controller ignores DICTATION_RESULT while 'starting' or 'recording' and ignores RECORDING_STATE 'processing' only while 'starting'; why: my literal clause broke auto-stop (the frame stayed 'recording' and the result was then dropped; 3 existing tests failed); the SW captureId filter is the real guard, the content guard is defense in depth; cost if wrong: none known
Ruling: OFFSCREEN_STOP carries captureId and the offscreen ignores a stop for another capture; why: an untargeted discard on a late reply could kill a newer session's capture; cost if wrong: none
Ruling: accept the rewritten checklist line 79 (start recording in the frame, click the page textarea while it processes) and that F5 also hides an idle pill when the whole window loses focus (it returns on focusin); why: the old steps were unreachable after F5; cost if wrong: none
Final fix wave: re-review (a1c157d..6269269): all 7 findings ADDRESSED, no new Critical/Important; 3 Minor plus out-of-scope notes
Final wave: parked; DONE overtaking the START reply can leave the frame 'recording' and drop the result; Ruling: park, theoretical (needs a message sent at least 1 s later to overtake the reply on runtime.sendMessage); Phase 2 hardening: onDone awaits s.starting; cost if wrong: one lost transcript in a race not observed
Final wave: parked; execCopy fallback on automatic copies in an unfocused frame may pull focus into that frame; Ruling: park, likely fails without activation anyway; smoke checklist frame section covers it; option: fall back only when navigator.userActivation.isActive; cost if wrong: a focus jump into an iframe after a missed insert
Final wave: parked; capture.test.js spies on Blob.prototype.arrayBuffer without restoring; Ruling: park, test hygiene, later tests do not read audio; cost if wrong: a confusing future test failure
Final wave: parked; after a watchdog expiry a same-tab REC while the SW still processes says "busy in another tab"; Ruling: park, wording only; cost if wrong: a misleading message
Final wave: parked; after an SW restart an orphaned offscreen capture holds the mic until max time; Ruling: park, needs the SW to die mid-recording despite the 10 Hz heartbeat; cost if wrong: mic on up to maxRecordingTime with the tray indicator visible
Final wave: parked; CHANGELOG.md:21 says "another window or tab" (README says "window, tab or frame"); Ruling: park, cosmetic doc wording; cost if wrong: none
Phase 1: all 14 tasks complete, final review fixed; branch phase-1 at 6269269; unit 659/659; build clean; e2e 3/3 (controller verified)
