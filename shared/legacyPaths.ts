/**
 * The roots for remapping absolute paths that point into a legacy user-data folder.
 *
 * Projects store absolute paths into the cache (MediaItem.proxy.path, channelProxies[*].path), by default under
 * `<userData>/cache`. When the user-data folder moved (electron/userDataMigration.ts), such a path no longer exists;
 * the same file is usually at the same relative path under the current folder. The main process matches paths
 * against these roots in their real form (electron/legacyPathRemap.ts, IPC `fs:relocateLegacyPath`), and the
 * renderer's proxy checks (src/state/mediaActions.ts verifyProxies, src/app/channelProxies.ts) ask it before calling
 * a file missing.
 *
 * Pure: no DOM, no Node. Paths may be Windows or POSIX paths whatever the platform running this code.
 */

/** A path under `from` is looked for at the same relative path under `to`. */
export interface PathRoot { from: string; to: string }

const isWindowsPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');

function trimSep(p: string): string {
  let s = p;
  while (s.length > 1 && /[\\/]$/.test(s) && !/^[A-Za-z]:[\\/]$/.test(s)) s = s.slice(0, -1);
  return s;
}

/**
 * The roots for legacy user-data folders `legacyDirs`: their default cache (`<legacy>/cache`) maps to the current
 * cache folder, anything else under them to the current user-data folder. Roots equal to their target are dropped.
 */
export function legacyPathRoots(legacyDirs: readonly string[], userData: string, cacheDir: string): PathRoot[] {
  const out: PathRoot[] = [];
  for (const dir of legacyDirs) {
    if (!dir) continue;
    const sep = isWindowsPath(dir) ? '\\' : '/';
    const base = trimSep(dir);
    out.push({ from: `${base}${sep}cache`, to: cacheDir }, { from: base, to: userData });
  }
  return out.filter((r) => !samePath(r.from, r.to));
}

function samePath(a: string, b: string): boolean {
  const win = isWindowsPath(a) || isWindowsPath(b);
  const norm = (p: string) => { const t = trimSep(win ? p.replace(/\//g, '\\') : p); return win ? t.toLowerCase() : t; };
  return norm(a) === norm(b);
}
