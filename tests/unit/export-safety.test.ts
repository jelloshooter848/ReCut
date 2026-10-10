/**
 * Export must never overwrite a project source asset: imported subtitle files, media in a bin that is not
 * on the exported timeline, and proxies. Requests are built the way the Export dialog builds them
 * (src/panels/export/request.ts) and run through the real exporter.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportSettings, MediaItem, MediaProbe, Project, Sequence, SubtitleTrack } from '@shared/model';
import { createMediaItem, createProject, createSequence } from '@shared/project';
import { makeClip } from '@shared/timeline';
import { adaptFfmpegArgs, ffmpegMajorVersionSync } from '../../electron/media/ffmpeg';
import { buildRenderGraph } from '../../electron/export/renderGraph';
import { runExport, startExportJob, type ExportJobQueue, type ExportJobSpec } from '../../electron/export/exporter';
import { buildExportRequest, projectSourcePaths } from '../../src/panels/export/request';

const exec = promisify(execFile);
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.RECUT_FFPROBE || 'ffprobe';
const FPS = { num: 24, den: 1 };

let dir: string;
let red: MediaItem;

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

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-export-safety-'));
  const file = path.join(dir, 'red.mp4');
  await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...adaptFfmpegArgs([
    '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=24:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-shortest', file,
  ], ffmpegMajorVersionSync(FFMPEG))]);
  red = { ...createMediaItem(file, 'red.mp4'), id: 'm-red', kind: 'video', probe: await probe(file) };
}, 60000);

afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
afterEach(() => { vi.restoreAllMocks(); });

/** A project with `red` on the timeline (1 s) and one sequence subtitle cue, like a real fan edit. */
function fixture(): { project: Project; seq: Sequence } {
  const project = createProject('Safety');
  project.media[red.id] = red;
  const seq = createSequence('Edit', FPS, 320, 240);
  seq.videoTracks[0].clips.push(makeClip({ mediaId: red.id, name: 'red', sourceIn: 0, duration: 24, speed: 1, kind: 'video' }, 0));
  seq.subtitleTracks.push({ id: 'sst', name: 'Dialogue', language: 'en', enabled: true, cues: [{ id: 'q1', start: 0, duration: 12, offset: 0, text: 'Export cue' }] });
  project.sequences = { [seq.id]: seq };
  project.sequenceOrder = [seq.id];
  project.activeSequenceId = seq.id;
  return { project, seq };
}

function importSubtitle(project: Project, file: string, content: string): SubtitleTrack {
  fs.writeFileSync(file, content, 'utf8');
  const track: SubtitleTrack = {
    id: `st-${path.basename(file)}`, name: path.basename(file), language: 'en', path: file, mediaId: red.id,
    cues: [{ id: 'c1', start: 0, end: 1, text: 'Original line' }], origin: 'srt',
  };
  project.subtitleTracks[track.id] = track;
  return track;
}

/** A media item that lives in a bin but is not used by the exported sequence. */
function binOnlyMedia(project: Project, file: string, over: Partial<MediaItem> = {}): MediaItem {
  fs.copyFileSync(red.path, file);
  const m: MediaItem = { ...createMediaItem(file, path.basename(file)), id: `bin-${path.basename(file)}`, kind: 'video', binId: 'bin-movies', ...over };
  project.media[m.id] = m;
  return m;
}

function settings(over: Partial<ExportSettings>): ExportSettings {
  return {
    outputDir: dir, fileName: 'out.mp4', width: 320, height: 240, fps: FPS,
    videoCodec: 'libx264', qualityMode: 'crf', crf: 30, videoBitrateKbps: 2000, preset: 'ultrafast',
    audioCodec: 'aac', audioBitrateKbps: 128, audioChannels: 2, sampleRate: 48000,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false, ...over,
  };
}

const fakeQueue = (): ExportJobQueue & { added: number } => {
  const q = { added: 0, add: (spec: ExportJobSpec) => { q.added++; return { id: 'j', kind: 'export' as const, title: spec.title, status: 'queued' as const, progress: 0 }; }, cancel: () => {} };
  return q;
};

describe('export never overwrites project source assets', () => {
  it('refuses a sidecar .srt that is an imported subtitle file and leaves it byte-identical', async () => {
    const { project, seq } = fixture();
    const srt = path.join(dir, 'dialogue.srt');
    importSubtitle(project, srt, '1\n00:00:00,000 --> 00:00:01,000\nOriginal line\n\n');
    const before = fs.readFileSync(srt);
    const req = buildExportRequest(project, seq, settings({ fileName: 'dialogue.mp4', exportSubtitleSidecar: true }));

    await expect(runExport(req)).rejects.toThrow(/Refusing to export to ".*dialogue\.srt".*project/);
    expect(fs.readFileSync(srt).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'dialogue.mp4'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'dialogue.part.mp4'))).toBe(false);

    const q = fakeQueue();
    const started = await startExportJob(q, req);
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error).toMatch(/dialogue\.srt/);
    expect(q.added).toBe(0);
  }, 30000);

  it('refuses an output that is a project media file not used by the exported sequence', async () => {
    const { project, seq } = fixture();
    const victim = binOnlyMedia(project, path.join(dir, 'binonly.mp4'));
    const before = fs.readFileSync(victim.path);
    const req = buildExportRequest(project, seq, settings({ fileName: 'binonly.mp4' }));
    await expect(runExport(req)).rejects.toThrow(/Refusing to export to ".*binonly\.mp4".*project/);
    expect(fs.readFileSync(victim.path).equals(before)).toBe(true);
  }, 30000);

  it('never touches a project media file named like the old <name>.part.mp4 temp (temps are unique, created exclusively)', async () => {
    const { project, seq } = fixture();
    const victim = binOnlyMedia(project, path.join(dir, 'victim.part.mp4'));
    const before = fs.readFileSync(victim.path);
    const req = buildExportRequest(project, seq, settings({ fileName: 'victim.mp4' }));
    // The render temp is <name>.recut-part-<random>.mp4 now, so this name is no longer a collision.
    expect(() => buildRenderGraph(req)).not.toThrow();
    const res = await runExport(req);
    expect(fs.readFileSync(res.outputPath).subarray(4, 8).toString('latin1')).toBe('ftyp');
    expect(fs.readFileSync(victim.path).equals(before)).toBe(true);
  }, 30000);

  it('refuses an output that is the proxy of a project media item not on the timeline', async () => {
    const { project, seq } = fixture();
    const proxyDir = path.join(dir, 'proxies');
    fs.mkdirSync(proxyDir, { recursive: true });
    const proxy = path.join(proxyDir, 'episode_proxy.mp4');
    fs.copyFileSync(red.path, proxy);
    const before = fs.readFileSync(proxy);
    binOnlyMedia(project, path.join(dir, 'episode.mp4'), { proxy: { status: 'ready', path: proxy } });
    const req = buildExportRequest(project, seq, settings({ outputDir: proxyDir, fileName: 'episode_proxy.mp4' }));
    expect(() => buildRenderGraph(req)).toThrow(/episode_proxy\.mp4/);
    await expect(runExport(req)).rejects.toThrow(/Refusing to export/);
    expect(fs.readFileSync(proxy).equals(before)).toBe(true);
  }, 30000);

  it('matches project source paths case-insensitively on every platform (Linux mounts exFAT / vfat / CIFS / casefold)', () => {
    const { project, seq } = fixture();
    importSubtitle(project, path.join(dir, 'Dialogue.SRT'), 'x');
    const subReq = buildExportRequest(project, seq, settings({ fileName: 'dialogue.mp4', exportSubtitleSidecar: true }));
    expect(() => buildRenderGraph(subReq, { platform: 'win32' })).toThrow(/Dialogue\.SRT/);
    expect(() => buildRenderGraph(subReq, { platform: 'linux' })).toThrow(/Dialogue\.SRT/);

    const { project: p2, seq: s2 } = fixture();
    binOnlyMedia(p2, path.join(dir, 'BinCase.MP4'));
    const mediaReq = buildExportRequest(p2, s2, settings({ fileName: 'bincase.mp4' }));
    expect(() => buildRenderGraph(mediaReq, { platform: 'win32' })).toThrow(/BinCase\.MP4/);
    expect(() => buildRenderGraph(mediaReq, { platform: 'linux' })).toThrow(/BinCase\.MP4/);
  });

  it('the dialog request lists every project source path (media, proxies, subtitle files)', () => {
    const { project, seq } = fixture();
    const sub = importSubtitle(project, path.join(dir, 'listed.srt'), 'x');
    const proxy = path.join(dir, 'listed_proxy.mp4');
    const bin = binOnlyMedia(project, path.join(dir, 'listed.mp4'), { proxy: { status: 'ready', path: proxy } });
    const req = buildExportRequest(project, seq, settings({}));
    expect(new Set(req.protectedPaths)).toEqual(new Set([red.path, bin.path, proxy, sub.path!]));
    expect(projectSourcePaths(project)).toEqual(req.protectedPaths);
  });

  it('refuses a sidecar that is a protected path, and keeps the old behaviour without protectedPaths', () => {
    const { project, seq } = fixture();
    const req = buildExportRequest(project, seq, settings({ fileName: 'temp-victim.mp4', exportSubtitleSidecar: true }));
    expect(() => buildRenderGraph({ ...req, protectedPaths: [path.join(dir, 'temp-victim.srt')] })).toThrow(/temp-victim\.srt/);
    // The sidecar temp is <name>.recut-part-<random>.srt created exclusively: the old fixed name is not written.
    expect(() => buildRenderGraph({ ...req, protectedPaths: [path.join(dir, 'temp-victim.part.srt')] })).not.toThrow();
    expect(() => buildRenderGraph({ ...req, protectedPaths: undefined })).not.toThrow();
    expect(() => buildRenderGraph({ ...req, protectedPaths: undefined, settings: { ...req.settings, fileName: 'red.mp4' } })).toThrow(/used by the timeline/);
  });

  it('the dialog request (media, subtitleTracks, sequences) protects subtitle files imported into another sequence', () => {
    const { project, seq } = fixture();
    const other = createSequence('Other', FPS, 320, 240);
    const otherSrt = path.join(dir, 'other-seq.srt');
    fs.writeFileSync(otherSrt, 'imported into another sequence', 'utf8');
    other.subtitleTracks.push({ id: 'o', name: 'o', language: 'en', enabled: true, cues: [], sourcePaths: [otherSrt] });
    project.sequences[other.id] = other;
    const s = settings({ fileName: 'other-seq.mp4', exportSubtitleSidecar: true });
    // Exactly what ExportDialog passes (src/panels/export/ExportDialog.tsx).
    const { media, subtitleTracks, sequences } = project;
    const req = buildExportRequest({ media, subtitleTracks, sequences }, seq, s);
    expect(req.protectedPaths).toContain(otherSrt);
    expect(() => buildRenderGraph(req)).toThrow(/Refusing to export to ".*other-seq\.srt".*a source file of the project/);
    // Without `sequences` (the dialog before this fix) the file was not protected.
    expect(buildExportRequest({ media, subtitleTracks }, seq, s).protectedPaths).not.toContain(otherSrt);
  });

  it('protects every req.media item even without protectedPaths (direct IPC callers)', () => {
    const { project, seq } = fixture();
    binOnlyMedia(project, path.join(dir, 'binonly-noprot.mp4'));
    const req = buildExportRequest(project, seq, settings({ fileName: 'binonly-noprot.mp4' }));
    expect(() => buildRenderGraph({ ...req, protectedPaths: undefined })).toThrow(/Refusing to export to ".*binonly-noprot\.mp4".*a source file of the project/);
  });

  it('writes the sidecar atomically: replaces a previous export sidecar and leaves no temp file', async () => {
    const { project, seq } = fixture();
    const outDir = path.join(dir, 'sidecar-out');
    fs.mkdirSync(outDir, { recursive: true });
    const sidecar = path.join(outDir, 'edit.srt');
    fs.writeFileSync(sidecar, 'stale sidecar from a previous export', 'utf8');
    const req = { ...buildExportRequest(project, seq, settings({ outputDir: outDir, fileName: 'edit.mp4', exportSubtitleSidecar: true })), overwrite: true };
    const writes: string[] = [];
    const renames: [string, string][] = [];
    const realWrite = fs.writeFileSync;
    const realRename = fs.renameSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, o?: fs.WriteFileOptions) => {
      writes.push(String(p));
      return realWrite(p, data, o);
    }) as typeof fs.writeFileSync);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => { renames.push([String(from), String(to)]); return realRename(from, to); });
    const res = await runExport(req);
    expect(res.sidecarPath).toBe(sidecar);
    expect(fs.readFileSync(sidecar, 'utf8')).toMatch(/Export cue/);
    expect(fs.readdirSync(outDir).sort()).toEqual(['edit.mp4', 'edit.srt']);
    // The sidecar content goes to a temp in the same folder, which is then renamed onto edit.srt; edit.srt itself is never written.
    expect(writes).not.toContain(sidecar);
    const toSidecar = renames.filter(([, to]) => to === sidecar);
    expect(toSidecar).toHaveLength(1);
    const temp = toSidecar[0][0];
    expect(path.dirname(temp)).toBe(outDir);
    expect(path.basename(temp)).toMatch(/^edit\.recut-part-[0-9a-f]+\.srt$/);
    expect(writes).toContain(temp);
  }, 30000);

  it('a failed sidecar temp write leaves the previous .srt unchanged and no temp behind', async () => {
    const { project, seq } = fixture();
    const outDir = path.join(dir, 'sidecar-fail');
    fs.mkdirSync(outDir, { recursive: true });
    const sidecar = path.join(outDir, 'edit.srt');
    fs.writeFileSync(sidecar, 'stale sidecar from a previous export', 'utf8');
    const req = { ...buildExportRequest(project, seq, settings({ outputDir: outDir, fileName: 'edit.mp4', exportSubtitleSidecar: true })), overwrite: true };
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, o?: fs.WriteFileOptions) => {
      if (/\.recut-part-[0-9a-f]+\.srt$/.test(String(p))) {
        realWrite(p, String(data).slice(0, 5), o); // a partial write, then the disk fills up
        throw Object.assign(new Error('ENOSPC: simulated'), { code: 'ENOSPC' });
      }
      return realWrite(p, data, o);
    }) as typeof fs.writeFileSync);
    await expect(runExport(req)).rejects.toThrow(/ENOSPC/);
    expect(fs.readFileSync(sidecar, 'utf8')).toBe('stale sidecar from a previous export');
    expect(fs.readdirSync(outDir).sort()).toEqual(['edit.mp4', 'edit.srt']);
  }, 30000);
});
