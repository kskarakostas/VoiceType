// VoiceType - Background Service Worker
// Handles OpenAI API calls and extension messaging

// Simple encryption for API key (not military-grade, but prevents casual snooping)
const ENCRYPTION_KEY = 'VoiceType_2024_SecureKey';

function encryptApiKey(apiKey) {
  if (!apiKey) return '';
  let encrypted = '';
  for (let i = 0; i < apiKey.length; i++) {
    encrypted += String.fromCharCode(
      apiKey.charCodeAt(i) ^ ENCRYPTION_KEY.charCodeAt(i % ENCRYPTION_KEY.length)
    );
  }
  return btoa(encrypted);
}

function decryptApiKey(encrypted) {
  if (!encrypted) return '';
  try {
    const decoded = atob(encrypted);
    let decrypted = '';
    for (let i = 0; i < decoded.length; i++) {
      decrypted += String.fromCharCode(
        decoded.charCodeAt(i) ^ ENCRYPTION_KEY.charCodeAt(i % ENCRYPTION_KEY.length)
      );
    }
    return decrypted;
  } catch {
    return encrypted; // Return as-is if not encrypted (backward compatibility)
  }
}

// Pricing 
// OpenAI: per minute (official)
// Gemini: per 1M tokens (we'll calculate from actual usage returned by API)
const PRICING = {
  // OpenAI - per minute
  'gpt-4o-transcribe': { type: 'per_minute', rate: 0.006 },
  'gpt-4o-mini-transcribe': { type: 'per_minute', rate: 0.003 },
  // Gemini - per 1M tokens (input/output rates)
  'gemini-3-flash-preview': { type: 'per_token', input: 0.10, output: 0.40 },
  'gemini-2.5-flash': { type: 'per_token', input: 0.15, output: 0.60 }
};

// Default settings
const DEFAULT_SETTINGS = {
  apiKey: '',
  geminiKey: '',
  provider: 'openai', // 'openai' or 'gemini'
  model: 'gpt-4o-transcribe',
  geminiModel: 'gemini-2.5-flash',
  activeMode: 'default',
  minRecordingTime: 0, // Minimum seconds before sending to API (0 = off)
  maxRecordingTime: 60, // Maximum recording time in seconds
  translateTargetLang: 'English', // Default target language for translation mode
  pillGap: 8, // Distance in pixels between pill and text field
  modes: {
    default: {
      name: 'Default',
      prompt: `You are a transcription assistant. Your ONLY task is to transcribe the spoken audio accurately.

RULES:
- Output ONLY the transcribed text, nothing else
- Fix obvious speech errors and add appropriate punctuation
- Do NOT add any introduction, explanation, or commentary
- Do NOT say things like "Here is the transcription:" or "The speaker said:"
- Just output the clean transcribed text directly`,
      icon: '🎤'
    },
    email: {
      name: 'Email',
      prompt: `You are an email writing assistant. The user will speak their ideas and you will compose a semi-formal email.

RULES:
- Output ONLY the email text, nothing else
- Create a well-structured, semi-formal email from the spoken content
- Include appropriate greeting (e.g., "Hi [Name]," or "Hello,") and sign-off (e.g., "Best regards,")
- Organize ideas into clear paragraphs
- Keep a professional but friendly tone
- Do NOT add any meta-commentary like "Here's your email:"
- Do NOT include [Name] placeholders - use generic greetings if no name is mentioned
- Just output the ready-to-send email directly`,
      icon: '📧'
    },
    translate: {
      name: 'Translate',
      prompt: `You are a translation transcription assistant. Transcribe the spoken audio and translate it to the target language.

TARGET LANGUAGE: {{targetLanguage}}

RULES:
- Output ONLY the translated text, nothing else
- First understand what was said (in any language)
- Then output the translation in {{targetLanguage}}
- Maintain the original meaning and tone
- Do NOT add any introduction or explanation
- Do NOT say "Translation:" or "In {{targetLanguage}}:"
- Just output the clean translated text directly`,
      icon: '🌐',
      hasLanguageOption: true
    },
    instruct: {
      name: 'Instruct',
      prompt: `You are a helpful AI assistant. The user will speak a question, instruction, or request. Listen to what they say and provide a helpful, direct response.

RULES:
- First understand what the user is asking or requesting
- Provide a clear, helpful, and concise response
- Output ONLY your response, nothing else
- Do NOT start with "Based on your question..." or similar preambles
- Do NOT repeat or transcribe the user's question
- Just provide the answer or complete the requested task directly
- Keep responses concise but complete
- If asked to write something specific (code, text, etc.), output that directly`,
      icon: '💡'
    }
  },
  shortcuts: {
    toggleRecording: 'Ctrl+Shift+Space'
  }
};

// Initialize settings on install
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get('settings');
  if (!existing.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  } else {
    // Merge with defaults to add any new modes
    const merged = {
      ...DEFAULT_SETTINGS,
      ...existing.settings,
      modes: {
        ...DEFAULT_SETTINGS.modes,
        ...existing.settings.modes
      }
    };
    await chrome.storage.local.set({ settings: merged });
  }
});

// Handle keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-recording') {
    sendToggleToActiveTab();
  }
});

// Handle extension icon click as alternative trigger
chrome.action.onClicked.addListener((tab) => {
  // This won't fire if popup is set
});

// Function to send toggle message to active tab
function sendToggleToActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].id) {
      const url = tabs[0].url || '';
      if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) {
        return;
      }
      
      chrome.tabs.sendMessage(tabs[0].id, { action: 'toggle-recording' })
        .catch(() => {
          // Content script not loaded - try to inject it
          chrome.scripting.executeScript({
            target: { tabId: tabs[0].id },
            files: ['content.js']
          }).then(() => {
            setTimeout(() => {
              chrome.tabs.sendMessage(tabs[0].id, { action: 'toggle-recording' });
            }, 100);
          }).catch(() => {});
        });
    }
  });
}

// Usage logging functions
function getDateKey(date = new Date()) {
  return date.toISOString().split('T')[0]; // YYYY-MM-DD
}

async function logUsage(audioDuration, model, mode, tokenUsage = null) {
  const result = await chrome.storage.local.get('usageLog');
  const usageLog = result.usageLog || { 
    daily: {}, 
    total: { sessions: 0, audioSeconds: 0, estimatedCost: 0 },
    byProvider: { 
      openai: { sessions: 0, cost: 0, audioSeconds: 0 }, 
      gemini: { sessions: 0, cost: 0, audioSeconds: 0 } 
    }
  };
  
  // Ensure byProvider exists and has audioSeconds for older data
  if (!usageLog.byProvider) {
    usageLog.byProvider = { 
      openai: { sessions: 0, cost: 0, audioSeconds: 0 }, 
      gemini: { sessions: 0, cost: 0, audioSeconds: 0 } 
    };
  }
  if (usageLog.byProvider.openai && !('audioSeconds' in usageLog.byProvider.openai)) {
    usageLog.byProvider.openai.audioSeconds = 0;
  }
  if (usageLog.byProvider.gemini && !('audioSeconds' in usageLog.byProvider.gemini)) {
    usageLog.byProvider.gemini.audioSeconds = 0;
  }
  
  const dateKey = getDateKey();
  const pricing = PRICING[model] || PRICING['gpt-4o-transcribe'];
  
  // Determine provider from model name
  const provider = model.startsWith('gemini') ? 'gemini' : 'openai';
  
  // Calculate cost based on pricing type
  let cost = 0;
  if (pricing.type === 'per_token' && tokenUsage) {
    // Gemini: calculate from actual token usage
    const inputCost = (tokenUsage.input / 1_000_000) * pricing.input;
    const outputCost = (tokenUsage.output / 1_000_000) * pricing.output;
    cost = inputCost + outputCost;
  } else if (pricing.type === 'per_minute' || pricing.rate) {
    // OpenAI: calculate from duration
    const rate = pricing.rate || pricing;
    cost = (audioDuration / 60) * rate;
  } else {
    // Fallback: estimate based on duration
    cost = (audioDuration / 60) * 0.006;
  }
  
  // Initialize daily entry if needed
  if (!usageLog.daily[dateKey]) {
    usageLog.daily[dateKey] = {
      sessions: 0,
      audioSeconds: 0,
      estimatedCost: 0,
      modes: {},
      byProvider: { 
        openai: { sessions: 0, cost: 0, audioSeconds: 0 }, 
        gemini: { sessions: 0, cost: 0, audioSeconds: 0 } 
      }
    };
  }
  
  // Ensure daily byProvider exists with audioSeconds
  if (!usageLog.daily[dateKey].byProvider) {
    usageLog.daily[dateKey].byProvider = { 
      openai: { sessions: 0, cost: 0, audioSeconds: 0 }, 
      gemini: { sessions: 0, cost: 0, audioSeconds: 0 } 
    };
  }
  if (!('audioSeconds' in usageLog.daily[dateKey].byProvider.openai)) {
    usageLog.daily[dateKey].byProvider.openai.audioSeconds = 0;
  }
  if (!('audioSeconds' in usageLog.daily[dateKey].byProvider.gemini)) {
    usageLog.daily[dateKey].byProvider.gemini.audioSeconds = 0;
  }
  
  // Update daily stats
  usageLog.daily[dateKey].sessions += 1;
  usageLog.daily[dateKey].audioSeconds += audioDuration;
  usageLog.daily[dateKey].estimatedCost += cost;
  usageLog.daily[dateKey].modes[mode] = (usageLog.daily[dateKey].modes[mode] || 0) + 1;
  usageLog.daily[dateKey].byProvider[provider].sessions += 1;
  usageLog.daily[dateKey].byProvider[provider].cost += cost;
  usageLog.daily[dateKey].byProvider[provider].audioSeconds += audioDuration;
  
  // Update total stats
  usageLog.total.sessions += 1;
  usageLog.total.audioSeconds += audioDuration;
  usageLog.total.estimatedCost += cost;
  
  // Update provider totals
  usageLog.byProvider[provider].sessions += 1;
  usageLog.byProvider[provider].cost += cost;
  usageLog.byProvider[provider].audioSeconds += audioDuration;
  
  // Clean up old entries (keep last 90 days)
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 90);
  const cutoffKey = getDateKey(cutoffDate);
  
  for (const key of Object.keys(usageLog.daily)) {
    if (key < cutoffKey) {
      delete usageLog.daily[key];
    }
  }
  
  await chrome.storage.local.set({ usageLog });
  return usageLog;
}

async function getUsageStats() {
  const result = await chrome.storage.local.get('usageLog');
  const usageLog = result.usageLog || { 
    daily: {}, 
    total: { sessions: 0, audioSeconds: 0, estimatedCost: 0 },
    byProvider: { 
      openai: { sessions: 0, cost: 0, audioSeconds: 0 }, 
      gemini: { sessions: 0, cost: 0, audioSeconds: 0 } 
    }
  };
  
  const today = getDateKey();
  const todayStats = usageLog.daily[today] || { 
    sessions: 0, audioSeconds: 0, estimatedCost: 0, modes: {},
    byProvider: { 
      openai: { sessions: 0, cost: 0, audioSeconds: 0 }, 
      gemini: { sessions: 0, cost: 0, audioSeconds: 0 } 
    }
  };
  
  // Get last 7 days stats
  const last7Days = { 
    sessions: 0, audioSeconds: 0, estimatedCost: 0,
    byProvider: { 
      openai: { sessions: 0, cost: 0, audioSeconds: 0 }, 
      gemini: { sessions: 0, cost: 0, audioSeconds: 0 } 
    }
  };
  const now = new Date();
  for (let i = 0; i < 7; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const key = getDateKey(date);
    if (usageLog.daily[key]) {
      last7Days.sessions += usageLog.daily[key].sessions;
      last7Days.audioSeconds += usageLog.daily[key].audioSeconds;
      last7Days.estimatedCost += usageLog.daily[key].estimatedCost;
      
      if (usageLog.daily[key].byProvider) {
        last7Days.byProvider.openai.sessions += usageLog.daily[key].byProvider.openai?.sessions || 0;
        last7Days.byProvider.openai.cost += usageLog.daily[key].byProvider.openai?.cost || 0;
        last7Days.byProvider.openai.audioSeconds += usageLog.daily[key].byProvider.openai?.audioSeconds || 0;
        last7Days.byProvider.gemini.sessions += usageLog.daily[key].byProvider.gemini?.sessions || 0;
        last7Days.byProvider.gemini.cost += usageLog.daily[key].byProvider.gemini?.cost || 0;
        last7Days.byProvider.gemini.audioSeconds += usageLog.daily[key].byProvider.gemini?.audioSeconds || 0;
      }
    }
  }
  
  // Ensure byProvider has audioSeconds
  const byProvider = usageLog.byProvider || { 
    openai: { sessions: 0, cost: 0, audioSeconds: 0 }, 
    gemini: { sessions: 0, cost: 0, audioSeconds: 0 } 
  };
  if (!('audioSeconds' in byProvider.openai)) byProvider.openai.audioSeconds = 0;
  if (!('audioSeconds' in byProvider.gemini)) byProvider.gemini.audioSeconds = 0;
  
  return {
    today: todayStats,
    last7Days,
    total: usageLog.total,
    byProvider,
    daily: usageLog.daily
  };
}

// Handle messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'transcribe') {
    handleTranscription(request.audioBlob, request.mode, request.audioDuration || 0)
      .then(result => sendResponse({ success: true, text: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep channel open for async response
  }
  
  // Trigger recording from popup
  if (request.action === 'triggerRecording') {
    sendToggleToActiveTab();
    sendResponse({ success: true });
    return false;
  }
  
  if (request.action === 'getSettings') {
    chrome.storage.local.get('settings', (result) => {
      const settings = result.settings || DEFAULT_SETTINGS;
      // Decrypt API keys before sending to popup
      if (settings.apiKey && settings.apiKeyEncrypted) {
        settings.apiKey = decryptApiKey(settings.apiKey);
      }
      if (settings.geminiKey && settings.geminiKeyEncrypted) {
        settings.geminiKey = decryptApiKey(settings.geminiKey);
      }
      sendResponse(settings);
    });
    return true;
  }
  
  if (request.action === 'saveSettings') {
    const settings = { ...request.settings };
    // Encrypt API keys before storing
    if (settings.apiKey && !settings.apiKeyEncrypted) {
      settings.apiKey = encryptApiKey(settings.apiKey);
      settings.apiKeyEncrypted = true;
    }
    if (settings.geminiKey && !settings.geminiKeyEncrypted) {
      settings.geminiKey = encryptApiKey(settings.geminiKey);
      settings.geminiKeyEncrypted = true;
    }
    chrome.storage.local.set({ settings }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.action === 'checkApiKey') {
    chrome.storage.local.get('settings', (result) => {
      const settings = result.settings || {};
      const provider = settings.provider || 'openai';
      
      let hasKey = false;
      if (provider === 'gemini') {
        let geminiKey = settings.geminiKey;
        if (geminiKey && settings.geminiKeyEncrypted) {
          geminiKey = decryptApiKey(geminiKey);
        }
        hasKey = geminiKey && geminiKey.length > 0;
      } else {
        let apiKey = settings.apiKey;
        if (apiKey && settings.apiKeyEncrypted) {
          apiKey = decryptApiKey(apiKey);
        }
        hasKey = apiKey && apiKey.length > 0;
      }
      
      sendResponse({ hasKey });
    });
    return true;
  }
  
  if (request.action === 'getUsageStats') {
    getUsageStats().then(stats => sendResponse(stats));
    return true;
  }
  
  if (request.action === 'clearUsageStats') {
    chrome.storage.local.set({ 
      usageLog: { daily: {}, total: { sessions: 0, audioSeconds: 0, estimatedCost: 0 } } 
    }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

// Transcription handler
async function handleTranscription(audioBase64, mode, audioDuration = 0) {
  const result = await chrome.storage.local.get('settings');
  const settings = result.settings || DEFAULT_SETTINGS;
  
  const provider = settings.provider || 'openai';
  const modeSettings = settings.modes[mode] || settings.modes.default;
  
  // Process prompt - replace template variables
  let prompt = modeSettings.prompt;
  if (modeSettings.hasLanguageOption && settings.translateTargetLang) {
    prompt = prompt.replace(/\{\{targetLanguage\}\}/g, settings.translateTargetLang);
  }
  
  let text, actualDuration, modelUsed, tokenUsage = null;
  
  if (provider === 'gemini') {
    // Use Gemini
    let geminiKey = settings.geminiKey;
    if (geminiKey && settings.geminiKeyEncrypted) {
      geminiKey = decryptApiKey(geminiKey);
    }
    
    if (!geminiKey) {
      throw new Error('Gemini API key not configured. Click the extension icon to add your Google AI API key.');
    }
    
    const geminiResult = await transcribeWithGemini(audioBase64, geminiKey, settings.geminiModel, prompt);
    text = geminiResult.text;
    actualDuration = audioDuration;
    modelUsed = settings.geminiModel;
    tokenUsage = geminiResult.tokenUsage; // Actual token counts from API
  } else {
    // Use OpenAI
    let apiKey = settings.apiKey;
    if (apiKey && settings.apiKeyEncrypted) {
      apiKey = decryptApiKey(apiKey);
    }
    
    if (!apiKey) {
      throw new Error('OpenAI API key not configured. Click the extension icon to add your API key.');
    }
    
    const openaiResult = await transcribeWithOpenAI(audioBase64, apiKey, settings.model, prompt);
    text = openaiResult.text;
    actualDuration = openaiResult.duration || audioDuration;
    modelUsed = settings.model;
  }
  
  // Log usage (with token usage for Gemini)
  await logUsage(actualDuration, modelUsed, mode, tokenUsage);
  
  return text;
}

// OpenAI transcription
async function transcribeWithOpenAI(audioBase64, apiKey, model, prompt) {
  // Convert base64 to blob
  const binaryString = atob(audioBase64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const audioBlob = new Blob([bytes], { type: 'audio/webm' });
  
  // Create form data
  const formData = new FormData();
  formData.append('file', audioBlob, 'recording.webm');
  formData.append('model', model);
  formData.append('response_format', 'json');
  formData.append('prompt', prompt);
  
  // Call OpenAI API
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`
    },
    body: formData
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `OpenAI API error: ${response.status}`);
  }
  
  const data = await response.json();
  return {
    text: data.text?.trim() || '',
    duration: data.duration
  };
}

// Gemini transcription
async function transcribeWithGemini(audioBase64, apiKey, model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{
        parts: [
          {
            text: `${prompt}\n\nPlease transcribe the following audio accurately:`
          },
          {
            inline_data: {
              mime_type: 'audio/webm',
              data: audioBase64
            }
          }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8192
      }
    })
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `Gemini API error: ${response.status}`);
  }
  
  const data = await response.json();
  
  // Extract text from Gemini response
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  
  // Extract token usage from response (Gemini provides this!)
  const usageMetadata = data.usageMetadata || {};
  const tokenUsage = {
    input: usageMetadata.promptTokenCount || 0,
    output: usageMetadata.candidatesTokenCount || 0,
    total: usageMetadata.totalTokenCount || 0
  };
  
  return {
    text: text.trim(),
    tokenUsage: tokenUsage
  };
}

// Export defaults for popup
self.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
