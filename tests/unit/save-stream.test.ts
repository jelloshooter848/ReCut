/**
 * Streamed manual save (roadmap §1, C2): the renderer sends the project file text to main in pieces while it
 * serializes (shared/projectWire.ts ProjectSaveStreamApi, src/state/mediaActions.ts saveStreamed), and main
 * appends them to a temp file that only the commit turns into the project file (electron/project/io.ts
 * ProjectFileWriter). Covers:
 *  - the file is byte-identical to the one-string save (serializeProject), also with non-ASCII text, and it
 *    opens again; pieces are cut between records;
 *  - crash safety: the target is untouched until the commit; a failed, incomplete, malformed or aborted save
 *    leaves the target as it was and no temp file; the .bak holds the previous version;
 *  - the .bak is a hard link where possible, a copy where links are refused, and a .bak that already is a link to
 *    the target leaves no temp name behind;
 *  - the save-race rules (bugs/closed/2026-10-06-edits-during-save-marked-saved.md) hold on the streamed path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProject, serializeProject } from '../../shared/project';
import type { Project } from '../../shared/model';
import type { SaveResult } from '../../shared/ipc';
import { canStreamSave, type ProjectSaveStreamApi } from '../../shared/projectWire';
import { loadProjectFile, ProjectFileWriter, saveProjectJson } from '../../electron/project/io';
import { useStore, resetStore } from '../../src/state/store';
import { saveProject } from '../../src/state/mediaActions';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const g = globalThis as Any;
const S = () => useStore.getState();

let tmp: string;
beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'recut-stream-'));
  resetStore();
  g.window = globalThis;
});
afterEach(async () => {
  vi.restoreAllMocks();
  delete g.recut;
  delete g.window;
  await fsp.rm(tmp, { recursive: true, force: true });
});

const leftovers = async (dir = tmp) => (await fsp.readdir(dir)).filter((n) => n.includes('.tmp-'));

/** A project whose file text is a few MB (several pieces), with non-ASCII and escaped text in its records. */
function bigProject(name = 'Big é 日本 🎬'): Project {
  const p = createProject(name);
  const seq = p.sequences[p.activeSequenceId!];
  seq.markers = Array.from({ length: 30_000 }, (_, i) => ({
    id: `m${i}`, time: i, duration: 0, name: i % 7 ? `marker ${i}` : `ü "q" \\ \n 🎞 ${i} \ud800`, note: 'x'.repeat(40), color: '#fff', kind: 'marker' as const,
  }));
  return p;
}

/** window.recut streaming into a real ProjectFileWriter (what preload + electron/ipc.ts do, minus the IPC). */
function realStreamApi(log: { pieces: string[]; calls: string[] }) {
  const writers = new Map<string, ProjectFileWriter>();
  let n = 0;
  const api: ProjectSaveStreamApi = {
    saveProjectBegin: async (p) => {
      log.calls.push('begin');
      try { const w = await ProjectFileWriter.open(p); const id = `s${n++}`; writers.set(id, w); return { ok: true, id }; } catch (e) { return { ok: false, error: String(e) }; }
    },
    saveProjectChunk: (id, seq, text) => { log.pieces.push(text); writers.get(id)?.append(seq, text); },
    saveProjectCommit: async (id, totals) => { log.calls.push('commit'); const w = writers.get(id)!; writers.delete(id); return w.commit(totals); },
    saveProjectAbort: async (id) => { log.calls.push('abort'); await writers.get(id)?.abort(); writers.delete(id); },
  };
  return api;
}

describe('streamed save: renderer -> main -> disk', () => {
  it('writes exactly the bytes of the one-string save, in several pieces cut between records, and opens again', async () => {
    const log = { pieces: [] as string[], calls: [] as string[] };
    g.recut = realStreamApi(log);
    expect(canStreamSave(g.recut)).toBe(true);
    useStore.setState({ project: bigProject(), dirty: true });
    const file = path.join(tmp, 'big.recut');
    const res = await saveProject(file);
    expect(res).toEqual({ ok: true, path: file });
    const bytes = await fsp.readFile(file);
    const modifiedAt = JSON.parse(bytes.toString('utf8')).modifiedAt;
    expect(modifiedAt).toBeGreaterThan(0);
    const expected = serializeProject({ ...S().project, modifiedAt });
    expect(bytes.equals(Buffer.from(expected, 'utf8'))).toBe(true);
    expect(log.pieces.length).toBeGreaterThan(2);
    expect(log.pieces.join('')).toBe(expected);
    for (const piece of log.pieces) expect(Buffer.from(piece, 'utf8').toString('utf8')).toBe(piece); // no split surrogate pairs
    // the same text through the one-string path gives the same file
    const other = path.join(tmp, 'one.recut');
    await saveProjectJson(other, expected);
    expect((await fsp.readFile(other)).equals(bytes)).toBe(true);
    expect(S().dirty).toBe(false);
    expect(S().projectPath).toBe(file);
    const loaded = await loadProjectFile(file);
    expect(loaded.ok && loaded.project.sequences[loaded.project.activeSequenceId!].markers.length).toBe(30_000);
    expect(await leftovers()).toEqual([]);
  });

  it('a refused begin (the folder is a file) is reported, sends nothing and leaves the project dirty', async () => {
    const log = { pieces: [] as string[], calls: [] as string[] };
    g.recut = realStreamApi(log);
    useStore.setState({ dirty: true });
    await fsp.writeFile(path.join(tmp, 'plain'), 'x');
    const res = await saveProject(path.join(tmp, 'plain', 'x.recut'));
    expect(res.ok).toBe(false);
    expect(log.pieces).toEqual([]);
    expect(log.calls).toEqual(['begin']);
    expect(S().dirty).toBe(true);
  });

  it('a serialization failure aborts the save: no file, no temp file, the error is thrown', async () => {
    const log = { pieces: [] as string[], calls: [] as string[] };
    g.recut = realStreamApi(log);
    const p = bigProject() as Any;
    p.settings.bad = 1n; // JSON.stringify throws on a BigInt (written last: pieces were already sent)
    useStore.setState({ project: p, dirty: true });
    const file = path.join(tmp, 'bad.recut');
    await expect(saveProject(file)).rejects.toThrow(/BigInt/);
    expect(log.calls).toEqual(['begin', 'abort']);
    expect(log.pieces.length).toBeGreaterThan(0);
    expect(fs.existsSync(file)).toBe(false);
    expect(await leftovers()).toEqual([]);
    expect(S().dirty).toBe(true);
  });

  it('a failure before the first piece was sent still drops the temp file main opened', async () => {
    const log = { pieces: [] as string[], calls: [] as string[] };
    g.recut = realStreamApi(log);
    const p = createProject('small') as Any;
    p.settings.bad = 1n;
    useStore.setState({ project: p, dirty: true });
    await expect(saveProject(path.join(tmp, 'small.recut'))).rejects.toThrow(/BigInt/);
    expect(log.pieces).toEqual([]);
    expect(log.calls).toEqual(['begin', 'abort']);
    expect(await leftovers()).toEqual([]);
  });
});

describe('ProjectFileWriter (main)', () => {
  const textOf = (name: string) => serializeProject(createProject(name));
  const pieces = (t: string) => [t.slice(0, 10), t.slice(10, 50), t.slice(50)];
  async function save(file: string, text: string): Promise<SaveResult> {
    const w = await ProjectFileWriter.open(file);
    pieces(text).forEach((p, i) => w.append(i, p));
    return w.commit({ chunks: 3, chars: text.length });
  }

  it('leaves the target untouched until the commit, then replaces it and keeps the previous file as .bak', async () => {
    const file = path.join(tmp, 'p.recut');
    const v1 = textOf('v1'); const v2 = textOf('v2');
    expect(await save(path.join(tmp, 'p'), v1)).toEqual({ ok: true, path: file }); // .recut appended
    const w = await ProjectFileWriter.open(file);
    pieces(v2).forEach((p, i) => w.append(i, p));
    await new Promise((r) => setTimeout(r, 20));
    expect(await fsp.readFile(file, 'utf8')).toBe(v1);
    expect(await leftovers()).toHaveLength(1);
    expect(w.projectId()).toBe(JSON.parse(v2).id);
    expect(await w.commit({ chunks: 3, chars: v2.length })).toEqual({ ok: true, path: file });
    expect(await fsp.readFile(file, 'utf8')).toBe(v2);
    expect(await fsp.readFile(file + '.bak', 'utf8')).toBe(v1);
    expect(await leftovers()).toEqual([]);
    w.append(3, 'late'); // ignored after the commit
    expect(await fsp.readFile(file, 'utf8')).toBe(v2);
    expect((await w.commit({ chunks: 3, chars: v2.length })).ok).toBe(false);
  });

  it('waits for pieces the commit overtook', async () => {
    const file = path.join(tmp, 'late.recut');
    const t = textOf('late');
    const w = await ProjectFileWriter.open(file);
    w.append(0, t.slice(0, 20));
    const done = w.commit({ chunks: 2, chars: t.length });
    setTimeout(() => w.append(1, t.slice(20)), 30);
    expect((await done).ok).toBe(true);
    expect(await fsp.readFile(file, 'utf8')).toBe(t);
  });

  for (const [label, feed, totals] of [
    ['a piece out of order', (w: ProjectFileWriter, t: string) => { w.append(0, t.slice(0, 10)); w.append(2, t.slice(10)); }, (t: string) => ({ chunks: 2, chars: t.length })],
    ['a piece that is not text', (w: ProjectFileWriter, t: string) => { w.append(0, t); w.append(1, 42 as unknown as string); }, (t: string) => ({ chunks: 2, chars: t.length + 2 })],
    ['fewer characters than the renderer sent', (w: ProjectFileWriter, t: string) => { w.append(0, t.slice(0, -1)); }, (t: string) => ({ chunks: 1, chars: t.length })],
    ['text that is not a JSON object', (w: ProjectFileWriter) => { w.append(0, '[1'); w.append(1, ']'); }, () => ({ chunks: 2, chars: 3 })],
  ] as const) {
    it(`${label}: the commit fails, the target and its .bak stay as they were, no temp file`, async () => {
      const file = path.join(tmp, 'keep.recut');
      const v1 = textOf('v1'); const v2 = textOf('v2');
      await save(file, v1);
      await save(file, v2);
      const t = textOf('v3');
      const w = await ProjectFileWriter.open(file);
      feed(w, t);
      const res = await w.commit(totals(t));
      expect(res.ok).toBe(false);
      expect(!res.ok && res.error).toMatch(/^Could not save project: /);
      expect(await fsp.readFile(file, 'utf8')).toBe(v2);
      expect(await fsp.readFile(file + '.bak', 'utf8')).toBe(v1);
      expect(await leftovers()).toEqual([]);
    });
  }

  it('a second commit is refused; an abort while the commit waits for pieces cancels it', async () => {
    const file = path.join(tmp, 'twice.recut');
    const t = textOf('t');
    const w = await ProjectFileWriter.open(file);
    w.append(0, t.slice(0, 5));
    const waiting = w.commit({ chunks: 2, chars: t.length });
    expect((await w.commit({ chunks: 2, chars: t.length })).ok).toBe(false);
    await w.abort();
    const res = await waiting;
    expect(!res.ok && res.error).toMatch(/cancelled/);
    expect(fs.existsSync(file)).toBe(false);
    expect(await leftovers()).toEqual([]);
  });

  it('abort removes the temp file and leaves the target alone', async () => {
    const file = path.join(tmp, 'a.recut');
    const v1 = textOf('v1');
    await save(file, v1);
    const w = await ProjectFileWriter.open(file);
    w.append(0, textOf('v2'));
    await w.abort();
    expect(await fsp.readFile(file, 'utf8')).toBe(v1);
    expect(await leftovers()).toEqual([]);
    expect((await w.commit({ chunks: 1, chars: 1 })).ok).toBe(false);
  });

  it('a failing disk write fails the commit and leaves no temp file', async () => {
    const file = path.join(tmp, 'eio.recut');
    const v1 = textOf('v1');
    await save(file, v1);
    const realOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, 'open').mockImplementationOnce(async (...args: Parameters<typeof fsp.open>) => {
      const fh = await realOpen(...args);
      let writes = 0;
      const realWrite = fh.write.bind(fh) as (...a: unknown[]) => Promise<{ bytesWritten: number }>;
      Object.assign(fh, { write: async (...a: unknown[]) => { if (writes++ >= 1) throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' }); return realWrite(...a); } });
      return fh;
    });
    const t = textOf('v2');
    const w = await ProjectFileWriter.open(file);
    pieces(t).forEach((p, i) => w.append(i, p));
    const res = await w.commit({ chunks: 3, chars: t.length });
    expect(!res.ok && res.error).toMatch(/EIO/);
    expect(await fsp.readFile(file, 'utf8')).toBe(v1);
    expect(await leftovers()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('saves through a symlinked .recut to its real file, the .bak beside the link', async () => {
    const realDir = path.join(tmp, 'real');
    await fsp.mkdir(realDir);
    const real = path.join(realDir, 'project.recut');
    const v1 = textOf('v1');
    await save(real, v1);
    const link = path.join(tmp, 'link.recut');
    await fsp.symlink(real, link);
    expect((await save(link, textOf('v2'))).ok).toBe(true);
    expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await fsp.readFile(real, 'utf8')).name).toBe('v2');
    expect(await fsp.readFile(link + '.bak', 'utf8')).toBe(v1);
    expect(await leftovers(realDir)).toEqual([]);
  });
});

describe('.bak without a copy', () => {
  it('is a hard link to the previous version where the filesystem allows it, and never shares the new file', async () => {
    const file = path.join(tmp, 'h.recut');
    const v1 = serializeProject(createProject('v1'));
    await saveProjectJson(file, v1);
    const before = await fsp.stat(file);
    const link = vi.spyOn(fsp, 'link');
    const copy = vi.spyOn(fsp, 'copyFile');
    await saveProjectJson(file, serializeProject(createProject('v2')));
    expect(link).toHaveBeenCalledTimes(1);
    expect(copy).not.toHaveBeenCalled();
    const bak = await fsp.stat(file + '.bak');
    expect(bak.ino).toBe(before.ino); // the old file itself, not a copy
    expect(bak.ino).not.toBe((await fsp.stat(file)).ino);
    expect(bak.mtimeMs).toBe(before.mtimeMs); // the backup's date is when that version was saved
    expect(await fsp.readFile(file + '.bak', 'utf8')).toBe(v1);
    // damaging the project file in place later never reaches the backup
    await fsp.writeFile(file, 'garbage');
    expect(await fsp.readFile(file + '.bak', 'utf8')).toBe(v1);
    expect(await leftovers()).toEqual([]);
  });

  it('is a copy where hard links are refused', async () => {
    const file = path.join(tmp, 'c.recut');
    const v1 = serializeProject(createProject('v1'));
    await saveProjectJson(file, v1);
    vi.spyOn(fsp, 'link').mockRejectedValue(Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' }));
    const copy = vi.spyOn(fsp, 'copyFile');
    expect((await saveProjectJson(file, serializeProject(createProject('v2')))).ok).toBe(true);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(await fsp.readFile(file + '.bak', 'utf8')).toBe(v1);
    expect(JSON.parse(await fsp.readFile(file, 'utf8')).name).toBe('v2');
    expect(await leftovers()).toEqual([]);
  });

  it('a .bak that already is a link to the project file (an interrupted save) leaves no temp name behind', async () => {
    const file = path.join(tmp, 'i.recut');
    const v1 = serializeProject(createProject('v1'));
    await saveProjectJson(file, v1);
    await fsp.link(file, file + '.bak');
    expect((await saveProjectJson(file, serializeProject(createProject('v2')))).ok).toBe(true);
    expect(await fsp.readFile(file + '.bak', 'utf8')).toBe(v1);
    expect(JSON.parse(await fsp.readFile(file, 'utf8')).name).toBe('v2');
    expect(await leftovers()).toEqual([]);
  });
});

describe('save race rules on the streamed path', () => {
  interface Pending { id: string; text: string[]; resolve: () => void }
  let pending: Pending[];
  let disk: string | null;
  let calls: string[];
  /** A streaming bridge whose commits land only when the test says so. */
  function delayedStreamApi() {
    let n = 0;
    const open = new Map<string, string[]>();
    const api: ProjectSaveStreamApi = {
      saveProjectBegin: async () => { const id = `s${n++}`; calls.push(`begin ${id}`); open.set(id, []); return { ok: true, id }; },
      saveProjectChunk: (id, _seq, text) => { open.get(id)!.push(text); },
      saveProjectCommit: (id) => new Promise((r) => {
        calls.push(`commit ${id}`);
        const text = open.get(id)!;
        pending.push({ id, text, resolve: () => { disk = text.join(''); r({ ok: true, path: '/p/x.recut' }); } });
      }),
      saveProjectAbort: async () => undefined,
    };
    g.recut = api;
  }
  const untilCommits = async (k: number) => { for (let i = 0; i < 200 && pending.length < k; i++) await new Promise((r) => setTimeout(r, 0)); };
  const nameIn = (t: string | null) => (t ? JSON.parse(t).name : null);
  beforeEach(() => { pending = []; disk = null; calls = []; });

  it('an edit while the save is in flight keeps the project dirty; the next save writes it', async () => {
    delayedStreamApi();
    S().renameProject('A');
    const first = saveProject('/p/x.recut');
    await untilCommits(1);
    S().renameProject('B');
    pending[0].resolve();
    expect((await first).ok).toBe(true);
    expect(nameIn(disk)).toBe('A');
    expect(S().dirty).toBe(true);
    const second = saveProject();
    await untilCommits(2);
    pending[1].resolve();
    await second;
    expect(nameIn(disk)).toBe('B');
    expect(S().dirty).toBe(false);
  });

  it('a second save starts only after the first one committed (saves never interleave)', async () => {
    delayedStreamApi();
    S().renameProject('A');
    const p1 = saveProject('/p/x.recut');
    S().renameProject('B');
    const p2 = saveProject('/p/x.recut');
    await untilCommits(1);
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['begin s0', 'commit s0']);
    pending[0].resolve();
    await untilCommits(2);
    expect(calls).toEqual(['begin s0', 'commit s0', 'begin s1', 'commit s1']);
    pending[1].resolve();
    await Promise.all([p1, p2]);
    expect(nameIn(disk)).toBe('B');
    expect(S().dirty).toBe(false);
  });
});
