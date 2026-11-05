// Modes: the mode list (choose the active mode), the editor that creates, edits and deletes
// modes, both ported from the 2.2 popup unchanged in behaviour, and the Translate target, the way
// to change it without a pill menu. Changes save through ctx.commit.
import { TARGET_LANGUAGES, orderedModeKeys } from '../../shared/defaults.js';
import { sameList } from '../../ui/lists.js';

/** @typedef {import('../options.js').PageContext} PageContext */
/** @typedef {import('../options.js').Section} Section */

const DEFAULT_MODE_ICON = '🎯';
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_PATHS = {
  edit: ['M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3Z', 'm13.5 8.5 3 3'],
  check: ['m5 12.5 4.5 4.5L19 7.5'],
};

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

/** Put `child` in `parent` exactly when `present`, touching the DOM only on a change. */
function keepChild(parent, child, present) {
  if (present && child.parentNode !== parent) parent.append(child);
  else if (!present && child.parentNode === parent) child.remove();
}

/**
 * @param {PageContext} ctx
 * @returns {Section}
 */
export function createModesSection(ctx) {
  const { $, document } = ctx;
  const el = {
    modeList: $('mode-list'), addMode: $('add-mode'), editor: $('mode-editor'), editorTitle: $('editor-title'),
    modeName: $('mode-name'), modeIcon: $('mode-icon'), modePrompt: $('mode-prompt'),
    deleteMode: $('delete-mode'), closeMode: $('close-mode'), createMode: $('create-mode'),
    target: $('translate-target'),
  };
  /** @type {{ key: string|null } | null} */
  let editing = null;
  const modeSave = ctx.typingSave(saveModeEdits);
  /** Mode list rows by mode key, reused across renders. */
  const modeRows = new Map();
  /** Stands for a stored target outside TARGET_LANGUAGES, so a render never rewrites it. */
  const otherTarget = document.createElement('option');

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

  // Rendering. A focused editor field is never overwritten, so a save while typing keeps the caret.

  function render() {
    renderModes();
    renderEditor();
    if (document.activeElement !== el.target) paintTarget();
  }

  function createModeRow(key) {
    const item = document.createElement('li');
    item.className = 'mode';

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'mode-select';
    select.dataset.focusKey = `select:${key}`;
    const icon = span('mode-icon', '');
    const label = document.createTextNode('');
    const name = span('mode-name', '');
    name.append(label);
    const preview = span('mode-preview', '');
    const text = span('mode-text', '');
    text.append(name, preview);
    select.append(icon, text);
    select.addEventListener('click', () => selectMode(key));

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'icon-btn';
    edit.dataset.focusKey = `edit:${key}`;
    edit.append(svgIcon('edit'));
    edit.addEventListener('click', () => openEditor(key));

    item.append(select, edit);
    return {
      item, select, icon, name, label, preview, edit,
      badge: span('mode-badge', 'Built-in'),
      check: svgIcon('check', 'mode-check'),
    };
  }

  function fillModeRow(row, key) {
    const settings = ctx.settings();
    const mode = settings.modes[key];
    const active = key === settings.activeMode;
    row.select.setAttribute('aria-pressed', String(active));
    setText(row.icon, mode.icon || DEFAULT_MODE_ICON);
    setText(row.label, mode.name);
    keepChild(row.name, row.badge, Boolean(mode.builtIn));
    setText(row.preview, mode.prompt?.trim() ? mode.prompt.trim() : 'Raw transcription');
    keepChild(row.select, row.check, active);
    row.edit.setAttribute('aria-label', `Edit ${mode.name}`);
  }

  // Rows are updated in place; the list is rebuilt only when modes are added, removed or
  // reordered. A blur save renders between mousedown and mouseup, and a row replaced in
  // between never receives its click.
  function renderModes() {
    const keys = orderedModeKeys(ctx.settings().modes);
    for (const key of modeRows.keys()) if (!keys.includes(key)) modeRows.delete(key);
    for (const key of keys) {
      if (!modeRows.has(key)) modeRows.set(key, createModeRow(key));
      fillModeRow(modeRows.get(key), key);
    }
    const items = keys.map((key) => modeRows.get(key).item);
    if (sameList(items, [...el.modeList.children])) return;
    const focused = el.modeList.contains(document.activeElement) ? document.activeElement : null;
    el.modeList.replaceChildren(...items);
    if (focused?.isConnected) focused.focus();
  }

  /** The editor shows the saved mode it edits; a new-mode draft is not in settings yet. */
  function renderEditor() {
    const mode = editing?.key ? ctx.settings().modes[editing.key] : null;
    if (!mode) return;
    if (document.activeElement !== el.modeName) el.modeName.value = mode.name;
    if (document.activeElement !== el.modeIcon) el.modeIcon.value = mode.icon || DEFAULT_MODE_ICON;
    if (document.activeElement !== el.modePrompt) el.modePrompt.value = mode.prompt;
  }

  function paintTarget() {
    const value = ctx.settings().translateTargetLang;
    const listed = TARGET_LANGUAGES.some(({ name }) => name === value);
    if (!listed) {
      otherTarget.value = value;
      setText(otherTarget, value);
    }
    keepChild(el.target, otherTarget, !listed);
    el.target.value = value;
  }

  // The render skips a focused select, so a save that failed puts the stored value back here.
  async function saveTarget() {
    const value = el.target.value;
    const saved = await ctx.commit((s) => { s.translateTargetLang = value; }, `Translate to: ${value}`);
    if (!saved) paintTarget();
  }

  function selectMode(key) {
    const settings = ctx.settings();
    if (key === settings.activeMode) return;
    ctx.commit((s) => { s.activeMode = key; }, `Mode: ${settings.modes[key].name}`);
  }

  /** The editor fields as a mode, or null when the name is empty. */
  function readEditor() {
    const name = el.modeName.value.trim();
    if (!name) return null;
    return { name, icon: el.modeIcon.value.trim() || DEFAULT_MODE_ICON, prompt: el.modePrompt.value.trim() };
  }

  // An existing mode autosaves like every other control; only a new mode waits for Create.
  function syncEditorActions() {
    const key = editing?.key ?? null;
    el.editorTitle.textContent = key ? 'Edit mode' : 'New mode';
    el.createMode.hidden = Boolean(key);
    el.closeMode.textContent = key ? 'Close' : 'Cancel';
    el.deleteMode.hidden = !key || Boolean(ctx.settings().modes[key]?.builtIn);
  }

  // A mode another page deleted is no longer in settings, so an edit typed here never brings it back.
  async function saveModeEdits() {
    modeSave.cancel();
    const key = editing?.key;
    const mode = key ? ctx.settings().modes[key] : null;
    if (!mode) return;
    const fields = readEditor();
    if (!fields) {
      ctx.toast('Enter a mode name', 'error');
      return;
    }
    if (fields.name === mode.name && fields.icon === mode.icon && fields.prompt === mode.prompt) return;
    await ctx.commit((s) => { s.modes[key] = { ...s.modes[key], ...fields }; });
  }

  function openEditor(key) {
    saveModeEdits();
    editing = { key };
    syncEditorActions();
    const mode = key ? ctx.settings().modes[key] : null;
    el.modeName.value = mode?.name ?? '';
    el.modeIcon.value = mode?.icon ?? DEFAULT_MODE_ICON;
    el.modePrompt.value = mode?.prompt ?? '';
    el.editor.hidden = false;
    el.modeName.focus();
  }

  function closeEditor() {
    saveModeEdits();
    editing = null;
    el.editor.hidden = true;
  }

  async function createMode() {
    const draft = editing;
    if (draft?.key !== null || el.createMode.disabled) return;
    const fields = readEditor();
    if (!fields) {
      ctx.toast('Enter a mode name', 'error');
      el.modeName.focus();
      return;
    }
    const key = `custom_${Date.now()}`;
    el.createMode.disabled = true;
    const ok = await ctx.commit((s) => { s.modes[key] = { ...fields, builtIn: false }; }, 'Mode created');
    el.createMode.disabled = false;
    if (!ok || editing !== draft) return;
    editing = { key };
    syncEditorActions();
  }

  async function deleteEditingMode() {
    const key = editing?.key;
    if (!key || ctx.settings().modes[key]?.builtIn) return;
    const ok = await ctx.commit((s) => {
      delete s.modes[key];
      if (s.activeMode === key) s.activeMode = 'default';
    }, 'Mode deleted');
    if (ok) closeEditor();
  }

  for (const { name } of TARGET_LANGUAGES) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    el.target.append(option);
  }

  el.addMode.addEventListener('click', () => openEditor(null));
  el.createMode.addEventListener('click', createMode);
  el.closeMode.addEventListener('click', closeEditor);
  el.deleteMode.addEventListener('click', deleteEditingMode);
  for (const field of [el.modeName, el.modeIcon, el.modePrompt]) {
    field.addEventListener('input', () => {
      if (editing?.key) modeSave.schedule();
    });
    field.addEventListener('change', saveModeEdits);
    field.addEventListener('blur', saveModeEdits);
  }

  el.target.addEventListener('change', saveTarget);
  // A focused select stays focused while its tab is in the background, where the pill can change
  // the target and the render skips it. Focus comes back with the tab.
  el.target.addEventListener('focus', paintTarget);

  // Reset to defaults closes the editor first, saving an edit still waiting for the typing pause.
  return { render, typingSaves: [modeSave], beforeReset: closeEditor };
}
