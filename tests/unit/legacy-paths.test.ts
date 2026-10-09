/**
 * Proxy and cache paths saved under a legacy user-data folder: the roots (shared/legacyPaths.ts), the main-process
 * remap that compares paths in their real form (electron/legacyPathRemap.ts: symlinked temp folders on macOS, 8.3
 * short names on Windows, letter case, separators), and verifyProxies / the channel-proxy check asking for it before
 * a proxy is called missing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { legacyPathRoots } from '../../shared/legacyPaths';
import { canonicalPath, createLegacyPathRemapper } from '../../electron/legacyPathRemap';
import { createMediaItem, createProject } from '../../shared/project';
import type { FileStat, RecutApi } from '../../shared/ipc';
import { useStore } from '../../src/state/store';
import { relocatedCachePath, verifyProxies } from '../../src/state/mediaActions';

describe('legacyPathRoots', () => {
  it('maps the legacy default cache to the current cache folder and the rest to the current user-data folder', () => {
    expect(legacyPathRoots(['/home/u/.config/Old'], '/home/u/.config/New', '/home/u/.config/New/cache')).toEqual([
      { from: '/home/u/.config/Old/cache', to: '/home/u/.config/New/cache' },
      { from: '/home/u/.config/Old', to: '/home/u/.config/New' },
    ]);
    expect(legacyPathRoots(['C:\\Users\\u\\AppData\\Roaming\\Old\\'], 'C:\\Users\\u\\AppData\\Roaming\\New', 'D:\\cache')).toEqual([
      { from: 'C:\\Users\\u\\AppData\\Roaming\\Old\\cache', to: 'D:\\cache' },
      { from: 'C:\\Users\\u\\AppData\\Roaming\\Old', to: 'C:\\Users\\u\\AppData\\Roaming\\New' },
    ]);
  });
  it('drops roots that map onto themselves', () => {
    expect(legacyPathRoots(['/a/Same'], '/a/Same', '/a/Same/cache')).toEqual([]);
    expect(legacyPathRoots(['C:\\A\\Same'], 'c:/a/same', 'C:\\A\\Same\\cache')).toEqual([]);
    expect(legacyPathRoots([], '/a', '/a/cache')).toEqual([]);
  });
});

/** An existence set for injected realpath / exists: the files and every ancestor folder count as existing. */
function existing(files: string[], P: typeof path.posix, fold: boolean) {
  const all = new Map<string, string>();
  const key = (p: string) => (fold ? p.toLowerCase() : p);
  for (const f of files) {
    let cur = f;
    for (;;) {
      all.set(key(cur), cur);
      const parent = P.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return {
    has: (p: string) => all.has(key(p)),
    /** realpath: the stored (canonical) spelling of an existing path, after `alias` rewrites; throws otherwise. */
    realpath: (alias: (p: string) => string) => (p: string) => {
      const real = all.get(key(alias(p)));
      if (real === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
      return real;
    },
  };
}

describe('createLegacyPathRemapper: POSIX (Linux rules)', () => {
  const roots = legacyPathRoots(['/home/u/.config/Old'], '/home/u/.config/New', '/srv/cache');
  const fsys = existing(['/srv/cache/proxies/k_540p_all.mp4', '/home/u/.config/New/whisper/models/m.bin'], path.posix, false);
  const remap = createLegacyPathRemapper(roots, { platform: 'linux', realpath: fsys.realpath((p) => p), exists: fsys.has });

  it('the default cache maps to the cache folder, other paths to the user-data folder', () => {
    expect(remap('/home/u/.config/Old/cache/proxies/k_540p_all.mp4')).toBe('/srv/cache/proxies/k_540p_all.mp4');
    expect(remap('/home/u/.config/Old/whisper/models/m.bin')).toBe('/home/u/.config/New/whisper/models/m.bin');
  });
  it('separators are normalised (duplicate and trailing slashes)', () => {
    expect(remap('/home/u/.config//Old/cache/proxies//k_540p_all.mp4')).toBe('/srv/cache/proxies/k_540p_all.mp4');
  });
  it('null when no file exists there, outside every root, a different case (case-sensitive), or climbing out with ..', () => {
    expect(remap('/home/u/.config/Old/cache/proxies/gone.mp4')).toBeNull();
    expect(remap('/elsewhere/k_540p_all.mp4')).toBeNull();
    expect(remap('/home/u/.config/old/cache/proxies/k_540p_all.mp4')).toBeNull();
    expect(remap('/home/u/.config/Older/cache/proxies/k_540p_all.mp4')).toBeNull();
    expect(remap('/home/u/.config/Old/cache/../../../../srv/cache/proxies/k_540p_all.mp4')).toBeNull();
    expect(remap('')).toBeNull();
  });
  it('no roots: null', () => {
    expect(createLegacyPathRemapper([], { platform: 'linux', exists: () => true })('/home/u/.config/Old/cache/x')).toBeNull();
  });
});

describe('createLegacyPathRemapper: macOS (symlinked temp folder, case-insensitive)', () => {
  // /var is a symlink to /private/var: Electron and Node may report either spelling.
  const real = '/private/var/folders/xy/T/run';
  const fsys = existing([`${real}/appdata/New/cache/proxies/k.mp4`], path.posix, true);
  const realpath = fsys.realpath((p) => p.replace(/^\/var\//i, '/private/var/'));

  it('a path saved as /var/… matches roots spelled /private/var/…, and the reverse', () => {
    const viaPrivate = createLegacyPathRemapper(
      legacyPathRoots([`${real}/appdata/Old`], `${real}/appdata/New`, `${real}/appdata/New/cache`), { platform: 'darwin', realpath, exists: fsys.has });
    expect(viaPrivate('/var/folders/xy/T/run/appdata/Old/cache/proxies/k.mp4')).toBe(`${real}/appdata/New/cache/proxies/k.mp4`);
    const viaVar = createLegacyPathRemapper(
      legacyPathRoots(['/var/folders/xy/T/run/appdata/Old'], '/var/folders/xy/T/run/appdata/New', '/var/folders/xy/T/run/appdata/New/cache'),
      { platform: 'darwin', realpath, exists: (p) => { try { return fsys.has(realpath(p)); } catch { return false; } } });
    expect(viaVar(`${real}/appdata/Old/cache/proxies/k.mp4`)).toBe('/var/folders/xy/T/run/appdata/New/cache/proxies/k.mp4');
  });
  it('a root that maps onto itself never answers, whichever spelling the path uses', () => {
    const same = `${real}/appdata/New`;
    const remap = createLegacyPathRemapper([{ from: same, to: same }], { platform: 'darwin', realpath, exists: fsys.has });
    expect(remap('/var/folders/xy/T/run/appdata/New/cache/proxies/k.mp4')).toBeNull();
    expect(remap(`${same}/cache/proxies/k.mp4`)).toBeNull();
  });
  it('letter case is ignored on macOS', () => {
    const remap = createLegacyPathRemapper(
      legacyPathRoots([`${real}/appdata/Old`], `${real}/appdata/New`, `${real}/appdata/New/cache`), { platform: 'darwin', realpath, exists: fsys.has });
    expect(remap(`${real.toUpperCase()}/APPDATA/old/Cache/proxies/k.mp4`)).toBe(`${real}/appdata/New/cache/proxies/k.mp4`);
  });
});

describe('createLegacyPathRemapper: Windows (8.3 short names, case, separators)', () => {
  const long = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\t';
  const fsys = existing([`${long}\\appdata\\New\\cache\\proxies\\k.mp4`], path.win32, true);
  const realpath = fsys.realpath((p) => p.replace(/^C:\\Users\\RUNNER~1(?=\\|$)/i, 'C:\\Users\\runneradmin'));
  const env = { platform: 'win32' as const, realpath, exists: (p: string) => { try { return fsys.has(realpath(p)); } catch { return false; } } };

  it('a path saved with the short name matches roots in long form', () => {
    const remap = createLegacyPathRemapper(legacyPathRoots([`${long}\\appdata\\Old`], `${long}\\appdata\\New`, `${long}\\appdata\\New\\cache`), env);
    expect(remap('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\t\\appdata\\Old\\cache\\proxies\\k.mp4')).toBe(`${long}\\appdata\\New\\cache\\proxies\\k.mp4`);
  });
  it('roots in short form match a path saved in long form', () => {
    const short = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\t';
    const remap = createLegacyPathRemapper(legacyPathRoots([`${short}\\appdata\\Old`], `${short}\\appdata\\New`, `${short}\\appdata\\New\\cache`), env);
    expect(remap(`${long}\\appdata\\Old\\cache\\proxies\\k.mp4`)).toBe(`${short}\\appdata\\New\\cache\\proxies\\k.mp4`);
  });
  it('case-insensitive, and forward slashes are accepted', () => {
    const remap = createLegacyPathRemapper(legacyPathRoots([`${long}\\appdata\\Old`], `${long}\\appdata\\New`, `${long}\\appdata\\New\\cache`), env);
    expect(remap('c:/users/RUNNERADMIN/appdata/local/temp/T/APPDATA/old/cache/proxies/k.mp4')).toBe(`${long}\\appdata\\New\\cache\\proxies\\k.mp4`);
    expect(remap('c:/users/runneradmin/appdata/local/temp/t/appdata/old/cache/proxies/missing.mp4')).toBeNull();
  });
  it('canonicalPath keeps the missing tail and expands the existing head', () => {
    expect(canonicalPath('C:/Users/RUNNER~1/AppData/Local/Temp/t/appdata/Old/x', env)).toBe(`${long}\\appdata\\Old\\x`);
  });
});

describe('createLegacyPathRemapper on the real file system', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-legacy-paths-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it.skipIf(process.platform === 'win32')('a root reached through a symlinked folder matches the real path (and the reverse)', () => {
    const real = path.join(tmp, 'real');
    fs.mkdirSync(path.join(real, 'New', 'cache', 'proxies'), { recursive: true });
    fs.writeFileSync(path.join(real, 'New', 'cache', 'proxies', 'k.mp4'), 'x');
    const link = path.join(tmp, 'link');
    fs.symlinkSync(real, link);
    const viaLink = createLegacyPathRemapper(legacyPathRoots([path.join(link, 'Old')], path.join(link, 'New'), path.join(link, 'New', 'cache')));
    expect(viaLink(path.join(real, 'Old', 'cache', 'proxies', 'k.mp4'))).toBe(path.join(link, 'New', 'cache', 'proxies', 'k.mp4'));
    const viaReal = createLegacyPathRemapper(legacyPathRoots([path.join(real, 'Old')], path.join(real, 'New'), path.join(real, 'New', 'cache')));
    expect(viaReal(path.join(link, 'Old', 'cache', 'proxies', 'k.mp4'))).toBe(path.join(real, 'New', 'cache', 'proxies', 'k.mp4'));
  });

  it('folders under os.tmpdir() spelled as it gives them (Windows runner: the 8.3 short name) and in real form', () => {
    // Laid out like tests/e2e/user-data-migration.spec.ts after the move: the legacy folder is gone.
    const appData = path.join(tmp, 'real', 'appdata');
    const legacy = path.join(appData, 'OldAppName');
    const current = path.join(appData, 'MigrationTestApp');
    fs.mkdirSync(path.join(current, 'cache', 'proxies'), { recursive: true });
    const expected = path.join(current, 'cache', 'proxies', 'k_540p_all.mp4');
    fs.writeFileSync(expected, 'x');
    const roots = legacyPathRoots([legacy], current, path.join(current, 'cache'));
    const remap = createLegacyPathRemapper(roots);
    const realTmp = fs.realpathSync.native(tmp);
    for (const saved of [path.join(legacy, 'cache', 'proxies', 'k_540p_all.mp4'), path.join(realTmp, 'real', 'appdata', 'OldAppName', 'cache', 'proxies', 'k_540p_all.mp4')]) {
      const evidence = JSON.stringify({
        tmpdir: os.tmpdir(), realTmp, saved, canonicalSaved: canonicalPath(saved), expectedExists: fs.existsSync(expected),
        roots: roots.map((r) => ({ ...r, canonicalFrom: canonicalPath(r.from), canonicalTo: canonicalPath(r.to) })),
      }, null, 1);
      expect(remap(saved), evidence).toBe(expected);
    }
  });

  it('a root that maps onto itself never answers', () => {
    fs.mkdirSync(path.join(tmp, 'Same', 'cache'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'Same', 'cache', 'k.mp4'), 'x');
    const remap = createLegacyPathRemapper([{ from: path.join(tmp, 'Same'), to: path.join(tmp, 'Same') }]);
    expect(remap(path.join(tmp, 'Same', 'cache', 'k.mp4'))).toBeNull();
  });
});

describe('verifyProxies and the channel-proxy check with a moved user-data folder', () => {
  const OLD = '/home/u/.config/Old';
  const NEW = '/home/u/.config/New';
  let files: Set<string>;
  let relocateCalls: string[];
  const g = globalThis as unknown as Record<string, unknown>;

  function install(withRelocate = true): void {
    relocateCalls = [];
    const remap = createLegacyPathRemapper(legacyPathRoots([OLD], NEW, `${NEW}/cache`), { platform: 'linux', realpath: (p) => p, exists: (p) => files.has(p) });
    const api: Partial<RecutApi> = {
      stat: async (p: string): Promise<FileStat> => ({ exists: files.has(p) }),
      ...(withRelocate ? { relocateLegacyPath: async (p: string) => { relocateCalls.push(p); return remap(p); } } : {}),
    };
    g.window = globalThis;
    g.recut = api;
  }

  beforeEach(() => {
    files = new Set();
    useStore.getState().loadProjectData(createProject('Remap'), null);
  });
  afterEach(() => { delete g.recut; delete g.window; });

  function addMedia(id: string, proxyPath: string): void {
    const m = { ...createMediaItem(`/media/${id}.mkv`, `${id}.mkv`), id, proxy: { status: 'ready' as const, path: proxyPath, progress: 1 } };
    useStore.getState().addMedia([m]);
  }

  it('a proxy under the legacy cache that now exists under the current cache is remapped, not reported missing', async () => {
    install();
    addMedia('a', `${OLD}/cache/proxies/a_540p_all.mp4`);
    addMedia('b', `${OLD}/cache/proxies/b_540p_all.mp4`);
    addMedia('c', '/media/proxies/c.mp4');
    files.add(`${NEW}/cache/proxies/a_540p_all.mp4`); // moved with the folder
    const gone = await verifyProxies();
    expect(gone.sort()).toEqual(['b', 'c']);
    const media = useStore.getState().project.media;
    expect(media.a.proxy).toMatchObject({ status: 'ready', path: `${NEW}/cache/proxies/a_540p_all.mp4` });
    expect(media.b.proxy.status).toBe('none');
    expect(media.c.proxy.status).toBe('none');
  });

  it('an existing proxy is not looked up; a bridge without the call reports missing proxies as before', async () => {
    install();
    addMedia('a', `${OLD}/cache/proxies/a.mp4`);
    files.add(`${OLD}/cache/proxies/a.mp4`);
    expect(await verifyProxies()).toEqual([]);
    expect(relocateCalls).toEqual([]);
    install(false);
    addMedia('b', `${OLD}/cache/proxies/b.mp4`);
    files.add(`${NEW}/cache/proxies/b.mp4`);
    expect(await verifyProxies()).toEqual(['b']);
  });

  it('relocatedCachePath (the channel-proxy check uses it) finds the moved file or returns null', async () => {
    install();
    files.add(`${NEW}/cache/proxies/x_ch1.mono-L_v1.m4a`);
    const api = g.recut as RecutApi;
    expect(await relocatedCachePath(api, `${OLD}/cache/proxies/x_ch1.mono-L_v1.m4a`)).toBe(`${NEW}/cache/proxies/x_ch1.mono-L_v1.m4a`);
    expect(await relocatedCachePath(api, `${OLD}/cache/proxies/y.m4a`)).toBeNull();
    expect(await relocatedCachePath(api, '/other/x.m4a')).toBeNull();
  });
});
