// The single recording session. The offscreen document captures audio; this module decides who
// may record, relays levels and results to the exact frame that asked, and frees the session on
// every path so a closed tab or a lost frame never leaves the microphone on or the next start busy.
import { MSG } from '../shared/messages.js';

const BUSY = 'VoiceType is busy in another tab. Try again in a moment.';
const NO_KEY = 'Add an API key in the VoiceType popup.';
const NEEDS_PERMISSION = 'Allow the microphone in the VoiceType tab that just opened, then press REC again.';
const DENIED = 'Microphone blocked for VoiceType. Allow it at chrome://settings/content/microphone.';
const MIC_ERROR = 'Could not start the microphone.';
const CANCELLED = 'Recording cancelled.';
const FAILED_NOTICE = Object.freeze({ text: 'Recording failed. Try again.', tone: 'error' });

/**
 * @typedef {{ tabId: number, frameId: number }} Endpoint
 * @typedef {{ endpoint: Endpoint, state: 'starting'|'recording'|'processing', modeKey: string, minSec: number }} Session
 * Internally a session also holds the id of its offscreen capture: reports that name any other
 * capture are stale (a cancelled recording finishing late) and are dropped.
 * @typedef {import('../shared/messages.js').StartResponse} StartResponse
 */

/**
 * @param {{
 *   ensureOffscreen: () => Promise<void>,
 *   toOffscreen: (message: object) => Promise<any>,
 *   toTab: (endpoint: Endpoint, message: object) => Promise<boolean>,
 *   openPermissionPage: () => Promise<void>,
 *   getSettings: () => Promise<import('../shared/defaults.js').Settings>,
 *   dictate: (input: { audioBase64: string, mimeType: string, modeKey: string, durationSec: number }) => Promise<import('../shared/messages.js').DictationMessage>,
 * }} deps
 */
export function createRecorder({ ensureOffscreen, toOffscreen, toTab, openPermissionPage, getSettings, dictate }) {
  /** @type {null | (Session & { captureId: string, stopRequested: boolean, starting: Promise<StartResponse>|null })} */
  let session = null;
  /** @type {Endpoint|null} */
  let pendingPermission = null;

  const fail = (reason, error) => ({ ok: false, reason, error });
  const owns = (endpoint) => session !== null
    && session.endpoint.tabId === endpoint.tabId && session.endpoint.frameId === endpoint.frameId;
  /** The current session, when this offscreen report came from its capture. */
  const reporter = (captureId) => (session !== null && captureId === session.captureId ? session : null);

  /** Stop a capture without a result. The microphone is released; errors are irrelevant here. */
  async function discard(captureId) {
    try {
      await toOffscreen({ action: MSG.OFFSCREEN_STOP, discard: true, captureId });
    } catch {
      // No offscreen document means no capture to stop.
    }
  }

  /**
   * Free a session that will produce no result. The offscreen document also aborts a start that
   * is still opening the microphone when this stop arrives, so it covers every state.
   */
  async function drop(s) {
    if (session !== s) return;
    session = null;
    await discard(s.captureId);
  }

  /** Free the session and tell its frame that the recording failed. */
  async function failSession(s) {
    if (session !== s) return;
    session = null;
    await toTab(s.endpoint, { action: MSG.RECORDING_STATE, state: 'idle', reason: 'error', notice: FAILED_NOTICE });
  }

  /** Ask the offscreen document for the audio; it arrives as OFFSCREEN_DONE. */
  async function finish(s) {
    s.state = 'processing';
    try {
      await toOffscreen({ action: MSG.OFFSCREEN_STOP, discard: false, captureId: s.captureId });
    } catch {
      // The offscreen document is gone, so no audio will ever arrive.
      await failSession(s);
    }
  }

  /** @returns {Promise<StartResponse>} */
  async function begin(s) {
    let settings;
    try {
      settings = await getSettings();
    } catch {
      settings = null;
    }
    if (session !== s) return fail('micError', CANCELLED);
    if (!settings) {
      session = null;
      return fail('micError', MIC_ERROR);
    }
    const key = settings.keys?.[settings.provider];
    if (typeof key !== 'string' || !key.trim()) {
      session = null;
      return fail('noKey', NO_KEY);
    }
    s.modeKey = settings.activeMode;
    s.minSec = settings.minRecordingTime;

    let reply = null;
    try {
      await ensureOffscreen();
      if (session === s) {
        reply = await toOffscreen({
          action: MSG.OFFSCREEN_START, maxSec: settings.maxRecordingTime, silenceSec: settings.autoStopSilenceSec, captureId: s.captureId,
        });
      }
    } catch {
      reply = null;
    }
    // Freed while starting (CANCEL, tab closed). This late reply must not touch a newer session or
    // open the permission page. drop() may have reached the offscreen document before the capture
    // came up, so a capture that did come up is stopped by its id: nothing keeps the microphone.
    if (session !== s) {
      if (reply?.ok) await discard(s.captureId);
      return fail('micError', CANCELLED);
    }
    if (reply?.ok) {
      s.state = 'recording';
      if (s.stopRequested) await finish(s);
      return { ok: true };
    }
    session = null;
    if (reply?.reason === 'needsPermission') {
      pendingPermission = s.endpoint;
      try {
        await openPermissionPage();
      } catch {
        // The start response still tells the user what to do.
      }
      return fail('needsPermission', NEEDS_PERMISSION);
    }
    if (reply?.reason === 'denied') return fail('denied', DENIED);
    return fail('micError', typeof reply?.error === 'string' && reply.error ? reply.error : MIC_ERROR);
  }

  return {
    /**
     * @param {Endpoint} endpoint
     * @returns {Promise<StartResponse>}
     */
    async start(endpoint) {
      if (session) {
        if (!owns(endpoint) || session.state === 'processing') return fail('busy', BUSY);
        // The same frame asked again: recording already, or share the start in flight.
        return session.state === 'recording' ? { ok: true } : session.starting;
      }
      // Reserve synchronously so a start from another frame during the awaits below is busy.
      const s = {
        endpoint: { ...endpoint }, state: 'starting', modeKey: 'default', minSec: 0,
        captureId: crypto.randomUUID(), stopRequested: false, starting: null,
      };
      session = s;
      s.starting = begin(s);
      return s.starting;
    },

    /**
     * @param {Endpoint} endpoint
     * @returns {Promise<{ ok: boolean }>}
     */
    async stop(endpoint) {
      if (!owns(endpoint)) return { ok: false };
      const s = session;
      if (s.state === 'starting') s.stopRequested = true;
      else if (s.state === 'recording') await finish(s);
      return { ok: true };
    },

    /**
     * @param {Endpoint} endpoint
     * @returns {Promise<{ ok: boolean }>}
     */
    async cancel(endpoint) {
      if (!owns(endpoint)) return { ok: false };
      await drop(session);
      return { ok: true };
    },

    /**
     * @param {number} level
     * @param {string} captureId
     */
    onLevel(level, captureId) {
      const s = reporter(captureId);
      if (!s || s.state !== 'recording') return;
      toTab(s.endpoint, { action: MSG.AUDIO_LEVEL, level }).then((delivered) => {
        // No receiver: the frame navigated or closed, so nobody is left to stop this recording.
        if (!delivered && session === s && s.state === 'recording') return drop(s);
      }, () => {});
    },

    /** @param {import('../shared/messages.js').OffscreenDone} payload */
    async onDone(payload) {
      const s = reporter(payload?.captureId);
      if (!s) return;
      if (payload?.reason !== 'user') {
        s.state = 'processing';
        const delivered = await toTab(s.endpoint, { action: MSG.RECORDING_STATE, state: 'processing', reason: payload?.reason });
        if (!delivered && session === s) session = null;
        if (session !== s) return; // the frame is gone or the owner cancelled: no provider call
      }
      s.state = 'processing';
      const durationSec = Number(payload?.durationSec) || 0;
      /** @type {import('../shared/messages.js').DictationMessage} */
      let message;
      if (durationSec < s.minSec) {
        message = { success: false, error: 'Too short, ignored', tone: 'warning' };
      } else {
        try {
          message = await dictate({ audioBase64: payload.audioBase64, mimeType: payload.mimeType, modeKey: s.modeKey, durationSec });
        } catch {
          message = { success: false, error: 'Something went wrong. Try again.', tone: 'error' };
        }
      }
      if (session === s) session = null;
      await toTab(s.endpoint, { action: MSG.DICTATION_RESULT, ...message });
    },

    /** @param {{ error?: string, captureId?: string }} payload */
    async onOffscreenError(payload) {
      const s = reporter(payload?.captureId);
      if (s) await failSession(s);
    },

    /** @param {{ granted: boolean }} payload */
    async onPermissionResult({ granted }) {
      const endpoint = pendingPermission;
      if (!endpoint) return;
      pendingPermission = null;
      const notice = granted
        ? { text: 'Microphone allowed. Press REC again.', tone: 'success' }
        : { text: 'Microphone not allowed.', tone: 'error' };
      await toTab(endpoint, { action: MSG.RECORDING_STATE, state: 'idle', reason: 'permission', notice });
    },

    /** @param {number} tabId */
    async onTabRemoved(tabId) {
      if (pendingPermission?.tabId === tabId) pendingPermission = null;
      const s = session;
      // A processing session finishes; its result is simply undeliverable.
      if (s && s.endpoint.tabId === tabId && s.state !== 'processing') await drop(s);
    },

    /** @returns {Session|null} */
    get session() {
      if (!session) return null;
      const { endpoint, state, modeKey, minSec } = session;
      return { endpoint: { ...endpoint }, state, modeKey, minSec };
    },
  };
}
