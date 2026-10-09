/**
 * User-data folder migration: when the per-user data folder name changes (shared/productIdentity.ts
 * USER_DATA_DIR_NAME vs LEGACY_USER_DATA_DIR_NAMES), the first launch moves the legacy folder (preferences, Local
 * Storage, the untitled autosave, caches, OCR languages, Whisper models) to the new one. While the names are equal
 * every legacy candidate is the current folder, so nothing is read or written.
 *
 * Runs in the main process before anything touches userData (electron/userDataStartup.ts). Pure Node, no Electron
 * imports: the decision is a pure function (planUserDataMigration) and the side effects (migrateUserData) take their
 * file-system operations, clock and process checks as options, so vitest drives both.
 *
 * Rules:
 *  - Skipped when the folder is overridden (`<prefix>USER_DATA`), when every legacy candidate is the current folder
 *    (equal names, or a case-only difference on a case-insensitive file system), or once the marker exists.
 *  - No legacy folder with data: marker "nothing-to-migrate".
 *  - Both folders hold data: neither is touched (never merged); the current one is used; marker "both-existed" and a
 *    one-time notice.
 *  - The legacy app still runs (its Chromium single-instance lock is held): nothing moves; this session uses the
 *    legacy folder and the user is asked to quit the other app.
 *  - Otherwise `rename` (atomic, instant on one volume). When that fails (another volume, a scanner holding a file):
 *    copy to `<current>.migrating` (Chromium's disposable caches left out), verify file count and sizes, rename it
 *    into place and keep the legacy folder. Marker "moved" or "copied".
 *  - Nothing in the legacy folder is ever deleted or overwritten on a failure path. Any failure: this session uses
 *    the legacy folder, no marker (the next launch tries again), and the caller tells the user once.
 *  - Two launches at once: a lock file next to the current folder lets only one migrate.
 */
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Written into the current folder when the check is settled; its presence ends every later check. */
export const MIGRATION_MARKER = 'user-data-migration.json';

/**
 * Top-level entries of a Chromium profile that are disposable (caches, crash reports) or belong to one running
 * process (singleton locks): not copied, and a folder holding only these counts as empty.
 */
export const DISPOSABLE_ENTRIES: ReadonlySet<string> = new Set([
  // Not Chromium's 'Cache': on Windows and macOS (case-insensitive) it is the same folder as the app's own `cache`.
  'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache',
  'Crashpad', 'Crash Reports', 'SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile', '.DS_Store',
]);

export type MigrationResult = 'moved' | 'copied' | 'nothing-to-migrate' | 'both-existed';

export interface MigrationMarker { from: string | null; at: number; result: MigrationResult; appVersion: string }

// ------------------------------------------------------------------
// Decision (pure)
// ------------------------------------------------------------------

export interface FolderFacts {
  path: string;
  exists: boolean;
  /** Holds anything besides DISPOSABLE_ENTRIES and the marker. */
  hasData: boolean;
}

export interface LegacyFolderFacts extends FolderFacts {
  /** Is the same folder as the current one (equal path, or a case-only difference on a case-insensitive system). */
  sameAsCurrent: boolean;
  /** Its app is running (single-instance lock held). Only needed for the folder that would move. */
  inUse: boolean;
}

export interface MigrationFacts {
  /** The user-data folder is set explicitly (`<prefix>USER_DATA`). */
  overridden: boolean;
  current: FolderFacts & { markerPresent: boolean };
  /** Legacy folders in order of preference. */
  legacy: LegacyFolderFacts[];
}

export type MigrationPlan =
  | { kind: 'skip'; reason: 'override' | 'same-folder' | 'done' }
  | { kind: 'nothing-to-migrate' }
  | { kind: 'both-existed'; legacy: string }
  | { kind: 'legacy-in-use'; legacy: string }
  | { kind: 'move'; legacy: string };

/** What to do at this launch. */
export function planUserDataMigration(f: MigrationFacts): MigrationPlan {
  if (f.overridden) return { kind: 'skip', reason: 'override' };
  const others = f.legacy.filter((l) => !l.sameAsCurrent);
  if (others.length === 0) return { kind: 'skip', reason: 'same-folder' };
  if (f.current.markerPresent) return { kind: 'skip', reason: 'done' };
  const source = others.find((l) => l.exists && l.hasData);
  if (!source) return { kind: 'nothing-to-migrate' };
  if (f.current.hasData) return { kind: 'both-existed', legacy: source.path };
  if (source.inUse) return { kind: 'legacy-in-use', legacy: source.path };
  return { kind: 'move', legacy: source.path };
}

// ------------------------------------------------------------------
// Facts
// ------------------------------------------------------------------

type Fs = Pick<typeof nodeFs,
  'existsSync' | 'readdirSync' | 'lstatSync' | 'statSync' | 'readlinkSync' | 'openSync' | 'closeSync' | 'writeFileSync' | 'readFileSync'
  | 'renameSync' | 'mkdirSync' | 'rmSync' | 'copyFileSync' | 'symlinkSync' | 'utimesSync' | 'unlinkSync'>;

export interface MigrationEnv {
  fs?: Fs;
  platform?: NodeJS.Platform;
  hostname?: string;
  /** Whether process `pid` is alive (default: `process.kill(pid, 0)`). */
  isPidAlive?(pid: number): boolean;
  now?(): number;
  /** Synchronous pause while another launch holds the migration lock. */
  sleep?(ms: number): void;
  log?(message: string): void;
}

function defaultPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

function defaultSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const caseInsensitive = (platform: NodeJS.Platform) => platform === 'win32' || platform === 'darwin';

/** Same folder: equal resolved paths (case-folded on Windows and macOS), or the same directory on disk. */
export function isSameFolder(a: string, b: string, platform: NodeJS.Platform = process.platform, fs: Fs = nodeFs): boolean {
  const ra = path.resolve(a), rb = path.resolve(b);
  if (ra === rb || (caseInsensitive(platform) && ra.toLowerCase() === rb.toLowerCase())) return true;
  try {
    const sa = fs.statSync(ra), sb = fs.statSync(rb);
    return sa.ino !== 0 && sa.dev === sb.dev && sa.ino === sb.ino;
  } catch { return false; }
}

/** Whether `dir` holds anything besides DISPOSABLE_ENTRIES and the marker. */
export function folderHasData(dir: string, fs: Fs = nodeFs): boolean {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return false; }
  return names.some((n) => n !== MIGRATION_MARKER && !DISPOSABLE_ENTRIES.has(n));
}

/**
 * Whether a running app holds the Chromium single-instance lock of profile folder `dir`.
 * POSIX: the `SingletonLock` symlink names `<host>-<pid>`; held when that process is alive on this host (a lock
 * from another host counts as held: that machine may be using the folder). Windows: the running app keeps
 * `lockfile` open without write sharing, so opening it for writing fails.
 */
export function isFolderInUse(dir: string, env: MigrationEnv = {}): boolean {
  const fs = env.fs ?? nodeFs;
  const platform = env.platform ?? process.platform;
  if (platform === 'win32') {
    let fd: number;
    try { fd = fs.openSync(path.join(dir, 'lockfile'), 'r+'); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
    }
    try { fs.closeSync(fd); } catch { /* ignore */ }
    return false;
  }
  let target: string;
  try { target = fs.readlinkSync(path.join(dir, 'SingletonLock')); } catch { return false; }
  const dash = target.lastIndexOf('-');
  const host = dash > 0 ? target.slice(0, dash) : '';
  const pid = Number(target.slice(dash + 1));
  if (!host || !Number.isInteger(pid) || pid <= 0) return false;
  if (host !== (env.hostname ?? os.hostname())) return true;
  return (env.isPidAlive ?? defaultPidAlive)(pid);
}

export interface MigrationOptions extends MigrationEnv {
  /** The folder this launch uses unless the migration says otherwise (`app.getPath('userData')`). */
  current: string;
  /** Legacy folders in order of preference (`<appData>/<legacy name>`). */
  legacy: string[];
  overridden: boolean;
  appVersion: string;
  /** Tests: behave as if renaming the legacy folder failed with EXDEV (moving to another volume). */
  forceCopy?: boolean;
  /** How long to wait for another launch that is migrating (default 20 s). */
  lockWaitMs?: number;
}

export function gatherMigrationFacts(o: MigrationOptions): MigrationFacts {
  const fs = o.fs ?? nodeFs;
  const platform = o.platform ?? process.platform;
  const exists = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const curExists = exists(o.current);
  const current = {
    path: o.current, exists: curExists, hasData: curExists && folderHasData(o.current, fs),
    markerPresent: curExists && fs.existsSync(path.join(o.current, MIGRATION_MARKER)),
  };
  if (o.overridden) return { overridden: true, current, legacy: [] };
  const legacy = o.legacy.map((p) => {
    const sameAsCurrent = isSameFolder(p, o.current, platform, fs);
    const e = !sameAsCurrent && exists(p);
    const hasData = e && folderHasData(p, fs);
    return { path: p, exists: e, hasData, sameAsCurrent, inUse: false };
  });
  // The lock is checked only for the folder that would move.
  const source = legacy.find((l) => !l.sameAsCurrent && l.exists && l.hasData);
  if (source && !current.hasData) source.inUse = isFolderInUse(source.path, o);
  return { overridden: false, current, legacy };
}

// ------------------------------------------------------------------
// Side effects
// ------------------------------------------------------------------

export interface MigrationOutcome {
  /**
   * 'none': nothing to do (skipped; nothing written). 'busy': another launch is migrating right now (this one
   * should quit). 'failed': the move failed; this session uses the legacy folder and the next launch tries again.
   */
  result: MigrationResult | 'none' | 'legacy-in-use' | 'failed' | 'busy';
  /** The folder this session must use. */
  userData: string;
  /** The legacy folder involved, if any. */
  legacy?: string;
  /** Why the move failed ('failed'), or why a rename fell back to a copy ('copied'). */
  error?: string;
  /** For 'none': why. */
  reason?: 'override' | 'same-folder' | 'done';
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Run the check and, when needed, the move. Never throws. */
export function migrateUserData(o: MigrationOptions): MigrationOutcome {
  const log = o.log ?? ((m: string) => console.log(`[user-data] ${m}`));
  try {
    const first = planUserDataMigration(gatherMigrationFacts(o));
    if (first.kind === 'skip') return { result: 'none', userData: o.current, reason: first.reason };
    const lock = acquireMigrationLock(o);
    if (!lock) {
      log(`another launch is moving the user-data folder (${o.current}.migration-lock held)`);
      return { result: 'busy', userData: o.current };
    }
    try {
      // Decided again under the lock: another launch may have finished in the meantime.
      return execute(planUserDataMigration(gatherMigrationFacts(o)), o, log);
    } finally {
      lock.release();
    }
  } catch (e) {
    log(`check failed: ${errText(e)}`);
    return { result: 'none', userData: o.current, error: errText(e) };
  }
}

function execute(plan: MigrationPlan, o: MigrationOptions, log: (m: string) => void): MigrationOutcome {
  const fs = o.fs ?? nodeFs;
  switch (plan.kind) {
    case 'skip':
      return { result: 'none', userData: o.current, reason: plan.reason };
    case 'nothing-to-migrate':
      writeMarker(o, null, 'nothing-to-migrate', log);
      return { result: 'nothing-to-migrate', userData: o.current };
    case 'both-existed':
      log(`both ${plan.legacy} and ${o.current} hold data: using ${o.current}, leaving ${plan.legacy} as it is`);
      writeMarker(o, plan.legacy, 'both-existed', log);
      return { result: 'both-existed', userData: o.current, legacy: plan.legacy };
    case 'legacy-in-use':
      log(`${plan.legacy} is in use by a running app: not moving it; this session uses it`);
      return { result: 'legacy-in-use', userData: plan.legacy, legacy: plan.legacy };
    case 'move':
      break;
  }
  const legacy = plan.legacy;
  // The current folder holds nothing worth keeping (checked by the plan): clear it so the folder can take its place.
  clearDisposableFolder(o.current, fs);
  fs.mkdirSync(path.dirname(o.current), { recursive: true });
  let renameError: string | undefined;
  try {
    if (o.forceCopy) throw Object.assign(new Error('EXDEV: cross-device link not permitted (forced for tests)'), { code: 'EXDEV' });
    fs.renameSync(legacy, o.current);
  } catch (e) {
    renameError = errText(e);
  }
  if (renameError === undefined) {
    log(`moved ${legacy} to ${o.current}`);
    rewritePrefsCacheDir(o, legacy, log);
    writeMarker(o, legacy, 'moved', log);
    return { result: 'moved', userData: o.current, legacy };
  }
  log(`rename ${legacy} -> ${o.current} failed (${renameError}); copying instead`);
  const temp = `${o.current}.migrating`;
  try {
    fs.rmSync(temp, { recursive: true, force: true }); // a copy an interrupted launch left: ours, never user data
    copyTree(legacy, temp, fs, true);
    const problem = compareTrees(legacy, temp, fs);
    if (problem) throw new Error(`the copy does not match the original (${problem})`);
    clearDisposableFolder(o.current, fs);
    fs.renameSync(temp, o.current);
  } catch (e) {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* left for the next attempt */ }
    log(`copying ${legacy} failed (${errText(e)}); this session uses ${legacy}`);
    return { result: 'failed', userData: legacy, legacy, error: errText(e) };
  }
  log(`copied ${legacy} to ${o.current} (the original is kept)`);
  rewritePrefsCacheDir(o, legacy, log);
  writeMarker(o, legacy, 'copied', log);
  return { result: 'copied', userData: o.current, legacy, error: renameError };
}

/** Remove `dir` when it exists and holds nothing but disposable entries (callers checked it has no data). */
function clearDisposableFolder(dir: string, fs: Fs): void {
  if (!fs.existsSync(dir)) return;
  if (folderHasData(dir, fs)) throw new Error(`${dir} is not empty`);
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeMarker(o: MigrationOptions, from: string | null, result: MigrationResult, log: (m: string) => void): void {
  const fs = o.fs ?? nodeFs;
  const marker: MigrationMarker = { from, at: (o.now ?? Date.now)(), result, appVersion: o.appVersion };
  try {
    fs.mkdirSync(o.current, { recursive: true });
    fs.writeFileSync(path.join(o.current, MIGRATION_MARKER), JSON.stringify(marker, null, 2) + '\n');
  } catch (e) {
    log(`could not write ${MIGRATION_MARKER}: ${errText(e)}`);
  }
}

/** Read the marker of `dir`, or null. */
export function readMigrationMarker(dir: string, fs: Fs = nodeFs): MigrationMarker | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MIGRATION_MARKER), 'utf8')) as Partial<MigrationMarker>;
    return m && typeof m.result === 'string' ? (m as MigrationMarker) : null;
  } catch { return null; }
}

/** Whether `p` is `root` or inside it (case-folded on Windows and macOS). */
export function isPathInside(p: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = (s: string) => (caseInsensitive(platform) ? s.toLowerCase() : s);
  const rp = fold(path.resolve(p)), rr = fold(path.resolve(root));
  return rp === rr || rp.startsWith(rr.endsWith(path.sep) ? rr : rr + path.sep);
}

/** A `prefs.json` cacheDir chosen inside the legacy folder now lives at the same place inside the current one. */
function rewritePrefsCacheDir(o: MigrationOptions, legacy: string, log: (m: string) => void): void {
  const fs = o.fs ?? nodeFs;
  const file = path.join(o.current, 'prefs.json');
  try {
    if (!fs.existsSync(file)) return;
    const prefs = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const dir = prefs?.cacheDir;
    if (typeof dir !== 'string' || !dir.trim() || !isPathInside(dir, legacy, o.platform ?? process.platform)) return;
    const next = path.join(o.current, path.relative(path.resolve(legacy), path.resolve(dir)));
    prefs.cacheDir = next;
    const temp = `${file}.migrating-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(prefs, null, 2));
    fs.renameSync(temp, file);
    log(`prefs cacheDir ${dir} -> ${next}`);
  } catch (e) {
    log(`could not update cacheDir in prefs.json: ${errText(e)}`);
  }
}

// ------------------------------------------------------------------
// Copy and verify
// ------------------------------------------------------------------

/** Copy `src` into the new folder `dst` (top-level DISPOSABLE_ENTRIES left out when `skipDisposable`). */
export function copyTree(src: string, dst: string, fs: Fs = nodeFs, skipDisposable = false): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (skipDisposable && DISPOSABLE_ENTRIES.has(name)) continue;
    const from = path.join(src, name), to = path.join(dst, name);
    const st = fs.lstatSync(from);
    if (st.isDirectory()) copyTree(from, to, fs);
    else if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else if (st.isFile()) {
      fs.copyFileSync(from, to, nodeFs.constants.COPYFILE_EXCL);
      try { fs.utimesSync(to, st.atime, st.mtime); } catch { /* times are a nicety */ }
    }
  }
}

/** Relative path → size of every regular file under `root` (top-level DISPOSABLE_ENTRIES and the marker left out). */
export function listFiles(root: string, fs: Fs = nodeFs): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (dir: string, rel: string, top: boolean) => {
    for (const name of fs.readdirSync(dir)) {
      if (top && (DISPOSABLE_ENTRIES.has(name) || name === MIGRATION_MARKER)) continue;
      const p = path.join(dir, name), r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p, r, false);
      else if (st.isFile()) out.set(r, st.size);
    }
  };
  walk(root, '', true);
  return out;
}

/** Null when `copy` has the same files with the same sizes as `original`, else what differs. */
export function compareTrees(original: string, copy: string, fs: Fs = nodeFs): string | null {
  const a = listFiles(original, fs), b = listFiles(copy, fs);
  if (a.size !== b.size) return `${a.size} files, ${b.size} copied`;
  for (const [rel, size] of a) {
    const got = b.get(rel);
    if (got === undefined) return `${rel} missing`;
    if (got !== size) return `${rel}: ${size} bytes, ${got} copied`;
  }
  return null;
}

// ------------------------------------------------------------------
// One migration at a time
// ------------------------------------------------------------------

interface HeldLock { release(): void }

/** `<current>.migration-lock` (exclusive create; a lock whose process is gone is taken over). Null after the wait. */
function acquireMigrationLock(o: MigrationOptions): HeldLock | null {
  const fs = o.fs ?? nodeFs;
  const file = `${o.current}.migration-lock`;
  const alive = o.isPidAlive ?? defaultPidAlive;
  const sleep = o.sleep ?? defaultSleep;
  const now = o.now ?? Date.now;
  const deadline = now() + (o.lockWaitMs ?? 20_000);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeFileSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      return { release: () => { try { fs.unlinkSync(file); } catch { /* ignore */ } } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let holder = NaN;
    try { holder = Number(String(fs.readFileSync(file, 'utf8')).trim()); } catch { /* being written or removed */ }
    if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && !alive(holder)) {
      try { fs.unlinkSync(file); } catch { /* someone else took it over */ }
      continue;
    }
    if (now() >= deadline) return null;
    sleep(200);
  }
}
