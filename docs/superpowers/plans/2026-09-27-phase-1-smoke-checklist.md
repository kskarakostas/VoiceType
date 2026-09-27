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
- Clear history: the first click changes the button to "Click again to clear usage history"; a second, separate click clears and shows "Usage history cleared". Waiting 3 s after the first click reverts the label. The popup never closes on these clicks.
- Reset to defaults: the first click reads "Click again to reset modes, prompts, recording limits, silence auto-stop and hotkey". After a second, separate click the keys, provider, spoken languages and vocabulary are unchanged; modes, limits, silence auto-stop and the hotkey are back to defaults.
- Double click: double click Clear history. The label changes to "Click again to clear usage history" and nothing is cleared (the Usage numbers stay). Double click Reset to defaults: the label changes and nothing is reset.
- Held Enter: Tab to Clear history and hold Enter for 2 s. The label changes and nothing is cleared. The same on Reset to defaults: nothing is reset.
- Mode edits save without a button: Add mode, type a name, click "Create mode". The editor stays open and the Create button is gone. Change the prompt and pause: the preview in the mode list shows the new prompt.
- Popup closed mid-edit: in that mode's editor type a few more words into the prompt and at once click on the page so the popup closes. Reopen and open the mode's editor: the new words are saved.
- First click after typing: make Default the active mode. In the mode editor type into the prompt and, without pausing, click Email in the mode list once. That one click makes Email active (check mark, toast "Mode: Email"). Delete the test mode afterwards.
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
- Right-to-left page: on fields.html run `document.documentElement.dir = 'rtl'` in the DevTools console (the same as a page with `<html dir="rtl">`), then focus the textarea and open the pill menu. The pill and its menu look the same as without it (element order, icons, text direction, menu layout). Reload the page to undo.
- The field inside the scrolling container: the pill follows it while the container scrolls and while the page scrolls.
- The left-flush input: the pill sits on its right.
- The bottom-edge field: the menu opens upward.
- Resize the window: the pill stays attached to the field.
- Status timing: an error (wrong key) stays about 6 s; `Done <$0.01` stays about 2.5 s. With the menu open, the status never covers the menu.
- Literal names: create a custom mode named `<img src=x onerror=alert(1)>` in the popup. The popup list and the pill menu show that text literally and no alert fires. Delete the mode afterwards.
- Menu content: modes with the active one marked; the translate row only when Translate is active; the provider switch with "no key" on a provider without a key; a usage line such as `Today <$0.01 (3), all time $0.21`; the hotkey hint.
- Modal dialog (known limitation): on fields.html run `const d = document.createElement('dialog'); d.append(document.createElement('textarea')); document.body.append(d); d.showModal();` in the console, then click into the dialog's textarea. The pill sits below the top layer and is inert there: it may show behind the backdrop, and clicks do not reach it. Hold the hotkey and speak: the text is inserted into the dialog's textarea. Reload the page afterwards.

## 5. Frames and shadow roots (spec 6.4)
- Same-origin iframe field: the pill shows inside the iframe only, and dictation lands in that field.
- Cross-origin iframe field (from `127.0.0.1`): the same.
- Input inside the open shadow root: pill and dictation work.
- Contenteditable inside the open shadow root: put the caret after its first word and dictate. The text lands at the caret, not at the end.
- Pills across frames: click the page's textarea, then the same-origin frame's textarea, then the cross-origin frame's textarea, then the page's textarea again. After each click note how many pills are visible. Spec 6.4 expects a pill only in the frame holding the focused field; a frame whose field was focused last may keep its pill (the next check uses that).
- Cross-origin frame with the page focused (D12): click into the cross-origin frame's textarea, then into the page's textarea. Click REC on the frame's pill (if it hid, note that and skip), speak, click it again. The page's textarea stays untouched and the frame's pill shows "Return to the field to insert, or click here to copy.". Click into the frame's textarea: the text is inserted there once.
- The same, but click the held status instead of the frame's textarea. Note the result. Expected: "Copied to clipboard." and Ctrl+V pastes the text. The Task 11 review predicts "Copy failed. Click here to try again." while the frame lacks focus; in that case click into the frame's textarea, then click the status again: it must copy.

## 6. Insertion (spec 6.5 as amended in 6.0)
- Ctrl+Z exactness: in the textarea type "Hello ", dictate "one two three", press Ctrl+Z once. Only the dictated text disappears; "Hello " stays. Repeat typing right up to the moment you press REC: still exact.
- The same check in the text input and in the fixtures contenteditable.
- Focus moved (Review Focus 4): start in the textarea, click into the text input while it processes. The text input stays untouched and the pill shows "The field lost focus. Text copied to clipboard."; Ctrl+V pastes the text.
- Field removed: start in the textarea, and while it processes run `document.getElementById('ta').remove()` in the console. The pill shows "The field lost focus. Text copied to clipboard." (or "Could not insert. Click here to copy the text.", and clicking copies it).
- No field: click on empty page space, hold the hotkey and speak. The pill appears at the bottom right corner and ends with "Copied to clipboard."
- Another window: dictate into the textarea and, while it processes, switch to another window (Alt+Tab, or Cmd+Tab on macOS) until the result has arrived. With the windows side by side the pill shows "Return to the field to insert, or click here to copy.". Switch back with the keyboard: the text is inserted into the textarea exactly once, then "Done" with the cost.
- Another tab: the same, switching to another tab while it processes and back after the result: inserted exactly once.
- Held status clicked: repeat with the windows side by side and, instead of switching back with the keyboard, click the held status on the pill. The pill shows "Copied to clipboard." and Ctrl+V pastes the text. Note whether the text was also inserted into the textarea (the click brings the window back, which counts as a return); it must appear there at most once.
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
- Synthetic chord: click into the fixtures textarea, then in the DevTools console run `window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', ctrlKey: true, shiftKey: true }))`. Nothing starts: no recording, no permission tab, no tray indicator, the pill stays idle.
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

Run each row on both providers and note the cost the pill shows after "Done" (under a cent shows as `<$0.01`; the popup's Usage section gives the running total). Then set spoken languages to English and Greek and add "Palowise" to the vocabulary: a Default dictation containing the word spells it "Palowise".

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
