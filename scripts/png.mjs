// Minimal PNG codec for pwa.mjs: decode an 8-bit, non-interlaced PNG to RGBA,
// area-average resample it, and re-encode as an 8-bit RGBA PNG.
//
// Why hand-rolled: GitHub's ubuntu-latest runner image ships neither Pillow nor
// ImageMagick (the first deploy failed on exactly that, run 42729934379), so the
// icon resize cannot depend on them. Node's stdlib (zlib) covers the format
// subset real icons use. Inputs outside that subset — sub-8-bit or 16-bit
// depths, Adam7 interlacing — throw, and pwa.mjs falls back to Pillow or
// ImageMagick where those exist. No npm dependencies, like the rest of the repo.

import { inflateSync, deflateSync } from "node:zlib";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG color type → samples per pixel (bit depth 8 only)
const SAMPLES = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// ---- CRC32 (PNG chunks) ----------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- decode ----------------------------------------------------------------

export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error("not a PNG");

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = -1;
  let palette = null;
  let trns = null;
  const idats = [];

  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (len > 0x7fffffff || off + 12 + len > buf.length) throw new Error("truncated chunk");
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (buf.readUInt32BE(off + 8 + len) !== crc32(buf.subarray(off + 4, off + 8 + len)))
      throw new Error(`CRC mismatch in ${type}`);
    off += 12 + len;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[10] !== 0 || data[11] !== 0) throw new Error("unsupported compression or filter method");
      interlace = data[12];
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "tRNS") {
      trns = data;
    } else if (type === "IDAT") {
      idats.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (!width || !height) throw new Error("missing or empty IHDR");
  if (interlace !== 0) throw new Error("interlaced PNGs are not supported");
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} is not supported (8 only)`);
  const samples = SAMPLES[colorType];
  if (!samples) throw new Error(`color type ${colorType} is not supported`);
  if (colorType === 3 && (!palette || palette.length % 3 !== 0))
    throw new Error("palette missing or malformed");
  if (!idats.length) throw new Error("no image data");

  const stride = width * samples;
  const raw = inflateSync(Buffer.concat(idats));
  if (raw.length < height * (stride + 1)) throw new Error("image data truncated");

  unfilter(raw, width, height, stride, samples);
  const rgba = expand(raw, width, height, stride, samples, colorType, palette, trns);
  return { width, height, rgba };
}

// Undo the per-scanline filters, in place inside the inflated buffer. For every
// filter the bytes it reads (left, up, up-left) are already unfiltered: left
// within the same row because the loop runs left to right, up/up-left because
// the previous row was finished first.
function unfilter(raw, width, height, stride, bpp) {
  let p = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[p++];
    const ro = p; // this row's first byte
    const po = y > 0 ? ro - stride - 1 : -1; // previous row's first byte
    const left = (i) => (i >= bpp ? raw[ro + i - bpp] : 0);
    const up = (i) => (po >= 0 ? raw[po + i] : 0);
    const upleft = (i) => (po >= 0 && i >= bpp ? raw[po + i - bpp] : 0);

    switch (ft) {
      case 0: // None
        break;
      case 1: // Sub
        for (let i = bpp; i < stride; i++) raw[ro + i] = (raw[ro + i] + left(i)) & 255;
        break;
      case 2: // Up
        for (let i = 0; i < stride; i++) raw[ro + i] = (raw[ro + i] + up(i)) & 255;
        break;
      case 3: // Average
        for (let i = 0; i < stride; i++) raw[ro + i] = (raw[ro + i] + ((left(i) + up(i)) >> 1)) & 255;
        break;
      case 4: // Paeth
        for (let i = 0; i < stride; i++) raw[ro + i] = (raw[ro + i] + paeth(left(i), up(i), upleft(i))) & 255;
        break;
      default:
        throw new Error(`bad filter type ${ft}`);
    }
    p += stride;
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Expand the unfiltered scanlines to straight (non-premultiplied) RGBA.
function expand(raw, width, height, stride, samples, colorType, palette, trns) {
  const out = Buffer.allocUnsafe(width * height * 4);

  // tRNS marks one color fully transparent in gray (type 0) and RGB (type 2)
  // images; in palettes (type 3) it is a per-entry alpha array.
  let trnsGray = -1;
  let trnsR = -1;
  let trnsG = -1;
  let trnsB = -1;
  if (trns && colorType === 0) trnsGray = trns.readUInt16BE(0) & 255;
  if (trns && colorType === 2) {
    trnsR = trns.readUInt16BE(0) & 255;
    trnsG = trns.readUInt16BE(2) & 255;
    trnsB = trns.readUInt16BE(4) & 255;
  }

  for (let y = 0, rp = 0, op = 0; y < height; y++, rp += stride + 1) {
    for (let x = 0; x < width; x++, op += 4) {
      const i = rp + 1 + x * samples; // +1 skips the filter byte
      let r;
      let g;
      let b;
      let a = 255;
      if (colorType === 6) {
        r = raw[i];
        g = raw[i + 1];
        b = raw[i + 2];
        a = raw[i + 3];
      } else if (colorType === 2) {
        r = raw[i];
        g = raw[i + 1];
        b = raw[i + 2];
        if (r === trnsR && g === trnsG && b === trnsB) a = 0;
      } else if (colorType === 4) {
        r = g = b = raw[i];
        a = raw[i + 1];
      } else if (colorType === 0) {
        r = g = b = raw[i];
        if (raw[i] === trnsGray) a = 0;
      } else {
        const idx = raw[i];
        const pe = idx * 3;
        if (pe + 2 >= palette.length) throw new Error(`palette index ${idx} out of range`);
        r = palette[pe];
        g = palette[pe + 1];
        b = palette[pe + 2];
        if (trns && idx < trns.length) a = trns[idx];
      }
      out[op] = r;
      out[op + 1] = g;
      out[op + 2] = b;
      out[op + 3] = a;
    }
  }
  return out;
}

// ---- resample --------------------------------------------------------------

// Area-average (box filter) downsample with correct fractional edges. Alpha is
// premultiplied before averaging and unpremultiplied after, so fully or partly
// transparent pixels do not bleed their color into visible edges. Weights
// telescope, so the per-pixel coverage denominator is exactly sx*sy. For
// upscales this degenerates to (weighted) nearest-neighbor — fine for the
// manifest icons, which only ever come from a1024px master.
export function resizeRgba(src, sw, sh, dw, dh) {
  const dst = Buffer.alloc(dw * dh * 4);
  const sx = sw / dw;
  const sy = sh / dh;
  const cover = sx * sy;

  for (let dy = 0; dy < dh; dy++) {
    const y0 = dy * sy;
    const y1 = y0 + sy;
    const iy0 = Math.floor(y0);
    const iy1 = Math.min(sh, Math.ceil(y1));
    for (let dx = 0; dx < dw; dx++) {
      const x0 = dx * sx;
      const x1 = x0 + sx;
      const ix0 = Math.floor(x0);
      const ix1 = Math.min(sw, Math.ceil(x1));

      let pr = 0; // premultiplied channel sums, weighted by coverage
      let pg = 0;
      let pb = 0;
      let pa = 0;
      for (let iy = iy0; iy < iy1; iy++) {
        const wy = Math.min(y1, iy + 1) - Math.max(y0, iy);
        if (wy <= 0) continue;
        for (let ix = ix0; ix < ix1; ix++) {
          const wx = Math.min(x1, ix + 1) - Math.max(x0, ix);
          if (wx <= 0) continue;
          const w = wx * wy;
          const o = (iy * sw + ix) * 4;
          const a = src[o + 3] / 255;
          pr += src[o] * a * w;
          pg += src[o + 1] * a * w;
          pb += src[o + 2] * a * w;
          pa += a * w;
        }
      }

      const o = (dy * dw + dx) * 4;
      const alpha = pa / cover; // mean alpha, 0..1
      dst[o + 3] = clamp255(Math.round(alpha * 255));
      if (pa > 0) {
        dst[o] = clamp255(Math.round(pr / pa));
        dst[o + 1] = clamp255(Math.round(pg / pa));
        dst[o + 2] = clamp255(Math.round(pb / pa));
      } else {
        dst[o] = dst[o + 1] = dst[o + 2] = 0;
      }
    }
  }
  return dst;
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// ---- encode ----------------------------------------------------------------

// Encode RGBA as an 8-bit RGBA PNG. Each scanline is written with the filter
// (None/Sub/Up/Average/Paeth) that minimizes the sum of absolute filtered
// bytes — the heuristic the PNG spec suggests — then everything is deflated.
export function encodePng(rgba, width, height) {
  if (rgba.length !== width * height * 4) throw new Error("rgba buffer size mismatch");
  const stride = width * 4;
  const bpp = 4;
  const filtered = Buffer.alloc(height * (stride + 1));
  const trials = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];

  let prev = null; // previous row, unfiltered (a view into rgba)
  for (let y = 0; y < height; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const t = trials[f];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const x = row[i];
        const left = i >= bpp ? row[i - bpp] : 0;
        const up = prev ? prev[i] : 0;
        const ul = prev && i >= bpp ? prev[i - bpp] : 0;
        let v;
        if (f === 0) v = x;
        else if (f === 1) v = x - left;
        else if (f === 2) v = x - up;
        else if (f === 3) v = x - ((left + up) >> 1);
        else v = x - paeth(left, up, ul);
        v &= 255;
        t[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    const ro = y * (stride + 1);
    filtered[ro] = best;
    trials[best].copy(filtered, ro + 1);
    prev = row;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    PNG_SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(filtered, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
