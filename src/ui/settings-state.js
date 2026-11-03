// The save engine both trusted extension pages (popup and settings page) share. It holds the
// page's copy of the settings, saves only the top-level fields an edit changed, puts those fields
// back when a save fails, and re-reads when stored settings change, so a page left open for hours
// never writes its stale copy over newer data from another page or the pill.
import { freshSettings } from '../shared/defaults.js';
import { changedFields } from './settings-client.js';

/** @typedef {import('../shared/defaults.js').Settings} Settings */

const NOT_LOADED = 'Settings are not loaded. Nothing was saved.';
const SAVE_ERROR = 'Could not save settings.';

/**
 * `current` with the fields of `patch` put back to their `snapshot` values; for `keys` only the
 * providers in the patch. Fields other saves changed in the meantime are kept.
 * @param {Settings} current
 * @param {Settings} snapshot
 * @param {Partial<Settings>} patch
 * @returns {Settings}
 */
function restoreFields(current, snapshot, patch) {
  const next = { ...current };
  for (const field of Object.keys(patch)) {
    if (field === 'keys') {
      const keys = { ...next.keys };
      for (const id of Object.keys(patch.keys)) {
        if (Object.hasOwn(snapshot.keys, id)) keys[id] = snapshot.keys[id];
        else delete keys[id];
      }
      next.keys = keys;
    } else if (Object.hasOwn(snapshot, field)) {
      next[field] = snapshot[field];
    } else {
      delete next[field];
    }
  }
  return next;
}

/**
 * @param {{
 *   client: ReturnType<typeof import('./settings-client.js').createSettingsClient>,
 *   render: () => void,
 *   toast: (text: string, tone?: 'info'|'success'|'error') => void,
 * }} env `render` redraws the page from `settings()`; it runs after every change to them
 */
export function createSettingsState({ client, render, toast }) {
  let settings = freshSettings();
  let loaded = false;
  // Saves in flight, saves started so far, and re-reads started so far. A re-read waits for the
  // saves in flight and is dropped when a save started while it ran: its copy may predate it.
  let inFlight = 0;
  let saveCount = 0;
  let readCount = 0;
  let rereadPending = false;
  let loading = true;
  let changedWhileLoading = false;

  /**
   * Apply a change to a copy of the settings, save only the fields it changed, and put those
   * fields back when the save fails.
   * @param {(draft: Settings) => void} mutate
   * @param {string} [successText]
   * @returns {Promise<boolean>}
   */
  async function commit(mutate, successText) {
    const snapshot = structuredClone(settings);
    const draft = structuredClone(settings);
    mutate(draft);
    const patch = changedFields(snapshot, draft);
    if (Object.keys(patch).length === 0) return true;
    if (!loaded) {
      // Never save from fallback settings: that would write blank keys over the real ones.
      render();
      toast(NOT_LOADED, 'error');
      return false;
    }
    settings = draft;
    render();
    inFlight += 1;
    saveCount += 1;
    const result = await client.save(patch);
    inFlight -= 1;
    if (result.success) {
      if (successText) toast(successText, 'success');
    } else {
      settings = restoreFields(settings, snapshot, patch);
      render();
      toast(result.error || SAVE_ERROR, 'error');
    }
    if (inFlight === 0 && rereadPending) {
      rereadPending = false;
      reread();
    }
    return result.success;
  }

  function requestReread() {
    if (inFlight > 0) rereadPending = true;
    else reread();
  }

  // Also runs after the page's own saves; rendering the same settings again changes nothing.
  async function reread() {
    const read = ++readCount;
    const savesBefore = saveCount;
    const fresh = await client.load();
    if (read !== readCount) return;
    if (saveCount !== savesBefore) {
      requestReread();
      return;
    }
    if (!fresh) return;
    settings = fresh;
    render();
  }

  /**
   * Subscribe to external changes, load the settings and render once. Subscribing first means a
   * change while the first read runs is read again after it.
   * @returns {Promise<boolean>} whether the settings loaded
   */
  async function start() {
    client.onExternalChange(() => {
      if (loading) changedWhileLoading = true;
      else if (loaded) requestReread();
    });
    const stored = await client.load();
    loading = false;
    loaded = stored !== null;
    if (loaded) settings = stored;
    render();
    if (loaded && changedWhileLoading) requestReread();
    return loaded;
  }

  return {
    /** @returns {Settings} the page's copy; read it, never mutate it */
    settings: () => settings,
    loaded: () => loaded,
    commit,
    start,
  };
}
