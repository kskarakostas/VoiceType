// Microphone capture for the offscreen document. Every browser API arrives through deps,
// so the whole lifecycle runs under unit tests with fakes.
import { MSG } from '../shared/messages.js';
import { RECORDING_MIME, LEVEL_INTERVAL_MS, rms, levelFromRms, createSilenceDetector, bytesToBase64 } from './audio.js';

export const AUDIO_CONSTRAINTS = Object.freeze({
  audio: Object.freeze({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }),
});
export const AUDIO_BITS_PER_SECOND = 32000;
export const TIMESLICE_MS = 100;
/** How long to wait for the recorder's stop event before finishing with the chunks we have. */
export const STOP_TIMEOUT_MS = 2000;

const DENIED = 'Microphone access is blocked.';
const GENERIC = 'Could not start the microphone.';
const FAILED = 'Recording failed.';

/**
 * @typedef {{ state: string, start(timeslice?: number): void, stop(): void,
 *   ondataavailable: ((event: { data: Blob }) => void)|null,
 *   onstop: ((event?: unknown) => void)|null, onerror: ((event?: unknown) => void)|null }} MediaRecorderLike
 * @typedef {{ read(): Float32Array, close(): Promise<void> }} AnalyserLike
 * @typedef {{
 *   queryPermission: () => Promise<'granted'|'prompt'|'denied'>,
 *   getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
 *   createMediaRecorder: (stream: MediaStream, options: MediaRecorderOptions) => MediaRecorderLike,
 *   createAnalyser: (stream: MediaStream) => Promise<AnalyserLike>,
 *   send: (message: object) => void,
 *   now: () => number,
 *   setInterval: (fn: () => void, ms: number) => any,
 *   clearInterval: (id: any) => void,
 *   setTimeout: (fn: () => void, ms: number) => any,
 *   clearTimeout: (id: any) => void,
 * }} CaptureDeps
 * @typedef {'user'|'maxTime'|'silence'|'ended'} FinishReason
 */

/**
 * @param {string} reason
 * @param {string} error
 * @returns {import('../shared/messages.js').OffscreenStartResponse}
 */
function failure(reason, error) {
  return /** @type {any} */ ({ ok: false, reason, error });
}

/** @param {MediaStream|null} stream */
function stopTracks(stream) {
  for (const track of stream?.getTracks() ?? []) {
    try { track.stop(); } catch { /* already stopped */ }
  }
}

/** @param {AnalyserLike|null} analyser */
async function closeAnalyser(analyser) {
  try { await analyser?.close(); } catch { /* the context is gone either way */ }
}

/**
 * One recording at a time: permission check, MediaRecorder, levels, max time, silence stop.
 * @param {CaptureDeps} deps
 */
export function createCapture(deps) {
  const { send, now } = deps;
  let starting = false;
  let cancelStart = false;
  /** @type {any} */
  let session = null;

  /**
   * @param {{ maxSec: number, silenceSec: number }} options
   * @returns {Promise<import('../shared/messages.js').OffscreenStartResponse>}
   */
  async function start({ maxSec, silenceSec } = {}) {
    if (starting || session) return failure('micError', 'Already recording.');
    starting = true;
    cancelStart = false;
    let stream = null;
    let analyser = null;
    try {
      const state = await deps.queryPermission();
      // Offscreen documents cannot show a permission prompt; the service worker opens the grant page.
      if (state === 'prompt') return failure('needsPermission', 'Microphone permission needed.');
      if (state === 'denied') return failure('denied', DENIED);
      try {
        stream = await deps.getUserMedia(AUDIO_CONSTRAINTS);
      } catch (err) {
        if (err?.name === 'NotAllowedError') return failure('denied', DENIED);
        if (err?.name === 'NotFoundError') return failure('micError', 'No microphone found.');
        return failure('micError', GENERIC);
      }
      if (!cancelStart) analyser = await deps.createAnalyser(stream).catch(() => null);
      if (cancelStart) {
        stopTracks(stream);
        await closeAnalyser(analyser);
        return failure('micError', 'Recording cancelled.');
      }
      begin(stream, analyser, { maxSec, silenceSec });
      return { ok: true };
    } catch {
      stopTracks(stream);
      await closeAnalyser(analyser);
      return failure('micError', GENERIC);
    } finally {
      starting = false;
    }
  }

  function begin(stream, analyser, { maxSec, silenceSec }) {
    const recorder = deps.createMediaRecorder(stream, { mimeType: RECORDING_MIME, audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
    const s = {
      stream,
      analyser,
      recorder,
      chunks: [],
      startedAt: 0,
      detector: createSilenceDetector({ silenceSec }),
      levelTimer: null,
      maxTimer: null,
      finishing: null,
      discard: false,
      errored: false,
      resolveStopped: () => {},
      stopped: null,
      onEnded: () => { void finish(s, 'ended'); },
    };
    s.stopped = new Promise((resolve) => { s.resolveStopped = resolve; });
    recorder.ondataavailable = (event) => {
      if (event?.data && event.data.size > 0) s.chunks.push(event.data);
    };
    recorder.onstop = () => s.resolveStopped();
    recorder.onerror = () => {
      if (s !== session) return;
      s.errored = true;
      s.resolveStopped();
      void finish(s, null);
    };
    recorder.start(TIMESLICE_MS);
    s.startedAt = now();
    session = s;
    for (const track of stream.getTracks()) track.addEventListener('ended', s.onEnded);
    // setInterval, not requestAnimationFrame: an offscreen document is never rendered.
    if (analyser) s.levelTimer = deps.setInterval(() => tick(s), LEVEL_INTERVAL_MS);
    if (Number.isFinite(maxSec) && maxSec > 0) {
      s.maxTimer = deps.setTimeout(() => { void finish(s, 'maxTime'); }, maxSec * 1000);
    }
  }

  function tick(s) {
    if (s !== session || s.finishing) return;
    let value = 0;
    try { value = rms(s.analyser.read()); } catch { value = 0; }
    send({ action: MSG.OFFSCREEN_LEVEL, level: levelFromRms(value) });
    if (s.detector.push(value)) void finish(s, 'silence');
  }

  function clearTimers(s) {
    if (s.levelTimer !== null) deps.clearInterval(s.levelTimer);
    if (s.maxTimer !== null) deps.clearTimeout(s.maxTimer);
    s.levelTimer = null;
    s.maxTimer = null;
  }

  function releaseTracks(s) {
    for (const track of s.stream.getTracks()) track.removeEventListener('ended', s.onEnded);
    stopTracks(s.stream);
  }

  /**
   * Stop timers, the recorder, the tracks and the analyser, then report. Idempotent.
   * @param {any} s
   * @param {FinishReason|null} reason null after a recorder error (the report is an error)
   * @param {boolean} [discard]
   */
  function finish(s, reason, discard = false) {
    if (discard) s.discard = true;
    if (s.finishing) return s.finishing;
    s.finishing = (async () => {
      const durationSec = Math.max(0, (now() - s.startedAt) / 1000);
      clearTimers(s);
      try {
        if (s.recorder.state !== 'inactive') s.recorder.stop();
        else s.resolveStopped();
      } catch {
        s.resolveStopped();
      }
      releaseTracks(s);
      let timer = null;
      await Promise.race([s.stopped, new Promise((resolve) => { timer = deps.setTimeout(resolve, STOP_TIMEOUT_MS); })]);
      deps.clearTimeout(timer);
      await closeAnalyser(s.analyser);
      if (session === s) session = null;
      if (s.discard) return;
      if (s.errored || s.chunks.length === 0) {
        send({ action: MSG.OFFSCREEN_ERROR, error: FAILED });
        return;
      }
      try {
        const buffer = await new Blob(s.chunks, { type: 'audio/webm' }).arrayBuffer();
        send({ action: MSG.OFFSCREEN_DONE, audioBase64: bytesToBase64(new Uint8Array(buffer)), mimeType: 'audio/webm', durationSec, reason });
      } catch {
        send({ action: MSG.OFFSCREEN_ERROR, error: FAILED });
      }
    })();
    return s.finishing;
  }

  /**
   * @param {{ discard?: boolean }} [options]
   * @returns {Promise<{ ok: boolean }>}
   */
  async function stop({ discard = false } = {}) {
    if (starting) {
      // The service worker cancelled while the microphone was still opening.
      cancelStart = true;
      return { ok: true };
    }
    if (!session) return { ok: false };
    await finish(session, 'user', discard === true);
    return { ok: true };
  }

  return {
    start,
    stop,
    get active() {
      return starting || session !== null;
    },
  };
}
