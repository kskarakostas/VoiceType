// VoiceType - Popup Script
// Handles settings panel UI and logic

// Default settings (same as background.js)
const DEFAULT_SETTINGS = {
  apiKey: '',
  geminiKey: '',
  provider: 'openai',
  model: 'gpt-4o-transcribe',
  geminiModel: 'gemini-2.5-flash',
  activeMode: 'default',
  minRecordingTime: 0,
  maxRecordingTime: 60,
  translateTargetLang: 'English',
  pillGap: 8, // Distance in pixels between pill and text field
  modes: {
    default: {
      name: 'Default',
      prompt: 'You are a transcription assistant. Your ONLY task is to transcribe the spoken audio accurately. Output ONLY the transcribed text, nothing else. Fix obvious speech errors and add appropriate punctuation. Do NOT add any introduction, explanation, or commentary.',
      icon: '🎤'
    },
    email: {
      name: 'Email',
      prompt: 'You are an email writing assistant. The user will speak their ideas and you will compose a semi-formal email. Output ONLY the email text, nothing else. Create a well-structured, semi-formal email with appropriate greeting and sign-off. Keep a professional but friendly tone. Do NOT add any meta-commentary.',
      icon: '📧'
    },
    translate: {
      name: 'Translate',
      prompt: 'You are a translation transcription assistant. Transcribe the spoken audio and translate it to the target language. Output ONLY the translated text, nothing else. Maintain the original meaning and tone. Do NOT add any introduction or explanation.',
      icon: '🌐',
      hasLanguageOption: true
    },
    instruct: {
      name: 'Instruct',
      prompt: 'You are a helpful AI assistant. The user will speak a question, instruction, or request. Understand what they say and provide a helpful, direct response. Output ONLY your response. Do NOT repeat the question. Keep responses concise but complete.',
      icon: '💡'
    }
  }
};

// State
let settings = null;
let editingMode = null;
let isNewMode = false;

// DOM Elements
const elements = {
  apiKey: document.getElementById('api-key'),
  clearKey: document.getElementById('clear-key'),
  geminiKey: document.getElementById('gemini-key'),
  clearGeminiKey: document.getElementById('clear-gemini-key'),
  apiKeyWarning: document.getElementById('api-key-warning'),
  model: document.getElementById('model'),
  geminiModel: document.getElementById('gemini-model'),
  maxTime: document.getElementById('max-time'),
  maxTimeGemini: document.getElementById('max-time-gemini'),
  openaiSettings: document.getElementById('openai-settings'),
  geminiSettings: document.getElementById('gemini-settings'),
  modesList: document.getElementById('modes-list'),
  modeEditor: document.getElementById('mode-editor'),
  editorTitle: document.getElementById('editor-title'),
  modeName: document.getElementById('mode-name'),
  modeIcon: document.getElementById('mode-icon'),
  modePrompt: document.getElementById('mode-prompt'),
  addMode: document.getElementById('add-mode'),
  saveMode: document.getElementById('save-mode'),
  cancelEdit: document.getElementById('cancel-edit'),
  deleteMode: document.getElementById('delete-mode'),
  saveSettings: document.getElementById('save-settings'),
  resetDefaults: document.getElementById('reset-defaults'),
  statusIndicator: document.getElementById('status-indicator'),
  shortcutsLink: document.getElementById('shortcuts-link'),
  toast: document.getElementById('toast'),
  // Usage stats elements
  todaySessions: document.getElementById('today-sessions'),
  todayTime: document.getElementById('today-time'),
  todayCost: document.getElementById('today-cost'),
  weekSessions: document.getElementById('week-sessions'),
  weekTime: document.getElementById('week-time'),
  weekCost: document.getElementById('week-cost'),
  totalSessions: document.getElementById('total-sessions'),
  totalTime: document.getElementById('total-time'),
  totalCost: document.getElementById('total-cost'),
  // Provider breakdown
  openaiSessions: document.getElementById('openai-sessions'),
  openaiTime: document.getElementById('openai-time'),
  openaiCost: document.getElementById('openai-cost'),
  geminiSessions: document.getElementById('gemini-sessions'),
  geminiTime: document.getElementById('gemini-time'),
  geminiCost: document.getElementById('gemini-cost'),
  refreshStats: document.getElementById('refresh-stats'),
  clearStats: document.getElementById('clear-stats'),
  startRecording: document.getElementById('start-recording'),
  pillGap: document.getElementById('pill-gap'),
  pillGapValue: document.getElementById('pill-gap-value')
};

// Initialize
async function init() {
  // Load settings
  settings = await loadSettings();
  
  // Populate UI
  populateUI();
  
  // Set up event listeners
  setupEventListeners();
  
  // Set up tabs
  setupTabs();
  
  // Update status
  updateStatus();
  
  // Load usage stats
  await loadUsageStats();
}

// Set up tab switching
function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');
  
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetId = `tab-${tab.dataset.tab}`;
      
      // Update active tab
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      // Update active content
      tabContents.forEach(content => {
        content.classList.toggle('active', content.id === targetId);
      });
    });
  });
}

// Load settings from storage
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'getSettings' }, (result) => {
      resolve(result || DEFAULT_SETTINGS);
    });
  });
}

// Save settings to storage
async function saveSettings() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'saveSettings', settings }, (result) => {
      resolve(result);
    });
  });
}

// Populate UI with current settings
function populateUI() {
  // Set provider tabs
  const provider = settings.provider || 'openai';
  document.querySelectorAll('.provider-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.provider === provider);
  });
  elements.openaiSettings.style.display = provider === 'openai' ? 'block' : 'none';
  elements.geminiSettings.style.display = provider === 'gemini' ? 'block' : 'none';
  
  // OpenAI API key
  if (settings.apiKey && settings.apiKey.length > 0) {
    const lastFour = settings.apiKey.slice(-4);
    elements.apiKey.value = '';
    elements.apiKey.placeholder = `sk-...${lastFour} (saved)`;
  } else {
    elements.apiKey.value = '';
    elements.apiKey.placeholder = 'sk-...';
  }
  
  // Gemini API key
  if (settings.geminiKey && settings.geminiKey.length > 0) {
    const lastFour = settings.geminiKey.slice(-4);
    elements.geminiKey.value = '';
    elements.geminiKey.placeholder = `AIza...${lastFour} (saved)`;
  } else {
    elements.geminiKey.value = '';
    elements.geminiKey.placeholder = 'AIza...';
  }
  
  // Show warning if any key is set
  const hasKey = (settings.apiKey && settings.apiKey.length > 0) || 
                 (settings.geminiKey && settings.geminiKey.length > 0);
  elements.apiKeyWarning.style.display = hasKey ? 'block' : 'none';
  
  elements.model.value = settings.model || 'gpt-4o-transcribe';
  elements.geminiModel.value = settings.geminiModel || 'gemini-2.5-flash';
  elements.maxTime.value = String(settings.maxRecordingTime ?? 60);
  if (elements.maxTimeGemini) {
    elements.maxTimeGemini.value = String(settings.maxRecordingTime ?? 60);
  }
  
  // Pill gap
  const pillGap = settings.pillGap ?? 8;
  if (elements.pillGap) {
    elements.pillGap.value = pillGap;
    elements.pillGapValue.textContent = `${pillGap}px`;
  }
  
  renderModesList();
}

// Render modes list
function renderModesList() {
  const modesHtml = Object.entries(settings.modes)
    .map(([key, mode]) => `
      <div class="mode-item ${settings.activeMode === key ? 'active' : ''}" 
           data-mode="${key}">
        <span class="mode-icon">${mode.icon}</span>
        <div class="mode-info">
          <div class="mode-name">${mode.name}</div>
          <div class="mode-prompt-preview">${mode.prompt.substring(0, 50)}...</div>
        </div>
        <div class="mode-actions">
          <button class="mode-action-btn edit-mode" data-mode="${key}" title="Edit">✏️</button>
        </div>
      </div>
    `).join('');
  
  elements.modesList.innerHTML = modesHtml;
  
  // Add click listeners
  elements.modesList.querySelectorAll('.mode-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (!e.target.classList.contains('edit-mode')) {
        selectMode(item.dataset.mode);
      }
    });
  });
  
  elements.modesList.querySelectorAll('.edit-mode').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openModeEditor(btn.dataset.mode);
    });
  });
}

// Select active mode
function selectMode(modeKey) {
  settings.activeMode = modeKey;
  renderModesList();
  showToast('Mode selected: ' + settings.modes[modeKey].name);
}

// Open mode editor
function openModeEditor(modeKey = null) {
  isNewMode = !modeKey;
  editingMode = modeKey;
  
  if (isNewMode) {
    elements.editorTitle.textContent = 'New Mode';
    elements.modeName.value = '';
    elements.modeIcon.value = '🎯';
    elements.modePrompt.value = '';
    elements.deleteMode.style.display = 'none';
  } else {
    const mode = settings.modes[modeKey];
    elements.editorTitle.textContent = 'Edit Mode';
    elements.modeName.value = mode.name;
    elements.modeIcon.value = mode.icon;
    elements.modePrompt.value = mode.prompt;
    
    // Only show delete for custom modes (not the built-in ones)
    const builtInModes = ['default', 'email', 'grammar', 'casual', 'technical', 'medical', 'legal', 'notes'];
    elements.deleteMode.style.display = builtInModes.includes(modeKey) ? 'none' : 'block';
  }
  
  elements.modeEditor.style.display = 'block';
  elements.modeName.focus();
}

// Close mode editor
function closeModeEditor() {
  elements.modeEditor.style.display = 'none';
  editingMode = null;
  isNewMode = false;
}

// Save mode
function saveModeChanges() {
  const name = elements.modeName.value.trim();
  const icon = elements.modeIcon.value.trim() || '🎯';
  const prompt = elements.modePrompt.value.trim();
  
  if (!name) {
    showToast('Please enter a mode name', 'error');
    return;
  }
  
  if (!prompt) {
    showToast('Please enter a prompt', 'error');
    return;
  }
  
  let modeKey = editingMode;
  
  if (isNewMode) {
    // Generate a unique key for new modes
    modeKey = 'custom_' + Date.now();
  }
  
  settings.modes[modeKey] = { name, icon, prompt };
  
  renderModesList();
  closeModeEditor();
  showToast(isNewMode ? 'Mode created!' : 'Mode updated!', 'success');
}

// Delete mode
function deleteCurrentMode() {
  if (!editingMode) return;
  
  delete settings.modes[editingMode];
  
  // If deleted mode was active, switch to default
  if (settings.activeMode === editingMode) {
    settings.activeMode = 'default';
  }
  
  renderModesList();
  closeModeEditor();
  showToast('Mode deleted', 'success');
}

// Update status indicator
function updateStatus() {
  const provider = settings.provider || 'openai';
  const hasApiKey = provider === 'openai' 
    ? (settings.apiKey && settings.apiKey.length > 0)
    : (settings.geminiKey && settings.geminiKey.length > 0);
  const indicator = elements.statusIndicator;
  
  if (hasApiKey) {
    indicator.classList.add('ready');
    indicator.querySelector('.status-text').textContent = 'Ready';
  } else {
    indicator.classList.remove('ready');
    indicator.querySelector('.status-text').textContent = 'Add API key';
  }
}

// Show toast notification
function showToast(message, type = '') {
  elements.toast.textContent = message;
  elements.toast.className = 'toast ' + type;
  elements.toast.classList.add('show');
  
  setTimeout(() => {
    elements.toast.classList.remove('show');
  }, 2500);
}

// Reset to defaults
function resetToDefaults() {
  if (confirm('Reset all settings to defaults? Your API key will be preserved.')) {
    const apiKey = settings.apiKey;
    const apiKeyEncrypted = settings.apiKeyEncrypted;
    settings = { ...DEFAULT_SETTINGS, apiKey, apiKeyEncrypted };
    populateUI();
    showToast('Settings reset to defaults', 'success');
  }
}

// Format seconds to MM:SS or HH:MM:SS
function formatTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Format cost
function formatCost(cost) {
  if (cost < 0.01) {
    return '$' + cost.toFixed(4);
  }
  return '$' + cost.toFixed(2);
}

// Load and display usage stats
async function loadUsageStats() {
  const stats = await new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'getUsageStats' }, resolve);
  });
  
  if (!stats) return;
  
  // Today
  elements.todaySessions.textContent = stats.today.sessions || 0;
  elements.todayTime.textContent = formatTime(stats.today.audioSeconds || 0);
  elements.todayCost.textContent = formatCost(stats.today.estimatedCost || 0);
  
  // Last 7 days
  elements.weekSessions.textContent = stats.last7Days.sessions || 0;
  elements.weekTime.textContent = formatTime(stats.last7Days.audioSeconds || 0);
  elements.weekCost.textContent = formatCost(stats.last7Days.estimatedCost || 0);
  
  // All time
  elements.totalSessions.textContent = stats.total.sessions || 0;
  elements.totalTime.textContent = formatTime(stats.total.audioSeconds || 0);
  elements.totalCost.textContent = formatCost(stats.total.estimatedCost || 0);
  
  // Provider breakdown
  const byProvider = stats.byProvider || { 
    openai: { sessions: 0, cost: 0, audioSeconds: 0 }, 
    gemini: { sessions: 0, cost: 0, audioSeconds: 0 } 
  };
  elements.openaiSessions.textContent = byProvider.openai?.sessions || 0;
  elements.openaiTime.textContent = formatTime(byProvider.openai?.audioSeconds || 0);
  elements.openaiCost.textContent = formatCost(byProvider.openai?.cost || 0);
  elements.geminiSessions.textContent = byProvider.gemini?.sessions || 0;
  elements.geminiTime.textContent = formatTime(byProvider.gemini?.audioSeconds || 0);
  elements.geminiCost.textContent = formatCost(byProvider.gemini?.cost || 0);
}

// Clear usage stats
async function clearUsageStats() {
  if (confirm('Clear all usage history? This cannot be undone.')) {
    await new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'clearUsageStats' }, resolve);
    });
    await loadUsageStats();
    showToast('Usage history cleared', 'success');
  }
}

// Set up event listeners
function setupEventListeners() {
  // Provider tabs
  document.querySelectorAll('.provider-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const provider = tab.dataset.provider;
      settings.provider = provider;
      
      document.querySelectorAll('.provider-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.provider === provider);
      });
      elements.openaiSettings.style.display = provider === 'openai' ? 'block' : 'none';
      elements.geminiSettings.style.display = provider === 'gemini' ? 'block' : 'none';
    });
  });
  
  // Clear OpenAI API key button
  elements.clearKey.addEventListener('click', () => {
    settings.apiKey = '';
    settings.apiKeyEncrypted = false;
    elements.apiKey.value = '';
    elements.apiKey.placeholder = 'sk-...';
    updateStatus();
    showToast('API key cleared', 'success');
  });
  
  // Clear Gemini API key button
  elements.clearGeminiKey.addEventListener('click', () => {
    settings.geminiKey = '';
    settings.geminiKeyEncrypted = false;
    elements.geminiKey.value = '';
    elements.geminiKey.placeholder = 'AIza...';
    updateStatus();
    showToast('Gemini key cleared', 'success');
  });
  
  // OpenAI API key input
  elements.apiKey.addEventListener('input', () => {
    const value = elements.apiKey.value.trim();
    if (value && value.startsWith('sk-')) {
      settings.apiKey = value;
      settings.apiKeyEncrypted = false;
      elements.apiKeyWarning.style.display = 'block';
      updateStatus();
    }
  });
  
  // Gemini API key input
  elements.geminiKey.addEventListener('input', () => {
    const value = elements.geminiKey.value.trim();
    if (value && value.startsWith('AIza')) {
      settings.geminiKey = value;
      settings.geminiKeyEncrypted = false;
      elements.apiKeyWarning.style.display = 'block';
      updateStatus();
    }
  });
  
  // Model change
  elements.model.addEventListener('change', () => {
    settings.model = elements.model.value;
  });
  
  // Gemini model change
  elements.geminiModel.addEventListener('change', () => {
    settings.geminiModel = elements.geminiModel.value;
  });
  
  // Max time change - sync both selects
  const syncMaxTime = (value) => {
    settings.maxRecordingTime = parseInt(value) || 60;
    elements.maxTime.value = String(settings.maxRecordingTime);
    if (elements.maxTimeGemini) {
      elements.maxTimeGemini.value = String(settings.maxRecordingTime);
    }
  };
  
  elements.maxTime.addEventListener('change', () => {
    syncMaxTime(elements.maxTime.value);
  });
  
  if (elements.maxTimeGemini) {
    elements.maxTimeGemini.addEventListener('change', () => {
      syncMaxTime(elements.maxTimeGemini.value);
    });
  }
  
  // Pill gap slider
  if (elements.pillGap) {
    elements.pillGap.addEventListener('input', () => {
      const value = parseInt(elements.pillGap.value);
      settings.pillGap = value;
      elements.pillGapValue.textContent = `${value}px`;
    });
  }
  
  // Add mode button
  elements.addMode.addEventListener('click', () => openModeEditor());
  
  // Mode editor buttons
  elements.saveMode.addEventListener('click', saveModeChanges);
  elements.cancelEdit.addEventListener('click', closeModeEditor);
  elements.deleteMode.addEventListener('click', deleteCurrentMode);
  
  // Save settings button
  elements.saveSettings.addEventListener('click', async () => {
    await saveSettings();
    // Refresh UI to show masked key
    populateUI();
    showToast('Settings saved!', 'success');
  });
  
  // Reset defaults
  if (elements.resetDefaults) {
    elements.resetDefaults.addEventListener('click', resetToDefaults);
  }
  
  // Usage stats buttons
  elements.refreshStats.addEventListener('click', async () => {
    elements.refreshStats.style.transform = 'rotate(360deg)';
    await loadUsageStats();
    setTimeout(() => {
      elements.refreshStats.style.transform = '';
    }, 300);
  });
  
  elements.clearStats.addEventListener('click', clearUsageStats);
  
  // Chrome shortcuts link
  elements.shortcutsLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
  
  // Close editor when clicking outside
  document.addEventListener('click', (e) => {
    if (elements.modeEditor.style.display === 'block') {
      if (!elements.modeEditor.contains(e.target) && 
          !e.target.classList.contains('edit-mode') &&
          e.target !== elements.addMode) {
        closeModeEditor();
      }
    }
  });
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
