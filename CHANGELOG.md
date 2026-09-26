# Changelog

## 2.0.0 (unreleased)

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
- `web_accessible_resources` entry and the `<all_urls>` host permission.
- Pill distance slider.
