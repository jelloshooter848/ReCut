/**
 * Subtitle bitmap → OCR-ready grayscale (pure; no Node, no DOM).
 *
 * 1. Crop to the alpha bounding box with a transparent margin (IMAGE_PAD).
 * 2. Composite onto black (white text stays white, its dark border melts into the background) and invert:
 *    black text on white, the polarity Tesseract's LSTM models are trained on.
 * 3. Split into horizontal bands at runs of >= MIN_BAND_GAP empty rows (a top sign and the bottom dialogue are read
 *    separately; the lines of one dialogue block stay together).
 * 4. Encode each band as binary PGM (P5).
 * `flipPolarity` is the retry when the text came out dark-on-light (light text on a dark box, or dark text).
 */

export interface Ya8 {
  width: number;
  height: number;
  /** Interleaved gray, alpha; 2 bytes per pixel. */
  data: Uint8Array;
}

export interface Gray8 {
  width: number;
  height: number;
  /** 1 byte per pixel, 0 = black, 255 = white. */
  data: Uint8Array;
}

export interface OcrBand extends Gray8 {
  /** Top row of the band within the cropped image. */
  y: number;
  /** PGM (P5) encoding of the band. */
  pgm: Uint8Array;
}

/** Margin kept around the ink, in pixels. */
export const PREPROCESS_PAD = 12;
/** Empty rows needed to split bands. */
export const MIN_BAND_GAP = 8;
/** Alpha below this is background. */
export const INK_ALPHA = 8;
/** In the inverted image, a row is empty when every pixel is at least this light. */
export const EMPTY_ROW_MIN = 224;

/** Bounding box of pixels with alpha >= minAlpha, or null for a transparent image. */
export function alphaBBox(img: Ya8, minAlpha = INK_ALPHA): { x: number; y: number; width: number; height: number } | null {
  const { width, height, data } = img;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 2;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 2 + 1] >= minAlpha) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/**
 * Bilinear upscale of a ya8 image by an integer factor (pixel centres aligned). Used for small (DVD-sized) canvases:
 * scaling only the cropped subtitle in JS is far cheaper than scaling every full frame in FFmpeg.
 */
export function upscaleYa8(img: Ya8, factor: number): Ya8 {
  if (!(factor > 1) || !Number.isInteger(factor)) return img;
  const { width: sw, height: sh, data: src } = img;
  const dw = sw * factor, dh = sh * factor;
  const out = new Uint8Array(dw * dh * 2);
  // Per destination column: left source column and weight (shared by all rows).
  const x0s = new Int32Array(dw), x1s = new Int32Array(dw), fxs = new Float32Array(dw);
  for (let x = 0; x < dw; x++) {
    const fx = Math.min(Math.max((x + 0.5) / factor - 0.5, 0), sw - 1);
    x0s[x] = Math.floor(fx);
    x1s[x] = Math.min(x0s[x] + 1, sw - 1);
    fxs[x] = fx - x0s[x];
  }
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(Math.max((y + 0.5) / factor - 0.5, 0), sh - 1);
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, sh - 1), wy = fy - y0;
    const r0 = y0 * sw * 2, r1 = y1 * sw * 2;
    let o = y * dw * 2;
    for (let x = 0; x < dw; x++) {
      const a = x0s[x] * 2, b = x1s[x] * 2, wx = fxs[x];
      for (let c = 0; c < 2; c++) {
        const top = src[r0 + a + c] + (src[r0 + b + c] - src[r0 + a + c]) * wx;
        const bot = src[r1 + a + c] + (src[r1 + b + c] - src[r1 + a + c]) * wx;
        out[o++] = Math.round(top + (bot - top) * wy);
      }
    }
  }
  return { width: dw, height: dh, data: out };
}

/** Crop to the alpha box plus `pad` on every side (the margin is transparent even past the source edges). */
export function cropToInk(img: Ya8, pad = PREPROCESS_PAD): Ya8 | null {
  const box = alphaBBox(img);
  if (!box) return null;
  const w = box.width + 2 * pad;
  const h = box.height + 2 * pad;
  const out = new Uint8Array(w * h * 2);
  for (let r = 0; r < box.height; r++) {
    const src = ((box.y + r) * img.width + box.x) * 2;
    out.set(img.data.subarray(src, src + box.width * 2), ((r + pad) * w + pad) * 2);
  }
  return { width: w, height: h, data: out };
}

/** Composite ya8 onto black and invert: gray' = 255 - gray * alpha / 255. Light text becomes black on white. */
export function compositeInvert(img: Ya8): Gray8 {
  const n = img.width * img.height;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const g = img.data[i * 2], a = img.data[i * 2 + 1];
    out[i] = 255 - Math.round((g * a) / 255);
  }
  return { width: img.width, height: img.height, data: out };
}

/** 255 - v for every pixel (the OCR retry for dark-on-light subtitles). */
export function flipPolarity(img: Gray8): Gray8 {
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < out.length; i++) out[i] = 255 - img.data[i];
  return { width: img.width, height: img.height, data: out };
}

/**
 * Row ranges [y0, y1) of ink separated by at least `minGap` empty rows. Each range is widened by up to
 * min(pad, half the gap) empty rows on each side so the glyphs keep a margin.
 */
export function findBands(img: Gray8, minGap = MIN_BAND_GAP, pad = PREPROCESS_PAD, emptyMin = EMPTY_ROW_MIN): { y0: number; y1: number }[] {
  const { width, height, data } = img;
  const inked: boolean[] = new Array(height);
  for (let y = 0; y < height; y++) {
    let ink = false;
    const row = y * width;
    for (let x = 0; x < width; x++) if (data[row + x] < emptyMin) { ink = true; break; }
    inked[y] = ink;
  }
  // Runs of ink rows, joining runs whose gap is shorter than minGap.
  const runs: { y0: number; y1: number }[] = [];
  let y = 0;
  while (y < height) {
    if (!inked[y]) { y++; continue; }
    const s = y;
    while (y < height && inked[y]) y++;
    const last = runs[runs.length - 1];
    if (last && s - last.y1 < minGap) last.y1 = y;
    else runs.push({ y0: s, y1: y });
  }
  return runs.map((r, i) => {
    const above = i === 0 ? r.y0 : Math.floor((r.y0 - runs[i - 1].y1) / 2);
    const below = i === runs.length - 1 ? height - r.y1 : Math.floor((runs[i + 1].y0 - r.y1) / 2);
    return { y0: r.y0 - Math.min(pad, above), y1: r.y1 + Math.min(pad, below) };
  });
}

/** Rows [y0, y1) of a gray image. */
export function sliceRows(img: Gray8, y0: number, y1: number): Gray8 {
  return { width: img.width, height: y1 - y0, data: img.data.slice(y0 * img.width, y1 * img.width) };
}

/** Binary PGM: "P5\n<w> <h>\n255\n" + pixels. */
export function encodePgm(img: Gray8): Uint8Array {
  const header = `P5\n${img.width} ${img.height}\n255\n`;
  const out = new Uint8Array(header.length + img.data.length);
  for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
  out.set(img.data, header.length);
  return out;
}

/** The whole chain: ya8 subtitle image → bands of black-on-white gray8 with their PGM. Empty for a blank image. */
export function prepareForOcr(img: Ya8, opts: { pad?: number; minGap?: number } = {}): OcrBand[] {
  const pad = opts.pad ?? PREPROCESS_PAD;
  const cropped = cropToInk(img, pad);
  if (!cropped) return [];
  const gray = compositeInvert(cropped);
  return findBands(gray, opts.minGap ?? MIN_BAND_GAP, pad).map(({ y0, y1 }) => {
    const band = sliceRows(gray, y0, y1);
    return { ...band, y: y0, pgm: encodePgm(band) };
  });
}
