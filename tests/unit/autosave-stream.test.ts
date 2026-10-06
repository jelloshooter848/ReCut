/**
 * Streamed autosave (roadmap §1, perf E): the renderer streams the autosave text (compact JSON, the bytes of
 * JSON.stringify(project)) to main while it serializes it in slices, like the manual save
 * (shared/projectWire.ts ProjectAutosaveStreamApi, src/state/mediaActions.ts autosaveStreamed), and main appends
 * the pieces to a temp file beside the autosave file that only the commit renames over it
 * (electron/project/io.ts ProjectFileWriter.openAutosave). Covers:
 *  - the sliced compact serializer writes exactly JSON.stringify(project), also for odd values;
 *  - the autosave file is byte-identical to the one-string autosave, written in several pieces; the project file
 *    and its .bak are never touched; no temp file is left; recovery offers it as before;
 *  - a failed / incomplete / refused autosave leaves the previous autosave in place and no temp file;
 *  - autosaves never interleave;
 *  - bugs/closed/2026-10-06-autosave-during-save-ignored-by-recovery.md: after a save that left edits unsaved, an
 *    autosave newer than the project file follows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProject, LiveView, serializeProject } from '../../shared/project';
import type { Project } from '../../shared/model';
import type { SaveResult } from '../../shared/ipc';
import { canStreamAutosave, type ProjectAutosaveStreamApi, type ProjectSaveStreamApi } from '../../shared/projectWire';
import { autosavePathFor, checkRecovery, ProjectFileWriter, untitledAutosavePath, writeAutosaveJson } from '../../electron/project/io';
import { useStore, resetStore } from '../../src/state/store';
import { AUTOSAVE_AFTER_SAVE_MS, autosaveProject, saveProject, serializeProjectSliced } from '../../src/state/mediaActions';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const g = globalThis as Any;
const S = () => useStore.getState();

let tmp: string;
let userData: string;
beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'recut-autostream-'));
  userData = path.join(tmp, 'userData');
  resetStore();
  g.window = globalThis;
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete g.recut;
  delete g.window;
  await fsp.rm(tmp, { recursive: true, force: true });
});

const leftovers = async (dir: string) => (await fsp.readdir(dir).catch(() => [] as string[])).filter((n) => n.includes('.tmp-'));

/** A project whose compact text is a few MB (several pieces), with non-ASCII and escaped text. */
function bigProject(name = 'Auto é 日本 🎬'): Project {
  const p = createProject(name);
  const seq = p.sequences[p.activeSequenceId!];
  seq.markers = Array.from({ length: 30_000 }, (_, i) => ({
    id: `m${i}`, time: i, duration: 0, name: i % 7 ? `marker ${i}` : `ü "q" \\ \n 🎞 ${i} \ud800`, note: 'x'.repeat(40), color: '#fff', kind: 'marker' as const,
  }));
  return p;
}

/** window.recut streaming autosaves into a real ProjectFileWriter, checked like electron/ipc.ts does. */
function realAutosaveApi(log: { pieces: string[]; calls: string[] }) {
  const writers = new Map<string, ProjectFileWriter>();
  let n = 0;
  const api: ProjectAutosaveStreamApi = {
    autosaveProjectBegin: async (p) => {
      log.calls.push('begin');
      try { const w = await ProjectFileWriter.openAutosave(p, userData); const id = `a${n++}`; writers.set(id, w); return { ok: true, id }; } catch (e) { return { ok: false, error: `Autosave failed: ${(e as Error).message}` }; }
    },
    saveProjectChunk: (id, seq, text) => { log.pieces.push(text); writers.get(id)?.append(seq, text); },
    autosaveProjectCommit: async (p, id, totals) => {
      log.calls.push('commit');
      const w = writers.get(id)!;
      writers.delete(id);
      if (autosavePathFor(p, userData) !== w.path) { await w.abort(); return { ok: false, error: 'Autosave failed: the autosave was started for another project' }; }
      return w.commit(totals);
    },
    saveProjectAbort: async (id) => { log.calls.push('abort'); await writers.get(id)?.abort(); writers.delete(id); },
  };
  return api;
}

describe('sliced compact serialization', () => {
  it('is exactly JSON.stringify of the project', async () => {
    const p = bigProject();
    expect(await serializeProjectSliced(p, true)).toBe(JSON.stringify(p));
    const empty = createProject('empty');
    expect(await serializeProjectSliced(empty, true)).toBe(JSON.stringify(empty));
  });

  it('matches JSON.stringify for odd values: undefined, functions, toJSON, numeric and __proto__ keys, LiveView, empty records', async () => {
    const p = createProject('odd') as Any;
    const seq = p.sequences[p.activeSequenceId];
    seq.view = new LiveView({ playhead: 7, zoom: 2 });
    p.media = JSON.parse('{"__proto__": {"id": "x", "name": "proto"}, "2": {"id": "2"}, "10": {"id": "10", "gone": null}}');
    p.media.u = undefined;
    p.media.f = () => 1;
    p.media.d = new Date(0);
    p.media.t = { toJSON: (k: string) => `key ${k}` };
    p.scenes = {};
    p.subtitleTracks = { only: undefined };
    p.extra = undefined;
    p.when = new Date(5);
    p.tags.custom = ['a', undefined, () => 1];
    expect(await serializeProjectSliced(p, true)).toBe(JSON.stringify(p));
    const q = createProject('array-collection') as Any;
    q.sequences = [1, 2];
    expect(await serializeProjectSliced(q, true)).toBe(JSON.stringify(q));
  });
});

describe('streamed autosave: renderer -> main -> disk', () => {
  const now = 1_790_000_000_000;

  it('writes exactly the one-string autosave bytes in several pieces, never touches the project file or .bak, and recovery offers it', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const log = { pieces: [] as string[], calls: [] as string[] };
    g.recut = realAutosaveApi(log);
    expect(canStreamAutosave(g.recut)).toBe(true);
    const projectFile = path.join(tmp, 'Edit.recut');
    await fsp.writeFile(projectFile, 'PROJECT');
    await fsp.writeFile(projectFile + '.bak', 'BACKUP');
    const old = new Date(now - 60_000);
    await fsp.utimes(projectFile, old, old);
    const project = bigProject();
    useStore.setState({ project, projectPath: projectFile, dirty: true });
    await autosaveProject();
    const auto = projectFile + '.autosave';
    const text = await fsp.readFile(auto, 'utf8');
    expect(text).toBe(JSON.stringify({ ...project, modifiedAt: now }));
    expect(log.pieces.length).toBeGreaterThan(1);
    expect(log.pieces.join('')).toBe(text);
    expect(log.calls).toEqual(['begin', 'commit']);
    expect(await fsp.readFile(projectFile, 'utf8')).toBe('PROJECT');
    expect(await fsp.readFile(projectFile + '.bak', 'utf8')).toBe('BACKUP');
    expect(await fsp.readdir(tmp)).not.toContain('Edit.recut.autosave.bak');
    expect(await leftovers(tmp)).toEqual([]);
    // Same bytes as the one-string autosave of the same project.
    const ref = path.join(tmp, 'Ref.recut');
    await writeAutosaveJson(ref, JSON.stringify({ ...project, modifiedAt: now }), userData);
    expect(await fsp.readFile(ref + '.autosave', 'utf8')).toBe(text);
    vi.restoreAllMocks();
    const rec = await checkRecovery(userData, [projectFile]);
    expect(rec?.autosavePath).toBe(auto);
    expect(rec?.project.name).toBe(project.name);
    expect(S().dirty).toBe(true); // an autosave marks nothing saved
  });

  it('a never-saved project autosaves to the untitled autosave in app data', async () => {
    g.recut = realAutosaveApi({ pieces: [], calls: [] });
    useStore.setState({ project: createProject('Untitled one'), projectPath: null, dirty: true });
    await autosaveProject();
    const file = untitledAutosavePath(userData);
    expect(JSON.parse(await fsp.readFile(file, 'utf8')).name).toBe('Untitled one');
    expect(await leftovers(path.dirname(file))).toEqual([]);
    expect((await checkRecovery(userData, []))?.projectPath).toBeNull();
  });

  it('a clean project is not autosaved', async () => {
    const log = { pieces: [] as string[], calls: [] as string[] };
    g.recut = realAutosaveApi(log);
    useStore.setState({ dirty: false });
    await autosaveProject();
    expect(log.calls).toEqual([]);
  });

  it('a refused path (not a .recut project) is an error; nothing is written', async () => {
    const log = { pieces: [] as string[], calls: [] as string[] };
    g.recut = realAutosaveApi(log);
    useStore.setState({ projectPath: path.join(tmp, 'notes.txt'), dirty: true });
    await expect(autosaveProject()).rejects.toThrow(/Autosave failed: not a project path/);
    expect(log.pieces).toEqual([]);
    expect(await fsp.readdir(tmp)).toEqual([]);
  });

  it('an incomplete or failed autosave leaves the previous autosave in place and no temp file', async () => {
    const projectFile = path.join(tmp, 'Keep.recut');
    const auto = projectFile + '.autosave';
    await fsp.writeFile(auto, '{"previous":true}');
    // Pieces lost on the way: the commit's totals do not match.
    const w = await ProjectFileWriter.openAutosave(projectFile, userData);
    w.append(0, '{"a":');
    const r1 = await w.commit({ chunks: 1, chars: 9 });
    expect(r1.ok).toBe(false);
    expect((r1 as { error: string }).error).toMatch(/^Autosave failed: /);
    // Aborted.
    const w2 = await ProjectFileWriter.openAutosave(projectFile, userData);
    w2.append(0, '{"b":1}');
    await w2.abort();
    // Serialization fails in the renderer: the stream is aborted, the error thrown.
    const log = { pieces: [] as string[], calls: [] as string[] };
    g.recut = realAutosaveApi(log);
    const bad = createProject('bad') as Any;
    bad.media = { x: { big: BigInt(1) } };
    useStore.setState({ project: bad, projectPath: projectFile, dirty: true });
    await expect(autosaveProject()).rejects.toThrow();
    expect(log.calls).toContain('abort');
    expect(await fsp.readFile(auto, 'utf8')).toBe('{"previous":true}');
    expect(await leftovers(tmp)).toEqual([]);
  });

  it('a stream begun for one project is not committed as another one', async () => {
    const a = path.join(tmp, 'A.recut'), b = path.join(tmp, 'B.recut');
    const api = realAutosaveApi({ pieces: [], calls: [] });
    const begun = await api.autosaveProjectBegin(a);
    if (!begun.ok) throw new Error(begun.error);
    api.saveProjectChunk(begun.id, 0, '{}');
    const res = await api.autosaveProjectCommit(b, begun.id, { chunks: 1, chars: 2 });
    expect(res.ok).toBe(false);
    expect(await fsp.readdir(tmp)).toEqual([]);
  });

  it('autosaves never interleave: the second one starts after the first committed and writes the newer edit', async () => {
    const calls: string[] = [];
    const pending: (() => void)[] = [];
    let disk = '';
    let n = 0;
    const open = new Map<string, string[]>();
    const api: ProjectAutosaveStreamApi = {
      autosaveProjectBegin: async () => { const id = `a${n++}`; calls.push(`begin ${id}`); open.set(id, []); return { ok: true, id }; },
      saveProjectChunk: (id, _s, text) => { open.get(id)!.push(text); },
      autosaveProjectCommit: (_p, id) => new Promise<SaveResult>((r) => { calls.push(`commit ${id}`); pending.push(() => { disk = open.get(id)!.join(''); r({ ok: true, path: 'x' }); }); }),
      saveProjectAbort: async () => undefined,
    };
    g.recut = api;
    S().renameProject('A');
    const p1 = autosaveProject();
    S().renameProject('B');
    const p2 = autosaveProject();
    for (let i = 0; i < 50 && pending.length < 1; i++) await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['begin a0', 'commit a0']);
    pending[0]();
    for (let i = 0; i < 50 && pending.length < 2; i++) await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['begin a0', 'commit a0', 'begin a1', 'commit a1']);
    pending[1]();
    await Promise.all([p1, p2]);
    expect(JSON.parse(disk).name).toBe('B');
  });

  it('falls back to one string on a bridge without streamed autosaves', async () => {
    const sent: string[] = [];
    g.recut = { autosaveProjectJson: async (_p: string | null, json: string) => { sent.push(json); return { ok: true, path: 'x' }; } };
    useStore.setState({ dirty: true });
    await autosaveProject();
    expect(JSON.parse(sent[0]).id).toBe(S().project.id);
  });
});

/**
 * bugs/closed/2026-10-06-autosave-during-save-ignored-by-recovery.md: an edit made while a manual save is in flight
 * stays dirty, but its autosave may land before the save's write, and recovery then ignores it (not newer than the
 * project file). After such a save, another autosave must follow.
 */
describe('autosave after a save that left edits unsaved', () => {
  interface Pending { id: string; text: string[]; resolve: () => Promise<void> }
  let pending: Pending[];
  let autosaves: string[];
  /** Autosave writes started (awaited before the folder is removed). */
  let writing: Promise<unknown>[];
  const projectFile = () => path.join(tmp, 'Race.recut');
  /** Saves stream to the real project file but land only when the test says so; autosaves are written at once. */
  function api() {
    let n = 0;
    const open = new Map<string, string[]>();
    const save: ProjectSaveStreamApi = {
      saveProjectBegin: async () => { const id = `s${n++}`; open.set(id, []); return { ok: true, id }; },
      saveProjectChunk: (id, _seq, text) => { open.get(id)?.push(text); },
      saveProjectCommit: (id) => new Promise<SaveResult>((r) => {
        const text = open.get(id)!;
        pending.push({ id, text, resolve: async () => { await fsp.writeFile(projectFile(), text.join('')); r({ ok: true, path: projectFile() }); } });
      }),
      saveProjectAbort: async () => undefined,
    };
    g.recut = {
      ...save,
      autosaveProjectJson: (p: string | null, json: string) => { autosaves.push(json); const w = writeAutosaveJson(p, json, userData); writing.push(w); return w; },
    };
  }
  const tick = async (k = 20) => { for (let i = 0; i < k; i++) await new Promise((r) => setImmediate(r)); };
  const untilCommits = async (k: number) => { for (let i = 0; i < 400 && pending.length < k; i++) await new Promise((r) => setImmediate(r)); };
  const nameIn = (t: string | undefined) => (t ? JSON.parse(t).name : null);
  beforeEach(() => { pending = []; autosaves = []; writing = []; });
  afterEach(async () => { await Promise.all(writing); });

  it('the edit made during the save is autosaved again after the save, and recovery offers it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    api();
    S().renameProject('A');
    useStore.setState({ projectPath: projectFile() });
    const save = saveProject();
    await untilCommits(1);
    S().renameProject('B'); // the edit during the save ...
    await autosaveProject(); // ... and its autosave, landing before the save's write
    expect(nameIn(autosaves[0])).toBe('B');
    await pending[0].resolve();
    expect((await save).ok).toBe(true);
    expect(S().dirty).toBe(true);
    // Recovery would ignore that autosave: it is not newer than the project file.
    expect(await checkRecovery(userData, [projectFile()])).toBeNull();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_AFTER_SAVE_MS - 100);
    expect(autosaves).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    await tick();
    expect(autosaves).toHaveLength(2);
    expect(nameIn(autosaves[1])).toBe('B');
    // In the app that autosave lands AUTOSAVE_AFTER_SAVE_MS after the save's write; date the project file back so.
    const back = new Date(Date.now() - AUTOSAVE_AFTER_SAVE_MS);
    await fsp.utimes(projectFile(), back, back);
    const rec = await checkRecovery(userData, [projectFile()]);
    expect(rec?.project.name).toBe('B');
  });

  it('no extra autosave after a save without edits in flight, or when the project was saved again meanwhile', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    api();
    useStore.setState({ projectPath: projectFile() });
    S().renameProject('A');
    const s1 = saveProject();
    await untilCommits(1);
    await pending[0].resolve();
    await s1;
    expect(S().dirty).toBe(false);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_AFTER_SAVE_MS * 2);
    expect(autosaves).toHaveLength(0);
    // Edit during a save, then a second save writes it before the follow-up is due.
    S().renameProject('B');
    const s2 = saveProject();
    await untilCommits(2);
    S().renameProject('C');
    await pending[1].resolve();
    await s2;
    expect(S().dirty).toBe(true);
    const s3 = saveProject();
    await untilCommits(3);
    await pending[2].resolve();
    await s3;
    expect(S().dirty).toBe(false);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_AFTER_SAVE_MS * 2);
    await tick();
    expect(autosaves).toHaveLength(0);
  });

  it('waits for playback to stop before autosaving', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    api();
    useStore.setState({ projectPath: projectFile() });
    S().renameProject('A');
    const s1 = saveProject();
    await untilCommits(1);
    S().renameProject('B');
    useStore.setState({ playback: { playing: true, rate: 1 } });
    await pending[0].resolve();
    await s1;
    await vi.advanceTimersByTimeAsync(AUTOSAVE_AFTER_SAVE_MS * 3);
    await tick();
    expect(autosaves).toHaveLength(0);
    useStore.setState({ playback: { playing: false, rate: 1 } });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_AFTER_SAVE_MS);
    await tick();
    expect(autosaves).toHaveLength(1);
    expect(nameIn(autosaves[0])).toBe('B');
  });
});

it('serializeProject is untouched by the compact path (the manual save layout)', async () => {
  const p = bigProject();
  expect(await serializeProjectSliced(p)).toBe(serializeProject(p));
});
