/**
 * Shared measurement helpers for the media attack suite (tests/attack).
 *
 * Media is generated once by gen-media.sh into ATTACK_MEDIA_DIR (default: the session scratchpad) and reused.
 * All measurements are made with ffmpeg/ffprobe on real files; nothing here is mocked.
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { Clip, ExportSettings, MediaItem, Rational, Sequence } from '@shared/model';
import type { ExportRequest } from '@shared/ipc';
import { createSequence } from '@shared/project';
import { frameCenterSeconds } from '@shared/time';
import { makeClip } from '@shared/timeline';
import { probeMedia, classifyKind } from '../../electron/media/probe';
import { runExport } from '../../electron/export/exporter';

const exec = promisify(execFile);
export const ROOT = path.resolve(__dirname, '..', '..');
export const SCRATCH = process.env.ATTACK_SCRATCH
  || '/tmp/claude-0/-home-user-ReCut/db207bb1-8e4d-5534-84bf-420066a58686/scratchpad/attack-media';
export const MEDIA_DIR = process.env.ATTACK_MEDIA_DIR || path.join(SCRATCH, 'media');
export const OUT_DIR = path.join(SCRATCH, 'out');
export const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
export const FFPROBE = process.env.RECUT_FFPROBE || 'ffprobe';

export const FPS_23976: Rational = { num: 24000, den: 1001 };
export const FPS_24: Rational = { num: 24, den: 1 };
export const FPS_25: Rational = { num: 25, den: 1 };
export const FPS_2997: Rational = { num: 30000, den: 1001 };

/** Generate the media set (idempotent) and return its directory. */
export function ensureMedia(): string {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  execFileSync('bash', [path.join(__dirname, 'gen-media.sh'), MEDIA_DIR], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 600_000 });
  return MEDIA_DIR;
}
export function mediaPath(name: string): string { return path.join(MEDIA_DIR, name); }

export async function ff(args: string[], opts: { maxBuffer?: number } = {}): Promise<{ stdout: Buffer; stderr: string }> {
  const { stdout, stderr } = await exec(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args], { encoding: 'buffer', maxBuffer: opts.maxBuffer ?? 256 * 1024 * 1024 });
  return { stdout: stdout as Buffer, stderr: String(stderr) };
}

export interface ProbeStream { index: number; codec_type: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; start_time?: string; duration?: string; nb_frames?: string; channels?: number; channel_layout?: string; sample_rate?: string; pix_fmt?: string; profile?: string; tags?: Record<string, string>; disposition?: Record<string, number>; side_data_list?: Record<string, unknown>[] }
export interface ProbeJson { format: { duration?: string; start_time?: string; format_name?: string; nb_streams?: number }; streams: ProbeStream[] }

export async function ffprobeJson(file: string, extra: string[] = []): Promise<ProbeJson> {
  const { stdout } = await exec(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...extra, file], { maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(String(stdout)) as ProbeJson;
}

/** Exact frame count of the first video stream (decodes the file). */
export async function countFrames(file: string): Promise<number> {
  const { stdout } = await exec(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]);
  return Number(String(stdout).trim());
}

/** Presentation timestamps (seconds) of every decoded video frame. */
export async function framePts(file: string): Promise<number[]> {
  const { stdout } = await exec(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file], { maxBuffer: 64 * 1024 * 1024 });
  return String(stdout).split('\n').map((s) => s.trim().replace(/,$/, '')).filter(Boolean).map(Number);
}

/**
 * Decode the burned-in frame counter of every frame (see gen-media.sh: top half = 16+4*(N%50), bottom = 16+4*(floor(N/50)%50)).
 * Returns -1 for frames that do not carry a valid counter (e.g. black gap frames, fades).
 */
export async function readCounters(file: string, extraInput: string[] = []): Promise<number[]> {
  const { stdout } = await ff([...extraInput, '-i', file, '-map', '0:v:0', '-vf', 'scale=2:2:flags=area', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']);
  const out: number[] = [];
  for (let i = 0; i + 6 <= stdout.length; i += 6) {
    const top = (stdout[i] + stdout[i + 1]) / 2, bot = (stdout[i + 2] + stdout[i + 3]) / 2;
    const lo = (top - 16) / 4, hi = (bot - 16) / 4;
    const loR = Math.round(lo), hiR = Math.round(hi);
    const ok = Math.abs(lo - loR) < 0.35 && Math.abs(hi - hiR) < 0.35 && loR >= 0 && loR < 50 && hiR >= 0 && hiR < 50;
    out.push(ok ? hiR * 50 + loR : -1);
  }
  return out;
}

/** Mean luma (Y plane, 16..235) of every frame. */
export async function frameLuma(file: string): Promise<number[]> {
  const { stdout } = await ff(['-i', file, '-map', '0:v:0', '-vf', 'scale=2:2:flags=area', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']);
  const out: number[] = [];
  for (let i = 0; i + 6 <= stdout.length; i += 6) out.push((stdout[i] + stdout[i + 1] + stdout[i + 2] + stdout[i + 3]) / 4);
  return out;
}

/** Indices of frames whose mean luma exceeds `threshold` (flash frames of the sync sources). */
export async function flashFrames(file: string, threshold = 120): Promise<number[]> {
  const l = await frameLuma(file);
  return l.map((v, i) => (v > threshold ? i : -1)).filter((i) => i >= 0);
}

/**
 * Decode the first audio stream (or `stream`, absolute index) to mono 48 kHz s16 and return the onset times (seconds)
 * of bursts: the first sample above `threshold` (0..1) after at least `quiet` seconds below it.
 */
export async function audioOnsets(file: string, opts: { threshold?: number; quiet?: number; stream?: number; rate?: number } = {}): Promise<number[]> {
  const rate = opts.rate ?? 48000;
  const map = opts.stream !== undefined ? `0:${opts.stream}` : '0:a:0';
  const { stdout } = await ff(['-i', file, '-map', map, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-']);
  const th = (opts.threshold ?? 0.1) * 32767;
  const quietSamples = Math.round((opts.quiet ?? 0.1) * rate);
  const onsets: number[] = [];
  let lastLoud = -Infinity;
  for (let i = 0; i + 1 < stdout.length; i += 2) {
    const v = stdout.readInt16LE(i);
    const n = i / 2;
    if (Math.abs(v) > th) {
      if (n - lastLoud > quietSamples) onsets.push(n / rate);
      lastLoud = n;
    }
  }
  return onsets;
}

/** RMS level (0..1) of mono-mixed audio between t0 and t1 seconds. */
export async function audioRms(file: string, t0: number, t1: number, stream?: number): Promise<number> {
  const map = stream !== undefined ? `0:${stream}` : '0:a:0';
  const { stdout } = await ff(['-i', file, '-map', map, '-vn', '-ac', '1', '-ar', '48000', '-af', `atrim=start=${t0}:end=${t1}`, '-f', 's16le', '-']);
  let acc = 0; const n = stdout.length / 2;
  for (let i = 0; i + 1 < stdout.length; i += 2) { const v = stdout.readInt16LE(i) / 32768; acc += v * v; }
  return n ? Math.sqrt(acc / n) : 0;
}

/** Duration (seconds) of decoded audio of a file (first stream or absolute index). */
export async function audioDecodedDuration(file: string, stream?: number): Promise<number> {
  const map = stream !== undefined ? `0:${stream}` : '0:a:0';
  const { stdout } = await ff(['-i', file, '-map', map, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-']);
  return stdout.length / 2 / 48000;
}

// ---------------------------------------------------------------- project model helpers

let idCounter = 0;
/** Build a MediaItem through the real probe + classify code of electron/media/probe.ts. */
export async function makeMediaItem(file: string, over: Partial<MediaItem> = {}): Promise<MediaItem> {
  const probe = await probeMedia(file);
  const kind = classifyKind(probe, file);
  const st = fs.statSync(file);
  return {
    id: `m${++idCounter}_${path.basename(file).replace(/\W+/g, '_')}`, name: path.basename(file), path: file, kind, category: 'Other', identity: {}, binId: null,
    probe, offline: false, fileSize: st.size, fileMtime: st.mtimeMs, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [],
    notes: '', tags: [], addedAt: 0, ...over,
  };
}

export function makeSeq(fps: Rational, w = 320, h = 240): Sequence { return createSequence('Attack', fps, w, h); }

export function vclip(seq: Sequence, media: MediaItem, start: number, frames: number, sourceIn: number, speed = 1, track = 0): Clip {
  const c = makeClip({ mediaId: media.id, name: `${media.name}@${start}`, sourceIn, duration: frames, speed, kind: 'video' }, start);
  seq.videoTracks[track].clips.push(c);
  return c;
}
export function aclip(seq: Sequence, media: MediaItem, start: number, frames: number, sourceIn: number, speed = 1, track = 0, stream?: number): Clip {
  const s = stream ?? media.probe?.audio[0]?.index;
  const c = makeClip({ mediaId: media.id, name: `${media.name}@${start}a`, sourceIn, duration: frames, speed, kind: 'audio', audioStream: s }, start);
  seq.audioTracks[track].clips.push(c);
  return c;
}

let outN = 0;
export function settings(fps: Rational, over: Partial<ExportSettings> = {}): ExportSettings {
  return {
    outputDir: OUT_DIR, fileName: `attack_${process.pid}_${outN++}.mp4`, width: 320, height: 240, fps,
    videoCodec: 'libx264', qualityMode: 'crf', crf: 16, videoBitrateKbps: 2000, preset: 'veryfast',
    audioCodec: 'aac', audioBitrateKbps: 192, audioChannels: 2, sampleRate: 48000,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false, ...over,
  };
}

export function request(seq: Sequence, media: MediaItem[], over: Partial<ExportSettings> = {}): ExportRequest {
  const m: Record<string, MediaItem> = {};
  for (const x of media) m[x.id] = x;
  return { sequence: seq, media: m, settings: settings(seq.fps, over) };
}

export async function exportSeq(seq: Sequence, media: MediaItem[], over: Partial<ExportSettings> = {}): Promise<{ outputPath: string; warnings: string[]; durationSec: number }> {
  const r = await runExport(request(seq, media, over));
  return r;
}

/** Editor model: the media frame the Program Monitor shows for a layer at `sourceTime` (frame-centered seek, Chromium shows the frame covering t). */
export function editorMediaFrame(sourceTime: number, mediaFps: Rational): number {
  const t = sourceTime + 0.5 / (mediaFps.num / mediaFps.den);
  return Math.floor(t * mediaFps.num / mediaFps.den + 1e-9);
}

export function fmt(n: number, d = 4): string { return Number.isFinite(n) ? n.toFixed(d) : String(n); }

// ---------------------------------------------------------------- patched export (root-cause experiments)
import { buildRenderGraph, FILTER_SCRIPT_TOKEN } from '../../electron/export/renderGraph';

/**
 * Build the render graph, let `patch` rewrite the filter graph / args, and run ffmpeg exactly like exporter.ts does.
 * Used to demonstrate root causes (e.g. replacing one filter) without modifying renderGraph.ts.
 */
export async function exportPatched(req: ExportRequest, patch: { filter?: (g: string) => string; args?: (a: string[]) => string[] }): Promise<{ outputPath: string; filterGraph: string }> {
  const g = buildRenderGraph(req);
  const filterGraph = patch.filter ? patch.filter(g.filterGraph) : g.filterGraph;
  const script = path.join(OUT_DIR, `patched_${process.pid}_${outN++}.txt`);
  fs.writeFileSync(script, filterGraph, 'utf8');
  let args = g.args.map((a) => (a === FILTER_SCRIPT_TOKEN ? script : a));
  if (patch.args) args = patch.args(args);
  const outputPath = args[args.length - 1];
  await exec(FFMPEG, args, { maxBuffer: 64 * 1024 * 1024 });
  return { outputPath, filterGraph };
}

/** Editor frames (sequence of `fps`, clip sourceIn 0, speed 1) at which a source frame with absolute pts `absPts` is shown:
 *  Chromium's time base starts at the container start_time; the player seeks to frame centers and shows the covering frame. */
export function editorFramesShowing(absPts: number, nextAbsPts: number, containerStart: number, fps: Rational): number[] {
  const t0 = absPts - containerStart, t1 = nextAbsPts - containerStart;
  const out: number[] = [];
  const first = Math.ceil((t0 - 0.5 * fps.den / fps.num) * fps.num / fps.den - 1e-9);
  for (let f = Math.max(0, first); ; f++) {
    const c = frameCenterSeconds(f, fps);
    if (c >= t1) break;
    if (c >= t0) out.push(f);
  }
  return out;
}
