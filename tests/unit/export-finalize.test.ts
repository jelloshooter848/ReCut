/**
 * Export finalize step: the rendered <name>.recut-part-<random>.mp4 replaces <name>.mp4. A previous file at the output path
 * must survive when the replace fails (file locked by a player on Windows, EXDEV, EPERM, ...), and the error must
 * reach the caller. The success path replaces the old file and leaves no .part behind.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportSettings, MediaItem, MediaProbe } from '@shared/model';
import { createMediaItem, createProject, createSequence } from '@shared/project';
import { makeClip } from '@shared/timeline';
import { adaptFfmpegArgs, ffmpegMajorVersionSync } from '../../electron/media/ffmpeg';
import * as exporter from '../../electron/export/exporter';
import { buildExportRequest } from '../../src/panels/export/request';

const exec = promisify(execFile);
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';
const FPS = { num: 24, den: 1 };
const OLD = 'previous export the user still wants';

let dir: string;
let red: MediaItem;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-export-finalize-'));
  const file = path.join(dir, 'red.mp4');
  await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...adaptFfmpegArgs([
    '-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=24:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file,
  ], ffmpegMajorVersionSync(FFMPEG))]);
  const probe: MediaProbe = {
    container: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 1, size: fs.statSync(file).size,
    video: { index: 0, codec: 'h264', width: 160, height: 120, fps: FPS, avgFps: FPS, isVfr: false },
    audio: [], subtitles: [], startTime: 0, browserPlayable: true,
  };
  red = { ...createMediaItem(file, 'red.mp4'), id: 'm-red', kind: 'video', probe };
}, 60000);

afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
afterEach(() => { vi.restoreAllMocks(); });

function request(outDir: string, fileName: string) {
  const project = createProject('Finalize');
  project.media[red.id] = red;
  const seq = createSequence('Edit', FPS, 160, 120);
  seq.videoTracks[0].clips.push(makeClip({ mediaId: red.id, name: 'red', sourceIn: 0, duration: 12, speed: 1, kind: 'video' }, 0));
  project.sequences = { [seq.id]: seq };
  project.sequenceOrder = [seq.id];
  project.activeSequenceId = seq.id;
  const settings: ExportSettings = {
    outputDir: outDir, fileName, width: 160, height: 120, fps: FPS,
    videoCodec: 'libx264', qualityMode: 'crf', crf: 35, videoBitrateKbps: 1000, preset: 'ultrafast',
    audioCodec: 'aac', audioBitrateKbps: 128, audioChannels: 2, sampleRate: 48000,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false,
  };
  return buildExportRequest(project, seq, settings);
}

function freshDir(name: string): string {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const errno = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });

describe('runExport finalize', () => {
  it('replaces a previous export and leaves no .part file', async () => {
    const out = freshDir('replace');
    fs.writeFileSync(path.join(out, 'edit.mp4'), OLD);
    const res = await exporter.runExport({ ...request(out, 'edit.mp4'), overwrite: true });
    expect(res.outputPath).toBe(path.join(out, 'edit.mp4'));
    expect(fs.readFileSync(res.outputPath).subarray(4, 8).toString('latin1')).toBe('ftyp');
    expect(fs.readdirSync(out)).toEqual(['edit.mp4']);
  }, 30000);

  it('keeps the previous file intact, keeps the render and reports the error when the final rename fails', async () => {
    const out = freshDir('locked');
    const target = path.join(out, 'edit.mp4');
    fs.writeFileSync(target, OLD);
    const real = fs.renameSync;
    // A file held open by a player (Windows): it can be neither replaced nor moved.
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === target || String(from) === target) throw errno('EBUSY');
      return real(from, to);
    });
    const err = await exporter.runExport({ ...request(out, 'edit.mp4'), overwrite: true }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/EBUSY/);
    expect(fs.readFileSync(target, 'utf8')).toBe(OLD);
    // The finished render is kept next to the output (named in the error) so the user does not have to re-render.
    const files = fs.readdirSync(out).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toBe('edit.mp4');
    expect(files[1]).toMatch(/^edit\.recut-unsaved-.*\.mp4$/);
    expect(err?.message).toContain(path.join(out, files[1]));
  }, 30000);
});

describe('finalizeExportOutput', () => {
  const realOps = { renameSync: fs.renameSync, unlinkSync: fs.unlinkSync, lstatSync: fs.lstatSync };

  function setup(name: string) {
    const d = freshDir(name);
    const part = path.join(d, 'edit.part.mp4');
    const target = path.join(d, 'edit.mp4');
    fs.writeFileSync(part, 'new render');
    fs.writeFileSync(target, OLD);
    return { d, part, target };
  }

  it('replaces an existing file and leaves no .part', () => {
    const { d, part, target } = setup('fin-ok');
    exporter.finalizeExportOutput(part, target);
    expect(fs.readFileSync(target, 'utf8')).toBe('new render');
    expect(fs.readdirSync(d)).toEqual(['edit.mp4']);
  });

  it('works when there is no previous file', () => {
    const d = freshDir('fin-new');
    const part = path.join(d, 'edit.part.mp4');
    fs.writeFileSync(part, 'new render');
    exporter.finalizeExportOutput(part, path.join(d, 'edit.mp4'));
    expect(fs.readdirSync(d)).toEqual(['edit.mp4']);
  });

  it('never deletes the previous file when the new render cannot be moved into place', () => {
    const { d, part, target } = setup('fin-fail');
    const ops = { ...realOps, renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === part) throw errno('EPERM');
      realOps.renameSync(from, to);
    } };
    expect(() => exporter.finalizeExportOutput(part, target, ops)).toThrow(/EPERM/);
    expect(fs.readFileSync(target, 'utf8')).toBe(OLD);
    // The .part is left for the caller (runExport cleans it up); no backup is left behind.
    expect(fs.readdirSync(d).sort()).toEqual(['edit.mp4', 'edit.part.mp4']);
  });

  it('falls back to move-aside when the target cannot be replaced in place (e.g. read-only on Windows)', () => {
    const { d, part, target } = setup('fin-aside');
    let direct = 0;
    const ops = { ...realOps, renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === part && String(to) === target && direct++ === 0) throw errno('EPERM');
      realOps.renameSync(from, to);
    } };
    exporter.finalizeExportOutput(part, target, ops);
    expect(fs.readFileSync(target, 'utf8')).toBe('new render');
    expect(fs.readdirSync(d)).toEqual(['edit.mp4']);
  });

  it('keeps the backup and names it in the error when the backup cannot be restored', () => {
    const { d, part, target } = setup('fin-restore-fail');
    let backup = '';
    const ops = { ...realOps, renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === part) throw errno('EPERM'); // the render can never be moved in
      if (String(from) === target) backup = String(to);
      else if (String(to) === target) throw errno('EACCES'); // ... and the backup cannot be moved back
      realOps.renameSync(from, to);
    } };
    let err: Error | null = null;
    try { exporter.finalizeExportOutput(part, target, ops); } catch (e) { err = e as Error; }
    expect(err?.message).toMatch(/EPERM/);
    expect(backup).toMatch(/edit\.mp4\.recut-old-/);
    expect(err?.message).toContain(`The previous file was kept as "${backup}"`);
    expect(fs.readFileSync(backup, 'utf8')).toBe(OLD);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(d).sort()).toEqual(['edit.part.mp4', path.basename(backup)].sort());
  });

  it('throws the first error and moves nothing aside when the first rename fails and there is no target', () => {
    const d = freshDir('fin-no-target');
    const part = path.join(d, 'edit.part.mp4');
    const target = path.join(d, 'edit.mp4');
    fs.writeFileSync(part, 'new render');
    const calls: string[] = [];
    const ops = { ...realOps, renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      calls.push(`${String(from)} -> ${String(to)}`);
      throw errno('EXDEV');
    } };
    expect(() => exporter.finalizeExportOutput(part, target, ops)).toThrow(/Could not write the export to ".*edit\.mp4": EXDEV/);
    expect(calls).toEqual([`${part} -> ${target}`]);
    expect(fs.readdirSync(d)).toEqual(['edit.part.mp4']);
  });
});
