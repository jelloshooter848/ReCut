/**
 * Project file I/O: atomic save, load + normalize, autosave/recovery, prefs, recent list.
 *
 * Pure Node — no Electron imports — so vitest can import it. Every function that needs
 * the app-data directory takes it as the `userData` argument.
 *
 * Conventions:
 *  - Project files are `*.recut` JSON (see PROJECT_EXT / ensureProjectExt).
 *  - Autosaves live next to the project as `<project>.recut.autosave`, or for never-saved
 *    projects at `<userData>/autosave/untitled.recut.autosave`. An autosave file is itself a
 *    plain project JSON, so it can be opened/renamed by hand.
 *  - Prefs live at `<userData>/prefs.json`.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDirSafe } from '../safeMkdir';
import { normalizeProject, serializeProject } from '../../shared/project';
import type { AppPreferences, Project } from '../../shared/model';
import type { LoadResult, RecoveryInfo, SaveResult } from '../../shared/ipc';

export const PROJECT_EXT = '.recut';
export const AUTOSAVE_EXT = '.autosave';
export const BACKUP_EXT = '.bak';
export const MAX_RECENT = 15;

export function ensureProjectExt(p: string): string {
  return p.toLowerCase().endsWith(PROJECT_EXT) ? p : p + PROJECT_EXT;
}

export function isProjectPath(p: string): boolean {
  return p.toLowerCase().endsWith(PROJECT_EXT);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ------------------------------------------------------------------
// Atomic write
// ------------------------------------------------------------------

/**
 * Write `data` to `target` atomically: write to a temp file in the same directory, fsync,
 * copy the previous file (if any) to `<target>.bak`, then rename the temp file over the target.
 */
export async function atomicWriteFile(target: string, data: string | Uint8Array, opts: { backup?: boolean } = {}): Promise<void> {
  const dir = path.dirname(target);
  await ensureDirSafe(dir); // never recursive mkdir on a user path (BUG-1)
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  // One buffer, written with as few syscalls as possible (FileHandle.writeFile goes through the thread
  // pool in 512 KiB pieces, about 130 round trips for a 67 MB project).
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const fh = await fsp.open(tmp, 'w');
  try {
    let off = 0;
    while (off < buf.byteLength) {
      const { bytesWritten } = await fh.write(buf, off, buf.byteLength - off);
      if (bytesWritten <= 0) throw new Error('short write');
      off += bytesWritten;
    }
    try { await fh.sync(); } catch { /* fsync unsupported on some filesystems */ }
  } finally {
    await fh.close();
  }
  try {
    if (opts.backup !== false) {
      try {
        await fsp.copyFile(target, target + BACKUP_EXT);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') { /* ignore backup failure */ }
      }
    }
    await fsp.rename(tmp, target);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

// ------------------------------------------------------------------
// Save / load
// ------------------------------------------------------------------

/**
 * Autosave serialization: compact JSON (2.5x smaller than the 2-space form, and faster to produce and
 * write; P-06). Manual saves stay human-readable via serializeProject. Both parse to the same project.
 */
export function serializeAutosave(p: Project): string {
  return JSON.stringify(p);
}

/** Save a project. The `.recut` extension is appended when missing; the final path is returned. */
export async function saveProjectFile(filePath: string, project: Project): Promise<SaveResult> {
  try {
    const target = ensureProjectExt(path.resolve(filePath));
    const toWrite: Project = { ...project, modifiedAt: project.modifiedAt || Date.now() };
    await atomicWriteFile(target, serializeProject(toWrite));
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: `Could not save project: ${errMsg(e)}` };
  }
}

export async function readProjectJson(filePath: string): Promise<Project> {
  const text = await fsp.readFile(filePath, 'utf8');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`Not valid JSON: ${errMsg(e)}`); }
  return normalizeProject(raw);
}

/** Thrown for content that cannot be a project at all (unreadable / not JSON / not an object). */
class DamagedProjectError extends Error {}

/** Read + parse; damaged content throws DamagedProjectError, a valid-but-refused project (e.g. newer format) throws Error. */
async function readProjectStrict(filePath: string): Promise<Project> {
  let text: string;
  try { text = await fsp.readFile(filePath, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw e;
    throw new DamagedProjectError(errMsg(e));
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new DamagedProjectError(`Not valid JSON: ${errMsg(e)}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DamagedProjectError('Project file is not a JSON object');
  return normalizeProject(raw);
}

/** Path the damaged project file is copied to before a backup is used: `<path>.corrupt-<timestamp>`. */
export function corruptCopyPath(filePath: string, now = Date.now()): string {
  return `${filePath}.corrupt-${now}`;
}

/**
 * Load a project. Falls back to `<path>.bak` only when the main file is damaged (unreadable / not
 * JSON); a project refused by `normalizeProject` (e.g. saved by a newer ReCut) is reported as an
 * error so a stale backup never silently replaces it. On fallback the damaged file is copied aside
 * (it would otherwise become the next `.bak` on save) and the result says `fromBackup`.
 */
export async function loadProjectFile(filePath: string): Promise<LoadResult> {
  const resolved = path.resolve(filePath);
  try {
    const project = await readProjectStrict(resolved);
    return { ok: true, path: resolved, project };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, error: `Project file not found: ${resolved}` };
    if (!(e instanceof DamagedProjectError)) return { ok: false, error: `Could not open project: ${errMsg(e)}` };
    const bak = resolved + BACKUP_EXT;
    try {
      const project = await readProjectJson(bak);
      const st = await statOrNull(bak);
      try { await fsp.copyFile(resolved, corruptCopyPath(resolved)); } catch (ce) {
        console.warn(`could not keep a copy of the damaged project ${resolved}:`, ce);
      }
      return { ok: true, path: resolved, project, fromBackup: true, backupMtime: st?.mtimeMs ?? undefined };
    } catch { /* no usable backup */ }
    return { ok: false, error: `Could not open project: ${errMsg(e)}` };
  }
}

// ------------------------------------------------------------------
// Autosave / recovery
// ------------------------------------------------------------------

export function untitledAutosavePath(userData: string): string {
  return path.join(userData, 'autosave', `untitled${PROJECT_EXT}${AUTOSAVE_EXT}`);
}

export function autosavePathFor(projectPath: string | null, userData: string): string {
  if (!projectPath) return untitledAutosavePath(userData);
  return path.resolve(projectPath) + AUTOSAVE_EXT;
}

/** Given an autosave path, return the project path it belongs to (null for the untitled autosave). */
export function projectPathForAutosave(autosavePath: string, userData: string): string | null {
  if (path.resolve(autosavePath) === path.resolve(untitledAutosavePath(userData))) return null;
  return autosavePath.endsWith(AUTOSAVE_EXT) ? autosavePath.slice(0, -AUTOSAVE_EXT.length) : null;
}

export async function writeAutosave(projectPath: string | null, project: Project, userData: string): Promise<SaveResult> {
  try {
    const target = autosavePathFor(projectPath, userData);
    // Autosaves are already a safety net; no .bak chain for them.
    await atomicWriteFile(target, serializeAutosave(project), { backup: false });
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: `Autosave failed: ${errMsg(e)}` };
  }
}

async function statOrNull(p: string): Promise<fs.Stats | null> {
  try { return await fsp.stat(p); } catch { return null; }
}

async function recoveryFrom(autosavePath: string, projectPath: string | null): Promise<RecoveryInfo | null> {
  const st = await statOrNull(autosavePath);
  if (!st || !st.isFile() || st.size === 0) return null;
  try {
    const project = await readProjectJson(autosavePath);
    return { autosavePath, projectPath, savedAt: st.mtimeMs, project };
  } catch (e) {
    console.warn(`[recovery] ignoring unreadable autosave ${autosavePath}: ${errMsg(e)}`);
    return null; // corrupt autosave: nothing to recover
  }
}

/**
 * Look for recoverable work: the untitled autosave, or an autosave next to any of the
 * `candidateProjects` (usually the recent list) that is newer than its project file
 * (or whose project file has gone missing). The newest candidate wins.
 */
export async function checkRecovery(userData: string, candidateProjects: string[]): Promise<RecoveryInfo | null> {
  const found: RecoveryInfo[] = [];
  const untitled = await recoveryFrom(untitledAutosavePath(userData), null);
  if (untitled) found.push(untitled);
  const seen = new Set<string>();
  for (const p of candidateProjects) {
    if (typeof p !== 'string' || !p) continue;
    const resolved = path.resolve(p);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    try {
      const auto = autosavePathFor(resolved, userData);
      const [autoSt, projSt] = await Promise.all([statOrNull(auto), statOrNull(resolved)]);
      if (!autoSt) continue;
      // Allow a small slack so an autosave written just before the save isn't flagged.
      if (projSt && autoSt.mtimeMs <= projSt.mtimeMs + 1000) continue;
      const info = await recoveryFrom(auto, resolved);
      if (info) found.push(info);
    } catch (e) {
      console.warn(`[recovery] skipping ${resolved}: ${errMsg(e)}`);
    }
  }
  if (found.length === 0) return null;
  found.sort((a, b) => b.savedAt - a.savedAt);
  return found[0];
}

/** Delete an autosave file. Refuses to delete anything that is not an autosave. */
export async function discardRecovery(autosavePath: string): Promise<void> {
  if (typeof autosavePath !== 'string' || !autosavePath.endsWith(AUTOSAVE_EXT)) {
    throw new Error('Refusing to delete a non-autosave file');
  }
  await fsp.rm(autosavePath, { force: true });
}

/**
 * After a successful save of `project` to a real path, drop the untitled autosave if it
 * belongs to the same project (so it is not offered for recovery on next launch).
 */
export async function clearUntitledAutosaveFor(project: Project, userData: string): Promise<void> {
  const p = untitledAutosavePath(userData);
  try {
    const text = await fsp.readFile(p, 'utf8');
    const raw = JSON.parse(text) as { id?: unknown };
    if (raw && raw.id === project.id) await fsp.rm(p, { force: true });
  } catch { /* nothing to do */ }
}

// ------------------------------------------------------------------
// Preferences & recent projects
// ------------------------------------------------------------------

export function defaultPrefs(): AppPreferences {
  return { recentProjects: [], shortcuts: {} };
}

export function prefsPath(userData: string): string {
  return path.join(userData, 'prefs.json');
}

export function normalizePrefs(raw: unknown): AppPreferences {
  const d = defaultPrefs();
  if (!raw || typeof raw !== 'object') return d;
  const p = raw as Partial<AppPreferences> & Record<string, unknown>;
  const out: AppPreferences = {
    ...d,
    ...p,
    recentProjects: Array.isArray(p.recentProjects) ? p.recentProjects.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT) : [],
    shortcuts: p.shortcuts && typeof p.shortcuts === 'object' ? { ...(p.shortcuts as Record<string, string>) } : {},
  };
  if (out.layout && typeof out.layout !== 'object') delete out.layout;
  return out;
}

export async function readPrefs(userData: string): Promise<AppPreferences> {
  try {
    const text = await fsp.readFile(prefsPath(userData), 'utf8');
    return normalizePrefs(JSON.parse(text));
  } catch {
    return defaultPrefs();
  }
}

export async function writePrefs(userData: string, prefs: AppPreferences): Promise<void> {
  await atomicWriteFile(prefsPath(userData), JSON.stringify(prefs, null, 2), { backup: false });
}

export async function updatePrefs(userData: string, patch: Partial<AppPreferences>): Promise<AppPreferences> {
  const cur = await readPrefs(userData);
  const next = normalizePrefs({ ...cur, ...patch });
  await writePrefs(userData, next);
  return next;
}

/** Pure: insert `p` at the front of a recent list, deduped, capped at MAX_RECENT. */
export function pushRecent(list: string[], p: string): string[] {
  const resolved = path.resolve(p);
  const rest = list.filter((x) => path.resolve(x) !== resolved);
  return [resolved, ...rest].slice(0, MAX_RECENT);
}

export async function addRecentProject(userData: string, p: string): Promise<string[]> {
  const cur = await readPrefs(userData);
  const next = await updatePrefs(userData, { recentProjects: pushRecent(cur.recentProjects, p) });
  return next.recentProjects;
}

export async function removeRecentProject(userData: string, p: string): Promise<string[]> {
  const cur = await readPrefs(userData);
  const resolved = path.resolve(p);
  const next = await updatePrefs(userData, { recentProjects: cur.recentProjects.filter((x) => path.resolve(x) !== resolved) });
  return next.recentProjects;
}

export async function clearRecentProjects(userData: string): Promise<void> {
  await updatePrefs(userData, { recentProjects: [] });
}

/** Recent projects whose files still exist (does not mutate stored prefs). */
export async function existingRecentProjects(userData: string): Promise<string[]> {
  const cur = await readPrefs(userData);
  const checks = await Promise.all(cur.recentProjects.map(async (p) => ((await statOrNull(p))?.isFile() ? p : null)));
  return checks.filter((p): p is string => p !== null);
}
