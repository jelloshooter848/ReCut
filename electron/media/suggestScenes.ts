/**
 * Suggest Scenes analysis (#147, #151) as a background job: one FFmpeg pass over the video at a tiny size and a few
 * frames per second gives an average colour histogram per shot; the cached waveform gives the sound score at each cut.
 * The renderer adds the transcript and groups the shots (shared/sceneSuggest.ts).
 */
import path from 'node:path';
import type { JobInfo } from '@shared/model';
import type { SuggestScenesRequest, SuggestScenesResult } from '@shared/ipc';
import { audioLink, histogramFromRgba, meanHistogram } from '@shared/sceneSuggest';
import type { JobQueue, JobRunContext } from '../jobs/jobQueue';
import { inFlightJob, trackInFlight, type InFlight } from '../jobs/inFlight';
import { cacheKeysForPath } from './cache';
import { FfmpegError, ffmpegFileArg, runFfmpeg } from './ffmpeg';
import { probeMedia } from './probe';
import { AV_TIME_BASE, parseShowinfoPts } from './sceneDetect';
import { getWaveform } from './waveform';

/** Analysis frames: this size, this many per second. */
export const SUGGEST_FRAME_W = 32;
export const SUGGEST_FRAME_H = 18;
export const SUGGEST_FPS = 4;

export function suggestFilter(): string {
  return `fps=${SUGGEST_FPS},scale=${SUGGEST_FRAME_W}:${SUGGEST_FRAME_H}:flags=area,format=rgb24,settb=AVTB,showinfo`;
}

const round4 = (h: Float32Array) => Array.from(h, (x) => Math.round(x * 10000) / 10000);

export async function runSuggestScenes(req: SuggestScenesRequest, ctx: JobRunContext): Promise<SuggestScenesResult> {
  const shots = req.shots;
  // Sound: start the (cached) waveform while the picture pass runs. Missing audio is not an error.
  const audioP = req.audioPath
    ? cacheKeysForPath(req.audioPath)
      .then(({ key, legacyKey }) => getWaveform(req.audioPath!, key, { streamIndex: req.audioStream, legacyKey }))
      .catch(() => null)
    : Promise.resolve(null);

  // Picture: frame i (stdout, rgb24) pairs with the i-th showinfo timestamp (stderr), as in shot detection.
  const probe = await probeMedia(req.videoPath).catch(() => undefined);
  const startUs = probe && Number.isFinite(probe.startTime) && probe.startTime > 0 ? Math.round(probe.startTime * AV_TIME_BASE) : 0;
  const duration = req.duration > 0 ? req.duration : probe?.duration ?? 0;
  const frameBytes = SUGGEST_FRAME_W * SUGGEST_FRAME_H * 3;
  const frame = new Uint8Array(frameBytes);
  let filled = 0;
  const frameHists: Float32Array[] = [];
  const ptsUs: number[] = [];
  const run = runFfmpeg(
    ['-copyts', '-i', ffmpegFileArg(req.videoPath), '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', suggestFilter(), '-f', 'rawvideo', 'pipe:1'],
    {
      duration: duration > 0 ? duration : undefined,
      stdout: 'data',
      loglevel: 'info',
      signal: ctx.signal,
      onStdout: (chunk) => {
        let off = 0;
        while (off < chunk.length) {
          const n = Math.min(frameBytes - filled, chunk.length - off);
          frame.set(chunk.subarray(off, off + n), filled);
          filled += n; off += n;
          if (filled === frameBytes) { frameHists.push(histogramFromRgba(frame, 3)); filled = 0; }
        }
      },
      onProgress: (p) => ctx.setProgress(Math.min(0.97, p), `Comparing ${shots.length} shots · ${Math.round(p * 100)}%`),
      onStderrLine: (line) => { const t = parseShowinfoPts(line); if (t !== null) ptsUs.push(Math.round(t * AV_TIME_BASE) - startUs); },
    },
  );
  ctx.onCancel(() => run.cancel());
  await run.promise;
  if (ctx.signal.aborted) throw new FfmpegError('suggest scenes canceled', { canceled: true });

  // Average the frames inside each shot (shots and frames are both in time order); a shot too short to hold a frame
  // takes the frame nearest its middle.
  const times = ptsUs.slice(0, frameHists.length).map((us) => us / AV_TIME_BASE);
  const hists: (number[] | null)[] = [];
  let k = 0;
  for (const s of shots) {
    while (k < times.length && times[k] < s.start) k++;
    const inside: Float32Array[] = [];
    for (let j = k; j < times.length && times[j] < s.end; j++) inside.push(frameHists[j]);
    if (!inside.length && times.length) {
      const mid = (s.start + s.end) / 2;
      let best = 0;
      for (let j = Math.max(0, k - 1); j < Math.min(times.length, k + 1); j++) if (Math.abs(times[j] - mid) < Math.abs(times[best] - mid)) best = j;
      inside.push(frameHists[best]);
    }
    const h = meanHistogram(inside);
    hists.push(h ? round4(h) : null);
  }

  ctx.setProgress(0.98, 'Listening across the cuts');
  const wave = await audioP;
  const audioLinks = shots.slice(1).map((s) => (wave ? audioLink({ rate: wave.rate, peaks: wave.peaks }, s.start) : null));
  ctx.setProgress(1, `${shots.length} shots compared`);
  return { hists, audioLinks };
}

const inFlight: InFlight = new WeakMap();

export function startSuggestScenesJob(queue: JobQueue, req: SuggestScenesRequest): JobInfo {
  const existing = inFlightJob(queue, inFlight, req.mediaId);
  if (existing) return existing;
  const job = queue.add<SuggestScenesResult>({
    kind: 'suggestScenes',
    title: `Suggest scenes · ${req.name ?? path.basename(req.videoPath)}`,
    mediaId: req.mediaId,
    run: (ctx) => runSuggestScenes(req, ctx),
  });
  trackInFlight(queue, inFlight, req.mediaId, job.id);
  return job;
}
