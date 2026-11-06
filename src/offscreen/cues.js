// Short synthesized cues. No audio files, and a new AudioContext per cue: an open context holds
// an audio stream open between dictations. No chrome APIs here: the settings page plays the same
// cues to preview them.

/** Classic: a flat tone ramped in and out, as 3.2 played it. */
const GAIN = 0.18;
const RAMP_SEC = 0.005;
/** The other sets (V61): a note starts at this share of the last one's length... */
const OVERLAP_STEP = 0.85;
/** ...its gain falls exponentially to DECAY_FLOOR at this multiple of its length... */
const DECAY_END = 1.5;
const DECAY_FLOOR = 0.0008;
/** ...and its oscillator stops at this multiple, so `onended` waits for the tail. */
const STOP_AT = 1.6;
const DEFAULT_SET = 'soft';
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
 * @typedef {Pick<AudioContext, 'state'|'currentTime'|'destination'|'resume'|'close'|'createOscillator'|'createGain'|'createBiquadFilter'>} AudioContextLike
 * @typedef {Readonly<Record<import('../shared/messages.js').CueName, readonly Note[]>>} CueNotes
 * @typedef {{ envelope: 'flat', notes: CueNotes }
 *   | { envelope: 'decay', wave: OscillatorType, gain: number, attackMs: number, lowpassHz: number|null, notes: CueNotes }} CueSet
 */

/** @param {...[number, number]} pairs Hz and ms. */
const seq = (...pairs) => Object.freeze(pairs.map(([freq, ms]) => Object.freeze({ freq, ms })));

/** @type {Readonly<Record<import('../shared/defaults.js').Settings['soundSet'], Readonly<CueSet>>>} */
export const CUE_SETS = Object.freeze({
  soft: Object.freeze({
    envelope: 'decay', wave: 'sine', gain: 0.07, attackMs: 20, lowpassHz: null,
    notes: Object.freeze({
      start: seq([440, 110], [587, 190]),
      stop: seq([587, 110], [440, 190]),
      done: seq([587, 110], [784, 240]),
      error: seq([294, 160], [247, 240]),
    }),
  }),
  warm: Object.freeze({
    envelope: 'decay', wave: 'triangle', gain: 0.09, attackMs: 15, lowpassHz: 1200,
    notes: Object.freeze({
      start: seq([392, 110], [523, 190]),
      stop: seq([523, 110], [392, 190]),
      done: seq([523, 110], [659, 240]),
      error: seq([262, 160], [220, 240]),
    }),
  }),
  tap: Object.freeze({
    envelope: 'decay', wave: 'sine', gain: 0.08, attackMs: 12, lowpassHz: null,
    notes: Object.freeze({
      start: seq([523, 200]),
      stop: seq([392, 200]),
      done: seq([659, 260]),
      error: seq([247, 280]),
    }),
  }),
  classic: Object.freeze({
    envelope: 'flat',
    notes: Object.freeze({
      start: seq([660, 70], [880, 90]),
      stop: seq([880, 70], [660, 90]),
      done: seq([880, 70], [1320, 110]),
      error: seq([330, 120], [247, 120]),
    }),
  }),
});

export const CUE_NAMES = Object.freeze(Object.keys(CUE_SETS.classic.notes));

/**
 * An unknown or missing set plays Soft. Own names only: `__proto__` and `constructor` are not sets.
 * @param {unknown} set
 * @returns {Readonly<CueSet>}
 */
const setFor = (set) => (typeof set === 'string' && Object.hasOwn(CUE_SETS, set) ? CUE_SETS[set] : CUE_SETS[DEFAULT_SET]);

/**
 * How long a cue sounds: from the start of its first oscillator to the end of its last.
 * @param {string} set
 * @param {import('../shared/messages.js').CueName} name
 * @returns {number} Milliseconds.
 */
export function cueLengthMs(set, name) {
  const { envelope, notes } = setFor(set);
  const list = notes[name];
  if (envelope === 'flat') return list.reduce((sum, { ms }) => sum + ms, 0);
  const startOfLast = list.slice(0, -1).reduce((sum, { ms }) => sum + ms * OVERLAP_STEP, 0);
  return startOfLast + list.at(-1).ms * STOP_AT;
}

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
 * One note of a decay set: a linear attack to the peak, then an exponential fall to near zero.
 * The oscillator runs on past the end of the fall, so nothing is cut while it is audible.
 * @param {AudioContextLike} ctx
 * @param {Extract<CueSet, { envelope: 'decay' }>} set
 * @param {Note} note
 * @param {number} from Context time in seconds.
 * @returns {OscillatorNode}
 */
function scheduleDecayNote(ctx, set, { freq, ms }, from) {
  const oscillator = ctx.createOscillator();
  const envelope = ctx.createGain();
  oscillator.type = set.wave;
  oscillator.frequency.value = freq;
  envelope.gain.setValueAtTime(0, from);
  envelope.gain.linearRampToValueAtTime(set.gain, from + set.attackMs / 1000);
  envelope.gain.exponentialRampToValueAtTime(DECAY_FLOOR, from + (ms * DECAY_END) / 1000);
  let source = oscillator;
  if (set.lowpassHz !== null) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = set.lowpassHz;
    oscillator.connect(filter);
    source = filter;
  }
  source.connect(envelope);
  envelope.connect(ctx.destination);
  oscillator.start(from);
  oscillator.stop(from + (ms * STOP_AT) / 1000);
  return oscillator;
}

/**
 * @param {AudioContextLike} ctx
 * @param {readonly Note[]} notes
 * @returns {OscillatorNode} The last one.
 */
function scheduleFlat(ctx, notes) {
  let at = ctx.currentTime;
  let last;
  for (const { freq, ms } of notes) {
    last = scheduleNote(ctx, freq, at, at + ms / 1000);
    at += ms / 1000;
  }
  return last;
}

/**
 * @param {AudioContextLike} ctx
 * @param {Extract<CueSet, { envelope: 'decay' }>} set
 * @param {readonly Note[]} notes
 * @returns {OscillatorNode} The last one.
 */
function scheduleDecay(ctx, set, notes) {
  let at = ctx.currentTime;
  let last;
  for (const note of notes) {
    last = scheduleDecayNote(ctx, set, note, at);
    at += (note.ms * OVERLAP_STEP) / 1000;
  }
  return last;
}

/**
 * Resolves when the last note ended, or a while after it should have.
 * @param {AudioContextLike} ctx
 * @param {string} setName
 * @param {import('../shared/messages.js').CueName} name
 * @returns {Promise<void>}
 */
function playNotes(ctx, setName, name) {
  const set = setFor(setName);
  const last = set.envelope === 'flat' ? scheduleFlat(ctx, set.notes[name]) : scheduleDecay(ctx, set, set.notes[name]);
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, cueLengthMs(setName, name) + END_GRACE_MS);
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
 * @returns {{ play: (name: string, set?: string) => Promise<{ ok: boolean }> }} `play` never rejects.
 */
export function createCuePlayer({ createContext }) {
  return {
    async play(name, set) {
      // A plain lookup in the notes would find inherited names such as __proto__.
      if (!CUE_NAMES.includes(name)) return { ok: false };
      /** @type {AudioContextLike|undefined} */
      let ctx;
      let played = false;
      try {
        ctx = createContext();
        await resumeWithin(ctx, RESUME_TIMEOUT_MS);
        if (ctx.state !== 'running') return { ok: false };
        await playNotes(ctx, set, name);
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
