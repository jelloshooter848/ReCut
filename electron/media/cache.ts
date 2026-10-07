/**
 * On-disk cache layout for derived media (thumbnails, waveforms, proxies, scene detection, OCR and transcription results).
 *
 * Keys (bugs/closed/2026-10-05-moved-media-cache-miss.md):
 *  - `cacheKeyForPath` is the file's CONTENT key (./identity.ts: size + a sampled fingerprint, no path, no mtime), so
 *    derived media survive moving, renaming, copying, relinking and Collect Project. New entries are written under it.
 *  - The pre-0.10 key, `cacheKeyForFile` (sha1 of path + size + mtime), is kept as a read-only fallback: a lookup
 *    that misses under the content key tries the legacy key (`findCachedFile`) and adopts a hit under the content key
 *    (a hard link), so caches made by older versions are reused, never mass-invalidated.
 *  - Computing a content key reads ~0.6 MB of the file. It is remembered in memory and on disk (`ids/<legacy key>`,
 *    valid while the file keeps its path, size and mtime), so a file is fingerprinted once, not once per request.
 *
 * No Electron import here: main.ts calls `setCacheDir(path.join(app.getPath('userData'), 'cache'))`
 * at startup; tests set RECUT_CACHE_DIR.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertAbsoluteMediaPath } from './ffmpeg';
import { fingerprintFile } from './identity';

/** `ids`: the content-key index (legacy key -> content key, see cacheKeysForPath). */
export type CacheSubdir = 'thumbs' | 'waves' | 'proxies' | 'scenes' | 'ocr' | 'ids' | 'whisper';
export const CACHE_SUBDIRS: CacheSubdir[] = ['thumbs', 'waves', 'proxies', 'scenes', 'ocr', 'ids', 'whisper'];

let configuredDir: string | null = null;

/** Set the default cache root (normally `<userData>/cache`). RECUT_CACHE_DIR still takes precedence. */
export function setCacheDir(dir: string): void {
  configuredDir = dir;
}

/** Resolve the cache root: env RECUT_CACHE_DIR → setCacheDir() → <tmp>/recut-cache. */
export function getCacheDir(): string {
  const env = process.env.RECUT_CACHE_DIR;
  if (env && env.trim()) return path.resolve(env);
  if (configuredDir) return configuredDir;
  return path.join(os.tmpdir(), 'recut-cache');
}

/** Path of a cache subdirectory (created on demand). */
export function cacheSubdir(sub: CacheSubdir): string {
  const dir = path.join(getCacheDir(), sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * The LEGACY (pre-0.10) cache key: sha1 of path + size + mtime. It changes when the file moves, so it is only a
 * fallback lookup for entries older versions wrote, and the index key of the content key (cacheKeysForPath).
 */
export function cacheKeyForFile(filePath: string, size: number, mtimeMs: number): string {
  const h = createHash('sha1');
  h.update(path.resolve(filePath));
  h.update('\0');
  h.update(String(size));
  h.update('\0');
  h.update(String(Math.floor(mtimeMs)));
  return h.digest('hex');
}

/** Content key of a file from its size and fingerprint (./identity.ts). 40 hex characters, like the legacy key. */
export function contentCacheKey(size: number, fingerprint: string): string {
  return createHash('sha1').update(`recut-content-key\0${size}\0${fingerprint}`).digest('hex');
}

/** Both keys of a media file: write under `key`; `legacyKey` is a read-only fallback for older cache entries. */
export interface MediaCacheKeys {
  /** Content key: the same for every copy of the file, wherever it is. */
  key: string;
  /** Pre-0.10 path + size + mtime key. */
  legacyKey: string;
  size: number;
}

/** In-memory index: legacy key (path + size + mtime) -> content key. */
const contentKeyMemo = new Map<string, Promise<string>>();
const MEMO_MAX = 4096;
const HEX40 = /^[0-9a-f]{40}$/;

/** For tests and diagnostics: how many files were actually fingerprinted (read). */
export const identityStats = { fingerprinted: 0 };

/** Forget the in-memory content-key index (tests; the on-disk index stays). */
export function resetContentKeyMemo(): void {
  contentKeyMemo.clear();
}

async function contentKeyFor(filePath: string, size: number, legacyKey: string): Promise<string> {
  const indexFile = path.join(cacheSubdir('ids'), legacyKey);
  try {
    const known = (await fsp.readFile(indexFile, 'utf8')).trim();
    if (HEX40.test(known)) return known;
  } catch { /* not indexed yet */ }
  identityStats.fingerprinted++;
  const key = contentCacheKey(size, await fingerprintFile(filePath, size));
  const part = `${indexFile}.part-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fsp.writeFile(part, key);
    await fsp.rename(part, indexFile);
  } catch {
    await removeQuietly(part); // the index is an optimisation only
  }
  return key;
}

/**
 * Stat the file and compute both of its cache keys. Throws if the file is missing or the path is not absolute.
 * The content key is fingerprinted at most once per path + size + mtime (memory, then the `ids` index on disk).
 */
export async function cacheKeysForPath(filePath: string): Promise<MediaCacheKeys> {
  assertAbsoluteMediaPath(filePath); // a source media path: never resolved against the working directory
  const st = await fsp.stat(filePath);
  const legacyKey = cacheKeyForFile(filePath, st.size, st.mtimeMs);
  let p = contentKeyMemo.get(legacyKey);
  if (!p) {
    const created = contentKeyFor(filePath, st.size, legacyKey);
    p = created;
    contentKeyMemo.set(legacyKey, created);
    created.catch(() => { if (contentKeyMemo.get(legacyKey) === created) contentKeyMemo.delete(legacyKey); });
    if (contentKeyMemo.size > MEMO_MAX) contentKeyMemo.delete(contentKeyMemo.keys().next().value as string);
  }
  return { key: await p, legacyKey, size: st.size };
}

/**
 * The cache key of a media file: its CONTENT key, which survives moves, renames and copies. Throws if the file is
 * missing or the path is not absolute. Any new cache keyed on a media file should use this (and findCachedFile with
 * cacheKeysForPath only when it has entries from before 0.10 to keep).
 */
export async function cacheKeyForPath(filePath: string): Promise<string> {
  return (await cacheKeysForPath(filePath)).key;
}

/**
 * Make an entry found under the legacy key available under the content key: a hard link (no copy, no extra disk).
 * Returns the path to use: `primary` when linked (or it appeared meanwhile), else `legacy` (hard links refused, e.g.
 * a cache folder on FAT / exFAT: the legacy entry is still served, just not adopted).
 */
export async function adoptLegacyEntry(legacy: string, primary: string): Promise<string> {
  try {
    await fsp.mkdir(path.dirname(primary), { recursive: true });
    await fsp.link(legacy, primary);
    return primary;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return primary;
    return legacy;
  }
}

/**
 * Look a cache entry up under the content key, then under the legacy key (adopting a legacy hit, adoptLegacyEntry).
 * `pathFor(key)` is the entry's file for a key; `accept(file)` (default: it is a file) may reject a corrupt entry.
 * Returns the file to read, or null on a miss (then write the new entry to `pathFor(keys.key)`).
 */
export async function findCachedFile(
  keys: Pick<MediaCacheKeys, 'key' | 'legacyKey'>,
  pathFor: (key: string) => string,
  accept: (file: string) => Promise<boolean> = fileExists,
): Promise<string | null> {
  const primary = pathFor(keys.key);
  if (await accept(primary)) return primary;
  if (keys.legacyKey === keys.key) return null;
  const legacy = pathFor(keys.legacyKey);
  if (!(await accept(legacy))) return null;
  return adoptLegacyEntry(legacy, primary);
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/** Remove a file, ignoring errors (used for `.part` cleanup). */
export async function removeQuietly(p: string): Promise<void> {
  try { await fsp.rm(p, { force: true }); } catch { /* ignore */ }
}

/** Approximate total size of the cache in bytes (walks the tree). */
export async function cacheSizeBytes(): Promise<number> {
  const root = getCacheDir();
  let total = 0;
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        try { total += (await fsp.stat(p)).size; } catch { /* ignore */ }
      }
    }
  }
  await walk(root);
  return total;
}
