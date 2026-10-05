/**
 * Export file safety (critic A2, A3, A4, A8 and the finalize follow-up): an export must never replace, truncate
 * or move a file the user did not ask it to replace. Every test uses real files in a temp folder and, where the
 * damage happens in ffmpeg, a real ffmpeg run.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportSettings, MediaItem, MediaProbe, Project, Sequence, SubtitleTrack } from '@shared/model';
import type { ExportRequest } from '@shared/ipc';
import { createMediaItem, createProject, createSequence } from '@shared/project';
import { makeClip } from '@shared/timeline';
import { adaptFfmpegArgs, ffmpegMajorVersionSync } from '../../electron/media/ffmpeg';
import { buildRenderGraph, exportOutputPath } from '../../electron/export/renderGraph';
import { finalizeExportOutput, runExport, startExportJob, type ExportJobQueue, type ExportJobSpec } from '../../electron/export/exporter';
import { buildExportRequest } from '../../src/panels/export/request';
import { validateExportSettings } from '../../src/panels/export/settings';

const exec = promisify(execFile);
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
const FPS = { num: 24, den: 1 };
const USER = 'USER DATA (not part of the project)';
const SRT = '1\n00:00:00,000 --> 00:00:01,000\nUSER ORIGINAL LINE\n\n';

let root: string;
let red: MediaItem;
let redBytes: Buffer;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-export-file-safety-'));
  const file = path.join(root, 'red.mp4');
  await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...adaptFfmpegArgs([
    '-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=24:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-shortest', file,
  ], ffmpegMajorVersionSync(FFMPEG))]);
  const probe: MediaProbe = {
    container: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 1, size: fs.statSync(file).size,
    video: { index: 0, codec: 'h264', width: 160, height: 120, fps: FPS, avgFps: FPS, isVfr: false },
    audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }], subtitles: [], startTime: 0, browserPlayable: true,
  };
  red = { ...createMediaItem(file, 'red.mp4'), id: 'm-red', kind: 'video', probe };
  redBytes = fs.readFileSync(file);
}, 60000);

afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });
afterEach(() => { vi.restoreAllMocks(); });

function sub(name: string): string { return fs.mkdtempSync(path.join(root, `${name}-`)); }

function fixture(): { project: Project; seq: Sequence } {
  const project = createProject('File safety');
  project.media[red.id] = red;
  const seq = createSequence('Edit', FPS, 160, 120);
  seq.videoTracks[0].clips.push(makeClip({ mediaId: red.id, name: 'red', sourceIn: 0, duration: 12, speed: 1, kind: 'video' }, 0));
  seq.subtitleTracks.push({ id: 'sst', name: 'Dialogue', language: 'en', enabled: true, cues: [{ id: 'q1', start: 0, duration: 6, offset: 0, text: 'Export cue' }] });
  project.sequences = { [seq.id]: seq };
  project.sequenceOrder = [seq.id];
  project.activeSequenceId = seq.id;
  return { project, seq };
}

function settings(outputDir: string, over: Partial<ExportSettings> = {}): ExportSettings {
  return {
    outputDir, fileName: 'out.mp4', width: 160, height: 120, fps: FPS,
    videoCodec: 'libx264', qualityMode: 'crf', crf: 35, videoBitrateKbps: 1000, preset: 'ultrafast',
    audioCodec: 'aac', audioBitrateKbps: 128, audioChannels: 2, sampleRate: 48000,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false, ...over,
  };
}

function request(outputDir: string, over: Partial<ExportSettings> = {}, project?: Project, seq?: Sequence): ExportRequest {
  const f = project && seq ? { project, seq } : fixture();
  return buildExportRequest(f.project, f.seq, settings(outputDir, over));
}

function binMedia(project: Project, file: string): MediaItem {
  const m: MediaItem = { ...createMediaItem(file, path.basename(file)), id: `bin-${path.basename(file)}`, kind: 'video', binId: 'b' };
  project.media[m.id] = m;
  return m;
}

const fakeQueue = (): ExportJobQueue & { added: number } => {
  const q = { added: 0, add: (spec: ExportJobSpec) => { q.added++; return { id: 'j', kind: 'export' as const, title: spec.title, status: 'queued' as const, progress: 0 }; }, cancel: () => {} };
  return q;
};

const isMp4 = (p: string) => fs.readFileSync(p).subarray(4, 8).toString('latin1') === 'ftyp';

// -------------------------------------------------------------------------------------------------
// A2: no silent replace; temp files are unique and created exclusively
// -------------------------------------------------------------------------------------------------

describe('A2 export never replaces or consumes a file it did not create', () => {
  it('a user file named <name>.part.mp4 survives an export to <name>.mp4 (real ffmpeg)', async () => {
    const d = sub('a2-part');
    const userFile = path.join(d, 'holiday.part.mp4');
    fs.writeFileSync(userFile, USER);
    const res = await runExport(request(d, { fileName: 'holiday.mp4' }));
    expect(fs.readFileSync(userFile, 'utf8')).toBe(USER);
    expect(isMp4(res.outputPath)).toBe(true);
    expect(fs.readdirSync(d).sort()).toEqual(['holiday.mp4', 'holiday.part.mp4']);
  }, 30000);

  it('a user file named <name>.part.srt survives the sidecar step', async () => {
    const d = sub('a2-srt');
    const userFile = path.join(d, 'movie.part.srt');
    fs.writeFileSync(userFile, SRT);
    const res = await runExport(request(d, { fileName: 'movie.mp4', exportSubtitleSidecar: true }));
    expect(fs.readFileSync(userFile, 'utf8')).toBe(SRT);
    expect(fs.readFileSync(res.sidecarPath!, 'utf8')).toMatch(/Export cue/);
    expect(fs.readdirSync(d).sort()).toEqual(['movie.mp4', 'movie.part.srt', 'movie.srt']);
  }, 30000);

  it('ffmpeg writes to a unique temp next to the output and every output path is a file: URL', async () => {
    const d = sub('a2-args');
    const spawned: string[][] = [];
    const onSpawn = (c: ChildProcess) => { spawned.push(c.spawnargs.slice(1)); };
    await runExport(request(d, { fileName: 'edit.mp4' }), undefined, undefined, { onSpawn, chunked: false });
    expect(spawned).toHaveLength(1);
    const out = spawned[0][spawned[0].length - 1];
    expect(out.startsWith('file:')).toBe(true);
    expect(path.dirname(out.slice(5))).toBe(d);
    expect(path.basename(out)).toMatch(/^edit\.recut-part-[0-9a-f]{12,}\.mp4$/);
    // Inputs from the project are file: URLs too (a media path can never be read as a protocol).
    const inputs = spawned[0].filter((_, i, a) => a[i - 1] === '-i');
    expect(inputs.length).toBeGreaterThan(0);
    for (const i of inputs) expect(i.startsWith('file:')).toBe(true);
  }, 30000);

  it('chunked export: chunk, concat and final outputs and inputs are file: URLs', async () => {
    const d = sub('a2-chunk');
    const spawned: string[][] = [];
    const { project, seq } = fixture();
    seq.videoTracks[0].clips.push(makeClip({ mediaId: red.id, name: 'red2', sourceIn: 0, duration: 12, speed: 1, kind: 'video' }, 12));
    const res = await runExport(request(d, { fileName: 'chunked.mp4' }, project, seq), undefined, undefined,
      { chunked: true, maxSegmentsPerChunk: 1, onSpawn: (c) => { spawned.push(c.spawnargs.slice(1)); } });
    expect(res.chunks).toBeGreaterThan(1);
    expect(isMp4(res.outputPath)).toBe(true);
    for (const args of spawned) {
      expect(args[args.length - 1].startsWith('file:')).toBe(true);
      for (const i of args.filter((_, k, a) => a[k - 1] === '-i')) expect(i.startsWith('file:')).toBe(true);
    }
    expect(path.basename(spawned[spawned.length - 1].at(-1)!)).toMatch(/^chunked\.recut-part-[0-9a-f]+\.mp4$/);
    expect(fs.readdirSync(d)).toEqual(['chunked.mp4']);
  }, 60000);

  it('startExportJob refuses an existing output with code "exists" unless overwrite is set', async () => {
    const d = sub('a2-exists');
    const target = path.join(d, 'edit.mp4');
    fs.writeFileSync(target, USER);
    const q = fakeQueue();
    const r = await startExportJob(q, request(d, { fileName: 'edit.mp4' }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('exists');
      expect(r.error).toMatch(/edit\.mp4" already exists/);
    }
    expect(q.added).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe(USER);

    const ok = await startExportJob(q, { ...request(d, { fileName: 'edit.mp4' }), overwrite: true });
    expect(ok.ok).toBe(true);
    expect(q.added).toBe(1);
  });

  it('startExportJob refuses an existing sidecar .srt (output absent) with code "exists"', async () => {
    const d = sub('a2-sidecar-exists');
    fs.writeFileSync(path.join(d, 'edit.srt'), SRT);
    const r = await startExportJob(fakeQueue(), request(d, { fileName: 'edit.mp4', exportSubtitleSidecar: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.code).toBe('exists'); expect(r.error).toMatch(/edit\.srt" already exists/); }
    // Without a sidecar the .srt is irrelevant.
    const r2 = await startExportJob(fakeQueue(), request(d, { fileName: 'edit.mp4' }));
    expect(r2.ok).toBe(true);
  });

  it('runExport (direct callers) refuses an existing output without overwrite and replaces it with overwrite', async () => {
    const d = sub('a2-run');
    const target = path.join(d, 'edit.mp4');
    fs.writeFileSync(target, USER);
    await expect(runExport(request(d, { fileName: 'edit.mp4' }))).rejects.toThrow(/already exists/);
    expect(fs.readFileSync(target, 'utf8')).toBe(USER);
    expect(fs.readdirSync(d)).toEqual(['edit.mp4']);
    await runExport({ ...request(d, { fileName: 'edit.mp4' }), overwrite: true });
    expect(isMp4(target)).toBe(true);
    expect(fs.readdirSync(d)).toEqual(['edit.mp4']);
  }, 30000);

  it('a file created at the output path while rendering is not replaced (no overwrite) and the render is kept', async () => {
    const d = sub('a2-race');
    const target = path.join(d, 'edit.mp4');
    // The user saves a file under the same name while ffmpeg runs (after every up-front check).
    const err = await runExport(request(d, { fileName: 'edit.mp4' }), undefined, undefined, { onSpawn: () => { fs.writeFileSync(target, USER); } })
      .then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/already exists/);
    expect(fs.readFileSync(target, 'utf8')).toBe(USER);
    const kept = fs.readdirSync(d).filter((f) => f !== 'edit.mp4');
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^edit\.recut-unsaved-.*\.mp4$/);
    expect(err?.message).toContain(kept[0]);
    expect(isMp4(path.join(d, kept[0]))).toBe(true);
  }, 30000);
});

// -------------------------------------------------------------------------------------------------
// A3: the output folder must be absolute (no ffmpeg protocol prefixes)
// -------------------------------------------------------------------------------------------------

describe('A3 output folder must be an absolute path', () => {
  it('refuses protocol-like and relative output folders before anything is written', async () => {
    const d = sub('a3');
    const victim = path.join(d, 'victim.mp4');
    fs.copyFileSync(red.path, victim);
    const { project, seq } = fixture();
    const v = binMedia(project, victim);
    seq.videoTracks[0].clips.push(makeClip({ mediaId: v.id, name: 'v', sourceIn: 0, duration: 12, speed: 1, kind: 'video' }, 12));
    for (const dir of [`tee:${victim}|x`, `concat:${victim}`, 'pipe:1', 'http://example.invalid/x', 'out', './out', '']) {
      const req = request(dir, { fileName: 'out.mp4' }, project, seq);
      expect(() => buildRenderGraph(req), dir).toThrow(/absolute/);
      expect(() => exportOutputPath(req.settings), dir).toThrow(/absolute/);
      const q = fakeQueue();
      const r = await startExportJob(q, req);
      expect(r.ok, dir).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/absolute/);
      expect(q.added).toBe(0);
      await expect(runExport(req)).rejects.toThrow(/absolute/);
    }
    expect(fs.readFileSync(victim).equals(redBytes)).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), 'tee:' + victim))).toBe(false);
  }, 30000);

  it('the Export dialog shows the same refusal for a relative output folder', () => {
    const base = settings('/tmp');
    for (const dir of ['out', './out', `tee:/x/victim.mp4|x`, 'concat:/a|/b']) {
      const v = validateExportSettings({ ...base, outputDir: dir });
      expect(v.ok, dir).toBe(false);
      expect(v.issues.find((i) => i.field === 'outputDir')?.message, dir).toMatch(/absolute|full path/i);
    }
    for (const dir of ['/home/me/Videos', 'C:\\Videos', 'D:/Exports', '\\\\server\\share\\out']) {
      expect(validateExportSettings({ ...base, outputDir: dir }).ok, dir).toBe(true);
    }
  });
});

// -------------------------------------------------------------------------------------------------
// A4: identity (dev, ino) and case-folded comparison
// -------------------------------------------------------------------------------------------------

describe('A4 hard links and case-insensitive volumes', () => {
  it('a <name>.part.mp4 hard-linked to a project media file is never written through (real ffmpeg)', async () => {
    const d = sub('a4-part');
    const media = path.join(d, 'source.mp4');
    fs.copyFileSync(red.path, media);
    fs.linkSync(media, path.join(d, 'out.part.mp4'));
    const { project, seq } = fixture();
    binMedia(project, media);
    await runExport(request(d, { fileName: 'out.mp4' }, project, seq)).catch(() => undefined);
    expect(fs.readFileSync(media).equals(redBytes)).toBe(true);
  }, 30000);

  it('an output hard-linked to a project source is refused even with overwrite', async () => {
    const d = sub('a4-out');
    const media = path.join(d, 'source.mp4');
    fs.copyFileSync(red.path, media);
    fs.linkSync(media, path.join(d, 'edit.mp4'));
    const { project, seq } = fixture();
    binMedia(project, media);
    const req: ExportRequest = { ...request(d, { fileName: 'edit.mp4' }, project, seq), overwrite: true };
    const r = await startExportJob(fakeQueue(), req);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.code).toBeUndefined(); expect(r.error).toMatch(/Refusing to export to ".*edit\.mp4".*same file as.*source\.mp4/); }
    await expect(runExport(req)).rejects.toThrow(/Refusing to export/);
    expect(fs.readFileSync(media).equals(redBytes)).toBe(true);
    expect(fs.statSync(path.join(d, 'edit.mp4')).ino).toBe(fs.statSync(media).ino);
  }, 30000);

  it('a sidecar .srt hard-linked to an imported subtitle file is refused even with overwrite', async () => {
    const d = sub('a4-srt');
    const srt = path.join(d, 'dialogue.srt');
    fs.writeFileSync(srt, SRT);
    fs.linkSync(srt, path.join(d, 'edit.srt'));
    const { project, seq } = fixture();
    const track: SubtitleTrack = { id: 'st', name: 'dialogue.srt', language: 'en', path: srt, mediaId: red.id, cues: [], origin: 'srt' };
    project.subtitleTracks[track.id] = track;
    const req: ExportRequest = { ...request(d, { fileName: 'edit.mp4', exportSubtitleSidecar: true }, project, seq), overwrite: true };
    await expect(runExport(req)).rejects.toThrow(/Refusing to export to ".*edit\.srt"/);
    expect(fs.readFileSync(srt, 'utf8')).toBe(SRT);
    expect(fs.existsSync(path.join(d, 'edit.mp4'))).toBe(false);
  }, 30000);

  it('compares case-folded on every platform (exFAT / vfat / CIFS / casefold volumes on Linux)', () => {
    const d = sub('a4-case');
    const media = path.join(d, 'Clip.MP4');
    fs.copyFileSync(red.path, media);
    const { project, seq } = fixture();
    binMedia(project, media);
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      expect(() => buildRenderGraph(request(d, { fileName: 'clip.mp4' }, project, seq), { platform }), platform).toThrow(/Clip\.MP4/);
    }
  });

  it('buildRenderGraph stays pure: the identity check only runs with the exporter-supplied statPath', () => {
    const d = sub('a4-pure');
    const media = path.join(d, 'source.mp4');
    fs.copyFileSync(red.path, media);
    fs.linkSync(media, path.join(d, 'edit.mp4'));
    const { project, seq } = fixture();
    binMedia(project, media);
    const req = request(d, { fileName: 'edit.mp4' }, project, seq);
    expect(() => buildRenderGraph({ ...req, overwrite: true })).not.toThrow();
    const ids: Record<string, string> = { [path.join(d, 'edit.mp4')]: '1:42', [media]: '1:42' };
    const statPath = (p: string) => (ids[p] ? { id: ids[p], isDirectory: false } : null);
    expect(() => buildRenderGraph({ ...req, overwrite: true }, { statPath })).toThrow(/same file as/);
  });
});

// -------------------------------------------------------------------------------------------------
// A8: a folder named like the output
// -------------------------------------------------------------------------------------------------

describe('A8 a folder at the output path', () => {
  it('finalizeExportOutput never moves a folder aside', () => {
    const d = sub('a8-fin');
    const out = path.join(d, 'edit.mp4');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'keep.txt'), 'x');
    const part = path.join(d, 'edit.recut-part-abc.mp4');
    fs.writeFileSync(part, 'render');
    expect(() => finalizeExportOutput(part, out)).toThrow(/not a file/);
    expect(fs.statSync(out).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(out, 'keep.txt'), 'utf8')).toBe('x');
    expect(fs.readdirSync(d).sort()).toEqual(['edit.mp4', 'edit.recut-part-abc.mp4']);
  });

  it('an export whose output (or sidecar) path is a folder is refused before rendering, even with overwrite', async () => {
    const d = sub('a8-run');
    fs.mkdirSync(path.join(d, 'edit.mp4'));
    const q = fakeQueue();
    for (const overwrite of [false, true]) {
      const r = await startExportJob(q, { ...request(d, { fileName: 'edit.mp4' }), overwrite });
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.code).toBeUndefined(); expect(r.error).toMatch(/edit\.mp4" is a folder/); }
      await expect(runExport({ ...request(d, { fileName: 'edit.mp4' }), overwrite })).rejects.toThrow(/is a folder/);
    }
    expect(q.added).toBe(0);
    fs.mkdirSync(path.join(d, 'other.srt'));
    const r = await startExportJob(q, { ...request(d, { fileName: 'other.mp4', exportSubtitleSidecar: true }), overwrite: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/other\.srt" is a folder/);
    expect(fs.readdirSync(d).sort()).toEqual(['edit.mp4', 'other.srt']);
    expect(fs.statSync(path.join(d, 'edit.mp4')).isDirectory()).toBe(true);
  }, 30000);
});

// -------------------------------------------------------------------------------------------------
// Finalize follow-up: a failed final move keeps the finished render
// -------------------------------------------------------------------------------------------------

describe('a failed final move keeps the finished render', () => {
  it('names the kept render in the error instead of deleting it', async () => {
    const d = sub('keep');
    const target = path.join(d, 'edit.mp4');
    const real = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === target) throw Object.assign(new Error('EPERM: simulated'), { code: 'EPERM' });
      return real(from, to);
    });
    const err = await runExport(request(d, { fileName: 'edit.mp4' })).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/EPERM/);
    const files = fs.readdirSync(d);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^edit\.recut-unsaved-.*\.mp4$/);
    expect(err?.message).toContain(path.join(d, files[0]));
    expect(isMp4(path.join(d, files[0]))).toBe(true);
  }, 30000);
});
