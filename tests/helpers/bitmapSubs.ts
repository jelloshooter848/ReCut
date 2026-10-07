/**
 * Test fixture generator: real bitmap subtitle streams with known text and timing.
 *
 * 1. Each event's text is rendered by FFmpeg `drawtext` (white text, black border, transparent background) to RGBA,
 *    many events per FFmpeg run (one `drawtext` per event, gated by `enable='eq(n,i)'`, text read from a file so no
 *    filtergraph escaping is needed).
 * 2. The RGBA is cropped to its alpha box and quantised to a 4-entry palette (transparent, black, grey, white) so
 *    every target codec can carry it unchanged (DVD and XSUB allow only 4 colours).
 * 3. A PGS `.sup` is written by hand (PCS / WDS / PDS / ODS with RLE / END per subtitle, and a display set with no
 *    objects to clear it) and muxed into MKV with `-c:s copy` next to a short video.
 * 4. `dvd_subtitle` (MKV), `dvb_subtitle` (MPEG-TS) and `xsub` (AVI) are made from that MKV by a bitmap-to-bitmap
 *    transcode in FFmpeg, with `-fix_sub_duration` so each subtitle carries its real end time.
 *
 * No binaries are committed: everything is generated at test time from `ffmpeg` on PATH (or RECUT_FFMPEG).
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { adaptFfmpegArgs, ffmpegMajorVersionSync, getFfmpegPath, getFfprobePath } from '../../electron/media/ffmpeg';

export type BitmapSubCodec = 'hdmv_pgs_subtitle' | 'dvd_subtitle' | 'dvb_subtitle' | 'xsub';
export const BITMAP_FIXTURE_CODECS: BitmapSubCodec[] = ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'];

export interface FixtureEvent {
  /** Seconds. */
  start: number;
  /** Seconds; must be > start and <= the next event's start. */
  end: number;
  /** Text; '\n' makes a second line. */
  text: string;
}

export interface BitmapSubsFixtureOptions {
  codec: BitmapSubCodec;
  events: FixtureEvent[];
  /** Subtitle canvas (PGS video size). Default 1920x1080 for PGS, 720x480 otherwise. */
  width?: number;
  height?: number;
  /** Default: height / 18, at least 20. */
  fontSize?: number;
  /** File name without extension. Default `subs-<codec>`. */
  name?: string;
  /** Media duration in seconds. Default: last end + 1. */
  duration?: number;
  /** Add a silent audio stream before the subtitles, so the bitmap stream is index 2 instead of 1. */
  withAudio?: boolean;
}

export interface BitmapSubsFixture {
  path: string;
  /** Absolute stream index (ffprobe `index`) of the bitmap subtitle stream. */
  streamIndex: number;
  codec: BitmapSubCodec;
  width: number;
  height: number;
  duration: number;
  events: FixtureEvent[];
  /**
   * Seconds to add to an event time to get its media time in ReCut (the container's start_time is media time 0, the
   * fixture's times are relative to its video). 0 except MPEG-TS with audio, where it is +0.01 (mp2 encoder delay).
   */
  timeOffset: number;
  /** Pixel size of each event's bitmap as written into the PGS (after cropping to the alpha box). */
  bitmaps: { x: number; y: number; width: number; height: number }[];
}

const ENCODER_FOR: Record<BitmapSubCodec, string | null> = {
  hdmv_pgs_subtitle: null,
  dvd_subtitle: 'dvdsub',
  dvb_subtitle: 'dvbsub',
  xsub: 'xsub',
};

function ffBin(): string {
  return getFfmpegPath() ?? 'ffmpeg';
}

function ff(args: string[], cwd?: string): void {
  execFileSync(ffBin(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 600_000,
    cwd,
    windowsHide: true,
  });
}

let listingCache: string | null = null;
function ffListing(): string {
  if (listingCache !== null) return listingCache;
  try {
    const enc = execFileSync(ffBin(), ['-hide_banner', '-encoders'], { timeout: 20_000, windowsHide: true }).toString();
    const dec = execFileSync(ffBin(), ['-hide_banner', '-decoders'], { timeout: 20_000, windowsHide: true }).toString();
    const fil = execFileSync(ffBin(), ['-hide_banner', '-filters'], { timeout: 20_000, windowsHide: true }).toString();
    listingCache = `${enc}\n@@DEC\n${dec}\n@@FIL\n${fil}`;
  } catch {
    listingCache = '';
  }
  return listingCache;
}

/** First font file that exists (same list as scripts/make-test-media.sh), or null. */
export function findFixtureFont(): string | null {
  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/Library/Fonts/Arial.ttf',
    'C:\\Windows\\Fonts\\arial.ttf',
    '/c/Windows/Fonts/arial.ttf',
    '/mnt/c/Windows/Fonts/arial.ttf',
  ];
  if (process.env.WINDIR) candidates.unshift(path.join(process.env.WINDIR, 'Fonts', 'arial.ttf'));
  for (const f of candidates) {
    try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}

/**
 * Why a fixture of `codec` cannot be generated here, or null when it can. Tests use this to skip cleanly.
 */
export function bitmapFixtureUnavailable(codec: BitmapSubCodec): string | null {
  const listing = ffListing();
  if (!listing) return 'ffmpeg not found';
  const [enc, rest] = listing.split('\n@@DEC\n');
  const [dec, fil] = (rest ?? '').split('\n@@FIL\n');
  if (!/\sdrawtext\s/.test(fil ?? '')) return 'ffmpeg has no drawtext filter (built without libfreetype)';
  if (!findFixtureFont()) return 'no font file found for drawtext';
  if (!/\spgssub\s/.test(dec ?? '')) return 'ffmpeg has no PGS decoder';
  const encoder = ENCODER_FOR[codec];
  if (encoder && !new RegExp(`^\\s*S\\S*\\s+${encoder}\\s`, 'm').test(enc ?? '')) return `ffmpeg has no ${encoder} encoder`;
  if (!/^\s*V\S*\s+mpeg4\s/m.test(enc ?? '')) return 'ffmpeg has no mpeg4 encoder';
  return null;
}

// ------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------

export interface PalettedBitmap {
  width: number;
  height: number;
  /** Palette indices 0..3 (0 transparent, 1 black, 2 grey, 3 white), row-major. */
  indices: Uint8Array;
}

/** 4-entry palette as [Y, Cr, Cb, A] (studio range, grey). */
export const FIXTURE_PALETTE: [number, number, number, number][] = [
  [16, 128, 128, 0],
  [16, 128, 128, 255],
  [126, 128, 128, 255],
  [235, 128, 128, 255],
];

/** Quantise one RGBA pixel to the fixture palette. */
export function quantizePixel(r: number, g: number, b: number, a: number): number {
  if (a < 128) return 0;
  const l = (r * 299 + g * 587 + b * 114) / 1000;
  return l < 85 ? 1 : l < 170 ? 2 : 3;
}

/** Crop an RGBA frame to its alpha box and quantise it. Returns null for a fully transparent frame. */
export function rgbaToPaletted(rgba: Uint8Array, width: number, height: number): (PalettedBitmap & { x: number; y: number }) | null {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (rgba[row + x * 4 + 3] >= 128) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = ((y + y0) * width + (x + x0)) * 4;
      out[y * w + x] = quantizePixel(rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]);
    }
  }
  return { x: x0, y: y0, width: w, height: h, indices: out };
}

const RENDER_BATCH = 40;

/**
 * Render `texts` with drawtext into paletted bitmaps (cropped to the text). One FFmpeg run per RENDER_BATCH texts.
 */
export async function renderTexts(dir: string, texts: string[], opts: { width: number; fontSize: number }): Promise<PalettedBitmap[]> {
  const font = findFixtureFont();
  if (!font) throw new Error('no font file found for drawtext');
  const work = fs.mkdtempSync(path.join(dir, 'render-'));
  try {
    fs.copyFileSync(font, path.join(work, 'font.ttf'));
    const out: PalettedBitmap[] = [];
    const border = Math.max(2, Math.round(opts.fontSize / 14));
    for (let b = 0; b < texts.length; b += RENDER_BATCH) {
      const batch = texts.slice(b, b + RENDER_BATCH);
      const maxLines = Math.max(...batch.map((t) => t.split('\n').length));
      const stripH = Math.ceil(maxLines * opts.fontSize * 1.4 + 4 * border + 16);
      const W = opts.width;
      const filters: string[] = [`color=c=black@0.0:s=${W}x${stripH}:r=1:d=${batch.length}`, 'format=rgba'];
      batch.forEach((t, i) => {
        // drawtext reads the file verbatim (expansion=none): no escaping of the text itself.
        fs.writeFileSync(path.join(work, `t${i}.txt`), t, 'utf8');
        filters.push(
          `drawtext=fontfile=font.ttf:textfile=t${i}.txt:expansion=none:fontsize=${opts.fontSize}:fontcolor=white`
          + `:borderw=${border}:bordercolor=black:line_spacing=${Math.round(opts.fontSize * 0.2)}`
          + `:x=(w-tw)/2:y=(h-th)/2:enable='eq(n\\,${i})'`,
        );
      });
      fs.writeFileSync(path.join(work, 'graph.txt'), `${filters.join(',')}[o]`, 'utf8');
      const raw = await runCollect(['-filter_complex_script', 'graph.txt', '-map', '[o]', '-frames:v', String(batch.length), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], work);
      const frameBytes = W * stripH * 4;
      if (raw.length < frameBytes * batch.length) throw new Error(`drawtext produced ${raw.length} bytes, expected ${frameBytes * batch.length}`);
      for (let i = 0; i < batch.length; i++) {
        const p = rgbaToPaletted(raw.subarray(i * frameBytes, (i + 1) * frameBytes), W, stripH);
        if (!p) throw new Error(`drawtext rendered nothing for ${JSON.stringify(batch[i])}`);
        out.push({ width: p.width, height: p.height, indices: p.indices });
      }
    }
    return out;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function runCollect(args: string[], cwd: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const bin = ffBin();
    // -filter_complex_script became -/filter_complex in FFmpeg 7 (and was removed in 8).
    const full = adaptFfmpegArgs(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], ffmpegMajorVersionSync(bin));
    const child = spawn(bin, full, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(-2000)}`));
    });
  });
}

// ------------------------------------------------------------------
// PGS writer
// ------------------------------------------------------------------

/** PGS run-length encoding of one bitmap (each line ends with 00 00). */
export function encodePgsRle(bmp: PalettedBitmap): Buffer {
  const bytes: number[] = [];
  const run = (c: number, len: number) => {
    while (len > 0) {
      const l = Math.min(len, 16383);
      len -= l;
      if (c === 0) {
        if (l < 64) bytes.push(0, l);
        else bytes.push(0, 0x40 | (l >> 8), l & 0xff);
      } else if (l <= 2) {
        for (let k = 0; k < l; k++) bytes.push(c);
      } else if (l < 64) {
        bytes.push(0, 0x80 | l, c);
      } else {
        bytes.push(0, 0xc0 | (l >> 8), l & 0xff, c);
      }
    }
  };
  for (let y = 0; y < bmp.height; y++) {
    let x = 0;
    while (x < bmp.width) {
      const c = bmp.indices[y * bmp.width + x];
      let e = x + 1;
      while (e < bmp.width && bmp.indices[y * bmp.width + e] === c) e++;
      run(c, e - x);
      x = e;
    }
    bytes.push(0, 0);
  }
  return Buffer.from(bytes);
}

function segment(type: number, pts: number, payload: Buffer): Buffer {
  if (payload.length > 0xffff) throw new Error('PGS segment too large');
  const h = Buffer.alloc(13);
  h.write('PG', 0, 'latin1');
  h.writeUInt32BE(pts >>> 0, 2);
  h.writeUInt32BE(0, 6);
  h.writeUInt8(type, 10);
  h.writeUInt16BE(payload.length, 11);
  return Buffer.concat([h, payload]);
}

const PCS = 0x16, WDS = 0x17, PDS = 0x14, ODS = 0x15, END = 0x80;

export interface PgsDisplay {
  start: number;
  end: number;
  x: number;
  y: number;
  bitmap: PalettedBitmap;
}

/** Write a PGS elementary stream (.sup contents). Each display gets an epoch start and, unless the next display starts at its end, a clearing display set. */
export function writePgsSup(displays: PgsDisplay[], width: number, height: number): Buffer {
  const parts: Buffer[] = [];
  let comp = 0;
  const pcs = (pts: number, state: number, obj: { x: number; y: number } | null) => {
    const p = Buffer.alloc(11 + (obj ? 8 : 0));
    p.writeUInt16BE(width, 0);
    p.writeUInt16BE(height, 2);
    p.writeUInt8(0x10, 4);
    p.writeUInt16BE(comp++ & 0xffff, 5);
    p.writeUInt8(state, 7);
    p.writeUInt8(0, 8); // palette update flag
    p.writeUInt8(0, 9); // palette id
    p.writeUInt8(obj ? 1 : 0, 10);
    if (obj) {
      p.writeUInt16BE(0, 11); // object id
      p.writeUInt8(0, 13); // window id
      p.writeUInt8(0, 14); // not cropped
      p.writeUInt16BE(obj.x, 15);
      p.writeUInt16BE(obj.y, 17);
    }
    parts.push(segment(PCS, pts, p));
  };
  const wds = (pts: number, d: PgsDisplay) => {
    const p = Buffer.alloc(10);
    p.writeUInt8(1, 0);
    p.writeUInt8(0, 1);
    p.writeUInt16BE(d.x, 2);
    p.writeUInt16BE(d.y, 4);
    p.writeUInt16BE(d.bitmap.width, 6);
    p.writeUInt16BE(d.bitmap.height, 8);
    parts.push(segment(WDS, pts, p));
  };
  const pds = (pts: number) => {
    const p = Buffer.alloc(2 + 5 * FIXTURE_PALETTE.length);
    p.writeUInt8(0, 0);
    p.writeUInt8(0, 1);
    FIXTURE_PALETTE.forEach(([y, cr, cb, a], i) => {
      p.writeUInt8(i, 2 + i * 5);
      p.writeUInt8(y, 3 + i * 5);
      p.writeUInt8(cr, 4 + i * 5);
      p.writeUInt8(cb, 5 + i * 5);
      p.writeUInt8(a, 6 + i * 5);
    });
    parts.push(segment(PDS, pts, p));
  };
  const ods = (pts: number, bmp: PalettedBitmap) => {
    const rle = encodePgsRle(bmp);
    const FIRST_MAX = 0xffff - 11;
    const NEXT_MAX = 0xffff - 4;
    let off = 0;
    let first = true;
    while (first || off < rle.length) {
      const max = first ? FIRST_MAX : NEXT_MAX;
      const chunk = rle.subarray(off, off + max);
      off += chunk.length;
      const last = off >= rle.length;
      const flag = (first ? 0x80 : 0) | (last ? 0x40 : 0);
      const head = Buffer.alloc(first ? 11 : 4);
      head.writeUInt16BE(0, 0);
      head.writeUInt8(0, 2);
      head.writeUInt8(flag, 3);
      if (first) {
        head.writeUIntBE(rle.length + 4, 4, 3);
        head.writeUInt16BE(bmp.width, 7);
        head.writeUInt16BE(bmp.height, 9);
      }
      parts.push(segment(ODS, pts, Buffer.concat([head, chunk])));
      first = false;
    }
  };
  displays.forEach((d, i) => {
    const pts = Math.round(d.start * 90000);
    pcs(pts, 0x80, { x: d.x, y: d.y });
    wds(pts, d);
    pds(pts);
    ods(pts, d.bitmap);
    parts.push(segment(END, pts, Buffer.alloc(0)));
    const next = displays[i + 1];
    if (!next || next.start > d.end + 1e-6) {
      const ept = Math.round(d.end * 90000);
      pcs(ept, 0x00, null);
      wds(ept, d);
      parts.push(segment(END, ept, Buffer.alloc(0)));
    }
  });
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------
// Fixture
// ------------------------------------------------------------------

/**
 * Generate a media file with one bitmap subtitle stream of `opts.codec` carrying `opts.events`.
 * Container: MKV for PGS and DVD, MPEG-TS for DVB, AVI for XSUB. Returns the path and the stream index.
 */
export async function makeBitmapSubsFixture(dir: string, opts: BitmapSubsFixtureOptions): Promise<BitmapSubsFixture> {
  const why = bitmapFixtureUnavailable(opts.codec);
  if (why) throw new Error(`cannot generate ${opts.codec}: ${why}`);
  const events = [...opts.events];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!(e.end > e.start) || e.start < 0) throw new Error(`bad event ${i}: ${e.start}-${e.end}`);
    if (i > 0 && e.start < events[i - 1].end - 1e-9) throw new Error(`event ${i} overlaps the previous one`);
    if (!e.text.trim()) throw new Error(`event ${i} has no text`);
  }
  const isPgs = opts.codec === 'hdmv_pgs_subtitle';
  const width = opts.width ?? (isPgs ? 1920 : 720);
  const height = opts.height ?? (isPgs ? 1080 : 480);
  const fontSize = opts.fontSize ?? Math.max(20, Math.round(height / 18));
  const duration = opts.duration ?? (events.length ? events[events.length - 1].end + 1 : 2);
  const name = opts.name ?? `subs-${opts.codec}`;
  fs.mkdirSync(dir, { recursive: true });

  // Render each distinct text once.
  const distinct = [...new Set(events.map((e) => e.text))];
  const rendered = await renderTexts(dir, distinct, { width: Math.min(width, 1920), fontSize });
  const byText = new Map(distinct.map((t, i) => [t, rendered[i]]));
  const displays: PgsDisplay[] = events.map((e) => {
    const bitmap = byText.get(e.text)!;
    if (bitmap.width > width || bitmap.height > height) throw new Error(`text ${JSON.stringify(e.text)} does not fit the ${width}x${height} canvas`);
    const x = Math.floor((width - bitmap.width) / 2);
    const y = Math.max(0, height - bitmap.height - Math.round(height / 12));
    return { start: e.start, end: e.end, x, y, bitmap };
  });
  const sup = path.join(dir, `${name}.sup`);
  fs.writeFileSync(sup, writePgsSup(displays, width, height));

  // A video (canvas-sized: the XSUB canvas is the video size), 2 fps black, mpeg4 (built into every FFmpeg), plus an
  // optional silent audio stream so the subtitle stream is not always index 1 (PCM: no encoder delay, so no negative
  // start; MPEG-TS gets mp2, which starts 10 ms before the video: see `timeOffset`). `-copyts` keeps the .sup times
  // (FFmpeg would otherwise shift the .sup input so its first subtitle lands at 0).
  const pgsMkv = path.join(dir, isPgs ? `${name}.mkv` : `${name}.pgs.mkv`);
  const inputs = ['-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=2:d=${duration}`];
  const maps = ['-map', '0:v'];
  if (opts.withAudio) {
    inputs.push('-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono:d=${duration}`);
    maps.push('-map', '1:a');
  }
  inputs.push('-f', 'sup', '-i', sup);
  maps.push('-map', `${opts.withAudio ? 2 : 1}:s`);
  ff(['-copyts', ...inputs, ...maps, '-c:v', 'mpeg4', '-q:v', '10', '-g', '600', ...(opts.withAudio ? ['-c:a', 'pcm_s16le'] : []),
    '-c:s', 'copy', '-t', String(duration), pgsMkv]);
  const streamIndex = opts.withAudio ? 2 : 1;

  let outPath = pgsMkv;
  if (!isPgs) {
    const ext = opts.codec === 'dvd_subtitle' ? 'mkv' : opts.codec === 'dvb_subtitle' ? 'ts' : 'avi';
    outPath = path.join(dir, `${name}.${ext}`);
    // Bitmap-to-bitmap transcode. -fix_sub_duration ends each subtitle at the next one (the PGS clear sets).
    ff(['-fix_sub_duration', '-i', pgsMkv, '-map', '0', '-c', 'copy', ...(ext === 'ts' ? ['-c:a', 'mp2', '-b:a', '64k'] : []),
      '-c:s', ENCODER_FOR[opts.codec]!, outPath]);
    fs.rmSync(pgsMkv, { force: true });
  }
  fs.rmSync(sup, { force: true });

  // Where the fixture's t=0 (the video start) lands on ReCut's media timeline (container start_time, clamped at 0, is
  // media time 0; see electron/media/probe.ts). 0 except for MPEG-TS with audio.
  const pr = JSON.parse(execFileSync(getFfprobePath() ?? 'ffprobe', ['-v', 'error', '-print_format', 'json', '-show_entries',
    'format=start_time:stream=codec_type,start_time', outPath], { timeout: 60_000, windowsHide: true }).toString()) as {
    format?: { start_time?: string }; streams?: { codec_type?: string; start_time?: string }[] };
  const fmtStart = Math.max(0, Number(pr.format?.start_time) || 0);
  const vStart = Number(pr.streams?.find((st) => st.codec_type === 'video')?.start_time) || 0;
  const timeOffset = Math.round((vStart - fmtStart) * 1e6) / 1e6;

  return {
    path: outPath,
    timeOffset,
    streamIndex,
    codec: opts.codec,
    width,
    height,
    duration,
    events,
    bitmaps: displays.map((d) => ({ x: d.x, y: d.y, width: d.bitmap.width, height: d.bitmap.height })),
  };
}
