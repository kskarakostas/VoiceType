# Privacy Policy for VoiceType

**Last Updated: September 2026**

## Overview

VoiceType is a Chrome extension that provides AI-powered speech-to-text functionality. We are committed to protecting your privacy and being transparent about our data practices.

## Data Collection

### What We Collect

VoiceType collects and processes the following data **locally on your device**:

1. **Audio Data**: Temporarily recorded for transcription purposes
2. **API Keys**: Your OpenAI or Google Gemini API keys, stored in plain text in Chrome's local extension storage
3. **Settings**: Your preferences (provider, modes, recording limits)
4. **Usage Statistics**: Session counts, audio duration, and estimated costs

### What We Do NOT Collect

- Personal information
- Browsing history
- Form data or passwords
- Any data for advertising purposes

## Data Storage

- All data is stored **locally** in Chrome's extension storage
- API keys are stored in plain text in `chrome.storage.local`. They are never written to `chrome.storage.sync`, so they do not leave this browser profile. Anyone with access to your browser profile on disk can read them; this is the same protection level as a saved website password without a master password.
- No data is sent to our servers (we don't have any servers)
- Usage statistics are stored locally and never transmitted

## Data Transmission

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

Mode processing sends the transcript text, not the audio, to the text model of the same provider you chose for speech recognition.

Your use of these services is subject to their terms and privacy policies.

## Data Retention

- Audio recordings are processed in memory and immediately discarded after transcription
- Settings and API keys persist until you clear them or uninstall the extension
- Usage statistics are retained for 90 days

## Your Rights

You can:

- **Clear your API keys** at any time through the extension settings
- **Clear usage statistics** through the Usage tab
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
