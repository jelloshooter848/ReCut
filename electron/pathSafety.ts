/**
 * Main-process path identity for "would this write replace a project source file?" checks. Unlike the
 * renderer's lexical check (shared/pathKey.ts) it follows symlinks (realpath), recognizes hard links by device +
 * inode and folds case on every platform, so an aliased spelling of a source path is still caught.
 * Pure Node (no Electron).
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Canonical form of a path for comparisons: realpath when it exists, else realpath(dir)/basename,
 * else path.resolve. (Same contract as `canonicalPath` in electron/export/exporter.ts.)
 */
export function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  try { return fs.realpathSync.native(abs); } catch { /* does not exist (yet) */ }
  try { return path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs)); } catch { return abs; }
}

/**
 * Comparison key: canonical path, case-folded on every platform (the video export rule in
 * electron/export/renderGraph.ts assertOutputNotASource). A case-sensitive volume can hold two files that differ
 * only in case; refusing to write the other one is harmless, while not folding misses a case-insensitive volume
 * mounted on Linux (vfat / exFAT / NTFS / SMB) or a case-insensitive APFS volume.
 */
function compareKey(p: string): string {
  return canonicalPath(p).toLowerCase();
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
 * The first of `candidates` that is the same file as `target`: equal canonical paths (case-folded on every
 * platform), or, when both exist, the same device and inode. Non-string / empty / NUL-containing candidates are
 * ignored. `_platform` is accepted for callers that pass it; the comparison no longer depends on it.
 */
export function findSameFile(target: string, candidates: readonly unknown[], _platform?: string): string | undefined {
  const key = compareKey(target);
  const id = fileIdentity(target);
  for (const c of candidates) {
    if (typeof c !== 'string' || c === '' || c.includes('\0')) continue;
    if (compareKey(c) === key) return c;
    if (id) {
      const other = fileIdentity(c);
      if (other && other.dev === id.dev && other.ino === id.ino) return c;
    }
  }
  return undefined;
}
