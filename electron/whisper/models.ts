/**
 * Whisper model installer: where models live (`<userData>/whisper/models/ggml-<id>.bin`), install (a 'download' job on
 * the network lane, one per model at a time, resumable), cancel (the job), remove, install from a local file, the
 * install state of every model with disk usage, and the SHA-256 check run before a model is used.
 *
 * Models are always one of the pinned manifest files (shared/whisper.ts WHISPER_MODELS): a download or a picked file
 * is accepted only when its size and SHA-256 match. Downloads use the shared verified downloader
 * (electron/net/download.ts) with the Hugging Face policy: https://huggingface.co, redirects within WHISPER_REDIRECT_DOMAINS.
 * No Electron import, so it stays unit-testable.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ID, JobInfo } from '@shared/model';
import {
  WHISPER_MODELS, WHISPER_MODELS_ORIGIN, WHISPER_REDIRECT_DOMAINS, whisperModelUrl,
  type WhisperModelInfo, type WhisperModelState,
} from '@shared/whisper';
import type { MediaFetch } from '../ipc';
import type { JobQueue } from '../jobs/jobQueue';
import { inFlightJob, trackInFlight, type InFlight } from '../jobs/inFlight';
import { ensureDirSafe } from '../safeMkdir';
import { downloadVerified, renameRetrying, sha256File, type DownloadPolicy } from '../net/download';

/**
 * Model downloads: start at https://huggingface.co; redirects only over https (default port) to Hugging Face's own
 * domains, huggingface.co and hf.co and their subdomains (its storage and CDN hosts change by region and over time,
 * issue #102). The pinned SHA-256 guarantees the file.
 */
export const WHISPER_DOWNLOAD_POLICY: DownloadPolicy = {
  origins: [WHISPER_MODELS_ORIGIN], redirectDomains: WHISPER_REDIRECT_DOMAINS, provider: 'Hugging Face',
};

/** The Whisper folder of a user-data folder (`<userData>/whisper`). */
export function whisperDir(userData: string): string {
  return path.join(userData, 'whisper');
}

/** The models folder of a user-data folder (`<userData>/whisper/models`). */
export function whisperModelsDir(userData: string): string {
  return path.join(whisperDir(userData), 'models');
}

// ------------------------------------------------------------------
// Manifest (+ test models)
// ------------------------------------------------------------------

let testModels: WhisperModelInfo[] = [];

/**
 * Tests only: extra models (e2e with a loopback model server and a generated model). electron/media/index.ts calls
 * this only for an unpackaged app with a loopback RECUT_WHISPER_MODEL_URL, so a release build never lists them.
 */
export function setTestWhisperModels(models: WhisperModelInfo[]): void {
  testModels = models.filter((m) => /^test-[a-z0-9.-]+$/.test(m.id) && /^ggml-test-[a-z0-9.-]+\.bin$/.test(m.file));
}

/** Parse RECUT_WHISPER_TEST_MODEL ("<bytes>:<sha256>") into the one test model, or null. */
export function parseTestModelSpec(v: string | undefined | null): WhisperModelInfo | null {
  const m = typeof v === 'string' ? /^(\d+):([0-9a-f]{64})$/.exec(v.trim()) : null;
  if (!m) return null;
  return { id: 'test-tiny', name: 'Test (tiny)', file: 'ggml-test-tiny.bin', bytes: Number(m[1]), sha256: m[2], englishOnly: false, note: 'Test model' };
}

/** Every installable model (the manifest, plus test models in tests). */
export function allWhisperModels(): readonly WhisperModelInfo[] {
  return testModels.length ? [...WHISPER_MODELS, ...testModels] : WHISPER_MODELS;
}

/** The model with this id, or undefined. */
export function findWhisperModel(id: unknown): WhisperModelInfo | undefined {
  return typeof id === 'string' ? allWhisperModels().find((m) => m.id === id) : undefined;
}

/** A model id ReCut can install; throws otherwise (IPC argument check). */
export function assertWhisperModelId(v: unknown): string {
  if (!findWhisperModel(v)) throw new Error(`unknown Whisper model: ${JSON.stringify(typeof v === 'string' ? v.slice(0, 40) : v)}`);
  return v as string;
}

function modelOrThrow(id: string): WhisperModelInfo {
  const m = findWhisperModel(id);
  if (!m) throw new Error(`unknown Whisper model: ${JSON.stringify(id)}`);
  return m;
}

/** Path of a model's file in `dir`. Throws for an id that is not in the manifest. */
export function whisperModelPath(dir: string, id: string): string {
  return path.join(dir, modelOrThrow(id).file);
}

/** "466 MB" / "1.6 GB" (decimal units, as the dialogs show them). */
export function formatModelSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------

async function fileSize(p: string): Promise<number> {
  try {
    const st = await fsp.stat(p);
    return st.isFile() ? st.size : -1;
  } catch {
    return -1;
  }
}

/** Every model with its install state. `jobFor(id)` names the active 'download' job installing a model, if any. */
export async function listWhisperModels(dir: string, jobFor?: (id: string) => string | undefined): Promise<WhisperModelState[]> {
  return Promise.all(allWhisperModels().map(async (m): Promise<WhisperModelState> => {
    const file = path.join(dir, m.file);
    const [size, part] = await Promise.all([fileSize(file), fileSize(`${file}.part`)]);
    const state: WhisperModelState = {
      id: m.id, name: m.name, bytes: m.bytes, englishOnly: m.englishOnly, note: m.note,
      installed: size === m.bytes, partialBytes: part > 0 && part < m.bytes ? part : 0,
    };
    const jobId = jobFor?.(m.id);
    if (jobId) state.jobId = jobId;
    return state;
  }));
}

/** Bytes used by the models folder (installed models and partial downloads). */
export async function whisperModelsDiskUsage(dir: string): Promise<number> {
  let total = 0;
  let names: string[];
  try { names = await fsp.readdir(dir); } catch { return 0; }
  for (const n of names) {
    const s = await fileSize(path.join(dir, n));
    if (s > 0) total += s;
  }
  return total;
}

// ------------------------------------------------------------------
// Install / remove
// ------------------------------------------------------------------

/** What the installer needs from the media layer (electron/media/index.ts). */
export interface WhisperModelContext {
  /** The models folder (`<userData>/whisper/models`). */
  modelsDir: string;
  /** HTTP client (Electron `net.fetch`); without one, installs fail with a clear message. */
  fetch?: MediaFetch;
  /** Base URL of the model files when overridden for tests (a loopback URL ending in '/'); default WHISPER_MODELS_BASE. */
  baseUrl?: string | null;
  /** Active 'download' job per model id; kept up to date here. */
  jobs?: Map<string, ID>;
}

/** Result of a finished install job (`JobInfo.result`). */
export interface WhisperInstallResult { model: string; bytes: number }

/** In-flight install per model (dedupe). */
const installs: InFlight = new WeakMap();

/** Download URL of a model, honouring a test base-URL override. */
export function modelDownloadUrl(model: WhisperModelInfo, baseUrl?: string | null): string {
  return baseUrl ? new URL(model.file, baseUrl).toString() : whisperModelUrl(model);
}

/** The queued / running install job of `id`, if any. */
export function activeModelInstallJob(queue: JobQueue, id: string): JobInfo | null {
  return inFlightJob(queue, installs, id);
}

/** Job title of a model install: "Install Whisper model Small (488 MB)". */
export function modelInstallTitle(model: WhisperModelInfo): string {
  return `Install Whisper model ${model.name} (${formatModelSize(model.bytes)})`;
}

/**
 * Start (or join) the install of one model: a job of kind 'download'. A partial download left by a cancel-free
 * interruption (network error, quit) is resumed with an HTTP Range request. While it runs, a second call returns the
 * same job. Its result is a WhisperInstallResult. Cancel removes the partial file.
 */
export function startModelInstallJob(queue: JobQueue, id: string, ctx: WhisperModelContext): JobInfo {
  const model = modelOrThrow(id);
  const existing = inFlightJob(queue, installs, id);
  if (existing) return existing;
  const fetchFn = ctx.fetch;
  if (!fetchFn) throw new Error('Downloading Whisper models is not available here. Use Install from file… instead.');
  const allowLoopback = Boolean(ctx.baseUrl);
  const url = modelDownloadUrl(model, ctx.baseUrl);
  const dest = path.join(ctx.modelsDir, model.file);
  const job = queue.add<WhisperInstallResult>({
    kind: 'download',
    title: modelInstallTitle(model),
    run: async (jc) => {
      await ensureDirSafe(ctx.modelsDir);
      await downloadVerified({
        url, bytes: model.bytes, sha256: model.sha256, dest, fetch: fetchFn, signal: jc.signal, allowLoopback,
        policy: WHISPER_DOWNLOAD_POLICY,
        onProgress: (f, got) => jc.setProgress(f, `${formatModelSize(got)} of ${formatModelSize(model.bytes)}`),
      });
      verified.set(dest, { size: model.bytes, mtimeMs: (await fsp.stat(dest)).mtimeMs, sha256: model.sha256 });
      return { model: id, bytes: model.bytes };
    },
  });
  trackInFlight(queue, installs, id, job.id);
  const jobs = ctx.jobs;
  if (jobs) {
    jobs.set(id, job.id);
    queue.waitFor(job.id).finally(() => { if (jobs.get(id) === job.id) jobs.delete(id); }).catch(() => undefined);
  }
  return job;
}

/** Delete an installed model (and any partial download). Refused while that model is downloading. */
export async function removeModel(queue: JobQueue, id: string, ctx: Pick<WhisperModelContext, 'modelsDir'>): Promise<{ ok: boolean; error?: string }> {
  const model = findWhisperModel(id);
  if (!model) return { ok: false, error: `unknown Whisper model: ${JSON.stringify(id)}` };
  if (inFlightJob(queue, installs, id)) return { ok: false, error: `The ${model.name} model is downloading. Cancel the download first.` };
  const file = path.join(ctx.modelsDir, model.file);
  try {
    await fsp.rm(file, { force: true });
    await fsp.rm(`${file}.part`, { force: true });
    verified.delete(file);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Could not remove the ${model.name} model: ${(e as Error).message}` };
  }
}

/**
 * Install a model from a file the user picked (the fallback when downloads are blocked). The file must have the
 * manifest size and SHA-256; it is copied to a temp file in the models folder, verified there (so a file that changes
 * while it is copied is never installed) and renamed into place.
 */
export async function installModelFromFile(queue: JobQueue, id: string, src: string, ctx: Pick<WhisperModelContext, 'modelsDir'>): Promise<{ ok: boolean; error?: string }> {
  const model = findWhisperModel(id);
  if (!model) return { ok: false, error: `unknown Whisper model: ${JSON.stringify(id)}` };
  if (inFlightJob(queue, installs, id)) return { ok: false, error: `The ${model.name} model is downloading. Cancel the download first.` };
  let st;
  try { st = await fsp.stat(src); } catch { return { ok: false, error: `${path.basename(src)} was not found.` }; }
  if (!st.isFile()) return { ok: false, error: `${path.basename(src)} is not a file.` };
  const wrong = `${path.basename(src)} is not the ${model.name} model ReCut expects (${model.file}, ${formatModelSize(model.bytes)} from the whisper.cpp model repository).`;
  if (st.size !== model.bytes) return { ok: false, error: wrong };
  const dest = path.join(ctx.modelsDir, model.file);
  const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await ensureDirSafe(ctx.modelsDir);
    await fsp.copyFile(src, tmp);
    const [size, hash] = [(await fsp.stat(tmp)).size, await sha256File(tmp)];
    if (size !== model.bytes || hash !== model.sha256) { await fsp.rm(tmp, { force: true }); return { ok: false, error: wrong }; }
    await renameRetrying(tmp, dest);
    await fsp.rm(`${dest}.part`, { force: true }).catch(() => undefined);
    verified.set(dest, { size: model.bytes, mtimeMs: (await fsp.stat(dest)).mtimeMs, sha256: model.sha256 });
    return { ok: true };
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    return { ok: false, error: `Could not install the ${model.name} model: ${(e as Error).message}` };
  }
}

// ------------------------------------------------------------------
// Verify before use
// ------------------------------------------------------------------

/**
 * Files already hashed in this session (path → size, mtime and the hash they had): a 1.6 GB model is hashed once per
 * session, not before every transcription. Any change of size or mtime hashes it again.
 */
const verified = new Map<string, { size: number; mtimeMs: number; sha256: string }>();

/** Tests: forget the hashes remembered this session. */
export function _resetVerifiedModels(): void { verified.clear(); }

/** Result of verifyModel: ok, or why the model cannot be used. */
export type WhisperVerifyResult = { ok: true; path: string } | { ok: false; reason: 'unknown' | 'missing' | 'damaged'; error: string };

/**
 * Check an installed model before use: the file exists with the manifest size and SHA-256 (hashed once per session
 * while its size and mtime stay the same). The transcription job runs this first, so a damaged or swapped file is
 * never handed to the engine.
 */
export async function verifyModel(modelsDir: string, id: string, signal?: AbortSignal): Promise<WhisperVerifyResult> {
  const model = findWhisperModel(id);
  if (!model) return { ok: false, reason: 'unknown', error: `unknown Whisper model: ${JSON.stringify(id)}` };
  const file = path.join(modelsDir, model.file);
  let st: { size: number; mtimeMs: number } | null = null;
  try { const s = await fsp.stat(file); if (s.isFile()) st = { size: s.size, mtimeMs: s.mtimeMs }; } catch { /* missing */ }
  if (!st) return { ok: false, reason: 'missing', error: `The ${model.name} Whisper model is not installed. Install it in Transcription Models….` };
  const damaged = `The ${model.name} Whisper model is damaged. Remove it and install it again in Transcription Models….`;
  if (st.size !== model.bytes) return { ok: false, reason: 'damaged', error: damaged };
  const seen = verified.get(file);
  if (seen && seen.size === st.size && seen.mtimeMs === st.mtimeMs && seen.sha256 === model.sha256) return { ok: true, path: file };
  try {
    const hash = await sha256File(file, signal);
    if (hash !== model.sha256) { verified.delete(file); return { ok: false, reason: 'damaged', error: damaged }; }
  } catch (e) {
    if (signal?.aborted) throw e;
    return { ok: false, reason: 'missing', error: `The ${model.name} Whisper model could not be read: ${(e as Error).message}` };
  }
  verified.set(file, { ...st, sha256: model.sha256 });
  return { ok: true, path: file };
}
