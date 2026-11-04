// Short synthesized cues. No audio files, and a new AudioContext per cue: an open context holds
// an audio stream open between dictations.

const GAIN = 0.18;
const RAMP_SEC = 0.005;
const RESUME_TIMEOUT_MS = 1000;
/** How long past its planned end a cue waits for `onended`. */
const END_GRACE_MS = 500;
/**
 * How long a played cue keeps its context. `onended` runs on the render clock while the output
 * buffer still holds the end of the cue, a Bluetooth output more of it, and `close()` drops what
 * is buffered: the cue would stop short with a click.
 */
const CLOSE_TAIL_MS = 300;

/** @typedef {{ freq: number, ms: number }} Note */
/**
 * @typedef {Pick<AudioContext, 'state'|'currentTime'|'destination'|'resume'|'close'|'createOscillator'|'createGain'>} AudioContextLike
 */

/** @type {Readonly<Record<import('../shared/messages.js').CueName, readonly Note[]>>} */
export const CUES = Object.freeze({
  start: Object.freeze([{ freq: 660, ms: 70 }, { freq: 880, ms: 90 }]),
  stop: Object.freeze([{ freq: 880, ms: 70 }, { freq: 660, ms: 90 }]),
  done: Object.freeze([{ freq: 880, ms: 70 }, { freq: 1320, ms: 110 }]),
  error: Object.freeze([{ freq: 330, ms: 120 }, { freq: 247, ms: 120 }]),
});

export const CUE_NAMES = Object.freeze(Object.keys(CUES));

/** @param {AudioContextLike} ctx */
async function resumeWithin(ctx, ms) {
  let timer;
  try {
    await Promise.race([ctx.resume(), new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One note, ramped from and back to 0 so it does not click.
 * @param {AudioContextLike} ctx
 * @param {number} freq
 * @param {number} from Context time in seconds.
 * @param {number} to
 * @returns {OscillatorNode}
 */
function scheduleNote(ctx, freq, from, to) {
  const oscillator = ctx.createOscillator();
  const envelope = ctx.createGain();
  oscillator.frequency.value = freq;
  envelope.gain.setValueAtTime(0, from);
  envelope.gain.linearRampToValueAtTime(GAIN, from + RAMP_SEC);
  envelope.gain.setValueAtTime(GAIN, to - RAMP_SEC);
  envelope.gain.linearRampToValueAtTime(0, to);
  oscillator.connect(envelope);
  envelope.connect(ctx.destination);
  oscillator.start(from);
  oscillator.stop(to);
  return oscillator;
}

/**
 * Resolves when the last note ended, or a while after it should have.
 * @param {AudioContextLike} ctx
 * @param {readonly Note[]} notes
 * @returns {Promise<void>}
 */
function playNotes(ctx, notes) {
  let at = ctx.currentTime;
  let last;
  let plannedMs = 0;
  for (const { freq, ms } of notes) {
    last = scheduleNote(ctx, freq, at, at + ms / 1000);
    at += ms / 1000;
    plannedMs += ms;
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, plannedMs + END_GRACE_MS);
    last.onended = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

/**
 * Not awaited: a cue reports what it played, and a close that hangs must not hold the reply.
 * @param {AudioContextLike} ctx
 */
function closeQuietly(ctx) {
  try {
    ctx.close().catch(() => {});
  } catch {
    // Already closed.
  }
}

/**
 * @param {{ createContext: () => AudioContextLike }} deps
 * @returns {{ play: (name: string) => Promise<{ ok: boolean }> }} `play` never rejects.
 */
export function createCuePlayer({ createContext }) {
  return {
    async play(name) {
      // A plain lookup in CUES would find inherited names such as __proto__.
      if (!CUE_NAMES.includes(name)) return { ok: false };
      /** @type {AudioContextLike|undefined} */
      let ctx;
      let played = false;
      try {
        ctx = createContext();
        await resumeWithin(ctx, RESUME_TIMEOUT_MS);
        if (ctx.state !== 'running') return { ok: false };
        await playNotes(ctx, CUES[name]);
        played = true;
        return { ok: true };
      } catch {
        return { ok: false };
      } finally {
        if (played) setTimeout(closeQuietly, CLOSE_TAIL_MS, ctx);
        else if (ctx) closeQuietly(ctx);
      }
    },
  };
}
