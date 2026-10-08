/**
 * File › Export Timeline… (Roadmap §10): writes the files `exportTimeline` (shared/interchange) made in the
 * renderer, IPC `interchange:write`. Pure Node (no Electron imports), like electron/fs.ts.
 *
 * Only plain `.fcpxml` / `.otio` / `.edl` file names inside an existing absolute folder are written; a target that
 * is the same file as one of the project's sources (`protectedPaths`, by canonical path or device + inode, see
 * electron/pathSafety.ts) or exists and is not a regular file is refused, and existing files are only replaced
 * with `overwrite`. Every file is written atomically (temp file in the same folder, fsync, rename; no `.bak`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './project/io';
import { findSameFile } from './pathSafety';
import type { InterchangeWriteResult } from '../shared/ipc';

const EXT = /\.(?:fcpxml|otio|edl)$/i;
/** More files than any sequence has video tracks (one EDL per track); a bound on what the renderer may send. */
export const INTERCHANGE_MAX_FILES = 256;

function plainName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[/\\\0]/.test(name)
    && name !== '.' && name !== '..' && EXT.test(name);
}

export async function writeInterchangeFiles(req: unknown): Promise<InterchangeWriteResult> {
  const r = (req ?? {}) as { folder?: unknown; files?: unknown; protectedPaths?: unknown; overwrite?: unknown };
  const { folder, files, protectedPaths } = r;
  if (typeof folder !== 'string' || folder === '' || folder.includes('\0') || !path.isAbsolute(folder)) {
    return { ok: false, error: `Timeline export needs a full folder path, not "${String(folder)}".` };
  }
  if (!Array.isArray(files) || files.length === 0 || files.length > INTERCHANGE_MAX_FILES) {
    return { ok: false, error: 'Timeline export needs between 1 and 256 files to write.' };
  }
  if (!Array.isArray(protectedPaths)) return { ok: false, error: 'Timeline export needs the list of project source files.' };
  const st = fs.statSync(folder, { throwIfNoEntry: false });
  if (!st?.isDirectory()) return { ok: false, error: `The folder "${folder}" does not exist.` };

  const seen = new Set<string>();
  const targets: { target: string; contents: string }[] = [];
  for (const f of files as { name?: unknown; contents?: unknown }[]) {
    if (!f || !plainName(f.name)) return { ok: false, error: `Timeline export only writes .fcpxml, .otio or .edl file names, not "${String(f?.name)}".` };
    if (typeof f.contents !== 'string') return { ok: false, error: `The contents of "${f.name}" must be text.` };
    const key = f.name.toLowerCase();
    if (seen.has(key)) return { ok: false, error: `Two files are named "${f.name}".` };
    seen.add(key);
    targets.push({ target: path.join(folder, f.name), contents: f.contents });
  }

  const existing: string[] = [];
  for (const { target } of targets) {
    const hit = findSameFile(target, protectedPaths);
    if (hit !== undefined) {
      return { ok: false, error: `Refusing to write "${target}": that file is a source file of the project (${hit}). Choose a different name or folder.` };
    }
    const ex = fs.statSync(target, { throwIfNoEntry: false });
    if (ex && !ex.isFile()) return { ok: false, error: `Refusing to write "${target}": it exists and is not a file.` };
    if (ex) existing.push(target);
  }
  if (existing.length && r.overwrite !== true) {
    return { ok: false, code: 'exists', existing, error: `${existing.length === 1 ? 'A file' : `${existing.length} files`} with ${existing.length === 1 ? 'that name exists' : 'those names exist'} already.` };
  }
  for (const { target, contents } of targets) await atomicWriteFile(target, contents, { backup: false });
  return { ok: true, paths: targets.map((t) => t.target) };
}
