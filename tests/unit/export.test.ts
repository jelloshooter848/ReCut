/**
 * Export pipeline tests: generate tiny synthetic media with ffmpeg, export sequences through
 * runExport, then verify the output with ffprobe/ffmpeg (duration, fps, size, pixel colors, audio).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Clip, ExportSettings, MediaItem, MediaProbe, Sequence, Transition } from '@shared/model';
import type { ExportRequest } from '@shared/ipc';
import { createSequence } from '@shared/project';
import { makeClip } from '@shared/timeline';
import { buildRenderGraph, escapeFilterPath, exportOutputPath, FILTER_SCRIPT_TOKEN, sanitizeExportFileName } from '../../electron/export/renderGraph';
import { runExport, buildExportCommand, startExportJob, type ExportJobQueue, type ExportJobSpec } from '../../electron/export/exporter';
import { planExportChunks, sampleIndexAt, shouldChunk } from '../../electron/export/chunks';
import type { ChildProcess } from 'node:child_process';

const exec = promisify(execFile);
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.RECUT_FFPROBE || 'ffprobe';
const FPS = { num: 24, den: 1 };

let dir: string;
let mediaA: MediaItem; // red 10s + 440Hz
let mediaB: MediaItem; // blue 10s + 880Hz
let media51: MediaItem; // 5.1 audio-only 4s
let outN = 0;

async function ff(args: string[]): Promise<void> {
  await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 64 * 1024 * 1024 });
}

async function probe(file: string): Promise<MediaProbe> {
  const { stdout } = await exec(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s: any) => s.codec_type === 'video');
  const audio = j.streams.filter((s: any) => s.codec_type === 'audio').map((s: any) => ({
    index: s.index, codec: s.codec_name, channels: s.channels, layout: s.channel_layout ?? '', sampleRate: Number(s.sample_rate),
  }));
  const rat = (r: string) => { const [n, d] = r.split('/').map(Number); return { num: n, den: d || 1 }; };
  return {
    container: j.format.format_name, duration: Number(j.format.duration), size: Number(j.format.size),
    video: v ? { index: v.index, codec: v.codec_name, width: v.width, height: v.height, fps: rat(v.r_frame_rate), avgFps: rat(v.avg_frame_rate), isVfr: false } : undefined,
    audio, subtitles: [], startTime: Number(j.format.start_time ?? 0), browserPlayable: true,
  };
}

async function makeMedia(id: string, file: string, kind: MediaItem['kind']): Promise<MediaItem> {
  return {
    id, name: path.basename(file), path: file, kind, category: 'Other', identity: {}, binId: null,
    probe: await probe(file), offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [],
    notes: '', tags: [], addedAt: 0,
  };
}

function settings(over: Partial<ExportSettings> = {}): ExportSettings {
  return {
    outputDir: dir, fileName: `out${outN++}.mp4`, width: 320, height: 240, fps: FPS,
    videoCodec: 'libx264', qualityMode: 'crf', crf: 23, videoBitrateKbps: 2000, preset: 'ultrafast',
    audioCodec: 'aac', audioBitrateKbps: 128, audioChannels: 2, sampleRate: 48000,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false, ...over,
  };
}

function seq(): Sequence { return createSequence('T', FPS, 320, 240); }

function vclip(seq: Sequence, media: MediaItem, start: number, frames: number, sourceIn: number, speed = 1): Clip {
  const c = makeClip({ mediaId: media.id, name: `${media.name}@${start}`, sourceIn, duration: frames, speed, kind: 'video' }, start);
  seq.videoTracks[0].clips.push(c);
  return c;
}
function aclip(seq: Sequence, media: MediaItem, start: number, frames: number, sourceIn: number, speed = 1, track = 0): Clip {
  const stream = media.probe!.audio[0].index;
  const c = makeClip({ mediaId: media.id, name: `${media.name}@${start}a`, sourceIn, duration: frames, speed, kind: 'audio', audioStream: stream }, start);
  seq.audioTracks[track].clips.push(c);
  return c;
}

function req(sequence: Sequence, over: Partial<ExportSettings> = {}, extra: Partial<ExportRequest> = {}): ExportRequest {
  const media: Record<string, MediaItem> = {};
  for (const m of [mediaA, mediaB, media51]) media[m.id] = m;
  return { sequence, media, settings: settings(over), ...extra };
}

interface OutInfo { duration: number; width?: number; height?: number; fps?: string; channels?: number; layout?: string; hasAudio: boolean; hasVideo: boolean }
async function probeOut(file: string): Promise<OutInfo> {
  const p = await probe(file);
  const a = p.audio[0];
  return {
    duration: p.duration, width: p.video?.width, height: p.video?.height, fps: p.video ? `${p.video.fps.num}/${p.video.fps.den}` : undefined,
    channels: a?.channels, layout: a?.layout, hasAudio: !!a, hasVideo: !!p.video,
  };
}

/** Average RGB of the frame at time t. */
async function frameColor(file: string, t: number): Promise<[number, number, number]> {
  const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const buf = stdout as unknown as Buffer;
  let r = 0, g = 0, b = 0; const n = buf.length / 3;
  for (let i = 0; i < buf.length; i += 3) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; }
  return [r / n, g / n, b / n];
}

/** mean_volume (dB) of the audio over [t, t+len]; -Infinity for digital silence / no audio. */
async function meanVolume(file: string, t: number, len: number): Promise<number> {
  const { stderr } = await exec(FFMPEG, ['-hide_banner', '-ss', String(t), '-t', String(len), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  const m = /mean_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(stderr);
  if (!m) return -Infinity;
  return m[1] === '-inf' ? -Infinity : Number(m[1]);
}

const isRed = (c: [number, number, number]) => c[0] > 150 && c[1] < 80 && c[2] < 80;
const isBlue = (c: [number, number, number]) => c[2] > 150 && c[0] < 80 && c[1] < 80;
const isBlack = (c: [number, number, number]) => c[0] < 30 && c[1] < 30 && c[2] < 30;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-export-test-'));
  const a = path.join(dir, 'red.mp4'), b = path.join(dir, 'blue.mp4'), s = path.join(dir, 'surround.mp4');
  await Promise.all([
    ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=24:d=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=10',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-shortest', a]),
    ff(['-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=24:d=10', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=10',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-shortest', b]),
    ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-af', 'aformat=channel_layouts=5.1', '-c:a', 'aac', '-f', 'mp4', s]),
  ]);
  mediaA = await makeMedia('mA', a, 'video');
  mediaB = await makeMedia('mB', b, 'video');
  media51 = await makeMedia('m51', s, 'audio');
}, 60000);

afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('export pipeline', () => {
  it('(a) renders a three-cut sequence with exact duration and correct content/audio', async () => {
    const s = seq();
    vclip(s, mediaA, 0, 48, 2);     // A 2s..4s
    vclip(s, mediaB, 48, 48, 1);    // B 1s..3s
    vclip(s, mediaA, 96, 24, 6);    // A 6s..7s
    aclip(s, mediaA, 0, 48, 2);
    aclip(s, mediaB, 48, 48, 1);
    aclip(s, mediaA, 96, 24, 6);
    const r = req(s);
    const res = await runExport(r, undefined);
    expect(res.warnings).toEqual([]);
    const info = await probeOut(res.outputPath);
    expect(Math.abs(info.duration - 5.0)).toBeLessThan(0.05);
    expect(info.fps).toBe('24/1');
    expect(info.width).toBe(320);
    expect(info.height).toBe(240);
    expect(info.hasAudio).toBe(true);
    expect(isRed(await frameColor(res.outputPath, 1.0))).toBe(true);
    expect(isBlue(await frameColor(res.outputPath, 3.0))).toBe(true);
    expect(isRed(await frameColor(res.outputPath, 4.5))).toBe(true);
    expect(await meanVolume(res.outputPath, 1.0, 0.5)).toBeGreaterThan(-40);
    expect(await meanVolume(res.outputPath, 4.2, 0.5)).toBeGreaterThan(-40);
  }, 30000);

  it('(b) a muted audio clip renders silence', async () => {
    const s = seq();
    vclip(s, mediaA, 0, 48, 2);
    const c = aclip(s, mediaA, 0, 48, 2);
    c.audio.muted = true;
    const res = await runExport(req(s));
    const info = await probeOut(res.outputPath);
    expect(info.hasAudio).toBe(true);
    expect(await meanVolume(res.outputPath, 0.5, 1)).toBeLessThan(-80);
  }, 30000);

  it('(c) a cross dissolve mixes both clips at the cut and keeps timing', async () => {
    const s = seq();
    const a = vclip(s, mediaA, 0, 48, 2);
    const b = vclip(s, mediaB, 48, 48, 1);
    const tr: Transition = { id: 'tr1', type: 'crossDissolve', duration: 12, outClipId: a.id, inClipId: b.id };
    s.videoTracks[0].transitions.push(tr);
    const g = buildRenderGraph(req(s));
    expect(g.warnings).toEqual([]);
    expect(g.filterGraph).toContain('xfade=transition=fade:duration=0.5:offset=1.75');
    const res = await runExport(req(s));
    const info = await probeOut(res.outputPath);
    expect(Math.abs(info.duration - 4.0)).toBeLessThan(0.05);
    const mid = await frameColor(res.outputPath, 2.0);
    expect(mid[0]).toBeGreaterThan(60);
    expect(mid[2]).toBeGreaterThan(60);
    expect(isRed(await frameColor(res.outputPath, 1.0))).toBe(true);
    expect(isBlue(await frameColor(res.outputPath, 3.5))).toBe(true);
  }, 30000);

  it('(c2) transitions are clamped when a clip lacks source handles', () => {
    const s = seq();
    const a = vclip(s, mediaA, 0, 48, 2);
    const b = vclip(s, mediaB, 48, 48, 0);   // B starts at source 0: no in-handle
    s.videoTracks[0].transitions.push({ id: 'tr', type: 'crossDissolve', duration: 12, outClipId: a.id, inClipId: b.id });
    const g = buildRenderGraph(req(s));
    expect(g.filterGraph).not.toContain('xfade');
    expect(g.warnings.some((w) => /handles/.test(w))).toBe(true);
  });

  it('(d) gaps render black and the output covers the whole sequence', async () => {
    const s = seq();
    vclip(s, mediaA, 24, 24, 2);
    const res = await runExport(req(s));
    const info = await probeOut(res.outputPath);
    expect(Math.abs(info.duration - 2.0)).toBeLessThan(0.05);
    expect(isBlack(await frameColor(res.outputPath, 0.5))).toBe(true);
    expect(isRed(await frameColor(res.outputPath, 1.5))).toBe(true);
  }, 30000);

  it('(e) rangeMode inOut exports only the marked range', async () => {
    const s = seq();
    vclip(s, mediaA, 0, 48, 2);
    vclip(s, mediaB, 48, 48, 1);
    vclip(s, mediaA, 96, 24, 6);
    s.view.inPoint = 24; s.view.outPoint = 72;
    const res = await runExport(req(s, { rangeMode: 'inOut' }));
    const info = await probeOut(res.outputPath);
    expect(Math.abs(info.duration - 2.0)).toBeLessThan(0.05);
    expect(isRed(await frameColor(res.outputPath, 0.5))).toBe(true);
    expect(isBlue(await frameColor(res.outputPath, 1.5))).toBe(true);
  }, 30000);

  it('(f) 5.1 source exports as 6 channels or stereo per settings', async () => {
    const s = seq();
    aclip(s, media51, 0, 48, 0.5);
    const six = await runExport(req(s, { audioChannels: 6, audioBitrateKbps: 384 }));
    const i6 = await probeOut(six.outputPath);
    expect(i6.channels).toBe(6);
    expect(Math.abs(i6.duration - 2.0)).toBeLessThan(0.05);
    expect(i6.hasVideo).toBe(true);
    const two = await runExport(req(s, { audioChannels: 2 }));
    const i2 = await probeOut(two.outputPath);
    expect(i2.channels).toBe(2);
    expect(await meanVolume(two.outputPath, 0.5, 1)).toBeGreaterThan(-40);
  }, 40000);

  it('(g) a 2x speed clip consumes 4s of source over 2s of timeline', async () => {
    const s = seq();
    vclip(s, mediaA, 0, 48, 1, 2);
    aclip(s, mediaA, 0, 48, 1, 2);
    const g = buildRenderGraph(req(s));
    expect(g.filterGraph).toContain('setpts=PTS/2');
    expect(g.filterGraph).toContain('atempo=2');
    const res = await runExport(req(s));
    const info = await probeOut(res.outputPath);
    expect(Math.abs(info.duration - 2.0)).toBeLessThan(0.05);
    expect(isRed(await frameColor(res.outputPath, 1.9))).toBe(true);
    expect(await meanVolume(res.outputPath, 1.0, 0.5)).toBeGreaterThan(-40);
  }, 30000);

  it('(h) opacity 0.5 over black renders half-intensity red', async () => {
    const s = seq();
    const c = vclip(s, mediaA, 0, 24, 2);
    c.transform.opacity = 0.5;
    const res = await runExport(req(s));
    const [r, g, b] = await frameColor(res.outputPath, 0.5);
    expect(r).toBeGreaterThan(90);
    expect(r).toBeLessThan(170);
    expect(g).toBeLessThan(40);
    expect(b).toBeLessThan(40);
  }, 30000);

  it('(i) offline media produces a warning and a black placeholder', () => {
    const s = seq();
    vclip(s, mediaA, 0, 24, 2);
    const r = req(s);
    r.media = { ...r.media, [mediaA.id]: { ...mediaA, offline: true } };
    const g = buildRenderGraph(r);
    expect(g.warnings.some((w) => /offline/.test(w))).toBe(true);
    expect(g.inputCount).toBe(0);
    expect(g.durationSec).toBe(1);
    expect(g.args[g.args.length - 1]).toBe(path.join(dir, r.settings.fileName));
    expect(g.args).toContain(FILTER_SCRIPT_TOKEN);
  });

  it('(j) transform: position, scale and rotation move the image off-center', async () => {
    const s = seq();
    const c = vclip(s, mediaA, 0, 24, 2);
    c.transform.scale = 0.5;
    c.transform.x = 80;   // image occupies x 160+80-80 .. => right half
    c.transform.rotation = 10;
    const res = await runExport(req(s));
    expect(res.warnings).toEqual([]);
    // Left edge is black, center-right area is red.
    const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', res.outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
    const buf = stdout as unknown as Buffer;
    const px = (x: number, y: number) => buf[(y * 320 + x) * 3];
    expect(px(10, 120)).toBeLessThan(30);
    expect(px(240, 120)).toBeGreaterThan(150);
  }, 30000);

  it('(k) burn-in subtitles and sidecar export', async () => {
    const s = seq();
    vclip(s, mediaA, 0, 48, 2);
    const r = req(s, { burnSubtitles: true, exportSubtitleSidecar: true }, { subtitles: [{ start: 0.2, end: 1.8, text: 'HELLO WORLD' }] });
    const g = buildRenderGraph(r, { subtitleFilePath: '/tmp/a b/c:d.srt' });
    expect(g.subtitleContent).toContain('HELLO WORLD');
    expect(g.filterGraph).toContain(`subtitles=filename=${escapeFilterPath('/tmp/a b/c:d.srt')}`);
    const res = await runExport(r);
    expect(res.sidecarPath).toBeDefined();
    expect(fs.readFileSync(res.sidecarPath!, 'utf8')).toContain('HELLO WORLD');
    // Burned-in white text: count bright (non-red) pixels in the frame.
    const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', '1.0', '-i', res.outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
    const buf = stdout as unknown as Buffer;
    let white = 0;
    for (let i = 0; i < buf.length; i += 3) if (buf[i + 1] > 150 && buf[i + 2] > 150) white++;
    expect(white).toBeGreaterThan(50);
    expect(isRed(await frameColor(res.outputPath, 1.9))).toBe(true);
  }, 30000);

  it('(l) audio crossfade + 23.976 fps sequence is frame-exact', async () => {
    const s = createSequence('T', { num: 24000, den: 1001 }, 320, 240);
    const a = makeClip({ mediaId: mediaA.id, name: 'a', sourceIn: 2, duration: 48, kind: 'audio', audioStream: 1 }, 0);
    const b = makeClip({ mediaId: mediaB.id, name: 'b', sourceIn: 1, duration: 48, kind: 'audio', audioStream: 1 }, 48);
    s.audioTracks[0].clips.push(a, b);
    s.audioTracks[0].transitions.push({ id: 'tr', type: 'audioCrossfade', duration: 12, outClipId: a.id, inClipId: b.id });
    s.videoTracks[0].clips.push(makeClip({ mediaId: mediaA.id, name: 'v', sourceIn: 0, duration: 96, kind: 'video' }, 0));
    const g = buildRenderGraph(req(s, { fps: { num: 24000, den: 1001 } }));
    expect(g.warnings).toEqual([]);
    expect(g.filterGraph).toContain('acrossfade=d=0.5005:c1=tri:c2=tri');
    const res = await runExport(req(s, { fps: { num: 24000, den: 1001 } }));
    const { stdout } = await exec(FFPROBE, ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=nb_read_frames,r_frame_rate', '-of', 'csv=p=0', res.outputPath]);
    expect(stdout.trim()).toBe('24000/1001,96');
    expect(await meanVolume(res.outputPath, 1.9, 0.2)).toBeGreaterThan(-40);
    expect(await meanVolume(res.outputPath, 3.0, 0.5)).toBeGreaterThan(-40);
  }, 30000);

  it('(m) upper video tracks composite over lower ones; audio tracks are mixed', async () => {
    const s = seq();
    vclip(s, mediaA, 0, 24, 2);
    s.videoTracks[1].clips.push(makeClip({ mediaId: mediaB.id, name: 'v2', sourceIn: 1, duration: 12, kind: 'video' }, 12));
    aclip(s, mediaA, 0, 24, 2, 1, 0);
    aclip(s, mediaB, 0, 24, 1, 1, 1);
    s.audioTracks[1].volume = 0.5;
    const g = buildRenderGraph(req(s));
    expect(g.filterGraph).toContain('amix=inputs=2:normalize=0');
    expect(g.filterGraph).toContain('volume=0.5');
    const res = await runExport(req(s));
    expect(isRed(await frameColor(res.outputPath, 0.25))).toBe(true);
    expect(isBlue(await frameColor(res.outputPath, 0.75))).toBe(true);
    expect(await meanVolume(res.outputPath, 0.2, 0.5)).toBeGreaterThan(-40);
  }, 30000);

  it('escapes filter paths for both parsing levels', () => {
    expect(escapeFilterPath('/plain/path.srt')).toBe('/plain/path.srt');
    // Graph level unescapes once, then the option parser unescapes again: C\\:\\\\x\\\\y.srt -> C\:\\x\\y.srt -> C:\x\y.srt
    expect(escapeFilterPath('C:\\x\\y.srt')).toBe('C\\\\:\\\\\\\\x\\\\\\\\y.srt');
    expect(escapeFilterPath("it's.srt")).toBe("it\\\\\\'s.srt");
  });

  it('buildExportCommand inlines the filter graph; startExportJob queues a job', async () => {
    const s = seq();
    vclip(s, mediaA, 0, 24, 2);
    const cmd = buildExportCommand(req(s));
    expect(cmd).toContain('-filter_complex');
    expect(cmd).not.toContain(FILTER_SCRIPT_TOKEN);
    const added: ExportJobSpec[] = [];
    const queue: ExportJobQueue = {
      add: (spec) => { added.push(spec); return { id: 'job1', kind: spec.kind, title: spec.title, status: 'queued', progress: 0 }; },
      cancel: () => {},
    };
    const r = req(s);
    const start = await startExportJob(queue, r);
    expect(start.ok).toBe(true);
    if (start.ok) expect(start.outputPath).toBe(path.join(dir, r.settings.fileName));
    expect(added[0].kind).toBe('export');
    let last = 0;
    await added[0].run({ setProgress: (p) => { last = Math.max(last, p); }, onCancel: () => {} });
    expect(last).toBe(1);
    expect(fs.existsSync(start.ok ? start.outputPath : '')).toBe(true);
    // Empty sequence is rejected up front.
    const bad = await startExportJob(queue, req(seq()));
    expect(bad.ok).toBe(false);
  }, 30000);

  it('cancel kills ffmpeg and removes the partial output', async () => {
    const s = seq();
    vclip(s, mediaA, 0, 240, 0);
    const r = req(s, { preset: 'veryslow', crf: 10, width: 320, height: 240 });
    const ac = new AbortController();
    const p = runExport(r, (prog) => { if (prog > 0) ac.abort(); }, ac.signal);
    setTimeout(() => ac.abort(), 1500);
    await expect(p).rejects.toThrow(/canceled/);
    expect(fs.existsSync(path.join(dir, r.settings.fileName))).toBe(false);
    expect(fs.existsSync(path.join(dir, r.settings.fileName.replace(/\.mp4$/, '.part.mp4')))).toBe(false);
  }, 30000);
});

describe('export request validation', () => {
  const fakeQueue = (): ExportJobQueue & { added: number } => {
    const q = { added: 0, add: (spec: ExportJobSpec) => { q.added++; return { id: 'j', kind: 'export' as const, title: spec.title, status: 'queued' as const, progress: 0 }; }, cancel: () => {} };
    return q;
  };

  it('refuses an output folder under /proc quickly instead of hanging the main process (BUG-1)', async () => {
    if (process.platform !== 'linux') return;
    const s = seq();
    vclip(s, mediaA, 0, 24, 0);
    const q = fakeQueue();
    const t0 = Date.now();
    const res = await startExportJob(q, req(s, { outputDir: '/proc/recut-nope' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Cannot create output folder/);
    expect(q.added).toBe(0);
    await expect(runExport(req(s, { outputDir: '/proc/recut-nope/deeper' }))).rejects.toThrow(/Cannot create output folder/);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('refuses an output (or its .part / sidecar) that is a source or proxy of the sequence (QA-03)', async () => {
    const s = seq();
    vclip(s, mediaA, 0, 24, 0);
    const srcDir = path.dirname(mediaA.path);
    const base = path.basename(mediaA.path);
    expect(() => buildRenderGraph(req(s, { outputDir: srcDir, fileName: base }))).toThrow(/used by the sequence/);
    const q = fakeQueue();
    const r = await startExportJob(q, req(s, { outputDir: srcDir, fileName: base }));
    expect(r.ok).toBe(false);
    expect(q.added).toBe(0);
    // .part temp equal to a source
    const partVictim = path.join(dir, 'victim.part.mp4');
    fs.copyFileSync(mediaA.path, partVictim);
    const m2 = { ...mediaA, id: 'pv', path: partVictim };
    const s2 = seq(); vclip(s2, m2, 0, 24, 0);
    expect(() => buildRenderGraph({ sequence: s2, media: { pv: m2 }, settings: settings({ fileName: 'victim.mp4' }) })).toThrow(/used by the sequence/);
    // sidecar .srt / proxy path
    const m3 = { ...mediaA, id: 'px', proxy: { status: 'ready' as const, path: path.join(dir, 'prx.mp4') } };
    const s3 = seq(); vclip(s3, m3, 0, 24, 0);
    expect(() => buildRenderGraph({ sequence: s3, media: { px: m3 }, settings: settings({ fileName: 'prx.mp4' }) })).toThrow(/used by the sequence/);
    const m4 = { ...mediaA, id: 'sc', path: path.join(dir, 'cap.srt') };
    const s4 = seq(); vclip(s4, m4, 0, 24, 0);
    expect(() => buildRenderGraph({ sequence: s4, media: { sc: m4 }, settings: settings({ fileName: 'cap.mp4', exportSubtitleSidecar: true }) })).toThrow(/used by the sequence/);
    expect(() => buildRenderGraph({ sequence: s4, media: { sc: m4 }, settings: settings({ fileName: 'cap.mp4' }) })).not.toThrow();
  });

  it('compares case-insensitively on win32/darwin and through symlinks via realpath', async () => {
    const s = seq();
    vclip(s, mediaA, 0, 24, 0);
    const upper = path.basename(mediaA.path).toUpperCase();
    const r = req(s, { outputDir: path.dirname(mediaA.path), fileName: upper });
    expect(() => buildRenderGraph(r, { platform: 'darwin' })).toThrow(/used by the sequence/);
    expect(() => buildRenderGraph(r, { platform: 'linux' })).not.toThrow();
    const link = path.join(dir, 'linkdir');
    try { fs.symlinkSync(path.dirname(mediaA.path), link, 'dir'); } catch { return; }
    const res = await startExportJob(fakeQueue(), req(s, { outputDir: link, fileName: path.basename(mediaA.path) }));
    expect(res.ok).toBe(false);
  });

  it('sanitizes the file name to a basename server-side (QA-19)', () => {
    expect(sanitizeExportFileName('../../escape.mp4')).toBe('escape.mp4');
    expect(sanitizeExportFileName('a\\b\\c:d*e?f"g<h>i|j\u0001.mp4')).toBe('cdefghij.mp4');
    expect(sanitizeExportFileName('..')).toBe('export');
    expect(path.dirname(exportOutputPath(settings({ fileName: 'sub/dir/x.mp4' })))).toBe(dir);
  });

  it('validates dimensions 16..8192 and even (QA-20)', async () => {
    const s = seq();
    vclip(s, mediaA, 0, 24, 0);
    expect(() => buildRenderGraph(req(s, { width: 16000, height: 9000 }))).toThrow(/between 16 and 8192/);
    expect(() => buildRenderGraph(req(s, { width: 8, height: 240 }))).toThrow(/between 16 and 8192/);
    expect(() => buildRenderGraph(req(s, { width: 321, height: 240 }))).toThrow(/even/);
    expect(() => buildRenderGraph(req(s, { width: 8192, height: 16 }))).not.toThrow();
    const r = await startExportJob(fakeQueue(), req(s, { width: 16000, height: 9000 }));
    expect(r.ok).toBe(false);
  });

  it('refuses a range with no enabled clips (QA-21)', () => {
    const s = seq();
    vclip(s, mediaA, 0, 24, 0).enabled = false;
    expect(() => buildRenderGraph(req(s))).toThrow('Nothing enabled to export in the selected range');
    vclip(s, mediaA, 48, 24, 0);
    s.view.inPoint = 0; s.view.outPoint = 24;
    expect(() => buildRenderGraph(req(s, { rangeMode: 'inOut' }))).toThrow(/Nothing enabled/);
    expect(() => buildRenderGraph(req(s))).not.toThrow();
  });

  it('warns when a clip needs more source than the media has (QA-22)', () => {
    const s = seq();
    vclip(s, mediaA, 0, 24 * 4, 8); // 8s..12s of a 10s file
    const g = buildRenderGraph(req(s));
    expect(g.warnings.some((w) => /extends past the end of its media/.test(w))).toBe(true);
    const ok = seq();
    vclip(ok, mediaA, 0, 24 * 2, 8); // 8s..10s: exactly fits
    expect(buildRenderGraph(req(ok)).warnings.some((w) => /extends past/.test(w))).toBe(false);
  });
});

describe('render graph timestamps (docs/attack/media.md M-01..M-04, M-09)', () => {
  const mp4 = (m: MediaItem): MediaItem => ({ ...m, probe: { ...m.probe!, container: 'mp4' } });

  it('track timeline uses integer frame timestamps (settb + setpts=N), never N*den/num/TB', () => {
    const s = createSequence('T', { num: 30000, den: 1001 }, 320, 240);
    s.videoTracks[0].clips.push(makeClip({ mediaId: mediaA.id, name: 'v', sourceIn: 0.4, duration: 30, kind: 'video' }, 0));
    const g = buildRenderGraph(req(s, { fps: { num: 30000, den: 1001 } }));
    expect(g.filterGraph).toContain('settb=1001/30000,setpts=N[tv');
    expect(g.filterGraph).not.toMatch(/setpts=N\*/);
  });

  it('inputs keep container-relative pts; video trims half a media frame early with the editor phase bias; audio rebases to the in-point', () => {
    const s = seq();
    const m = mp4(mediaA);
    vclip(s, m, 0, 24, 2); aclip(s, m, 0, 24, 2);
    const g = buildRenderGraph({ ...req(s), media: { [m.id]: m } });
    // linked V+A with the same range share one input (M-09); exact container: no 1 s pre-roll
    expect(g.inputCount).toBe(1);
    const i = g.args.indexOf('-copyts');
    expect(g.args.slice(i, i + 4)).toEqual(['-copyts', '-start_at_zero', '-ss', '1.939167']);
    // 24 fps media in a 24 fps sequence: trim at 2 - 1/48, setpts bias c = 1/48 - 1/48 (+1 µs)
    expect(g.filterGraph).toContain('[0:v:0]trim=start=1.979167:duration=1.270833,settb=AVTB,setpts=PTS-2.000001/TB,fps=24/1:start_time=0');
    expect(g.filterGraph).toMatch(/\[0:1\]atrim=start=2:duration=1\.25,asetpts=PTS-2\/TB,aresample=async=1:first_pts=0/);
  });

  it('non-exact containers keep 1 s of decoder pre-roll; different ranges get separate inputs', () => {
    const s = seq();
    vclip(s, mediaA, 0, 24, 3); aclip(s, mediaA, 0, 24, 2);
    const g = buildRenderGraph(req(s));
    expect(g.inputCount).toBe(2);
    expect(g.args).toContain('1.979167'); // 3 - 1/48 - 1
  });

  it('late-starting video (probe video.startTime) is transparent until its first frame', () => {
    const s = seq();
    const m = mp4(mediaA);
    (m.probe!.video as { startTime?: number }).startTime = 0.5;
    vclip(s, m, 0, 24, 0);
    const g = buildRenderGraph({ ...req(s), media: { [m.id]: m } });
    expect(g.filterGraph).toContain("lut=a=0:enable='lt(t,0.479166)'");
  });
});

// ---------------------------------------------------------------------------------------------------
// Chunked export (docs/attack/performance.md P-01)
// ---------------------------------------------------------------------------------------------------

describe('chunked export (P-01)', () => {
  let lumaMedia: MediaItem; // 64x36, 24 fps, luma = 8 * frame index (mod 256), 440 Hz tone
  let toneMedia: MediaItem; // 60 s, 660 Hz, 48 kHz, audio only
  const CLIPS = 400, LEN = 3, AUDIO_LEN = 49;
  /** Source frame shown by output frame f (clip i = f / LEN starts at source frame (i*7) % 20). */
  const srcFrameAt = (f: number) => ((Math.floor(f / LEN) * 7) % 20) + (f % LEN);

  beforeAll(async () => {
    const f = path.join(dir, 'luma.mp4');
    await ff(['-f', 'lavfi', '-i', "nullsrc=s=64x36:r=24:d=4,geq=lum='mod(N*8,256)':cb=128:cr=128", '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-shortest', f]);
    lumaMedia = await makeMedia('mL', f, 'video');
    const t = path.join(dir, 'tone60.m4a');
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=60', '-c:a', 'aac', '-ac', '1', t]);
    toneMedia = await makeMedia('mT', t, 'audio');
  }, 60000);

  function bigSeq(): { s: Sequence; transCut: number } {
    const s = createSequence('Big', FPS, 64, 36);
    for (let i = 0; i < CLIPS; i++) {
      const c = makeClip({ mediaId: lumaMedia.id, name: `c${i}`, sourceIn: ((i * 7) % 20) / 24, duration: LEN, kind: 'video' }, i * LEN);
      s.videoTracks[0].clips.push(c);
    }
    // A cross dissolve exactly where a 100-segment chunk would naturally end: the planner must avoid it.
    const v = s.videoTracks[0].clips;
    s.videoTracks[0].transitions.push({ id: 'trX', type: 'crossDissolve', duration: 2, outClipId: v[99].id, inClipId: v[100].id });
    const stream = lumaMedia.probe!.audio[0].index;
    for (let i = 0; i < Math.floor((CLIPS * LEN) / AUDIO_LEN); i++) {
      // Audio clips (49 frames) rarely share a cut with video: chunk boundaries split some of them mid-clip.
      s.audioTracks[0].clips.push(makeClip({ mediaId: lumaMedia.id, name: `a${i}`, sourceIn: (i % 5) * 0.25, duration: AUDIO_LEN, kind: 'audio', audioStream: stream }, i * AUDIO_LEN));
    }
    // One long A2 clip under everything: no clean cut exists, so boundaries split audio clips mid-clip.
    s.audioTracks[1].clips.push(makeClip({ mediaId: toneMedia.id, name: 'tone', sourceIn: 0.5, duration: CLIPS * LEN, kind: 'audio', audioStream: toneMedia.probe!.audio[0].index }, 0));
    return { s, transCut: 100 * LEN };
  }
  const bigReq = (s: Sequence, over: Partial<ExportSettings> = {}): ExportRequest => ({
    sequence: s, media: { [lumaMedia.id]: lumaMedia, [toneMedia.id]: toneMedia }, settings: settings({ width: 64, height: 36, crf: 18, ...over }),
  });

  /** Mean luma of every frame (1x1 gray scale-down). */
  async function lumaPerFrame(file: string): Promise<number[]> {
    const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-vf', 'extractplanes=y,scale=1:1:flags=area', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    return [...(stdout as unknown as Buffer)];
  }
  it('plans boundaries at cuts outside transition windows, within the segment budget', () => {
    const { s, transCut } = bigSeq();
    const r = bigReq(s);
    const input = { req: r, startF: 0, endF: CLIPS * LEN };
    expect(shouldChunk(input, buildRenderGraph(r).inputCount)).toBe(true);
    const chunks = planExportChunks(input); // one boundary set for both passes
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks[0].startF).toBe(0);
    expect(chunks[chunks.length - 1].endF).toBe(CLIPS * LEN);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (i > 0) expect(c.startF).toBe(chunks[i - 1].endF);
      expect(c.videoSegments).toBeLessThanOrEqual(100);
      expect(c.audioSegments).toBeLessThanOrEqual(100);
      expect(c.startF % LEN).toBe(0); // on a video cut
      expect(c.startF === transCut).toBe(false); // not inside the dissolve window (299..301)
    }
    // At least one boundary splits an audio clip (exercises sample-exact mid-clip joins).
    expect(chunks.slice(1).some((c) => c.startF % AUDIO_LEN !== 0 && c.startF < Math.floor((CLIPS * LEN) / AUDIO_LEN) * AUDIO_LEN)).toBe(true);
    // Sample-exact cumulative boundaries (23.976: 2002 samples per frame at 48 kHz).
    expect(sampleIndexAt(1001, 1, 48000, { num: 24000, den: 1001 })).toBe(2002000);
  });

  it('exports a 400-clip sequence in chunks: exact frames, content at boundaries, exact audio, bounded ffmpeg RSS', async () => {
    const { s, transCut } = bigSeq();
    const r = bigReq(s);
    const input = { req: r, startF: 0, endF: CLIPS * LEN };
    const chunks = planExportChunks(input, 100, 'video');
    // Small audio chunks so the audio joins split clips (A2 spans everything).
    const audioChunks = planExportChunks(input, 8, 'audio');
    expect(audioChunks.length).toBeGreaterThanOrEqual(3);
    let peakKb = 0;
    const timers: NodeJS.Timeout[] = [];
    const onSpawn = (child: ChildProcess) => {
      const sample = () => {
        try {
          const st = fs.readFileSync(`/proc/${child.pid}/status`, 'utf8');
          const m = /VmHWM:\s+(\d+) kB/.exec(st) ?? /VmRSS:\s+(\d+) kB/.exec(st);
          if (m) peakKb = Math.max(peakKb, Number(m[1]));
        } catch { /* exited */ }
      };
      sample();
      const t = setInterval(sample, 20);
      timers.push(t);
      child.once('exit', () => clearInterval(t));
    };
    const progress: number[] = [];
    const res = await runExport(r, (p) => progress.push(p), undefined, { onSpawn, maxAudioSegmentsPerChunk: 8 });
    const peakDuringExportKb = peakKb;
    timers.forEach(clearInterval);
    expect(res.chunks).toBe(chunks.length);
    expect(res.audioChunks).toBe(audioChunks.length);
    expect(res.chunks).toBeGreaterThanOrEqual(4);
    // Progress is monotonic across chunks.
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1] - 1e-9);
    expect(progress[progress.length - 1]).toBe(1);

    // Exact frame count / duration.
    const { stdout } = await exec(FFPROBE, ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets,duration,r_frame_rate', '-of', 'json', res.outputPath]);
    const vs = JSON.parse(stdout).streams[0];
    expect(Number(vs.nb_read_packets)).toBe(CLIPS * LEN);
    expect(Math.abs(Number(vs.duration) - (CLIPS * LEN) / 24)).toBeLessThan(1e-3);
    expect(vs.r_frame_rate).toBe('24/1');

    // Every frame shows the editor's source frame (chunk boundaries included); dissolve frames skipped.
    const luma = await lumaPerFrame(res.outputPath);
    expect(luma.length).toBe(CLIPS * LEN);
    const bad: string[] = [];
    for (let f = 0; f < luma.length; f++) {
      if (f >= transCut - 1 && f <= transCut) continue;
      const want = srcFrameAt(f) * 8;
      if (Math.abs(luma[f] - want) > 4) bad.push(`f${f}: ${luma[f]} != ${want}`);
    }
    expect(bad.slice(0, 10)).toEqual([]);
    for (const c of chunks.slice(1)) {
      // Frames on both sides of each chunk boundary.
      expect(Math.abs(luma[c.startF - 1] - srcFrameAt(c.startF - 1) * 8)).toBeLessThanOrEqual(4);
      expect(Math.abs(luma[c.startF] - srcFrameAt(c.startF) * 8)).toBeLessThanOrEqual(4);
    }

    // Audio: exactly frames * 2000 samples.
    const total = sampleIndexAt(CLIPS * LEN, 0, 48000, FPS);
    // The MP4 edit list carries the exact length (a plain decode also emits the AAC frame's tail padding).
    const { stdout: ajs } = await exec(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration_ts,time_base', '-of', 'json', res.outputPath]);
    const as = JSON.parse(ajs).streams[0];
    expect(as.time_base).toBe('1/48000');
    expect(Number(as.duration_ts)).toBe(total);

    // PCM level: the chunks' audio passes (boundaries split A2 and some A1 clips) concatenate to the
    // single-pass PCM (float rounding only: SIMD vs scalar tails at different frame splits, about -100 dB).
    const raw = async (file: string, map = '0:a:0') => {
      const { stdout: o } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', map, '-f', 'f32le', '-c:a', 'pcm_f32le', '-'], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
      const bb = o as unknown as Buffer;
      return new Float32Array(bb.buffer, bb.byteOffset, bb.length / 4);
    };
    const script = path.join(dir, 'chunk-audio.txt');
    const renderWav = async (opts: Parameters<typeof buildRenderGraph>[1], out: string) => {
      const g = buildRenderGraph(r, opts);
      fs.writeFileSync(script, g.filterGraph);
      await ff([...g.inputArgs, '-filter_complex_script', script, '-map', '[aout]', '-c:a', 'pcm_f32le', '-f', 'wav', out]);
      return g;
    };
    const refWav = path.join(dir, 'chunk-ref.wav');
    const refGraph = await renderWav({ streams: 'audio', audioSamples: total }, refWav);
    const refPcm = await raw(refWav);
    expect(refPcm.length).toBe(total * 2);
    let off = 0, pcmDiff = 0;
    for (const c of audioChunks) {
      const n = sampleIndexAt(c.endF, 0, 48000, FPS) - sampleIndexAt(c.startF, 0, 48000, FPS);
      const w = path.join(dir, `chunk-${c.startF}.wav`);
      await renderWav({ range: { startF: c.startF, endF: c.endF }, streams: 'audio', audioSamples: n }, w);
      const p = await raw(w);
      expect(p.length).toBe(n * 2);
      for (let i = 0; i < p.length; i++) pcmDiff = Math.max(pcmDiff, Math.abs(p[i] - refPcm[off + i]));
      off += p.length;
    }
    expect(off).toBe(refPcm.length);
    expect(pcmDiff).toBeLessThan(1e-4);

    // Output level: the exported AAC matches an AAC encode of the single-pass PCM (no sample shift at any join;
    // a one-sample shift would give an RMS difference of about 0.03 here).
    const refM4a = path.join(dir, 'chunk-ref.m4a');
    await ff(['-i', refWav, ...refGraph.audioCodecArgs, '-t', String((CLIPS * LEN) / 24), '-f', 'mp4', refM4a]);
    const a = await raw(res.outputPath), ref = await raw(refM4a);
    expect(a.length / 2 - total).toBeLessThan(1024);
    expect(ref.length).toBe(a.length);
    let sq = 0;
    for (let i = 0; i < a.length; i++) sq += (a[i] - ref[i]) ** 2;
    expect(Math.sqrt(sq / a.length)).toBeLessThan(0.003);

    // ffmpeg memory stays bounded (one chunk at a time).
    expect(peakDuringExportKb).toBeGreaterThan(0);
    expect(peakDuringExportKb / 1024).toBeLessThan(1536);
    console.log(`[chunked export] ${res.chunks} chunks, boundaries ${chunks.map((c) => c.startF).join(',')}; ${res.audioChunks} audio chunks ${audioChunks.map((c) => c.startF).join(',')}; peak ffmpeg RSS ${(peakDuringExportKb / 1024).toFixed(0)} MB`);
  }, 300000);

  it('cancel during a chunked export deletes temp files and the partial output', async () => {
    const { s } = bigSeq();
    const r = bigReq(s);
    // Private TMPDIR (os.tmpdir() reads it per call) so other processes' exports do not interfere.
    const tmp = fs.mkdtempSync(path.join(dir, 'tmp-'));
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    const ac = new AbortController();
    let spawned = 0;
    try {
      const p = runExport(r, undefined, ac.signal, { onSpawn: () => { if (++spawned === 2) ac.abort(); } });
      await expect(p).rejects.toThrow(/canceled/);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    }
    expect(spawned).toBe(2);
    expect(fs.readdirSync(tmp)).toEqual([]);
    expect(fs.existsSync(path.join(dir, r.settings.fileName.replace(/\.mp4$/, '.part.mp4')))).toBe(false);
    expect(fs.existsSync(path.join(dir, r.settings.fileName))).toBe(false);
  }, 60000);

  it('reports which chunk failed', async () => {
    const { s } = bigSeq();
    const broken: MediaItem = { ...lumaMedia, path: path.join(dir, 'gone.mp4') };
    const r: ExportRequest = { ...bigReq(s), media: { [lumaMedia.id]: broken, [toneMedia.id]: toneMedia } };
    await expect(runExport(r)).rejects.toThrow(/Export failed in chunk 1\/\d+ \(video, frames 0-\d+\)/);
  }, 60000);
});
