/**
 * Project file attack: normalizeProject robustness + electron/project/io save/load/autosave/recovery paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProject, createSequence, normalizeProject, serializeProject, PROJECT_FORMAT_VERSION } from '../../shared/project';
import { makeClip, sequenceDuration, resolveSubtitleCues, allTracks } from '../../shared/timeline';
import {
  saveProjectFile, loadProjectFile, writeAutosave, checkRecovery, atomicWriteFile, BACKUP_EXT, autosavePathFor,
} from '../../electron/project/io';
import { buildRenderGraph } from '../../electron/export/renderGraph';
import { buildBinRows } from '../../src/panels/project/tree';
import type { Project } from '../../shared/model';
import { S, fresh, insert, fakeMedia } from './helpers';

let tmp: string;
beforeEach(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'recut-attack-io-')); });
afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });

function projectWithClips(): Project {
  const f = fresh();
  insert(f, 0, 5, 0); insert(f, 0, 5, 120);
  S().addTransitionAtCut(f.seqId, f.seq().videoTracks[0].id, 120, 'crossDissolve', 24);
  return JSON.parse(JSON.stringify(S().project)) as Project;
}

describe('normalizeProject hostile input', () => {
  it('formatVersion 99 is refused with a clear message', () => {
    expect(() => normalizeProject({ ...createProject('x'), formatVersion: 99 })).toThrow(/newer ReCut/);
  });

  it('non-object / missing formatVersion / junk sequences are handled without throwing TypeErrors', () => {
    expect(() => normalizeProject(null)).toThrow(/not a JSON object/);
    expect(() => normalizeProject({})).toThrow(/formatVersion/);
    const p = normalizeProject({ formatVersion: 1, sequences: { a: null, b: 5, c: { name: 'ok' } }, media: { m: null, n: 'str' }, bins: 7 });
    expect(Object.keys(p.sequences)).toEqual(['c']);
    expect(Object.keys(p.media)).toEqual([]);
  });

  it('clips with duration 0 / negative / NaN are dropped, but NaN or non-finite start must not survive either', () => {
    const p = projectWithClips();
    const seqId = p.activeSequenceId!;
    const t = p.sequences[seqId].videoTracks[0];
    t.clips[0].duration = 0; t.clips[1].duration = -5;
    t.clips.push({ ...t.clips[1], id: 'nan', duration: NaN, start: 10 });
    t.clips.push({ ...t.clips[1], id: 'badstart', duration: 10, start: NaN });
    t.clips.push({ ...t.clips[1], id: 'infstart', duration: 10, start: Infinity });
    const n = normalizeProject(p);
    const ids = n.sequences[seqId].videoTracks[0].clips.map((c) => c.id);
    expect(ids).not.toContain('nan');
    expect(ids, 'clip with start=NaN loaded; sequenceDuration becomes NaN').not.toContain('badstart');
    expect(ids, 'clip with start=Infinity loaded').not.toContain('infstart');
    expect(Number.isFinite(sequenceDuration(n.sequences[seqId]))).toBe(true);
  });

  it('a clip with NaN start poisons sequenceDuration and the export graph (downstream symptom)', () => {
    const p = projectWithClips();
    const seqId = p.activeSequenceId!;
    p.sequences[seqId].videoTracks[0].clips[0].start = NaN;
    const n = normalizeProject(p);
    const seq = n.sequences[seqId];
    const st = { outputDir: tmp, fileName: 'x', width: 64, height: 64, fps: seq.fps, videoCodec: 'libx264' as const, qualityMode: 'crf' as const, crf: 20, videoBitrateKbps: 0, preset: 'ultrafast', audioCodec: 'aac' as const, audioBitrateKbps: 96, audioChannels: 2 as const, sampleRate: 48000, rangeMode: 'entire' as const, burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false as const };
    let durationSec: number | null = null; let err: string | null = null;
    try { durationSec = buildRenderGraph({ sequence: seq, media: n.media, settings: st }).durationSec; } catch (e) { err = String(e); }
    expect(err !== null || Number.isFinite(durationSec), `render graph built with durationSec=${durationSec} (ffmpeg gets "-t NaN")`).toBe(true);
  });

  it('sequences referencing missing media ids load; cues/transitions do not throw', () => {
    const p = projectWithClips();
    p.media = {};
    const n = normalizeProject(p);
    const seq = n.sequences[n.activeSequenceId!];
    expect(allTracks(seq).flatMap((t) => t.clips).length).toBe(4);
    expect(() => resolveSubtitleCues(seq)).not.toThrow();
  });

  it('a transition whose clips are missing from the file is dropped on load', () => {
    const p = projectWithClips();
    const seqId = p.activeSequenceId!;
    const t = p.sequences[seqId].videoTracks[0];
    t.transitions.push({ id: 'ghost', type: 'crossDissolve', duration: 10, outClipId: 'nope', inClipId: 'nada' });
    const n = normalizeProject(p);
    expect(n.sequences[seqId].videoTracks[0].transitions.map((x) => x.id), 'dangling transition kept').not.toContain('ghost');
  });

  it('circular bin parents are repaired so their contents stay visible in the Project panel', () => {
    const p = createProject('cyc');
    p.bins.a = { id: 'a', name: 'A', parentId: 'b' };
    p.bins.b = { id: 'b', name: 'B', parentId: 'a' };
    p.bins.self = { id: 'self', name: 'Self', parentId: 'self' };
    const m = fakeMedia('in-cycle.mp4'); m.binId = 'a';
    const m2 = fakeMedia('in-self.mp4'); m2.binId = 'self';
    const m3 = fakeMedia('dangling-bin.mp4'); m3.binId = 'does-not-exist';
    p.media[m.id] = m; p.media[m2.id] = m2; p.media[m3.id] = m3;
    const n = normalizeProject(JSON.parse(JSON.stringify(p)));
    const rows = buildBinRows({
      bins: n.bins, media: n.media, sequences: n.sequences, sequenceOrder: n.sequenceOrder, scenes: n.scenes, query: '',
      expanded: new Proxy({}, { get: () => true }) as Record<string, boolean>, sort: 'name', view: 'list', cols: 1,
    } as unknown as Parameters<typeof buildBinRows>[0]);
    const shown = rows.filter((r) => r.kind === 'media').map((r) => (r as { media: { name: string } }).media.name);
    expect(shown, 'media inside a bin cycle is invisible').toContain('in-cycle.mp4');
    expect(shown, 'media inside a self-parented bin is invisible').toContain('in-self.mp4');
    expect(shown, 'media whose bin no longer exists is invisible').toContain('dangling-bin.mp4');
  });

  it('duplicate ids in sequenceOrder are de-duplicated', () => {
    const p = createProject('dup');
    p.sequenceOrder = [p.activeSequenceId!, p.activeSequenceId!];
    const n = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(n.sequenceOrder.length, 'sequence listed twice').toBe(1);
  });

  it('view state with zoom 0 / NaN playhead is sanitized', () => {
    const p = createProject('view');
    const s = p.sequences[p.activeSequenceId!];
    s.view = { playhead: NaN, zoom: 0, scroll: -5, inPoint: 10, outPoint: 5 } as typeof s.view;
    const n = normalizeProject(JSON.parse(JSON.stringify(p)));
    const vw = n.sequences[p.activeSequenceId!].view;
    expect(vw.zoom, 'zoom 0 → division by zero in the timeline').toBeGreaterThan(0);
    expect(Number.isFinite(vw.playhead), 'NaN playhead').toBe(true);
    expect(vw.scroll).toBeGreaterThanOrEqual(0);
  });

  it('10 MB of notes round-trips through serialize/normalize in reasonable time', () => {
    const p = createProject('notes');
    const m = fakeMedia('big.mp4'); m.notes = 'x'.repeat(10 * 1024 * 1024);
    p.media[m.id] = m;
    const t0 = Date.now();
    const text = serializeProject(p);
    const n = normalizeProject(JSON.parse(text));
    expect(n.media[m.id].notes.length).toBe(10 * 1024 * 1024);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe('io: save / load / backup / recovery', () => {
  it('save → load → save is byte-identical (round-trip stability)', async () => {
    const p = projectWithClips();
    const file = path.join(tmp, 'rt.recut');
    const r1 = await saveProjectFile(file, p);
    expect(r1.ok).toBe(true);
    const first = await fsp.readFile(file, 'utf8');
    const loaded = await loadProjectFile(file);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    await saveProjectFile(file, loaded.project);
    const second = await fsp.readFile(file, 'utf8');
    expect(second).toBe(first);
  });

  it('saving to a path whose parent cannot be created fails gracefully (no throw, ok:false)', async () => {
    const blocker = path.join(tmp, 'file-not-dir');
    await fsp.writeFile(blocker, 'x');
    const res = await saveProjectFile(path.join(blocker, 'sub', 'p.recut'), createProject('x'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Could not save project/);
  });

  it('save over an existing file keeps a .bak and the sibling autosave is not offered for recovery afterwards', async () => {
    const file = path.join(tmp, 'p.recut');
    const p = createProject('one');
    await saveProjectFile(file, p);
    await writeAutosave(file, { ...p, name: 'autosaved' }, tmp);
    await new Promise((r) => setTimeout(r, 20));
    const p2 = { ...p, name: 'two' };
    await saveProjectFile(file, p2);
    expect(fs.existsSync(file + BACKUP_EXT)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file + BACKUP_EXT, 'utf8')).name).toBe('one');
    expect(await checkRecovery(tmp, [file])).toBeNull();
  });

  it('opening a corrupt .recut falls back to .bak — but must tell the caller it did (not a silent ok)', async () => {
    const file = path.join(tmp, 'c.recut');
    await saveProjectFile(file, createProject('good'));
    await saveProjectFile(file, createProject('good2')); // creates .bak = good
    await fsp.writeFile(file, '{ this is not json');
    const res = await loadProjectFile(file);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.project.name).toBe('good');
      // The result carries no indication that the backup was used (see qa.md): assert the contract we want.
      expect((res as unknown as { recovered?: boolean; fromBackup?: boolean; warning?: string }).fromBackup ?? (res as { warning?: string }).warning, 'silent .bak fallback').toBeTruthy();
    }
  });

  it('a project from a NEWER format must not be silently replaced by an older .bak', async () => {
    const file = path.join(tmp, 'v.recut');
    await saveProjectFile(file, createProject('old-format-copy'));
    await saveProjectFile(file, createProject('old-format-copy-2')); // .bak now exists (format 1)
    const newer = { ...createProject('from-the-future'), formatVersion: PROJECT_FORMAT_VERSION + 1 };
    await fsp.writeFile(file, JSON.stringify(newer));
    const res = await loadProjectFile(file);
    // Expected: ok:false with the "newer ReCut" message. Actual: ok:true with the stale backup → a later save overwrites the newer file.
    expect(res.ok, `loaded "${res.ok ? res.project.name : ''}" from .bak instead of refusing the newer-format file`).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/newer ReCut/);
  });

  it('opening a .recut that is actually a directory gives a readable error', async () => {
    const dir = path.join(tmp, 'folder.recut');
    await fsp.mkdir(dir);
    const res = await loadProjectFile(dir);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Could not open project/);
  });

  it('a newer-but-corrupt autosave is ignored by checkRecovery (silently)', async () => {
    const file = path.join(tmp, 'a.recut');
    await saveProjectFile(file, createProject('x'));
    const auto = autosavePathFor(file, tmp);
    await fsp.writeFile(auto, '{corrupt');
    const future = new Date(Date.now() + 60_000);
    await fsp.utimes(auto, future, future);
    expect(await checkRecovery(tmp, [file])).toBeNull();
    expect(fs.existsSync(auto)).toBe(true);
  });

  it('atomicWriteFile leaves no temp files behind on failure', async () => {
    const target = path.join(tmp, 'ro', 'x.json');
    await fsp.mkdir(path.dirname(target));
    await fsp.writeFile(target, 'old');
    // make rename fail by replacing the target with a non-empty directory
    await fsp.rm(target); await fsp.mkdir(target); await fsp.writeFile(path.join(target, 'child'), '');
    await expect(atomicWriteFile(target, 'new')).rejects.toBeTruthy();
    const leftovers = (await fsp.readdir(path.dirname(target))).filter((n) => n.startsWith('.'));
    expect(leftovers).toEqual([]);
  });
});
