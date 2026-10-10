/**
 * electron/chromiumCache.ts: the one-time removal of Chromium's HTTP cache from the default cache folder
 * (bugs/closed/2026-10-09-default-cache-dir-is-chromium-http-cache.md @ 59eafc6). Only Chromium's folder names, only in
 * `<userData>/cache`, never anything of the app's.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isChromiumCacheEntryName, isDefaultCacheDir, removeStaleChromiumCache } from '../../electron/chromiumCache';
import { CACHE_SUBDIRS } from '../../electron/media/cache';

const tmps: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-chromium-cache-'));
  tmps.push(d);
  return d;
}
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function write(p: string, text = 'x'): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

/** Every file under `dir`, relative, sorted. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

/** The app's cache entries plus Chromium's leftovers in `<userData>/cache`. */
function seedProfile(userData: string): void {
  const cache = path.join(userData, 'cache');
  for (const sub of CACHE_SUBDIRS) write(path.join(cache, sub, `${sub}-entry`));
  write(path.join(cache, 'Cache_Data', 'index'));
  write(path.join(cache, 'Cache_Data', 'data_0'));
  write(path.join(cache, 'Cache_Data', 'f_00000a'));
  write(path.join(cache, 'Cache_Data', 'index-dir', 'the-real-index'));
  write(path.join(cache, 'Cache_Data', '0123456789abcdef_0'));
  write(path.join(cache, 'old_Cache_Data_000', 'index'));
  write(path.join(cache, 'old_Cache_Data_042', 'data_1'));
}

const appEntries = CACHE_SUBDIRS.map((sub) => `${sub}/${sub}-entry`).sort();

describe('isChromiumCacheEntryName', () => {
  it("matches Chromium's backend folder and its renamed-for-deletion folders only", () => {
    for (const n of ['Cache_Data', 'old_Cache_Data_000', 'old_Cache_Data_099', 'old_Cache_Data_123']) expect(isChromiumCacheEntryName(n), n).toBe(true);
    for (const n of [
      ...CACHE_SUBDIRS, 'cache_data', 'CACHE_DATA', 'Cache_Data2', 'Cache_Data ', 'xCache_Data', 'Cache', 'old_Cache_Data_',
      'old_Cache_Data_1', 'old_Cache_Data_0000', 'old_cache_data_000', 'old_proxies_000', 'index', 'index-dir', 'data_0',
      'f_000001', 'the-real-index', '0123456789abcdef_0', 'Code Cache', 'GPUCache', '',
    ]) expect(isChromiumCacheEntryName(n), n).toBe(false);
  });
});

describe('isDefaultCacheDir', () => {
  it('is true only for <userData>/cache', () => {
    const ud = path.resolve('/x/ReCut');
    expect(isDefaultCacheDir(ud, path.join(ud, 'cache'))).toBe(true);
    expect(isDefaultCacheDir(ud, path.join(ud, 'cache') + path.sep)).toBe(true);
    expect(isDefaultCacheDir(ud, path.join(ud, 'x', '..', 'cache'))).toBe(true);
    expect(isDefaultCacheDir(ud, path.join(ud, 'Cache'))).toBe(false);
    expect(isDefaultCacheDir(ud, path.join(ud, 'cache', 'proxies'))).toBe(false);
    expect(isDefaultCacheDir(ud, path.resolve('/elsewhere/cache'))).toBe(false);
    expect(isDefaultCacheDir(ud, ud)).toBe(false);
  });
});

describe('removeStaleChromiumCache', () => {
  it("removes Chromium's folders from the default cache folder and keeps every app entry", async () => {
    const ud = tmpDir();
    seedProfile(ud);
    write(path.join(ud, 'cache', 'notes.txt')); // something a user put there: not Chromium's, kept
    const logs: string[] = [];
    const removed = await removeStaleChromiumCache({ userData: ud, cacheDir: path.join(ud, 'cache'), log: (m) => logs.push(m) });
    expect(removed.map((p) => path.basename(p)).sort()).toEqual(['Cache_Data', 'old_Cache_Data_000', 'old_Cache_Data_042']);
    expect(tree(path.join(ud, 'cache'))).toEqual([...appEntries, 'notes.txt'].sort());
    expect(logs.join('\n')).toContain('removed');
  });

  it('touches nothing when the app uses another cache folder (a chosen folder or RECUT_CACHE_DIR)', async () => {
    const ud = tmpDir();
    seedProfile(ud);
    const chosen = path.join(tmpDir(), 'my-cache');
    seedProfile(path.dirname(chosen)); // Chromium-like names in the chosen folder's parent's "cache": untouched too
    write(path.join(chosen, 'Cache_Data', 'index'));
    const before = tree(ud);
    const chosenBefore = tree(path.dirname(chosen));
    expect(await removeStaleChromiumCache({ userData: ud, cacheDir: chosen, log: () => undefined })).toEqual([]);
    expect(tree(ud)).toEqual(before);
    expect(tree(path.dirname(chosen))).toEqual(chosenBefore);
  });

  it('a chosen folder that is <userData>/Cache (another case) is not the default folder', async () => {
    const ud = tmpDir();
    seedProfile(ud);
    const before = tree(ud);
    expect(await removeStaleChromiumCache({ userData: ud, cacheDir: path.join(ud, 'Cache'), log: () => undefined })).toEqual([]);
    expect(tree(ud)).toEqual(before);
  });

  it('never removes a file or a symbolic link that has a Chromium name', async () => {
    const ud = tmpDir();
    const cache = path.join(ud, 'cache');
    write(path.join(cache, 'Cache_Data')); // a file, not a folder
    const target = path.join(tmpDir(), 'precious');
    write(path.join(target, 'keep.bin'));
    let linked = true;
    try { fs.symlinkSync(target, path.join(cache, 'old_Cache_Data_000'), 'junction'); } catch { linked = false; }
    expect(await removeStaleChromiumCache({ userData: ud, cacheDir: cache, log: () => undefined })).toEqual([]);
    expect(fs.statSync(path.join(cache, 'Cache_Data')).isFile()).toBe(true);
    expect(fs.existsSync(path.join(target, 'keep.bin'))).toBe(true);
    if (linked) expect(fs.lstatSync(path.join(cache, 'old_Cache_Data_000')).isSymbolicLink()).toBe(true);
  });

  it('a missing cache folder or a removal failure is logged, never thrown', async () => {
    const ud = tmpDir();
    const logs: string[] = [];
    expect(await removeStaleChromiumCache({ userData: ud, cacheDir: path.join(ud, 'cache'), log: (m) => logs.push(m) })).toEqual([]);
    expect(logs).toEqual([]); // no folder yet: nothing to do, nothing to report

    // userData/cache is a file: listing it fails (ENOTDIR), which is logged.
    write(path.join(ud, 'cache'));
    expect(await removeStaleChromiumCache({ userData: ud, cacheDir: path.join(ud, 'cache'), log: (m) => logs.push(m) })).toEqual([]);
    expect(logs.join('\n')).toMatch(/cannot list/);
  });

  it('is a no-op on a profile without leftovers (Linux: Chromium used <userData>/Cache, a different folder)', async () => {
    const ud = tmpDir();
    for (const sub of CACHE_SUBDIRS) write(path.join(ud, 'cache', sub, `${sub}-entry`));
    if (process.platform === 'linux') write(path.join(ud, 'Cache', 'Cache_Data', 'index'));
    const before = tree(ud);
    expect(await removeStaleChromiumCache({ userData: ud, cacheDir: path.join(ud, 'cache'), log: () => undefined })).toEqual([]);
    expect(tree(ud)).toEqual(before);
  });
});
