// VoiceType popup. A trusted extension page: it reads the full settings (keys included) and
// autosaves every change with SAVE_SETTINGS, rolling the change back when the save fails.
import { MSG } from '../shared/messages.js';
import { PROVIDERS } from '../shared/models.js';
import { formatCost } from '../shared/pricing.js';
import { freshSettings, AUTO_STOP_CHOICES } from '../shared/defaults.js';
import { formatChord, chordFromEvent } from '../shared/chord.js';
import {
  SPOKEN_LANGUAGES, MAX_KEYWORDS, parseKeywords, formatKeywords, toggleLanguage, createInlineConfirm,
} from './form.js';

// Typing pauses this long before a key or the vocabulary saves; blur and change save at once.
const TYPING_SAVE_MS = 800;
const LOAD_ERROR = 'Could not load settings. Close and reopen the popup.';
const NOT_LOADED = 'Settings are not loaded. Nothing was saved.';
const HOTKEY_IDLE_HINT = 'Tap to toggle, hold to talk.';
const HOTKEY_ARMED_HINT = 'Press the new hotkey. Esc cancels.';
const HOTKEY_INVALID_HINT = 'Use Ctrl, Alt or Cmd with a key';
const RESET_PROMPT = 'Click again to reset modes, prompts, recording limits, silence auto-stop and hotkey';
const DEFAULT_MODE_ICON = '🎯';
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'OS']);
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_PATHS = {
  edit: ['M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3Z', 'm13.5 8.5 3 3'],
  check: ['m5 12.5 4.5 4.5L19 7.5'],
};

/** Seconds as m:ss, or h:mm:ss from one hour up. */
function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(Math.floor(seconds % 60)).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function maskKey(key) {
  return key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)} (saved)` : 'Key saved';
}

function isSettings(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Boolean(value.modes) && typeof value.modes === 'object' && !Array.isArray(value.modes)
    && Boolean(value.keys) && typeof value.keys === 'object';
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Wire the popup markup, load settings and usage, and autosave every control.
 * @param {{ chrome: typeof globalThis.chrome, document: Document, window: Window }} env
 * @returns {Promise<{ readonly settings: import('../shared/defaults.js').Settings, readonly loaded: boolean }>}
 */
export async function initPopup({ chrome, document, window }) {
  const $ = (id) => document.getElementById(id);
  const setTimer = (fn, ms) => window.setTimeout(fn, ms);
  const clearTimer = (id) => window.clearTimeout(id);
  const nav = window.navigator;
  const mac = /mac/i.test(nav?.userAgentData?.platform || nav?.platform || '');
  const providerIds = Object.keys(PROVIDERS);

  const el = {
    status: $('status'), statusText: $('status-text'), banner: $('banner'), bannerText: $('banner-text'),
    providerRadios: [...document.querySelectorAll('input[name="provider"]')],
    keyRow: {}, keyInput: {}, testKey: {}, clearKey: {}, spendHint: $('spend-hint'),
    minTime: $('min-time'), maxTime: $('max-time'), autoStop: $('auto-stop'),
    hotkey: $('hotkey'), hotkeyHint: $('hotkey-hint'),
    languages: $('languages'), keywords: $('keywords'), keywordCount: $('keyword-count'),
    modeList: $('mode-list'), addMode: $('add-mode'), editor: $('mode-editor'), editorTitle: $('editor-title'),
    modeName: $('mode-name'), modeIcon: $('mode-icon'), modePrompt: $('mode-prompt'),
    deleteMode: $('delete-mode'), cancelMode: $('cancel-mode'), saveMode: $('save-mode'),
    refreshUsage: $('refresh-usage'), clearUsage: $('clear-usage'),
    version: $('version'), reset: $('reset'), toast: $('toast'),
  };
  for (const id of providerIds) {
    el.keyRow[id] = $(`key-row-${id}`);
    el.keyInput[id] = $(`key-${id}`);
    el.testKey[id] = $(`test-${id}`);
    el.clearKey[id] = $(`clear-${id}`);
  }

  let settings = freshSettings();
  let loaded = false;
  /** @type {{ key: string|null } | null} */
  let editing = null;
  let hotkeyArmed = false;
  let toastTimer;
  let keywordTimer;
  const keyTimers = {};

  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return null;
    }
  }

  function toast(text, tone = 'info') {
    el.toast.textContent = text;
    el.toast.dataset.tone = tone;
    el.toast.hidden = false;
    clearTimer(toastTimer);
    toastTimer = setTimer(() => { el.toast.hidden = true; }, tone === 'error' ? 6000 : 2500);
  }

  /**
   * Apply a change, save the whole settings object, and roll back on failure.
   * @param {(s: import('../shared/defaults.js').Settings) => void} mutate
   * @param {string} [successText]
   * @returns {Promise<boolean>}
   */
  async function commit(mutate, successText) {
    const previous = structuredClone(settings);
    mutate(settings);
    render();
    const response = loaded ? await send({ action: MSG.SAVE_SETTINGS, settings }) : null;
    if (response?.success === true) {
      if (successText) toast(successText, 'success');
      return true;
    }
    settings = previous;
    render();
    toast(loaded ? response?.error || 'Could not save settings.' : NOT_LOADED, 'error');
    return false;
  }

  function svgIcon(name, className) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);
    for (const d of ICON_PATHS[name]) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  function span(className, text) {
    const node = document.createElement('span');
    node.className = className;
    node.textContent = text;
    return node;
  }

  // Rendering. A focused text field is never overwritten, so a save while typing keeps the caret.

  function render() {
    renderProvider();
    renderRecording();
    renderSpeech();
    renderModes();
  }

  function renderProvider() {
    for (const radio of el.providerRadios) radio.checked = radio.value === settings.provider;
    for (const id of providerIds) {
      const key = settings.keys[id] || '';
      el.keyRow[id].hidden = id !== settings.provider;
      el.keyInput[id].placeholder = key ? maskKey(key) : PROVIDERS[id].keyPlaceholder;
      if (document.activeElement !== el.keyInput[id]) el.keyInput[id].value = '';
      el.clearKey[id].disabled = !key;
    }
    const ready = Boolean(settings.keys[settings.provider]?.trim());
    el.status.dataset.ready = String(ready);
    el.statusText.textContent = ready ? 'Ready' : 'Add API key';
    el.spendHint.hidden = !providerIds.some((id) => settings.keys[id]?.trim());
  }

  function setSelect(select, value) {
    const wanted = String(value);
    if (![...select.options].some((o) => o.value === wanted)) {
      const option = document.createElement('option');
      option.value = wanted;
      option.textContent = `${wanted} s`;
      select.append(option);
    }
    select.value = wanted;
  }

  function renderRecording() {
    setSelect(el.minTime, settings.minRecordingTime);
    setSelect(el.maxTime, settings.maxRecordingTime);
    el.autoStop.value = String(settings.autoStopSilenceSec);
    renderHotkey();
  }

  function renderHotkey() {
    el.hotkey.textContent = hotkeyArmed ? 'Press keys' : formatChord(settings.hotkey, { mac });
    el.hotkey.setAttribute('aria-pressed', String(hotkeyArmed));
  }

  function renderSpeech() {
    const chosen = new Set(settings.languages);
    for (const box of el.languages.querySelectorAll('input[type="checkbox"]')) {
      box.checked = box.value === 'auto' ? settings.languages.length === 0 : chosen.has(box.value);
    }
    if (document.activeElement !== el.keywords) el.keywords.value = formatKeywords(settings.keywords);
    el.keywordCount.textContent = `${settings.keywords.length} of ${MAX_KEYWORDS} terms`;
  }

  function renderModes() {
    const focused = el.modeList.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    el.modeList.replaceChildren();
    for (const [key, mode] of Object.entries(settings.modes)) {
      const active = key === settings.activeMode;
      const item = document.createElement('li');
      item.className = 'mode';

      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'mode-select';
      select.dataset.focusKey = `select:${key}`;
      select.setAttribute('aria-pressed', String(active));
      const name = span('mode-name', mode.name);
      if (mode.builtIn) name.append(span('mode-badge', 'Built-in'));
      const text = span('mode-text', '');
      text.append(name, span('mode-preview', mode.prompt?.trim() ? mode.prompt.trim() : 'Raw transcription'));
      select.append(span('mode-icon', mode.icon || DEFAULT_MODE_ICON), text);
      if (active) select.append(svgIcon('check', 'mode-check'));
      select.addEventListener('click', () => selectMode(key));

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'icon-btn';
      edit.dataset.focusKey = `edit:${key}`;
      edit.setAttribute('aria-label', `Edit ${mode.name}`);
      edit.append(svgIcon('edit'));
      edit.addEventListener('click', () => openEditor(key));

      item.append(select, edit);
      el.modeList.append(item);
    }
    if (focused) {
      for (const button of el.modeList.querySelectorAll('button')) {
        if (button.dataset.focusKey === focused) button.focus();
      }
    }
  }

  // Provider and keys.

  async function saveKey(id) {
    clearTimer(keyTimers[id]);
    const value = el.keyInput[id].value.trim();
    if (!value || value === settings.keys[id]) {
      renderProvider();
      return;
    }
    await commit((s) => { s.keys[id] = value; }, 'Key saved');
  }

  async function testKey(id) {
    const key = el.keyInput[id].value.trim() || settings.keys[id]?.trim();
    if (!key) {
      toast('Enter a key first', 'error');
      return;
    }
    const button = el.testKey[id];
    button.disabled = true;
    button.textContent = 'Testing…';
    const result = await send({ action: MSG.VALIDATE_KEY, provider: id, key });
    button.disabled = false;
    button.textContent = 'Test';
    if (result?.ok) toast(`${PROVIDERS[id].label} key works`, 'success');
    else toast(result?.error || 'Could not reach the provider.', 'error');
  }

  for (const radio of el.providerRadios) {
    radio.addEventListener('change', () => {
      if (radio.checked) commit((s) => { s.provider = radio.value; });
    });
  }

  for (const id of providerIds) {
    const input = el.keyInput[id];
    input.addEventListener('input', () => {
      clearTimer(keyTimers[id]);
      keyTimers[id] = setTimer(() => saveKey(id), TYPING_SAVE_MS);
    });
    input.addEventListener('change', () => saveKey(id));
    input.addEventListener('blur', () => saveKey(id));
    el.testKey[id].addEventListener('click', () => testKey(id));
    el.clearKey[id].addEventListener('click', () => {
      clearTimer(keyTimers[id]);
      input.value = '';
      commit((s) => { s.keys[id] = ''; }, 'Key cleared');
    });
  }

  // Recording.

  for (const seconds of AUTO_STOP_CHOICES) {
    const option = document.createElement('option');
    option.value = String(seconds);
    option.textContent = seconds === 0 ? 'Off' : `${seconds} s`;
    el.autoStop.append(option);
  }

  el.minTime.addEventListener('change', () => commit((s) => { s.minRecordingTime = Number(el.minTime.value); }));
  el.maxTime.addEventListener('change', () => commit((s) => { s.maxRecordingTime = Number(el.maxTime.value); }));
  el.autoStop.addEventListener('change', () => commit((s) => { s.autoStopSilenceSec = Number(el.autoStop.value); }));

  function setHotkeyHint(text, tone) {
    el.hotkeyHint.textContent = text;
    if (tone) el.hotkeyHint.dataset.tone = tone;
    else delete el.hotkeyHint.dataset.tone;
  }

  function disarmHotkey() {
    hotkeyArmed = false;
    setHotkeyHint(HOTKEY_IDLE_HINT);
    renderHotkey();
  }

  el.hotkey.addEventListener('click', () => {
    if (hotkeyArmed) {
      disarmHotkey();
      return;
    }
    hotkeyArmed = true;
    setHotkeyHint(HOTKEY_ARMED_HINT);
    renderHotkey();
    el.hotkey.focus();
  });
  el.hotkey.addEventListener('blur', () => { if (hotkeyArmed) disarmHotkey(); });
  el.hotkey.addEventListener('keydown', (event) => {
    if (!hotkeyArmed || event.key === 'Tab') return;
    // Also keeps Escape from closing the popup and Space or Enter from clicking the button.
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      disarmHotkey();
      return;
    }
    if (MODIFIER_KEYS.has(event.key)) return;
    const chord = chordFromEvent(event);
    if (!chord) {
      setHotkeyHint(HOTKEY_INVALID_HINT, 'error');
      return;
    }
    hotkeyArmed = false;
    setHotkeyHint(HOTKEY_IDLE_HINT);
    commit((s) => { s.hotkey = chord; }, `Hotkey: ${formatChord(chord, { mac })}`);
  });

  // Speech.

  for (const { code, label } of [{ code: 'auto', label: 'Auto' }, ...SPOKEN_LANGUAGES]) {
    const wrap = document.createElement('label');
    wrap.className = 'check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = `lang-${code}`;
    box.value = code;
    box.addEventListener('change', () => commit((s) => { s.languages = toggleLanguage(s.languages, code, box.checked); }));
    wrap.append(box, document.createTextNode(label));
    el.languages.append(wrap);
  }

  async function saveKeywords() {
    clearTimer(keywordTimer);
    const next = parseKeywords(el.keywords.value);
    if (sameList(next, settings.keywords)) {
      renderSpeech();
      return;
    }
    await commit((s) => { s.keywords = next; });
  }

  el.keywords.addEventListener('input', () => {
    clearTimer(keywordTimer);
    keywordTimer = setTimer(saveKeywords, TYPING_SAVE_MS);
  });
  el.keywords.addEventListener('change', saveKeywords);
  el.keywords.addEventListener('blur', saveKeywords);

  // Modes.

  function selectMode(key) {
    if (key === settings.activeMode) return;
    commit((s) => { s.activeMode = key; }, `Mode: ${settings.modes[key].name}`);
  }

  function openEditor(key) {
    editing = { key };
    const mode = key ? settings.modes[key] : null;
    el.editorTitle.textContent = key ? 'Edit mode' : 'New mode';
    el.modeName.value = mode?.name ?? '';
    el.modeIcon.value = mode?.icon ?? DEFAULT_MODE_ICON;
    el.modePrompt.value = mode?.prompt ?? '';
    el.deleteMode.hidden = !key || Boolean(mode?.builtIn);
    el.editor.hidden = false;
    el.modeName.focus();
  }

  function closeEditor() {
    editing = null;
    el.editor.hidden = true;
  }

  async function saveEditor() {
    if (!editing) return;
    const name = el.modeName.value.trim();
    if (!name) {
      toast('Enter a mode name', 'error');
      el.modeName.focus();
      return;
    }
    const icon = el.modeIcon.value.trim() || DEFAULT_MODE_ICON;
    const prompt = el.modePrompt.value.trim();
    const created = editing.key === null;
    const key = created ? `custom_${Date.now()}` : editing.key;
    const ok = await commit((s) => {
      s.modes[key] = { ...(s.modes[key] || { builtIn: false }), name, icon, prompt };
    }, created ? 'Mode created' : 'Mode updated');
    if (ok) closeEditor();
  }

  async function deleteEditingMode() {
    const key = editing?.key;
    if (!key || settings.modes[key]?.builtIn) return;
    const ok = await commit((s) => {
      delete s.modes[key];
      if (s.activeMode === key) s.activeMode = 'default';
    }, 'Mode deleted');
    if (ok) closeEditor();
  }

  el.addMode.addEventListener('click', () => openEditor(null));
  el.saveMode.addEventListener('click', saveEditor);
  el.cancelMode.addEventListener('click', closeEditor);
  el.deleteMode.addEventListener('click', deleteEditingMode);

  // Usage.

  function fillUsage(prefix, bucket, costField) {
    $(`usage-${prefix}-sessions`).textContent = String(bucket?.sessions || 0);
    $(`usage-${prefix}-audio`).textContent = formatTime(bucket?.audioSeconds || 0);
    $(`usage-${prefix}-cost`).textContent = formatCost(bucket?.[costField] || 0);
  }

  async function loadUsage() {
    const stats = await send({ action: MSG.GET_USAGE });
    if (!stats?.total || typeof stats.total !== 'object') return false;
    fillUsage('today', stats.today, 'estimatedCost');
    fillUsage('week', stats.last7Days, 'estimatedCost');
    fillUsage('total', stats.total, 'estimatedCost');
    for (const id of providerIds) fillUsage(id, stats.total.byProvider?.[id], 'cost');
    return true;
  }

  el.refreshUsage.addEventListener('click', async () => {
    if (!(await loadUsage())) toast('Could not load usage.', 'error');
  });

  createInlineConfirm(el.clearUsage, {
    prompt: 'Click again to clear usage history',
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    onConfirm: async () => {
      const response = await send({ action: MSG.CLEAR_USAGE });
      if (response?.success !== true) {
        toast('Could not clear usage history.', 'error');
        return;
      }
      await loadUsage();
      toast('Usage history cleared', 'success');
    },
  });

  // About and reset.

  el.version.textContent = `Version ${chrome.runtime.getManifest().version}`;
  for (const link of document.querySelectorAll('a[data-external]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      chrome.tabs.create({ url: link.href });
    });
  }

  createInlineConfirm(el.reset, {
    prompt: RESET_PROMPT,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    onConfirm: () => {
      closeEditor();
      return commit((s) => {
        const kept = { keys: { ...s.keys }, provider: s.provider, languages: [...s.languages], keywords: [...s.keywords] };
        Object.assign(s, freshSettings(), kept);
      }, 'Settings reset');
    },
  });

  // Load.

  const stored = await send({ action: MSG.GET_SETTINGS });
  loaded = isSettings(stored);
  if (loaded) {
    settings = { ...freshSettings(), ...stored };
  } else {
    // Never save from fallback settings: that would write blank keys over the real ones.
    el.bannerText.textContent = LOAD_ERROR;
    el.banner.hidden = false;
  }
  render();
  await loadUsage();

  return {
    get settings() { return settings; },
    get loaded() { return loaded; },
  };
}

if (globalThis.chrome?.runtime) {
  document.addEventListener('DOMContentLoaded', () => {
    initPopup({ chrome: globalThis.chrome, document, window });
  });
}
