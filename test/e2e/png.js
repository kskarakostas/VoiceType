// PNG files from Playwright screenshots: 8-bit RGB or RGBA, non-interlaced.
import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Bytes per pixel, by PNG colour type. */
const CHANNELS = new Map([[2, 3], [6, 4]]);

/**
 * @param {number} left
 * @param {number} up
 * @param {number} upLeft
 */
function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/**
 * @param {Buffer} buffer a PNG file
 * @returns {{ width: number, height: number, channels: number, data: Buffer }} rows of channel
 *   bytes with no filter bytes, top row first
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  for (let at = 8; at < buffer.length;) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('ascii', at + 4, at + 8);
    const chunk = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      channels = CHANNELS.get(chunk[9]) ?? 0;
      if (chunk[8] !== 8 || !channels || chunk[12] !== 0) throw new Error('unsupported PNG');
    } else if (type === 'IDAT') {
      idat.push(chunk);
    }
    at += 12 + length; // length, type, data, CRC
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const from = y * (stride + 1) + 1;
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? data[row + i - channels] : 0;
      const up = y > 0 ? data[row + i - stride] : 0;
      const upLeft = y > 0 && i >= channels ? data[row + i - stride - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) predicted = paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
      data[row + i] = (raw[from + i] + predicted) & 0xff;
    }
  }
  return { width, height, channels, data };
}
