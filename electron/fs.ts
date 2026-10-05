/**
 * Filesystem helpers exposed to the renderer over IPC. Pure Node (no Electron imports).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './project/io';
import { findSameFile } from './pathSafety';
import type { FileStat, RelinkCandidate, RelinkScanRequest, SubtitleWriteResult } from '../shared/ipc';

export interface DirEntry { name: string; path: string; isDirectory: boolean; size: number }

export async function stat(p: string): Promise<FileStat> {
  try {
    const st = await fsp.stat(p);
    return { exists: true, size: st.size, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() };
  } catch {
    return { exists: false };
  }
}

export async function readText(p: string): Promise<string> {
  return fsp.readFile(p, 'utf8');
}

const SUBTITLE_EXT = /\.(?:srt|vtt)$/i;

/**
 * Subtitle export writer (IPC `subtitles:export`). Refuses anything but an absolute `.srt` / `.vtt` path,
 * a target that exists and is not a regular file, and a target that is the same file as one of
 * `protectedPaths` (the project's sources, sent by the renderer) by canonical path or device + inode
 * (electron/pathSafety.ts), so symlinked folder aliases, hard links and case variants are caught here even
 * though the renderer's pre-check is lexical. Then writes UTF-8 atomically (temp file in the same folder,
 * fsync, rename over the target; parent folders created safely): a failure never leaves a truncated file,
 * and no `.bak` is left next to user files. I/O errors reject.
 */
export async function writeSubtitleFile(
  target: string, content: string, protectedPaths: readonly string[], opts: { platform?: string } = {},
): Promise<SubtitleWriteResult> {
  if (typeof target !== 'string' || target === '' || target.includes('\0') || !path.isAbsolute(target)) {
    return { ok: false, error: `Subtitle export needs a full file path, not "${String(target)}".` };
  }
  if (!SUBTITLE_EXT.test(target)) return { ok: false, error: `Subtitle export only writes .srt or .vtt files, not "${target}".` };
  if (typeof content !== 'string') return { ok: false, error: 'Subtitle export content must be text.' };
  if (!Array.isArray(protectedPaths)) return { ok: false, error: 'Subtitle export needs the list of project source files.' };
  const hit = findSameFile(target, protectedPaths, opts.platform ?? process.platform);
  if (hit !== undefined) {
    return { ok: false, error: `Refusing to export subtitles to "${target}": that file is a source file of the project (${hit}). Choose a different file name or folder.` };
  }
  const existing = fs.statSync(target, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) return { ok: false, error: `Refusing to export subtitles to "${target}": it exists and is not a file.` };
  await atomicWriteFile(target, content, { backup: false });
  return { ok: true, path: target };
}

export async function listDir(p: string): Promise<DirEntry[]> {
  const entries = await fsp.readdir(p, { withFileTypes: true });
  const out: DirEntry[] = [];
  for (const e of entries) {
    const full = path.join(p, e.name);
    let isDirectory = e.isDirectory();
    let size = 0;
    try {
      const st = await fsp.stat(full); // follows symlinks
      isDirectory = st.isDirectory();
      size = st.isFile() ? st.size : 0;
    } catch { /* broken symlink / permission: keep dirent info */ }
    out.push({ name: e.name, path: full, isDirectory, size });
  }
  out.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return out;
}

export const RELINK_SCAN_CAP = 200_000;
const SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * Recursively walk `req.folder` looking for the missing files by basename (case-insensitive).
 * Confidence is 'name+size' when the size matches the recorded size, else 'name'.
 * Caps at RELINK_SCAN_CAP directory entries, skips node_modules/.git, does not follow symlinked
 * directories, and never throws on permission errors.
 */
export async function scanForRelink(req: RelinkScanRequest): Promise<RelinkCandidate[]> {
  const byName = new Map<string, { mediaId: string; fileName: string; size?: number }[]>();
  for (const m of req.missing ?? []) {
    if (!m || typeof m.fileName !== 'string' || !m.fileName) continue;
    const key = path.basename(m.fileName).toLowerCase();
    const list = byName.get(key) ?? [];
    list.push(m);
    byName.set(key, list);
  }
  const out: RelinkCandidate[] = [];
  if (byName.size === 0 || typeof req.folder !== 'string' || !req.folder) return out;

  let visited = 0;
  const queue: string[] = [path.resolve(req.folder)];
  while (queue.length > 0 && visited < RELINK_SCAN_CAP) {
    const dir = queue.shift()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // permission denied, vanished, not a directory
    }
    for (const e of entries) {
      if (++visited > RELINK_SCAN_CAP) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(full);
        continue;
      }
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      const matches = byName.get(e.name.toLowerCase());
      if (!matches) continue;
      let size: number | null = null;
      try {
        const st = await fsp.stat(full);
        if (!st.isFile()) continue;
        size = st.size;
      } catch {
        continue;
      }
      for (const m of matches) {
        const confidence: RelinkCandidate['confidence'] = typeof m.size === 'number' && m.size === size ? 'name+size' : 'name';
        out.push({ missingMediaId: m.mediaId, path: full, confidence });
      }
    }
  }
  // Best candidates first: size matches before name-only, then stable by path.
  out.sort((a, b) => {
    if (a.missingMediaId !== b.missingMediaId) return a.missingMediaId < b.missingMediaId ? -1 : 1;
    if (a.confidence !== b.confidence) return a.confidence === 'name+size' ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return out;
}
