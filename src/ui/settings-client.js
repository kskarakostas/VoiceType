// Settings client for the trusted extension pages (popup and settings page). Pages save only the
// top-level fields an edit changed, and re-read when storage changes, so a page left open for
// hours never writes its stale copy over newer data from another page or the pill.
import { MSG } from '../shared/messages.js';
import { freshSettings } from '../shared/defaults.js';

/** @typedef {import('../shared/defaults.js').Settings} Settings */

/**
 * A GET_SETTINGS reply that carries full settings (modes and keys), not an error or a public copy.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSettings(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Boolean(value.modes) && typeof value.modes === 'object' && !Array.isArray(value.modes)
    && Boolean(value.keys) && typeof value.keys === 'object';
}

/** Structural equality of plain JSON data; key order inside objects is ignored. */
function sameData(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && sameData(a[k], b[k]));
}

/**
 * The SAVE_SETTINGS patch from one edit: every top-level field of `next` except settingsVersion
 * whose value differs from `previous`, with `keys` reduced to the providers whose key changed.
 * Fields absent from `next` are not reported. Values are `next`'s own objects, not copies.
 * @param {Settings} previous
 * @param {Settings} next
 * @returns {Partial<Settings>}
 */
export function changedFields(previous, next) {
  const patch = {};
  for (const field of Object.keys(next)) {
    if (field === 'settingsVersion' || sameData(previous?.[field], next[field])) continue;
    if (field !== 'keys') {
      patch[field] = next[field];
      continue;
    }
    const keys = Object.fromEntries(Object.entries(next.keys ?? {}).filter(([id, key]) => !sameData(previous?.keys?.[id], key)));
    if (Object.keys(keys).length > 0) patch.keys = keys;
  }
  return patch;
}

/**
 * @param {{ chrome: typeof globalThis.chrome }} env
 */
export function createSettingsClient({ chrome }) {
  /**
   * @param {object} message
   * @returns {Promise<any|null>} the reply, or null when the message could not be sent
   */
  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return null;
    }
  }

  /** @returns {Promise<Settings|null>} full settings, or null when the reply is not settings */
  async function load() {
    const reply = await send({ action: MSG.GET_SETTINGS });
    return isSettings(reply) ? { ...freshSettings(), ...reply } : null;
  }

  /**
   * @param {Partial<Settings>} patch only the fields to change; the router merges them
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async function save(patch) {
    const reply = await send({ action: MSG.SAVE_SETTINGS, settings: patch });
    return reply?.success === true ? { success: true } : { success: false, error: reply?.error };
  }

  /**
   * Change one site's rule. Site rules never go through `save`.
   * @param {{ host: string, hidePill?: boolean, mode?: string|null }} rule a field left out keeps its stored value
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async function saveSiteRule(rule) {
    const reply = await send({ action: MSG.SET_SITE_RULE, ...rule });
    return reply?.success === true ? { success: true } : { success: false, error: reply?.error };
  }

  /**
   * Call `listener` whenever stored settings change (from any page, the pill or the worker).
   * @param {() => void} listener
   * @returns {() => void} unsubscribe
   */
  function onExternalChange(listener) {
    const onChanged = (changes, areaName) => {
      if (areaName === 'local' && Object.hasOwn(changes, 'settings')) listener();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }

  return { send, load, save, saveSiteRule, onExternalChange };
}
