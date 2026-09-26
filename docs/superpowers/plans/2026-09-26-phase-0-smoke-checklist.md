# Phase 0 end-to-end smoke checklist (Task 14, for K. S. Karakostas)

Branch `phase-0`. Build first: `npm install && npm run build`. Load `dist/` unpacked in a fresh Chrome profile.
Serve the fixtures over http, not file://: `npx serve test/fixtures` then open the printed URL plus `/fields.html`.

## 1. Fresh-profile install
- Popup opens: status "Add API key", OpenAI tab active, no errors in the service worker console (chrome://extensions, "service worker" link) or the popup console.

## 2. Key entry (both providers)
- Paste a key, press Tab: toast "Key saved", placeholder shows the masked key, status Ready.
- Paste a key, then click outside the popup without Tab or Enter: reopen and confirm the key was saved. If not, that is a known `change`-event gap to report.
- Click Test: "key works" or a friendly error, never a raw provider body.
- Gemini key beginning with `AQ.`: accepted and Test passes.
- Clear: placeholder resets, status "Add API key".
- `confirm()` dialogs (Reset, Clear history) do not dismiss the popup.

## 3. Provider matrix on the fixtures page (per provider)
| Mode | Say | Expect in the textarea |
|---|---|---|
| Default | "The meeting is at three, bring the Palowise deck." | Sentence, punctuated |
| Email | "Tell Maria the report is late and I will send it Friday." | Greeting, body, sign-off, no placeholders |
| Translate to Greek | "Good morning, how are you?" | Greek only |
| Instruct | "What is the capital of Portugal?" | One-line answer |

Record the cost shown in "Done <cost>" per row. Gemini Default should come out near $0.006 per minute of audio.

## 4. Live API shape checks (first contact with the new models)
- Gemini transcribe: no "Invalid JSON payload ... Unknown name" error. If one appears naming `audioTranscriptionConfig`, `mode`, `languageCodes` or `customVocabulary`, the field names in `src/background/providers/gemini.js` need correcting against https://ai.google.dev/gemini-api/docs/generate-content/transcribe.
- Gemini refine: `system_instruction` and `thinkingLevel: low` accepted.
- OpenAI transcribe: `languages[]`, `keywords[]` accepted (set a spoken language and a keyword in storage via the popup once Phase 1 adds the UI; for now they are empty and the call must still succeed).
- OpenAI refine: `reasoning.effort: none` accepted on `gpt-6-luna`.
- A 3 to 5 minute Gemini recording finishes (service worker survives a request over 30 s).

## 5. Failure paths
- Wrong key: "rejected the API key" text, no key fragment on screen.
- Network off: "Network error. Check your connection."
- Recording under the minimum: "Too short, ignored".
- Three seconds of silence: "No speech detected."
- Password field: no pill.
- contenteditable and role=textbox: text appears; Ctrl+Z removes exactly the dictated text.
- Switch tab during processing, come back: result either inserted, or "Could not insert. Click here to copy the text." and clicking copies.
- Hidden tab: insertion may be delayed by about a second (expected).

## 6. Shortcut
- Ctrl+Shift+Space toggles recording on an https page and on the served fixtures page.
- Shortcut with no field focused: nothing happens (known; Phase 1 adds clipboard mode).

## 7. Upgrade path
- Profile with v1.7.6, both keys set, one custom mode: replace with `dist/`. Both keys work, the custom mode exists, built-in prompts are the v2 texts, usage shows zero.

## 8. Corruption regression
- Open popup, change max recording, close. Reopen, change min recording, close. Dictate with each provider: both work.

## 9. Shadow DOM and layout (browser-only)
- A page with an editor inside an open shadow root: the caret position is respected on insert.
- Long status and warning lines are readable next to the field.

## 10. Tag
Only after sections 1 to 8 pass:
```bash
npx vitest run
git tag -a v2.0.0 -m "VoiceType 2.0.0: two-stage pipeline, current models, tested core"
```

Open item: README `YOUR_USERNAME` placeholders at three places need your GitHub handle before the first release.
