/**
 * Media layer entry point: wires probe / thumbnails / waveform / proxy / scene detection /
 * subtitle extraction / export onto a single shared JobQueue and exposes them as `MediaHandlers`
 * for electron/ipc.ts.
 *
 * No runtime Electron import (only a type import from ../ipc) so it stays unit-testable.
 */
import type { ID, JobInfo, MediaProbe } from '@shared/model';
import {
  pathToMediaUrl, ffmpegMissingMessage,
  type ExportRequest, type ExportStartResult, type FilmstripRequest, type ProxyRequest,
  type SceneDetectRequest, type ThumbnailRequest, type WaveformData,
} from '@shared/ipc';
import type { OcrLanguageState, OcrRequest } from '@shared/ocr';
import type { MediaContext, MediaFetch, MediaHandlers } from '../ipc';
import { listOcrLanguages, ocrDataDir } from '../ocr/dataDir';
import { parseLangUrlOverride } from '../ocr/download';
import { installFromFile, removeLanguage, startInstallJob } from '../ocr/languages';
import { JobQueue } from '../jobs/jobQueue';
import { buildExportCommand, cancelExportJob, startExportJob } from '../export/exporter';
import { cacheKeyForPath, setCacheDir } from './cache';
import { getFfmpegPath, getFfprobePath, setFfmpegPaths } from './ffmpeg';
import { probeMedia } from './probe';
import { cancelThumbRequests, getFilmstrip, getThumbnail } from './thumbs';
import { getWaveform } from './waveform';
import { startProxyJob } from './proxy';
import { startSceneDetectJob } from './sceneDetect';
import { extractSubtitles } from './subtitlesExtract';

export type { MediaHandlers, MediaContext } from '../ipc';

/** The one job queue shared by proxies, scene detection, waveforms, OCR, language downloads and exports. */
export const jobQueue = new JobQueue();

/**
 * What init() was given that the OCR layer needs: the user-data folder, the HTTP client for downloads and the
 * language base URL when RECUT_OCR_LANG_URL overrides it (tests; only a loopback http(s) URL is accepted).
 */
let ocrCtx: { userData: string; fetch?: MediaFetch; langBaseUrl?: string | null } | null = null;

/** The OCR context from init(); throws before init. */
export function ocrContext(): { userData: string; dataDir: string; fetch?: MediaFetch; langBaseUrl?: string | null } {
  if (!ocrCtx) throw new Error('OCR is not ready yet (the media layer has not started)');
  return { ...ocrCtx, dataDir: ocrDataDir(ocrCtx.userData) };
}

/** Active 'download' job per language code (filled by the language installer). */
export const ocrDownloadJobs = new Map<string, ID>();

function activeDownloadJob(code: string): ID | undefined {
  const id = ocrDownloadJobs.get(code);
  const job = id ? jobQueue.get(id) : undefined;
  return job && (job.status === 'queued' || job.status === 'running') ? job.id : undefined;
}

const notImplemented = (what: string) => new Error(`${what} is not implemented yet`);

export const mediaHandlers: MediaHandlers = {
  init(ctx: MediaContext): void {
    const rawLangUrl = process.env.RECUT_OCR_LANG_URL;
    const langBaseUrl = parseLangUrlOverride(rawLangUrl);
    if (rawLangUrl && !langBaseUrl) console.warn('RECUT_OCR_LANG_URL ignored: only a loopback http(s) URL is accepted');
    ocrCtx = { userData: ctx.userData, fetch: ctx.fetch, langBaseUrl };
    if (ctx.cacheDir) setCacheDir(ctx.cacheDir);
    // Prefer our own resolver (env → bundled → PATH); fall back to whatever the IPC layer found.
    if (!getFfmpegPath() && ctx.ffmpegPath) setFfmpegPaths({ ffmpeg: ctx.ffmpegPath });
    if (!getFfprobePath() && ctx.ffprobePath) setFfmpegPaths({ ffprobe: ctx.ffprobePath });
  },

  shutdown(): void {
    jobQueue.cancelAll();
    jobQueue.flush();
  },

  probe(path: string): Promise<MediaProbe> {
    return probeMedia(path);
  },

  async thumbnail(req: ThumbnailRequest): Promise<string> {
    const file = await getThumbnail(req);
    return pathToMediaUrl(file);
  },

  async filmstrip(req: FilmstripRequest): Promise<string[]> {
    const files = await getFilmstrip(req);
    // '' = frame not produced (request canceled): keep it '' rather than a bare scheme URL.
    return files.map((f) => (f ? pathToMediaUrl(f) : ''));
  },

  async cancelThumbnails(requestIds: string[]): Promise<void> {
    cancelThumbRequests(requestIds);
  },

  async waveform(path: string, _mediaId?: ID, streamIndex?: number): Promise<WaveformData> {
    const key = await cacheKeyForPath(path);
    return getWaveform(path, key, { streamIndex });
  },

  async startProxy(req: ProxyRequest): Promise<JobInfo> {
    if (!getFfmpegPath()) throw new Error(ffmpegMissingMessage('ffmpeg'));
    const { job } = await startProxyJob(jobQueue, req);
    return job;
  },

  async startSceneDetect(req: SceneDetectRequest): Promise<JobInfo> {
    return startSceneDetectJob(jobQueue, req);
  },

  extractSubtitles(path: string, streamIndex: number): Promise<string> {
    return extractSubtitles(path, streamIndex);
  },

  async startOcr(_req: OcrRequest): Promise<JobInfo> {
    throw notImplemented('Reading subtitles with OCR');
  },

  ocrLanguages(): Promise<OcrLanguageState[]> {
    return listOcrLanguages(ocrContext().dataDir, activeDownloadJob);
  },

  async ocrInstallLanguage(code: string): Promise<JobInfo> {
    const c = ocrContext();
    return startInstallJob(jobQueue, code, { dataDir: c.dataDir, fetch: c.fetch, baseUrl: c.langBaseUrl, jobs: ocrDownloadJobs });
  },

  ocrRemoveLanguage(code: string): Promise<{ ok: boolean; error?: string }> {
    return removeLanguage(jobQueue, code, { dataDir: ocrContext().dataDir });
  },

  ocrInstallLanguageFromFile(code: string, path: string): Promise<{ ok: boolean; error?: string }> {
    return installFromFile(jobQueue, code, path, { dataDir: ocrContext().dataDir });
  },

  async listJobs(): Promise<JobInfo[]> {
    return jobQueue.list();
  },

  async cancelJob(id: ID): Promise<void> {
    jobQueue.cancel(id);
  },

  async clearJobs(): Promise<void> {
    jobQueue.clear();
  },

  startExport(req: ExportRequest): Promise<ExportStartResult> {
    return startExportJob(jobQueue, req);
  },

  async cancelExport(jobId: ID): Promise<void> {
    await cancelExportJob(jobQueue, jobId);
  },

  async previewExportCommand(req: ExportRequest): Promise<string[]> {
    return buildExportCommand(req);
  },

  onJobsUpdate(cb: (jobs: JobInfo[]) => void): () => void {
    return jobQueue.subscribe(cb);
  },
};

export default mediaHandlers;
