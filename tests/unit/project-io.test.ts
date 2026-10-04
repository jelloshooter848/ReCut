import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProject } from '../../shared/project';
import {
  saveProjectFile, loadProjectFile, writeAutosave, checkRecovery, discardRecovery, autosavePathFor,
  untitledAutosavePath, clearUntitledAutosaveFor, defaultPrefs, readPrefs, updatePrefs, addRecentProject,
  pushRecent, MAX_RECENT, atomicWriteFile, ensureProjectExt, projectPathForAutosave, serializeAutosave, writeAutosaveJson,
} from '../../electron/project/io';
import { ensureDirSafe } from '../../electron/safeMkdir';
import { projectPathFromArgv } from '../../electron/project/argv';
import { PROJECT_FORMAT_VERSION } from '../../shared/model';
import { parseRange, contentTypeFor, mediaUrlPath } from '../../electron/media/range';

let tmp: string;
let userData: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'recut-io-'));
  userData = path.join(tmp, 'userData');
  await fsp.mkdir(userData, { recursive: true });
});
afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

const touch = (p: string, ms: number) => fsp.utimes(p, new Date(ms), new Date(ms));

describe('project save/load', () => {
  it('round-trips a project through an atomic save and appends .recut', async () => {
    const project = createProject('Roundtrip');
    const target = path.join(tmp, 'my-edit');
    const saved = await saveProjectFile(target, project);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.path).toBe(path.join(tmp, 'my-edit.recut'));
    expect(fs.existsSync(saved.path)).toBe(true);
    // no temp files left behind
    const leftovers = (await fsp.readdir(tmp)).filter((n) => n.includes('.tmp-'));
    expect(leftovers).toEqual([]);

    const loaded = await loadProjectFile(saved.path);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.project.id).toBe(project.id);
    expect(loaded.project.name).toBe('Roundtrip');
    expect(loaded.project.sequenceOrder).toEqual(project.sequenceOrder);
    expect(Object.keys(loaded.project.sequences)).toEqual(Object.keys(project.sequences));
  });

  it('keeps one .bak of the previous file and overwrites atomically', async () => {
    const p1 = createProject('v1');
    const file = path.join(tmp, 'proj.recut');
    await saveProjectFile(file, p1);
    const p2 = { ...p1, name: 'v2' };
    await saveProjectFile(file, p2);
    const bak = JSON.parse(await fsp.readFile(file + '.bak', 'utf8'));
    const cur = JSON.parse(await fsp.readFile(file, 'utf8'));
    expect(bak.name).toBe('v1');
    expect(cur.name).toBe('v2');
    const p3 = { ...p1, name: 'v3' };
    await saveProjectFile(file, p3);
    expect(JSON.parse(await fsp.readFile(file + '.bak', 'utf8')).name).toBe('v2');
  });

  it('falls back to the .bak when the main file is corrupt', async () => {
    const file = path.join(tmp, 'proj.recut');
    await saveProjectFile(file, createProject('good'));
    await saveProjectFile(file, createProject('newer'));
    await fsp.writeFile(file, '{ this is not json');
    const loaded = await loadProjectFile(file);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.project.name).toBe('good');
  });

  it('reports missing files and non-project JSON as errors', async () => {
    const missing = await loadProjectFile(path.join(tmp, 'nope.recut'));
    expect(missing.ok).toBe(false);
    const junk = path.join(tmp, 'junk.recut');
    await fsp.writeFile(junk, JSON.stringify({ hello: 'world' }));
    const r = await loadProjectFile(junk);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/formatVersion/);
  });

  it('atomicWriteFile creates parent directories', async () => {
    const target = path.join(tmp, 'a', 'b', 'c.json');
    await atomicWriteFile(target, '{}');
    expect(await fsp.readFile(target, 'utf8')).toBe('{}');
  });

  it('ensureProjectExt is idempotent and case-insensitive', () => {
    expect(ensureProjectExt('/x/y')).toBe('/x/y.recut');
    expect(ensureProjectExt('/x/y.recut')).toBe('/x/y.recut');
    expect(ensureProjectExt('/x/y.RECUT')).toBe('/x/y.RECUT');
  });
});

describe('autosave & recovery', () => {
  it('computes autosave locations', () => {
    expect(autosavePathFor('/p/a.recut', userData)).toBe('/p/a.recut.autosave');
    expect(autosavePathFor(null, userData)).toBe(path.join(userData, 'autosave', 'untitled.recut.autosave'));
    expect(projectPathForAutosave('/p/a.recut.autosave', userData)).toBe('/p/a.recut');
    expect(projectPathForAutosave(untitledAutosavePath(userData), userData)).toBeNull();
  });

  it('finds nothing when there is no autosave', async () => {
    expect(await checkRecovery(userData, [])).toBeNull();
  });

  it('offers an untitled autosave for recovery and discards it', async () => {
    const project = createProject('Unsaved work');
    const r = await writeAutosave(null, project, userData);
    expect(r.ok).toBe(true);
    const rec = await checkRecovery(userData, []);
    expect(rec).not.toBeNull();
    expect(rec!.projectPath).toBeNull();
    expect(rec!.autosavePath).toBe(untitledAutosavePath(userData));
    expect(rec!.project.name).toBe('Unsaved work');
    expect(rec!.savedAt).toBeGreaterThan(0);
    await discardRecovery(rec!.autosavePath);
    expect(await checkRecovery(userData, [])).toBeNull();
  });

  it('offers a project autosave only when it is newer than the project file', async () => {
    const file = path.join(tmp, 'edit.recut');
    const project = createProject('Saved');
    await saveProjectFile(file, project);
    const auto = await writeAutosave(file, { ...project, name: 'Autosaved later' }, userData);
    expect(auto.ok).toBe(true);
    // autosave older than project → nothing to recover
    await touch(file, Date.now());
    await touch(file + '.autosave', Date.now() - 60_000);
    expect(await checkRecovery(userData, [file])).toBeNull();
    // autosave newer than project → recovery
    await touch(file + '.autosave', Date.now() + 5_000);
    const rec = await checkRecovery(userData, [file]);
    expect(rec).not.toBeNull();
    expect(rec!.projectPath).toBe(file);
    expect(rec!.project.name).toBe('Autosaved later');
  });

  it('offers an autosave whose project file has gone missing', async () => {
    const file = path.join(tmp, 'gone.recut');
    await writeAutosave(file, createProject('Orphan'), userData);
    const rec = await checkRecovery(userData, [file]);
    expect(rec?.project.name).toBe('Orphan');
  });

  it('picks the newest candidate', async () => {
    const a = path.join(tmp, 'a.recut');
    const b = path.join(tmp, 'b.recut');
    await writeAutosave(a, createProject('A'), userData);
    await writeAutosave(b, createProject('B'), userData);
    await touch(a + '.autosave', Date.now() - 10_000);
    await touch(b + '.autosave', Date.now());
    const rec = await checkRecovery(userData, [a, b]);
    expect(rec?.project.name).toBe('B');
  });

  it('refuses to discard non-autosave files', async () => {
    const file = path.join(tmp, 'keep.recut');
    await saveProjectFile(file, createProject('keep'));
    await expect(discardRecovery(file)).rejects.toThrow();
    expect(fs.existsSync(file)).toBe(true);
  });

  it('clears the untitled autosave after the same project is saved to disk', async () => {
    const project = createProject('Was untitled');
    await writeAutosave(null, project, userData);
    await clearUntitledAutosaveFor(createProject('Other'), userData);
    expect(fs.existsSync(untitledAutosavePath(userData))).toBe(true);
    await clearUntitledAutosaveFor(project, userData);
    expect(fs.existsSync(untitledAutosavePath(userData))).toBe(false);
  });
});

describe('prefs & recent projects', () => {
  it('returns defaults when no prefs file exists', async () => {
    expect(await readPrefs(userData)).toEqual(defaultPrefs());
    expect(defaultPrefs()).toEqual({ recentProjects: [], shortcuts: {} });
  });

  it('persists patches', async () => {
    await updatePrefs(userData, { lastExportDir: '/exports', shortcuts: { 'edit.undo': 'Ctrl+Z' } });
    const p = await readPrefs(userData);
    expect(p.lastExportDir).toBe('/exports');
    expect(p.shortcuts['edit.undo']).toBe('Ctrl+Z');
    expect(fs.existsSync(path.join(userData, 'prefs.json'))).toBe(true);
  });

  it('survives a corrupt prefs file', async () => {
    await fsp.writeFile(path.join(userData, 'prefs.json'), '!!!');
    expect(await readPrefs(userData)).toEqual(defaultPrefs());
  });

  it('keeps recent projects deduped, most-recent first, capped', async () => {
    expect(pushRecent(['/a', '/b'], '/b')).toEqual(['/b', '/a']);
    const many = Array.from({ length: 20 }, (_, i) => `/p/${i}.recut`);
    let list: string[] = [];
    for (const m of many) list = pushRecent(list, m);
    expect(list.length).toBe(MAX_RECENT);
    expect(list[0]).toBe('/p/19.recut');
    const stored = await addRecentProject(userData, '/x/one.recut');
    expect(stored).toEqual(['/x/one.recut']);
    expect((await readPrefs(userData)).recentProjects).toEqual(['/x/one.recut']);
  });
});

describe('parseRange', () => {
  const size = 1000;
  it('returns the full range when there is no header', () => {
    expect(parseRange(null, size)).toEqual({ start: 0, end: 999 });
    expect(parseRange(undefined, size)).toEqual({ start: 0, end: 999 });
    expect(parseRange('', size)).toEqual({ start: 0, end: 999 });
  });
  it('parses start-end and clamps the end', () => {
    expect(parseRange('bytes=10-19', size)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=0-0', size)).toEqual({ start: 0, end: 0 });
    expect(parseRange('bytes=990-5000', size)).toEqual({ start: 990, end: 999 });
    expect(parseRange('Bytes = 5-6', size)).toEqual({ start: 5, end: 6 });
  });
  it('parses open-ended ranges', () => {
    expect(parseRange('bytes=500-', size)).toEqual({ start: 500, end: 999 });
    expect(parseRange('bytes=0-', size)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=999-', size)).toEqual({ start: 999, end: 999 });
  });
  it('parses suffix ranges', () => {
    expect(parseRange('bytes=-100', size)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-5000', size)).toEqual({ start: 0, end: 999 });
  });
  it('uses the first of multiple ranges', () => {
    expect(parseRange('bytes=0-9, 20-29', size)).toEqual({ start: 0, end: 9 });
  });
  it('returns null for invalid or unsatisfiable ranges', () => {
    expect(parseRange('bytes=1000-', size)).toBeNull();
    expect(parseRange('bytes=1500-1600', size)).toBeNull();
    expect(parseRange('bytes=20-10', size)).toBeNull();
    expect(parseRange('bytes=-0', size)).toBeNull();
    expect(parseRange('bytes=-', size)).toBeNull();
    expect(parseRange('bytes=abc', size)).toBeNull();
    expect(parseRange('items=0-1', size)).toBeNull();
    expect(parseRange('bytes=0-1', -1)).toBeNull();
    expect(parseRange('bytes=0-', 0)).toBeNull();
    expect(parseRange('bytes=-10', 0)).toBeNull();
  });
});

describe('protocol helpers', () => {
  it('maps extensions to content types', () => {
    expect(contentTypeFor('/a/b.mp4')).toBe('video/mp4');
    expect(contentTypeFor('/a/b.MKV')).toBe('video/x-matroska');
    expect(contentTypeFor('/a/b.mov')).toBe('video/quicktime');
    expect(contentTypeFor('/a/b.webm')).toBe('video/webm');
    expect(contentTypeFor('/a/b.m4v')).toBe('video/x-m4v');
    expect(contentTypeFor('/a/b.mp3')).toBe('audio/mpeg');
    expect(contentTypeFor('/a/b.aac')).toBe('audio/aac');
    expect(contentTypeFor('/a/b.wav')).toBe('audio/wav');
    expect(contentTypeFor('/a/b.flac')).toBe('audio/flac');
    expect(contentTypeFor('/a/b.ogg')).toBe('audio/ogg');
    expect(contentTypeFor('/a/b.jpg')).toBe('image/jpeg');
    expect(contentTypeFor('/a/b.png')).toBe('image/png');
    expect(contentTypeFor('/a/b.webp')).toBe('image/webp');
    expect(contentTypeFor('/a/b.srt')).toMatch(/^text\/plain/);
    expect(contentTypeFor('/a/b.xyz')).toBe('application/octet-stream');
  });
  it('decodes recut-media URLs back to paths', () => {
    const p = '/Movies/Return of the Jedi (1983)/film #1.mkv';
    expect(mediaUrlPath(`recut-media://local/${encodeURIComponent(p)}`, 'recut-media')).toBe(p);
    expect(mediaUrlPath('recut-media://other/%2Fx', 'recut-media')).toBeNull();
    expect(mediaUrlPath('https://local/%2Fx', 'recut-media')).toBeNull();
    expect(mediaUrlPath('recut-media://local/', 'recut-media')).toBeNull();
  });
});

describe('backup fallback (QA-04 / QA-10)', () => {
  it('a damaged .recut opens from .bak with fromBackup + backupMtime and the damaged file is kept aside', async () => {
    const file = path.join(tmp, 'c.recut');
    await saveProjectFile(file, createProject('good'));
    await saveProjectFile(file, createProject('good2')); // .bak = good
    await fsp.writeFile(file, '{ truncated');
    const res = await loadProjectFile(file);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.project.name).toBe('good');
    expect(res.fromBackup).toBe(true);
    expect(res.backupMtime).toBe((await fsp.stat(file + '.bak')).mtimeMs);
    const aside = (await fsp.readdir(tmp)).filter((f) => f.startsWith('c.recut.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(await fsp.readFile(path.join(tmp, aside[0]), 'utf8')).toBe('{ truncated');
  });

  it('a normal open is not flagged fromBackup', async () => {
    const file = path.join(tmp, 'n.recut');
    await saveProjectFile(file, createProject('n'));
    const res = await loadProjectFile(file);
    expect(res.ok && res.fromBackup).toBeFalsy();
  });

  it('a newer-format project is refused, never replaced by its .bak', async () => {
    const file = path.join(tmp, 'v.recut');
    await saveProjectFile(file, createProject('a'));
    await saveProjectFile(file, createProject('b'));
    await fsp.writeFile(file, JSON.stringify({ ...createProject('future'), formatVersion: PROJECT_FORMAT_VERSION + 1 }));
    const res = await loadProjectFile(file);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/newer ReCut/);
    expect((await fsp.readdir(tmp)).some((f) => f.includes('.corrupt-'))).toBe(false);
  });

  it('a damaged file without a usable .bak reports an error', async () => {
    const file = path.join(tmp, 'x.recut');
    await fsp.writeFile(file, 'nope');
    const res = await loadProjectFile(file);
    expect(res.ok).toBe(false);
  });

  it('a corrupt autosave does not break checkRecovery', async () => {
    const file = path.join(tmp, 'r.recut');
    await saveProjectFile(file, createProject('r'));
    const auto = autosavePathFor(file, userData);
    await fsp.writeFile(auto, '{corrupt');
    const future = new Date(Date.now() + 60_000);
    await fsp.utimes(auto, future, future);
    await fsp.mkdir(path.dirname(untitledAutosavePath(userData)), { recursive: true });
    await fsp.writeFile(untitledAutosavePath(userData), '\u0000garbage');
    await expect(checkRecovery(userData, [file, 42 as unknown as string])).resolves.toBeNull();
  });
});

describe('projectPathFromArgv (QA-33)', () => {
  it('Chromium-reordered argv: --project followed by a switch, real path last', () => {
    const argv = ['--no-sandbox', '--project', '--allow-file-access-from-files', '--enable-features=X', '/app/dist/electron/main.js', '/tmp/x/second.recut'];
    expect(projectPathFromArgv(argv)).toBe('/tmp/x/second.recut');
  });
  it('prefers the last positional .recut', () => {
    expect(projectPathFromArgv(['/a/one.recut', '--flag', '/b/two.RECUT'])).toBe('/b/two.RECUT');
    expect(projectPathFromArgv(['--project=/c/p.recut', '/d/q.recut'])).toBe('/d/q.recut');
  });
  it('--project=<p> and --project <p> (next token not a switch)', () => {
    expect(projectPathFromArgv(['.', '--project=/c/p'])).toBe('/c/p');
    expect(projectPathFromArgv(['.', '--project', '/c/plain'])).toBe('/c/plain');
    expect(projectPathFromArgv(['.', '--project', '--other'])).toBeNull();
    expect(projectPathFromArgv(['.', '--project'])).toBeNull();
    expect(projectPathFromArgv(['.', '--no-sandbox'])).toBeNull();
  });
  it('relative paths resolve against the given working directory', () => {
    expect(projectPathFromArgv(['rel/p.recut'], '/work')).toBe(path.resolve('/work', 'rel/p.recut'));
  });
});

describe('autosave format and safe folder creation (P-06, BUG-1)', () => {
  it('autosaves are compact JSON; manual saves stay 2-space indented; both load the same project', async () => {
    const project = createProject('Format');
    const file = path.join(tmp, 'fmt.recut');
    const saved = await saveProjectFile(file, project);
    const auto = await writeAutosave(file, project, userData);
    expect(saved.ok && auto.ok).toBe(true);
    const manualText = await fsp.readFile(file, 'utf8');
    const autoText = await fsp.readFile(autosavePathFor(file, userData), 'utf8');
    expect(manualText).toContain('\n  "');
    expect(autoText).not.toContain('\n');
    expect(autoText).toBe(serializeAutosave(project));
    expect(JSON.parse(autoText)).toEqual(JSON.parse(manualText));
    const rec = await checkRecovery(userData, []);
    expect(rec).toBeNull(); // autosave not newer than the project by more than the slack
  });

  it('writeAutosaveJson writes a renderer-serialized project as-is and recovery loads it', async () => {
    const project = createProject('From JSON');
    const json = JSON.stringify(project);
    const r = await writeAutosaveJson(null, json, userData);
    expect(r.ok).toBe(true);
    expect(await fsp.readFile(untitledAutosavePath(userData), 'utf8')).toBe(json);
    const rec = await checkRecovery(userData, []);
    expect(rec?.project.name).toBe('From JSON');
    expect((await writeAutosaveJson(null, 'nope', userData)).ok).toBe(false);
    expect((await writeAutosaveJson(null, 42 as unknown as string, userData)).ok).toBe(false);
  });

  it('atomicWriteFile writes large strings and buffers exactly', async () => {
    const big = 'é'.repeat(3_000_000); // 6 MB of UTF-8
    const f = path.join(tmp, 'big.txt');
    await atomicWriteFile(f, big);
    expect(await fsp.readFile(f, 'utf8')).toBe(big);
    const buf = Buffer.alloc(1_500_000, 7);
    await atomicWriteFile(f, buf);
    expect((await fsp.readFile(f)).equals(buf)).toBe(true);
  });

  it('ensureDirSafe creates nested folders and refuses files / pseudo file systems quickly', async () => {
    const nested = path.join(tmp, 'a', 'b', 'c');
    await ensureDirSafe(nested);
    expect(fs.statSync(nested).isDirectory()).toBe(true);
    await ensureDirSafe(nested); // exists: no-op
    const file = path.join(tmp, 'plain.txt');
    fs.writeFileSync(file, 'x');
    await expect(ensureDirSafe(path.join(file, 'sub'))).rejects.toThrow(/not a folder/);
    if (process.platform === 'linux') {
      const t0 = Date.now();
      await expect(ensureDirSafe('/proc/recut-nope/deeper')).rejects.toThrow(/pseudo file system/);
      await expect(ensureDirSafe('/sys/recut-nope')).rejects.toThrow(/pseudo file system/);
      // Through a symlink into /proc.
      const link = path.join(tmp, 'proclink');
      fs.symlinkSync('/proc/self', link);
      await expect(ensureDirSafe(path.join(link, 'recut-nope'))).rejects.toThrow(/pseudo file system/);
      expect(Date.now() - t0).toBeLessThan(1000);
    }
  });

  it('saving a project under /proc fails fast instead of hanging', async () => {
    if (process.platform !== 'linux') return;
    const t0 = Date.now();
    const r = await saveProjectFile('/proc/recut-nope/p.recut', createProject('x'));
    expect(r.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
