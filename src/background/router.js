import { MSG } from '../shared/messages.js';
import { applySettingsPatch, migrateSettings, toPublicSettings, DEFAULT_SETTINGS, SETTINGS_VERSION } from '../shared/defaults.js';
import { PROVIDERS } from '../shared/models.js';
import { emptyLog } from './usage.js';
import { ProviderError, redact } from './providers/errors.js';

/**
 * @typedef {'offscreen'|'extension'|'content'|'unknown'} SenderKind
 * @typedef {{ tabId: number, frameId: number }} Endpoint
 * @typedef {{
 *   start: (endpoint: Endpoint) => Promise<import('../shared/messages.js').StartResponse>,
 *   stop: (endpoint: Endpoint) => Promise<{ ok: boolean }>,
 *   cancel: (endpoint: Endpoint) => Promise<{ ok: boolean }>,
 *   onLevel: (level: number, captureId: string) => void,
 *   onDone: (payload: import('../shared/messages.js').OffscreenDone) => Promise<void>,
 *   onOffscreenError: (payload: import('../shared/messages.js').OffscreenError) => Promise<void>,
 *   onPermissionResult: (payload: { granted: boolean }) => Promise<void>,
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
]);

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

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
  return { tabId: sender.tab.id, frameId: sender.frameId ?? 0 };
}

/**
 * @param {{
 *   storage: ReturnType<import('./storage.js').createStorage>,
 *   validateKey: (provider: string, key: string) => Promise<boolean>,
 *   summarize: typeof import('./usage.js').summarize,
 *   recorder: RecorderPort,
 *   identify: (sender: chrome.runtime.MessageSender|undefined) => SenderKind,
 * }} deps
 * @returns {(request: any, sender: chrome.runtime.MessageSender|undefined) => Promise<any>}
 */
export function createRouter({ storage, validateKey, summarize, recorder, identify }) {
  return async function handle(request, sender) {
    const action = request?.action;
    const allowed = ACCESS.get(action);
    if (!allowed) return undefined;
    const kind = identify(sender);
    if (!allowed.includes(kind)) return { success: false, error: 'Not allowed.' };

    switch (action) {
      case MSG.GET_SETTINGS: {
        const settings = await storage.getSettings();
        return kind === 'extension' ? settings : toPublicSettings(settings);
      }

      case MSG.SAVE_SETTINGS: {
        const next = request.settings;
        if (!isPlainObject(next)) return { success: false, error: 'Invalid settings.' };
        // Merge so a partial payload never drops custom modes or a key the popup did not send.
        await storage.updateSettings((current) => migrateSettings({
          ...current,
          ...pickSettingsFields(next),
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

      case MSG.START_RECORDING:
        return recorder.start(endpointOf(sender));

      case MSG.STOP_RECORDING:
        return recorder.stop(endpointOf(sender));

      case MSG.CANCEL_RECORDING:
        return recorder.cancel(endpointOf(sender));

      case MSG.OFFSCREEN_LEVEL:
        recorder.onLevel(Number(request.level), request.captureId);
        return { ok: true };

      case MSG.OFFSCREEN_DONE: {
        const { audioBase64, mimeType, durationSec, reason, captureId } = request;
        await recorder.onDone({ audioBase64, mimeType, durationSec, reason, captureId });
        return { ok: true };
      }

      case MSG.OFFSCREEN_ERROR:
        await recorder.onOffscreenError({ error: request.error, captureId: request.captureId });
        return { ok: true };

      case MSG.PERMISSION_RESULT:
        await recorder.onPermissionResult({ granted: request.granted === true });
        return { ok: true };

      default:
        return undefined;
    }
  };
}
