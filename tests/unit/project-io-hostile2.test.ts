/**
 * Critic round A/B, file side:
 *  - B2: a load that had to repair data keeps the original file as `<path>.pre-repair-<ts>` and says so
 *    (LoadResult.repaired / preRepairPath); recovery reads never create copies;
 *  - B4: a project with very deep unknown nesting opens and can be cloned across IPC;
 *  - B10: formatVersion must be a positive integer; a refused `{}` file mentions an existing .bak;
 *  - A6: a symlink planted at `<project>.bak` is replaced, never written through; a symlinked .recut is saved
 *    through to its real file (the link stays a link);
 *  - A7: discardRecovery only deletes autosaves offered by checkRecovery; autosave writes need a project path;
 *  - atomicWriteFileSync (prefs on window close) writes via temp + rename.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProject } from '../../shared/project';
import {
  saveProjectFile, loadProjectFile, writeAutosave, writeAutosaveJson, checkRecovery, discardRecovery, atomicWriteFileSync,
  serializeAutosave,
} from '../../electron/project/io';
import * as TL from '../../shared/timeline';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const rt = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const seqOf = (p: Any) => p.sequences[p.activeSequenceId];
const clip = (id: string, start: number, duration: number, extra: Any = {}) => ({ id, mediaId: 'm1', name: id, start, duration, sourceIn: 0, speed: 1, ...extra });

let tmp: string;
let userData: string;
beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'recut-io2-'));
  userData = path.join(tmp, 'userData');
  await fsp.mkdir(userData, { recursive: true });
});
afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });

const listing = async (dir = tmp) => (await fsp.readdir(dir)).sort();
const preRepairCopies = async (dir = tmp) => (await fsp.readdir(dir)).filter((f) => f.includes('.pre-repair-'));

function damagedButRepairable(): string {
  const p = rt(createProject('repairable')) as Any;
  seqOf(p).videoTracks[0].clips = [clip('good', 0, 10), clip('nanIn', 10, 10, { sourceIn: null }), clip('frac', 20, 0.5), clip('neg', -1, 10)];
  return JSON.stringify(p);
}

describe('B2: repaired loads are reported and the original is kept', () => {
  it('copies the original to <path>.pre-repair-<ts>, reports the repairs, and the copy survives two saves', async () => {
    const f = path.join(tmp, 'r.recut');
    const text = damagedButRepairable();
    await fsp.writeFile(f, text);
    const r = await loadProjectFile(f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(seqOf(r.project).videoTracks[0].clips.map((c: Any) => c.id)).toEqual(['good']);
    expect(r.repaired?.length).toBeGreaterThan(0);
    expect(r.repaired!.join('\n')).toMatch(/clip/i);
    expect(r.preRepairPath).toBeDefined();
    expect(path.dirname(r.preRepairPath!)).toBe(tmp);
    expect(path.basename(r.preRepairPath!)).toMatch(/^r\.recut\.pre-repair-\d+$/);
    expect(await fsp.readFile(r.preRepairPath!, 'utf8')).toBe(text);
    expect(await fsp.readFile(f, 'utf8')).toBe(text); // loading never rewrites the project
    await saveProjectFile(f, r.project);
    await saveProjectFile(f, r.project);
    expect(await fsp.readFile(r.preRepairPath!, 'utf8')).toBe(text);
  });

  it('a clean load reports nothing and makes no copy', async () => {
    const f = path.join(tmp, 'clean.recut');
    await saveProjectFile(f, createProject('clean'));
    const r = await loadProjectFile(f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.repaired).toBeUndefined();
    expect(r.preRepairPath).toBeUndefined();
    expect(await preRepairCopies()).toEqual([]);
  });

  it('a .bak that itself needed repairs is reported, and its original kept too', async () => {
    const f = path.join(tmp, 'b.recut');
    const bakText = damagedButRepairable();
    await fsp.writeFile(f, '{ not json');
    await fsp.writeFile(f + '.bak', bakText);
    const r = await loadProjectFile(f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fromBackup).toBe(true);
    expect(r.repaired?.length).toBeGreaterThan(0);
    expect(path.basename(r.preRepairPath!)).toMatch(/^b\.recut\.bak\.pre-repair-\d+$/);
    expect(await fsp.readFile(r.preRepairPath!, 'utf8')).toBe(bakText);
  });

  it('recovery reads of a repairable autosave never create copies', async () => {
    const f = path.join(tmp, 'auto.recut');
    const res = await writeAutosaveJson(f, damagedButRepairable(), userData);
    expect(res.ok).toBe(true);
    for (let i = 0; i < 3; i++) {
      const rec = await checkRecovery(userData, [f]);
      expect(seqOf(rec!.project).videoTracks[0].clips.map((c: Any) => c.id)).toEqual(['good']);
    }
    expect(await preRepairCopies()).toEqual([]);
  });
});

describe('B3 end to end: overlap -> trimStart -> save -> reload keeps every clip', () => {
  it('no clip is lost', async () => {
    const f = path.join(tmp, 'o.recut');
    const p = rt(createProject('x')) as Any;
    seqOf(p).videoTracks[0].clips = [clip('A', 0, 100), clip('B', 50, 10)];
    await fsp.writeFile(f, JSON.stringify(p));
    const r1 = await loadProjectFile(f) as Any;
    TL.trimStart(seqOf(r1.project), 'B', 55, () => 1000);
    await saveProjectFile(f, r1.project);
    const r2 = await loadProjectFile(f) as Any;
    expect(TL.allTracks(seqOf(r2.project)).flatMap((t) => t.clips.map((c) => c.id)).sort()).toEqual(['A', 'B']);
    expect(r2.repaired).toBeUndefined();
  });
});

describe('B4: deep unknown nesting', () => {
  it('a project with a 6000-deep unknown field opens, clones for IPC, and autosaves', async () => {
    const f = path.join(tmp, 'deep.recut');
    const json = JSON.stringify(rt(createProject('deep'))).replace(/^\{/, `{"extra":${'['.repeat(6000)}${']'.repeat(6000)},`);
    await fsp.writeFile(f, json);
    const r = await loadProjectFile(f);
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    expect(() => structuredClone(r)).not.toThrow();
    expect(() => serializeAutosave(r.project)).not.toThrow();
    expect(r.repaired?.join('\n')).toMatch(/nested/);
  });

  it('recovery of a deep autosave yields a cloneable project', async () => {
    const json = JSON.stringify(rt(createProject('deep'))).replace(/^\{/, `{"extra":${'['.repeat(6000)}${']'.repeat(6000)},`);
    const w = await writeAutosaveJson(null, json, userData);
    expect(w.ok).toBe(true);
    const rec = await checkRecovery(userData, []);
    expect(rec?.project.name).toBe('deep');
    expect(() => structuredClone(rec)).not.toThrow();
  });
});

describe('B10: formatVersion and refused files with a backup', () => {
  for (const fv of [0, -1, 0.5]) {
    it(`formatVersion ${fv} is refused as not a ReCut project (the .bak is not used)`, async () => {
      const f = path.join(tmp, 'fv.recut');
      await saveProjectFile(f, createProject('bak'));
      const p = rt(createProject('x')) as Any; p.formatVersion = fv;
      await fsp.writeFile(f, JSON.stringify(p));
      const r = await loadProjectFile(f);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/not a ReCut project/);
    });
  }

  it('a root {} file is refused; the error names the existing backup', async () => {
    const f = path.join(tmp, 'e.recut');
    await saveProjectFile(f, createProject('bak'));
    await saveProjectFile(f, createProject('main'));
    await fsp.writeFile(f, '{}');
    const r = await loadProjectFile(f);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/not a ReCut project/);
      expect(r.error).toContain(f + '.bak');
    }
    expect(await fsp.readFile(f, 'utf8')).toBe('{}');
  });

  it('without a backup the refusal does not mention one', async () => {
    const f = path.join(tmp, 'solo.recut');
    await fsp.writeFile(f, '{}');
    const r = await loadProjectFile(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toMatch(/backup/i);
  });
});

// Symlinks need privileges on Windows; that is the only reason these may be skipped.
const canSymlink = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-ln-'));
  try { fs.symlinkSync(path.join(d, 'x'), path.join(d, 'y')); return true; } catch { return false; } finally { fs.rmSync(d, { recursive: true, force: true }); }
})();

describe('A6: symlinks next to the project', () => {
  it.skipIf(!canSymlink)('a symlink planted at <project>.bak is replaced by the backup, its target is untouched', async () => {
    const f = path.join(tmp, 's.recut');
    const victim = path.join(tmp, 'victim.txt');
    await fsp.writeFile(victim, 'precious');
    await saveProjectFile(f, createProject('first'));
    const firstText = await fsp.readFile(f, 'utf8');
    await fsp.symlink(victim, f + '.bak');
    const r = await saveProjectFile(f, createProject('second'));
    expect(r.ok).toBe(true);
    expect(await fsp.readFile(victim, 'utf8')).toBe('precious');
    expect((await fsp.lstat(f + '.bak')).isSymbolicLink()).toBe(false);
    expect(await fsp.readFile(f + '.bak', 'utf8')).toBe(firstText);
    expect((await listing()).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it.skipIf(!canSymlink)('a symlinked .recut is saved through to its real file; the link stays a link', async () => {
    const realDir = path.join(tmp, 'real');
    await fsp.mkdir(realDir);
    const real = path.join(realDir, 'project.recut');
    await saveProjectFile(real, createProject('v1'));
    const v1 = await fsp.readFile(real, 'utf8');
    const link = path.join(tmp, 'link.recut');
    await fsp.symlink(real, link);
    const r = await saveProjectFile(link, createProject('v2'));
    expect(r.ok).toBe(true);
    expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await fsp.readFile(real, 'utf8')).name).toBe('v2');
    // the backup sits where the loader looks for it: next to the path that was opened
    expect(await fsp.readFile(link + '.bak', 'utf8')).toBe(v1);
    const loaded = await loadProjectFile(link);
    expect(loaded.ok && loaded.project.name).toBe('v2');
    expect((await listing(realDir)).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it.skipIf(!canSymlink)('an autosave path that is a symlink is replaced, never written through', async () => {
    const f = path.join(tmp, 'a.recut');
    const victim = path.join(tmp, 'victim.txt');
    await fsp.writeFile(victim, 'precious');
    await fsp.symlink(victim, f + '.autosave');
    const r = await writeAutosave(f, createProject('auto'), userData);
    expect(r.ok).toBe(true);
    expect(await fsp.readFile(victim, 'utf8')).toBe('precious');
    expect((await fsp.lstat(f + '.autosave')).isSymbolicLink()).toBe(false);
  });
});

describe('A7: recovery / autosave paths from the renderer are checked', () => {
  it('discardRecovery refuses an autosave that checkRecovery did not offer', async () => {
    const other = path.join(tmp, 'someone-else.recut.autosave');
    await fsp.writeFile(other, 'keep');
    await expect(discardRecovery(other)).rejects.toThrow();
    expect(await fsp.readFile(other, 'utf8')).toBe('keep');
  });

  it('discardRecovery deletes the autosave checkRecovery offered (once)', async () => {
    const f = path.join(tmp, 'gone.recut');
    await writeAutosave(f, createProject('Orphan'), userData);
    const rec = await checkRecovery(userData, [f]);
    expect(rec).not.toBeNull();
    await discardRecovery(rec!.autosavePath);
    expect(fs.existsSync(f + '.autosave')).toBe(false);
    await fsp.writeFile(f + '.autosave', 'new'); // a later autosave at the same path is not covered by the old offer
    await expect(discardRecovery(rec!.autosavePath)).rejects.toThrow();
    expect(fs.existsSync(f + '.autosave')).toBe(true);
  });

  it('autosave writes require a .recut project path (or none, for the untitled autosave)', async () => {
    const notProject = path.join(tmp, 'notes.txt');
    const a = await writeAutosave(notProject, createProject('x'), userData);
    const b = await writeAutosaveJson(notProject, JSON.stringify(createProject('x')), userData);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(fs.existsSync(notProject + '.autosave')).toBe(false);
    const ok = await writeAutosaveJson(null, JSON.stringify(createProject('x')), userData);
    expect(ok.ok).toBe(true);
  });
});

describe('atomicWriteFileSync (prefs on window close)', () => {
  it('writes the content, creates the folder, leaves no temp file, and replaces a symlink instead of following it', async () => {
    const target = path.join(tmp, 'ud', 'prefs.json');
    atomicWriteFileSync(target, '{"a":1}');
    expect(await fsp.readFile(target, 'utf8')).toBe('{"a":1}');
    atomicWriteFileSync(target, '{"a":2}');
    expect(await fsp.readFile(target, 'utf8')).toBe('{"a":2}');
    expect((await listing(path.dirname(target))).filter((n) => n.includes('.tmp-'))).toEqual([]);
    if (canSymlink) {
      const victim = path.join(tmp, 'victim.json');
      await fsp.writeFile(victim, 'precious');
      await fsp.rm(target);
      await fsp.symlink(victim, target);
      atomicWriteFileSync(target, '{"a":3}');
      expect(await fsp.readFile(victim, 'utf8')).toBe('precious');
      expect(await fsp.readFile(target, 'utf8')).toBe('{"a":3}');
    }
  });
});
