// Pure popup form helpers. No chrome APIs, so every function is testable in isolation.

/** Spoken-language hints offered in the popup. `languages: []` in settings means Auto. */
export const SPOKEN_LANGUAGES = Object.freeze([
  { code: 'en', label: 'English' },
  { code: 'el', label: 'Greek' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
].map((entry) => Object.freeze(entry)));

export const MAX_KEYWORDS = 100;

/**
 * Vocabulary textarea to `keywords`: one term per line, trimmed, empty lines dropped,
 * case-insensitive duplicates dropped (first spelling kept), at most MAX_KEYWORDS terms.
 * @param {string} text
 * @returns {string[]}
 */
export function parseKeywords(text) {
  const seen = new Set();
  const terms = [];
  for (const line of String(text ?? '').split(/\r\n|\r|\n/)) {
    const term = line.trim();
    const folded = term.toLowerCase();
    if (!term || seen.has(folded)) continue;
    seen.add(folded);
    terms.push(term);
    if (terms.length === MAX_KEYWORDS) break;
  }
  return terms;
}

/**
 * @param {string[]} list
 * @returns {string}
 */
export function formatKeywords(list) {
  return list.join('\n');
}

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

/** A confirming click this soon after arming is part of the same gesture (a double click). */
export const CONFIRM_GUARD_MS = 400;

/**
 * Two-click confirmation on a button, replacing window.confirm() (which can dismiss the popup).
 * The first click swaps the label to `prompt`; a second click within `ms` calls `onConfirm`;
 * otherwise the label reverts. A second click within CONFIRM_GUARD_MS of arming, or one that
 * is part of a multi-click (`detail > 1`), is ignored and the button stays armed, so a double
 * click cannot arm and confirm in one gesture.
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
}
