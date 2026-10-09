/**
 * Finding a cache file saved under a legacy user-data folder (shared/legacyPaths.ts roots) at its place under the
 * current folder. Paths are compared in their real form: each is resolved, separators normalised, its longest existing
 * ancestor passed through realpath (so `/var/…` and `/private/var/…` on macOS, or a Windows 8.3 short name such as
 * `C:\Users\RUNNER~1\…` and its long form, compare equal), and case-folded on Windows and macOS. Both the real and the
 * merely resolved form of each side are tried, so a path written either way matches.
 *
 * No Electron imports: electron/ipc.ts serves it as `fs:relocateLegacyPath`; unit tests drive it with injected
 * realpath / exists functions and either platform's path rules.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PathRoot } from '../shared/legacyPaths';

export interface RemapEnv {
  platform?: NodeJS.Platform;
  /** realpath of an existing path; throws when it does not exist (default fs.realpathSync.native). */
  realpath?(p: string): string;
  /** Whether a file exists at `p` (default fs.existsSync). */
  exists?(p: string): boolean;
}

const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);
const folds = (platform: NodeJS.Platform) => platform === 'win32' || platform === 'darwin';

/** `p` resolved, with its longest existing ancestor replaced by that ancestor's real path. */
export function canonicalPath(p: string, env: RemapEnv = {}): string {
  const platform = env.platform ?? process.platform;
  const P = pathFor(platform);
  const realpath = env.realpath ?? ((x: string) => fs.realpathSync.native(x));
  const resolved = P.resolve(platform === 'win32' ? p.replace(/\//g, '\\') : p);
  const rest: string[] = [];
  let cur = resolved;
  for (;;) {
    try {
      const real = realpath(cur);
      return rest.length ? P.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = P.dirname(cur);
      if (parent === cur) return resolved;
      rest.push(P.basename(cur));
      cur = parent;
    }
  }
}

/**
 * A function that maps a missing path under one of `roots` (longest root first) to the same relative path under the
 * root's target, returning it only when a file exists there; null otherwise.
 */
export function createLegacyPathRemapper(roots: readonly PathRoot[], env: RemapEnv = {}): (p: string) => string | null {
  const platform = env.platform ?? process.platform;
  const P = pathFor(platform);
  const exists = env.exists ?? ((x: string) => fs.existsSync(x));
  const fold = (s: string) => (folds(platform) ? s.toLowerCase() : s);
  const forms = (p: string) => [...new Set([canonicalPath(p, env), P.resolve(platform === 'win32' ? p.replace(/\//g, '\\') : p)])];
  const sorted = [...roots].filter((r) => r.from && r.to).sort((a, b) => b.from.length - a.from.length)
    .map((r) => ({ to: r.to, froms: forms(r.from).map((f) => ({ raw: f, key: fold(f) })) }));
  return (p: string) => {
    if (typeof p !== 'string' || !p) return null;
    const pForms = forms(p).map((f) => ({ raw: f, key: fold(f) }));
    for (const r of sorted) {
      for (const from of r.froms) {
        const prefix = from.key.endsWith(P.sep) ? from.key : from.key + P.sep;
        for (const pf of pForms) {
          if (!pf.key.startsWith(prefix)) continue;
          const rel = pf.raw.slice(prefix.length);
          if (!rel) continue;
          const candidate = P.join(r.to, rel);
          if (fold(canonicalPath(candidate, env)) === pf.key) continue; // the root maps onto itself
          if (exists(candidate)) return candidate;
        }
      }
    }
    return null;
  };
}
