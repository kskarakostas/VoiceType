# VoiceType 3.0 release smoke checklist (for K. S. Karakostas)

Branch `v3`, version 3.0.0. Covers every lane, the 2.2 regression list in spec section 1, the items the L4 and L5 smokes left open, the top layer, the review fixes and the packed upgrade. Needs Chrome 140 or newer, working OpenAI and Gemini keys, speakers and a real microphone.

The Run column says who has it: **H** a harness ran it (results at the end), **M** a person has to. Your part is every M row. Run H rows you want to see for yourself. Fill Result with pass, fail (with the exact on-screen text) or n/a.

## 0. Before you reload

The upgrade is one way: a browser taken back to 2.2.0 shows an empty vocabulary, so copy your vocabulary first if you may go back. Coming forward again keeps dictionary and site rules.

| # | Run | How | Expected | Result |
|---|-----|-----|----------|--------|
| 0.1 | M | Do this first. With 2.2.0 loaded unpacked from this folder and your real settings, run the build below, then click the reload icon on the VoiceType card in chrome://extensions. | Keys masked on Settings, Provider; your custom mode after the built-ins; your terms in the Dictionary's All languages group; your hotkey on Settings, Recording; your history on Settings, Usage and data. | |

Build. A profile with no VoiceType loaded: **Load unpacked** on `chrome://extensions`, pick `dist/`.

```bash
npm test
```

```bash
npm run test:e2e
```

```bash
npm run build
```

Start the fixture pages in a second terminal and leave them up:

```bash
node test/fixtures/serve.mjs
```

Reload any open page after reloading the extension. Fixture pages: `http://localhost:8765/fields.html` (text field, textarea, contenteditable, password field, open shadow root input, same-origin and cross-origin iframes), `/hostile.html` (a page rule attacks the pill host), `/rtl.html` (right to left). The hotkey is Ctrl+Shift+Space. To change the style, use Settings, Appearance.

## 1. Upgrade from 2.2.0

| # | Run | How | Expected | Result |
|---|-----|-----|----------|--------|
| 1.1 | H | A 2.2 store (a key, a custom mode, vocabulary, a changed hotkey) read by this build. | The pages show the masked key, the custom mode last, the terms in All languages and the hotkey. | |
| 1.2 | H | A live call with dictionary terms. | The terms go with the request, one call per provider. | |
| 1.3 | H | A packed 2.2.0 updated to a packed 3.0.0 with one signing key. | Off until accepted; see "Packed upgrade" at the end. | |
| 1.4 | H | A page open during that update, with the 2.2 pill showing. | While off, a press gives the orphan notice. After accepting, one working pill with no reload. | |
| 1.6 | H | A 3.0 store stamped back to version 2 by 2.2, read by this build. | Dictionary, site rules and style kept, keywords merged. | |

## 2. Settings page and quick panel (L0)

| # | Run | How | Expected | Result |
|---|-----|-----|----------|--------|
| 2.1 | H | chrome://extensions, Details, Extension options. | The settings page opens in a tab at Home. | |
| 2.2 | H | Reload on `#settings/recording`; type `#nope` in the address bar. | Stays on Recording; `#nope` shows Home. | |
| 2.3 | H | Read the sidebar. | Home, Modes, Dictionary, then Settings: Provider, Recording, Speech, Sites, Appearance, Sound and clipboard, Usage and data. Footer: Version 3.0.0, by K. S. Karakostas, GitHub, Privacy. | |
| 2.4 | H | Window under about 720 px, light and dark. | The sidebar stacks, nothing scrolls sideways, text readable. | |
| 2.5 | H | The real popup from the toolbar icon. | Status, Provider, Mode, This site, Today, Open settings. | |
| 2.6 | H | Open settings with no settings tab, then again with one open on Modes. | A new tab at Home; then the same tab comes to the front, still on Modes, with no reload. | |
| 2.7 | M | Two real OS windows (the harness display has no window manager). The settings tab in a second window, focus the first, Open settings from its popup. | The second window comes to the front with the tab active. | |
| 2.8 | H | Pick a provider with no key in the popup. | "Add API key" shows and opens Provider. | |
| 2.9 | H | Change the mode in the popup. | The toast names it; the pill shows it within a second. | |
| 2.10 | H | Maximum length and a spoken language: change, wait a second, close the tab. Clear on a key. | Stored. | |
| 2.10b | M | Provider: switch provider; paste a key; Test says it works; Clear empties it, toast "Key cleared"; paste it back. Hotkey: click, press a new chord; Esc cancels while armed. | As stated, and each is there after you close and reopen the tab. | |
| 2.11 | H | Type a mode prompt, wait a second, Ctrl+W, reopen. Same with a key. | Both are there. | |
| 2.12 | H | Settings page and popup open: change the mode in the popup, the maximum length on the page. | Both stay. | |
| 2.13 | H | Reset to defaults, two clicks. | Keeps keys, provider, spoken languages, dictionary, site rules. Everything else resets; custom modes go. | |
| 2.14 | M | Tab through the settings page with a screen reader on, also Home's day squares and the Sites table. | The order follows the screen; a sidebar link moves focus to the page heading; rings show; each day reads like "Monday, dictated". | |

## 3. Home (L1)

| # | Run | How | Expected | Result |
|---|-----|-----|----------|--------|
| 3.1 | H | A log from 2.2 with no words. | Time saved, Words, Speaking speed and Per 1,000 words read "Counted from 3.0 on"; sessions, cost and days are real. No NaN. | |
| 3.2 | H | Dictate "This is a short test of the word counter" with Home open in another tab. | Words go up by nine with no reload. | |
| 3.3 | H | Dictate a Greek sentence of four words. | Words go up by four. | |
| 3.4 | H | Thresholds: under 30 s of talking; under 100 words. | "Shows after 30 s of talking", "Shows after 100 words"; past them, the numbers. | |
| 3.5 | H | Seven day squares. | Monday first, today outlined, days to come dashed, dictated days filled. | |
| 3.6 | H | Clear history. | "Dictate once to see your stats." with no reload. | |
| 3.7 | H | Dictate with Settings, Usage and data open; a dictation in Email. | The table updates with no Refresh; Refined by a mode goes up by one. | |

## 4. Dictionary (L2)

| # | Run | How | Expected | Result |
|---|-----|-----|----------|--------|
| 4.1 | H | Enter adds; `Alpha, Beta` adds two; `palowise` after `Palowise` is refused with "Already in All languages"; a 65-character term is refused. | As stated. | |
| 4.2 | H | Add language Greek, add a term; paste a three-line list. | A Greek card; the list reads as `a, b, c`. | |
| 4.3 | H | Type with no Enter, click away. Type with no Enter, wait a second, Ctrl+W, reopen. | Added both times. | |
| 4.4 | H | The same close with the service worker asleep (page idle a minute). | Added. | |
| 4.5 | H | Remove a chip by mouse and by keyboard; double-click an x; Remove group, two clicks. | One term each; focus moves on; the group goes after the second click. | |
| 4.6 | H | Export CSV, then import the same file. | "Nothing new: all N terms are already in the dictionary." | |
| 4.7 | H | Import: one term per line; an unknown language; past 100 terms. | Into All languages; "Line N: unknown language"; "over the 100 term limit by N". Nothing imported on an error. | |
| 4.8 | M | Open the export in real Excel; save as CSV UTF-8 and import; save as plain CSV with Greek; save as Unicode Text. | Greek reads right; the UTF-8 file imports; both others are refused with nothing imported, "This file is not UTF-8. Save it as CSV UTF-8 and try again. Nothing was imported." | |
| 4.9 | H | Two settings tabs: add a term in one. | The other shows it; text being typed there stays. | |
| 4.10 | H | Dictate with a term from any group. | It goes with the request, one live call per provider. | |
| 4.11 | M | An IME (Greek polytonic or similar) in the add field. | Composition is not cut. | |

## 5. Site rules (L3)

| # | Run | How | Expected | Result |
|---|-----|-----|----------|--------|
| 5.1 | H | Hide pill in the popup on a site. | Within a second the idle pill goes, in frames too, and stays gone after a reload. Other sites keep theirs. | |
| 5.2 | H | The hotkey on the hidden site: tap, hold, password field, focus moved during processing. | Minimal indicator; the text lands; refusal; clipboard with its status. | |
| 5.3 | H | Mode on this site Email. | Used here and in its frames; the global mode unchanged; other sites use the global mode. | |
| 5.4 | H | The pill's menu on that site. | Mode marked This site, Use active mode first. A pick changes the site, not the global mode. Use active mode clears it. | |
| 5.5 | H | A custom mode set on a site, then deleted. | The site falls back; the row goes unless it hides the pill. | |
| 5.6 | H | The popup on chrome://extensions, a `file:` page, the new tab page. | "Not available on this page". | |
| 5.6b | M | The popup on the Web Store. | Same. | |
| 5.7 | H | Add site: a full URL; the same again; `not a host`; Hide pill off with no mode; a draft left unsaved. | `example.com` row; "example.com already has a rule."; refused; "Turn on Hide pill or choose a mode."; no rule. | |
| 5.8 | H | Change a mode in a Sites row, change it from the pill on that site, come back and toggle Hide pill on the row. | The newer mode survives. | |
| 5.9 | H | Back to a page after the rule changed. | The current rule applies. | |
| 5.9b | M | Hide a site you visit daily, type its address from another site so Chrome may prerender it, click a field. The reverse from a hidden site to a normal one. | No pill; then the pill. | |
| 5.9c | H | A field scrolled out of view, the hotkey, on a normal and a hidden site. | The pill in the corner, or Minimal at the bottom centre; back at the field on a scroll. | |
| 5.9d | H | Click the pill's mode button across its width. | The menu opens from every point. | |
| 5.10 | H | The real action popup: with Hide pill on, untick it with the page open, each style. Row 5.1 ticks it. | The page follows. | |

## 6. Sound and clipboard (L4)

| # | Run | How | Expected | Result |
|---|-----|-----|----------|--------|
| 6.1 | H | Defaults. | Both off. With both off, no tone and the clipboard unchanged. | |
| 6.2 | H | Sounds on: click, tap, hold, silence auto-stop. | Start, stop, done, once each, read from real output. | |
| 6.3 | H | Too short; double tap; silence; no key; another tab busy. | No error tone except for "No speech detected."; each status right. | |
| 6.4 | H | Cancel while starting; navigate during a recording. | No stray tone; the next start is not busy. | |
| 6.5 | H | Always copy on: textarea, contenteditable, cross-origin frame, a multi-line Greek result, a long hold, a silence auto-stop over 5 s after the last key. | Text in the field, same text on the clipboard, no "Not copied". | |
| 6.6 | H | Close the tab during processing, Always copy off. | The paste gives the text (review fix). | |
| 6.7 | H | Slow provider, focus moved. | "The field lost focus. Text copied to clipboard." and no page prompt. | |
| 6.7b | H | A build without `clipboardWrite`, a write left pending. | "Could not insert. Click here to copy the text." about 1 s later; a click copies. | |
| 6.8 | M | Real speakers and a real microphone, no headphones, usual volume, Play sounds on, OpenAI then Gemini. Press the hotkey, say nothing, stop after 3 s. | "No speech detected." Any text means the start tone got into the recording: note it. | |
| 6.9 | M | Same, speaking one sentence right after the start tone. | Only that sentence; its first words not cut. | |
| 6.10 | M | Listen to each tone. | Clean end, no click. Audible at low volume and over another tab's audio. | |
| 6.11 | M | A Bluetooth headset. | Note whether the start tone is late or lost, and whether a tail is cut. | |
| 6.12 | M | A real Google Doc, Always copy off, then on: dictate. Then Settings, Recording, Silence auto-stop on: press the hotkey once, speak for over 5 s, stop talking and let it end, with no key or mouse in between. | "Copied to clipboard. The field could not be edited."; the paste gives the text; no page prompt. | |
| 6.13 | H | chrome://extensions, Details. | The list reads "Modify data you copy and paste." | |
| 6.14 | M | Hold to talk on a physical keyboard for over 5 s, always copy on. | The text lands, no "Not copied". | |

## 7. Pill styles (L5)

| # | Run | How | Expected | Result |
|---|-----|-----|----------|--------|
| 7.1 | H | Appearance page, light and dark, keyboard, phone width. | Pill, Dot (Default), Minimal, previews; arrows save; no sideways scroll. | |
| 7.2 | H | Each style on text field, textarea, contenteditable, shadow input, both iframes, `hostile.html`, `rtl.html`. | Idle: bar, dot, nothing. Recording: bar, bar, indicator. The text lands, `Done` and the cost. | |
| 7.3 | H | Dot: point, leave, return within 0.3 s. | Opens; closes after about 0.3 s; a return keeps it open. | |
| 7.4 | H | Minimal: resize; stop; password field; click through the indicator and through `Done`. | Stays bottom centre; dots, then `Done`; refusal; the page gets the clicks; no menu. | |
| 7.5 | H | A live switch of style in a second tab, idle and during a recording. | Applies within a second; the recording goes on; an open menu closes. | |
| 7.6 | M | The same with Settings in a second OS window, side by side. | As 7.5. | |
| 7.7 | H | Reduced motion. | Bars static, clock runs, no pulse, Dot opens at once, steady ring. | |
| 7.8 | H | TinyMCE at `tiny.cloud`, each style, with and without Hide pill. | The text lands; two indicators are expected on such an editor. | |
| 7.9 | M | Forced colors on (DevTools, Rendering, or a Windows contrast theme), by eye, on Settings, Appearance and a recording on `fields.html`. | Selected card and focus rings visible; the pill readable. | |

## 8. A recording in a frame out of sight (L5)

Both frames, Dot unless stated. Row 8.8 ran on a same-origin frame.

| # | Run | How | Expected | Result |
|---|-----|-----|----------|--------|
| 8.1 | H | In view, scroll out, scroll back; fast flips. | Own indicator; bottom centre indicator with live clock and bars; back; nothing left over. | |
| 8.2 | H | Stop while out of sight. | Dots, the text lands, it goes. | |
| 8.3 | H | Frame removed; `display: none`; `opacity: 0`; `visibility: hidden`; an opaque overlay. | Each brings it up or clears it; undoing takes it away. | |
| 8.4 | H | Hide pill on. | Same. | |
| 8.5 | H | A page field used beside it, menu included; a press there. | Usable; "VoiceType is recording in another field of this page. Click back into it to stop." | |
| 8.6 | H | Tab closed; Back to a restored page; extension turned off. | Clears; no false indicator; the orphan notice. | |
| 8.7 | H | A 3000 px tall frame on Minimal: `Done`, a refusal. | By the field, inside the window. | |
| 8.8 | H | A top page that finishes loading after the frame went out of sight. | The indicator comes up (review fix). | |

## 9. Top layer

Rows 9.1 to 9.3 ran with Pill, Dot and Minimal, on a recording in the top frame and in the cross-origin frame, headless and headed. Row 9.4 ran Dot and Minimal in the top frame.

| # | Run | How | Expected | Result |
|---|-----|-----|----------|--------|
| 9.1 | H | A modal `<dialog>` opened during a recording. | The indicator paints over it; the dialog stays modal; focus does not move. | |
| 9.2 | H | A page popover. | Same; it stays open. | |
| 9.3 | H | A fullscreen element. | Same; fullscreen stays. | |
| 9.4 | H | Material Web `md-dialog` and a Bootstrap modal, dictating into a field inside. | The text lands; the dialog stays; Bootstrap's focus trap is undisturbed. | |
| 9.5 | H | After the status ends under a modal. | The host leaves the top layer: the idle pill is under the modal, as in 2.2. | |
| 9.6 | H | The page calls `hidePopover()` on the host; removes the host. | Back within a second. | |
| 9.7 | H | A held pointer on Stop; keyboard focus on Stop; an open menu scrolled; the processing pulse. | Each survives the raises. | |
| 9.8 | M | A real site with a native modal you use (GitHub's command palette, for example), and a real video in fullscreen, in Chrome on your screen. | The indicator shows; nothing flickers. | |
| 9.9 | M | A screen reader on `fields.html`, a dictation, then the same on the 9.8 site with its modal open. | With no modal a status is read once. Under a modal it is inert: note what you hear. | |

Known limit: under a modal the indicator and statuses can be seen, not clicked. The hotkey works; close the dialog to click a click-to-copy status.

## 10. 2.2 regressions (spec section 1)

Rows 10.1, 10.5, 10.6, 10.7 and 10.8 ran on each style; 10.3 on Dot.

| # | Run | How | Expected | Result |
|---|-----|-----|----------|--------|
| 10.1 | H | Hold to talk. | The text lands on release. | |
| 10.2 | H | Dictation in frames and shadow roots. | The text lands. | |
| 10.3 | H | Textarea and contenteditable on `fields.html`: type, dictate, one Ctrl+Z. | Inserted once; undo removes exactly the dictated text. Slate and Lexical rungs are unit tests; 10.4 is their real check. | |
| 10.4 | M | Your real sites: Gmail, Notion, Slack, ChatGPT, claude.ai, Facebook. | Inserted once, or also on the clipboard with "Could not confirm the insert. The text is also on the clipboard." | |
| 10.5 | H | Orphan: extension off with a page open, a press; extension reload with a page open. | "VoiceType was turned off or updated. Reload this page."; after a reload the new copy records. | |
| 10.6 | H | Password field. | "VoiceType does not record in password fields." and no recording. | |
| 10.7 | H | Cost: the Done status, Today in the popup, Usage and data. | One session per dictation, the right cost. | |
| 10.8 | H | Held result: a frame, focus moved to the page, back to the field. | "Return to the field to insert, or click here to copy."; the text lands once. | |

## 11. Review fixes

The guard against a press while a result is landing has unit tests only: no harness hits the window.

| # | Run | How | Expected | Result |
|---|-----|-----|----------|--------|
| 11.1 | H | `document.documentElement.style.zoom = '2'` and `'0.75'` in the console, each style. Zoom 2 in frame 0 over a mirror, on Minimal. | The indicator stays in the window, in its place. | |
| 11.2 | H | "Could not insert. Click here to copy the text." up (a build without `clipboardWrite`, as 6.7b), press the hotkey. | "Copied to clipboard."; the next press records. | |
| 11.3 | H | Gemini and OpenAI, real speech, one take each. | The sentence comes back. | |

## 12. Anything else on real hardware

| # | Run | How | Expected | Result |
|---|-----|-----|----------|--------|
| 12.1 | M | Windows and macOS, if you ship there. | The hotkey, a dictation, the settings page. | |
| 12.2 | M | Chrome 140 itself, if you can get one (runs were on 153 and 156). | Loads; `currentCSSZoom` and popovers exist. | |

## Automated results (Atlas, 2026-11-04)

Run on the real build at `9f8e607`, the last commit under `src/`. Later commits touch documents, the screenshots and their spec only. L4, L5, L6 and the dialog libraries ran headed in a nested X display with a real X clipboard and real audio output captured from a null sink; e2e, L1 to L3 and real speech ran headless. Provider stubbed unless stated. Harnesses are in the session scratchpad, `smoke/`.

| Gate | Chromium 153 | Chrome 156 |
|---|---|---|
| `npm test` | 1677/1677 | |
| `npm run test:e2e` (headless) | 176/176 | |
| `npm audit --omit=dev` | 0 vulnerabilities | |
| L1 items | 9/9 | not run |
| L2 items, with one live call per provider | 11/11 | not run |
| L3 items, with a live refine (the hide-only menu item is superseded: Minimal has no menu, an e2e pins the rule) | 15/15, 1 skipped | not run |
| L4 items, with real output and the real X clipboard | 35/35 | 35/35 |
| L5 items | 119/119 | 119/119 |
| L6 items (`run-l6.mjs`: L0 pages, the real popup, rollback, tab closed, late top page, top layer headed, undo, zoom) | 45/45 | 45/45 |
| Real dialog libraries (Material Web, Bootstrap) | 7/7 | 7/7 |
| Real speech, one take per case: OpenAI Email, OpenAI no rule, OpenAI Translate to Greek on a hidden site, Gemini no rule, Gemini Email | 4/5 in the full run; the hidden-site case waited for a stale selector, and passed on a rerun with that fixed: "Γεια σου, Μαρία..." | not run |

On the OpenAI Email take the refined text ended with a stray non-Latin character from the model (`gpt-6-luna`), not from VoiceType.

Rows 1.3 and 1.4 come from the probe below, which ran on `62a26d1`, before the fix wave, and was not rerun on `9f8e607`. Round 2 of the review compared migration before and after that wave on a full 2.2 store: identical output.

## Packed upgrade

Run at `62a26d1` with one signing key, Chromium 153 through a local update server. Chrome 156 refuses a self-packed crx, so its profile came from Chromium with the install location edited to the store's, and its own updater fetched the crx. Not a Web Store update.

- The update turns VoiceType off until the user accepts, at the store's install location. At the local-server location a browser restart granted it silently. Update while running: no bubble; the toolbar icon goes; the menu button reads "Action required"; the menu's top item reads "VoiceType - BYOK Speech to Text is disabled"; its bubble says "To re-enable it, accept the new permissions: Modify data you copy and paste", with Remove and Accept permissions.
- Update applied at browser start: the same bubble opens by itself.
- Keys, modes and active mode unchanged; terms in `dictionary.any`; `settingsVersion` 3.
- While off, an open page keeps its 2.2 pill; a press does not record and shows "VoiceType was turned off or updated. Reload this page."
- After accepting: one host, the hotkey records, with no reload, on open tabs and on tabs loaded while off.
- 2.2 keeps its offscreen document, and with one recording in the session the update waited for the next browser start (one run).

An unpacked build, which is how the README installs, asks nothing. Your own check, if you ever ship to the store: a real store update.

## What stays manual

Rows marked M: 0.1, 2.7, 2.10b, 2.14, 4.8, 4.11, 5.6b, 5.9b, 6.8 to 6.12, 6.14, 7.6, 7.9, 9.8, 9.9, 10.4, 12.1, 12.2. That is real speakers and a real microphone, Bluetooth, real Google Docs, real Excel, an IME, two real OS windows, a screen reader, forced colours by eye, a real physical keyboard, your real sites and profile, the Web Store, a real prerender, Windows and macOS, Chrome 140.
