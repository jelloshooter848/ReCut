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
