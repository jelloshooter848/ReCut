/**
 * Timed images from a bitmap subtitle stream (PGS, VobSub, DVB, XSUB), for OCR.
 *
 * Three FFmpeg passes:
 *  1. Isolate: `-copyts -map 0:I -c copy` into a temp .mks (AVI for XSUB, which Matroska and NUT cannot carry).
 *     The only full read of the source: it gives progress and cancel, and leaves passes 2-3 a small file. If the
 *     remux fails, passes 2-3 read the source directly.
 *  2. Timing: `ffprobe -show_frames` gives each subtitle's pts, start/end_display_time and num_rects. Timing comes
 *     from here, not from sub2video, whose frame timing changed between FFmpeg 6 and 8.
 *  3. Pixels: sub2video renders the stream to raw ya8 on stdout (`-canvas_size`, x2 below 720 lines, showinfo for
 *     the pts of every frame). Frames are paired with their showinfo pts, reduced to a cropped image + hash, and
 *     matched to the ffprobe windows by the time FFmpeg's decoder gives them (pts + start_display_time).
 *
 * `assembleEvents` (pure) turns windows + frames into events; `EventAssembler` is the same logic, streaming.
 * `extractBitmapEvents` runs the passes and hands each event to the caller with stdout backpressure, so memory stays
 * flat on a feature film: one raw frame (two, for the duplicate check) plus a bounded queue of cropped images.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FfmpegError, ffmpegFileArg, getFfprobePath, lineSplitter, runFfmpeg, type FfmpegRun } from '../media/ffmpeg';
import { ffmpegMissingMessage } from '../../shared/ipc';

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

/**
 * Bitmap subtitle codecs this pipeline reads (ffprobe codec_name). Local copy: the shared OCR contract
 * (shared/ocr.ts) is expected to export the same set; reconcile when it lands.
 */
export const OCR_BITMAP_CODECS: ReadonlySet<string> = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

/** end_display_time values that mean "unknown" (PGS reports UINT32_MAX; 0 means "until the next one"). */
export const UNKNOWN_END_DISPLAY = new Set([0, 4294967295]);
/** An event whose end is unknown lasts at most this long (seconds). */
export const MAX_UNKNOWN_DURATION = 10;
/** Events shorter than this (seconds, after merging) are dropped. */
export const MIN_EVENT_DURATION = 0.04;
/** Two events are back to back when the gap between them is at most this (seconds): covers the DVD end-time grid
 * (1024/90000 s, ~11.4 ms) while staying under one frame, so a line repeated after a real gap stays two events. */
export const BACK_TO_BACK_GAP = 0.02;
/** Alpha at or above this counts as ink (an x2 bicubic scale leaves faint ringing below it). */
export const ALPHA_INK = 8;
/** Transparent margin kept around the ink box of each image (pixels of the rendered canvas). */
export const IMAGE_PAD = 12;
/** Canvases with fewer lines than this are rendered at twice the size (OCR wants ~30 px text). */
export const UPSCALE_BELOW_HEIGHT = 720;
/** Rendered frames allowed to wait for their showinfo pts before extraction fails. */
const MAX_FRAMES_WITHOUT_PTS = 256;

// ------------------------------------------------------------------
// Pure: ffprobe frames → timing windows
// ------------------------------------------------------------------

/** One decoded subtitle as ffprobe -show_frames reports it. */
export interface ProbeSubtitleFrame {
  /** sub->pts in microseconds (ffprobe `pts` for subtitle frames), file timeline. */
  ptsUs: number;
  /** ms after pts. */
  startDisplay: number;
  /** ms after pts; see UNKNOWN_END_DISPLAY. */
  endDisplay: number;
  numRects: number;
}

/** A span of the stream during which one decoded subtitle (or a clear, numRects 0) is current. */
export interface TimingWindow {
  /** Where FFmpeg's sub2video puts this subtitle (pts + start_display_time; µs, file timeline). */
  decodeUs: number;
  /** Earliest pixel-frame pts (µs) that belongs to this window: decodeUs, or that rounded to the stream time base. */
  matchUs: number;
  /** Display start, seconds on the media timeline (file start_time = 0). */
  start: number;
  /** Explicit display end (seconds, media timeline), or null when the stream does not say. */
  end: number | null;
  numRects: number;
}

interface RawProbeFrame {
  media_type?: string;
  pts?: number | string;
  pts_time?: string;
  start_display_time?: number | string;
  end_display_time?: number | string;
  num_rects?: number | string;
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && v !== 'N/A') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Subtitle frames from ffprobe `-show_frames` JSON (`frames` array). Frames without a pts are skipped. */
export function parseProbeFrames(frames: unknown): ProbeSubtitleFrame[] {
  if (!Array.isArray(frames)) return [];
  const out: ProbeSubtitleFrame[] = [];
  for (const f of frames as RawProbeFrame[]) {
    if (!f || (f.media_type !== undefined && f.media_type !== 'subtitle')) continue;
    let ptsUs = toNum(f.pts);
    if (ptsUs === null) {
      const t = toNum(f.pts_time);
      ptsUs = t === null ? null : Math.round(t * 1e6);
    }
    if (ptsUs === null) continue;
    out.push({
      ptsUs,
      startDisplay: toNum(f.start_display_time) ?? 0,
      endDisplay: toNum(f.end_display_time) ?? 0,
      numRects: Math.max(0, toNum(f.num_rects) ?? 0),
    });
  }
  return out;
}

/** av_rescale_q-style rounding: nearest, halves away from zero. */
function roundHalfAway(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/** `us` rounded to a multiple of the time base `tb` (as FFmpeg 6.x sub2video does), back in µs. */
export function roundToTimeBase(us: number, tb: { num: number; den: number } | null): number {
  if (!tb || !(tb.num > 0) || !(tb.den > 0)) return us;
  const ticks = roundHalfAway((us * tb.den) / (tb.num * 1e6));
  return roundHalfAway((ticks * tb.num * 1e6) / tb.den);
}

export interface TimingOptions {
  /** Seconds subtracted from file timestamps: the source's format start_time (0 when unknown). */
  offset?: number;
  /** Time base of the stream pass 3 decodes (e.g. {1, 1000} for Matroska). */
  timeBase?: { num: number; den: number } | null;
  /**
   * XSUB only: absolute [start, end] seconds read from each packet's "[HH:MM:SS.mmm-HH:MM:SS.mmm]" header, in packet
   * order. Used when there is one per frame; otherwise start_display_time is taken as absolute (FFmpeg 6.1 to 8's
   * xsub decoder subtracts a packet time it misreads as microseconds, which is ~0 for AVI packet indices).
   */
  xsubTimes?: { start: number; end: number }[] | null;
  codec?: string;
}

/** Normalise ffprobe frames into timing windows, sorted by decode time. */
export function buildTimingWindows(frames: ProbeSubtitleFrame[], opts: TimingOptions = {}): TimingWindow[] {
  const offset = opts.offset ?? 0;
  const xsub = opts.codec === 'xsub';
  const headers = xsub && opts.xsubTimes && opts.xsubTimes.length === frames.length ? opts.xsubTimes : null;
  const out = frames.map((f, i): TimingWindow => {
    const decodeUs = f.ptsUs + Math.round(f.startDisplay * 1000);
    const matchUs = Math.min(decodeUs, roundToTimeBase(decodeUs, opts.timeBase ?? null));
    const endKnown = !UNKNOWN_END_DISPLAY.has(f.endDisplay) && f.endDisplay > f.startDisplay;
    let start: number;
    let end: number | null;
    if (headers) {
      start = headers[i].start - offset;
      end = headers[i].end > headers[i].start ? headers[i].end - offset : null;
    } else if (xsub) {
      start = f.startDisplay / 1000 - offset;
      end = endKnown ? f.endDisplay / 1000 - offset : null;
    } else {
      start = decodeUs / 1e6 - offset;
      end = endKnown ? (f.ptsUs + f.endDisplay * 1000) / 1e6 - offset : null;
    }
    return { decodeUs, matchUs, start, end, numRects: f.numRects };
  });
  // Stable sort by decode time (decoders emit in order; this only guards odd muxes).
  return out.map((w, i) => ({ w, i })).sort((a, b) => a.w.decodeUs - b.w.decodeUs || a.i - b.i).map((x) => x.w);
}

// ------------------------------------------------------------------
// Pure: windows + pixel frames → events
// ------------------------------------------------------------------

/** What the assembler needs to know about one sub2video frame. */
export interface PixelFrame<P = unknown> {
  /** showinfo pts in µs (settb=AVTB). */
  ptsUs: number;
  blank: boolean;
  /** Content hash of the (cropped) image; equal hash = same picture. Ignored when blank. */
  hash: string;
  payload?: P;
}

export interface AssembledEvent<P = unknown> {
  start: number;
  end: number;
  hash: string;
  /** 0-based, in order of first appearance. */
  imageId: number;
  /** First event showing this image. Later events with the same imageId reuse its OCR text. */
  isNewImage: boolean;
  payload?: P;
}

interface PendingEvent<P> { start: number; end: number; hash: string; payload?: P }

/**
 * Streaming form of `assembleEvents`: feed frames in pts order with `push`, then call `finish`. Events are emitted in
 * order through `emit` as soon as they are final (a window is final once a later frame arrives; merging holds one).
 *
 * Rules:
 *  - window k runs from its matchUs to the next window's; a frame belongs to the last window with matchUs <= pts;
 *  - an event's image is the first non-blank frame of its window that differs from the previous event's image (a
 *    repeat of the previous picture can sit right at the boundary), else the first non-blank one; no image → no event;
 *  - start = window start; end = min(explicit end, next window's start, media duration), and when the end is unknown
 *    at most start + MAX_UNKNOWN_DURATION;
 *  - back-to-back events (gap <= BACK_TO_BACK_GAP) with the same hash merge; then events < MIN_EVENT_DURATION drop;
 *  - imageId numbers unique hashes; isNewImage marks the first event of each.
 */
export class EventAssembler<P = unknown> {
  private cur = -1;
  private chosen: PixelFrame<P> | null = null;
  private fallback: PixelFrame<P> | null = null;
  private prevWindowHash: string | null = null;
  private pending: PendingEvent<P> | null = null;
  private ids = new Map<string, number>();
  private finished = false;
  emitted = 0;

  constructor(
    private readonly windows: TimingWindow[],
    private readonly duration: number,
    private readonly emit: (ev: AssembledEvent<P>) => void,
  ) {}

  /** End of window k by the rules above. */
  endOf(k: number): number {
    const w = this.windows[k];
    let end = Number.POSITIVE_INFINITY;
    if (w.end !== null) end = Math.min(end, w.end);
    const next = this.windows[k + 1];
    if (next) end = Math.min(end, next.start);
    if (this.duration > 0) end = Math.min(end, this.duration);
    if (w.end === null || !Number.isFinite(end)) end = Math.min(end, w.start + MAX_UNKNOWN_DURATION);
    return end;
  }

  push(f: PixelFrame<P>): void {
    if (this.finished) throw new Error('EventAssembler: push after finish');
    const ws = this.windows;
    while (this.cur + 1 < ws.length && ws[this.cur + 1].matchUs <= f.ptsUs) {
      if (this.cur >= 0) this.closeWindow(this.cur);
      this.cur++;
    }
    if (this.cur < 0 || f.blank) return;
    const w = ws[this.cur];
    if (w.numRects <= 0) return;
    if (this.chosen) return;
    if (this.prevWindowHash === null || f.hash !== this.prevWindowHash) this.chosen = f;
    else if (!this.fallback) this.fallback = f;
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.cur >= 0) this.closeWindow(this.cur);
    // Windows that never got a frame have no image: nothing to emit for them.
    this.cur = this.windows.length;
    this.flushPending();
  }

  private closeWindow(k: number): void {
    const w = this.windows[k];
    const img = this.chosen ?? this.fallback;
    this.chosen = null;
    this.fallback = null;
    if (w.numRects <= 0 || !img) {
      this.prevWindowHash = null;
      return;
    }
    this.prevWindowHash = img.hash;
    const ev: PendingEvent<P> = { start: w.start, end: this.endOf(k), hash: img.hash, payload: img.payload };
    const p = this.pending;
    if (p && p.hash === ev.hash && Math.abs(ev.start - p.end) <= BACK_TO_BACK_GAP && ev.end >= p.end) {
      p.end = ev.end;
      return;
    }
    this.flushPending();
    this.pending = ev;
  }

  private flushPending(): void {
    const p = this.pending;
    this.pending = null;
    if (!p || !(p.end - p.start >= MIN_EVENT_DURATION - 1e-9)) return;
    let id = this.ids.get(p.hash);
    const isNew = id === undefined;
    if (id === undefined) {
      id = this.ids.size;
      this.ids.set(p.hash, id);
    }
    this.emitted++;
    this.emit({ start: p.start, end: p.end, hash: p.hash, imageId: id, isNewImage: isNew, payload: p.payload });
  }

  get uniqueImages(): number { return this.ids.size; }
}

/** Pure, batch form of EventAssembler. `pixelFrames` must be in pts order. */
export function assembleEvents<P = unknown>(windows: TimingWindow[], pixelFrames: PixelFrame<P>[], duration: number): AssembledEvent<P>[] {
  const out: AssembledEvent<P>[] = [];
  const a = new EventAssembler<P>(windows, duration, (e) => out.push(e));
  for (const f of pixelFrames) a.push(f);
  a.finish();
  return out;
}

// ------------------------------------------------------------------
// Pure: raw ya8 frame → cropped image + hash
// ------------------------------------------------------------------

export interface Ya8Image {
  width: number;
  height: number;
  /** Interleaved gray, alpha: 2 bytes per pixel, row-major. */
  data: Uint8Array;
}

export interface CroppedImage extends Ya8Image {
  /** Position of the crop in the rendered canvas (rendered pixels: canvas x scale). */
  x: number;
  y: number;
}

export interface FrameAnalysis {
  blank: boolean;
  hash: string;
  image: CroppedImage | null;
}

/** Bounding box of pixels with alpha >= ALPHA_INK in a ya8 frame, or null when there are none. */
export function ya8InkBox(data: Uint8Array, width: number, height: number, minAlpha = ALPHA_INK): { x0: number; y0: number; x1: number; y1: number } | null {
  const rowBytes = width * 2;
  const rowHasInk = (y: number): boolean => {
    const base = y * rowBytes;
    for (let i = base + 1; i < base + rowBytes; i += 2) if (data[i] >= minAlpha) return true;
    return false;
  };
  let y0 = -1;
  // Fast blank scan: 4 bytes = 2 pixels; alpha bytes are 1 and 3. Only valid for the >= 8 threshold mask.
  if (minAlpha === 8 && data.byteOffset % 4 === 0 && data.length % 4 === 0) {
    const u32 = new Uint32Array(data.buffer, data.byteOffset, data.length / 4);
    const mask = os.endianness() === 'LE' ? 0xf800f800 : 0x00f800f8;
    let first = -1;
    for (let i = 0; i < u32.length; i++) if (u32[i] & mask) { first = i; break; }
    if (first < 0) return null;
    y0 = Math.floor((first * 4) / rowBytes);
  } else {
    for (let y = 0; y < height; y++) if (rowHasInk(y)) { y0 = y; break; }
    if (y0 < 0) return null;
  }
  let y1 = y0;
  for (let y = height - 1; y > y0; y--) if (rowHasInk(y)) { y1 = y; break; }
  let x0 = width, x1 = -1;
  for (let y = y0; y <= y1; y++) {
    const base = y * rowBytes;
    for (let x = 0; x < x0; x++) if (data[base + x * 2 + 1] >= minAlpha) { x0 = x; break; }
    for (let x = width - 1; x > x1; x--) if (data[base + x * 2 + 1] >= minAlpha) { x1 = x; break; }
  }
  if (x1 < x0) return null;
  return { x0, y0, x1, y1 };
}

/** Crop a ya8 frame to its ink box plus `pad` (clipped to the frame), copy it out and hash it. */
export function analyzeYa8Frame(data: Uint8Array, width: number, height: number, pad = IMAGE_PAD): FrameAnalysis {
  const box = ya8InkBox(data, width, height);
  if (!box) return { blank: true, hash: '', image: null };
  const x = Math.max(0, box.x0 - pad);
  const y = Math.max(0, box.y0 - pad);
  const w = Math.min(width, box.x1 + 1 + pad) - x;
  const h = Math.min(height, box.y1 + 1 + pad) - y;
  const out = new Uint8Array(w * h * 2);
  for (let r = 0; r < h; r++) {
    const src = ((y + r) * width + x) * 2;
    out.set(data.subarray(src, src + w * 2), r * w * 2);
  }
  const hash = createHash('sha1').update(`${w}x${h}@${x},${y}:`).update(out).digest('hex');
  return { blank: false, hash, image: { width: w, height: h, x, y, data: out } };
}

// ------------------------------------------------------------------
// Pure: showinfo / xsub headers
// ------------------------------------------------------------------

/** showinfo line → { n, ptsUs } (pts is in µs because the graph ends with settb=AVTB), or null. */
export function parseShowinfoFrame(line: string): { n: number; ptsUs: number } | null {
  const m = /\bn:\s*(\d+)\s+pts:\s*(-?\d+)/.exec(line);
  if (!m) return null;
  return { n: parseInt(m[1], 10), ptsUs: parseInt(m[2], 10) };
}

const XSUB_HEADER = /\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})-(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/g;

/** Scanner for XSUB packet headers in a byte stream (chunks may split a header). */
export function xsubHeaderScanner(): { push(chunk: Uint8Array): void; times: { start: number; end: number }[] } {
  let carry = '';
  const times: { start: number; end: number }[] = [];
  return {
    times,
    push(chunk) {
      const text = carry + Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length).toString('latin1');
      XSUB_HEADER.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = XSUB_HEADER.exec(text))) {
        const n = m.slice(1).map((s) => parseInt(s, 10));
        times.push({ start: n[0] * 3600 + n[1] * 60 + n[2] + n[3] / 1000, end: n[4] * 3600 + n[5] * 60 + n[6] + n[7] / 1000 });
      }
      // A 27-byte header cannot fit in 26 carried bytes, so nothing is counted twice.
      carry = text.slice(-26);
    },
  };
}

// ------------------------------------------------------------------
// Extraction
// ------------------------------------------------------------------

export interface BitmapEvent {
  /** 0-based, in emission (time) order. */
  index: number;
  /** Seconds on the media timeline. */
  start: number;
  end: number;
  imageId: number;
  /** First event showing this image: OCR it; later events with the same imageId reuse the text. */
  isNewImage: boolean;
  /** The image cropped to its ink (+IMAGE_PAD), ya8, in rendered pixels (canvas x `scale`). */
  image: CroppedImage;
}

export type ExtractPhase = 'isolate' | 'probe' | 'render';

export interface ExtractPlan {
  /** Subtitles with pixels in the stream (an upper bound on events: merging and dropping only remove). */
  expectedEvents: number;
  canvas: { width: number; height: number; scale: number };
  /** True when passes 2-3 read the isolated copy; false when the remux failed and they read the source. */
  isolated: boolean;
}

export interface ExtractBitmapEventsOptions {
  /** Absolute source path. */
  path: string;
  /** ffprobe stream index of the bitmap subtitle stream. */
  streamIndex: number;
  /** ffprobe codec_name; must be in OCR_BITMAP_CODECS. */
  codec: string;
  /** Media duration in seconds (ends are capped at it); <= 0 or omitted = unknown. */
  duration?: number;
  signal?: AbortSignal;
  /** Progress within each phase, 0..1. */
  onProgress?: (phase: ExtractPhase, fraction: number) => void;
  /** Called once, after the timing pass. */
  onPlan?: (plan: ExtractPlan) => void;
  /**
   * Called per event, in order. May be async: while it runs, at most `maxQueuedEvents` further events wait and FFmpeg
   * is paused. Throwing aborts the extraction.
   */
  onEvent: (ev: BitmapEvent) => void | Promise<void>;
  /** Parent for the temp folder. Default os.tmpdir(). */
  tempDir?: string;
  /** Default 8. */
  maxQueuedEvents?: number;
}

export interface ExtractBitmapEventsResult {
  events: number;
  uniqueImages: number;
  probeFrames: number;
  pixelFrames: number;
  canvas: { width: number; height: number; scale: number };
  isolated: boolean;
}

function canceledError(): FfmpegError {
  return new FfmpegError('bitmap subtitle extraction canceled', { canceled: true });
}

/** ffprobe → JSON with abort support (runFfprobeJson has none). */
function ffprobeJson<T>(args: string[], signal?: AbortSignal): Promise<T> {
  const bin = getFfprobePath();
  if (!bin) return Promise.reject(new FfmpegError(ffmpegMissingMessage('ffprobe'), {}));
  if (signal?.aborted) return Promise.reject(canceledError());
  return new Promise<T>((resolve, reject) => {
    const child = spawn(bin, ['-v', 'error', '-print_format', 'json', ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    const errLines: string[] = [];
    const errSplit = lineSplitter((l) => { errLines.push(l); if (errLines.length > 30) errLines.shift(); });
    let aborted = false;
    const onAbort = () => { aborted = true; try { child.kill('SIGKILL'); } catch { /* gone */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => errSplit.push(c));
    let spawnError: Error | null = null;
    child.on('error', (e) => { spawnError = e; });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      errSplit.flush();
      if (aborted) return reject(canceledError());
      if (spawnError) return reject(new FfmpegError(`failed to run ffprobe: ${(spawnError as Error).message}`, {}));
      if (code !== 0) return reject(new FfmpegError(`ffprobe exited with code ${code}: ${errLines.slice(-10).join('\n')}`, { code, stderr: errLines.join('\n') }));
      try { resolve(JSON.parse(Buffer.concat(out).toString('utf8') || '{}') as T); } catch (e) { reject(new FfmpegError(`ffprobe produced invalid JSON: ${(e as Error).message}`, {})); }
    });
  });
}

interface ProbeStream { index?: number; codec_type?: string; codec_name?: string; width?: number; height?: number; time_base?: string }
interface ProbeJson { streams?: ProbeStream[]; frames?: unknown[]; format?: { start_time?: string; duration?: string } }

function parseTimeBase(s: string | undefined): { num: number; den: number } | null {
  const m = /^(\d+)\/(\d+)$/.exec(s ?? '');
  if (!m) return null;
  const num = parseInt(m[1], 10), den = parseInt(m[2], 10);
  return num > 0 && den > 0 ? { num, den } : null;
}

async function scanXsubFile(file: string, signal?: AbortSignal): Promise<{ start: number; end: number }[]> {
  const scanner = xsubHeaderScanner();
  const stream = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  for await (const chunk of stream) {
    if (signal?.aborted) { stream.destroy(); throw canceledError(); }
    scanner.push(chunk as Buffer);
  }
  return scanner.times;
}

/** Canvas for sub2video: the stream's own size, else the video's, at least 720x576 for DVB (its default). */
export function chooseCanvas(codec: string, streamSize: { width?: number; height?: number } | null, videoSize: { width?: number; height?: number } | null): { width: number; height: number } {
  const sw = streamSize?.width ?? 0, sh = streamSize?.height ?? 0;
  const vw = videoSize?.width ?? 0, vh = videoSize?.height ?? 0;
  let w = sw > 0 && sh > 0 ? sw : vw > 0 && vh > 0 ? vw : 0;
  let h = sw > 0 && sh > 0 ? sh : vw > 0 && vh > 0 ? vh : 0;
  if (codec === 'dvb_subtitle') { w = Math.max(w, 720); h = Math.max(h, 576); }
  if (!(w > 0 && h > 0)) {
    if (codec === 'hdmv_pgs_subtitle') { w = 1920; h = 1080; } else { w = 720; h = 576; }
  }
  // Even sizes keep every ya8 row 4-byte aligned overall and suit the x2 scale.
  return { width: Math.min(8192, w + (w % 2)), height: Math.min(8192, h + (h % 2)) };
}

/** Pass 3 filter graph for input stream `inputStream` of file 0. */
export function sub2videoGraph(inputStream: number, scale: number): string {
  const s = scale > 1 ? `scale=iw*${scale}:ih*${scale}:flags=bicubic,` : '';
  return `[0:${inputStream}]${s}format=ya8,settb=AVTB,showinfo[o]`;
}

/**
 * Run the three passes and hand each event to `onEvent`. Resolves when every event has been handled; rejects with
 * FfmpegError{canceled:true} on abort. Temp files are removed in every case.
 */
export async function extractBitmapEvents(opts: ExtractBitmapEventsOptions): Promise<ExtractBitmapEventsResult> {
  const { signal } = opts;
  const codec = (opts.codec ?? '').toLowerCase();
  if (!OCR_BITMAP_CODECS.has(codec)) throw new Error(`subtitle codec ${codec || 'unknown'} cannot be read with OCR`);
  if (!Number.isInteger(opts.streamIndex) || opts.streamIndex < 0) throw new Error(`bad stream index ${opts.streamIndex}`);
  const srcArg = ffmpegFileArg(opts.path); // asserts an absolute path
  if (signal?.aborted) throw canceledError();

  const tmp = await fsp.mkdtemp(path.join(opts.tempDir ?? os.tmpdir(), 'recut-ocr-'));
  let render: FfmpegRun | null = null;
  try {
    // ---- source facts (header only)
    const src = await ffprobeJson<ProbeJson>(['-show_entries', 'format=start_time,duration:stream=index,codec_type,codec_name,width,height,time_base', srcArg], signal);
    // Media time 0 is the container start_time, clamped at 0 (as probeMedia does: a negative start from audio priming
    // does not move the video).
    const offset = Math.max(0, toNum(src.format?.start_time) ?? 0);
    const duration = opts.duration && opts.duration > 0 ? opts.duration : (toNum(src.format?.duration) ?? 0);
    const srcStream = (src.streams ?? []).find((s) => s.index === opts.streamIndex);
    if (!srcStream || srcStream.codec_type !== 'subtitle') throw new Error(`stream ${opts.streamIndex} of ${path.basename(opts.path)} is not a subtitle stream`);
    const video = (src.streams ?? []).find((s) => s.codec_type === 'video' && (s.width ?? 0) > 0);

    // ---- pass 1: isolate
    const isoPath = path.join(tmp, codec === 'xsub' ? 'stream.avi' : 'stream.mks');
    let isolated = false;
    const iso = runFfmpeg(['-copyts', '-i', srcArg, '-map', `0:${opts.streamIndex}`, '-c', 'copy', '-f', codec === 'xsub' ? 'avi' : 'matroska', ffmpegFileArg(isoPath)], {
      duration: duration > 0 ? duration + offset : undefined,
      signal,
      onProgress: (p) => opts.onProgress?.('isolate', p),
    });
    try {
      await iso.promise;
      isolated = true;
    } catch (e) {
      if ((e instanceof FfmpegError && e.canceled) || signal?.aborted) throw canceledError();
      isolated = false; // fall back to the source
    }
    opts.onProgress?.('isolate', 1);
    const readArg = isolated ? ffmpegFileArg(isoPath) : srcArg;
    const readStream = isolated ? 0 : opts.streamIndex;

    // ---- pass 2: timing
    const probe = await ffprobeJson<ProbeJson>(['-select_streams', String(readStream), '-show_streams', '-show_frames',
      '-show_entries', 'stream=index,codec_name,width,height,time_base:frame=media_type,pts,pts_time,start_display_time,end_display_time,num_rects', readArg], signal);
    const frames = parseProbeFrames(probe.frames);
    const pStream = (probe.streams ?? [])[0] ?? srcStream;
    let xsubTimes: { start: number; end: number }[] | null = null;
    if (codec === 'xsub') xsubTimes = await scanXsubFile(isolated ? isoPath : opts.path, signal);
    const windows = buildTimingWindows(frames, { offset, timeBase: parseTimeBase(pStream.time_base), xsubTimes, codec });
    const canvas = chooseCanvas(codec, { width: pStream.width ?? srcStream.width, height: pStream.height ?? srcStream.height }, video ?? null);
    const scale = canvas.height < UPSCALE_BELOW_HEIGHT ? 2 : 1;
    const plan: ExtractPlan = { expectedEvents: windows.filter((w) => w.numRects > 0).length, canvas: { ...canvas, scale }, isolated };
    opts.onProgress?.('probe', 1);
    opts.onPlan?.(plan);
    if (plan.expectedEvents === 0) {
      opts.onProgress?.('render', 1);
      return { events: 0, uniqueImages: 0, probeFrames: frames.length, pixelFrames: 0, canvas: plan.canvas, isolated };
    }

    // ---- pass 3: pixels
    const W = canvas.width * scale, H = canvas.height * scale;
    const frameBytes = W * H * 2;
    let cur = Buffer.allocUnsafeSlow(frameBytes);
    let prev = Buffer.allocUnsafeSlow(frameBytes);
    let prevAnalysis: FrameAnalysis | null = null;
    let filled = 0;
    let pixelFrames = 0;
    const pendingFrames: FrameAnalysis[] = [];
    const pendingPts: number[] = [];
    let nextN = 0;
    const firstUs = windows[0].matchUs;
    const lastUs = windows[windows.length - 1].decodeUs;

    const queue: BitmapEvent[] = [];
    const maxQueued = Math.max(1, opts.maxQueuedEvents ?? 8);
    let wake: (() => void) | null = null;
    const notify = () => { const w = wake; wake = null; w?.(); };
    let producerDone = false;
    let failure: unknown = null;
    let index = 0;

    const assembler = new EventAssembler<CroppedImage>(windows, duration, (ev) => {
      queue.push({ index: index++, start: ev.start, end: ev.end, imageId: ev.imageId, isNewImage: ev.isNewImage, image: ev.payload! });
      notify();
    });

    let paused = false;
    const updateFlow = () => {
      const stdout = render?.child?.stdout;
      if (!stdout) return;
      const shouldPause = queue.length >= maxQueued;
      if (shouldPause && !paused) { paused = true; stdout.pause(); } else if (!shouldPause && paused) { paused = false; stdout.resume(); }
    };

    const drainPairs = () => {
      while (pendingFrames.length && pendingPts.length) {
        const a = pendingFrames.shift()!;
        const ptsUs = pendingPts.shift()!;
        assembler.push({ ptsUs, blank: a.blank, hash: a.hash, payload: a.image ?? undefined });
        if (lastUs > firstUs) opts.onProgress?.('render', Math.max(0, Math.min(1, (ptsUs - firstUs) / (lastUs - firstUs))));
      }
      updateFlow();
    };

    const onFrame = () => {
      pixelFrames++;
      let a: FrameAnalysis;
      if (prevAnalysis && cur.equals(prev)) a = prevAnalysis;
      else a = analyzeYa8Frame(cur, W, H);
      prevAnalysis = a;
      const t = prev; prev = cur; cur = t;
      pendingFrames.push(a);
      drainPairs();
      // stderr normally runs ahead of stdout. Frames piling up without a pts means showinfo output is not being
      // parsed (a changed log format): fail rather than pair frames with the wrong times.
      if (pendingFrames.length > MAX_FRAMES_WITHOUT_PTS && !failure) {
        failure = new Error('could not read frame times from FFmpeg (showinfo output not recognised)');
        render?.cancel();
      }
    };

    const onStdout = (chunk: Buffer) => {
      let off = 0;
      while (off < chunk.length) {
        const n = Math.min(frameBytes - filled, chunk.length - off);
        chunk.copy(cur, filled, off, off + n);
        filled += n;
        off += n;
        if (filled === frameBytes) { filled = 0; onFrame(); }
      }
    };

    const onStderrLine = (line: string) => {
      const f = parseShowinfoFrame(line);
      if (!f) return;
      if (f.n !== nextN) return; // out of sequence (should not happen); never pair a frame with the wrong pts
      nextN++;
      pendingPts.push(f.ptsUs);
      drainPairs();
    };

    const consumer = (async () => {
      for (;;) {
        if (failure) return;
        if (signal?.aborted) throw canceledError();
        const ev = queue.shift();
        if (!ev) {
          if (producerDone) return;
          await new Promise<void>((r) => { wake = r; });
          continue;
        }
        updateFlow();
        await opts.onEvent(ev);
      }
    })();
    consumer.catch((e) => {
      failure = failure ?? e;
      render?.cancel();
    });

    render = runFfmpeg(['-copyts', '-canvas_size', `${canvas.width}x${canvas.height}`, '-i', readArg,
      '-filter_complex', sub2videoGraph(readStream, scale), '-map', '[o]', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'ya8', '-'], {
      stdout: 'data',
      loglevel: 'info',
      stderrLines: 60,
      signal,
      onStdout,
      onStderrLine,
    });
    try {
      await render.promise;
    } catch (e) {
      if (failure) throw failure;
      if ((e instanceof FfmpegError && e.canceled) || signal?.aborted) throw canceledError();
      throw e;
    } finally {
      render = null;
    }
    // Frames still waiting for a pts (should not happen) are dropped.
    assembler.finish();
    producerDone = true;
    notify();
    await consumer;
    if (failure) throw failure;
    if (signal?.aborted) throw canceledError();
    opts.onProgress?.('render', 1);
    return { events: assembler.emitted, uniqueImages: assembler.uniqueImages, probeFrames: frames.length, pixelFrames, canvas: plan.canvas, isolated };
  } finally {
    if (render) {
      const r: FfmpegRun = render;
      r.cancel();
      await r.promise.catch(() => undefined);
    }
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
