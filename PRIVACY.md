# Privacy Policy for VoiceType

**Last Updated: November 2026**

## Overview

VoiceType is a Chrome extension that provides AI-powered speech-to-text functionality. We are committed to protecting your privacy and being transparent about our data practices.

## Data Collection

### What We Collect

VoiceType collects and processes the following data **locally on your device**:

1. **Audio Data**: Temporarily recorded for transcription purposes
2. **API Keys**: Your OpenAI or Google Gemini API keys, stored in plain text in Chrome's local extension storage
3. **Settings**: Your preferences (provider, modes, Translate target language, recording limits, silence auto-stop, hotkey, spoken languages, pill style, sounds, always-copy, keep recent dictations)
4. **Dictionary**: The terms you add, by language
5. **Site Rules**: The hostnames you add a rule for, with that rule (Hide pill, mode). VoiceType stores only the sites you set a rule on
6. **Usage Statistics**: Session counts, audio duration, word counts, modes used, and estimated costs per day. Word counts are numbers; the statistics hold no transcript
7. **Recent dictations**: With Keep recent dictations on, which is the default, the text of your last 20 dictations, the transcript before a mode changed it, the mode, the site and the time. Off, none of this is kept. A dictation in an incognito tab is never kept

### What We Do NOT Collect

- Personal information
- Browsing history
- Form data or passwords
- Any data for advertising purposes
- Clipboard contents (VoiceType writes dictated text to the clipboard when it cannot insert it, and on every dictation with Always copy the result on; it never reads the clipboard)

## Data Storage

- All data is stored **locally** in Chrome's extension storage
- API keys are stored in plain text in `chrome.storage.local`. They are never written to `chrome.storage.sync`, so Chrome Sync never copies them. They are stored unencrypted on disk inside your Chrome profile folder. Anyone, or any program, with access to that folder can read them.
- Inside Chrome, the keys are readable only by VoiceType's own trusted contexts: the background service worker and its extension pages (popup, settings page, recording and permission pages). VoiceType restricts its local storage with `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`, so its in-page script cannot read that storage at all. The in-page script receives settings without keys, the dictionary or your site rules (only the current site's Hide pill and mode), and no key is ever sent to a web page.
- No data is sent to our servers (we don't have any servers)
- Your dictionary and site rules are stored locally. Dictionary terms leave this device only with a recording, as described below; site rules never do
- Usage statistics are stored locally and never transmitted
- Recent dictations are held in Chrome's session storage, in memory, not on disk, and never leave this device. Only VoiceType's service worker and extension pages can read that store. A web page's in-page script can ask for the newest dictation of its own site, when you open the pill menu; a frame from another site gets nothing

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

Mode processing sends the transcript text, not the audio, to the text model of the same provider you chose for speech recognition. Your spoken-language hints and dictionary terms, when set, are sent with the audio to the speech recognition model. Every term of every language group is sent with every recording.

Your use of these services is subject to their terms and privacy policies.

## Permissions

- **Access to all sites** (`<all_urls>`): the in-page script that shows the pill runs on every site so you can dictate anywhere. VoiceType uses the host permission itself to put that script back into tabs that are already open when VoiceType is installed or updated. The same permission is what lets the background service worker call the OpenAI and Gemini APIs. The script looks only at the field you focus and dictate into; it does not read or send page content.
- **scripting**: the re-injection described above.
- **offscreen**: the extension document that records the microphone. It also plays the optional sounds and copies results.
- **storage**: settings, keys, dictionary, site rules and usage statistics on this device, and recent dictations in memory.
- **clipboardWrite**: copying a result to the clipboard with no click: for Always copy the result, and for text VoiceType cannot insert. Chrome describes it as "Modify data you copy and paste". VoiceType does not read the clipboard. Always copy the result is off by default.

## Data Retention

- Audio recordings are processed in memory and immediately discarded after transcription. Closing the tab or navigating it away while it records cancels the recording without sending it. Switching to another tab does not: the recording goes on until you stop it or it reaches the maximum length, and that audio is sent
- Settings, API keys, your dictionary and site rules persist until you clear them or uninstall the extension
- Recent dictations: at most 20, gone when you close the browser, or when the extension is reloaded, updated or turned off, or when you clear them or turn them off
- Usage statistics: daily history is trimmed to 90 days each time a dictation is logged; all-time totals are kept until you clear them

## Your Rights

You can:

- **Clear your API keys** at any time through the extension settings
- **Clear usage statistics** on the settings page under Usage and data
- **Clear recent dictations**, or turn them off, on the History page of the settings page
- **Remove dictionary terms and site rules** on the Dictionary and Sites pages of the settings page
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
