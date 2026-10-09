/**
 * Export runner: turns an ExportRequest into an ffmpeg process, reports progress, handles cancel,
 * and integrates with the main-process job queue.
 *
 * Temp files (filter script, burn-in SRT, chapters FFMETADATA) live in a fresh os.tmpdir()/recut-export-XXXXXX/ and
 * are removed when the run finishes. Output is written to <name>.recut-part-<random>.<ext> (created exclusively) and renamed on success;
 * a per-track audio export renders every file first and then renames them one by one.
 * Every path handed to ffmpeg as an input or output is a `file:` URL, so no protocol prefix is ever interpreted.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportRequest, ExportStartResult } from '@shared/ipc';
import type { ID, JobInfo } from '@shared/model';
import {
  buildExportGraphs, buildRenderGraph, buildSubtitleSrt, exportPartPath, exportSidecarTempPath, exportUnsavedPath, ExportOutputExistsError, FILTER_SCRIPT_TOKEN,
  outputFrameIndex, outputMetadataArgs, sec, type ExportPathStat, type RenderGraph,
} from './renderGraph';
import { ensureDirSafe } from '../safeMkdir';
import { canonicalPath, fileIdentity } from '../pathSafety';
import { adaptFfmpegArgs, ffmpegFileArg, ffmpegMajorVersionSync, getFfmpegPath } from '../media/ffmpeg';
import { ffmpegMissingMessage } from '../../shared/ipc';
import { CHUNK_MAX_AUDIO_SEGMENTS, CHUNK_MAX_SEGMENTS, planExportChunks, sampleIndexAt, shouldChunk, type ExportChunk } from './chunks';

// Canonical form of a path for comparisons (realpath, else realpath(dir)/basename, else path.resolve); renderGraph
// folds case. Shared with the subtitle export check (electron/pathSafety.ts).
export { canonicalPath };

/** File identity key (`dev:ino`, the same rule as the subtitle export check), undefined without one. */
function identityKey(p: string): string | undefined {
  const id = fileIdentity(p);
  return id ? `${id.dev}:${id.ino}` : undefined;
}

/**
 * What is at `p` for the output checks (RenderGraphOptions.statPath): its identity (following symlinks) and
 * whether it is a folder; null when nothing is there (a dangling symlink counts as existing).
 */
export function exportStatPath(p: string): ExportPathStat | null {
  if (!fs.lstatSync(p, { throwIfNoEntry: false })) return null;
  let isDirectory = false;
  try { isDirectory = fs.statSync(p).isDirectory(); } catch { /* dangling or looping symlink: not a folder */ }
  return { id: identityKey(p), isDirectory };
}

/**
 * `args` with every `-i` value as a `file:` URL (ffmpegFileArg, electron/media/ffmpeg.ts), so `tee:`, `concat:`,
 * `http:` ... are never protocols and a relative path is refused rather than read relative to the main process cwd.
 */
function fileInputs(args: string[]): string[] {
  return args.map((a, i) => (i > 0 && args[i - 1] === '-i' ? ffmpegFileArg(a) : a));
}

function randomToken(): string {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Creates a new empty render temp next to the output with O_EXCL (never an existing file, symlink or hard link)
 * and returns its path and identity. ffmpeg then writes into this file (it is the only file at that name).
 */
/** What identifies a reserved render file: its `dev:ino` key, and its device and creation time (#133). */
export interface RenderFileStamp { id: string | undefined; dev?: bigint; birthNs?: bigint }

function renderFileStamp(p: string): RenderFileStamp {
  let st: fs.BigIntStats | undefined;
  try { st = fs.lstatSync(p, { bigint: true, throwIfNoEntry: false }); } catch { st = undefined; }
  return { id: identityKey(p), ...(st ? { dev: st.dev, birthNs: st.birthtimeNs } : {}) };
}

/**
 * Whether `now` (the render file after ffmpeg wrote it) is still the file reserved as `reserved`. The same `dev:ino`
 * says so. Where a file system has no stable inode numbers (exFAT, FAT: macOS gives an empty file a made-up number
 * that changes once it has data, #133) the same device and creation time do, for a regular file (never a symlink).
 */
export function sameRenderFile(reserved: RenderFileStamp, now: { id: string | undefined; dev?: bigint; birthNs?: bigint; isFile: boolean } | null): boolean {
  if (!now) return false;
  if (reserved.id !== undefined && now.id === reserved.id) return true;
  return now.isFile && reserved.dev !== undefined && now.dev === reserved.dev
    && reserved.birthNs !== undefined && reserved.birthNs > 0n && now.birthNs === reserved.birthNs;
}

function currentRenderFile(p: string): Parameters<typeof sameRenderFile>[1] {
  let st: fs.BigIntStats | undefined;
  try { st = fs.lstatSync(p, { bigint: true, throwIfNoEntry: false }); } catch { return null; }
  return st ? { id: identityKey(p), dev: st.dev, birthNs: st.birthtimeNs, isFile: st.isFile() } : null;
}

function reserveRenderTemp(outputPath: string): { path: string; stamp: RenderFileStamp } {
  for (let attempt = 0; ; attempt++) {
    const p = exportPartPath(outputPath, randomToken());
    let fd: number;
    try {
      fd = fs.openSync(p, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST' && attempt < 4) continue;
      throw e;
    }
    fs.closeSync(fd);
    return { path: p, stamp: renderFileStamp(p) };
  }
}

/**
 * The final move failed: keep the finished render under `<name>.recut-unsaved-<time>.<ext>` (or, if even that rename
 * fails, under its temp name) so the user does not have to render again. Returns where it is.
 */
function keepUnsavedRender(partPath: string, outputPath: string): string {
  const kept = exportUnsavedPath(outputPath, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomToken().slice(0, 4)}`);
  if (exportStatPath(kept)) return partPath;
  try { fs.renameSync(partPath, kept); return kept; } catch { return partPath; }
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
  /** The output file (per-track audio export: the first file; all of them are in `outputPaths`). */
  outputPath: string;
  /** Every file written, in track order for a per-track audio export. */
  outputPaths: string[];
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

/**
 * Full ffmpeg args (binary excluded) with the filter graph inline, for the "preview command" UI. A per-track audio
 * export runs one command per file: this is the first file's.
 */
export function buildExportCommand(req: ExportRequest): string[] {
  const { graphs } = buildExportGraphs(req, {
    subtitleFilePath: graphSubtitlePathPreview(req), chaptersFilePath: path.join(os.tmpdir(), 'recut-export', 'chapters.txt'),
    softSubtitleFilePaths: softSubtitlePaths(req, path.join(os.tmpdir(), 'recut-export')),
  });
  return inlineFilter(graphs[0]);
}

/** Temp paths for the soft subtitle streams of `req` (MKV): `<dir>/subtitles-<n>.srt`, one per chosen track. */
function softSubtitlePaths(req: ExportRequest, dir: string): string[] {
  const n = Array.isArray(req.settings.subtitleOutputs) ? Math.min(256, req.settings.subtitleOutputs.length) : 0;
  return Array.from({ length: n }, (_, i) => path.join(dir, `subtitles-${i}.srt`));
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
  let outputPaths: string[];
  try {
    const built = buildExportGraphs(req, { canonicalPath, statPath: exportStatPath });
    graph = built.graphs[0];
    outputPaths = built.graphs.map((g) => g.outputPath);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return e instanceof ExportOutputExistsError ? { ok: false, error, code: 'exists' } : { ok: false, error };
  }
  if (!getFfmpegPath()) return { ok: false, error: ffmpegMissingMessage('ffmpeg') };
  try {
    // Never a blocking / recursive mkdir on a user path (BUG-1: recursive mkdir under /proc never returns).
    await ensureDirSafe(path.dirname(graph.outputPath));
  } catch (e) {
    return { ok: false, error: `Cannot create output folder: ${e instanceof Error ? e.message : String(e)}` };
  }
  const title = outputPaths.length > 1 ? `Export ${outputPaths.length} audio files (${path.basename(graph.outputPath)}, …)` : `Export ${path.basename(graph.outputPath)}`;
  const info = queue.add({
    kind: 'export',
    title,
    run: (ctx) => {
      const ac = new AbortController();
      ctx.onCancel(() => ac.abort());
      return runExport(req, (p, msg) => ctx.setProgress(p, msg), ac.signal);
    },
  });
  return { ok: true, jobId: info.id, outputPath: graph.outputPath, ...(outputPaths.length > 1 ? { outputPaths } : {}) };
}

export function cancelExportJob(queue: ExportJobQueue, jobId: ID): void {
  queue.cancel(jobId);
}

/** File operations used by finalizeExportOutput (injectable for tests). */
export interface FinalizeFsOps {
  renameSync(from: string, to: string): void;
  unlinkSync(p: string): void;
  lstatSync(p: string): { isFile(): boolean };
}

/**
 * Moves the finished render (<name>.recut-part-*.mp4) onto the output path, replacing a previous file there.
 *
 * rename replaces an existing target atomically on POSIX and on Windows (libuv uses MoveFileEx with
 * MOVEFILE_REPLACE_EXISTING), so the previous file is never deleted up front: if the move fails (file open in a
 * player, EXDEV, EPERM, ...) the user keeps it and the error is thrown. Only when the in-place replace fails and a
 * previous file exists (e.g. a read-only target on Windows, which MoveFileEx refuses to replace) is the old file
 * moved aside to a backup, the render moved in, and the backup deleted; if the render still cannot be moved in, the
 * backup is moved back. Only a regular file is ever moved aside: anything else at the output path (a folder, a
 * symlink) is left alone and the error thrown. The render temp is left for the caller on failure.
 */
export function finalizeExportOutput(partPath: string, outputPath: string, ops: FinalizeFsOps = fs): void {
  let firstError: unknown;
  try { ops.renameSync(partPath, outputPath); return; } catch (e) { firstError = e; }
  const fail = (e: unknown, extra = ''): Error =>
    new Error(`Could not write the export to "${outputPath}": ${e instanceof Error ? e.message : String(e)}${extra}`);
  let existing: { isFile(): boolean };
  try { existing = ops.lstatSync(outputPath); } catch { throw fail(firstError); }
  if (!existing.isFile()) throw fail(firstError, '. What is at that path is not a file (a folder?); it was left unchanged.');

  const backup = `${outputPath}.recut-old-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  try { ops.renameSync(outputPath, backup); } catch { throw fail(firstError, '. The existing file was left unchanged.'); }
  try {
    ops.renameSync(partPath, outputPath);
  } catch (e) {
    try { ops.renameSync(backup, outputPath); } catch {
      throw fail(e, `. The previous file was kept as "${backup}".`);
    }
    throw fail(e, '. The existing file was left unchanged.');
  }
  try { ops.unlinkSync(backup); } catch { /* stale backup next to the output; harmless */ }
}

/**
 * Runs an export to completion without a queue. Rejects on ffmpeg failure (message carries the last
 * stderr lines) or cancel (message "Export canceled").
 */
export async function runExport(req: ExportRequest, onProgress?: ExportProgress, signal?: AbortSignal, opts: ExportRunOptions = {}): Promise<ExportRunResult> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-export-'));
  const subtitleFilePath = path.join(tmpDir, 'subtitles.srt');
  const chaptersFilePath = path.join(tmpDir, 'chapters.txt');
  /** Reserved render temps not moved onto their output yet (deleted on failure). */
  const parts: { path: string; stamp: RenderFileStamp; outputPath: string }[] = [];
  let sidecarTemp: string | null = null;
  try {
    if (signal?.aborted) throw new Error('Export canceled');
    // One graph per output file: one file, or one per audio track (per-track audio export).
    const softSubtitleFilePaths = softSubtitlePaths(req, tmpDir);
    const { outputs, graphs } = buildExportGraphs(req, { subtitleFilePath, chaptersFilePath, softSubtitleFilePaths, canonicalPath, statPath: exportStatPath });
    // The sequence's Chapter markers (FFMETADATA input of the single pass or of the chunk join); the same for every file.
    const chaptersContent = graphs[0].chaptersContent;
    if (chaptersContent) fs.writeFileSync(chaptersFilePath, chaptersContent, 'utf8');
    // Soft subtitle streams (MKV): inputs of the single pass or of the chunk join.
    graphs[0].softSubtitles.forEach((sub, i) => fs.writeFileSync(softSubtitleFilePaths[i], sub.content, 'utf8'));
    try { await ensureDirSafe(path.dirname(graphs[0].outputPath)); } catch (e) {
      throw new Error(`Cannot create output folder: ${e instanceof Error ? e.message : String(e)}`);
    }
    const n = graphs.length;
    let chunks = 1, audioChunks = 1;
    for (let i = 0; i < n; i++) {
      const graph = graphs[i];
      const file = outputs.files[i];
      const reserved = reserveRenderTemp(graph.outputPath);
      parts.push({ path: reserved.path, stamp: reserved.stamp, outputPath: graph.outputPath });
      const fileProgress: ExportProgress | undefined = n > 1 && onProgress
        ? (p, msg) => onProgress((i + p) / n, `${file.label ?? `File ${i + 1}`} (${i + 1}/${n}): ${msg ?? ''}`.trim())
        : onProgress;
      const fileDir = n > 1 ? fs.mkdtempSync(path.join(tmpDir, `file-${i}-`)) : tmpDir;
      const used = await renderOutputFile(file.req, graph, file.audioTrackId, reserved.path, fileDir, chaptersContent ? chaptersFilePath : null, subtitleFilePath,
        softSubtitleFilePaths.slice(0, graph.softSubtitles.length), fileProgress, signal, opts);
      chunks = Math.max(chunks, used.chunks);
      audioChunks = Math.max(audioChunks, used.audioChunks);
    }

    // ffmpeg wrote into the files reserved above; never move anything else onto an output.
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!sameRenderFile(part.stamp, currentRenderFile(part.path))) {
        parts.splice(i, 1);
        throw new Error(`The render file "${part.path}" was replaced by another file during the export. It was left untouched; export again.`);
      }
    }
    const written: string[] = [];
    while (parts.length) {
      const part = parts[0];
      try {
        // Something created at the output path while rendering is not replaced without the user's consent.
        if (!req.overwrite && exportStatPath(part.outputPath)) throw new ExportOutputExistsError(part.outputPath);
        finalizeExportOutput(part.path, part.outputPath);
      } catch (e) {
        const kept = keepUnsavedRender(part.path, part.outputPath);
        parts.shift();
        const done = written.length ? ` Already written: ${written.map((w) => `"${w}"`).join(', ')}.` : '';
        throw new Error(`${e instanceof Error ? e.message : String(e)} The finished render was kept as "${kept}".${done}`);
      }
      parts.shift();
      written.push(part.outputPath);
    }

    // Sidecar: its path was checked against the project's sources by buildExportGraphs. Written to a new temp
    // (random name, created exclusively) in the same folder and renamed, so a failed write never leaves a
    // truncated .srt and no existing file is ever written through. A per-track export writes one, `<base>.srt`.
    let sidecarPath: string | undefined;
    if (outputs.sidecarPath && req.subtitles?.length) {
      const srt = buildSubtitleSrt(req);
      if (srt) {
        const target = outputs.sidecarPath;
        if (!req.overwrite && exportStatPath(target)) throw new ExportOutputExistsError(target);
        const temp = exportSidecarTempPath(target.replace(/\.srt$/i, ''), randomToken()); // <base>.recut-part-<token>.srt
        try {
          fs.writeFileSync(temp, srt, { encoding: 'utf8', flag: 'wx' });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') sidecarTemp = temp; // ours (possibly partial): clean up
          throw e;
        }
        sidecarTemp = temp;
        fs.renameSync(sidecarTemp, target);
        sidecarTemp = null;
        sidecarPath = target;
      }
    }
    onProgress?.(1, 'Done');
    const warnings = graphs.flatMap((g) => g.warnings).filter((w, i, all) => all.indexOf(w) === i);
    return { outputPath: written[0], outputPaths: written, durationSec: graphs[0].durationSec, warnings, sidecarPath, chunks, audioChunks };
  } finally {
    for (const part of parts) { try { fs.unlinkSync(part.path); } catch { /* nothing to clean */ } }
    if (sidecarTemp) { try { fs.unlinkSync(sidecarTemp); } catch { /* nothing to clean */ } }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Renders one output file into `partPath`: a single ffmpeg pass, or chunks joined at the end (large sequences, see
 * chunks.ts). An audio-only file is chunked by its audio inputs only. Returns the chunk counts.
 */
async function renderOutputFile(
  req: ExportRequest, graph: RenderGraph, audioTrackId: ID | undefined, partPath: string, tmpDir: string, chaptersFile: string | null, subtitleFilePath: string,
  softSubtitleFiles: string[], onProgress: ExportProgress | undefined, signal: AbortSignal | undefined, opts: ExportRunOptions,
): Promise<{ chunks: number; audioChunks: number }> {
  const planInput = { req, startF: graph.startF, endF: graph.endF };
  const chunked = opts.chunked ?? (graph.audioOnly ? graph.inputCount > CHUNK_MAX_AUDIO_SEGMENTS : shouldChunk(planInput, graph.inputCount));
  const chunks = chunked && !graph.audioOnly ? mergeChunksWithoutOutputFrames(planExportChunks(planInput, opts.maxSegmentsPerChunk ?? CHUNK_MAX_SEGMENTS, 'video'), req, graph) : [];
  const audioChunks = chunked ? planExportChunks(planInput, opts.maxAudioSegmentsPerChunk ?? CHUNK_MAX_AUDIO_SEGMENTS, 'audio') : [];
  if (chunked) {
    await runChunkedExport(req, graph, chunks, audioChunks, tmpDir, chaptersFile, softSubtitleFiles, partPath, onProgress, signal, opts.onSpawn, audioTrackId);
  } else {
    if (graph.subtitleContent) fs.writeFileSync(subtitleFilePath, graph.subtitleContent, 'utf8');
    const scriptPath = path.join(tmpDir, 'filter.txt');
    fs.writeFileSync(scriptPath, graph.filterGraph, 'utf8');
    const args = fileInputs(graph.args.map((a) => (a === FILTER_SCRIPT_TOKEN ? scriptPath : a)));
    args[args.length - 1] = ffmpegFileArg(partPath);
    onProgress?.(0, 'Starting ffmpeg');
    await runFfmpeg(args, graph.durationSec, onProgress, signal, opts.onSpawn);
  }
  return { chunks: Math.max(1, chunks.length), audioChunks: Math.max(1, audioChunks.length) };
}

// ---------------------------------------------------------------------------------------------------
// Chunked export (P-01): bounded ffmpeg memory for sequences with thousands of clips
// ---------------------------------------------------------------------------------------------------

/** x264/x265 GOP settings for chunk files: closed GOPs, IDR at each chunk start, headers independent of content (none for intra-only codecs). */
function chunkGopArgs(vcodecArgs: string[]): string[] {
  const codec = vcodecArgs[vcodecArgs.indexOf('-c:v') + 1];
  if (codec !== 'libx264' && codec !== 'libx265') return []; // ProRes / DNxHR: every frame is a key frame
  const hevc = codec === 'libx265';
  return hevc
    ? ['-x265-params', 'keyint=250:open-gop=0', '-force_key_frames', '0']
    : ['-x264-params', 'keyint=250:open-gop=0:stitchable=1', '-force_key_frames', '0'];
}

/**
 * Output frame-rate conversion: a video chunk shorter than an output frame can own no output frame (e.g. a
 * 1-frame chunk at 60 -> 24 fps). Such a chunk is joined with the next one (the last with the previous), which
 * keeps every boundary valid (chunks.ts) and the absolute output frame mapping unchanged.
 */
export function mergeChunksWithoutOutputFrames(chunks: ExportChunk[], req: ExportRequest, full: RenderGraph): ExportChunk[] {
  const seqFps = req.sequence.fps;
  const outFrames = (c: ExportChunk) => outputFrameIndex(c.endF - full.startF, seqFps, full.outputFps) - outputFrameIndex(c.startF - full.startF, seqFps, full.outputFps);
  const join = (a: ExportChunk, b: ExportChunk): ExportChunk => ({
    startF: a.startF, endF: b.endF, videoSegments: a.videoSegments + b.videoSegments,
    audioSegments: a.audioSegments + b.audioSegments, videoMemoryMB: a.videoMemoryMB + b.videoMemoryMB,
  });
  const out: ExportChunk[] = [];
  let pending: ExportChunk | null = null;
  for (const c of chunks) {
    const cur: ExportChunk = pending ? join(pending, c) : c;
    pending = null;
    if (outFrames(cur) > 0) out.push(cur); else pending = cur;
  }
  if (pending) {
    if (out.length) out.push(join(out.pop()!, pending)); else out.push(pending);
  }
  return out;
}

function concatList(files: string[]): string {
  return 'ffconcat version 1.0\n' + files.map((f) => `file '${path.basename(f).replace(/'/g, "'\\''")}'\n`).join('');
}

/**
 * Renders `chunks` (consecutive, covering the export range) one ffmpeg process at a time:
 * 1. video per chunk -> chunk-NNN.mp4 (chunk-NNN.mov for MOV) with the same encoder settings, exact frame count
 *    (H.264 / H.265: closed GOP, IDR at 0; ProRes / DNxHR are intra-only and need nothing more);
 * 2. audio per chunk -> chunk-NNN.wav (32-bit float PCM, exactly S(end) - S(start) samples where
 *    S(f) = round((f - startF) * SR * den/num), so the chunks join with no drift); an MKV with several output audio
 *    tracks writes one WAV per output track from the same chunk process (chunk-NNN-a1.wav, ...);
 * 3. one final process: concat demuxer (video stream copy + PCM) -> one audio encode per output track (AAC / AC-3 / PCM /
 *    FLAC) in the output container, with the chapters (`chaptersFile`, FFMETADATA), the soft subtitle files (MKV) and
 *    no metadata from the chunk files or the sources.
 * An audio-only export has no video chunks (`chunks` is empty). Every chunk graph is buildRenderGraph over the chunk's
 * sub-range (and `audioTrackId` for a per-track file), so frame choice and timing are the single-pass ones;
 * boundaries never split a transition or fade (chunks.ts).
 */
async function runChunkedExport(
  req: ExportRequest, full: RenderGraph, chunks: ExportChunk[], audioChunks: ExportChunk[], tmpDir: string, chaptersFile: string | null,
  softSubtitleFiles: string[], partPath: string,
  onProgress: ExportProgress | undefined, signal: AbortSignal | undefined, onSpawn: ExportRunOptions['onSpawn'], audioTrackId?: ID,
): Promise<void> {
  const n = chunks.length;
  const na = audioChunks.length;
  const fps = req.sequence.fps;
  const fd = fps.den / fps.num;
  // Progress weights: video encode dominates; audio passes and the final mux are cheaper.
  const total = full.frameCount;
  const W_VIDEO = full.audioOnly ? 0 : 0.8, W_AUDIO = full.audioOnly ? 0.9 : 0.12, W_MUX = full.audioOnly ? 0.1 : 0.08;
  let done = 0; // completed weight
  const report = (w: number, p: number, msg: string) => onProgress?.(Math.min(0.999, done + w * p), msg);

  const videoFiles: string[] = [];
  /** Per output audio track, its chunk files in order. */
  const outs = full.audioOutputs.length ? full.audioOutputs : [{ label: '[aout]', channels: full.channels, name: '' }];
  const audioFiles: string[][] = outs.map(() => []);
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

  onProgress?.(0, `Rendering in ${Math.max(n, na)} chunks`);
  // Per-input decoder threads multiply ffmpeg memory by the input count: one decoder thread per input
  // (encode is the bottleneck) and 2 filter threads halve the peak RSS of a 100-segment chunk
  // (1.47 GB -> 0.56 GB) and do not slow it down.
  const oneThread = (inputArgs: string[]) => inputArgs.flatMap((a) => (a === '-i' ? ['-threads', '1', a] : [a]));
  // Video chunk container: the output's (ProRes / DNxHR go in MOV), MP4 otherwise.
  const chunkMuxer = full.container === 'mov' ? 'mov' : 'mp4';
  for (let i = 0; i < n; i++) {
    const c = chunks[i];
    const tag = String(i).padStart(4, '0');
    const srt = path.join(tmpDir, `sub-${tag}.srt`);
    const g = buildRenderGraph(req, { range: { startF: c.startF, endF: c.endF }, streams: 'video', subtitleFilePath: srt, canonicalPath });
    if (g.subtitleContent) fs.writeFileSync(srt, g.subtitleContent, 'utf8');
    const script = path.join(tmpDir, `v-${tag}.txt`);
    fs.writeFileSync(script, g.filterGraph, 'utf8');
    const out = path.join(tmpDir, `chunk-${tag}.${chunkMuxer}`);
    const args = ['-hide_banner', '-nostdin', '-y', '-filter_complex_threads', '2', ...fileInputs(oneThread(g.inputArgs)), '-filter_complex_script', script, '-map', '[vout]', ...outputMetadataArgs(null),
      ...g.videoCodecArgs, ...chunkGopArgs(g.videoCodecArgs), '-an', '-t', sec(Math.max(g.durationSec, g.outputDurationSec)), '-f', chunkMuxer, ffmpegFileArg(out)];
    await step(i, c, 'video', args, g.durationSec, W_VIDEO * (c.endF - c.startF) / total);
    try { fs.unlinkSync(script); } catch { /* best effort */ }
    videoFiles.push(out);
  }
  for (let i = 0; i < na; i++) {
    const c = audioChunks[i];
    const tag = String(i).padStart(4, '0');
    const samples = sampleIndexAt(c.endF, full.startF, full.sampleRate, fps) - sampleIndexAt(c.startF, full.startF, full.sampleRate, fps);
    const g = buildRenderGraph(req, { range: { startF: c.startF, endF: c.endF }, streams: 'audio', audioSamples: samples, canonicalPath, audioTrackId });
    const script = path.join(tmpDir, `a-${tag}.txt`);
    fs.writeFileSync(script, g.filterGraph, 'utf8');
    // One WAV per output audio track, all from this one process (the tracks are decoded once).
    const args = ['-hide_banner', '-nostdin', '-y', '-filter_complex_threads', '2', ...fileInputs(oneThread(g.inputArgs)), '-filter_complex_script', script];
    outs.forEach((o, k) => {
      const out = path.join(tmpDir, k === 0 ? `chunk-${tag}.wav` : `chunk-${tag}-a${k}.wav`);
      args.push('-map', o.label, ...outputMetadataArgs(null), '-c:a', 'pcm_f32le', '-ar', String(g.sampleRate), '-ac', String(o.channels), '-vn', '-f', 'wav', ffmpegFileArg(out));
      audioFiles[k].push(out);
    });
    await step(i, c, 'audio', args, (c.endF - c.startF) * fd, W_AUDIO * (c.endF - c.startF) / total);
    try { fs.unlinkSync(script); } catch { /* best effort */ }
  }

  const vList = path.join(tmpDir, 'video.ffconcat');
  const aLists = outs.map((_, k) => path.join(tmpDir, k === 0 ? 'audio.ffconcat' : `audio-${k}.ffconcat`));
  if (n) fs.writeFileSync(vList, concatList(videoFiles), 'utf8');
  aLists.forEach((l, k) => fs.writeFileSync(l, concatList(audioFiles[k]), 'utf8'));
  // The hvc1 tag of the H.265 stream (MP4 / MOV); Matroska has no codec tags.
  const hevcTag = full.videoCodecArgs.includes('libx265') && full.container !== 'mkv';
  const inputs = [
    ...(n ? ['-f', 'concat', '-safe', '0', '-i', ffmpegFileArg(vList)] : []),
    ...aLists.flatMap((l) => ['-f', 'concat', '-safe', '0', '-i', ffmpegFileArg(l)]),
    ...(chaptersFile ? ['-f', 'ffmetadata', '-i', ffmpegFileArg(chaptersFile)] : []),
    ...softSubtitleFiles.flatMap((f) => ['-f', 'srt', '-i', ffmpegFileArg(f)]),
  ];
  const aIn = n ? 1 : 0;
  const chIn = aIn + aLists.length;
  const subIn = chIn + (chaptersFile ? 1 : 0);
  const args = ['-hide_banner', '-nostdin', '-y', ...inputs,
    ...(n ? ['-map', '0:v:0'] : []), ...aLists.flatMap((_, k) => ['-map', `${aIn + k}:a:0`]), ...softSubtitleFiles.flatMap((_, k) => ['-map', `${subIn + k}:s:0`]),
    ...outputMetadataArgs(chaptersFile ? chIn : null),
    ...(n ? ['-c:v', 'copy', ...(hevcTag ? ['-tag:v', 'hvc1'] : [])] : ['-vn']), ...full.audioCodecArgs, ...full.subtitleCodecArgs, ...full.streamArgs,
    ...full.muxArgs.slice(0, -2), '-t', sec(n ? Math.max(full.durationSec, full.outputDurationSec) : full.durationSec), ...full.muxArgs.slice(-2), ffmpegFileArg(partPath)];
  try {
    if (signal?.aborted) throw new Error('Export canceled');
    await runFfmpeg(args, full.durationSec, (p) => report(W_MUX, p, `Joining ${Math.max(n, na)} chunks`), signal, onSpawn);
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
  const full = adaptFfmpegArgs(['-progress', 'pipe:1', '-nostats', '-loglevel', 'warning', ...args], ffmpegMajorVersionSync(bin));
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
    // Stall watchdog: some FFmpeg builds can spin forever (e.g. an AAC encoder bug in development builds). If neither
    // the output position nor the output size moves for STALL_MS, stop FFmpeg and fail with a clear message.
    let stalled = false;
    const progressState = new Map<string, string>();
    let lastProgressAt = Date.now();
    const stallMs = exportStallMs();
    const watchdog = setInterval(() => {
      if (settled || Date.now() - lastProgressAt < stallMs) return;
      stalled = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, Math.min(5000, Math.max(250, stallMs / 4)));
    watchdog.unref?.();

    const onAbort = () => {
      if (settled) return;
      canceled = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => { clearInterval(watchdog); signal?.removeEventListener('abort', onAbort); };

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
        const pk = /^(out_time_us|total_size)=(\S+)/.exec(line.trim());
        if (pk) {
          // Any movement of the output position or the output size counts as progress.
          const prev = progressState.get(pk[1]);
          if (prev !== pk[2]) { progressState.set(pk[1], pk[2]); lastProgressAt = Date.now(); }
        }
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
      if (stalled) {
        reject(new Error(`FFmpeg stopped making progress for ${Math.round(stallMs / 1000)} s and was stopped. `
          + 'This is usually an FFmpeg bug: try another FFmpeg release (development builds are not recommended) or a different audio bitrate.'));
        return;
      }
      if (code === 0) { resolve(); return; }
      const tail = stderrLines.slice(-30).join('\n');
      reject(new Error(`ffmpeg exited with ${code !== null ? `code ${code}` : `signal ${sig}`}${tail ? `:\n${tail}` : ''}`));
    });
  });
}

/** No-progress limit for one FFmpeg run (env RECUT_EXPORT_STALL_MS, default 2 minutes). */
export function exportStallMs(): number {
  const v = Number(process.env.RECUT_EXPORT_STALL_MS);
  return Number.isFinite(v) && v > 0 ? v : 120_000;
}

function formatClock(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = Math.floor(s % 60);
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
}
