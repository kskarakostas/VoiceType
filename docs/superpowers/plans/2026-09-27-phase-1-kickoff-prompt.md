# Phase 1 kickoff prompt

Paste the block below into a fresh Claude Code session opened in this repository. Fill the smoke-results line first.

---

Resume VoiceType. Phase 0 (v2.0.0 tree) is merged on `main` and pushed to https://github.com/kskarakostas/VoiceType. Write and execute the Phase 1 plan.

Read these inputs first, in order:
1. `docs/superpowers/specs/2026-09-26-voicetype-roadmap.md`: sections 2 to 4 for decisions and architecture, section 6 for the Phase 1 design (offscreen recorder, Shadow DOM pill, positioning, frames and shadow hosts, insertion ladder v2, popup rework, orphan handling, hold-to-talk hotkey, silence auto-stop, Playwright smoke).
2. `docs/superpowers/plans/2026-09-26-phase-0-ledger.md`: every line containing `minor (deferred)`, `Phase 1`, `note for` or `parked` is Phase 1 input. From the final-review section, M2 (restrict `chrome.storage` access to trusted contexts and stop pushing keys to tabs) and M3 (the new pill renders user data with `textContent` only) are Phase 1 requirements, not options.
3. `docs/superpowers/plans/2026-09-26-phase-0-smoke-checklist.md` plus my results: SMOKE RESULTS: <passed everything | failed sections: ...>. Any failure there is fixed before Phase 1 work starts.
4. The project memory (auto-loaded) and `docs/superpowers/plans/2026-09-26-phase-0-foundation-and-fixes.md` for the plan format and Global Constraints to reuse.

Ground rules, unchanged from Phase 0: plain JavaScript with JSDoc, esbuild + Vitest, `minimum_chrome_version` 116, API keys plaintext in `chrome.storage.local` and never written by content scripts, no em or en dashes anywhere, commit messages carry only the change description, GitHub release only (no Web Store), all subagents on Opus, branch `phase-1` off `main`. Address me as Kostas; in files I am K. S. Karakostas.

Deliverables:
A. Before planning, verify against current official docs: the offscreen-document microphone flow (`chrome.offscreen.createDocument` with `reasons: ['USER_MEDIA']`, `chrome.runtime.getContexts`, the permission-page grant from the `cookbook.offscreen-user-media` sample), whether `chrome.storage.local.setAccessLevel` restricts content-script access at Chrome 116, and current Chrome behaviour of `execCommand('insertText')` inside Lexical and ProseMirror editors. Then batch every design question into one `AskUserQuestion` (at most 4 questions, enumerated options, one recommended).
B. `superpowers:writing-plans` produces `docs/superpowers/plans/2026-09-27-phase-1-core-rebuild.md` from spec section 6 plus the ledger lines, with a Review Focus section and full TDD steps.
C. Execute it with `superpowers:subagent-driven-development`, one ledger, Opus implementers and reviewers, a whole-branch review at the end, and a browser smoke checklist for me. Bump the manifest and package version to 2.1.0 and extend `CHANGELOG.md`.

Start by reading the four inputs, then ask the batched design questions.
