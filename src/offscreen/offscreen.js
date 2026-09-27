// Offscreen document entry. Only chrome.runtime exists here: levels and results go to the
// service worker, which relays them to the recording tab.
import { MSG } from '../shared/messages.js';
import { createCapture } from './capture.js';

const FFT_SIZE = 2048;
const RESUME_TIMEOUT_MS = 1000;

/** @returns {Promise<'granted'|'prompt'|'denied'>} */
async function queryPermission() {
  try {
    const status = await navigator.permissions.query({ name: /** @type {PermissionName} */ ('microphone') });
    return status.state;
  } catch {
    // Unknown state: the permission page asks, and closes at once when access is already granted.
    return 'prompt';
  }
}

/**
 * @param {MediaStream} stream
 * @param {MediaRecorderOptions} options
 */
function createMediaRecorder(stream, options) {
  const supported = MediaRecorder.isTypeSupported(options.mimeType);
  return new MediaRecorder(stream, supported ? options : { audioBitsPerSecond: options.audioBitsPerSecond });
}

/**
 * Called after getUserMedia resolves: an AudioContext created earlier can stay suspended.
 * @param {MediaStream} stream
 */
async function createAnalyser(stream) {
  const ctx = new AudioContext();
  try {
    let timer;
    await Promise.race([ctx.resume(), new Promise((resolve) => { timer = setTimeout(resolve, RESUME_TIMEOUT_MS); })]);
    clearTimeout(timer);
    if (ctx.state !== 'running') throw new Error(`AudioContext is ${ctx.state}`);
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    return {
      read() {
        analyser.getFloatTimeDomainData(buffer);
        return buffer;
      },
      async close() {
        source.disconnect();
        await ctx.close();
      },
    };
  } catch (err) {
    ctx.close().catch(() => {});
    throw err;
  }
}

const capture = createCapture({
  queryPermission,
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  createMediaRecorder,
  createAnalyser,
  send: (message) => { chrome.runtime.sendMessage(message).catch(() => {}); },
  now: () => performance.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Content scripts broadcast to every extension context; only the service worker drives capture.
  if (sender.tab) return false;
  if (message?.action === MSG.OFFSCREEN_START) {
    capture.start({ maxSec: Number(message.maxSec), silenceSec: Number(message.silenceSec) || 0 }).then(sendResponse);
    return true;
  }
  if (message?.action === MSG.OFFSCREEN_STOP) {
    capture.stop({ discard: message.discard === true }).then(sendResponse);
    return true;
  }
  return false;
});
