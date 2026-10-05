/**
 * Export attack: render-graph validation gaps and real ffmpeg runs for the destructive cases.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportSettings, MediaItem, Sequence } from '../../shared/model';
import { createMediaItem, createSequence } from '../../shared/project';
import { makeClip, sequenceDuration } from '../../shared/timeline';
import { buildRenderGraph, exportOutputPath } from '../../electron/export/renderGraph';
import { runExport, startExportJob, type ExportJobQueue, type ExportJobSpec } from '../../electron/export/exporter';
import { probeFromFfprobe } from '../../electron/media/probe';
import { fakeProbe, FPS } from './helpers';

let dir: string;
let src: string;
let media: MediaItem;

function settings(over: Partial<ExportSettings> = {}): ExportSettings {
  return {
    outputDir: dir, fileName: 'out.mp4', width: 64, height: 36, fps: FPS, videoCodec: 'libx264', qualityMode: 'crf', crf: 30,
    videoBitrateKbps: 0, preset: 'ultrafast', audioCodec: 'aac', audioBitrateKbps: 64, audioChannels: 2, sampleRate: 48000,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false, ...over,
  };
}

function seqWith(clips: { start: number; duration: number; enabled?: boolean }[]): Sequence {
  const seq = createSequence('X', FPS, 64, 36);
  for (const c of clips) {
    const clip = makeClip({ mediaId: media.id, name: 'c', sourceIn: 0, duration: c.duration, kind: 'video' }, c.start);
    if (c.enabled === false) clip.enabled = false;
    seq.videoTracks[0].clips.push(clip);
  }
  return seq;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-attack-export-'));
  src = path.join(dir, 'source.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x36:r=24:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  const raw = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', src]).toString());
  media = { ...createMediaItem(src, 'source.mp4'), kind: 'video', probe: probeFromFfprobe(raw, src, fs.statSync(src).size) };
});
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('render graph validation', () => {
  it('an empty sequence is refused', () => {
    expect(() => buildRenderGraph({ sequence: seqWith([]), media: { [media.id]: media }, settings: settings() })).toThrow(/empty/);
  });

  it('a sequence whose only clips are disabled must be refused or at least warned about (not a silent black render)', () => {
    const seq = seqWith([{ start: 0, duration: 48, enabled: false }]);
    let g: ReturnType<typeof buildRenderGraph> | null = null;
    let err: unknown = null;
    try { g = buildRenderGraph({ sequence: seq, media: { [media.id]: media }, settings: settings() }); } catch (e) { err = e; }
    const warned = g ? g.warnings.some((w) => /disabled|nothing/i.test(w)) : false;
    expect(err !== null || warned, `graph built silently: inputs=${g?.inputCount} warnings=${JSON.stringify(g?.warnings)}`).toBe(true);
  });

  it('in > out and in == out fall back to the entire sequence with a warning (never a 0-frame or negative export)', () => {
    const seq = seqWith([{ start: 0, duration: 48 }]);
    for (const [i, o] of [[40, 10], [10, 10]]) {
      seq.view.inPoint = i; seq.view.outPoint = o;
      const g = buildRenderGraph({ sequence: seq, media: { [media.id]: media }, settings: settings({ rangeMode: 'inOut' }) });
      expect(g.frameCount).toBe(48);
      expect(g.warnings.some((w) => /In\/Out/.test(w))).toBe(true);
    }
  });

  it('file names are sanitized server-side too: slashes must not escape the output folder', () => {
    const p = exportOutputPath(settings({ fileName: '../../escape.mp4' }));
    expect(path.resolve(p).startsWith(path.resolve(dir) + path.sep), `output path escaped the folder: ${p}`).toBe(true);
    const q = exportOutputPath(settings({ fileName: 'sub/dir/x.mp4' }));
    expect(path.dirname(path.resolve(q))).toBe(path.resolve(dir));
  });

  it('quotes / unicode / spaces in the file name are kept and resolvable', () => {
    // `"` is illegal on Windows and stripped (same as the dialog's sanitizeFileName); the rest is kept.
    const name = `Ünïcödé 🎬 "quoted" it's.mp4`;
    const p = exportOutputPath(settings({ fileName: name }));
    expect(path.basename(p)).toBe(name.replace(/"/g, ''));
  });

  it('absurd dimensions (16000x9000) are not capped by the main-process graph builder', () => {
    const seq = seqWith([{ start: 0, duration: 24 }]);
    // The dialog caps at 8192; the main process now refuses too (clear error instead of a warning).
    expect(() => buildRenderGraph({ sequence: seq, media: { [media.id]: media }, settings: settings({ width: 16000, height: 9000 }) })).toThrow(/dimensions must be between 16 and 8192/);
  });

  it('an export whose output path equals one of its own source files must be refused', () => {
    const seq = seqWith([{ start: 0, duration: 24 }]);
    const s = settings({ outputDir: path.dirname(src), fileName: path.basename(src) });
    const req = { sequence: seq, media: { [media.id]: media }, settings: s };
    // Refused at graph level too (runExport goes through buildRenderGraph) ...
    expect(() => buildRenderGraph(req)).toThrow(/used by the sequence/);
    // ... and by startExportJob:
    let refused = false;
    const queue: ExportJobQueue = { add: (spec: ExportJobSpec) => ({ id: 'j', kind: 'export', title: spec.title, status: 'queued', progress: 0 }), cancel: () => {} };
    return startExportJob(queue, req).then((r) => { refused = !r.ok; expect(refused, 'startExportJob accepted output == source').toBe(true); });
  });
});

describe('real ffmpeg runs', () => {
  it('DESTRUCTIVE: exporting onto a source file overwrites the original media', async () => {
    const copy = path.join(dir, 'precious.mp4');
    fs.copyFileSync(src, copy);
    const before = fs.statSync(copy).size;
    const m2: MediaItem = { ...media, id: 'm2', path: copy, name: 'precious.mp4' };
    const seq = createSequence('X', FPS, 64, 36);
    seq.videoTracks[0].clips.push(makeClip({ mediaId: 'm2', name: 'c', sourceIn: 0, duration: 12, kind: 'video' }, 0)); // 0.5 s of a 2 s file
    const req = { sequence: seq, media: { m2 }, settings: settings({ outputDir: dir, fileName: 'precious.mp4' }) };
    let error: unknown = null;
    try { await runExport(req); } catch (e) { error = e; }
    const after = fs.existsSync(copy) ? fs.statSync(copy).size : -1;
    const dur = fs.existsSync(copy) ? Number(JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', copy]).toString()).format.duration) : -1;
    expect(error, 'export onto its own source should have been refused').not.toBeNull();
    expect(after === before && Math.abs(dur - 2) < 0.2, `source replaced: size ${before} → ${after}, duration now ${dur}s`).toBe(true);
  }, 60_000);

  it('deleting the output folder mid-export fails the job promptly (no hang) and leaves no .part', async () => {
    const out = path.join(dir, 'vanish');
    fs.mkdirSync(out);
    const seq = createSequence('X', FPS, 64, 36);
    seq.videoTracks[0].clips.push(makeClip({ mediaId: media.id, name: 'c', sourceIn: 0, duration: 48, kind: 'video' }, 0));
    const req = { sequence: seq, media: { [media.id]: media }, settings: settings({ outputDir: out, fileName: 'v.mp4', preset: 'veryslow', crf: 10, width: 1920, height: 1080 }) };
    let gotProgress = false;
    const p = runExport(req, (pr) => { if (pr > 0 && !gotProgress) { gotProgress = true; fs.rmSync(out, { recursive: true, force: true }); } });
    const t0 = Date.now();
    const result = await p.then(() => 'ok').catch((e: Error) => e.message);
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(result).not.toBe('ok');
    expect(fs.existsSync(path.join(out, 'v.part.mp4'))).toBe(false);
  }, 90_000);

  it('cancel right after start leaves neither output nor .part behind', async () => {
    const seq = createSequence('X', FPS, 64, 36);
    seq.videoTracks[0].clips.push(makeClip({ mediaId: media.id, name: 'c', sourceIn: 0, duration: 48, kind: 'video' }, 0));
    const ac = new AbortController();
    const req = { sequence: seq, media: { [media.id]: media }, settings: settings({ fileName: 'cancel.mp4', preset: 'veryslow', width: 1920, height: 1080 }) };
    const p = runExport(req, (pr) => { if (pr > 0) ac.abort(); }, ac.signal);
    await expect(p).rejects.toThrow(/canceled/);
    expect(fs.existsSync(path.join(dir, 'cancel.mp4'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'cancel.part.mp4'))).toBe(false);
  }, 60_000);

  it('a clip that extends past its (relinked, shorter) media exports without failing but with a warning', () => {
    const seq = createSequence('X', FPS, 64, 36);
    seq.videoTracks[0].clips.push(makeClip({ mediaId: media.id, name: 'c', sourceIn: 1, duration: 120, kind: 'video' }, 0)); // needs 6 s of a 2 s file
    const g = buildRenderGraph({ sequence: seq, media: { [media.id]: media }, settings: settings() });
    expect(g.warnings.some((w) => /past|exceeds|beyond|shorter/i.test(w)), `no warning that the clip exceeds the media: ${JSON.stringify(g.warnings)}`).toBe(true);
  });

  it('sanity: sequenceDuration counts disabled clips (why disabled-only sequences export black)', () => {
    expect(sequenceDuration(seqWith([{ start: 0, duration: 10, enabled: false }]))).toBe(10);
    void fakeProbe;
  });
});
