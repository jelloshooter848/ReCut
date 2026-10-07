/**
 * Media layer entry point: wires probe / thumbnails / waveform / proxy / scene detection /
 * subtitle extraction / export onto a single shared JobQueue and exposes them as `MediaHandlers`
 * for electron/ipc.ts.
 *
 * No runtime Electron import (only a type import from ../ipc) so it stays unit-testable.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ID, JobInfo, MediaProbe } from '@shared/model';
import {
  pathToMediaUrl, ffmpegMissingMessage,
  type ExportRequest, type ExportStartResult, type FilmstripRequest, type ProxyRequest, type ChannelProxyRequest,
  type SceneDetectRequest, type ThumbnailRequest, type WaveformData,
} from '@shared/ipc';
import type { OcrLanguageState, OcrRequest } from '@shared/ocr';
import type { MediaContext, MediaFetch, MediaHandlers } from '../ipc';
import { listOcrLanguages, ocrDataDir } from '../ocr/dataDir';
import { parseLangUrlOverride } from '../ocr/download';
import { installFromFile, removeLanguage, startInstallJob } from '../ocr/languages';
import { startOcrJob } from '../ocr/ocrJob';
import type { TranscribeRequest, WhisperEngineInfo, WhisperModelState } from '@shared/whisper';
import { parseLoopbackBaseUrl } from '../net/download';
import { getWhisperCliPath, whisperCliVersion } from '../whisper/engine';
import {
  installModelFromFile, listWhisperModels, parseTestModelSpec, removeModel, setTestWhisperModels, startModelInstallJob,
  whisperDir, whisperModelsDir,
} from '../whisper/models';
import { startTranscribeJob } from '../whisper/transcribeJob';
import { JobQueue } from '../jobs/jobQueue';
import { ensureDirSafe } from '../safeMkdir';
import { buildExportCommand, cancelExportJob, startExportJob } from '../export/exporter';
import { collectPreflight, startCollectJob } from '../project/collect';
import type { CollectRequest, CollectStartResult, CollectSummary } from '@shared/collect';
import { cacheKeysForPath, setCacheDir } from './cache';
import { getFfmpegPath, getFfprobePath, setFfmpegPaths } from './ffmpeg';
import { probeMedia } from './probe';
import { cancelThumbRequests, getFilmstrip, getThumbnail } from './thumbs';
import { getWaveform } from './waveform';
import { startProxyJob } from './proxy';
import { startChannelProxyJob } from './channelProxy';
import { startSceneDetectJob } from './sceneDetect';
import { extractSubtitles } from './subtitlesExtract';

export type { MediaHandlers, MediaContext } from '../ipc';

/** The one job queue shared by proxies, scene detection, waveforms, OCR, transcription, downloads and exports. */
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

/**
 * What init() was given that the Whisper layer needs: the user-data folder, the HTTP client for model downloads and
 * the model base URL when RECUT_WHISPER_MODEL_URL overrides it (tests; only a loopback http(s) URL is accepted).
 */
let whisperCtx: { userData: string; fetch?: MediaFetch; modelBaseUrl?: string | null } | null = null;

/** The Whisper context from init(); throws before init. */
export function whisperContext(): { userData: string; modelsDir: string; tempRoot: string; fetch?: MediaFetch; modelBaseUrl?: string | null } {
  if (!whisperCtx) throw new Error('Transcription is not ready yet (the media layer has not started)');
  return { ...whisperCtx, modelsDir: whisperModelsDir(whisperCtx.userData), tempRoot: path.join(whisperDir(whisperCtx.userData), 'tmp') };
}

/** Active 'download' job per Whisper model id (filled by the model installer). */
export const whisperDownloadJobs = new Map<string, ID>();

function activeModelJob(id: string): ID | undefined {
  const jobId = whisperDownloadJobs.get(id);
  const job = jobId ? jobQueue.get(jobId) : undefined;
  return job && (job.status === 'queued' || job.status === 'running') ? job.id : undefined;
}

/** Engine version, read once (whisper-cli --version). */
let engineVersion: Promise<string> | null = null;

function activeDownloadJob(code: string): ID | undefined {
  const id = ocrDownloadJobs.get(code);
  const job = id ? jobQueue.get(id) : undefined;
  return job && (job.status === 'queued' || job.status === 'running') ? job.id : undefined;
}

export const mediaHandlers: MediaHandlers = {
  init(ctx: MediaContext): void {
    const rawLangUrl = process.env.RECUT_OCR_LANG_URL;
    const langBaseUrl = parseLangUrlOverride(rawLangUrl);
    if (rawLangUrl && !langBaseUrl) console.warn('RECUT_OCR_LANG_URL ignored: only a loopback http(s) URL is accepted');
    ocrCtx = { userData: ctx.userData, fetch: ctx.fetch, langBaseUrl };
    const rawModelUrl = process.env.RECUT_WHISPER_MODEL_URL;
    const modelBaseUrl = parseLoopbackBaseUrl(rawModelUrl);
    if (rawModelUrl && !modelBaseUrl) console.warn('RECUT_WHISPER_MODEL_URL ignored: only a loopback http(s) URL is accepted');
    whisperCtx = { userData: ctx.userData, fetch: ctx.fetch, modelBaseUrl };
    // Tests only: a generated model served by a loopback model server, never in a packaged app.
    const testModel = modelBaseUrl && ctx.packaged === false ? parseTestModelSpec(process.env.RECUT_WHISPER_TEST_MODEL) : null;
    setTestWhisperModels(testModel ? [testModel] : []);
    // Temp folders of transcriptions that never finished (a crash, a forced quit): nothing runs yet, so remove them.
    void fsp.rm(whisperContext().tempRoot, { recursive: true, force: true }).catch(() => undefined);
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
    const { key, legacyKey } = await cacheKeysForPath(path);
    return getWaveform(path, key, { streamIndex, legacyKey });
  },

  async startProxy(req: ProxyRequest): Promise<JobInfo> {
    if (!getFfmpegPath()) throw new Error(ffmpegMissingMessage('ffmpeg'));
    const { job } = await startProxyJob(jobQueue, req);
    return job;
  },

  async startChannelProxy(req: ChannelProxyRequest): Promise<JobInfo> {
    if (!getFfmpegPath()) throw new Error(ffmpegMissingMessage('ffmpeg'));
    return startChannelProxyJob(jobQueue, req);
  },

  async startSceneDetect(req: SceneDetectRequest): Promise<JobInfo> {
    return startSceneDetectJob(jobQueue, req);
  },

  extractSubtitles(path: string, streamIndex: number): Promise<string> {
    return extractSubtitles(path, streamIndex);
  },

  async startOcr(req: OcrRequest): Promise<JobInfo> {
    if (!getFfmpegPath()) throw new Error(ffmpegMissingMessage('ffmpeg'));
    return startOcrJob(jobQueue, req, { dataDir: ocrContext().dataDir });
  },

  async ocrLanguages(): Promise<OcrLanguageState[]> {
    const { dataDir } = ocrContext();
    // Create the (app-owned) folder up front so "Open folder" has something to show before the first install.
    await ensureDirSafe(dataDir).catch(() => undefined);
    return listOcrLanguages(dataDir, activeDownloadJob);
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

  async startTranscribe(req: TranscribeRequest): Promise<JobInfo> {
    if (!getFfmpegPath()) throw new Error(ffmpegMissingMessage('ffmpeg'));
    const c = whisperContext();
    return startTranscribeJob(jobQueue, req, { modelsDir: c.modelsDir, tempRoot: c.tempRoot });
  },

  async whisperEngine(): Promise<WhisperEngineInfo> {
    const { modelsDir } = whisperContext();
    const bin = getWhisperCliPath();
    if (!bin) return { path: null, version: null, modelsDir, error: 'The speech-to-text engine (whisper-cli) is not included in this build of ReCut.' };
    engineVersion ??= whisperCliVersion(bin);
    try {
      return { path: bin, version: await engineVersion, modelsDir };
    } catch (e) {
      engineVersion = null; // try again next time
      return { path: bin, version: null, modelsDir, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async whisperModels(): Promise<WhisperModelState[]> {
    const { modelsDir } = whisperContext();
    // Create the (app-owned) folder up front so "Open folder" has something to show before the first install.
    await ensureDirSafe(modelsDir).catch(() => undefined);
    return listWhisperModels(modelsDir, activeModelJob);
  },

  async whisperInstallModel(id: string): Promise<JobInfo> {
    const c = whisperContext();
    return startModelInstallJob(jobQueue, id, { modelsDir: c.modelsDir, fetch: c.fetch, baseUrl: c.modelBaseUrl, jobs: whisperDownloadJobs });
  },

  whisperRemoveModel(id: string): Promise<{ ok: boolean; error?: string }> {
    return removeModel(jobQueue, id, { modelsDir: whisperContext().modelsDir });
  },

  whisperInstallModelFromFile(id: string, file: string): Promise<{ ok: boolean; error?: string }> {
    return installModelFromFile(jobQueue, id, file, { modelsDir: whisperContext().modelsDir });
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

  collectPreflight(req: CollectRequest): Promise<CollectSummary> {
    return collectPreflight(req);
  },

  startCollect(req: CollectRequest): Promise<CollectStartResult> {
    return startCollectJob(jobQueue, req);
  },

  onJobsUpdate(cb: (jobs: JobInfo[]) => void): () => void {
    return jobQueue.subscribe(cb);
  },
};

export default mediaHandlers;
