/**
 * Media layer entry point: wires probe / thumbnails / waveform / proxy / scene detection /
 * subtitle extraction / export onto a single shared JobQueue and exposes them as `MediaHandlers`
 * for electron/ipc.ts.
 *
 * No runtime Electron import (only a type import from ../ipc) so it stays unit-testable.
 */
import type { ID, JobInfo, MediaProbe } from '@shared/model';
import {
  pathToMediaUrl,
  type ExportRequest, type ExportStartResult, type FilmstripRequest, type ProxyRequest,
  type SceneDetectRequest, type ThumbnailRequest, type WaveformData,
} from '@shared/ipc';
import type { MediaContext, MediaHandlers } from '../ipc';
import { JobQueue } from '../jobs/jobQueue';
import { buildExportCommand, cancelExportJob, startExportJob } from '../export/exporter';
import { cacheKeyForPath, setCacheDir } from './cache';
import { getFfmpegPath, getFfprobePath, setFfmpegPaths } from './ffmpeg';
import { probeMedia } from './probe';
import { getFilmstrip, getThumbnail } from './thumbs';
import { getWaveform } from './waveform';
import { startProxyJob } from './proxy';
import { startSceneDetectJob } from './sceneDetect';
import { extractSubtitles } from './subtitlesExtract';

export type { MediaHandlers, MediaContext } from '../ipc';

/** The one job queue shared by proxies, scene detection, waveforms and exports. */
export const jobQueue = new JobQueue();

export const mediaHandlers: MediaHandlers = {
  init(ctx: MediaContext): void {
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
    return files.map(pathToMediaUrl);
  },

  async waveform(path: string, _mediaId?: ID): Promise<WaveformData> {
    const key = await cacheKeyForPath(path);
    return getWaveform(path, key);
  },

  async startProxy(req: ProxyRequest): Promise<JobInfo> {
    const { job } = await startProxyJob(jobQueue, req);
    return job;
  },

  async startSceneDetect(req: SceneDetectRequest): Promise<JobInfo> {
    return startSceneDetectJob(jobQueue, req);
  },

  extractSubtitles(path: string, streamIndex: number): Promise<string> {
    return extractSubtitles(path, streamIndex);
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
