// Generated image fixtures for the Read tests: no binary files in the repository.
import { deflateSync } from "node:zlib";

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  const body = new Uint8Array(4 + data.length);
  body.set(new TextEncoder().encode(type));
  body.set(data, 4);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(8 + data.length, Bun.hash.crc32(body) >>> 0);
  return out;
}

/** A screenshot-like picture: smooth gradients with hard-edged blocks; `noise` makes it photo-like (a PNG that stays large). */
export function testPng(width: number, height: number, noise = 0): Uint8Array {
  let seed = 1;
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      const block = ((x >> 6) + (y >> 6)) % 2 === 0;
      const grain = (): number => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return ((seed >>> 16) % (2 * noise + 1)) - noise;
      };
      raw[row + 1 + x * 3] = (block ? 240 : (x * 255) / width) + (noise ? grain() : 0);
      raw[row + 2 + x * 3] = (y * 255) / height + (noise ? grain() : 0);
      raw[row + 3 + x * 3] = (block ? 30 : 200) + (noise ? grain() : 0);
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

/** A 1×1 GIF with `frames` frames. */
export function testGif(frames: number): Uint8Array {
  const head = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
  const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0];
  return Uint8Array.from([...head, ...Array.from({ length: frames }, () => frame).flat(), 0x3b]);
}
