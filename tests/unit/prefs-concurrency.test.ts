/**
 * prefs.json under concurrent use (bugs/closed/2026-10-07-startup-open-fails-prefs-rename-windows.md).
 *
 * A launch with `--project` opens the project (which puts it on the recent list: read + write prefs.json) while the
 * renderer asks for AppInfo (reads prefs.json for the cache folder) and checks for recovery (reads prefs.json). On
 * Windows a rename over a file another handle has open fails with EPERM, so the recent-list write failed, and the
 * open failed with it ("Open failed: ... EPERM ... rename ... prefs.json"; the project never loaded).
 *
 * The Windows rule is emulated here on fs.promises: a rename onto prefs.json fails while a read of it is in flight.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const handlers = new Map<string, (...a: unknown[]) => unknown>();
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => os.tmpdir() },
  BrowserWindow: class {},
  dialog: {},
  shell: {},
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn); },
    on: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn); },
  },
}));

import * as io from '../../electron/project/io';
import { registerIpc } from '../../electron/ipc';
import { IPC } from '../../shared/ipc';
import { createProject } from '../../shared/project';

const isPrefs = (p: unknown) => typeof p === 'string' && path.basename(p) === 'prefs.json';

/** Windows rename semantics for prefs.json: a rename over it fails while a read of it is in flight. */
function emulateWindowsRename(): { refused: () => number } {
  const realRead = fsp.readFile.bind(fsp);
  const realRename = fsp.rename.bind(fsp);
  let reading = 0;
  let refused = 0;
  vi.spyOn(fsp, 'readFile').mockImplementation((async (p: Parameters<typeof fsp.readFile>[0], o?: Parameters<typeof fsp.readFile>[1]) => {
    if (!isPrefs(p)) return realRead(p, o);
    reading++;
    try {
      const out = await realRead(p, o);
      await new Promise((r) => setTimeout(r, 5)); // the handle stays open a little (a slow disk, an AV scan)
      return out;
    } finally { reading--; }
  }) as typeof fsp.readFile);
  vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
    if (isPrefs(to) && reading > 0) {
      refused++;
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${String(from)}' -> '${String(to)}'`), { code: 'EPERM' });
    }
    return realRename(from, to);
  });
  return { refused: () => refused };
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-prefs-')); handlers.clear(); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('prefs.json: one operation at a time', () => {
  it('reads and updates that overlap never rename over an open prefs.json, and no update is lost', async () => {
    const win = emulateWindowsRename();
    const a = path.join(dir, 'a.recut');
    const b = path.join(dir, 'b.recut');
    // What a launch with --project does at once: AppInfo + recovery reads, the recent list, the window bounds.
    const results = await Promise.allSettled([
      io.readPrefs(dir),
      io.addRecentProject(dir, a),
      io.readPrefs(dir),
      io.updatePrefs(dir, { cacheDir: path.join(dir, 'cache') }),
      io.readPrefs(dir),
      io.addRecentProject(dir, b),
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(win.refused()).toBe(0);
    const prefs = await io.readPrefs(dir);
    expect(prefs.recentProjects).toEqual([b, a]);
    expect(prefs.cacheDir).toBe(path.join(dir, 'cache'));
  });

  it('a failed prefs operation does not block the ones queued after it', async () => {
    fs.mkdirSync(path.join(dir, 'prefs.json', 'x'), { recursive: true }); // prefs.json is a folder: every write fails
    await expect(io.addRecentProject(dir, path.join(dir, 'a.recut'))).rejects.toThrow();
    await expect(io.readPrefs(dir)).resolves.toEqual(io.defaultPrefs());
  });
});

describe('project open / save do not depend on the recent list', () => {
  function register(onRecentChanged = vi.fn()) {
    registerIpc({ getWindow: () => null, requestQuit: () => undefined, userData: path.join(dir, 'userData'), isDev: false, onRecentChanged });
    return onRecentChanged;
  }
  const call = (ch: string, ...a: unknown[]) => handlers.get(ch)!({ sender: { id: 1 } }, ...a) as Promise<Record<string, unknown>>;

  it('opens the project even when prefs.json cannot be written', async () => {
    const file = path.join(dir, 'show.recut');
    expect((await io.saveProjectFile(file, createProject('Show'))).ok).toBe(true);
    fs.mkdirSync(path.join(dir, 'userData', 'prefs.json', 'x'), { recursive: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const recentChanged = register();
    const res = await call(IPC.projectLoad, file);
    expect(res.ok).toBe(true);
    expect(res.path).toBe(file);
    expect(res.projectWire).toBeTruthy();
    expect(recentChanged).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('opens the project at launch while the renderer reads prefs (Windows rename rule)', async () => {
    const file = path.join(dir, 'show.recut');
    expect((await io.saveProjectFile(file, createProject('Show'))).ok).toBe(true);
    const win = emulateWindowsRename();
    const recentChanged = register();
    // The renderer keeps reading prefs while the open runs (AppInfo, recovery check, shortcuts, layout).
    let done = false;
    const reads: Promise<unknown>[] = [call(IPC.projectCheckRecovery)];
    const reader = (async () => { while (!done) { reads.push(call(IPC.prefsGet)); await new Promise((r) => setTimeout(r, 1)); } })();
    const opened = await call(IPC.projectLoad, file).finally(() => { done = true; });
    await reader; await Promise.all(reads);
    expect(opened.ok).toBe(true);
    expect(win.refused()).toBe(0);
    expect(recentChanged).toHaveBeenCalled();
    expect((await io.readPrefs(path.join(dir, 'userData'))).recentProjects).toEqual([file]);
  });

  it('reports a save that reached the disk as saved even when prefs.json cannot be written', async () => {
    fs.mkdirSync(path.join(dir, 'userData', 'prefs.json', 'x'), { recursive: true });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    register();
    const file = path.join(dir, 'saved.recut');
    const res = await call(IPC.projectSave, file, createProject('Saved'));
    expect(res.ok).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('window bounds go through the prefs queue (follow-up)', () => {
  const bounds = (x: number) => ({ 'window.x': x, 'window.y': 20, 'window.width': 1400, 'window.height': 900, 'window.maximized': 0 });

  it('a bounds write among reads and updates never renames over an open prefs.json, and keeps every other change', async () => {
    await io.updateLayoutPrefs(dir, { 'panel.left': 300 });
    const win = emulateWindowsRename();
    const w = new io.LayoutPrefsWriter(dir, 10);
    const a = path.join(dir, 'a.recut');
    w.set(bounds(10));
    const ops = Promise.allSettled([io.readPrefs(dir), io.addRecentProject(dir, a), io.readPrefs(dir)]);
    w.set(bounds(30)); // the window moved again before the debounce fired
    const closing = w.flush(); // the window closes while the other operations are queued
    expect(w.pending).toBe(true);
    expect((await ops).filter((r) => r.status === 'rejected')).toEqual([]);
    await closing;
    expect(w.pending).toBe(false);
    expect(win.refused()).toBe(0);
    const prefs = await io.readPrefs(dir);
    expect(prefs.layout).toEqual({ 'panel.left': 300, ...bounds(30) });
    expect(prefs.recentProjects).toEqual([a]);
  });

  it('coalesces moves within the debounce into one write; flush writes the latest at once', async () => {
    const renames = vi.spyOn(fsp, 'rename');
    const w = new io.LayoutPrefsWriter(dir, 60_000);
    w.set(bounds(1)); w.set(bounds(2)); w.set(bounds(3));
    expect(w.pending).toBe(true);
    expect(fs.existsSync(io.prefsPath(dir))).toBe(false); // still waiting for the debounce
    await w.flush();
    expect(w.pending).toBe(false);
    expect(renames).toHaveBeenCalledTimes(1);
    expect((await io.readPrefs(dir)).layout).toEqual(bounds(3));
    await w.flush(); // nothing new: no write
    expect(renames).toHaveBeenCalledTimes(1);
  });

  it('writes after the debounce without a flush', async () => {
    const w = new io.LayoutPrefsWriter(dir, 5);
    w.set(bounds(7));
    await vi.waitFor(() => expect(w.pending).toBe(false));
    expect((await io.readPrefs(dir)).layout).toEqual(bounds(7));
  });

  it('a failed bounds write is reported, never thrown, and does not block later prefs operations', async () => {
    fs.mkdirSync(path.join(dir, 'prefs.json', 'x'), { recursive: true });
    const onError = vi.fn();
    const w = new io.LayoutPrefsWriter(dir, 60_000, onError);
    w.set(bounds(1));
    await expect(w.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(w.pending).toBe(false);
    await expect(io.readPrefs(dir)).resolves.toEqual(io.defaultPrefs());
  });
});

describe('atomic rename retry (Windows: a scan holds the destination for a moment)', () => {
  const saved = { enabled: io.RENAME_RETRY.enabled, delaysMs: [...io.RENAME_RETRY.delaysMs] };
  afterEach(() => { io.RENAME_RETRY.enabled = saved.enabled; io.RENAME_RETRY.delaysMs = [...saved.delaysMs]; });

  /** Fails the first `n` renames onto prefs.json with `code`, then renames for real. */
  function refuseRenames(n: number, code: string): { attempts: () => number } {
    const realRename = fsp.rename.bind(fsp);
    let attempts = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (!isPrefs(to)) return realRename(from, to);
      attempts++;
      if (attempts <= n) throw Object.assign(new Error(`${code}: rename '${String(from)}' -> '${String(to)}'`), { code });
      return realRename(from, to);
    });
    return { attempts: () => attempts };
  }

  it('is bounded: at most 5 attempts within 1 s, and Windows-only by default', () => {
    expect(io.RENAME_RETRY.delaysMs.length + 1).toBeLessThanOrEqual(5);
    expect(io.RENAME_RETRY.delaysMs.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1000);
    expect(io.RENAME_RETRY.enabled).toBe(process.platform === 'win32');
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries a rename refused with %s and succeeds', async (code) => {
    io.RENAME_RETRY.enabled = true;
    const r = refuseRenames(2, code);
    await io.writePrefs(dir, { ...io.defaultPrefs(), cacheDir: '/c' });
    expect(r.attempts()).toBe(3);
    expect((await io.readPrefs(dir)).cacheDir).toBe('/c');
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('gives up after the last attempt, removes its temp file, and leaves the old file', async () => {
    io.RENAME_RETRY.enabled = true;
    io.RENAME_RETRY.delaysMs = [1, 1, 1, 1];
    await io.writePrefs(dir, { ...io.defaultPrefs(), cacheDir: '/old' });
    const r = refuseRenames(99, 'EBUSY');
    await expect(io.writePrefs(dir, { ...io.defaultPrefs(), cacheDir: '/new' })).rejects.toMatchObject({ code: 'EBUSY' });
    expect(r.attempts()).toBe(5);
    vi.restoreAllMocks();
    expect((await io.readPrefs(dir)).cacheDir).toBe('/old');
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('does not retry other errors, nor anything when disabled (POSIX)', async () => {
    io.RENAME_RETRY.enabled = true;
    const r = refuseRenames(1, 'ENOSPC');
    await expect(io.writePrefs(dir, io.defaultPrefs())).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(r.attempts()).toBe(1);
    vi.restoreAllMocks();
    io.RENAME_RETRY.enabled = false;
    const r2 = refuseRenames(1, 'EPERM');
    await expect(io.writePrefs(dir, io.defaultPrefs())).rejects.toMatchObject({ code: 'EPERM' });
    expect(r2.attempts()).toBe(1);
  });

  it('retries in atomicWriteFileSync too, and gives up after 5 attempts', () => {
    io.RENAME_RETRY.enabled = true;
    io.RENAME_RETRY.delaysMs = [1, 1, 1, 1];
    const realRename = fs.renameSync.bind(fs);
    let attempts = 0, failFirst = 2;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      attempts++;
      if (attempts <= failFirst) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return realRename(from, to);
    });
    const target = path.join(dir, 'sync.json');
    io.atomicWriteFileSync(target, '{"a":1}');
    expect(attempts).toBe(3);
    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}');
    attempts = 0; failFirst = 99;
    expect(() => io.atomicWriteFileSync(target, '{"a":2}')).toThrow('EACCES');
    expect(attempts).toBe(5);
    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}');
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('retries the project save rename too (finishAtomic)', async () => {
    io.RENAME_RETRY.enabled = true;
    const realRename = fsp.rename.bind(fsp);
    let refused = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('show.recut') && refused < 2) { refused++; throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); }
      return realRename(from, to);
    });
    const file = path.join(dir, 'show.recut');
    expect((await io.saveProjectFile(file, createProject('Show'))).ok).toBe(true);
    expect(refused).toBe(2);
    expect((await io.loadProjectFile(file)).ok).toBe(true);
  });
});
