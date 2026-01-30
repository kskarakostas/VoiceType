# 🎙️ VoiceType - AI Speech to Text

> **Transform your voice into text anywhere on the web**

VoiceType is a Chrome extension that lets you dictate text into any input field using AI-powered speech recognition. Simply speak, and watch your words appear as text - perfect for emails, documents, search boxes, and more.

<p align="center">
  <img src="logo.png" alt="VoiceType Logo" width="200">
</p>

## ✨ Why VoiceType?

- **Works Everywhere** - Any text field on any website
- **AI-Powered Accuracy** - Uses OpenAI or Google Gemini for superior transcription
- **Multiple Modes** - Transcribe, compose emails, translate, or ask AI questions
- **Privacy First** - Your API key stays on your device, audio goes directly to your chosen AI provider
- **Simple & Clean** - Minimal, unobtrusive interface that stays out of your way

---

## 📋 Table of Contents

- [Features](#-features)
- [Installation](#-installation)
- [Getting Your API Key](#-getting-your-api-key)
- [How to Use](#-how-to-use)
- [Modes Explained](#-modes-explained)
- [Settings](#%EF%B8%8F-settings)
- [Keyboard Shortcut](#%EF%B8%8F-keyboard-shortcut)
- [FAQ](#-frequently-asked-questions)
- [Troubleshooting](#-troubleshooting)
- [Privacy & Security](#-privacy--security)
- [Credits](#-credits)

---

## 🚀 Features

| Feature | Description |
|---------|-------------|
| 🎤 **Voice to Text** | Speak naturally and get accurate transcriptions |
| 🤖 **Multi-Provider** | Choose between OpenAI or Google Gemini |
| 📧 **Email Mode** | Speak your ideas, get a formatted email |
| 🌐 **Translation** | Speak in any language, get text in another |
| 💡 **Instruct Mode** | Ask AI questions and get responses |
| ⌨️ **Keyboard Shortcut** | Quick access with customizable hotkey |
| 🔴 **Voice Visualization** | See your voice level while recording |
| 📊 **Usage Tracking** | Monitor your usage and estimated costs |
| 🔒 **Secure** | API keys encrypted and stored locally |

---

## 📥 Installation

### Step 1: Download the Extension

**Option A: From GitHub (Recommended)**
1. Click the green **Code** button above
2. Select **Download ZIP**
3. Extract the ZIP file to a folder on your computer
4. Remember where you saved it!

**Option B: Clone with Git**
```bash
git clone https://github.com/YOUR_USERNAME/voicetype-extension.git
```

### Step 2: Install in Chrome

1. Open Chrome and type `chrome://extensions/` in the address bar
2. Turn on **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the folder containing the extension files
5. You should see VoiceType appear in your extensions list!

### Step 3: Pin the Extension (Optional but Recommended)

1. Click the puzzle piece icon (🧩) in Chrome's toolbar
2. Find "VoiceType - AI Speech to Text"
3. Click the pin icon (📌) to keep it visible

---

## 🔑 Getting Your API Key

VoiceType needs an API key to work. You can choose between two AI providers:

### Option 1: OpenAI (Recommended for Best Accuracy)

1. Go to [platform.openai.com](https://platform.openai.com)
2. Sign up or log in to your account
3. Click on your profile → **View API keys**
4. Click **Create new secret key**
5. Copy the key (starts with `sk-`)
6. **Important:** Set a spending limit in Settings → Limits

**Cost:** ~$0.006 per minute of audio (very affordable!)

### Option 2: Google Gemini (Free Tier Available)

1. Go to [aistudio.google.com](https://aistudio.google.com)
2. Sign in with your Google account
3. Click **Get API key** → **Create API key**
4. Copy the key (starts with `AIza`)

**Cost:** Free tier available, then pay-per-use

### Adding Your Key to VoiceType

1. Click the VoiceType icon in Chrome's toolbar
2. Select your provider (OpenAI or Gemini)
3. Paste your API key
4. Click **Save**
5. The status should change to "Ready" ✓

---

## 📖 How to Use

### Basic Usage

1. **Click into any text field** (email, search box, form, document, etc.)
2. **Look for the purple dot** that appears to the left of the field
3. **Click the dot** (or use keyboard shortcut) to start recording
4. **Speak naturally** - pause where punctuation should go
5. **Click again** to stop recording
6. **Your text appears** in the field!

### Visual Guide

```
1. Focus on text field     2. Dot appears          3. Click to expand
   |                          |                       |
   v                          v                       v
┌─────────────────┐      ┌─────────────────┐    ┌─────────────────┐
│ Type here...    │      │ • Type here...  │    │ [🎤][REC][•••]  │
└─────────────────┘      └─────────────────┘    └─────────────────┘

4. Click REC to record   5. Speak...             6. Click to stop
   |                        |                       |
   v                        v                       v
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│ [🎤][● 0:05][•••]│    │ "Hello world"   │    │ Hello world     │
│ 🔴 Recording... │    │                 │    │ ✓ Done!         │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

---

## 🎯 Modes Explained

Click the **•••** menu button to change modes:

### 🎤 Default Mode
**What it does:** Accurately transcribes your speech to text.

**Best for:** Notes, messages, general typing, search queries

**Example:**
- You say: *"Hey John comma I wanted to follow up on our meeting yesterday period"*
- You get: `Hey John, I wanted to follow up on our meeting yesterday.`

---

### 📧 Email Mode
**What it does:** Transforms your spoken ideas into a properly formatted email.

**Best for:** Composing emails quickly without typing

**Example:**
- You say: *"Write to Sarah about the project deadline... tell her we need the report by Friday and ask if she needs any help"*
- You get:
  ```
  Hi Sarah,

  I wanted to reach out regarding the project deadline. We need the report 
  by Friday. Please let me know if you need any help getting it done.

  Best regards
  ```

---

### 🌐 Translate Mode
**What it does:** Transcribes your speech and translates it to another language.

**Available languages:** English, Greek, Spanish, French, German

**Best for:** Quick translations, learning languages, international communication

**Example:**
- You select: **Spanish (ES)**
- You say (in English): *"Where is the train station?"*
- You get: `¿Dónde está la estación de tren?`

---

### 💡 Instruct Mode
**What it does:** Ask the AI a question or give it an instruction, and it responds.

**Best for:** Quick questions, getting explanations, writing assistance

**Example:**
- You say: *"What's the capital of Australia?"*
- You get: `Canberra is the capital of Australia.`

- You say: *"Write a one-sentence summary of photosynthesis"*
- You get: `Photosynthesis is the process by which plants convert sunlight, water, and carbon dioxide into glucose and oxygen.`

---

## ⚙️ Settings

Click the VoiceType icon to access settings:

| Setting | Description |
|---------|-------------|
| **Provider** | Choose OpenAI or Gemini |
| **Model** | Select the AI model to use |
| **Max Recording** | Maximum recording time (30s to 5 minutes) |
| **API Key** | Your provider's API key |

### Recommended Settings

| Use Case | Provider | Model |
|----------|----------|-------|
| Best accuracy | OpenAI | gpt-4o |
| Budget-friendly | OpenAI | gpt-4o-mini |
| Free usage | Gemini | Gemini 2.5 Flash |

---

## ⌨️ Keyboard Shortcut

### Setting Up the Shortcut

The keyboard shortcut **must be set manually** in Chrome:

1. Go to `chrome://extensions/shortcuts` (copy and paste this into your address bar)
2. Find **"VoiceType - AI Speech to Text"**
3. Click the pencil icon ✏️ next to "Start/Stop voice recording"
4. Press your desired key combination (e.g., `Ctrl+Shift+Space`)
5. Click OK

### Recommended Shortcuts

| Windows/Linux | Mac | Notes |
|---------------|-----|-------|
| `Ctrl+Shift+Space` | `Cmd+Shift+Space` | Easy to remember |
| `Ctrl+Shift+V` | `Cmd+Shift+V` | V for Voice |
| `Alt+R` | `Option+R` | R for Record |

### Using the Shortcut

1. Click in any text field
2. Press your shortcut to **start** recording
3. Speak your text
4. Press the shortcut again to **stop** and transcribe

---

## ❓ Frequently Asked Questions

### General Questions

<details>
<summary><b>Is VoiceType free to use?</b></summary>

The extension itself is free. However, it requires an API key from OpenAI or Google Gemini:
- **Google Gemini:** Has a free tier with generous limits
- **OpenAI:** Pay-as-you-go, typically costs less than $0.01 per transcription

</details>

<details>
<summary><b>Which provider should I choose?</b></summary>

- **OpenAI (gpt-4o):** Best accuracy, especially for complex audio or accents
- **OpenAI (gpt-4o-mini):** Good accuracy, half the cost
- **Google Gemini:** Good accuracy, has free tier

Start with Gemini if you want to try it for free, switch to OpenAI if you need better accuracy.

</details>

<details>
<summary><b>Does it work offline?</b></summary>

No. VoiceType requires an internet connection to send audio to the AI provider for transcription.

</details>

<details>
<summary><b>What languages does it support?</b></summary>

VoiceType can transcribe speech in many languages (the AI will auto-detect). For translation mode, you can translate TO: English, Greek, Spanish, French, or German.

</details>

<details>
<summary><b>Is my audio saved anywhere?</b></summary>

No. Audio is sent directly to OpenAI or Google for processing and is not stored by VoiceType. Please review your chosen provider's privacy policy for their data handling practices.

</details>

### Technical Questions

<details>
<summary><b>Why doesn't the purple dot appear?</b></summary>

The dot only appears when you click into a text field. Some websites use custom input components that may not be detected. Try clicking directly in the text area or refreshing the page.

</details>

<details>
<summary><b>What's the maximum recording length?</b></summary>

You can set this in settings (30 seconds to 5 minutes). Longer recordings will automatically stop at the limit.

</details>

<details>
<summary><b>Why are short recordings ignored?</b></summary>

Recordings under 3 seconds are treated as accidental clicks and won't be sent to the API. This saves you money and avoids unwanted transcriptions.

</details>

---

## 🔧 Troubleshooting

### "Not configured" / "Add API key" error

**Problem:** VoiceType doesn't have a valid API key.

**Solution:**
1. Click the VoiceType icon
2. Make sure you've selected a provider (OpenAI or Gemini)
3. Paste your API key in the correct field
4. Click Save
5. Refresh the page you're on

---

### Microphone not working

**Problem:** Recording doesn't start or you see a microphone error.

**Solutions:**
1. **Check Chrome permissions:**
   - Click the lock icon 🔒 in the address bar
   - Make sure Microphone is set to "Allow"

2. **Check system permissions:**
   - **Windows:** Settings → Privacy → Microphone → Allow apps to access microphone
   - **Mac:** System Preferences → Security & Privacy → Microphone → Check Chrome

3. **Try a different tab:** Some websites block microphone access

4. **Restart Chrome:** Close all Chrome windows and reopen

---

### Keyboard shortcut doesn't work

**Problem:** Pressing the shortcut does nothing.

**Solutions:**
1. **Set up the shortcut first:**
   - Go to `chrome://extensions/shortcuts`
   - Find VoiceType and set a shortcut

2. **Check for conflicts:**
   - Another extension might use the same shortcut
   - Try a different key combination

3. **Make sure you're focused on a text field:**
   - Click in a text box before pressing the shortcut

---

### "API Error" or transcription fails

**Problem:** Recording works but transcription fails.

**Solutions:**
1. **Check your API key:** Make sure it's entered correctly (no extra spaces)

2. **Check your account:**
   - **OpenAI:** Make sure you have credits at [platform.openai.com/usage](https://platform.openai.com/usage)
   - **Gemini:** Check your quota at [aistudio.google.com](https://aistudio.google.com)

3. **Try a different model:** Switch between providers or models

4. **Check your internet connection**

---

### Poor transcription quality

**Problem:** Transcriptions have errors or miss words.

**Solutions:**
1. **Speak clearly** at a moderate pace
2. **Reduce background noise** - move to a quieter location
3. **Get closer to the microphone**
4. **Use a better microphone** - external mics often work better than built-in ones
5. **Try OpenAI's gpt-4o model** - it has the best accuracy

---

### Extension not loading on some websites

**Problem:** The purple dot doesn't appear on certain sites.

**Explanation:** Some websites (like Chrome's settings pages, the Chrome Web Store, or bank websites) block extensions for security reasons.

**Solution:** This is expected behavior and cannot be changed. Use VoiceType on regular websites.

---

### Settings won't save

**Problem:** Settings reset after closing the popup.

**Solutions:**
1. Make sure you click the **Save** button
2. Try removing and re-adding the extension
3. Check if Chrome has storage permissions for extensions

---

## 🔒 Privacy & Security

### What data does VoiceType collect?

| Data | Stored Where | Purpose |
|------|--------------|---------|
| API Key | Your browser (encrypted) | Authenticate with AI provider |
| Settings | Your browser | Remember your preferences |
| Usage stats | Your browser | Show you your usage |
| Audio | **Not stored** | Sent directly to AI provider |

### Security Best Practices

1. **Set spending limits** on your OpenAI/Google account
2. **Use a dedicated API key** just for VoiceType
3. **Review the provider's privacy policy:**
   - [OpenAI Privacy Policy](https://openai.com/privacy/)
   - [Google AI Privacy Policy](https://ai.google.dev/terms)

---

## 💰 Cost Estimation

### OpenAI Pricing

| Model | Cost per Minute |
|-------|-----------------|
| gpt-4o | $0.006 |
| gpt-4o-mini | $0.003 |

**Example:** A 30-second recording with gpt-4o costs about $0.003 (less than half a cent)

### Google Gemini Pricing

Gemini offers a free tier. After that:

| Model | Input (per 1M tokens) | Output (per 1M tokens) |
|-------|----------------------|------------------------|
| Gemini 2.5 Flash | $0.15 | $0.60 |

VoiceType tracks your usage - check the "Usage" tab in settings to monitor costs.

---

## 👨‍💻 Credits

**Created by:** K. S. Karakostas

**Built with:**
- OpenAI Whisper API
- Google Gemini API
- Chrome Extension APIs

---

## 📄 License

MIT License - feel free to use, modify, and distribute.

---

## 🙏 Support

If you find VoiceType useful:
- ⭐ **Star this repository** on GitHub
- 🐛 **Report bugs** by creating an issue
- 💡 **Suggest features** in the discussions

---

**Happy dictating! 🎤**
