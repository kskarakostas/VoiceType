# Changelog

## 2.2.0 (2026-09-28)

### Changed
- The glow around the pill while recording is larger and easier to see: a solid red ring that thickens as you speak, inside a wider halo. With reduced motion on, the ring stays still as before.

### Added
- `npm run screenshots`: regenerates the README screenshots in light and dark from the built extension, with a demo page, a sample key and sample usage.

## 2.1.1 (2026-09-28)

### Fixed
- Single-line dictation into Slate-based editors now stays in the field. 2.1.0 showed "Done", but the text vanished at the next keystroke and was not on the clipboard either. One `Ctrl+Z` removes the dictated text (dictated at a fresh caret).
- Dictating into a field inside an embedded frame (an iframe) and then clicking a field on the page while the text is processed no longer pulls the cursor out of the page field. The frame keeps the text with "Return to the field to insert, or click here to copy." and inserts it once when you click back into its field. A clipboard fallback never moves the cursor out of the field you are typing in.
- The hotkey no longer records while a password field has focus. Nothing is recorded or sent, and the pill shows "VoiceType does not record in password fields." in the corner.
- Pressing REC on the pill of an embedded frame that does not have keyboard focus now explains "Click into the field you want to dictate into, then press REC." instead of recording. This also closes a way to record while a password field in another frame had focus.
- After VoiceType is disabled, pages that stay open no longer swallow the hotkey (`Ctrl+Shift+Space` by default): the keys reach the page again, and the first press shows "VoiceType was turned off or updated. Reload this page." The same holds for a tab that an update could not switch over.
- The popup keeps the first click after typing: right after typing in the mode editor, one click on a mode selects it.
- Built-in modes are listed first, then your own modes in the order you created them, in the popup and in the pill menu. 2.1.0 listed your modes above Default once the popup was reopened.
- Pressing `Esc` right after pasting a key or typing vocabulary or a mode prompt in the popup saves it before the popup closes. 2.1.0 dropped anything entered less than about a second before `Esc` closed the popup.

## 2.1.0 (2026-09-27)

### Added
- Hold to talk: hold the hotkey while you speak and let go to insert the text. A quick tap starts recording and a second tap stops it. Default `Ctrl+Shift+Space`. Only real key presses count: a web page cannot trigger the hotkey with synthetic key events.
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
- On a Mac the default hotkey is now `Control+Shift+Space` (2.0.0 used `Command+Shift+Space`). Change it in the popup under Recording, Hotkey.
- The text goes to the field that had focus when you started recording. If focus moved or the field disappeared before the text arrived, the text is copied to the clipboard with a notice; it never lands in another field.
- A result that arrives while you are in another window or tab waits until you come back, and is inserted then. Meanwhile the pill keeps the status "Return to the field to insert, or click here to copy."
- Insertion rebuilt. One `Ctrl+Z` removes exactly the dictated text in text boxes. Rich editors (Gmail, Notion, Slack, ChatGPT, Lexical editors such as Facebook's, ProseMirror editors such as claude.ai) receive multi-line text. When an insert cannot be confirmed, the text is also put on the clipboard with a notice and is never inserted a second time. Google Docs goes straight to the clipboard.
- Recording happens in an extension page instead of the website. The website no longer gets microphone access or shows a microphone prompt; Chrome shows its microphone indicator in the system tray or menu bar while recording, and the microphone is released after every recording.
- The pill is isolated from page styles (closed Shadow DOM) and draws its own icons. It follows the field while you scroll, including fields inside scrolling web components, moves to the other side near the window edges, and opens its menu upward near the bottom. Its status and menu stay on screen near the window edges, and right-to-left pages do not change its layout.
- Errors and warnings in the pill stay 6 seconds, other messages 2.5 seconds, and never sit under the open menu.
- If VoiceType stops responding while processing, the pill resets after 75 seconds.
- The popup is one column with Provider, Recording, Speech, Modes, Usage and About sections. Every control saves on change; a save that fails is undone on screen and explained. A key saves when you paste it and click away. Edits to an existing mode save automatically; a new mode is saved with "Create mode". Clear history and Reset ask for a second, separate click instead of a browser dialog (a double click or a held Enter does not confirm them), and Reset keeps your keys, provider, spoken languages and vocabulary.
- One recording at a time across tabs: another tab gets "VoiceType is busy in another tab. Try again in a moment."
- Settings changed in the popup reach open tabs at once.
- After an install or update, open tabs get the new version without a page reload. A tab that cannot be switched over shows "VoiceType was updated. Reload this page."
- API keys are readable only by the background service worker and the popup. Web pages and the in-page script never receive them.
- Permissions: `offscreen` added; host access is `<all_urls>` again, used to put the in-page script back into open tabs after an install or update. It is also what lets the background service worker call the OpenAI and Gemini APIs. The install warning is unchanged, because the in-page script already ran on all sites.
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

### Fixed
- Email, Translate and Instruct modes now work on OpenAI. Speech is transcribed first, then the mode prompt is applied by a text model. Previously the prompt was sent to the transcription endpoint, which ignores instructions.
- If the mode step (email, translate, instruct) fails after a successful transcription, the raw transcript is inserted with a notice instead of losing the recording.
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
- `web_accessible_resources` entry.
- The `<all_urls>` host permission, narrowed to the two API origins (`api.openai.com`, `generativelanguage.googleapis.com`). The content script still runs on all sites, so the install warning is unchanged.
- Pill distance slider.
