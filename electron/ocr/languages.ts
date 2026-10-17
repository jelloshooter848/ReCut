/**
 * OCR language installer: install (a 'download' job on the network lane, one per language at a time), remove,
 * install from a local file, and the SHA-256 check run before a language is used.
 *
 * Files live in the OCR data folder (`<userData>/ocr/tessdata`, electron/ocr/dataDir.ts) and are always one of
 * the pinned manifest files (shared/ocr.ts OCR_LANGUAGES): a download or a picked file is accepted only when its
 * size and SHA-256 match the manifest. No Electron import, so it stays unit-testable.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ID, JobInfo } from '@shared/model';
import { ocrLanguage, ocrLanguageUrl, type OcrLanguageInfo } from '@shared/ocr';
import type { MediaFetch } from '../ipc';
import type { JobQueue } from '../jobs/jobQueue';
import { inFlightJob, trackInFlight, type InFlight } from '../jobs/inFlight';
import { ensureDirSafe } from '../safeMkdir';
import { ocrLanguagePath } from './dataDir';
import { downloadVerified, renameRetrying, sha256File } from './download';
import { PRODUCT_NAME } from '../../shared/productIdentity';

/** What the installer needs from the media layer (electron/media/index.ts ocrContext()). */
export interface OcrLanguageContext {
  /** The OCR data folder (`<userData>/ocr/tessdata`). */
  dataDir: string;
  /** HTTP client (Electron `net.fetch`); without one, installs fail with a clear message. */
  fetch?: MediaFetch;
  /** Base URL of the language files when overridden for tests (a loopback URL ending in '/'); default TESSDATA_BASE. */
  baseUrl?: string | null;
  /** Active 'download' job per language code (electron/media/index.ts ocrDownloadJobs); kept up to date here. */
  jobs?: Map<string, ID>;
}

/** Result of a finished install job (`JobInfo.result`). */
export interface OcrInstallResult { code: string; bytes: number }

/** In-flight install per language (dedupe). */
const installs: InFlight = new WeakMap();

/** "4.1 MB" (decimal megabytes, as the dialog shows them). */
export function formatOcrSize(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function langOrThrow(code: string): OcrLanguageInfo {
  const lang = ocrLanguage(code);
  if (!lang) throw new Error(`unknown OCR language: ${JSON.stringify(code)}`);
  return lang;
}

/** Download URL of a language, honouring a test base-URL override. */
export function languageUrl(lang: OcrLanguageInfo, baseUrl?: string | null): string {
  return baseUrl ? new URL(lang.file, baseUrl).toString() : ocrLanguageUrl(lang);
}

/** The queued / running install job of `code`, if any. */
export function activeInstallJob(queue: JobQueue, code: string): JobInfo | null {
  return inFlightJob(queue, installs, code);
}

/**
 * Start (or join) the install of one language: a job of kind 'download' titled "Install <Language> OCR data
 * (x MB)". While it runs, a second call returns the same job. Its result is an OcrInstallResult.
 */
export function startInstallJob(queue: JobQueue, code: string, ctx: OcrLanguageContext): JobInfo {
  const lang = langOrThrow(code);
  const existing = inFlightJob(queue, installs, code);
  if (existing) return existing;
  const fetchFn = ctx.fetch;
  if (!fetchFn) throw new Error('Downloading OCR languages is not available here. Use Install from file… instead.');
  const allowLoopback = Boolean(ctx.baseUrl);
  const url = languageUrl(lang, ctx.baseUrl);
  const dest = ocrLanguagePath(ctx.dataDir, code);
  const job = queue.add<OcrInstallResult>({
    kind: 'download',
    title: `Install ${lang.name} OCR data (${formatOcrSize(lang.bytes)})`,
    run: async (jc) => {
      await ensureDirSafe(ctx.dataDir);
      await downloadVerified({
        url, bytes: lang.bytes, sha256: lang.sha256, dest, fetch: fetchFn, signal: jc.signal, allowLoopback,
        onProgress: (f, got) => jc.setProgress(f, `${formatOcrSize(got)} of ${formatOcrSize(lang.bytes)}`),
      });
      return { code, bytes: lang.bytes };
    },
  });
  trackInFlight(queue, installs, code, job.id);
  const jobs = ctx.jobs;
  if (jobs) {
    jobs.set(code, job.id);
    queue.waitFor(job.id).finally(() => { if (jobs.get(code) === job.id) jobs.delete(code); }).catch(() => undefined);
  }
  return job;
}

/** Delete an installed language (and any partial download). Refused while that language is downloading. */
export async function removeLanguage(queue: JobQueue, code: string, ctx: Pick<OcrLanguageContext, 'dataDir'>): Promise<{ ok: boolean; error?: string }> {
  const lang = ocrLanguage(code);
  if (!lang) return { ok: false, error: `unknown OCR language: ${JSON.stringify(code)}` };
  if (inFlightJob(queue, installs, code)) return { ok: false, error: `${lang.name} is downloading. Cancel the download first.` };
  const file = ocrLanguagePath(ctx.dataDir, code);
  try {
    await fsp.rm(file, { force: true });
    await fsp.rm(`${file}.part`, { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Could not remove ${lang.name}: ${(e as Error).message}` };
  }
}

/**
 * Install a language from a file the user picked (the fallback when downloads are blocked). The file must have
 * the manifest size and SHA-256; it is copied to a temp file in the data folder, verified there (so a file that
 * changes while it is copied is never installed) and renamed into place.
 */
export async function installFromFile(queue: JobQueue, code: string, src: string, ctx: Pick<OcrLanguageContext, 'dataDir'>): Promise<{ ok: boolean; error?: string }> {
  const lang = ocrLanguage(code);
  if (!lang) return { ok: false, error: `unknown OCR language: ${JSON.stringify(code)}` };
  if (inFlightJob(queue, installs, code)) return { ok: false, error: `${lang.name} is downloading. Cancel the download first.` };
  let st;
  try { st = await fsp.stat(src); } catch { return { ok: false, error: `${path.basename(src)} was not found.` }; }
  if (!st.isFile()) return { ok: false, error: `${path.basename(src)} is not a file.` };
  const wrong = `${path.basename(src)} is not the ${lang.name} language file ${PRODUCT_NAME} expects (${lang.file}, ${formatOcrSize(lang.bytes)} from tessdata_fast).`;
  if (st.size !== lang.bytes) return { ok: false, error: wrong };
  const dest = ocrLanguagePath(ctx.dataDir, code);
  const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await ensureDirSafe(ctx.dataDir);
    await fsp.copyFile(src, tmp);
    const [size, hash] = [(await fsp.stat(tmp)).size, await sha256File(tmp)];
    if (size !== lang.bytes || hash !== lang.sha256) { await fsp.rm(tmp, { force: true }); return { ok: false, error: wrong }; }
    await renameRetrying(tmp, dest);
    return { ok: true };
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    return { ok: false, error: `Could not install ${lang.name}: ${(e as Error).message}` };
  }
}

/** Result of verifyInstalled: ok, or why the language cannot be used. */
export type OcrVerifyResult = { ok: true; path: string } | { ok: false; reason: 'unknown' | 'missing' | 'damaged'; error: string };

/**
 * Check an installed language before use: the file exists with the manifest size and SHA-256. The OCR job runs
 * this before reading, so a damaged or swapped file is never handed to the engine.
 */
export async function verifyInstalled(dataDir: string, code: string): Promise<OcrVerifyResult> {
  const lang = ocrLanguage(code);
  if (!lang) return { ok: false, reason: 'unknown', error: `unknown OCR language: ${JSON.stringify(code)}` };
  const file = ocrLanguagePath(dataDir, code);
  let size = -1;
  try { const st = await fsp.stat(file); size = st.isFile() ? st.size : -1; } catch { /* missing */ }
  if (size < 0) return { ok: false, reason: 'missing', error: `${lang.name} OCR data is not installed. Install it in OCR Languages….` };
  const damaged = `${lang.name} OCR data is damaged. Remove it and install it again in OCR Languages….`;
  if (size !== lang.bytes) return { ok: false, reason: 'damaged', error: damaged };
  try {
    if (await sha256File(file) !== lang.sha256) return { ok: false, reason: 'damaged', error: damaged };
  } catch (e) {
    return { ok: false, reason: 'missing', error: `${lang.name} OCR data could not be read: ${(e as Error).message}` };
  }
  return { ok: true, path: file };
}
