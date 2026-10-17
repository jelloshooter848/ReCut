/**
 * Chromium's HTTP cache and the app's default cache folder
 * (bugs/closed/2026-10-09-default-cache-dir-is-chromium-http-cache.md).
 *
 * The app's default cache folder is `<userData>/cache`. Chromium keeps its HTTP cache in `<sessionData>/Cache`
 * (`<sessionData>` = `<userData>`), and on Windows and macOS, whose file systems ignore case, those are the same folder.
 * With the HTTP cache on, Chromium 130 deletes every entry of that folder except `Cache_Data` at every start
 * (content/browser/network_service_instance_impl.cc MaybeCleanCacheDirectory / MaybeDeleteOldCache), taking the app's
 * proxies, thumbnails, waveforms, scene, OCR and Whisper results with it. main.ts therefore starts Electron with
 * `--disable-http-cache`, which turns that cleanup off and keeps Chromium out of the folder.
 *
 * Profiles made by earlier versions still hold Chromium's leftovers in that folder. `removeStaleChromiumCache` deletes
 * them once, under strict rules:
 *  - only in the DEFAULT cache folder `<userData>/cache` (never a folder the user chose, never RECUT_CACHE_DIR);
 *  - only directories directly inside it whose names are Chromium's own: `Cache_Data` (the cache backend folder,
 *    blockfile or simple cache, created by MaybeCleanCacheDirectory) and `old_Cache_Data_NNN` (a backend folder
 *    Chromium renamed for deletion: net/disk_cache/cache_util.cc GetPrefixedName, `old_<name>_%03d`, 000-099).
 *    Never a file, never a symbolic link, never anything else (the app's subfolders `proxies`, `thumbs`, … or
 *    anything a user put there);
 *  - failures are logged, never thrown.
 *
 * Chromium's backend file names (`index`, `index-dir`, `data_<n>`, `f_<hex>`, `<hex>_0`, `the-real-index`) only exist
 * INSIDE the backend folder in Chromium 96 and later and go with it. At the top of the folder such a name could not be
 * positively identified as Chromium's, so it is not matched there.
 *
 * Pure Node (no Electron import) so vitest can drive it.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Chromium's cache backend folder inside `<sessionData>/Cache` (network_service_instance_impl.cc). */
export const CHROMIUM_CACHE_DATA_DIR = 'Cache_Data';
const OLD_CACHE_DATA_RE = /^old_Cache_Data_\d{3}$/;

/** Whether `name`, directly inside the shared folder, is one of Chromium's HTTP-cache folders. Exact case. */
export function isChromiumCacheEntryName(name: string): boolean {
  return name === CHROMIUM_CACHE_DATA_DIR || OLD_CACHE_DATA_RE.test(name);
}

/** The app's default cache folder: `<userData>/cache` (electron/ipc.ts resolveCacheDir). */
export function defaultCacheDir(userData: string): string {
  return path.join(userData, 'cache');
}

/** Whether `cacheDir` is the default cache folder of `userData` (resolved paths, exact comparison). */
export function isDefaultCacheDir(userData: string, cacheDir: string): boolean {
  return path.resolve(cacheDir) === path.resolve(defaultCacheDir(userData));
}

export interface StaleChromiumCacheOptions {
  userData: string;
  /** The cache folder the app uses (RECUT_CACHE_DIR, else the preference, else the default). */
  cacheDir: string;
  log?: (msg: string) => void;
}

/**
 * Remove Chromium's HTTP-cache folders from the default cache folder (see the file comment for the rules).
 * Returns the paths it removed. Never throws.
 */
export async function removeStaleChromiumCache(o: StaleChromiumCacheOptions): Promise<string[]> {
  const log = o.log ?? ((m: string) => console.log(m));
  const removed: string[] = [];
  if (!isDefaultCacheDir(o.userData, o.cacheDir)) return removed;
  const dir = defaultCacheDir(o.userData);
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log(`cache cleanup: cannot list ${dir}: ${errMsg(e)}`);
    return removed;
  }
  for (const name of names) {
    if (!isChromiumCacheEntryName(name)) continue;
    const p = path.join(dir, name);
    try {
      const st = await fsp.lstat(p);
      if (!st.isDirectory()) continue; // a file or a symbolic link of that name is not Chromium's folder
      await fsp.rm(p, { recursive: true, force: true, maxRetries: 2 });
      removed.push(p);
    } catch (e) {
      log(`cache cleanup: could not remove Chromium's ${p}: ${errMsg(e)}`);
    }
  }
  if (removed.length) log(`cache cleanup: removed Chromium's HTTP cache from the cache folder: ${removed.join(', ')}`);
  return removed;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
