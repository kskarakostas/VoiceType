// The sections of the pill's menu. User data (mode names and icons) is only ever set with textContent.
import { formatChord } from '../shared/chord.js';
import { formatCost } from '../shared/pricing.js';
import { PROVIDERS } from '../shared/models.js';
import { TARGET_LANGUAGES, orderedModeKeys } from '../shared/defaults.js';

/**
 * @typedef {import('../shared/messages.js').ContentSettings} ContentSettings
 * @typedef {import('./pill.js').PillUsage} PillUsage
 * @typedef {import('./pill.js').PillRecent} PillRecent
 * @typedef {{ el: (tag: string, className?: string, attrs?: Record<string, string>) => HTMLElement,
 *   icon: (name: string, className?: string) => SVGSVGElement, doc: Document }} MenuHelpers
 */

/** @param {number} value */
const finite = (value) => (Number.isFinite(value) ? value : 0);

/** @param {Window|null} win */
function isMac(win) {
  const nav = win?.navigator;
  return /mac/i.test(nav?.userAgentData?.platform || nav?.platform || '');
}

/**
 * @param {MenuHelpers} helpers
 * @param {{ modes: Record<string, any>, active: string, marked: boolean, activeMode: Record<string, any>|null,
 *   settings: ContentSettings, usage: PillUsage|null, recent: PillRecent|null }} input
 * @returns {Element[]}
 */
export function buildMenuSections(helpers, { modes, active, marked, activeMode, settings, usage, recent }) {
  const sections = [modesSection(helpers, modes, active, marked)];
  if (activeMode?.hasLanguageOption) sections.push(translateSection(helpers, settings.translateTargetLang));
  sections.push(providerSection(helpers, settings));
  // Below the settings: it arrives after the menu opens and must not move one under the pointer.
  if (recent) sections.push(recentSection(helpers, recent));
  sections.push(footerSection(helpers, settings, usage));
  return sections;
}

/**
 * @param {MenuHelpers} helpers
 * @param {Record<string, any>} modes
 * @param {string} active the mode dictation uses here
 * @param {boolean} marked active comes from this site's rule
 */
function modesSection(helpers, modes, active, marked) {
  const { el, icon } = helpers;
  const section = titledSection(helpers, 'Mode');
  const list = el('div', 'list', { role: 'radiogroup', 'aria-label': 'Mode' });
  if (marked) list.append(useActiveItem(helpers));
  for (const key of orderedModeKeys(modes)) {
    const mode = modes[key];
    if (!mode || typeof mode !== 'object') continue;
    const item = el('button', 'item', { type: 'button', role: 'radio', 'aria-checked': String(key === active) });
    item.dataset.mode = key;
    const modeIcon = el('span', 'item-icon', { 'aria-hidden': 'true' });
    modeIcon.textContent = typeof mode.icon === 'string' ? mode.icon : '';
    const name = el('span', 'item-name');
    name.textContent = typeof mode.name === 'string' ? mode.name : key;
    item.append(modeIcon, name);
    if (marked && key === active) {
      const tag = el('span', 'item-tag');
      tag.textContent = 'This site';
      item.append(tag);
    }
    item.append(icon('check', 'item-check'));
    list.append(item);
  }
  section.append(list);
  return section;
}

/** @param {MenuHelpers} helpers */
function useActiveItem({ el }) {
  const item = el('button', 'item', { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-use-active': '' });
  const name = el('span', 'item-name');
  name.textContent = 'Use active mode';
  item.append(el('span', 'item-icon', { 'aria-hidden': 'true' }), name);
  return item;
}

/** @param {MenuHelpers} helpers */
function translateSection(helpers, current) {
  const { el } = helpers;
  const section = titledSection(helpers, 'Translate to', 'globe');
  const row = el('div', 'seg', { role: 'radiogroup', 'aria-label': 'Translate to' });
  for (const { code, name } of TARGET_LANGUAGES) {
    const chip = el('button', 'chip', { type: 'button', role: 'radio', 'aria-checked': String(current === name), 'aria-label': name, title: name });
    chip.dataset.lang = name;
    chip.textContent = code;
    row.append(chip);
  }
  section.append(row);
  return section;
}

/** @param {MenuHelpers} helpers */
function providerSection(helpers, settings) {
  const { el } = helpers;
  const section = titledSection(helpers, 'Provider');
  const row = el('div', 'seg', { role: 'radiogroup', 'aria-label': 'Provider' });
  const hasKey = settings.hasKey && typeof settings.hasKey === 'object' ? settings.hasKey : {};
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    const chip = el('button', 'chip', { type: 'button', role: 'radio', 'aria-checked': String(settings.provider === id) });
    chip.dataset.provider = id;
    const name = el('span', 'chip-name');
    name.textContent = provider.label;
    chip.append(name);
    if (hasKey[id] !== true) {
      const hint = el('span', 'chip-hint');
      hint.textContent = 'no key';
      chip.append(hint);
    }
    row.append(chip);
  }
  section.append(row);
  return section;
}

/**
 * @param {MenuHelpers} helpers
 * @param {PillRecent} recent
 */
function recentSection(helpers, { refined }) {
  const { el } = helpers;
  const section = titledSection(helpers, 'Last dictation');
  const row = el('div', 'seg', { role: 'group', 'aria-label': 'Last dictation' });
  const actions = [['insert', 'Insert'], ['copy', 'Copy']];
  if (refined) actions.push(['undo', 'Undo AI edit']);
  for (const [action, name] of actions) {
    const chip = el('button', 'chip chip-action', { type: 'button' });
    chip.dataset.history = action;
    chip.textContent = name;
    row.append(chip);
  }
  section.append(row);
  return section;
}

/** @param {MenuHelpers} helpers */
function footerSection({ el, doc }, settings, usage) {
  const section = el('div', 'section footer');
  if (usage && typeof usage === 'object') {
    const line = el('p', 'usage');
    line.textContent = `Today ${formatCost(finite(usage.todayCost))} (${finite(usage.todaySessions)}), all time ${formatCost(finite(usage.totalCost))}`;
    section.append(line);
  }
  const hotkey = settings.hotkey;
  if (hotkey && typeof hotkey === 'object' && typeof hotkey.code === 'string') {
    const hint = el('p', 'hint');
    const keys = el('kbd');
    keys.textContent = formatChord(hotkey, { mac: isMac(doc.defaultView) });
    const text = el('span');
    text.textContent = 'tap to toggle, hold to talk';
    hint.append(keys, text);
    section.append(hint);
  }
  return section;
}

/** @param {MenuHelpers} helpers */
function titledSection({ el, icon }, title, iconName) {
  const section = el('div', 'section');
  const label = el('p', 'label');
  if (iconName) label.append(icon(iconName));
  label.append(title);
  section.append(label);
  return section;
}
