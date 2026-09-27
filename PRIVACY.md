# Privacy Policy for VoiceType

**Last Updated: September 2026**

## Overview

VoiceType is a Chrome extension that provides AI-powered speech-to-text functionality. We are committed to protecting your privacy and being transparent about our data practices.

## Data Collection

### What We Collect

VoiceType collects and processes the following data **locally on your device**:

1. **Audio Data**: Temporarily recorded for transcription purposes
2. **API Keys**: Your OpenAI or Google Gemini API keys, stored in plain text in Chrome's local extension storage
3. **Settings**: Your preferences (provider, modes, recording limits, silence auto-stop, hotkey, spoken languages, vocabulary)
4. **Usage Statistics**: Session counts, audio duration, and estimated costs

### What We Do NOT Collect

- Personal information
- Browsing history
- Form data or passwords
- Any data for advertising purposes
- Clipboard contents (VoiceType writes dictated text to the clipboard when it cannot insert it, and never reads the clipboard)

## Data Storage

- All data is stored **locally** in Chrome's extension storage
- API keys are stored in plain text in `chrome.storage.local`. They are never written to `chrome.storage.sync`, so they do not leave this browser profile. They are stored unencrypted on disk inside your Chrome profile folder. Anyone, or any program, with access to that folder can read them.
- Inside Chrome, the keys are readable only by VoiceType's own trusted pages: the background service worker and the popup. VoiceType restricts its local storage with `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`, so its in-page script cannot read that storage at all. The in-page script receives settings without keys, and no key is ever sent to a web page.
- No data is sent to our servers (we don't have any servers)
- Usage statistics are stored locally and never transmitted

## Data Transmission

Audio is recorded in an extension document that belongs to VoiceType, not to the website you are on. The website never receives your microphone or your audio. The microphone is released after every recording.

Audio data is transmitted only to:

1. **OpenAI API** (api.openai.com) - when using OpenAI provider
2. **Google AI API** (generativelanguage.googleapis.com) - when using Gemini provider

These transmissions occur only when you actively record and submit audio for transcription. The audio is sent directly to the chosen API provider and is subject to their respective privacy policies:

- [OpenAI Privacy Policy](https://openai.com/privacy/)
- [Google AI Privacy Policy](https://ai.google.dev/terms)

## Third-Party Services

VoiceType uses third-party AI services for transcription and mode processing:

- **OpenAI**: `gpt-transcribe` for speech recognition, `gpt-6-luna` for modes (Email, Translate, Instruct and custom modes)
- **Google Gemini**: `gemini-3.5-transcribe` for speech recognition, `gemini-3.8-flash` for modes

Mode processing sends the transcript text, not the audio, to the text model of the same provider you chose for speech recognition. Your spoken-language hints and vocabulary terms, when set, are sent with the audio to the speech recognition model.

Your use of these services is subject to their terms and privacy policies.

## Permissions

- **Access to all sites** (`<all_urls>`): the in-page script that shows the pill runs on every site so you can dictate anywhere. VoiceType uses the host permission itself only to put that script back into tabs that are already open when VoiceType is installed or updated. The script looks only at the field you focus and dictate into; it does not read or send page content.
- **scripting**: the re-injection described above.
- **offscreen**: the extension document that records the microphone.
- **storage**: settings, keys and usage statistics on this device.

## Data Retention

- Audio recordings are processed in memory and immediately discarded after transcription. Closing or leaving a tab while it records cancels the recording without sending it
- Settings and API keys persist until you clear them or uninstall the extension
- Usage statistics: daily history is kept for 90 days; all-time totals are kept until you clear them

## Your Rights

You can:

- **Clear your API keys** at any time through the extension settings
- **Clear usage statistics** through the Usage section of the popup
- **Uninstall the extension** to remove all stored data

## Security

- API keys are sent only over HTTPS in request headers, never in URLs
- No external analytics or tracking
- All processing happens locally or directly with your chosen AI provider
- We recommend setting spending limits on your API provider accounts

## Children's Privacy

VoiceType is not directed at children under 13, and we do not knowingly collect data from children.

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be reflected in the "Last Updated" date.

## Contact

For privacy-related questions, please contact:

**K. S. Karakostas**

---

By using VoiceType, you agree to this privacy policy.
