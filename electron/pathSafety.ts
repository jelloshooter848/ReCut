/**
 * Main-process path identity for "would this write replace a project source file?" checks. Unlike the
 * renderer's lexical check (shared/pathKey.ts) it follows symlinks (realpath) and recognizes hard links and
 * case-insensitive volumes by device + inode, so an aliased spelling of a source path is still caught.
 * Pure Node (no Electron).
 */
import fs from 'node:fs';
import path from 'node:path';
import { foldsPathCase } from '../shared/pathKey';

/**
 * Canonical form of a path for comparisons: realpath when it exists, else realpath(dir)/basename,
 * else path.resolve. (Same contract as `canonicalPath` in electron/export/exporter.ts.)
 */
export function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  try { return fs.realpathSync.native(abs); } catch { /* does not exist (yet) */ }
  try { return path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs)); } catch { return abs; }
}

/** Comparison key: canonical path, case-folded where the platform's file systems fold names. */
function compareKey(p: string, platform: string | undefined): string {
  const c = canonicalPath(p);
  return foldsPathCase(platform) ? c.toLowerCase() : c;
}

/**
 * (device, inode) of an existing file, following symlinks; null when it does not exist, cannot be
 * stat-ed, or its file system reports no inode numbers (ino 0), where only the path comparison applies.
 */
export function fileIdentity(p: string): { dev: bigint; ino: bigint } | null {
  let st: fs.BigIntStats | undefined;
  try { st = fs.statSync(p, { bigint: true, throwIfNoEntry: false }); } catch { return null; }
  if (!st || st.ino === 0n) return null;
  return { dev: st.dev, ino: st.ino };
}

/**
 * The first of `candidates` that is the same file as `target`: equal canonical paths (case-folded on
 * win32 / darwin, and when `platform` is unknown), or, when both exist, the same device and inode.
 * Non-string / empty / NUL-containing candidates are ignored.
 */
export function findSameFile(target: string, candidates: readonly unknown[], platform: string | undefined = process.platform): string | undefined {
  const key = compareKey(target, platform);
  const id = fileIdentity(target);
  for (const c of candidates) {
    if (typeof c !== 'string' || c === '' || c.includes('\0')) continue;
    if (compareKey(c, platform) === key) return c;
    if (id) {
      const other = fileIdentity(c);
      if (other && other.dev === id.dev && other.ino === id.ino) return c;
    }
  }
  return undefined;
}
