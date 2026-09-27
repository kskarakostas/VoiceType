// Pure audio helpers for the offscreen recorder: level metering, silence detection, encoding.

export const RECORDING_MIME = 'audio/webm;codecs=opus';
export const LEVEL_INTERVAL_MS = 100;
export const SPEECH_RMS = 0.02;
export const SILENCE_RMS = 0.01;

const BASE64_CHUNK = 0x8000;

/**
 * Root mean square of time-domain samples in [-1, 1].
 * @param {Float32Array|number[]} samples
 * @returns {number} 0 for empty input
 */
export function rms(samples) {
  const n = samples?.length ?? 0;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / n);
}

/**
 * Map an RMS value to a display level. The square root lifts quiet speech into view.
 * @param {number} value
 * @returns {number} in [0, 1]
 */
export function levelFromRms(value) {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.sqrt(Math.max(0, value)) * 2.5);
}

/**
 * Decides when a recording has gone quiet after speech. Feed one RMS value per interval.
 * @param {{ silenceSec: number, intervalMs?: number, speechRms?: number, silenceRms?: number }} options
 * @returns {{ push(value: number): boolean, readonly heardSpeech: boolean }}
 */
export function createSilenceDetector({ silenceSec, intervalMs = LEVEL_INTERVAL_MS, speechRms = SPEECH_RMS, silenceRms = SILENCE_RMS }) {
  const limitMs = Number(silenceSec) > 0 ? Number(silenceSec) * 1000 : 0;
  let heardSpeech = false;
  let quietMs = 0;
  return {
    push(value) {
      if (value >= speechRms) heardSpeech = true;
      if (value < silenceRms) quietMs += intervalMs;
      else quietMs = 0;
      return limitMs > 0 && heardSpeech && quietMs >= limitMs;
    },
    get heardSpeech() {
      return heardSpeech;
    },
  };
}

/**
 * Base64 without spreading the whole buffer into one call (large arrays overflow the stack).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}
