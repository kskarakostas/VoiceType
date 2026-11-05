import { MSG } from '../shared/messages.js';
import { applySettingsPatch, migrateSettings, toPublicSettings, DEFAULT_SETTINGS, MAX_EDIT_CHARS, SETTINGS_VERSION } from '../shared/defaults.js';
import { PROVIDERS } from '../shared/models.js';
import { ruleFor, siteKey, withSiteRule } from '../shared/sites.js';
import { emptyLog } from './usage.js';
import { ProviderError, redact } from './providers/errors.js';

/**
 * @typedef {'offscreen'|'extension'|'content'|'unknown'} SenderKind
 * @typedef {{ tabId: number, frameId: number, documentId?: string }} Endpoint
 * @typedef {{
 *   start: (endpoint: Endpoint, tabUrl?: string, site?: { host?: string|null, incognito?: boolean, editText?: string|null }) => Promise<import('../shared/messages.js').StartResponse>,
 *   stop: (endpoint: Endpoint) => Promise<{ ok: boolean }>,
 *   cancel: (endpoint: Endpoint) => Promise<{ ok: boolean }>,
 *   onLevel: (level: number, captureId: string) => void,
 *   onDone: (payload: import('../shared/messages.js').OffscreenDone) => Promise<void>,
 *   onOffscreenError: (payload: import('../shared/messages.js').OffscreenError) => Promise<void>,
 *   onPermissionResult: (payload: { granted: boolean }) => Promise<void>,
 *   onFrameSight: (endpoint: Endpoint, seen: boolean) => void,
 *   ping: (endpoint: Endpoint) => Promise<{ alive: boolean }>,
 *   sweep: () => Promise<void>,
 * }} RecorderPort
 */

/**
 * Turn any thrown value into text safe to show on a web page.
 * @param {unknown} err
 * @param {{ context?: 'validate' }} [options] 'validate' words timeouts for the popup key check.
 */
export function userMessage(err, { context } = {}) {
  if (err && typeof err === 'object') {
    const e = /** @type {{ name?: string, message?: string }} */ (err);
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return context === 'validate' ? 'Key check timed out. Try again.' : 'Request timed out. Try a shorter recording.';
    }
    if (e.name === 'ProviderError') return String(e.message);
    // fetch() rejects with a TypeError on network failure; other TypeErrors are bugs.
    if (err instanceof TypeError && /fetch|network/i.test(err.message)) return 'Network error. Check your connection.';
  }
  return 'Something went wrong. Try again.';
}

/**
 * Log a failure for debugging without ever writing a key to the console.
 * @param {unknown} err
 */
export function warnFailure(err) {
  const e = /** @type {{ name?: string, message?: string }} */ (err);
  console.warn('VoiceType: ' + redact(e?.name + ': ' + e?.message));
}

/**
 * Classify a runtime.onMessage sender. Content scripts report the page's origin, so only the
 * extension's own origin marks a trusted page; sender.tab alone proves nothing (the permission
 * page runs in a tab).
 * @param {chrome.runtime.MessageSender|undefined} sender
 * @param {{ extensionId: string, extensionOrigin: string, offscreenUrl: string }} ids
 * @returns {SenderKind}
 */
export function senderKind(sender, { extensionId, extensionOrigin, offscreenUrl }) {
  if (!sender || sender.id !== extensionId) return 'unknown';
  if (sender.origin === extensionOrigin) {
    return typeof sender.url === 'string' && sender.url.startsWith(offscreenUrl) ? 'offscreen' : 'extension';
  }
  return typeof sender.tab?.id === 'number' ? 'content' : 'unknown';
}

/**
 * Key check with an own-property provider lookup, so 'constructor' is an unknown provider.
 * @param {Record<string, { validateKey: (args: { key: string, signal: AbortSignal }) => Promise<boolean> }>} adapters
 * @param {{ timeoutMs?: number }} [options]
 * @returns {(provider: string, key: string) => Promise<boolean>}
 */
export function createValidateKey(adapters, { timeoutMs = 15_000 } = {}) {
  return async (provider, key) => {
    if (typeof provider !== 'string' || !Object.hasOwn(adapters, provider)) {
      throw new ProviderError('Unknown provider.', { code: 'bad_request' });
    }
    return adapters[provider].validateKey({ key, signal: AbortSignal.timeout(timeoutMs) });
  };
}

/** Who may send each request (the Message contract). Anything else is not a router action. */
const ACCESS = new Map([
  [MSG.GET_SETTINGS, ['extension', 'content']],
  [MSG.SAVE_SETTINGS, ['extension']],
  [MSG.UPDATE_SETTINGS, ['extension', 'content']],
  [MSG.VALIDATE_KEY, ['extension']],
  [MSG.GET_USAGE, ['extension', 'content']],
  [MSG.CLEAR_USAGE, ['extension']],
  [MSG.START_RECORDING, ['content']],
  [MSG.STOP_RECORDING, ['content']],
  [MSG.CANCEL_RECORDING, ['content']],
  [MSG.OFFSCREEN_LEVEL, ['offscreen']],
  [MSG.OFFSCREEN_DONE, ['offscreen']],
  [MSG.OFFSCREEN_ERROR, ['offscreen']],
  [MSG.PERMISSION_RESULT, ['extension']],
  [MSG.SET_SITE_MODE, ['content']],
  [MSG.SET_SITE_RULE, ['extension']],
  [MSG.FRAME_SIGHT, ['content']],
  [MSG.GET_LAST_DICTATION, ['content']],
  [MSG.GET_HISTORY, ['extension']],
  [MSG.CLEAR_HISTORY, ['extension']],
  [MSG.PROCESSING_PING, ['content']],
]);

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** The `edit` of a START_RECORDING, as V44 takes it. The reply never names the text. */
const isValidEdit = (edit) => typeof edit?.text === 'string' && edit.text.length > 0 && edit.text.length <= MAX_EDIT_CHARS;

/** Own payload fields that name a settings field; anything else is dropped, never stored. */
function pickSettingsFields(settings) {
  const out = {};
  for (const field of Object.keys(DEFAULT_SETTINGS)) if (Object.hasOwn(settings, field)) out[field] = settings[field];
  return out;
}

/** String keys for known providers only; anything else leaves the stored key alone. */
function pickKeys(keys) {
  const out = {};
  if (!isPlainObject(keys)) return out;
  for (const id of Object.keys(PROVIDERS)) if (Object.hasOwn(keys, id) && typeof keys[id] === 'string') out[id] = keys[id];
  return out;
}

/**
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Endpoint}
 */
function endpointOf(sender) {
  return { tabId: sender.tab.id, frameId: sender.frameId ?? 0, documentId: sender.documentId };
}

/**
 * The site of the frame that sent this (V26): the top page's site key when the frame's origin has
 * that same key, else null. `tab.url` alone is the top page for every frame, and a third-party frame
 * must not count as it. `origin`, not `url`: an about:blank editor inherits its creator's origin.
 * @param {chrome.runtime.MessageSender} sender
 * @returns {string|null}
 */
function frameSite(sender) {
  const site = siteKey(sender.tab?.url);
  // An opaque origin is the string 'null', which siteKey reads as a host.
  return sender.origin !== 'null' && siteKey(sender.origin) === site ? site : null;
}

/**
 * Set one site's rule. Runs inside the settings queue, so the rule is built from the stored settings
 * and `mode` is checked against the stored modes.
 * @param {ReturnType<import('./storage.js').createStorage>} storage
 * @param {string} host A site key.
 * @param {(current: import('../shared/defaults.js').Settings) => { hidePill: boolean, mode: unknown }} ruleOf
 *   `mode` is null or an own key of `modes`; `withSiteRule` must never see anything else.
 * @returns {Promise<{ success: true } | { success: false, error: string }>}
 */
async function saveSiteRule(storage, host, ruleOf) {
  let error = null;
  await storage.updateSettings((current) => {
    const { hidePill, mode } = ruleOf(current);
    if (mode !== null && (typeof mode !== 'string' || !Object.hasOwn(current.modes, mode))) {
      error = 'Invalid settings.';
      return null;
    }
    return { ...current, siteRules: withSiteRule(current.siteRules, host, { hidePill, mode }) };
  });
  return error === null ? { success: true } : { success: false, error };
}

/**
 * @param {{
 *   storage: ReturnType<import('./storage.js').createStorage>,
 *   validateKey: (provider: string, key: string) => Promise<boolean>,
 *   summarize: typeof import('./usage.js').summarize,
 *   recorder: RecorderPort,
 *   history: Pick<ReturnType<import('./history.js').createHistory>, 'list'|'lastFor'|'clear'>,
 *   identify: (sender: chrome.runtime.MessageSender|undefined) => SenderKind,
 * }} deps
 * @returns {(request: any, sender: chrome.runtime.MessageSender|undefined) => Promise<any>}
 */
export function createRouter({ storage, validateKey, summarize, recorder, history, identify }) {
  return async function handle(request, sender) {
    recorder.sweep();
    const action = request?.action;
    const allowed = ACCESS.get(action);
    if (!allowed) return undefined;
    const kind = identify(sender);
    if (!allowed.includes(kind)) return { success: false, error: 'Not allowed.' };

    switch (action) {
      case MSG.GET_SETTINGS: {
        const settings = await storage.getSettings();
        return kind === 'extension' ? settings : { ...toPublicSettings(settings), site: ruleFor(settings, sender.tab?.url) };
      }

      case MSG.SAVE_SETTINGS: {
        const next = request.settings;
        if (!isPlainObject(next)) return { success: false, error: 'Invalid settings.' };
        // Merge so a partial payload never drops custom modes or a key the popup did not send.
        // Site rules change only through SET_SITE_MODE and SET_SITE_RULE, so an old tab cannot
        // overwrite newer ones; migrateSettings still repairs them when a custom mode goes.
        await storage.updateSettings((current) => migrateSettings({
          ...current,
          ...pickSettingsFields(next),
          siteRules: current.siteRules,
          settingsVersion: SETTINGS_VERSION,
          keys: { ...current.keys, ...pickKeys(next.keys) },
        }));
        return { success: true };
      }

      case MSG.UPDATE_SETTINGS: {
        let error = null;
        await storage.updateSettings((current) => {
          const result = applySettingsPatch(current, request.patch);
          if (result.ok) return result.settings;
          error = result.error;
          return null;
        });
        return error === null ? { success: true } : { success: false, error };
      }

      case MSG.SET_SITE_MODE: {
        const url = sender.tab?.url;
        const host = siteKey(url);
        if (host === null) return { success: false, error: 'Not available on this page.' };
        return saveSiteRule(storage, host, (current) => ({ hidePill: ruleFor(current, url).hidePill, mode: request.mode }));
      }

      case MSG.SET_SITE_RULE: {
        const { hidePill, mode } = request;
        const host = siteKey(request.host);
        const valid = typeof hidePill === 'boolean' || (hidePill === undefined && mode !== undefined);
        if (host === null || !valid) return { success: false, error: 'Invalid settings.' };
        // A field left out keeps the stored value: only the queue knows it, as a control can be stale (V18).
        return saveSiteRule(storage, host, ({ siteRules }) => {
          const stored = Object.hasOwn(siteRules, host) ? siteRules[host] : { hidePill: false, mode: null };
          return { hidePill: hidePill ?? stored.hidePill, mode: mode === undefined ? stored.mode : mode };
        });
      }

      case MSG.VALIDATE_KEY:
        try {
          await validateKey(request.provider, request.key);
          return { ok: true };
        } catch (err) {
          warnFailure(err);
          return { ok: false, error: userMessage(err, { context: 'validate' }) };
        }

      case MSG.GET_USAGE:
        return summarize(await storage.getUsageLog());

      case MSG.CLEAR_USAGE:
        await storage.setUsageLog(emptyLog());
        return { success: true };

      case MSG.GET_LAST_DICTATION: {
        // The site comes from the sender, never the request: a frame reads its own site alone (V28).
        const entry = await history.lastFor(frameSite(sender));
        return { entry: entry && { raw: entry.raw, text: entry.text, edit: entry.edit } };
      }

      case MSG.GET_HISTORY:
        return { entries: await history.list() };

      case MSG.CLEAR_HISTORY:
        await history.clear();
        return { success: true };

      case MSG.START_RECORDING:
        if (request.edit !== undefined && !isValidEdit(request.edit)) return { ok: false, reason: 'badEdit', error: 'Could not read the selection.' };
        return recorder.start(endpointOf(sender), sender.tab?.url, { host: frameSite(sender), incognito: sender.tab?.incognito === true, editText: request.edit?.text });

      case MSG.STOP_RECORDING:
        return recorder.stop(endpointOf(sender));

      case MSG.CANCEL_RECORDING:
        return recorder.cancel(endpointOf(sender));

      case MSG.PROCESSING_PING:
        return recorder.ping(endpointOf(sender));

      case MSG.OFFSCREEN_LEVEL:
        recorder.onLevel(Number(request.level), request.captureId);
        return { ok: true };

      case MSG.OFFSCREEN_DONE: {
        const { audioBase64, mimeType, durationSec, reason, captureId } = request;
        await recorder.onDone({ audioBase64, mimeType, durationSec, reason, captureId });
        return { ok: true };
      }

      case MSG.OFFSCREEN_ERROR:
        await recorder.onOffscreenError({ error: request.error, captureId: request.captureId, empty: request.empty, durationSec: request.durationSec });
        return { ok: true };

      case MSG.PERMISSION_RESULT:
        await recorder.onPermissionResult({ granted: request.granted === true });
        return { ok: true };

      case MSG.FRAME_SIGHT:
        recorder.onFrameSight(endpointOf(sender), request.seen === true);
        return { ok: true };

      default:
        return undefined;
    }
  };
}
