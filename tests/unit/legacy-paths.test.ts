/**
 * Proxy and cache paths saved under a legacy user-data folder (shared/legacyPaths.ts): remapped to the current folder
 * by verifyProxies and the channel-proxy check before they are called missing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { legacyPathRoots, remapLegacyPath } from '../../shared/legacyPaths';
import { createMediaItem, createProject } from '../../shared/project';
import type { AppInfo, FileStat, RecutApi } from '../../shared/ipc';
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
  it('drops roots that map onto themselves (the session uses the legacy folder, or the names are equal)', () => {
    expect(legacyPathRoots(['/a/Same'], '/a/Same', '/a/Same/cache')).toEqual([]);
    expect(legacyPathRoots(['C:\\A\\Same'], 'c:/a/same', 'C:\\A\\Same\\cache')).toEqual([]);
    expect(legacyPathRoots([], '/a', '/a/cache')).toEqual([]);
  });
});

describe('remapLegacyPath', () => {
  const posix = legacyPathRoots(['/home/u/.config/Old'], '/home/u/.config/New', '/srv/cache');
  const win = legacyPathRoots(['C:\\Users\\u\\AppData\\Roaming\\Old'], 'C:\\Users\\u\\AppData\\Roaming\\New', 'C:\\Users\\u\\AppData\\Roaming\\New\\cache');

  it('POSIX: the default cache maps to the cache folder, other paths to the user-data folder', () => {
    expect(remapLegacyPath('/home/u/.config/Old/cache/proxies/k_540p_all.mp4', posix)).toBe('/srv/cache/proxies/k_540p_all.mp4');
    expect(remapLegacyPath('/home/u/.config/Old/whisper/models/m.bin', posix)).toBe('/home/u/.config/New/whisper/models/m.bin');
  });
  it('POSIX is case-sensitive and needs a separator after the root', () => {
    expect(remapLegacyPath('/home/u/.config/old/cache/x.mp4', posix)).toBeNull();
    expect(remapLegacyPath('/home/u/.config/Older/cache/x.mp4', posix)).toBeNull();
    expect(remapLegacyPath('/home/u/.config/Old', posix)).toBeNull();
    expect(remapLegacyPath('/elsewhere/x.mp4', posix)).toBeNull();
  });
  it('Windows: case-insensitive, either separator, result in Windows form', () => {
    expect(remapLegacyPath('c:\\users\\U\\appdata\\roaming\\old\\cache\\proxies\\k.mp4', win))
      .toBe('C:\\Users\\u\\AppData\\Roaming\\New\\cache\\proxies\\k.mp4');
    expect(remapLegacyPath('C:/Users/u/AppData/Roaming/Old/cache/channel/k.m4a', win))
      .toBe('C:\\Users\\u\\AppData\\Roaming\\New\\cache\\channel\\k.m4a');
  });
  it('never climbs out of the target with ..', () => {
    expect(remapLegacyPath('/home/u/.config/Old/cache/../../../etc/passwd', posix)).toBeNull();
  });
  it('no roots: null', () => {
    expect(remapLegacyPath('/home/u/.config/Old/cache/x.mp4', [])).toBeNull();
  });
});

describe('verifyProxies with a moved user-data folder', () => {
  const OLD = '/home/u/.config/Old';
  const NEW = '/home/u/.config/New';
  let files: Set<string>;
  let appInfoCalls = 0;
  const g = globalThis as unknown as Record<string, unknown>;

  function install(roots: AppInfo['legacyPathRoots']): void {
    appInfoCalls = 0;
    const api = {
      appInfo: async () => { appInfoCalls++; return { legacyPathRoots: roots } as AppInfo; },
      stat: async (p: string): Promise<FileStat> => ({ exists: files.has(p) }),
    } as unknown as RecutApi;
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
    install(legacyPathRoots([OLD], NEW, `${NEW}/cache`));
    addMedia('a', `${OLD}/cache/proxies/a_540p_all.mp4`);
    addMedia('b', `${OLD}/cache/proxies/b_540p_all.mp4`);
    addMedia('c', '/media/proxies/c.mp4');
    files.add(`${NEW}/cache/proxies/a_540p_all.mp4`); // moved with the folder
    // b: not in the new folder either; c: outside any legacy root.
    const gone = await verifyProxies();
    expect(gone.sort()).toEqual(['b', 'c']);
    const media = useStore.getState().project.media;
    expect(media.a.proxy).toMatchObject({ status: 'ready', path: `${NEW}/cache/proxies/a_540p_all.mp4` });
    expect(media.b.proxy.status).toBe('none');
    expect(media.c.proxy.status).toBe('none');
    expect(appInfoCalls).toBe(1);
  });

  it('an existing proxy is left alone, and without legacy roots nothing is remapped', async () => {
    install([]);
    addMedia('a', `${OLD}/cache/proxies/a.mp4`);
    addMedia('b', `${OLD}/cache/proxies/b.mp4`);
    files.add(`${OLD}/cache/proxies/a.mp4`);
    files.add(`${NEW}/cache/proxies/b.mp4`);
    expect(await verifyProxies()).toEqual(['b']);
    expect(useStore.getState().project.media.a.proxy.path).toBe(`${OLD}/cache/proxies/a.mp4`);
  });

  it('relocatedCachePath (used by the channel-proxy check) finds the moved file or returns null', async () => {
    install(legacyPathRoots([OLD], NEW, `${NEW}/cache`));
    files.add(`${NEW}/cache/channel/x.m4a`);
    const api = g.recut as RecutApi;
    expect(await relocatedCachePath(api, `${OLD}/cache/channel/x.m4a`)).toBe(`${NEW}/cache/channel/x.m4a`);
    expect(await relocatedCachePath(api, `${OLD}/cache/channel/y.m4a`)).toBeNull();
    expect(await relocatedCachePath(api, '/other/x.m4a')).toBeNull();
  });
});
