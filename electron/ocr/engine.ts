/**
 * OCR engine: a pool of Tesseract (tesseract.js 7.0.0 WebAssembly) worker threads.
 *
 * Each worker runs dist/electron/ocr/worker.js (electron/ocr/worker.ts), which loads the packaged LSTM-only core from
 * dist/electron/ocr/core. This module talks to the workers with tesseract.js's worker message protocol
 * ({ workerId, jobId, action, payload } → { jobId, action, status: 'resolve' | 'reject' | 'progress', data }) instead of
 * tesseract.js's createWorker, so that a worker that crashes, fails to load or is terminated mid-job rejects every
 * pending call (createWorker leaves them pending and rethrows rejections from its message handler).
 *
 * Packaged: the worker and core are unpacked from app.asar (electron-builder `asarUnpack: dist/electron/ocr/**`),
 * because worker_threads cannot start a script inside an asar archive, and the core reads its .wasm with plain fs.
 *
 * Settings: OEM LSTM_ONLY, PSM SINGLE_BLOCK (6), preserve_interword_spaces=1, langPath = the local tessdata folder,
 * gzip false, cacheMethod 'none'. The worker's fetch always rejects, so OCR never touches the network.
 *
 * No `electron` import: unit-testable under plain Node (tests/unit/ocr-engine.test.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

export type OcrCoreVariant = 'relaxedsimd-lstm' | 'lstm';

export interface OcrResult {
  /** Recognised text, as Tesseract returns it (lines separated by \n, usually with a trailing \n). */
  text: string;
  /** Tesseract's mean word confidence, 0-100 (0 when nothing was recognised). */
  confidence: number;
}

export interface OcrPoolOptions {
  /** Folder holding `<language>.traineddata` (uncompressed tessdata_fast files). */
  dataDir: string;
  /** Tesseract language code(s), e.g. 'eng' or 'eng+fra'. */
  language: string;
  /** Number of worker threads; default defaultOcrPoolSize(). */
  size?: number;
  /** Override the worker script (tests); default ocrWorkerPath(). */
  workerPath?: string;
  /** Override the core folder (tests); default `<worker dir>/core`. */
  coreDir?: string;
  /** Force a core variant (tests, diagnostics). Default: relaxed SIMD when supported, else plain. */
  core?: OcrCoreVariant;
  /** Aborting terminates the pool (same as terminate()). */
  signal?: AbortSignal;
}

export interface OcrPool {
  readonly size: number;
  /** The core variant the workers loaded. */
  readonly core: OcrCoreVariant;
  /** OCR one image (PGM/PNM, PNG, JPEG, BMP, TIFF, WebP or GIF bytes). Queued until a worker is free. */
  recognize(image: Uint8Array): Promise<OcrResult>;
  /** Stop every worker now. Pending and queued recognize() calls reject. Idempotent. */
  terminate(): Promise<void>;
  /** Live worker threads (0 after terminate). */
  readonly liveWorkers: number;
}

export class OcrCancelledError extends Error {
  constructor(message = 'OCR cancelled') { super(message); this.name = 'OcrCancelledError'; }
}

const LANG_RE = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/;
const OEM_LSTM_ONLY = 1;
const PSM_SINGLE_BLOCK = '6';

/** min(3, cores − 1), at least 1. */
export function defaultOcrPoolSize(cpus = os.cpus().length): number {
  return Math.max(1, Math.min(3, cpus - 1));
}

/** `…/app.asar/…` → `…/app.asar.unpacked/…` (files listed in asarUnpack live there on disk). */
export function unpackedPath(p: string): string {
  return p.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

/**
 * dist/electron/ocr/worker.js next to the bundled main.js (this module is bundled into dist/electron/main.js, so
 * `__dirname` is dist/electron), redirected out of app.asar in a packaged app.
 */
export function ocrWorkerPath(baseDir: string = __dirname): string {
  return unpackedPath(path.join(baseDir, 'ocr', 'worker.js'));
}

/** dist/electron/ocr/core (the licence file Help › About opens lives there too). */
export function ocrCoreDir(baseDir: string = __dirname): string {
  return unpackedPath(path.join(baseDir, 'ocr', 'core'));
}

// ------------------------------------------------------------------
// One worker thread
// ------------------------------------------------------------------

interface Pending { resolve(v: unknown): void; reject(e: Error): void }

let workerCounter = 0;

class OcrThread {
  readonly id = `recut-ocr-${++workerCounter}`;
  private readonly w: Worker;
  private readonly pending = new Map<string, Pending>();
  private jobCounter = 0;
  private dead: Error | null = null;
  private readonly exited: Promise<void>;
  core: OcrCoreVariant | null = null;
  coreError: string | null = null;

  constructor(workerPath: string, data: { coreDir?: string; core?: OcrCoreVariant; debug?: boolean }) {
    this.w = new Worker(workerPath, { workerData: data, stdout: false, stderr: false });
    this.exited = new Promise((resolve) => this.w.once('exit', () => resolve()));
    this.w.on('message', (msg: unknown) => this.onMessage(msg));
    this.w.on('error', (e: Error) => this.fail(new Error(`OCR worker crashed: ${e?.message ?? String(e)}`)));
    this.w.on('exit', (code: number) => this.fail(this.dead ?? new Error(`OCR worker exited unexpectedly (code ${code})`)));
  }

  get alive(): boolean { return this.dead === null; }

  private onMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;
    if (m.recut === 'core') { this.core = m.variant as OcrCoreVariant; return; }
    if (m.recut === 'core-failed') { this.coreError = String(m.error); return; }
    if (m.recut === 'stderr') { console.log(`[ocr ${this.id}] ${String(m.line)}`); return; }
    const key = `${String(m.action)}-${String(m.jobId)}`;
    const p = this.pending.get(key);
    if (!p) return;
    if (m.status === 'resolve') { this.pending.delete(key); p.resolve(m.data); }
    else if (m.status === 'reject') { this.pending.delete(key); p.reject(new Error(String(m.data))); }
    // 'progress': ignored
  }

  /** Reject everything pending and mark the thread dead (first reason wins). */
  private fail(err: Error): void {
    if (!this.dead) this.dead = err;
    for (const p of this.pending.values()) p.reject(this.dead);
    this.pending.clear();
  }

  call(action: string, payload: unknown, transfer?: ArrayBuffer[]): Promise<unknown> {
    if (this.dead) return Promise.reject(this.dead);
    const jobId = `Job-${++this.jobCounter}`;
    return new Promise((resolve, reject) => {
      this.pending.set(`${action}-${jobId}`, { resolve, reject });
      try {
        this.w.postMessage({ workerId: this.id, jobId, action, payload }, transfer);
      } catch (e) {
        this.pending.delete(`${action}-${jobId}`);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  async init(dataDir: string, language: string): Promise<void> {
    await this.call('load', { options: { lstmOnly: true, corePath: '', logging: false } });
    if (this.coreError) throw new Error(`OCR core failed to load: ${this.coreError}`);
    await this.call('loadLanguage', {
      langs: language,
      options: { langPath: dataDir, cachePath: undefined, dataPath: undefined, cacheMethod: 'none', gzip: false, lstmOnly: true },
    });
    await this.call('initialize', { langs: language, oem: OEM_LSTM_ONLY, config: {} });
    await this.call('setParameters', { params: { tessedit_pageseg_mode: PSM_SINGLE_BLOCK, preserve_interword_spaces: '1' } });
  }

  async recognize(image: Uint8Array): Promise<OcrResult> {
    // Copy into a fresh buffer we can transfer (the caller keeps its own).
    const copy = new Uint8Array(image.byteLength);
    copy.set(image);
    const out = await this.call('recognize', { image: copy, options: {}, output: { text: true } }, [copy.buffer]) as
      { text?: string | null; confidence?: number | null };
    return { text: typeof out?.text === 'string' ? out.text : '', confidence: typeof out?.confidence === 'number' ? out.confidence : 0 };
  }

  async terminate(reason: Error): Promise<void> {
    this.fail(reason);
    await this.w.terminate().catch(() => 0);
    await this.exited;
  }
}

// ------------------------------------------------------------------
// Pool
// ------------------------------------------------------------------

function checkOptions(opts: OcrPoolOptions): void {
  if (typeof opts.language !== 'string' || !LANG_RE.test(opts.language)) throw new Error(`Invalid OCR language: ${String(opts.language)}`);
  if (typeof opts.dataDir !== 'string' || !path.isAbsolute(opts.dataDir)) throw new Error('OCR language folder must be an absolute path');
  for (const lang of opts.language.split('+')) {
    const file = path.join(opts.dataDir, `${lang}.traineddata`);
    if (!fs.existsSync(file)) throw new Error(`OCR language data not installed: ${lang} (${file})`);
  }
}

/**
 * Start `size` workers, each with the language loaded. Resolves once every worker is ready; if any fails, all are
 * terminated and the promise rejects with the first error.
 */
export async function createOcrPool(opts: OcrPoolOptions): Promise<OcrPool> {
  checkOptions(opts);
  const size = Math.max(1, Math.floor(opts.size ?? defaultOcrPoolSize()));
  const workerPath = opts.workerPath ?? ocrWorkerPath();
  if (!fs.existsSync(workerPath)) throw new Error(`OCR worker missing: ${workerPath}`);
  const data = { coreDir: opts.coreDir, core: opts.core, debug: process.env.RECUT_OCR_DEBUG === '1' };

  const threads: OcrThread[] = [];
  const queue: { image: Uint8Array; resolve(r: OcrResult): void; reject(e: Error): void }[] = [];
  const idle: OcrThread[] = [];
  let terminated: Error | null = null;
  let terminating: Promise<void> | null = null;

  const terminate = (reason: Error = new OcrCancelledError()): Promise<void> => {
    if (terminating) return terminating;
    terminated = reason;
    for (const q of queue.splice(0)) q.reject(reason);
    idle.length = 0;
    terminating = Promise.all(threads.map((t) => t.terminate(reason))).then(() => undefined);
    return terminating;
  };
  const onAbort = () => { void terminate(); };
  if (opts.signal) {
    if (opts.signal.aborted) throw new OcrCancelledError();
    opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  for (let i = 0; i < size; i++) threads.push(new OcrThread(workerPath, data));
  try {
    await Promise.all(threads.map((t) => t.init(opts.dataDir, opts.language)));
  } catch (e) {
    const err = terminated ?? (e instanceof Error ? e : new Error(String(e)));
    await terminate(err);
    opts.signal?.removeEventListener('abort', onAbort);
    throw err;
  }
  if (terminated) throw terminated;
  const core = threads[0].core ?? 'lstm';

  const pump = () => {
    while (!terminated && idle.length && queue.length) {
      const t = idle.pop()!;
      const job = queue.shift()!;
      t.recognize(job.image).then(
        (r) => { job.resolve(r); if (t.alive) idle.push(t); pump(); },
        (e: Error) => {
          job.reject(terminated ?? e);
          if (t.alive) { idle.push(t); pump(); }
          // A dead worker is not replaced: the job fails, and the caller decides (an OCR job stops on error).
        },
      );
    }
  };
  idle.push(...threads);

  return {
    size,
    core,
    get liveWorkers() { return terminating ? 0 : threads.filter((t) => t.alive).length; },
    recognize(image: Uint8Array): Promise<OcrResult> {
      if (terminated) return Promise.reject(terminated);
      if (!(image instanceof Uint8Array) || image.byteLength === 0) return Promise.reject(new Error('OCR image is empty'));
      if (!threads.some((t) => t.alive)) return Promise.reject(new Error('OCR workers are not running'));
      return new Promise((resolve, reject) => { queue.push({ image, resolve, reject }); pump(); });
    },
    terminate: () => { opts.signal?.removeEventListener('abort', onAbort); return terminate(); },
  };
}

// ------------------------------------------------------------------
// Probe (smoke test, About/Preferences)
// ------------------------------------------------------------------

export interface OcrProbe { core: OcrCoreVariant }

/**
 * Start one worker, load the core (no language needed), report which variant instantiated, and stop it.
 * Rejects when the worker or core cannot be loaded.
 */
export async function probeOcrCore(opts: { workerPath?: string; coreDir?: string; core?: OcrCoreVariant; timeoutMs?: number } = {}): Promise<OcrProbe> {
  const workerPath = opts.workerPath ?? ocrWorkerPath();
  if (!fs.existsSync(workerPath)) throw new Error(`OCR worker missing: ${workerPath}`);
  const t = new OcrThread(workerPath, { coreDir: opts.coreDir, core: opts.core });
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('OCR core probe timed out')), opts.timeoutMs ?? 30_000);
    });
    await Promise.race([t.call('load', { options: { lstmOnly: true, corePath: '', logging: false } }), timeout]);
    if (!t.core) throw new Error(t.coreError ? `OCR core failed to load: ${t.coreError}` : 'OCR core did not report its variant');
    return { core: t.core };
  } finally {
    clearTimeout(timer);
    await t.terminate(new OcrCancelledError('probe finished'));
  }
}
