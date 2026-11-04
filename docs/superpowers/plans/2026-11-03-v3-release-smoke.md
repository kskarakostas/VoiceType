# VoiceType 3.0 release smoke checklist (for K. S. Karakostas)

Branch `v3`, version 3.0.0. Covers every lane, the 2.2 regression list in spec section 1, the items the L4 and L5 smokes left open, the top layer, the review fixes and the packed upgrade. Needs Chrome 140 or newer, working OpenAI and Gemini keys, speakers and a real microphone.

The Run column says who has it: **H** a harness ran it (results at the end), **M** only a person can. Your part is every M row. Run H rows you want to see for yourself. Fill Result with pass, fail (with the exact on-screen text) or n/a.

Build, then click the reload icon on the VoiceType card in chrome://extensions:

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

The upgrade is one way: a browser taken back to 2.2.0 shows an empty vocabulary. Going forward again keeps dictionary and site rules.

| # | Run | How | Expected | Result |
|---|-----|-----|----------|--------|
| 1.1 | H | On a 2.2 store (keys, a custom mode, vocabulary, a changed hotkey), load the build. | Keys masked on Provider, the custom mode after the built-ins, terms in the Dictionary's All languages group, the hotkey kept, the usage history shown. | |
| 1.2 | H | Dictate once with a dictionary word. | The term reaches the provider. | |
| 1.3 | H | Go from a packed 2.2.0 to a packed 3.0.0 with one signing key. | See "Packed upgrade" in the results. | |
| 1.4 | H | A page open during that update, with the 2.2 pill showing. | One working pill after the update, or the orphan notice until reload; never two. | |
| 1.5 | M | Your own Chrome profile, your real settings, reload from 2.2.0 to this build. | As 1.1 with your own data. | |
| 1.6 | H | A 3.0 store stamped back to version 2 by 2.2, reloaded on this build. | Dictionary, site rules and style kept. | |

## 2. Settings page and quick panel (L0)

| # | Run | How | Expected | Result |
|---|-----|-----|----------|--------|
| 2.1 | H | chrome://extensions, Details, Extension options. | The settings page opens in a tab at Home. | |
| 2.2 | H | Reload on `#settings/recording`; type `#nope` in the address bar. | Stays on Recording; `#nope` shows Home. | |
| 2.3 | H | Read the sidebar. | Home, Modes, Dictionary, then Settings: Provider, Recording, Speech, Sites, Appearance, Sound and clipboard, Usage and data. Footer: Version 3.0.0, by K. S. Karakostas, GitHub, Privacy. | |
| 2.4 | H | Window under about 720 px, light and dark. | The sidebar stacks, nothing scrolls sideways, text readable. | |
| 2.5 | H | The real popup from the toolbar icon. | Status, Provider, Mode, This site, Today, Open settings. | |
| 2.6 | H | Open settings with no settings tab, then again with one open on Modes. | A new tab at Home; then the same tab comes to the front, still on Modes, with no reload. | |
| 2.7 | M | The settings tab in a second OS window, focus the first, Open settings from its popup. | The second window comes to the front with the tab active. | |
| 2.8 | H | Pick a provider with no key in the popup. | "Add API key" shows and opens Provider. | |
| 2.9 | H | Change the mode in the popup. | The toast names it; the pill shows it within a second. | |
| 2.10 | H | For each of Provider, Recording, Speech, Modes: change it, wait a second, close the tab, reopen. | The change is there. Paste a key, Test works, Clear empties it. | |
| 2.11 | H | Type a mode prompt, wait a second, Ctrl+W, reopen. Same with a key. | Both are there. | |
| 2.12 | H | Settings page and popup open: change the mode in the popup, the maximum length on the page. | Both stay. | |
| 2.13 | H | Reset to defaults, two clicks. | Keeps keys, provider, spoken languages, dictionary, site rules. Everything else resets; custom modes go. | |
| 2.14 | M | Tab through the settings page with a screen reader on. | The order follows the screen; a sidebar link moves focus to the page heading; rings show. | |

## 3. Home (L1)

| # | Run | How | Expected | Result |
|---|-----|-----|----------|--------|
| 3.1 | H | A log from 2.2 with no words. | Time saved, Words, Speaking speed and Per 1,000 words read "Counted from 3.0 on"; sessions, cost and days are real. No NaN. | |
| 3.2 | H | Dictate "This is a short test of the word counter" with Home open in another tab. | Words go up by nine with no reload. | |
| 3.3 | H | Dictate a Greek sentence of four words. | Words go up by four. | |
| 3.4 | H | Thresholds: under 30 s of talking; under 100 words. | "Shows after 30 s of talking", "Shows after 100 words"; past them, the numbers. | |
| 3.5 | H | Seven day squares. | Monday first, today outlined, days to come dashed, dictated days filled. | |
| 3.6 | H | Clear history. | "Dictate once to see your stats." with no reload. | |

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
| 4.8 | M | Open the export in real Excel; save as CSV UTF-8 and import; save as plain CSV with Greek; save as Unicode Text. | Greek reads right; the UTF-8 file imports; the others are refused with their texts. | |
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
| 5.6 | H | The popup on chrome://extensions, the Web Store, a `file:` page, the new tab page. | "Not available on this page". | |
| 5.7 | H | Add site: a full URL; the same again; `not a host`; Hide pill off with no mode; a draft left unsaved. | `example.com` row; "example.com already has a rule."; refused; "Turn on Hide pill or choose a mode."; no rule. | |
| 5.8 | H | Change a mode in a Sites row, change it from the pill on that site, come back and toggle Hide pill on the row. | The newer mode survives. | |
| 5.9 | H | Back to a page after the rule changed; a real prerender. | The current rule applies. | |
| 5.10 | M | Open the real popup on a site, tick Hide pill, watch the page behind it. | The idle pill goes with the popup open. | |

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
| 6.8 | M | Real speakers and a real microphone, no headphones, usual volume, Play sounds on, OpenAI then Gemini. Press the hotkey, say nothing, stop after 3 s. | "No speech detected." Any text means the start tone got into the recording: note it. | |
| 6.9 | M | Same, speaking one sentence right after the start tone. | Only that sentence; its first words not cut. | |
| 6.10 | M | Listen to each tone. | Clean end, no click. Audible at low volume and over another tab's audio. | |
| 6.11 | M | A Bluetooth headset. | Note whether the start tone is late or lost, and whether a tail is cut. | |
| 6.12 | M | A real Google Doc: with Always copy on and off, also after a silence auto-stop. | "Copied to clipboard. The field could not be edited."; the paste gives the text; no page prompt. | |
| 6.13 | H | chrome://extensions, Details. | The list reads "Modify data you copy and paste." | |

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
| 7.9 | M | Forced colors on, by eye. | Selected card and focus rings visible; the pill readable. | |

## 8. A recording in a frame out of sight (L5)

Both frames. Dot unless stated.

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

Each with Pill, Dot and Minimal, on a recording in the top frame and in the cross-origin frame.

| # | Run | How | Expected | Result |
|---|-----|-----|----------|--------|
| 9.1 | H | A modal `<dialog>` opened during a recording. | The indicator paints over it; the dialog stays modal; focus does not move. | |
| 9.2 | H | A page popover. | Same; it stays open. | |
| 9.3 | H | A fullscreen element. | Same; fullscreen stays. | |
| 9.4 | H | Material Web `md-dialog` and a Bootstrap modal, dictating into a field inside. | The text lands; the dialog stays; Bootstrap's focus trap is undisturbed. | |
| 9.5 | H | After the status ends under a modal. | The host leaves the top layer: the idle pill is under the modal, as in 2.2. | |
| 9.6 | H | The page calls `hidePopover()` on the host; removes the host. | Back within a second. | |
| 9.7 | H | A held pointer on Stop; keyboard focus on Stop; an open menu scrolled; the processing pulse. | Each survives the raises. | |
| 9.8 | M | A real site with a native modal you use (GitHub, for example), and a real video in fullscreen, in Chrome on your screen. | The indicator shows; nothing flickers. | |
| 9.9 | M | A screen reader during a recording under a modal. | Known limit: inert, so statuses are not announced. Note what you hear with no modal: a status read once. | |

Known limit: under a modal the indicator and statuses can be seen, not clicked. The hotkey works; close the dialog to click a click-to-copy status.

## 10. 2.2 regressions (spec section 1), on each style

| # | Run | How | Expected | Result |
|---|-----|-----|----------|--------|
| 10.1 | H | Hold to talk. | The text lands on release. | |
| 10.2 | H | Dictation in frames and shadow roots. | The text lands. | |
| 10.3 | H | The insertion ladder: textarea, contenteditable, Slate-style and Lexical-style editors on `fields.html`; one Ctrl+Z removes the text. | Inserted once; undo works. | |
| 10.4 | M | Your real sites: Gmail, Notion, Slack, ChatGPT, claude.ai, Facebook. | Inserted once, or also on the clipboard with the warning. | |
| 10.5 | H | Orphan: extension off with a page open, a press; extension reload with a page open. | "VoiceType was turned off or updated. Reload this page."; after a reload the new copy records. | |
| 10.6 | H | Password field. | "VoiceType does not record in password fields." and no recording. | |
| 10.7 | H | Cost: the Done status, Today in the popup, Usage and data. | One session per dictation, the right cost. | |
| 10.8 | H | Held result: a frame, focus moved to the page, back to the field. | "Return to the field to insert, or click here to copy."; the text lands once. | |

## 11. Review fixes

| # | Run | How | Expected | Result |
|---|-----|-----|----------|--------|
| 11.1 | H | `document.documentElement.style.zoom = '2'` and `'0.75'` in the console, each style, also in frame 0 over a mirror. | The indicator stays in the window, in its place. | |
| 11.2 | H | "Could not insert. Click here to copy" up, press the hotkey. | The press copies; the next press records. | |
| 11.3 | H | Gemini and OpenAI, real speech, one take each. | The sentence comes back. | |

## 12. Anything else on real hardware

| # | Run | How | Expected | Result |
|---|-----|-----|----------|--------|
| 12.1 | M | Windows and macOS, if you ship there. | The hotkey, a dictation, the settings page. | |
| 12.2 | M | Chrome 140 itself, if you can get one (runs were on 153 and 156). | Loads; `currentCSSZoom` and popovers exist. | |
