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
  buildRenderGraph, buildSubtitleSrt, exportPartPath, exportSidecarPath, FILTER_SCRIPT_TOKEN, type RenderGraph,
} from './renderGraph';

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

let cachedFfmpeg: string | null = null;

/** Resolves the ffmpeg binary: $RECUT_FFMPEG, then PATH, then /usr/bin/ffmpeg. */
export function resolveFfmpegPath(): string {
  if (cachedFfmpeg) return cachedFfmpeg;
  const env = process.env.RECUT_FFMPEG;
  if (env && fs.existsSync(env)) return (cachedFfmpeg = env);
  const names = process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      try { if (fs.statSync(p).isFile()) return (cachedFfmpeg = p); } catch { /* not here */ }
    }
  }
  return (cachedFfmpeg = '/usr/bin/ffmpeg');
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
  try {
    fs.mkdirSync(req.settings.outputDir, { recursive: true });
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
export async function runExport(req: ExportRequest, onProgress?: ExportProgress, signal?: AbortSignal): Promise<ExportRunResult> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpDir = path.join(os.tmpdir(), `recut-export-${id}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const subtitleFilePath = path.join(tmpDir, 'subtitles.srt');
  let partPath: string | null = null;
  try {
    if (signal?.aborted) throw new Error('Export canceled');
    const graph = buildRenderGraph(req, { subtitleFilePath, canonicalPath });
    if (graph.subtitleContent) fs.writeFileSync(subtitleFilePath, graph.subtitleContent, 'utf8');
    const scriptPath = path.join(tmpDir, 'filter.txt');
    fs.writeFileSync(scriptPath, graph.filterGraph, 'utf8');

    fs.mkdirSync(path.dirname(graph.outputPath), { recursive: true });
    partPath = exportPartPath(graph.outputPath);
    const args = graph.args.map((a) => (a === FILTER_SCRIPT_TOKEN ? scriptPath : a));
    args[args.length - 1] = partPath;

    onProgress?.(0, 'Starting ffmpeg');
    await runFfmpeg(args, graph.durationSec, onProgress, signal);

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
    return { outputPath: graph.outputPath, durationSec: graph.durationSec, warnings: graph.warnings, sidecarPath };
  } finally {
    if (partPath) { try { fs.unlinkSync(partPath); } catch { /* nothing to clean */ } }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------------------------------
// ffmpeg process runner
// ---------------------------------------------------------------------------------------------------

function runFfmpeg(args: string[], durationSec: number, onProgress?: ExportProgress, signal?: AbortSignal): Promise<void> {
  const bin = resolveFfmpegPath();
  const full = ['-progress', 'pipe:1', '-nostats', '-loglevel', 'warning', ...args];
  return new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, full, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      reject(new Error(`Cannot start ffmpeg (${bin}): ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
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
