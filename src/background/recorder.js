// The single recording session. The offscreen document captures audio; this module decides who
// may record, relays levels and results to the exact frame that asked, and frees the session on
// every path so a closed tab or a lost frame never leaves the microphone on or the next start busy.
import { MSG } from '../shared/messages.js';
import { ruleFor } from '../shared/sites.js';

const BUSY = 'VoiceType is busy in another tab. Try again in a moment.';
const IN_OTHER_FIELD = 'VoiceType is recording in another field of this page. Click back into it to stop.';
const STILL_WORKING = 'VoiceType is still working on this page. Try again in a moment.';
const NO_KEY = 'Add an API key in VoiceType settings.';
const NEEDS_PERMISSION = 'Allow the microphone in the VoiceType tab that just opened, then try again.';
const DENIED = 'Microphone blocked for VoiceType. Allow it at chrome://settings/content/microphone.';
const MIC_ERROR = 'Could not start the microphone.';
const CANCELLED = 'Recording cancelled.';
const FAILED_NOTICE = Object.freeze({ text: 'Recording failed. Try again.', tone: 'error' });
const TOO_SHORT = Object.freeze({ success: false, error: 'Too short, ignored', tone: 'warning' });
export const COPY_TIMEOUT_MS = 1000;

/**
 * @typedef {{ tabId: number, frameId: number }} Endpoint
 * @typedef {{ endpoint: Endpoint, state: 'starting'|'recording'|'processing', modeKey: string, minSec: number }} Session
 * Internally a session also holds the id of its offscreen capture: reports that name any other
 * capture are stale (a cancelled recording finishing late) and are dropped. It also holds the
 * `sounds` and `alwaysCopy` settings, read once at start, `liveAt`, when the recording went live,
 * `unseen`: its frame reported the indicator out of sight, so frame 0 is mirroring it,
 * `mirrorLost`: frame 0 had no receiver for the last mirror message, and `host` and `incognito`,
 * for the history: the frame's site as the router worked it out (V26), and whether the tab is incognito.
 * @typedef {import('../shared/messages.js').StartResponse} StartResponse
 */

/**
 * @param {{
 *   ensureOffscreen: () => Promise<void>,
 *   toOffscreen: (message: object) => Promise<any>,
 *   toTab: (endpoint: Endpoint, message: object) => Promise<boolean>,
 *   openPermissionPage: () => Promise<void>,
 *   getSettings: () => Promise<import('../shared/defaults.js').Settings>,
 *   dictate: (input: { audioBase64: string, mimeType: string, modeKey: string, durationSec: number, host: string|null, incognito: boolean }) => Promise<import('../shared/messages.js').DictationMessage>,
 * }} deps
 */
export function createRecorder({ ensureOffscreen, toOffscreen, toTab, openPermissionPage, getSettings, dictate }) {
  /** @type {null | (Session & { captureId: string, stopRequested: boolean, starting: Promise<StartResponse>|null, sounds: boolean, alwaysCopy: boolean, unseen: boolean, mirrorLost: boolean, liveAt: number, host: string|null, incognito: boolean })} */
  let session = null;
  /** @type {Endpoint|null} */
  let pendingPermission = null;

  const fail = (reason, error) => ({ ok: false, reason, error });
  const owns = (endpoint) => session !== null
    && session.endpoint.tabId === endpoint.tabId && session.endpoint.frameId === endpoint.frameId;
  /** What a refused start hears: the session may be on this very page. Only another frame is refused while it records. */
  const refusal = ({ tabId }) => {
    if (tabId !== session.endpoint.tabId) return BUSY;
    return session.state === 'processing' ? STILL_WORKING : IN_OTHER_FIELD;
  };
  /** The current session, when this offscreen report came from its capture. */
  const reporter = (captureId) => (session !== null && captureId === session.captureId ? session : null);

  const topOf = (s) => ({ tabId: s.endpoint.tabId, frameId: 0 });

  /**
   * Tell frame 0 what to show for this session. The mirror never decides a session, and a page still
   * loading has no receiver yet: mirrorLost has onLevel send it again.
   */
  function mirror(s, state) {
    toTab(topOf(s), { action: MSG.RECORDING_MIRROR, state, elapsedMs: Date.now() - s.liveAt })
      .then((delivered) => { s.mirrorLost = !delivered; }, () => {});
  }

  /** End a session that reached recording: every such exit comes through here, so a mirror goes with it. */
  function free(s) {
    if (session === s) session = null;
    if (!s.unseen) return;
    s.unseen = false;
    mirror(s, 'idle');
  }

  /** Play a cue when the session has sounds on. Fire and forget: a cue never delays or fails a dictation. */
  function cue(s, name) {
    if (!s.sounds) return;
    ensureOffscreen().then(() => toOffscreen({ action: MSG.OFFSCREEN_CUE, cue: name })).catch(() => {});
  }

  /**
   * Copy a result, waiting at most COPY_TIMEOUT_MS: a stuck copy never holds back a paid transcript.
   * @param {string} text
   * @returns {Promise<boolean>} True only when the offscreen document confirmed the copy.
   */
  async function copyResult(text) {
    let timer;
    const expired = new Promise((resolve) => { timer = setTimeout(resolve, COPY_TIMEOUT_MS, false); });
    const copied = ensureOffscreen()
      .then(() => toOffscreen({ action: MSG.OFFSCREEN_COPY, text }))
      .then((reply) => reply?.ok === true, () => false);
    const result = await Promise.race([copied, expired]);
    clearTimeout(timer);
    return result;
  }

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
    free(s);
    await discard(s.captureId);
  }

  /** Free the session and tell its frame that the recording failed. */
  async function failSession(s) {
    if (session !== s) return;
    free(s);
    cue(s, 'error');
    await toTab(s.endpoint, { action: MSG.RECORDING_STATE, state: 'idle', reason: 'error', notice: FAILED_NOTICE });
  }

  /** Ask the offscreen document for the audio; it arrives as OFFSCREEN_DONE. */
  async function finish(s) {
    s.state = 'processing';
    if (s.unseen) mirror(s, 'processing');
    try {
      await toOffscreen({ action: MSG.OFFSCREEN_STOP, discard: false, captureId: s.captureId });
    } catch {
      // The offscreen document is gone, so no audio will ever arrive.
      await failSession(s);
    }
  }

  /**
   * @param {NonNullable<typeof session>} s
   * @param {string} [tabUrl]
   * @returns {Promise<StartResponse>}
   */
  async function begin(s, tabUrl) {
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
    s.modeKey = ruleFor(settings, tabUrl).mode ?? settings.activeMode;
    s.minSec = settings.minRecordingTime;
    s.sounds = settings.sounds === true;
    s.alwaysCopy = settings.alwaysCopy === true;

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
      s.liveAt = Date.now();
      if (s.stopRequested) await finish(s);
      else cue(s, 'start');
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
    if (reply?.cancelled !== true) cue(s, 'error');
    if (reply?.reason === 'denied') return fail('denied', DENIED);
    return fail('micError', typeof reply?.error === 'string' && reply.error ? reply.error : MIC_ERROR);
  }

  return {
    /**
     * @param {Endpoint} endpoint
     * @param {string} [tabUrl] The top-level page; its site rule can fix the session's mode.
     * @param {{ host?: string|null, incognito?: boolean }} [site] For the history; `host` is the frame's site, not the page's.
     * @returns {Promise<StartResponse>}
     */
    async start(endpoint, tabUrl, { host = null, incognito = false } = {}) {
      if (session) {
        if (!owns(endpoint) || session.state === 'processing') return fail('busy', refusal(endpoint));
        // The same frame asked again: recording already, or share the start in flight.
        return session.state === 'recording' ? { ok: true } : session.starting;
      }
      // Reserve synchronously so a start from another frame during the awaits below is busy.
      const s = {
        endpoint: { ...endpoint }, state: 'starting', modeKey: 'default', minSec: 0,
        captureId: crypto.randomUUID(), stopRequested: false, starting: null, sounds: false, alwaysCopy: false,
        unseen: false, mirrorLost: false, liveAt: 0, host, incognito,
      };
      session = s;
      s.starting = begin(s, tabUrl);
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
      if (!s.unseen) return;
      if (s.mirrorLost) mirror(s, 'recording');
      else toTab(topOf(s), { action: MSG.AUDIO_LEVEL, level }).catch(() => {});
    },

    /**
     * A frame cannot draw outside itself: while its indicator is out of sight, frame 0 shows one.
     * @param {Endpoint} endpoint
     * @param {boolean} seen
     */
    onFrameSight(endpoint, seen) {
      if (!owns(endpoint) || endpoint.frameId === 0) return;
      const s = session;
      if (s.state === 'starting' || s.unseen !== seen) return;
      s.unseen = !seen;
      mirror(s, seen ? 'idle' : s.state);
    },

    /** @param {import('../shared/messages.js').OffscreenDone} payload */
    async onDone(payload) {
      const s = reporter(payload?.captureId);
      if (!s) return;
      if (payload?.reason !== 'user') {
        s.state = 'processing';
        if (s.unseen) mirror(s, 'processing');
        const delivered = await toTab(s.endpoint, { action: MSG.RECORDING_STATE, state: 'processing', reason: payload?.reason });
        if (!delivered && session === s) free(s);
        if (session !== s) return; // the frame is gone or the owner cancelled: no provider call
      }
      s.state = 'processing';
      const durationSec = Number(payload?.durationSec) || 0;
      /** @type {import('../shared/messages.js').DictationMessage} */
      let message;
      if (durationSec < s.minSec) {
        message = TOO_SHORT;
      } else {
        cue(s, 'stop');
        try {
          message = await dictate({ audioBase64: payload.audioBase64, mimeType: payload.mimeType, modeKey: s.modeKey, durationSec, host: s.host, incognito: s.incognito });
        } catch {
          message = { success: false, error: 'Something went wrong. Try again.', tone: 'error' };
        }
        const live = session === s;
        if (live) cue(s, message.success ? 'done' : 'error');
        if (message.success) {
          message = { ...message, copied: live && s.alwaysCopy ? await copyResult(message.text) : null };
        }
      }
      free(s);
      const delivered = await toTab(s.endpoint, { action: MSG.DICTATION_RESULT, ...message });
      // The tab closed or left for a page without us: the clipboard is what is left for a paid transcript.
      if (!delivered && message.success && !message.copied) await copyResult(message.text);
    },

    /** @param {import('../shared/messages.js').OffscreenError} payload */
    async onOffscreenError(payload) {
      const s = reporter(payload?.captureId);
      if (!s) return;
      // A stop before the first chunk, a double tap for one, is too short and no failure. Only a
      // user stop qualifies: an auto-stop leaves the frame recording, and it would drop this result.
      if (payload.empty === true && s.state === 'processing' && Number(payload.durationSec) < s.minSec) {
        free(s);
        await toTab(s.endpoint, { action: MSG.DICTATION_RESULT, ...TOO_SHORT });
        return;
      }
      await failSession(s);
    },

    /** @param {{ granted: boolean }} payload */
    async onPermissionResult({ granted }) {
      const endpoint = pendingPermission;
      if (!endpoint) return;
      pendingPermission = null;
      const notice = granted
        ? { text: 'Microphone allowed. Try again.', tone: 'success' }
        : { text: 'Microphone not allowed.', tone: 'error' };
      await toTab(endpoint, { action: MSG.RECORDING_STATE, state: 'idle', reason: 'permission', notice });
    },

    /** @param {number} tabId */
    async onTabRemoved(tabId) {
      if (pendingPermission?.tabId === tabId) pendingPermission = null;
      const s = session;
      // A processing session finishes: with no frame left, onDone copies its result.
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
