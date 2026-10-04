/**
 * Export runner: turns an ExportRequest into an ffmpeg process, reports progress, handles cancel,
 * and integrates with the main-process job queue.
 *
 * Temp files (filter script, burn-in SRT) live in os.tmpdir()/recut-export-<id>/ and are removed when
 * the run finishes. Output is written to <name>.part.mp4 and renamed on success.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportRequest, ExportStartResult } from '@shared/ipc';
import type { ID, JobInfo } from '@shared/model';
import {
  buildRenderGraph, buildSubtitleSrt, exportPartPath, exportSidecarPath, FILTER_SCRIPT_TOKEN, sec, type RenderGraph,
} from './renderGraph';
import { ensureDirSafe } from '../safeMkdir';
import { getFfmpegPath } from '../media/ffmpeg';
import { ffmpegMissingMessage } from '../../shared/ipc';
import { CHUNK_MAX_AUDIO_SEGMENTS, CHUNK_MAX_SEGMENTS, planExportChunks, sampleIndexAt, shouldChunk, type ExportChunk } from './chunks';

/**
 * Canonical form of a path for comparisons: realpath when it exists, else realpath(dir)/basename,
 * else path.resolve (renderGraph folds case on win32/darwin).
 */
export function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  try { return fs.realpathSync.native(abs); } catch { /* does not exist (yet) */ }
  try { return path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs)); } catch { return abs; }
}

// ---------------------------------------------------------------------------------------------------
// Job queue contract (structural; electron/jobs/jobQueue.ts is owned by another agent)
// ---------------------------------------------------------------------------------------------------

export interface ExportJobContext {
  setProgress(progress: number, message?: string): void;
  onCancel(fn: () => void): void;
}
export interface ExportJobSpec {
  kind: 'export';
  title: string;
  run: (ctx: ExportJobContext) => Promise<unknown>;
}
/** Minimal structural view of the JobQueue used by the exporter. */
export interface ExportJobQueue {
  add(spec: ExportJobSpec): JobInfo;
  cancel(id: ID): void;
}

// ---------------------------------------------------------------------------------------------------
// ffmpeg resolution
// ---------------------------------------------------------------------------------------------------

/**
 * The ffmpeg binary export uses: the app-wide resolver in electron/media/ffmpeg.ts (RECUT_FFMPEG /
 * RECUT_FFMPEG_PATH, bundled resources/ffmpeg, PATH). Throws a readable error when FFmpeg is missing.
 */
export function resolveFfmpegPath(): string {
  const bin = getFfmpegPath();
  if (!bin) throw new Error(ffmpegMissingMessage('ffmpeg'));
  return bin;
}

// ---------------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------------

export interface ExportRunResult {
  outputPath: string;
  durationSec: number;
  warnings: string[];
  /** Path of the sidecar .srt when one was written. */
  sidecarPath?: string;
  /** Number of video chunks rendered (1 = single pass). */
  chunks: number;
  /** Number of audio chunks rendered (1 = single pass). */
  audioChunks: number;
}

/** Test / tuning knobs for runExport. */
export interface ExportRunOptions {
  /** Force (true) or forbid (false) chunked rendering; default: automatic (see chunks.ts thresholds). */
  chunked?: boolean;
  /** Max clip segments per video chunk (default CHUNK_MAX_SEGMENTS). */
  maxSegmentsPerChunk?: number;
  /** Max clip segments per audio chunk (default CHUNK_MAX_AUDIO_SEGMENTS). */
  maxAudioSegmentsPerChunk?: number;
  /** Called with each ffmpeg child process as it starts (e.g. to sample its memory). */
  onSpawn?: (child: ChildProcess) => void;
}

export type ExportProgress = (progress: number, message?: string) => void;

/** Full ffmpeg args (binary excluded) with the filter graph inline, for the "preview command" UI. */
export function buildExportCommand(req: ExportRequest): string[] {
  const graph = buildRenderGraph(req, { subtitleFilePath: graphSubtitlePathPreview(req) });
  return inlineFilter(graph);
}

function graphSubtitlePathPreview(req: ExportRequest): string | undefined {
  return req.settings.burnSubtitles && req.subtitles?.length
    ? path.join(os.tmpdir(), 'recut-export', 'subtitles.srt')
    : undefined;
}

function inlineFilter(graph: RenderGraph): string[] {
  const args = [...graph.args];
  const i = args.indexOf('-filter_complex_script');
  if (i >= 0) args.splice(i, 2, '-filter_complex', graph.filterGraph.replace(/\n/g, ''));
  return args;
}

/** Validates a request and queues an export job. Resolves synchronously-built results. */
export async function startExportJob(queue: ExportJobQueue, req: ExportRequest): Promise<ExportStartResult> {
  let graph: RenderGraph;
  try {
    graph = buildRenderGraph(req, { canonicalPath });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!getFfmpegPath()) return { ok: false, error: ffmpegMissingMessage('ffmpeg') };
  try {
    // Never a blocking / recursive mkdir on a user path (BUG-1: recursive mkdir under /proc never returns).
    await ensureDirSafe(path.dirname(graph.outputPath));
  } catch (e) {
    return { ok: false, error: `Cannot create output folder: ${e instanceof Error ? e.message : String(e)}` };
  }
  const title = `Export ${path.basename(graph.outputPath)}`;
  const info = queue.add({
    kind: 'export',
    title,
    run: (ctx) => {
      const ac = new AbortController();
      ctx.onCancel(() => ac.abort());
      return runExport(req, (p, msg) => ctx.setProgress(p, msg), ac.signal);
    },
  });
  return { ok: true, jobId: info.id, outputPath: graph.outputPath };
}

export function cancelExportJob(queue: ExportJobQueue, jobId: ID): void {
  queue.cancel(jobId);
}

/**
 * Runs an export to completion without a queue. Rejects on ffmpeg failure (message carries the last
 * stderr lines) or cancel (message "Export canceled").
 */
export async function runExport(req: ExportRequest, onProgress?: ExportProgress, signal?: AbortSignal, opts: ExportRunOptions = {}): Promise<ExportRunResult> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpDir = path.join(os.tmpdir(), `recut-export-${id}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const subtitleFilePath = path.join(tmpDir, 'subtitles.srt');
  let partPath: string | null = null;
  try {
    if (signal?.aborted) throw new Error('Export canceled');
    const graph = buildRenderGraph(req, { subtitleFilePath, canonicalPath });
    try { await ensureDirSafe(path.dirname(graph.outputPath)); } catch (e) {
      throw new Error(`Cannot create output folder: ${e instanceof Error ? e.message : String(e)}`);
    }
    partPath = exportPartPath(graph.outputPath);
    const planInput = { req, startF: graph.startF, endF: graph.endF };
    const chunked = opts.chunked ?? shouldChunk(planInput, graph.inputCount);
    const chunks = chunked ? planExportChunks(planInput, opts.maxSegmentsPerChunk ?? CHUNK_MAX_SEGMENTS, 'video') : [];
    const audioChunks = chunked ? planExportChunks(planInput, opts.maxAudioSegmentsPerChunk ?? CHUNK_MAX_AUDIO_SEGMENTS, 'audio') : [];

    if (chunked) {
      await runChunkedExport(req, graph, chunks, audioChunks, tmpDir, partPath, onProgress, signal, opts.onSpawn);
    } else {
      if (graph.subtitleContent) fs.writeFileSync(subtitleFilePath, graph.subtitleContent, 'utf8');
      const scriptPath = path.join(tmpDir, 'filter.txt');
      fs.writeFileSync(scriptPath, graph.filterGraph, 'utf8');
      const args = graph.args.map((a) => (a === FILTER_SCRIPT_TOKEN ? scriptPath : a));
      args[args.length - 1] = partPath;
      onProgress?.(0, 'Starting ffmpeg');
      await runFfmpeg(args, graph.durationSec, onProgress, signal, opts.onSpawn);
    }

    // Replace the final file atomically-ish.
    try { fs.unlinkSync(graph.outputPath); } catch { /* did not exist */ }
    fs.renameSync(partPath, graph.outputPath);
    partPath = null;

    let sidecarPath: string | undefined;
    if (req.settings.exportSubtitleSidecar && req.subtitles?.length) {
      const srt = buildSubtitleSrt(req);
      if (srt) {
        sidecarPath = exportSidecarPath(graph.outputPath);
        fs.writeFileSync(sidecarPath, srt, 'utf8');
      }
    }
    onProgress?.(1, 'Done');
    return { outputPath: graph.outputPath, durationSec: graph.durationSec, warnings: graph.warnings, sidecarPath, chunks: Math.max(1, chunks.length), audioChunks: Math.max(1, audioChunks.length) };
  } finally {
    if (partPath) { try { fs.unlinkSync(partPath); } catch { /* nothing to clean */ } }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------------------------------
// Chunked export (P-01): bounded ffmpeg memory for sequences with thousands of clips
// ---------------------------------------------------------------------------------------------------

/** x264/x265 GOP settings for chunk files: closed GOPs, IDR at each chunk start, headers independent of content. */
function chunkGopArgs(vcodecArgs: string[]): string[] {
  const hevc = vcodecArgs[vcodecArgs.indexOf('-c:v') + 1] === 'libx265';
  return hevc
    ? ['-x265-params', 'keyint=250:open-gop=0', '-force_key_frames', '0']
    : ['-x264-params', 'keyint=250:open-gop=0:stitchable=1', '-force_key_frames', '0'];
}

function concatList(files: string[]): string {
  return 'ffconcat version 1.0\n' + files.map((f) => `file '${path.basename(f).replace(/'/g, "'\\''")}'\n`).join('');
}

/**
 * Renders `chunks` (consecutive, covering the export range) one ffmpeg process at a time:
 * 1. video per chunk -> chunk-NNN.mp4 (same encoder settings, closed GOP, IDR at 0, exact frame count);
 * 2. audio per chunk -> chunk-NNN.wav (32-bit float PCM, exactly S(end) - S(start) samples where
 *    S(f) = round((f - startF) * SR * den/num), so the chunks join with no drift);
 * 3. one final process: concat demuxer (video stream copy + PCM) -> one AAC/AC-3 encode -> MP4.
 * Every chunk graph is buildRenderGraph over the chunk's sub-range, so frame choice and timing are the
 * single-pass ones; boundaries never split a transition or fade (chunks.ts).
 */
async function runChunkedExport(
  req: ExportRequest, full: RenderGraph, chunks: ExportChunk[], audioChunks: ExportChunk[], tmpDir: string, partPath: string,
  onProgress: ExportProgress | undefined, signal: AbortSignal | undefined, onSpawn: ExportRunOptions['onSpawn'],
): Promise<void> {
  const n = chunks.length;
  const na = audioChunks.length;
  const fps = req.sequence.fps;
  const fd = fps.den / fps.num;
  // Progress weights: video encode dominates; audio passes and the final mux are cheaper.
  const total = full.frameCount;
  const W_VIDEO = 0.8, W_AUDIO = 0.12, W_MUX = 0.08;
  let done = 0; // completed weight
  const report = (w: number, p: number, msg: string) => onProgress?.(Math.min(0.999, done + w * p), msg);

  const videoFiles: string[] = [];
  const audioFiles: string[] = [];
  const step = async (i: number, c: ExportChunk, kind: 'video' | 'audio', args: string[], dur: number, w: number) => {
    if (signal?.aborted) throw new Error('Export canceled');
    const of = kind === 'video' ? n : na;
    const label = `chunk ${i + 1}/${of} (${kind}, frames ${c.startF}-${c.endF})`;
    try {
      await runFfmpeg(args, dur, (p, m) => report(w, p, `Chunk ${i + 1}/${of} ${kind}: ${m ?? ''}`.trim()), signal, onSpawn);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'Export canceled') throw e;
      throw new Error(`Export failed in ${label}: ${msg}`);
    }
    done += w;
  };

  onProgress?.(0, `Rendering in ${n} chunks`);
  // Per-input decoder threads multiply ffmpeg memory by the input count: one decoder thread per input
  // (encode is the bottleneck) and 2 filter threads halve the peak RSS of a 100-segment chunk
  // (1.47 GB -> 0.56 GB) and do not slow it down.
  const oneThread = (inputArgs: string[]) => inputArgs.flatMap((a) => (a === '-i' ? ['-threads', '1', a] : [a]));
  for (let i = 0; i < n; i++) {
    const c = chunks[i];
    const tag = String(i).padStart(4, '0');
    const srt = path.join(tmpDir, `sub-${tag}.srt`);
    const g = buildRenderGraph(req, { range: { startF: c.startF, endF: c.endF }, streams: 'video', subtitleFilePath: srt, canonicalPath });
    if (g.subtitleContent) fs.writeFileSync(srt, g.subtitleContent, 'utf8');
    const script = path.join(tmpDir, `v-${tag}.txt`);
    fs.writeFileSync(script, g.filterGraph, 'utf8');
    const out = path.join(tmpDir, `chunk-${tag}.mp4`);
    const args = ['-hide_banner', '-nostdin', '-y', '-filter_complex_threads', '2', ...oneThread(g.inputArgs), '-filter_complex_script', script, '-map', '[vout]',
      ...g.videoCodecArgs, ...chunkGopArgs(g.videoCodecArgs), '-an', '-t', sec(g.durationSec), '-f', 'mp4', out];
    await step(i, c, 'video', args, g.durationSec, W_VIDEO * (c.endF - c.startF) / total);
    try { fs.unlinkSync(script); } catch { /* best effort */ }
    videoFiles.push(out);
  }
  for (let i = 0; i < na; i++) {
    const c = audioChunks[i];
    const tag = String(i).padStart(4, '0');
    const samples = sampleIndexAt(c.endF, full.startF, full.sampleRate, fps) - sampleIndexAt(c.startF, full.startF, full.sampleRate, fps);
    const g = buildRenderGraph(req, { range: { startF: c.startF, endF: c.endF }, streams: 'audio', audioSamples: samples, canonicalPath });
    const script = path.join(tmpDir, `a-${tag}.txt`);
    fs.writeFileSync(script, g.filterGraph, 'utf8');
    const out = path.join(tmpDir, `chunk-${tag}.wav`);
    const args = ['-hide_banner', '-nostdin', '-y', '-filter_complex_threads', '2', ...oneThread(g.inputArgs), '-filter_complex_script', script, '-map', '[aout]',
      '-c:a', 'pcm_f32le', '-ar', String(g.sampleRate), '-ac', String(g.channels), '-vn', '-f', 'wav', out];
    await step(i, c, 'audio', args, (c.endF - c.startF) * fd, W_AUDIO * (c.endF - c.startF) / total);
    try { fs.unlinkSync(script); } catch { /* best effort */ }
    audioFiles.push(out);
  }

  const vList = path.join(tmpDir, 'video.ffconcat');
  const aList = path.join(tmpDir, 'audio.ffconcat');
  fs.writeFileSync(vList, concatList(videoFiles), 'utf8');
  fs.writeFileSync(aList, concatList(audioFiles), 'utf8');
  const hevc = full.videoCodecArgs.includes('libx265');
  const args = ['-hide_banner', '-nostdin', '-y',
    '-f', 'concat', '-safe', '0', '-i', vList, '-f', 'concat', '-safe', '0', '-i', aList,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', ...(hevc ? ['-tag:v', 'hvc1'] : []), ...full.audioCodecArgs,
    '-movflags', '+faststart', '-t', sec(full.durationSec), '-f', 'mp4', partPath];
  try {
    if (signal?.aborted) throw new Error('Export canceled');
    await runFfmpeg(args, full.durationSec, (p) => report(W_MUX, p, `Joining ${n} chunks`), signal, onSpawn);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'Export canceled') throw e;
    throw new Error(`Export failed joining ${n} video + ${na} audio chunks (frames ${full.startF}-${full.endF}): ${msg}`);
  }
}

// ---------------------------------------------------------------------------------------------------
// ffmpeg process runner
// ---------------------------------------------------------------------------------------------------

function runFfmpeg(args: string[], durationSec: number, onProgress?: ExportProgress, signal?: AbortSignal, onSpawn?: (c: ChildProcess) => void): Promise<void> {
  let bin: string;
  try { bin = resolveFfmpegPath(); } catch (e) { return Promise.reject(e); }
  const full = ['-progress', 'pipe:1', '-nostats', '-loglevel', 'warning', ...args];
  return new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, full, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      reject(new Error(`Cannot start ffmpeg (${bin}): ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    try { onSpawn?.(child); } catch { /* observer errors do not affect the export */ }
    const stderrLines: string[] = [];
    let stderrBuf = '';
    let stdoutBuf = '';
    let canceled = false;
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      canceled = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => { signal?.removeEventListener('abort', onAbort); };

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrBuf += chunk;
      const lines = stderrBuf.split(/\r?\n|\r/);
      stderrBuf = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) { stderrLines.push(l); if (stderrLines.length > 200) stderrLines.shift(); }
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        const m = /^out_time_(us|ms)=(-?\d+)/.exec(line.trim());
        if (m && durationSec > 0) {
          // ffmpeg <= 6.1 reports both keys in microseconds.
          const secs = Number(m[2]) / 1e6;
          const p = Math.max(0, Math.min(0.999, secs / durationSec));
          onProgress?.(p, `Encoding ${formatClock(secs)} / ${formatClock(durationSec)}`);
        } else if (line.startsWith('progress=end')) {
          onProgress?.(0.999, 'Finalizing');
        }
      }
    });
    child.on('error', (err) => {
      if (settled) return; settled = true; cleanup();
      reject(new Error(`Cannot start ffmpeg (${bin}): ${err.message}`));
    });
    child.on('close', (code, sig) => {
      if (settled) return; settled = true; cleanup();
      if (stderrBuf.trim()) stderrLines.push(stderrBuf);
      if (canceled) { reject(new Error('Export canceled')); return; }
      if (code === 0) { resolve(); return; }
      const tail = stderrLines.slice(-30).join('\n');
      reject(new Error(`ffmpeg exited with ${code !== null ? `code ${code}` : `signal ${sig}`}${tail ? `:\n${tail}` : ''}`));
    });
  });
}

function formatClock(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = Math.floor(s % 60);
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
}
