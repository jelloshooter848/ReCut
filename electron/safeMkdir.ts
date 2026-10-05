/**
 * Safe directory creation for user-supplied paths (docs/acceptance.md BUG-1).
 *
 * `fs.mkdir(p, { recursive: true })` never returns for paths under /proc (libuv retries forever), which
 * froze the main process (sync) or leaked a threadpool thread (async). This helper never uses recursive
 * mkdir: it walks up to the first existing ancestor with stat, refuses pseudo file systems and
 * non-directories, then creates the missing components one non-recursive mkdir at a time, all under a
 * timeout. Pure Node, no Electron.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Linux pseudo file systems where creating folders is never meaningful. */
const PSEUDO_ROOTS = ['/proc', '/sys', '/dev'];

export const MKDIR_TIMEOUT_MS = 5000;

function isUnder(p: string, root: string): boolean {
  return p === root || p.startsWith(root + path.sep);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

async function ensure(dir: string, platform: NodeJS.Platform): Promise<void> {
  const abs = path.resolve(dir);
  if (platform === 'linux') {
    const bad = PSEUDO_ROOTS.find((r) => isUnder(abs, r));
    if (bad) throw new Error(`"${abs}" is on a system pseudo file system (${bad}).`);
  }
  // First existing ancestor.
  const missing: string[] = [];
  let cur = abs;
  for (;;) {
    let isDir: boolean;
    try {
      isDir = (await fsp.stat(cur)).isDirectory();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOTDIR') throw new Error(`A part of "${abs}" exists and is not a folder.`);
      if (code !== 'ENOENT') throw new Error(`Cannot access "${cur}": ${code ?? String(e)}`);
      const parent = path.dirname(cur);
      if (parent === cur) throw new Error(`No existing parent folder for "${abs}".`);
      missing.push(cur);
      cur = parent;
      continue;
    }
    if (!isDir) throw new Error(`"${cur}" exists and is not a folder.`);
    break;
  }
  if (platform === 'linux') {
    // The existing ancestor may be a symlink into a pseudo file system.
    let real = cur;
    try { real = await fsp.realpath(cur); } catch { /* keep cur */ }
    const bad = PSEUDO_ROOTS.find((r) => isUnder(real, r));
    if (bad) throw new Error(`"${abs}" is on a system pseudo file system (${bad}).`);
  }
  for (const d of missing.reverse()) {
    try { await fsp.mkdir(d); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

/**
 * Creates `dir` (and missing parents) without recursive mkdir. Resolves when the folder exists;
 * rejects with a readable message when it cannot be created or the attempt exceeds `timeoutMs`.
 */
export async function ensureDirSafe(dir: string, opts: { timeoutMs?: number; platform?: NodeJS.Platform } = {}): Promise<void> {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('No folder given.');
  await withTimeout(ensure(dir, opts.platform ?? process.platform), opts.timeoutMs ?? MKDIR_TIMEOUT_MS, `Creating "${dir}"`);
}
