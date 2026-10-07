/**
 * The OCR job: one bitmap subtitle stream (PGS / VobSub / DVB / XSUB) → timed text cues, as a job of kind 'ocr'
 * (background lane, one at a time).
 *
 *  1. Check the language file (size + SHA-256 against the manifest; a missing or damaged file is a clear error).
 *  2. Cache: `ocr/<file key>_s<stream>_<lang>-<sha8>_v<pipeline>-<core>.json` (written via `.part` + rename). A hit
 *     returns at once with `cached: true`.
 *  3. Start the Tesseract worker pool (while FFmpeg isolates the stream) and extract the events
 *     (electron/ocr/bitmapEvents.ts). Each new image is split into bands (preprocess.ts) and every band is read on the
 *     pool, several images at a time; a band read with low confidence is read again with the polarity flipped and the
 *     better reading kept. Later events showing the same image reuse its text.
 *  4. Cues: one per event with text, in time order; consecutive events with the same text that touch are merged.
 *
 * Progress: isolate 0-25 %, probe at 25 %, render + OCR 25-100 % ("n/N events"). Cancel aborts FFmpeg and terminates
 * the worker pool; the pool is always terminated when the job ends. No Electron import (unit-testable).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { JobInfo, SubtitleCue } from '@shared/model';
import { uid } from '@shared/ids';
import { isOcrCodec, ocrLanguage, type OcrRequest, type OcrResult } from '@shared/ocr';
import type { JobQueue, JobRunContext } from '../jobs/jobQueue';
import { inFlightJob, trackInFlight, type InFlight } from '../jobs/inFlight';
import { cacheKeyForPath, cacheSubdir, fileExists, removeQuietly } from '../media/cache';
import { FfmpegError } from '../media/ffmpeg';
import { probeMedia } from '../media/probe';
import { extractBitmapEvents, type BitmapEvent } from './bitmapEvents';
import { createOcrPool, defaultOcrPoolSize, OcrCancelledError, type OcrCoreVariant, type OcrPool } from './engine';
import { verifyInstalled } from './languages';
import { joinBands } from './postprocess';
import { encodePgm, flipPolarity, prepareForOcr, type Ya8 } from './preprocess';

/** Bump when a change to extraction / preprocessing / clean-up changes the text or timing of a result. */
export const OCR_PIPELINE_VERSION = 1;
/** A band read with a mean confidence under this is read again with the polarity flipped. */
export const FLIP_RETRY_CONFIDENCE = 50;
/** Two cues with the same text are merged when the gap between them is at most this (seconds). */
export const MERGE_TOUCH_GAP = 0.02;

const CORE_VARIANTS: OcrCoreVariant[] = ['relaxedsimd-lstm', 'lstm'];

/** What the OCR job needs besides the request. */
export interface OcrJobContext {
  /** The OCR data folder (`<userData>/ocr/tessdata`). */
  dataDir: string;
  /** Worker pool size; default defaultOcrPoolSize(). */
  poolSize?: number;
  /** Override the worker script / core folder (tests). */
  workerPath?: string;
  coreDir?: string;
  /** Parent of the extraction temp folder (tests). Default os.tmpdir(). */
  tempDir?: string;
  /** Tests: called with the worker pool once it has started. */
  onPool?: (pool: OcrPool) => void;
}

/** Cache file of one OCR result. `sha8` is the start of the language file's SHA-256; `core` the engine core variant. */
export function ocrCachePath(fileKey: string, streamIndex: number, language: string, sha8: string, core: OcrCoreVariant): string {
  return path.join(cacheSubdir('ocr'), `${fileKey}_s${streamIndex}_${language}-${sha8}_v${OCR_PIPELINE_VERSION}-${core}.json`);
}

/** Core variant the pool loaded last in this process (the machine's CPU decides; it does not change). */
let lastCore: OcrCoreVariant | null = null;

function isCue(v: unknown): v is SubtitleCue {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return typeof c.id === 'string' && typeof c.text === 'string' && Number.isFinite(c.start) && Number.isFinite(c.end);
}

async function readCache(file: string, req: OcrRequest): Promise<OcrResult | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as Partial<OcrResult>;
    if (!Array.isArray(raw.cues) || !raw.cues.every(isCue) || typeof raw.codec !== 'string') return null;
    return {
      mediaId: req.mediaId, streamIndex: req.streamIndex, language: req.language, codec: raw.codec,
      // Fresh cue ids: a second read of the same stream must not share ids with the first track.
      cues: raw.cues.map((c) => ({ id: uid('cue'), start: c.start, end: c.end, text: c.text })),
      events: typeof raw.events === 'number' ? raw.events : raw.cues.length,
      cached: true,
    };
  } catch {
    return null;
  }
}

async function writeCache(file: string, result: OcrResult): Promise<void> {
  const part = `${file}.part`;
  try {
    const { cached: _c, mediaId: _m, ...rest } = result;
    await fsp.writeFile(part, JSON.stringify(rest));
    await fsp.rename(part, file);
  } catch {
    await removeQuietly(part);
  }
}

/** Read one band: as prepared, and flipped when that reads poorly; the better of the two. */
async function readBand(pool: OcrPool, band: ReturnType<typeof prepareForOcr>[number]): Promise<string> {
  const first = await pool.recognize(band.pgm);
  if (first.confidence >= FLIP_RETRY_CONFIDENCE) return first.text;
  const flipped = await pool.recognize(encodePgm(flipPolarity(band)));
  return flipped.confidence > first.confidence ? flipped.text : first.text;
}

/** OCR one subtitle image: bands read in parallel on the pool, cleaned and joined top to bottom. */
export async function readImage(pool: OcrPool, image: Ya8): Promise<string> {
  const bands = prepareForOcr(image);
  if (bands.length === 0) return '';
  const texts = await Promise.all(bands.map((b) => readBand(pool, b)));
  return joinBands(texts);
}

/** Events + their text → cues: skip empty text, merge consecutive identical text that touches. */
export function buildCues(events: { start: number; end: number; text: string }[]): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const ev of events) {
    if (!ev.text) continue;
    const last = cues[cues.length - 1];
    if (last && last.text === ev.text && ev.start - last.end <= MERGE_TOUCH_GAP && ev.start >= last.start) {
      last.end = Math.max(last.end, ev.end);
      continue;
    }
    cues.push({ id: uid('cue'), start: ev.start, end: ev.end, text: ev.text });
  }
  return cues;
}

function canceled(): FfmpegError {
  return new FfmpegError('OCR canceled', { canceled: true });
}

/** Run one OCR request (the body of the job). */
export async function runOcr(req: OcrRequest, ctx: OcrJobContext, jc: JobRunContext): Promise<OcrResult> {
  const lang = ocrLanguage(req.language);
  if (!lang) throw new Error(`unknown OCR language: ${JSON.stringify(req.language)}`);
  jc.setProgress(0, `Checking ${lang.name} OCR data…`);
  const verified = await verifyInstalled(ctx.dataDir, req.language);
  if (!verified.ok) throw new Error(verified.error);
  if (jc.signal.aborted) throw canceled();

  const fileKey = await cacheKeyForPath(req.path);
  const sha8 = lang.sha256.slice(0, 8);
  const cacheFor = (core: OcrCoreVariant) => ocrCachePath(fileKey, req.streamIndex, req.language, sha8, core);
  for (const core of lastCore ? [lastCore] : CORE_VARIANTS) {
    const file = cacheFor(core);
    if (!(await fileExists(file))) continue;
    const hit = await readCache(file, req);
    if (hit) {
      jc.setProgress(1, `${hit.cues.length} lines (cached)`);
      return hit;
    }
  }

  const probe = await probeMedia(req.path);
  const stream = probe.subtitles.find((s) => s.index === req.streamIndex);
  if (!stream) throw new Error(`${path.basename(req.path)} has no subtitle stream #${req.streamIndex}`);
  const codec = (stream.codec ?? '').toLowerCase();
  if (!isOcrCodec(codec)) throw new Error(`subtitle stream #${req.streamIndex} (${codec || 'unknown codec'}) cannot be read with OCR`);
  if (jc.signal.aborted) throw canceled();

  // Start the workers while FFmpeg isolates the stream.
  const poolPromise = createOcrPool({
    dataDir: ctx.dataDir, language: req.language, size: ctx.poolSize ?? defaultOcrPoolSize(), signal: jc.signal,
    workerPath: ctx.workerPath, coreDir: ctx.coreDir,
  });
  poolPromise.catch(() => undefined); // handled where awaited
  let pool: OcrPool | null = null;
  const getPool = async () => {
    if (!pool) { pool = await poolPromise; ctx.onPool?.(pool); }
    return pool;
  };

  const texts = new Map<number, string>();
  const events: { start: number; end: number; imageId: number }[] = [];
  const pending = new Set<Promise<void>>();
  let failure: unknown = null;
  let expected = 0;
  let done = 0;
  const report = () => {
    const total = Math.max(expected, done);
    jc.setProgress(0.25 + 0.75 * (total > 0 ? done / total : 0), `${done}/${total} events`);
  };

  try {
    const summary = await extractBitmapEvents({
      path: req.path,
      streamIndex: req.streamIndex,
      codec,
      duration: probe.duration,
      signal: jc.signal,
      tempDir: ctx.tempDir,
      onProgress: (phase, f) => {
        if (phase === 'isolate') jc.setProgress(0.25 * f, `Reading stream #${req.streamIndex}…`);
        else if (phase === 'probe') jc.setProgress(0.25, 'Finding subtitles…');
      },
      onPlan: (plan) => { expected = plan.expectedEvents; report(); },
      onEvent: async (ev: BitmapEvent) => {
        if (failure) throw failure;
        events.push({ start: ev.start, end: ev.end, imageId: ev.imageId });
        if (!ev.isNewImage) { done++; report(); return; }
        const p = getPool()
          .then((pl) => readImage(pl, ev.image))
          .then(
            (text) => { texts.set(ev.imageId, text); done++; report(); },
            (e: unknown) => { failure ??= e; },
          )
          .finally(() => { pending.delete(p); });
        pending.add(p);
        // Keep every worker busy (images have 1-2 bands) without holding many images in memory.
        const pl = await getPool();
        while (pending.size >= pl.size * 2 && !failure) await Promise.race(pending);
        if (failure) throw failure;
      },
    });
    await Promise.all(pending);
    if (failure) throw failure;
    if (jc.signal.aborted) throw canceled();

    const cues = buildCues(events.map((e) => ({ start: e.start, end: e.end, text: texts.get(e.imageId) ?? '' })));
    const { core } = await getPool();
    const result: OcrResult = {
      mediaId: req.mediaId, streamIndex: req.streamIndex, language: req.language, codec, cues, events: summary.events, cached: false,
    };
    await writeCache(cacheFor(core), result);
    jc.setProgress(1, `${cues.length} lines from ${summary.events} events`);
    return result;
  } catch (e) {
    if (jc.signal.aborted || e instanceof OcrCancelledError) throw canceled();
    throw e;
  } finally {
    // Never leave workers running: terminate the pool, also when it is still starting.
    const pl = pool ?? await poolPromise.catch(() => null);
    if (pl) {
      lastCore = pl.core;
      await pl.terminate().catch(() => undefined);
    }
    await Promise.allSettled([...pending]);
  }
}

/** In-flight OCR per path|stream|language (dedupe). */
const inFlightOcr: InFlight = new WeakMap();

/** Job title: "Read subtitles with OCR: film.mkv #3 (English)". */
export function ocrJobTitle(req: OcrRequest): string {
  const name = ocrLanguage(req.language)?.name ?? req.language;
  return `Read subtitles with OCR: ${path.basename(req.path)} #${req.streamIndex} (${name})`;
}

/**
 * Start (or join) the OCR of one stream. While a job for the same file, stream and language is queued or running,
 * that job is returned. Its result is an OcrResult.
 */
export function startOcrJob(queue: JobQueue, req: OcrRequest, ctx: OcrJobContext): JobInfo {
  const key = `${req.path}|${req.streamIndex}|${req.language}`;
  const existing = inFlightJob(queue, inFlightOcr, key);
  if (existing) return existing;
  const job = queue.add<OcrResult>({
    kind: 'ocr',
    title: ocrJobTitle(req),
    mediaId: req.mediaId,
    run: (jc) => runOcr(req, ctx, jc),
  });
  trackInFlight(queue, inFlightOcr, key, job.id);
  return job;
}

/** Tests: forget the remembered core variant. */
export function _resetOcrJobState(): void {
  lastCore = null;
}
