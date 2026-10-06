/**
 * Project open / save / autosave performance paths (roadmap §1 Phase 1 C):
 *  - serializeProject writes the one-record-per-line layout (shared/projectJson.ts); compact chunks are exactly
 *    JSON.stringify; both parse to the same project.
 *  - main sends an opened project as JSON pieces (shared/projectWire.ts) that decode to exactly what
 *    normalizeProject returned, without normalizing again.
 *  - saveProjectJson writes renderer-serialized text as-is with the .bak / symlink / atomic semantics of
 *    saveProjectFile; the untitled autosave is matched by its id from the file head.
 *  - the renderer saves / autosaves through one string and opens a wire reply without a second normalize; a plain
 *    project object (older bridge) is still normalized.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMediaItem, createProject, LiveView, normalizeProject, normalizeProjectWithReport, serializeProject } from '../../shared/project';
import { formatProjectJson, projectJsonChunks } from '../../shared/projectJson';
import { decodeProjectWire, encodeProjectWire, isProjectWire } from '../../shared/projectWire';
import { makeClip } from '../../shared/timeline';
import type { MediaItem, Project, Sequence } from '../../shared/model';
import type { LoadReply, RecoveryReply } from '../../shared/ipc';
import {
  clearUntitledAutosaveForId, loadProjectFile, saveProjectFile, saveProjectJson, topLevelProjectId, untitledAutosavePath,
  writeAutosaveJson,
} from '../../electron/project/io';
import { useStore, resetStore } from '../../src/state/store';
import { autosaveProject, openProject, projectFromReply, saveProject, serializeProjectSliced } from '../../src/state/mediaActions';
import { recoveryPrompt } from '../../src/app/project';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const rt = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

/** A project with clips, transitions, markers, cues, a snapshot, media with detected scenes, scenes and subtitles. */
function richProject(): Project {
  const p = createProject('Rich "quoted" é ');
  const seq = p.sequences[p.activeSequenceId!];
  const a = makeClip({ mediaId: 'm1', name: 'A', sourceIn: 1.5, duration: 50, kind: 'video' }, 0);
  a.id = 'ca'; a.linkId = 'L1'; a.tags = ['t'];
  const b = makeClip({ mediaId: 'm1', name: 'B\n2', sourceIn: 0, duration: 40, kind: 'video' }, 50);
  b.id = 'cb';
  seq.videoTracks[0].clips = [a, b];
  seq.videoTracks[0].transitions = [{ id: 'tr1', type: 'crossDissolve', duration: 10, outClipId: 'ca', inClipId: 'cb' }];
  seq.audioTracks[0].clips = [{ ...makeClip({ mediaId: 'm1', name: 'A', sourceIn: 1.5, duration: 50, kind: 'audio' }, 0), id: 'cau', linkId: 'L1' }];
  seq.markers = [{ id: 'mk1', time: 12, duration: 0, name: 'M', note: 'x', color: '#fff', kind: 'marker' }];
  seq.storyBlocks = [{ id: 'sb1', name: 'Act 1', start: 0, end: 90, color: '#123', notes: '' }];
  seq.subtitleTracks = [{ id: 'sst1', name: 'Subs', language: 'eng', enabled: true, cues: [{ id: 'q2', start: 60, duration: 10, offset: 0, text: 'free' }] }];
  seq.view = new LiveView({ playhead: 7, zoom: 2, scroll: 3, inPoint: 1, outPoint: 80 });
  const { snapshots: _s, ...data } = rt(seq);
  seq.snapshots = [{ id: 'snap1', name: 'Before', createdAt: 123, data: { ...data, view: new LiveView(data.view) } }];
  const m = createMediaItem('/media/a.mkv', 'a.mkv') as MediaItem;
  m.id = 'm1'; m.kind = 'video';
  m.detectedScenes = [{ id: 'ds1', start: 0, end: 5, name: 'S1', tags: [], characters: [] }, { id: 'ds2', start: 5, end: 9, name: 'S2', tags: [], characters: [] }];
  p.media = { m1: m };
  p.scenes = { sc1: { id: 'sc1', name: 'Scene', mediaId: 'm1', in: 1, out: 4, characters: [], location: '', arc: '', tags: [], notes: '', rating: 4, color: '#123456', createdAt: 9 } };
  p.subtitleTracks = { st1: { id: 'st1', name: 'eng', language: 'eng', mediaId: 'm1', origin: 'srt', cues: [{ id: 'c1', start: 1, end: 2, text: 'Hello' }] } };
  return p;
}

let tmp: string;
let userData: string;
beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'recut-iop-'));
  userData = path.join(tmp, 'userData');
  await fsp.mkdir(userData, { recursive: true });
});
afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });

describe('project file layout (serializeProject)', () => {
  it('parses to exactly what JSON.stringify gives, with one record per line under an indented structure', () => {
    const p = richProject();
    const text = serializeProject(p);
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(p)));
    expect(text).toBe(formatProjectJson(p));
    const lines = text.split('\n');
    expect(lines[0]).toBe('{');
    expect(lines[1]).toBe('  "formatVersion": 1,');
    // each clip is one compact line; the structure around it is indented
    const clipLine = lines.find((l) => l.includes('"id":"ca"'))!;
    expect(clipLine.trim()).toBe(JSON.stringify(p.sequences[p.activeSequenceId!].videoTracks[0].clips[0]) + ',');
    expect(lines.some((l) => /^ {6}"videoTracks": \[$/.test(l))).toBe(true);
    expect(lines.filter((l) => l.includes('"name":"S1"') || l.includes('"name":"S2"'))).toHaveLength(2);
    // much smaller than a 2-space pretty print
    expect(text.length).toBeLessThan(JSON.stringify(p, null, 2).length);
  });

  it('compact chunks are byte-identical to JSON.stringify, also for odd values', () => {
    const p = richProject() as Any;
    p.extra = { u: undefined, f: () => 1, d: new Date(0), list: [1, undefined, () => 2, , 3], empty: {}, none: [] }; // eslint-disable-line no-sparse-arrays
    p.sequences[p.activeSequenceId].unknownField = { nested: [[[]]] };
    p.media.m1.withUndefined = undefined;
    const out: string[] = [];
    const it = projectJsonChunks(p, out, { compact: true });
    while (!it.next().done) { /* run */ }
    expect(out.join('')).toBe(JSON.stringify(p));
    expect(JSON.parse(serializeProject(p))).toEqual(JSON.parse(JSON.stringify(p)));
  });

  it('yields between records, and the text does not depend on where it pauses', async () => {
    const p = richProject();
    const seq = p.sequences[p.activeSequenceId!];
    seq.markers = Array.from({ length: 1000 }, (_, i) => ({ id: `m${i}`, time: i, duration: 0, name: '', note: '', color: '#fff', kind: 'marker' as const }));
    const out: string[] = [];
    const it = projectJsonChunks(p, out);
    let steps = 0;
    while (!it.next().done) steps++;
    expect(steps).toBeGreaterThanOrEqual(5);
    expect(out.join('')).toBe(serializeProject(p));
    expect(await serializeProjectSliced(p)).toBe(serializeProject(p));
    expect(await serializeProjectSliced(p, true)).toBe(JSON.stringify(p));
  });

  it('a saved file loads back to the same project; the old pretty-printed files still load', async () => {
    const p = richProject();
    const f = path.join(tmp, 'rich.recut');
    expect((await saveProjectFile(f, p)).ok).toBe(true);
    const r = await loadProjectFile(f);
    expect(r.ok && rt(r.project)).toEqual(rt(normalizeProject(rt(p))));
    const old = path.join(tmp, 'old.recut');
    await fsp.writeFile(old, JSON.stringify(p, null, 2));
    const r2 = await loadProjectFile(old);
    expect(r2.ok && rt(r2.project)).toEqual(rt(normalizeProject(rt(p))));
  });
});

describe('project wire (main -> renderer on open)', () => {
  it('decodes to exactly the normalized project, LiveView instances included', async () => {
    const norm = normalizeProject(rt(richProject()));
    const wire = encodeProjectWire(norm);
    expect(isProjectWire(wire)).toBe(true);
    expect(isProjectWire(rt(wire))).toBe(true); // survives a structured / JSON copy (IPC)
    expect(wire.parts.filter(([c]) => c === 'sequences')).toHaveLength(Object.keys(norm.sequences).length);
    let pauses = 0;
    const back = await decodeProjectWire(rt(wire), () => { pauses++; });
    expect(pauses).toBe(wire.parts.length);
    expect(back).toEqual(norm);
    expect(Object.keys(back)).toEqual(Object.keys(norm));
    for (const s of Object.values(back.sequences)) {
      expect(s.view).toBeInstanceOf(LiveView);
      for (const sn of s.snapshots) expect(sn.data.view).toBeInstanceOf(LiveView);
    }
  });

  it('keeps a "__proto__" sequence key an own property, never the prototype', async () => {
    const norm = normalizeProject(rt(createProject('x')));
    const wire = encodeProjectWire(norm);
    const seqPart = wire.parts.find(([c]) => c === 'sequences')!;
    wire.parts.push(['sequences', '__proto__', seqPart[2]]);
    const back = await decodeProjectWire(wire);
    expect(Object.getPrototypeOf(back.sequences)).toBe(Object.prototype);
    expect(Object.hasOwn(back.sequences, '__proto__')).toBe(true);
  });

  it('rejects anything that is not a wire', () => {
    for (const v of [null, 1, 'x', {}, { normalized: false, head: '{}', parts: [] }, { normalized: true, head: 1, parts: [] }]) expect(isProjectWire(v)).toBe(false);
  });
});

describe('main: saveProjectJson / untitled autosave id', () => {
  it('writes the text as-is, keeps a .bak of the previous file and leaves no temp file', async () => {
    const f = path.join(tmp, 'p');
    const t1 = serializeProject(createProject('one'));
    const t2 = serializeProject(createProject('two'));
    const r1 = await saveProjectJson(f, t1);
    expect(r1).toEqual({ ok: true, path: path.join(tmp, 'p.recut') });
    expect((await saveProjectJson(f, t2)).ok).toBe(true);
    expect(await fsp.readFile(path.join(tmp, 'p.recut'), 'utf8')).toBe(t2);
    expect(await fsp.readFile(path.join(tmp, 'p.recut.bak'), 'utf8')).toBe(t1);
    expect((await fsp.readdir(tmp)).filter((n) => n.includes('.tmp-'))).toEqual([]);
    const loaded = await loadProjectFile(path.join(tmp, 'p.recut'));
    expect(loaded.ok && loaded.project.name).toBe('two');
  });

  it('refuses text that is not a JSON object and leaves the file alone', async () => {
    const f = path.join(tmp, 'p.recut');
    await saveProjectJson(f, serializeProject(createProject('keep')));
    const before = await fsp.readFile(f, 'utf8');
    for (const bad of ['', 'nope', '[1]', '{', 42, null]) {
      const r = await saveProjectJson(f, bad as unknown as string);
      expect(r.ok).toBe(false);
    }
    expect(await fsp.readFile(f, 'utf8')).toBe(before);
  });

  it.skipIf(process.platform === 'win32')('saves through a symlinked .recut to its real file', async () => {
    const real = path.join(tmp, 'real.recut');
    await saveProjectJson(real, serializeProject(createProject('v1')));
    const link = path.join(tmp, 'link.recut');
    await fsp.symlink(real, link);
    expect((await saveProjectJson(link, serializeProject(createProject('v2')))).ok).toBe(true);
    expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await fsp.readFile(real, 'utf8')).name).toBe('v2');
  });

  it('topLevelProjectId finds the top-level id only', () => {
    const p = createProject('x');
    expect(topLevelProjectId(serializeProject(p))).toBe(p.id);
    expect(topLevelProjectId(JSON.stringify(p))).toBe(p.id);
    expect(topLevelProjectId(JSON.stringify(p, null, 2))).toBe(p.id);
    expect(topLevelProjectId('{"a":{"id":"inner"},"b":[{"id":"x"}],"s":"\\"id\\": \\"no\\"","n":-1.5e3,"t":true,"id":"top"}')).toBe('top');
    expect(topLevelProjectId('{"a":1}')).toBeNull();
    expect(topLevelProjectId('{"id":42}')).toBeNull();
    expect(topLevelProjectId('{"i\\u0064":"escaped"}')).toBe('escaped');
    expect(topLevelProjectId('{"media":{"m":{"x":"')).toBeUndefined(); // cut off before the answer
    expect(topLevelProjectId('[1]')).toBeUndefined();
    expect(topLevelProjectId('')).toBeUndefined();
  });

  it('clears the untitled autosave of the same project only, also when its id is past the probed head', async () => {
    const p = createProject('mine');
    const auto = untitledAutosavePath(userData);
    await writeAutosaveJson(null, JSON.stringify(p), userData);
    await clearUntitledAutosaveForId('someone-else', userData);
    expect(fs.existsSync(auto)).toBe(true);
    await clearUntitledAutosaveForId(p.id, userData);
    expect(fs.existsSync(auto)).toBe(false);
    // id after 100 KB of other data: the head does not settle it, the whole file is parsed
    const { id, ...rest } = p;
    await writeAutosaveJson(null, JSON.stringify({ pad: 'x'.repeat(100_000), ...rest, id }), userData);
    await clearUntitledAutosaveForId(p.id, userData);
    expect(fs.existsSync(auto)).toBe(false);
    await clearUntitledAutosaveForId(p.id, userData); // missing file: nothing to do
  });
});

describe('renderer: save / autosave / open paths', () => {
  const g = globalThis as Any;
  let calls: { kind: string; path: string | null; arg: unknown }[];
  beforeEach(() => { resetStore(); g.window = globalThis; calls = []; });
  afterEach(() => { delete g.recut; delete g.window; });

  it('saveProject sends the file text through saveProjectJson (one string), else the object', async () => {
    g.recut = {
      saveProjectJson: async (p: string, json: string) => { calls.push({ kind: 'json', path: p, arg: json }); return { ok: true, path: p }; },
      saveProject: async (p: string, project: Project) => { calls.push({ kind: 'obj', path: p, arg: project }); return { ok: true, path: p }; },
    };
    useStore.setState({ dirty: true });
    const res = await saveProject('/p/x.recut');
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('json');
    const json = calls[0].arg as string;
    expect(json).toContain('\n  "');
    const st = useStore.getState();
    expect(JSON.parse(json).id).toBe(st.project.id);
    expect({ ...JSON.parse(json), modifiedAt: 0 }).toEqual({ ...rt(st.project), modifiedAt: 0 });
    expect(st.dirty).toBe(false);
    expect(st.projectPath).toBe('/p/x.recut');

    delete g.recut.saveProjectJson;
    await saveProject('/p/y.recut');
    expect(calls[1].kind).toBe('obj');
  });

  it('autosave sends compact JSON', async () => {
    g.recut = { autosaveProjectJson: async (p: string | null, json: string) => { calls.push({ kind: 'json', path: p, arg: json }); return { ok: true, path: 'a' }; } };
    useStore.setState({ dirty: true });
    await autosaveProject();
    const json = calls[0].arg as string;
    expect(json).not.toContain('\n');
    expect({ ...JSON.parse(json), modifiedAt: 0 }).toEqual({ ...rt(useStore.getState().project), modifiedAt: 0 });
  });

  it('opens a wire reply without normalizing again; a plain project object is normalized', async () => {
    const norm = normalizeProject(rt(richProject()));
    // Something normalizeProject would change: a running proxy job (reset to 'none' on load). In a wire it stays,
    // proving the renderer trusts main's normalization instead of repeating it.
    (norm.media.m1 as Any).proxy = { status: 'running' };
    const wireReply: LoadReply = { ok: true, path: '/p/rich.recut', projectWire: encodeProjectWire(norm) };
    g.recut = { loadProject: async () => rt(wireReply) };
    const res = await openProject('/p/rich.recut');
    expect(res.ok).toBe(true);
    const loaded = useStore.getState().project;
    expect(loaded.media.m1.proxy.status).toBe('running');
    expect(rt(loaded)).toEqual(rt(norm));
    expect(loaded.sequences[loaded.activeSequenceId!].view).toBeInstanceOf(LiveView);
    expect(useStore.getState().projectPath).toBe('/p/rich.recut');

    g.recut = { loadProject: async () => ({ ok: true, path: '/p/rich.recut', project: rt(norm) }) };
    await openProject('/p/rich.recut');
    expect(useStore.getState().project.media.m1.proxy.status).toBe('none');

    g.recut = { loadProject: async () => ({ ok: true, path: '/p/rich.recut', projectWire: { normalized: true } }) };
    const bad = await openProject('/p/rich.recut');
    expect(bad.ok).toBe(false);
  });

  it('recovery replies carry the project as a wire and its name for the prompt', async () => {
    const norm = normalizeProject(rt(createProject('Recovered Cut')));
    const reply: RecoveryReply = { autosavePath: '/p/a.recut.autosave', projectPath: '/p/a.recut', savedAt: 0, projectName: norm.name, projectWire: encodeProjectWire(norm) };
    expect(recoveryPrompt(reply).detail).toContain('"Recovered Cut"');
    const back = await projectFromReply(reply);
    expect(rt(back)).toEqual(rt(norm));
    const withRepairs = normalizeProjectWithReport(rt(norm));
    expect(withRepairs.repairs).toEqual([]);
  });
});

describe('normalizeProject (optimized) keeps its results', () => {
  it('a list with holes or junk is still filtered and reported; clean lists pass through', () => {
    const p = rt(createProject('x')) as Any;
    const seq: Sequence = p.sequences[p.activeSequenceId];
    p.tags.characters = ['a', 1, 'b'];
    (seq as Any).markers = [{ id: 'm', time: 1 }, 'junk'];
    const r = normalizeProjectWithReport(p);
    expect(r.project.tags.characters).toEqual(['a', 'b']);
    expect(r.project.sequences[seq.id].markers.map((m) => m.id)).toEqual(['m']);
    expect(r.repairs).toEqual(['marker that is not an object removed', 'list entry that is not text removed']);
    const holes = rt(createProject('y')) as Any;
    holes.tags.custom = ['a', 'b'];
    delete holes.tags.custom[0]; // a hole (not JSON, but structuredClone keeps holes)
    expect(normalizeProjectWithReport(holes).project.tags.custom).toEqual(['b']);
  });

  it('values nested deeper than the limit are still removed and counted', () => {
    const p = rt(createProject('deep')) as Any;
    let deep: Any = 'leaf';
    for (let i = 0; i < 80; i++) deep = [deep];
    p.extra = deep;
    p.extra2 = { a: { b: deep } };
    const r = normalizeProjectWithReport(p);
    expect(r.repairs).toEqual(['value nested more than 64 levels deep removed (2x)']);
    expect(() => JSON.stringify(r.project)).not.toThrow();
  });
});
