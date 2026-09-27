import { describe, it, expect } from 'vitest';
import {
  RECORDING_MIME, LEVEL_INTERVAL_MS, SPEECH_RMS, SILENCE_RMS,
  rms, levelFromRms, createSilenceDetector, bytesToBase64,
} from '../../../src/offscreen/audio.js';

describe('constants', () => {
  it('match the recording contract', () => {
    expect(RECORDING_MIME).toBe('audio/webm;codecs=opus');
    expect(LEVEL_INTERVAL_MS).toBe(100);
    expect(SPEECH_RMS).toBe(0.02);
    expect(SILENCE_RMS).toBe(0.01);
  });
});

describe('rms', () => {
  it('is 0 for empty or missing input', () => {
    expect(rms(new Float32Array(0))).toBe(0);
    expect(rms([])).toBe(0);
    expect(rms(undefined)).toBe(0);
  });
  it('is the root mean square of the samples', () => {
    expect(rms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5, 10);
    expect(rms(Float32Array.from([3, 4]))).toBeCloseTo(Math.sqrt(12.5), 6);
    expect(rms(new Float32Array(2048))).toBe(0);
  });
});

describe('levelFromRms', () => {
  it('stays within [0, 1]', () => {
    expect(levelFromRms(0)).toBe(0);
    expect(levelFromRms(-0.3)).toBe(0);
    expect(levelFromRms(0.16)).toBeCloseTo(1, 10);
    expect(levelFromRms(0.5)).toBe(1);
    expect(levelFromRms(Infinity)).toBe(1);
    expect(levelFromRms(Number.NaN)).toBe(0);
  });
  it('follows sqrt(rms) * 2.5 below the cap', () => {
    expect(levelFromRms(0.01)).toBeCloseTo(0.25, 10);
    expect(levelFromRms(0.04)).toBeCloseTo(0.5, 10);
  });
});

describe('createSilenceDetector', () => {
  const quiet = 0.001;
  const loud = 0.1;
  const push = (detector, value, times) => {
    let stop = false;
    for (let i = 0; i < times; i++) stop = detector.push(value);
    return stop;
  };

  it('stops once silence after speech spans silenceSec', () => {
    const detector = createSilenceDetector({ silenceSec: 2 });
    expect(detector.push(loud)).toBe(false);
    expect(detector.heardSpeech).toBe(true);
    expect(push(detector, quiet, 19)).toBe(false);
    expect(detector.push(quiet)).toBe(true);
  });

  it('never stops before speech was heard', () => {
    const detector = createSilenceDetector({ silenceSec: 2 });
    expect(push(detector, quiet, 100)).toBe(false);
    expect(detector.heardSpeech).toBe(false);
  });

  it('counts only silence that follows speech', () => {
    const detector = createSilenceDetector({ silenceSec: 2 });
    push(detector, quiet, 50);
    detector.push(loud);
    expect(push(detector, quiet, 19)).toBe(false);
    expect(detector.push(quiet)).toBe(true);
  });

  it('a sample at or above the silence threshold resets the run', () => {
    const detector = createSilenceDetector({ silenceSec: 2 });
    detector.push(loud);
    push(detector, quiet, 19);
    expect(detector.push(SILENCE_RMS)).toBe(false);
    expect(push(detector, quiet, 19)).toBe(false);
    expect(detector.push(quiet)).toBe(true);
  });

  it('a sample between the thresholds is not speech', () => {
    const detector = createSilenceDetector({ silenceSec: 2 });
    detector.push(0.015);
    expect(detector.heardSpeech).toBe(false);
    expect(push(detector, quiet, 40)).toBe(false);
  });

  it('silenceSec 0 never stops', () => {
    const detector = createSilenceDetector({ silenceSec: 0 });
    detector.push(loud);
    expect(push(detector, quiet, 10_000)).toBe(false);
    expect(detector.heardSpeech).toBe(true);
  });

  it('honours a custom interval and thresholds', () => {
    const detector = createSilenceDetector({ silenceSec: 1, intervalMs: 250, speechRms: 0.5, silenceRms: 0.2 });
    detector.push(0.4);
    expect(detector.heardSpeech).toBe(false);
    detector.push(0.5);
    expect(push(detector, 0.1, 3)).toBe(false);
    expect(detector.push(0.1)).toBe(true);
  });
});

describe('bytesToBase64', () => {
  /** Deterministic pseudo-random bytes so every byte value appears. */
  function bytes(length) {
    const out = new Uint8Array(length);
    let x = 12345;
    for (let i = 0; i < length; i++) {
      x = (x * 1103515245 + 12345) >>> 0;
      out[i] = x >>> 24;
    }
    return out;
  }

  it('encodes the empty array as the empty string', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
  });

  it.each([1, 2, 3, 0x7fff, 0x8000, 0x8001, 0x10000, 0x10002, 0x18000 + 7])('matches Buffer for %i bytes', (length) => {
    const data = bytes(length);
    expect(bytesToBase64(data)).toBe(Buffer.from(data).toString('base64'));
  });

  it('encodes a subarray view by its own bytes only', () => {
    const data = bytes(0x8000 + 10);
    const view = data.subarray(5, 0x8000 + 5);
    expect(bytesToBase64(view)).toBe(Buffer.from(view).toString('base64'));
  });
});
