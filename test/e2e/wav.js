// WAV files for Chromium's fake microphone (--use-file-for-fake-audio-capture): 16-bit mono PCM.
import { writeFileSync } from 'node:fs';

/** Half of full scale: a clear "speech" level without clipping after browser processing. */
const TONE_AMPLITUDE = 0.5;

/**
 * @param {ArrayLike<number>} samples in [-1, 1]
 * @param {number} sampleRate
 * @returns {Buffer} a canonical 44-byte RIFF/WAVE header followed by the PCM data
 */
export function encodeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return buf;
}

/**
 * @param {string} path
 * @param {{ seconds?: number, hz?: number, sampleRate?: number }} [options]
 * @returns {string} the path written
 */
export function writeToneWav(path, { seconds = 2, hz = 440, sampleRate = 48000 } = {}) {
  const samples = new Float64Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = TONE_AMPLITUDE * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  }
  writeFileSync(path, encodeWav(samples, sampleRate));
  return path;
}

/**
 * @param {string} path
 * @param {{ seconds?: number, sampleRate?: number }} [options]
 * @returns {string} the path written
 */
export function writeSilenceWav(path, { seconds = 2, sampleRate = 48000 } = {}) {
  writeFileSync(path, encodeWav(new Float64Array(Math.round(seconds * sampleRate)), sampleRate));
  return path;
}
