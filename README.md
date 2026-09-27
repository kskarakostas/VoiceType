<p align="center">
  <img src="logo.png" alt="VoiceType Logo" width="180">
</p>

<h1 align="center">VoiceType</h1>

<p align="center">
  <strong>BYOK dictation for Chrome with cost transparency</strong>
</p>

<p align="center">
  Transform your voice into text anywhere on the web.<br>
  Just speak. Let AI do the typing.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-2.0.0-purple" alt="Version">
  <img src="https://img.shields.io/badge/platform-Chrome-blue" alt="Platform">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
</p>

---

<p align="center">
  <img src="screenshots/in_use.png" alt="VoiceType Recording" width="280">
</p>

<p align="center"><em>Compact, unobtrusive interface that appears next to any text field</em></p>

---

## ✨ Features

<table>
<tr>
<td width="50%">

### 🎤 Voice to Text
Speak naturally into any text field on any website. VoiceType uses AI to accurately transcribe your speech with proper punctuation.

### 🤖 Multi-Provider Support  
Bring your own OpenAI or Gemini key. Speech recognition uses `gpt-transcribe` or `gemini-3.5-transcribe`; modes such as Email run the transcript through `gpt-6-luna` or `gemini-3.8-flash`.

### 📧 Smart Modes
Not just transcription: compose emails, translate languages, or ask AI questions directly with your voice.

</td>
<td width="50%">

### ⌨️ Keyboard Shortcuts
Start and stop recording without touching your mouse. Customizable hotkey support.

### 📊 Usage Tracking
Monitor your sessions, audio time, and estimated costs. Never get surprised by your bill.

### 🔒 Privacy First
Keys stay in your browser's local extension storage, never synced. Audio goes straight to the provider you chose. No server of ours exists.

</td>
</tr>
</table>

---

## 📸 Screenshots

<table>
<tr>
<td align="center" width="50%">
<img src="screenshots/floating_expand.png" alt="Quick Settings" width="240"><br>
<strong>Quick Settings</strong><br>
<em>Change mode and provider without leaving the page</em>
</td>
<td align="center" width="50%">
<img src="screenshots/settings.png" alt="Settings Panel" width="280"><br>
<strong>Settings Panel</strong><br>
<em>Configure your API keys and preferences</em>
</td>
</tr>
<tr>
<td align="center" width="50%">
<img src="screenshots/modes.png" alt="Transcription Modes" width="280"><br>
<strong>Transcription Modes</strong><br>
<em>Choose how AI processes your speech</em>
</td>
<td align="center" width="50%">
<img src="screenshots/usage.png" alt="Usage Statistics" width="280"><br>
<strong>Usage Statistics</strong><br>
<em>Track sessions, time, and costs by provider</em>
</td>
</tr>
</table>

---

## 🎯 Modes Explained

| Mode | Icon | What it does |
|------|:----:|--------------|
| **Default** | 🎤 | Accurate speech-to-text transcription |
| **Email** | 📧 | Transforms your ideas into formatted emails |
| **Instruct** | 💡 | Ask AI questions, get responses in the text field |
| **Translate** | 🌐 | Speak in any language, get text in another |

---

## 🚀 Quick Start

### 1. Install the Extension

```bash
# Clone the repository and build (requires Node.js 20+)
git clone https://github.com/kskarakostas/VoiceType.git
cd VoiceType
npm install
npm run build
```

Or download the ZIP from GitHub, extract it (the folder is named `VoiceType-main`) and build there:

```bash
cd VoiceType-main
npm install
npm run build
```

Then in Chrome:
1. Go to `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `dist/` folder

### 2. Get an API Key

**Option A: OpenAI**
- Go to [platform.openai.com](https://platform.openai.com)
- Create an API key
- Cost: ~$0.0045/minute

**Option B: Google Gemini** (may offer a free tier; check aistudio.google.com)
- Go to [aistudio.google.com](https://aistudio.google.com)
- Create an API key
- Cost: pay-per-use (may offer a free tier; check aistudio.google.com)

### 3. Configure & Go

1. Click the VoiceType icon in Chrome
2. Paste your API key (settings save automatically)
3. Click into any text field and start talking!

---

## ⌨️ Keyboard Shortcut

`Ctrl+Shift+Space` (Mac `Command+Shift+Space`) starts and stops recording. Chrome assigns it automatically on install.

If it conflicts with another extension or your system, set a different one:

1. Go to `chrome://extensions/shortcuts`
2. Find **VoiceType**
3. Click the pencil icon ✏️
4. Press your preferred shortcut

---

## ❓ FAQ

<details>
<summary><b>Is VoiceType free?</b></summary>
<br>
The extension is free. You need an API key from OpenAI (pay-per-use) or Google Gemini (may offer a free tier; check aistudio.google.com).
</details>

<details>
<summary><b>Which provider should I use?</b></summary>
<br>
Both are accurate for dictation. Gemini's transcribe model removes filler words on its own. OpenAI is the default. Costs are comparable; see the Usage tab.
</details>

<details>
<summary><b>Why doesn't the shortcut work?</b></summary>
<br>
The shortcut <code>Ctrl+Shift+Space</code> (Mac <code>Command+Shift+Space</code>) is assigned automatically on install. If it conflicts with another extension or your system, set a different one at <code>chrome://extensions/shortcuts</code>.
</details>

<details>
<summary><b>Why are short recordings ignored?</b></summary>
<br>
Recordings shorter than the minimum you set (default 1 second) are treated as accidental clicks. Change it in Settings.
</details>

<details>
<summary><b>Does it work offline?</b></summary>
<br>
No. Audio must be sent to OpenAI or Google for AI processing.
</details>

---

## 🔧 Troubleshooting

| Problem | Solution |
|---------|----------|
| **"Add API key" error** | Click the extension icon → paste your API key (it saves automatically) |
| **Microphone not working** | Click the 🔒 in address bar → Allow microphone |
| **Shortcut doesn't work** | `Ctrl+Shift+Space` (Mac `Command+Shift+Space`) is assigned on install; if it conflicts with another extension or your system, set a different one at `chrome://extensions/shortcuts` |
| **Transcription fails** | Check your API key and account balance |
| **Poor quality** | Speak clearly, reduce background noise, or try the other provider |

---

## 💰 Pricing Estimate

| Provider | Model | Cost |
|----------|-------|------|
| OpenAI | gpt-transcribe | ~$0.0045 per minute |
| OpenAI | gpt-6-luna (modes) | $0.10 in / $0.50 out per 1M tokens |
| Gemini | gemini-3.5-transcribe | ~$0.006 per minute |
| Gemini | gemini-3.8-flash (modes) | $0.75 in / $3.75 out per 1M tokens (list price through 2026) |

*A typical 30-second recording costs less than $0.01*

---

## 🔒 Privacy

- ✅ API keys stored in plain text in Chrome's local extension storage, never synced, never sent anywhere but the provider
- ✅ Audio sent directly to OpenAI/Google (not our servers)
- ✅ No analytics or tracking
- ✅ Fully open source

---

## 📄 License

MIT License: use it, modify it, share it.

---

## 👨‍💻 Author

**K. S. Karakostas**

---

<p align="center">
  <strong>⭐ Star this repo if you find it useful!</strong>
</p>

<p align="center">
  <a href="https://github.com/kskarakostas/VoiceType/issues">Report Bug</a>
  ·
  <a href="https://github.com/kskarakostas/VoiceType/issues">Request Feature</a>
</p>
