/**
 * MKV packaging export (ROADMAP §7), measured on real FFmpeg exports with ffprobe:
 * - two output audio tracks built from mix definitions (a 5.1 main mix of A1 + A2, a stereo commentary of A3 alone):
 *   codecs, channel layouts, languages, titles, default flags, each track exactly the range's samples, and each
 *   carrying only its own sources;
 * - two soft subtitle streams (SRT) with languages, titles and default / forced flags, cue times relative to the range;
 * - chapters from the sequence's Chapter markers (ffprobe -show_chapters);
 * - the video exactly the range's frames; no metadata from the sources;
 * - AC-3 5.1 + AAC stereo downmix (the "5.1 + stereo downmix" preset); an MKV without output tracks has the one main mix;
 * - a chunked MKV export is the single pass, frame for frame and sample for sample, with the same streams.
 * Nothing here asserts on encoder-version metadata (ENCODER tags, exact AAC / AC-3 padding), so it holds on FFmpeg 6.1 to 9.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportSettings, MediaItem, MediaProbe, Sequence } from '@shared/model';
import type { ExportRequest } from '@shared/ipc';
import { createSequence } from '@shared/project';
import { makeClip } from '@shared/timeline';
import { audioOutputPreset } from '@shared/exportFormat';
import { adaptFfmpegArgs, ffmpegMajorVersionSync } from '../../electron/media/ffmpeg';
import { runExport, type ExportRunOptions } from '../../electron/export/exporter';
import { buildExportRequest } from '../../src/panels/export/request';

const exec = promisify(execFile);
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.RECUT_FFPROBE || 'ffprobe';
const FPS = { num: 24, den: 1 };
const SR = 48000;

let dir: string;
let video: MediaItem;   // 320x180, 24 fps, 6 s, 440 Hz stereo (title / comment tags that must not reach the export)
let music: MediaItem;   // 6 s 660 Hz stereo WAV
let talk: MediaItem;    // 6 s 880 Hz stereo WAV (the commentary)
let outN = 0;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-mkv-'));
  const v = path.join(dir, 'src.mkv');
  await ff(['-f', 'lavfi', '-i', 'testsrc=s=320x180:r=24:d=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2',
    '-metadata', 'title=Source Title', '-metadata:s:a:0', 'language=jpn', '-metadata:s:a:0', 'title=Source Audio', '-shortest', v]);
  video = await mediaItem('video', v);
  const m = path.join(dir, 'music.wav');
  await ff(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=6', '-ac', '2', '-c:a', 'pcm_s16le', m]);
  music = await mediaItem('music', m, 'audio');
  const t = path.join(dir, 'talk.wav');
  await ff(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=6', '-ac', '2', '-c:a', 'pcm_s16le', t]);
  talk = await mediaItem('talk', t, 'audio');
}, 60000);
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

async function ff(args: string[]): Promise<void> {
  await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...adaptFfmpegArgs(args, ffmpegMajorVersionSync(FFMPEG))], { maxBuffer: 64 * 1024 * 1024 });
}

async function probeJson(file: string, extra: string[] = []): Promise<any> {
  const { stdout } = await exec(FFPROBE, ['-v', 'error', ...extra, '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', file], { maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function mediaItem(id: string, file: string, kind: MediaItem['kind'] = 'video'): Promise<MediaItem> {
  const j = await probeJson(file);
  const v = j.streams.find((s: any) => s.codec_type === 'video');
  const rat = (r: string) => { const [n, d] = r.split('/').map(Number); return { num: n, den: d || 1 }; };
  const probe: MediaProbe = {
    container: j.format.format_name.split(',')[0], duration: Number(j.format.duration), size: Number(j.format.size),
    video: v ? { index: v.index, codec: v.codec_name, width: v.width, height: v.height, fps: rat(v.r_frame_rate), avgFps: rat(v.avg_frame_rate), isVfr: false } : undefined,
    audio: j.streams.filter((s: any) => s.codec_type === 'audio').map((s: any) => ({
      index: s.index, codec: s.codec_name, channels: s.channels, layout: s.channel_layout ?? '', sampleRate: Number(s.sample_rate),
    })),
    subtitles: [], startTime: Number(j.format.start_time ?? 0), browserPlayable: true,
  } as MediaProbe;
  return {
    id, name: path.basename(file), path: file, kind, category: 'Other', identity: {}, binId: null,
    probe, offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
  } as MediaItem;
}

function settings(over: Partial<ExportSettings> = {}): ExportSettings {
  return {
    outputDir: dir, fileName: `m${outN++}`, width: 320, height: 180, fps: FPS,
    videoCodec: 'libx264', qualityMode: 'crf', crf: 23, videoBitrateKbps: 2000, preset: 'ultrafast',
    audioCodec: 'aac', audioBitrateKbps: 128, audioChannels: 2, sampleRate: SR,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false, container: 'mkv', ...over,
  };
}

/**
 * 120 frames (5 s) at 24 fps: V1 two cuts; A1 "Dialogue" 440 Hz over 0..96; A2 "Music" 660 Hz over 24..120; A3
 * "Commentary" 880 Hz over 0..120. Subtitle tracks "English" (en) and "Français" (fre). Chapter markers at 0
 * "Opening" and 60 "Second half" (and an ordinary marker that is not a chapter). In/Out 12..108.
 */
function sequence(): Sequence {
  const s = createSequence('S', FPS, 320, 180);
  s.videoTracks[0].clips.push(
    makeClip({ mediaId: video.id, name: 'v1', sourceIn: 0, duration: 60, kind: 'video' }, 0),
    makeClip({ mediaId: video.id, name: 'v2', sourceIn: 3, duration: 60, kind: 'video' }, 60),
  );
  const [a1, a2, a3] = s.audioTracks;
  a1.name = 'Dialogue';
  a1.clips.push(makeClip({ mediaId: video.id, name: 'a1', sourceIn: 0, duration: 96, kind: 'audio', audioStream: video.probe!.audio[0].index }, 0));
  a2.name = 'Music';
  a2.clips.push(makeClip({ mediaId: music.id, name: 'm', sourceIn: 0.5, duration: 96, kind: 'audio', audioStream: music.probe!.audio[0].index }, 24));
  a3.name = 'Commentary';
  a3.clips.push(makeClip({ mediaId: talk.id, name: 'c', sourceIn: 0, duration: 120, kind: 'audio', audioStream: talk.probe!.audio[0].index }, 0));
  s.subtitleTracks.push(
    { id: 'sub-en', name: 'English', language: 'en', enabled: true, cues: [
      { id: 'e1', start: 24, duration: 24, offset: 0, text: 'Hello there' },
      { id: 'e2', start: 72, duration: 12, offset: 0, text: 'Second line' },
    ] },
    { id: 'sub-fr', name: 'Français', language: 'fre', enabled: false, cues: [
      { id: 'f1', start: 36, duration: 12, offset: 0, text: 'Bonjour' },
    ] },
  );
  s.markers.push(
    { id: 'k1', time: 0, duration: 0, name: 'Opening', note: '', color: '#fff', kind: 'chapter' },
    { id: 'k2', time: 60, duration: 0, name: 'Second half', note: '', color: '#fff', kind: 'chapter' },
    { id: 'k3', time: 30, duration: 0, name: 'Just a note', note: '', color: '#fff', kind: 'marker' },
  );
  s.view.inPoint = 12; s.view.outPoint = 108;
  return s;
}

const MEDIA = () => ({ [video.id]: video, [music.id]: music, [talk.id]: talk });

/** The request the Export dialog sends (request.ts: per-track subtitle cues included). */
function req(s: Sequence, over: Partial<ExportSettings> = {}): ExportRequest {
  return buildExportRequest({ media: MEDIA(), subtitleTracks: {} }, s, settings(over));
}

/** Main 5.1 FLAC (A1 + A2, eng) and Commentary stereo PCM (A3, eng); English (default) and French (forced) subtitles. */
function packaged(s: Sequence, over: Partial<ExportSettings> = {}): Partial<ExportSettings> {
  const [a1, a2, a3] = s.audioTracks;
  return {
    audioOutputs: [
      { sources: [a1.id, a2.id], layout: '5.1', codec: 'flac', language: 'eng', title: 'Main 5.1' },
      { sources: [a3.id], layout: 'stereo', codec: 'pcm', language: 'eng', title: 'Commentary' },
    ],
    subtitleOutputs: [
      { trackId: 'sub-en', default: true },
      { trackId: 'sub-fr', forced: true, title: 'French (forced)' },
    ],
    ...over,
  };
}

const NO_CHUNKS: ExportRunOptions = { chunked: false };
const SMALL_CHUNKS: ExportRunOptions = { chunked: true, maxSegmentsPerChunk: 1, maxAudioSegmentsPerChunk: 1 };

/** Decoded samples of audio stream `i` as float32, interleaved. */
async function samples(file: string, i = 0): Promise<{ data: Float32Array; channels: number }> {
  const j = await probeJson(file);
  const a = j.streams.filter((s: any) => s.codec_type === 'audio')[i];
  const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', `0:a:${i}`, '-f', 'f32le', '-c:a', 'pcm_f32le', '-'],
    { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  const b = stdout as unknown as Buffer;
  return { data: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)), channels: a.channels };
}

/** Power of `freq` in channel `ch` over sample frames [from, to) (Goertzel), normalised so a full-scale sine is ~0.25. */
function tone(d: { data: Float32Array; channels: number }, freq: number, from: number, to: number, ch = 0): number {
  const w = 2 * Math.PI * freq / SR, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = from; i < to; i++) { const s0 = d.data[i * d.channels + ch] + c * s1 - s2; s2 = s1; s1 = s0; }
  const n = to - from;
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / (n * n);
}

async function frameCount(file: string): Promise<number> {
  const j = await probeJson(file, ['-count_frames', '-select_streams', 'v:0']);
  return Number(j.streams[0].nb_read_frames);
}

/** The SRT text of subtitle stream `i`. */
async function subtitleText(file: string, i: number): Promise<string> {
  const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', `0:s:${i}`, '-f', 'srt', '-']);
  return stdout.replace(/\r\n/g, '\n');
}

// The In/Out range 12..108: 96 frames = 4 s = 192000 samples at 48 kHz.
const RANGE_FRAMES = 96;
const RANGE_SAMPLES = 192000;

// ---------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------


import crypto from 'node:crypto';
// TEMPORARY DIAGNOSTIC v2 (not for merge): the downmix export under heavy contention, verbose FFmpeg logs on outliers.
const STRESS = process.platform === 'darwin' && process.arch === 'arm64' && (process.env.MAC_ARCH === 'x64' || process.env.PROBE_FORCE === '1');
const N = Number(process.env.PROBE_N || (STRESS ? 60 : 2));
const P = Number(process.env.PROBE_P || (STRESS ? 6 : 2));
const md5 = (d: Float32Array) => crypto.createHash('md5').update(Buffer.from(d.buffer, d.byteOffset, d.byteLength)).digest('hex').slice(0, 8);
function windows(d: { data: Float32Array; channels: number }, freq: number, ch = 0): string {
  const out: string[] = []; const W = 2400; const frames = d.data.length / d.channels;
  for (let s = 0; s + W <= frames; s += W) {
    let re = 0, im = 0;
    for (let i = s; i < s + W; i++) { const x = d.data[i * d.channels + ch]; const a = 2 * Math.PI * freq * i / SR; re += x * Math.cos(a); im -= x * Math.sin(a); }
    out.push(`${(s / SR).toFixed(2)}:${(2 * Math.hypot(re, im) / W).toFixed(4)}@${(Math.atan2(im, re) * 180 / Math.PI).toFixed(0)}`);
  }
  return out.join(' ');
}
describe('PROBE2 downmix under contention', () => {
  it('repeated concurrent exports', async () => {
    const s = sequence();
    s.audioTracks[2].muted = true;
    const mk = () => req(s, { audioOutputs: audioOutputPreset('surroundStereo', s), rangeMode: 'inOut' });
    let base: string[] = [];
    const first = await runExport(mk(), undefined, undefined, { chunked: false, onSpawn: (c: any) => { base = c.spawnargs.slice(); } });
    fs.rmSync(first.outputPath);
    const { buildRenderGraph } = await import('../../electron/export/renderGraph');
    const graph = path.join(dir, 'probe-graph.txt');
    fs.writeFileSync(graph, buildRenderGraph(mk()).filterGraph);
    const fi = base.findIndex((a) => a === '-/filter_complex' || a === '-filter_complex_script');
    base[fi + 1] = graph;
    const bin = base[0];
    const ci = base.indexOf('ffmetadata');
    const core = base.slice(1).filter((a, i, all) => !(a === '-progress' || all[i - 1] === '-progress'))
      .filter((_, i, all) => true);
    const ci2 = core.indexOf('ffmetadata');
    const args0 = core.filter((_, i) => !(i >= ci2 - 1 && i <= ci2 + 2)).map((a, i, all) => (all[i - 1] === '-map_chapters' ? '-1' : all[i - 1] === '-loglevel' ? 'verbose' : a));
    void ci;
    const counts = new Map<string, number>();
    const rows: string[] = [];
    let total = 0;
    for (let k = 0; k < N; k++) {
      const jobs = Array.from({ length: P }, async (_, j) => {
        const out = path.join(dir, `p2-${j}.mkv`);
        const args = args0.slice(); args[args.length - 1] = out;
        let stderr = '';
        try { stderr = (await exec(bin, args, { maxBuffer: 64 * 1024 * 1024 })).stderr; } catch (e: any) { stderr = 'FAILED ' + String(e?.stderr ?? e); }
        return { out, stderr, via: 'exec' };
      });
      // One through the exporter itself as well.
      jobs.push(runExport(mk(), undefined, undefined, { chunked: false }).then((r) => ({ out: r.outputPath, stderr: '', via: 'runExport' })));
      const done = await Promise.all(jobs);
      for (const d of done) {
        total++;
        let key: string; let st: any = null; let s51: any = null;
        try {
          s51 = await samples(d.out, 0); st = await samples(d.out, 1);
          key = [tone(st, 440, 48000, 144000).toPrecision(8), tone(st, 660, 48000, 144000).toPrecision(8), tone(s51, 440, 48000, 144000).toPrecision(8), st.data.length / 2, s51.data.length / 6, md5(st.data), md5(s51.data)].join(' ');
        } catch (e) { key = 'MEASURE-FAILED ' + String(e); }
        const seen = counts.get(key) ?? 0;
        counts.set(key, seen + 1);
        if (seen === 0) {
          rows.push(`NEW k=${k} via=${d.via} ${key}`);
          if (st) { rows.push(`WIN stL440 ${windows(st, 440)}`); rows.push(`WIN 51FL440 ${windows(s51, 440)}`); rows.push(`WIN stL660 ${windows(st, 660)}`); }
          rows.push(`ERR ${d.stderr.split('\n').filter((l) => !/^\s*$/.test(l)).slice(0, 400).join(' | ')}`);
        }
        fs.rmSync(d.out, { force: true });
      }
    }
    const { stdout: ver } = await exec(bin, ['-version']).catch(() => ({ stdout: '?' }));
    console.log(`PROBE2 ffmpeg=${ver.split('\n')[0]} arch=${process.env.MAC_ARCH ?? process.arch} exports=${total}\n` +
      [...counts].map(([k, n]) => `PROBE2 COUNT ${n} ${k}`).join('\n') + '\n' + rows.map((r) => 'PROBE2 ' + r).join('\n'));
  }, 3600000);
});
