// Pure form helpers shared by the extension pages. No chrome APIs, so every function is testable in isolation.

import { orderedModeKeys } from '../shared/defaults.js';
import { SPOKEN_LANGUAGES } from '../shared/dictionary.js';

const DEFAULT_MODE_ICON = '🎯';

/**
 * Apply one checkbox change to the spoken-language list. Checking 'auto' clears the list;
 * any other code is added or removed and the result follows SPOKEN_LANGUAGES order.
 * @param {string[]} list
 * @param {string} code
 * @param {boolean} checked
 * @returns {string[]}
 */
export function toggleLanguage(list, code, checked) {
  if (code === 'auto') return checked ? [] : [...list];
  const chosen = new Set(list);
  if (checked) chosen.add(code); else chosen.delete(code);
  return SPOKEN_LANGUAGES.map((l) => l.code).filter((c) => chosen.has(c));
}

/**
 * Fill a select with the modes in display order, after a `Use active mode` row of value `''` when
 * `useActive` is set. The options are rebuilt only when the list or a label changed, so an
 * unchanged select keeps its selection; after a rebuild the caller sets the value.
 * @param {HTMLSelectElement} select
 * @param {Record<string, { name: string, icon?: string }>} modes
 * @param {{ useActive?: boolean }} [options]
 */
export function fillModeSelect(select, modes, { useActive = false } = {}) {
  const rows = orderedModeKeys(modes).map((key) => [key, `${modes[key].icon || DEFAULT_MODE_ICON} ${modes[key].name}`]);
  if (useActive) rows.unshift(['', 'Use active mode']);
  const current = [...select.options];
  const same = current.length === rows.length
    && rows.every(([value, text], i) => current[i].value === value && current[i].textContent === text);
  if (same) return;
  select.replaceChildren(...rows.map(([value, text]) => {
    const option = select.ownerDocument.createElement('option');
    option.value = value;
    option.textContent = text;
    return option;
  }));
}

/** A confirming click this soon after arming is part of the same gesture (a double click). */
export const CONFIRM_GUARD_MS = 400;

/**
 * Two-click confirmation on a button, replacing window.confirm() (which can dismiss the popup).
 * The first click swaps the label to `prompt`; a second click within `ms` calls `onConfirm`;
 * otherwise the label reverts. A second click within CONFIRM_GUARD_MS of arming, or one that
 * is part of a multi-click (`detail > 1`), is ignored and the button stays armed, so a double
 * click cannot arm and confirm in one gesture. Auto-repeated Enter and Space keydowns are
 * prevented, so holding a key never produces the confirming click.
 * @param {HTMLButtonElement} button
 * @param {{ prompt?: string, ms?: number, onConfirm: () => unknown,
 *           setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} options
 */
export function createInlineConfirm(button, {
  prompt = 'Click again to confirm', ms = 3000, onConfirm, setTimeout: setTimer, clearTimeout: clearTimer,
}) {
  const label = button.textContent;
  let armed = false;
  let settled = false;
  let timer;
  let guard;

  const disarm = () => {
    armed = false;
    settled = false;
    clearTimer(timer);
    clearTimer(guard);
    button.textContent = label;
    delete button.dataset.confirming;
  };

  button.addEventListener('click', (event) => {
    if (!armed) {
      armed = true;
      button.textContent = prompt;
      button.dataset.confirming = 'true';
      timer = setTimer(disarm, ms);
      guard = setTimer(() => { settled = true; }, CONFIRM_GUARD_MS);
      return;
    }
    if (!settled || event.detail > 1) return;
    disarm();
    onConfirm();
  });

  button.addEventListener('keydown', (event) => {
    if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
  });
}
