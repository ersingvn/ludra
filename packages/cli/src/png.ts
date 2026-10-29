import { crc32, deflateSync, inflateSync } from "node:zlib";

/** An image as 8-bit RGBA, row by row. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Channels per pixel for each PNG colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Decodes a PNG to RGBA. Reads 8-bit, non-interlaced images of every colour
 * type, which covers what browsers and image editors write; throws an Error
 * naming what it can't read otherwise.
 */
export function decodePng(file: Uint8Array): Rgba {
  const buffer = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG file");
  let width = 0;
  let height = 0;
  let colorType = 0;
  let palette: Buffer | undefined;
  let alpha: Buffer | undefined;
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= buffer.length; ) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString("ascii", at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    at += 12 + length;
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colorType = body[9]!;
      if (body[8] !== 8) throw new Error(`${body[8]}-bit PNGs aren't supported, only 8-bit`);
      if (body[12] !== 0) throw new Error("interlaced PNGs aren't supported");
      if (CHANNELS[colorType] === undefined) throw new Error(`unknown PNG colour type ${colorType}`);
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") alpha = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
  }
  if (width === 0 || height === 0) throw new Error("the PNG has no IHDR chunk");
  if (colorType === 3 && !palette) throw new Error("the PNG has a palette colour type but no palette");

  const channels = CHANNELS[colorType]!;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error("the PNG's image data is cut short");
  const rows = unfilter(raw, stride, height, channels);

  const data = new Uint8Array(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += channels) {
    const o = i * 4;
    switch (colorType) {
      case 0:
        data[o] = data[o + 1] = data[o + 2] = rows[p]!;
        data[o + 3] = 255;
        break;
      case 2:
        data[o] = rows[p]!;
        data[o + 1] = rows[p + 1]!;
        data[o + 2] = rows[p + 2]!;
        data[o + 3] = 255;
        break;
      case 3: {
        const index = rows[p]!;
        data[o] = palette![index * 3]!;
        data[o + 1] = palette![index * 3 + 1]!;
        data[o + 2] = palette![index * 3 + 2]!;
        data[o + 3] = alpha?.[index] ?? 255;
        break;
      }
      case 4:
        data[o] = data[o + 1] = data[o + 2] = rows[p]!;
        data[o + 3] = rows[p + 1]!;
        break;
      case 6:
        data.set(rows.subarray(p, p + 4), o);
        break;
    }
  }
  return { width, height, data };
}

/** Undoes the per-row filters (none, sub, up, average, Paeth) into plain pixel bytes. */
function unfilter(raw: Buffer, stride: number, height: number, bpp: number): Uint8Array {
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[row + x - bpp]! : 0;
      const b = y > 0 ? out[prev + x]! : 0;
      const c = x >= bpp && y > 0 ? out[prev + x - bpp]! : 0;
      let value = raw[src + x]!;
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`unknown PNG row filter ${filter}`);
      out[row + x] = value & 0xff;
    }
  }
  return out;
}

/** Encodes RGBA as an 8-bit PNG. */
export function encodePng(image: Rgba): Buffer {
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}
