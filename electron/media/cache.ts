/**
 * On-disk cache layout for derived media (thumbnails, waveforms, proxies, scene detection).
 *
 * No Electron import here: main.ts calls `setCacheDir(path.join(app.getPath('userData'), 'cache'))`
 * at startup; tests set RECUT_CACHE_DIR.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export type CacheSubdir = 'thumbs' | 'waves' | 'proxies' | 'scenes';
export const CACHE_SUBDIRS: CacheSubdir[] = ['thumbs', 'waves', 'proxies', 'scenes'];

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

/** sha1 of path + size + mtime — changes whenever the source file changes. */
export function cacheKeyForFile(filePath: string, size: number, mtimeMs: number): string {
  const h = createHash('sha1');
  h.update(path.resolve(filePath));
  h.update('\0');
  h.update(String(size));
  h.update('\0');
  h.update(String(Math.floor(mtimeMs)));
  return h.digest('hex');
}

/** Stat the file and compute its cache key. Throws if the file is missing. */
export async function cacheKeyForPath(filePath: string): Promise<string> {
  const st = await fsp.stat(filePath);
  return cacheKeyForFile(filePath, st.size, st.mtimeMs);
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
