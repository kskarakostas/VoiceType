// VoiceType popup. Reads settings v2, saves on every change.
import { MSG } from '../shared/messages.js';
import { PROVIDERS } from '../shared/models.js';
import { formatCost } from '../shared/pricing.js';
import { freshSettings } from '../shared/defaults.js';

/** @type {import('../shared/defaults.js').Settings} */
let settings;
let editingMode = null;
let isNewMode = false;
// False when getSettings failed: the popup renders defaults but must never save them over the stored settings.
let settingsLoaded = false;
const LOAD_ERROR = 'Could not load settings. Close and reopen the popup.';

const $ = (id) => document.getElementById(id);
const el = {
  providerSections: { openai: $('openai-settings'), gemini: $('gemini-settings') },
  keyInput: { openai: $('api-key'), gemini: $('gemini-key') },
  testKey: { openai: $('test-key'), gemini: $('test-gemini-key') },
  clearKey: { openai: $('clear-key'), gemini: $('clear-gemini-key') },
  keyWarning: $('api-key-warning'),
  minTime: $('min-time'),
  maxTime: $('max-time'),
  modesList: $('modes-list'),
  modeEditor: $('mode-editor'),
  editorTitle: $('editor-title'),
  modeName: $('mode-name'),
  modeIcon: $('mode-icon'),
  modePrompt: $('mode-prompt'),
  addMode: $('add-mode'),
  saveMode: $('save-mode'),
  cancelEdit: $('cancel-edit'),
  deleteMode: $('delete-mode'),
  resetDefaults: $('reset-defaults'),
  statusIndicator: $('status-indicator'),
  shortcutsLink: $('shortcuts-link'),
  toast: $('toast'),
  versionText: $('version-text'),
  refreshStats: $('refresh-stats'),
  clearStats: $('clear-stats'),
};

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(chrome.runtime.lastError ? null : response));
  });
}

/** Saves the full settings object, keys included. Resolves true on success; shows an error toast otherwise. */
async function persist() {
  if (!settingsLoaded) {
    showToast(LOAD_ERROR, 'error', { sticky: true });
    return false;
  }
  const response = await send({ action: MSG.SAVE_SETTINGS, settings });
  if (response?.success === true) return true;
  showToast(response?.error || 'Could not save settings', 'error');
  return false;
}

async function init() {
  const stored = await send({ action: MSG.GET_SETTINGS });
  settingsLoaded = Boolean(stored && typeof stored === 'object'
    && stored.modes && typeof stored.modes === 'object' && !Array.isArray(stored.modes));
  settings = settingsLoaded ? stored : freshSettings();
  el.versionText.textContent = `v${chrome.runtime.getManifest().version}`;
  populateUI();
  setupTabs();
  setupEventListeners();
  if (!settingsLoaded) showToast(LOAD_ERROR, 'error', { sticky: true });
  await loadUsageStats();
}

function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  const contents = document.querySelectorAll('.tab-content');
  tabs.forEach((tab) => tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.toggle('active', t === tab));
    contents.forEach((c) => c.classList.toggle('active', c.id === `tab-${tab.dataset.tab}`));
  }));
}

function maskKey(key) {
  return key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)} (saved)` : 'saved';
}

function populateUI() {
  const provider = settings.provider;
  document.querySelectorAll('.provider-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.provider === provider));
  for (const id of Object.keys(PROVIDERS)) {
    el.providerSections[id].style.display = id === provider ? 'block' : 'none';
    const key = settings.keys[id] || '';
    el.keyInput[id].value = '';
    el.keyInput[id].placeholder = key ? maskKey(key) : PROVIDERS[id].keyPlaceholder;
  }
  el.keyWarning.style.display = Object.values(settings.keys).some(Boolean) ? 'block' : 'none';
  el.minTime.value = String(settings.minRecordingTime ?? 1);
  el.maxTime.value = String(settings.maxRecordingTime ?? 120);
  renderModesList();
  updateStatus();
}

function updateStatus() {
  const hasKey = Boolean(settings.keys[settings.provider]);
  el.statusIndicator.classList.toggle('ready', hasKey);
  el.statusIndicator.querySelector('.status-text').textContent = hasKey ? 'Ready' : 'Add API key';
}

function renderModesList() {
  el.modesList.replaceChildren();
  for (const [key, mode] of Object.entries(settings.modes)) {
    const item = document.createElement('div');
    item.className = `mode-item ${settings.activeMode === key ? 'active' : ''}`;
    item.dataset.mode = key;

    const icon = document.createElement('span');
    icon.className = 'mode-icon';
    icon.textContent = mode.icon || '🎯';

    const info = document.createElement('div');
    info.className = 'mode-info';
    const name = document.createElement('div');
    name.className = 'mode-name';
    name.textContent = mode.name;
    if (mode.builtIn) {
      const badge = document.createElement('span');
      badge.className = 'mode-badge';
      badge.textContent = 'built-in';
      name.append(badge);
    }
    const preview = document.createElement('div');
    preview.className = 'mode-prompt-preview';
    preview.textContent = (mode.prompt || '').trim() ? mode.prompt.slice(0, 60) : 'Raw transcription';
    info.append(name, preview);

    const edit = document.createElement('button');
    edit.className = 'mode-action-btn';
    edit.title = 'Edit';
    edit.setAttribute('aria-label', `Edit ${mode.name}`);
    edit.textContent = '✎';
    edit.addEventListener('click', (e) => { e.stopPropagation(); openModeEditor(key); });

    item.append(icon, info, edit);
    item.addEventListener('click', () => selectMode(key));
    el.modesList.append(item);
  }
}

async function selectMode(key) {
  settings.activeMode = key;
  renderModesList();
  if (await persist()) showToast(`Mode: ${settings.modes[key].name}`);
}

function openModeEditor(key = null) {
  isNewMode = !key;
  editingMode = key;
  if (isNewMode) {
    el.editorTitle.textContent = 'New mode';
    el.modeName.value = '';
    el.modeIcon.value = '🎯';
    el.modePrompt.value = '';
    el.deleteMode.style.display = 'none';
  } else {
    const mode = settings.modes[key];
    el.editorTitle.textContent = 'Edit mode';
    el.modeName.value = mode.name;
    el.modeIcon.value = mode.icon;
    el.modePrompt.value = mode.prompt || '';
    el.deleteMode.style.display = mode.builtIn ? 'none' : 'block';
  }
  el.modeEditor.style.display = 'block';
  el.modeName.focus();
}

function closeModeEditor() {
  el.modeEditor.style.display = 'none';
  editingMode = null;
  isNewMode = false;
}

async function saveModeChanges() {
  const name = el.modeName.value.trim();
  const icon = el.modeIcon.value.trim() || '🎯';
  const prompt = el.modePrompt.value.trim();
  if (!name) { showToast('Enter a mode name', 'error'); return; }
  const created = isNewMode;
  const key = created ? `custom_${Date.now()}` : editingMode;
  const existing = settings.modes[key] || { builtIn: false };
  settings.modes[key] = { ...existing, name, icon, prompt };
  renderModesList();
  closeModeEditor();
  if (await persist()) showToast(created ? 'Mode created' : 'Mode updated', 'success');
}

async function deleteCurrentMode() {
  if (!editingMode || settings.modes[editingMode]?.builtIn) return;
  delete settings.modes[editingMode];
  if (settings.activeMode === editingMode) settings.activeMode = 'default';
  renderModesList();
  closeModeEditor();
  if (await persist()) showToast('Mode deleted', 'success');
}

async function resetToDefaults() {
  if (!confirm('Reset modes, prompts and recording limits to defaults? Your API keys and provider are kept.')) return;
  const keys = { ...settings.keys };
  const { provider } = settings;
  settings = { ...freshSettings(), keys, provider };
  closeModeEditor(); // an open editor would otherwise save into a mode that may no longer exist
  populateUI();
  if (await persist()) showToast('Settings reset', 'success');
}

/** @param {{ sticky?: boolean }} [options] sticky skips the auto-hide. */
function showToast(message, type = '', { sticky = false } = {}) {
  el.toast.textContent = message;
  el.toast.className = `toast ${type} show`;
  clearTimeout(showToast.timer);
  if (!sticky) showToast.timer = setTimeout(() => el.toast.classList.remove('show'), 2500);
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mmss = `${m}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : mmss;
}

async function loadUsageStats() {
  const stats = await send({ action: MSG.GET_USAGE });
  if (!(stats && stats.total && typeof stats.total === 'object')) return;
  const fill = (prefix, bucket) => {
    $(`${prefix}-sessions`).textContent = bucket.sessions || 0;
    $(`${prefix}-time`).textContent = formatTime(bucket.audioSeconds || 0);
    $(`${prefix}-cost`).textContent = formatCost(bucket.estimatedCost || 0);
  };
  fill('today', stats.today);
  fill('week', stats.last7Days);
  fill('total', stats.total);
  for (const id of Object.keys(PROVIDERS)) {
    const p = stats.total.byProvider?.[id] || { sessions: 0, audioSeconds: 0, cost: 0 };
    $(`${id}-sessions`).textContent = p.sessions;
    $(`${id}-time`).textContent = formatTime(p.audioSeconds);
    $(`${id}-cost`).textContent = formatCost(p.cost);
  }
}

async function testKey(provider) {
  const typed = el.keyInput[provider].value.trim();
  const key = typed || settings.keys[provider];
  if (!key) { showToast('Enter a key first', 'error'); return; }
  const button = el.testKey[provider];
  button.disabled = true;
  button.textContent = 'Testing…';
  const result = await send({ action: MSG.VALIDATE_KEY, provider, key });
  button.disabled = false;
  button.textContent = 'Test';
  if (result?.ok) showToast(`${PROVIDERS[provider].label} key works`, 'success');
  else showToast(result?.error || 'Could not reach the provider', 'error');
}

function setupEventListeners() {
  document.querySelectorAll('.provider-tab').forEach((tab) => tab.addEventListener('click', async () => {
    settings.provider = tab.dataset.provider;
    populateUI();
    await persist();
  }));

  for (const provider of Object.keys(PROVIDERS)) {
    el.keyInput[provider].addEventListener('change', async () => {
      const value = el.keyInput[provider].value.trim();
      if (!value) return;
      settings.keys[provider] = value;
      populateUI();
      if (await persist()) showToast('Key saved', 'success');
    });
    el.testKey[provider].addEventListener('click', () => testKey(provider));
    el.clearKey[provider].addEventListener('click', async () => {
      settings.keys[provider] = '';
      populateUI();
      if (await persist()) showToast('Key cleared', 'success');
    });
  }

  el.minTime.addEventListener('change', async () => { settings.minRecordingTime = Number(el.minTime.value) || 1; await persist(); });
  el.maxTime.addEventListener('change', async () => { settings.maxRecordingTime = Number(el.maxTime.value) || 120; await persist(); });

  el.addMode.addEventListener('click', () => openModeEditor());
  el.saveMode.addEventListener('click', saveModeChanges);
  el.cancelEdit.addEventListener('click', closeModeEditor);
  el.deleteMode.addEventListener('click', deleteCurrentMode);
  el.resetDefaults.addEventListener('click', resetToDefaults);

  el.refreshStats.addEventListener('click', loadUsageStats);
  el.clearStats.addEventListener('click', async () => {
    if (!confirm('Clear all usage history? This cannot be undone.')) return;
    await send({ action: MSG.CLEAR_USAGE });
    await loadUsageStats();
    showToast('Usage history cleared', 'success');
  });

  el.shortcutsLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
}

document.addEventListener('DOMContentLoaded', init);
