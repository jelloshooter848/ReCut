/**
 * Pure path comparison for "is this output one of the project's source files?" checks done in the renderer,
 * where `node:path` is not available. Mirrors electron/export/renderGraph.ts `assertOutputNotASource`
 * (path.resolve, then case-folded on win32 / darwin) for absolute paths: `.` and `..` segments, repeated
 * and trailing separators are collapsed lexically, and on Windows `/` and `\` are equivalent.
 *
 * It does not follow symlinks (the renderer cannot); the main-process exporter additionally canonicalizes
 * with realpath. Pure: no DOM, no Node.
 */

/** Platforms whose default file systems compare names case-insensitively. Unknown → fold (stricter). */
export function foldsPathCase(platform: string | undefined): boolean {
  return platform === undefined || platform === 'win32' || platform === 'darwin';
}

function looksWindows(p: string, platform: string | undefined): boolean {
  if (platform !== undefined) return platform === 'win32';
  return /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(p);
}

/**
 * Lexically resolved form of an absolute path (what `path.resolve` returns for it on `platform`), or null
 * when `p` is not absolute (relative, drive-relative `C:foo`, or rooted without a drive `\foo` on Windows):
 * those depend on the main process's working directory and cannot be compared here.
 */
export function resolveAbsolutePath(p: string, platform: string | undefined): string | null {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) return null;
  const win = looksWindows(p, platform);
  const sep = win ? '\\' : '/';
  let root: string;
  let rest: string;
  if (win) {
    const s = p.replace(/\//g, '\\');
    const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/.exec(s);
    const drive = /^([A-Za-z]:)\\/.exec(s);
    if (unc) { root = `\\\\${unc[1]}\\${unc[2]}\\`; rest = s.slice(unc[0].length); }
    else if (drive) { root = `${drive[1]}\\`; rest = s.slice(drive[0].length); }
    else return null;
  } else {
    if (!p.startsWith('/')) return null;
    root = '/';
    rest = p;
  }
  const parts: string[] = [];
  for (const seg of rest.split(sep)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return root + parts.join(sep);
}

/** Comparison key for an absolute path on `platform` (resolved, case-folded where the OS folds), or null. */
export function pathCompareKey(p: string, platform: string | undefined): string | null {
  const r = resolveAbsolutePath(p, platform);
  if (r === null) return null;
  return foldsPathCase(platform) ? r.toLowerCase() : r;
}

/** The first of `candidates` that names the same file as `target` (by pathCompareKey), if any. */
export function findSamePath(target: string, candidates: readonly string[], platform: string | undefined): string | undefined {
  const key = pathCompareKey(target, platform);
  if (key === null) return undefined;
  return candidates.find((c) => pathCompareKey(c, platform) === key);
}
