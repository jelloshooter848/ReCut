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
import { normalizeProjectWithReport, serializeProject, ProjectIncompatibleError } from '../../shared/project';
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

function tempPathFor(file: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
}

/** The file a symlink at `p` points to (fully resolved); `p` itself when it is not a symlink or is dangling. */
async function resolveLinkTarget(p: string): Promise<string> {
  let st: fs.Stats;
  try { st = await fsp.lstat(p); } catch { return p; }
  if (!st.isSymbolicLink()) return p;
  try { return await fsp.realpath(p); } catch { return p; } // dangling: replace the link, never create its target
}

/** A temp file opened beside the file it will replace (openAtomic, then writeAll*, finishAtomic). */
interface AtomicFile {
  /** What the temp file replaces: `target`, or the file a symlink at `target` points to (followSymlink). */
  dest: string;
  tmp: string;
  fh: fsp.FileHandle;
}

/** Open the temp file for an atomic write of `target`. Creates the parent folder only where that is safe (BUG-1). */
async function openAtomic(target: string, followSymlink: boolean | undefined): Promise<AtomicFile> {
  await ensureDirSafe(path.dirname(target)); // never recursive mkdir on a user path (BUG-1)
  const dest = followSymlink ? await resolveLinkTarget(target) : target;
  const tmp = tempPathFor(dest);
  return { dest, tmp, fh: await fsp.open(tmp, 'w') };
}

/** Append all of `buf` to the temp file with as few syscalls as the OS allows. */
async function writeAll(fh: fsp.FileHandle, buf: Uint8Array): Promise<void> {
  let off = 0;
  while (off < buf.byteLength) {
    const { bytesWritten } = await fh.write(buf, off, buf.byteLength - off);
    if (bytesWritten <= 0) throw new Error('short write');
    off += bytesWritten;
  }
}

/**
 * Finish an atomic write whose bytes are all written: fsync, close, keep the previous file as `<target>.bak`
 * (unless `backup` is false), rename the temp file over its destination. On failure the temp file is removed
 * (the destination is untouched) and the error thrown.
 */
async function finishAtomic(f: AtomicFile, target: string, backup: boolean | undefined): Promise<void> {
  try {
    try {
      try { await f.fh.sync(); } catch { /* fsync unsupported on some filesystems */ }
    } finally {
      await f.fh.close();
    }
    if (backup !== false) await writeBackup(f.dest, target + BACKUP_EXT);
    await fsp.rename(f.tmp, f.dest);
  } catch (e) {
    await fsp.rm(f.tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** Drop an atomic write: close and remove the temp file (best effort; the destination is never touched). */
async function discardAtomic(f: AtomicFile): Promise<void> {
  await f.fh.close().catch(() => undefined);
  await fsp.rm(f.tmp, { force: true }).catch(() => undefined);
}

/**
 * Write `data` to `target` atomically: write to a temp file in the same directory, fsync,
 * keep the previous file (if any) as `<target>.bak`, then rename the temp file over the target.
 *
 * Symlinks: a symlink at `<target>.bak` is replaced (the backup is made under a temp name and renamed onto
 * that name), never written through. A symlink at `target` is replaced too, unless `followSymlink` is set
 * (project saves: the user opened the link, so the file it points to is updated and the link kept; the
 * `.bak` still sits next to `target`, where the loader looks for it).
 */
export async function atomicWriteFile(target: string, data: string | Uint8Array, opts: { backup?: boolean; followSymlink?: boolean } = {}): Promise<void> {
  // One buffer, written with as few syscalls as possible (FileHandle.writeFile goes through the thread
  // pool in 512 KiB pieces, about 130 round trips for a 67 MB project).
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const f = await openAtomic(target, opts.followSymlink);
  try {
    await writeAll(f.fh, buf);
  } catch (e) {
    // A failed write must not leave the hidden partial temp file beside the target.
    await discardAtomic(f);
    throw e;
  }
  await finishAtomic(f, target, opts.backup);
}

/**
 * Make `bak` hold the previous version `from`, under a temp name renamed onto `bak`, so a symlink planted at
 * `bak` is replaced rather than followed. The temp name is a hard link to `from` where the filesystem allows
 * it: that version is complete and was synced when it was saved, and the rename that follows only points
 * `from`'s name at the new file (nothing ReCut writes is ever modified in place), so the link keeps exactly
 * the old bytes without copying them; a 30 MB copy cost about as much as writing the new file. Where hard
 * links are refused (FAT / exFAT, some network shares, a symlinked project on another volume) it is a copy, as
 * before. A missing `from` (first save) or a failure is ignored: the backup is best effort and never blocks
 * the save.
 */
async function writeBackup(from: string, bak: string): Promise<void> {
  const tmp = tempPathFor(bak);
  try {
    let linked = true;
    try {
      await fsp.link(from, tmp);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw e;
      linked = false;
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      await fsp.copyFile(from, tmp);
    }
    await fsp.rename(tmp, bak);
    // POSIX rename does nothing when both names are links to one file (`bak` already was the previous version,
    // e.g. after a save interrupted between these steps): the temp name would stay behind.
    if (linked) await fsp.rm(tmp, { force: true });
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`could not update the backup ${bak}: ${errMsg(e)}`);
  }
}

/**
 * Synchronous atomic write (temp file + rename, no backup) for the window-close path, where an async write
 * would not finish before quit. Creates the parent folder (app-data paths only). A symlink at `target` is replaced.
 */
export function atomicWriteFileSync(target: string, data: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = tempPathFor(target);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
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
    const toWrite: Project = { ...project, modifiedAt: project.modifiedAt || Date.now() };
    return await writeProjectText(filePath, serializeProject(toWrite));
  } catch (e) {
    return { ok: false, error: `Could not save project: ${errMsg(e)}` };
  }
}

/** A cheap shape check for project JSON text from the renderer (it is written as-is, never parsed here). */
function looksLikeProjectJson(json: unknown): json is string {
  return typeof json === 'string' && json.length >= 2 && json[0] === '{' && json[json.length - 1] === '}';
}

/**
 * Save a project the renderer already serialized (the serializeProject layout, written in slices by
 * projectJsonChunks): one string crosses IPC instead of a structured clone of the whole project, and main only
 * writes it, atomically, with the same `.bak` and symlink handling as saveProjectFile. Like writeAutosaveJson it
 * is not parsed or normalized here (opening the file does that); a cheap shape check guards against garbage.
 */
export async function saveProjectJson(filePath: string, json: string): Promise<SaveResult> {
  if (!looksLikeProjectJson(json)) return { ok: false, error: 'Could not save project: not a serialized project (expected a JSON object string)' };
  try {
    return await writeProjectText(filePath, json);
  } catch (e) {
    return { ok: false, error: `Could not save project: ${errMsg(e)}` };
  }
}

async function writeProjectText(filePath: string, text: string): Promise<SaveResult> {
  const target = ensureProjectExt(path.resolve(filePath));
  await atomicWriteFile(target, text, { followSymlink: true });
  return { ok: true, path: target };
}

/** What the renderer says it sent (ProjectFileWriter.commit checks it against what arrived). */
export interface SaveStreamTotals { chunks: number; chars: number }

/** How long a commit waits for chunks still in flight (normally none: they are sent before the commit). */
const STRAGGLER_WAIT_MS = 10_000;

/**
 * A project save streamed by the renderer while it serializes (shared/projectWire.ts ProjectSaveStreamApi), so
 * the IPC copies, UTF-8 encoding and disk writes of one slice overlap the serialization of the next instead of
 * all following it. Same file semantics as saveProjectJson: the text is written as-is (never parsed) to a temp
 * file beside the target, and only commit, once every chunk is written and the whole text passed the same
 * shape check, syncs it, keeps the `.bak` and renames it over the target (through a symlinked `.recut`). Until
 * then the target is untouched; a failed or aborted save removes the temp file.
 *
 * A streamed autosave (openAutosave, shared/projectWire.ts ProjectAutosaveStreamApi) is the same writer with the
 * file semantics of writeAutosaveJson: its target is the autosave file, without a `.bak`.
 */
export class ProjectFileWriter {
  private chunks = 0;
  private chars = 0;
  private first = '';
  private last = '';
  /** The start of the text, for the top-level project id (projectId). */
  private head = '';
  /** Writes run one at a time, in arrival order. */
  private writing: Promise<void> = Promise.resolve();
  private error: unknown = null;
  /** commit was called (it may still be waiting for pieces). */
  private committing = false;
  /** No more pieces are taken: the commit is writing the file, or the save is finished or aborted. */
  private closed = false;
  private arrived: (() => void) | null = null;

  /**
   * `kind` 'autosave': the file is an autosave (no `.bak`, a symlink at the autosave path is replaced, errors say
   * "Autosave failed"); 'project': a project file (`.bak` kept, a symlinked `.recut` updated through the link).
   */
  private constructor(readonly path: string, private readonly file: AtomicFile, readonly kind: 'project' | 'autosave' = 'project') {}

  /** Open a save of the project file at `filePath` (`.recut` appended when missing). Throws when the temp file cannot be created. */
  static async open(filePath: string): Promise<ProjectFileWriter> {
    const target = ensureProjectExt(path.resolve(filePath));
    return new ProjectFileWriter(target, await openAtomic(target, true));
  }

  /**
   * Open a streamed autosave of the project at `projectPath` (null: the untitled autosave in `userData`), with the
   * file semantics of writeAutosaveJson: the temp file sits beside the autosave file (never beside the project
   * file), and the commit renames it over the autosave file, without a `.bak`. Throws when the path is refused
   * or the temp file cannot be created.
   */
  static async openAutosave(projectPath: string | null, userData: string): Promise<ProjectFileWriter> {
    const refused = autosaveTargetError(projectPath);
    if (refused && !refused.ok) throw new Error(refused.error.replace(/^Autosave failed: /, ''));
    const target = autosavePathFor(projectPath, userData);
    return new ProjectFileWriter(target, await openAtomic(target, false), 'autosave');
  }

  private failure(problem: string): SaveResult {
    return { ok: false, error: `${this.kind === 'autosave' ? 'Autosave failed' : 'Could not save project'}: ${problem}` };
  }

  /**
   * Chunk number `seq` (0, 1, 2, ...) of the text: written behind the earlier chunks. A chunk out of order or not
   * a string fails the save (commit reports it); after a failure, commit or abort, chunks are ignored.
   */
  append(seq: number, text: string): void {
    if (this.closed || this.error) return;
    if (typeof text !== 'string' || seq !== this.chunks) {
      this.fail(new Error(`save data chunk ${String(seq)} arrived out of order or malformed (expected chunk ${this.chunks})`));
      return;
    }
    this.chunks++;
    if (text.length) {
      if (this.chars === 0) this.first = text[0];
      this.last = text[text.length - 1];
      this.chars += text.length;
    }
    if (this.head.length < ID_PROBE_BYTES) this.head += text.slice(0, ID_PROBE_BYTES - this.head.length);
    const buf = Buffer.from(text, 'utf8');
    this.writing = this.writing.then(() => (this.error ? undefined : writeAll(this.file.fh, buf))).catch((e: unknown) => { this.fail(e); });
    this.arrived?.();
  }

  private fail(e: unknown): void {
    this.error ??= e;
    this.arrived?.();
  }

  /** The top-level project id in the text so far (null: none; undefined: not settled by its first 64 KB). */
  projectId(): string | null | undefined {
    return topLevelProjectId(this.head);
  }

  /** Finish the save: `totals` is what the renderer sent. Never throws; an error leaves the target untouched. */
  async commit(totals: SaveStreamTotals): Promise<SaveResult> {
    if (this.closed || this.committing) return this.failure('this save is already finished');
    this.committing = true;
    const want = { chunks: Number(totals?.chunks), chars: Number(totals?.chars) };
    const deadline = Date.now() + STRAGGLER_WAIT_MS;
    while (!this.error && !this.closed && this.chunks < want.chunks && Date.now() < deadline) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, Math.max(0, deadline - Date.now()));
        this.arrived = () => { clearTimeout(t); r(); };
      });
      this.arrived = null;
    }
    if (this.closed) return this.failure('the save was cancelled'); // aborted meanwhile
    this.closed = true;
    await this.writing;
    const problem = this.error ? errMsg(this.error)
      : this.chunks !== want.chunks || this.chars !== want.chars
        ? `the project data arrived incomplete (${this.chunks} of ${String(want.chunks)} chunks, ${this.chars} of ${String(want.chars)} characters)`
        : this.chars < 2 || this.first !== '{' || this.last !== '}' ? 'not a serialized project (expected a JSON object string)' : null;
    if (problem !== null) {
      await discardAtomic(this.file);
      return this.failure(problem);
    }
    try {
      await finishAtomic(this.file, this.path, this.kind === 'project');
      return { ok: true, path: this.path };
    } catch (e) {
      return this.failure(errMsg(e));
    }
  }

  /** Drop the save: the temp file is removed and the target left as it was. */
  async abort(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.arrived?.(); // a commit waiting for pieces gives up
    await this.writing;
    await discardAtomic(this.file);
  }
}

export async function readProjectJson(filePath: string): Promise<Project> {
  const text = await fsp.readFile(filePath, 'utf8');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`Not valid JSON: ${errMsg(e)}`); }
  const { project, repairs } = normalizeProjectWithReport(raw);
  // Recovery / backup reads: no pre-repair copy here (checkRecovery runs on every launch); just log.
  if (repairs.length) console.warn(`[project] ${filePath} needed repairs: ${repairs.join('; ')}`);
  return project;
}

/** readProjectJson, also returning what normalization repaired. */
async function readProjectJsonWithReport(filePath: string): Promise<{ project: Project; repairs: string[] }> {
  const text = await fsp.readFile(filePath, 'utf8');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`Not valid JSON: ${errMsg(e)}`); }
  return normalizeProjectWithReport(raw);
}

/** Thrown for damaged content: unreadable, not JSON, not an object, or a JSON object normalization could not repair. */
class DamagedProjectError extends Error {}

/**
 * Read + parse + normalize. Throws ENOENT as is; ProjectIncompatibleError (newer / missing formatVersion) as is;
 * everything else is damage and throws DamagedProjectError (with the original error as `cause`).
 */
async function readProjectStrict(filePath: string): Promise<{ project: Project; repairs: string[] }> {
  let text: string;
  try { text = await fsp.readFile(filePath, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw e;
    throw new DamagedProjectError(errMsg(e), { cause: e });
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new DamagedProjectError(`Not valid JSON: ${errMsg(e)}`, { cause: e }); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DamagedProjectError('Project file is not a JSON object');
  try {
    return normalizeProjectWithReport(raw);
  } catch (e) {
    if (e instanceof ProjectIncompatibleError) throw e;
    // normalizeProject repairs what it can; whatever it still throws on (a structurally broken file, or a
    // failure nobody anticipated) means this file's content is unusable, so it is damage and the .bak is tried.
    throw new DamagedProjectError(errMsg(e), { cause: e });
  }
}

/** Path the damaged project file is copied to before a backup is used: `<path>.corrupt-<timestamp>`. */
export function corruptCopyPath(filePath: string, now = Date.now()): string {
  return `${filePath}.corrupt-${now}`;
}

/** Path the original of a file that had to be repaired on load is copied to: `<file>.pre-repair-<timestamp>`. */
export function preRepairCopyPath(filePath: string, now = Date.now()): string {
  return `${filePath}.pre-repair-${now}`;
}

/**
 * Keep the unrepaired original of `file` beside it before the repaired project can be saved over it (after two
 * saves the `.bak` no longer holds it either). Returns the copy's path, or undefined when the copy failed.
 */
async function keepPreRepairCopy(file: string): Promise<string | undefined> {
  const copy = preRepairCopyPath(file);
  try {
    await fsp.copyFile(file, copy, fs.constants.COPYFILE_EXCL);
    return copy;
  } catch (e) {
    console.warn(`could not keep a copy of ${file} before repairs:`, e);
    return undefined;
  }
}

/** The repaired-load fields of a LoadResult (none when nothing was repaired). */
async function repairInfo(file: string, repairs: string[]): Promise<{ repaired?: string[]; preRepairPath?: string }> {
  if (!repairs.length) return {};
  console.warn(`[project] ${file} needed repairs: ${repairs.join('; ')}`);
  const preRepairPath = await keepPreRepairCopy(file);
  return preRepairPath ? { repaired: repairs, preRepairPath } : { repaired: repairs };
}

/**
 * Load a project. Falls back to `<path>.bak` only when the main file is damaged (unreadable / not JSON /
 * not an object / content normalizeProject cannot repair). A project this build refuses
 * (ProjectIncompatibleError: saved by a newer ReCut, or no formatVersion) is reported as an error so a
 * stale backup never silently replaces it. On fallback the damaged file is copied aside (it would
 * otherwise become the next `.bak` on save) and the result says `fromBackup`. When the file read (main or
 * .bak) needed repairs, its original is copied to `<file>.pre-repair-<ts>` and the result lists the repairs
 * (`repaired`, `preRepairPath`). A file refused as not a ReCut project names an existing `.bak` in the error.
 */
export async function loadProjectFile(filePath: string): Promise<LoadResult> {
  const resolved = path.resolve(filePath);
  try {
    const { project, repairs } = await readProjectStrict(resolved);
    return { ok: true, path: resolved, project, ...(await repairInfo(resolved, repairs)) };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, error: `Project file not found: ${resolved}` };
    const bak = resolved + BACKUP_EXT;
    if (e instanceof ProjectIncompatibleError) {
      // Never substituted automatically (it may be stale), but say it is there when this is not a ReCut project at all.
      const hint = e.reason === 'notProject' && (await statOrNull(bak))?.isFile() ? ` A backup of this project exists: ${bak}` : '';
      return { ok: false, error: `Could not open project: ${errMsg(e)}.${hint}` };
    }
    if (!(e instanceof DamagedProjectError)) throw e; // readProjectStrict classifies every failure; anything else is a bug
    try {
      const { project, repairs } = await readProjectJsonWithReport(bak);
      const st = await statOrNull(bak);
      try { await fsp.copyFile(resolved, corruptCopyPath(resolved)); } catch (ce) {
        console.warn(`could not keep a copy of the damaged project ${resolved}:`, ce);
      }
      return { ok: true, path: resolved, project, fromBackup: true, backupMtime: st?.mtimeMs ?? undefined, ...(await repairInfo(bak, repairs)) };
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

/** Autosaves are written only next to a `.recut` project path, or as the untitled autosave (the path is renderer input). */
function autosaveTargetError(projectPath: string | null): SaveResult | null {
  if (projectPath === null) return null;
  if (typeof projectPath !== 'string' || !isProjectPath(projectPath)) return { ok: false, error: `Autosave failed: not a project path (${String(projectPath)})` };
  return null;
}

export async function writeAutosave(projectPath: string | null, project: Project, userData: string): Promise<SaveResult> {
  const refused = autosaveTargetError(projectPath);
  if (refused) return refused;
  try {
    const target = autosavePathFor(projectPath, userData);
    // Autosaves are already a safety net; no .bak chain for them.
    await atomicWriteFile(target, serializeAutosave(project), { backup: false });
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: `Autosave failed: ${errMsg(e)}` };
  }
}

/**
 * Autosave from an already-serialized project (renderer-side JSON.stringify; avoids structured-cloning
 * the project across IPC). The string is written as-is, atomically; it is not parsed or normalized here
 * (recovery parses and normalizes it on load). Only a cheap shape check guards against garbage.
 */
export async function writeAutosaveJson(projectPath: string | null, json: string, userData: string): Promise<SaveResult> {
  if (!looksLikeProjectJson(json)) return { ok: false, error: 'Autosave failed: not a serialized project (expected a JSON object string)' };
  const refused = autosaveTargetError(projectPath);
  if (refused) return refused;
  try {
    const target = autosavePathFor(projectPath, userData);
    await atomicWriteFile(target, json, { backup: false });
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
    // No pre-repair copy (this runs on every launch): log, and let the recovery prompt say so.
    const { project, repairs } = await readProjectJsonWithReport(autosavePath);
    if (repairs.length) console.warn(`[recovery] ${autosavePath} needed repairs: ${repairs.join('; ')}`);
    return { autosavePath, projectPath, savedAt: st.mtimeMs, project, ...(repairs.length ? { repaired: repairs } : {}) };
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
  offeredAutosaves.add(path.resolve(found[0].autosavePath));
  return found[0];
}

/** Autosaves checkRecovery offered in this process: the only files discardRecovery deletes (the path comes from the renderer). */
const offeredAutosaves = new Set<string>();

/** Delete an autosave that checkRecovery offered (once). Refuses any other path. */
export async function discardRecovery(autosavePath: string): Promise<void> {
  const resolved = typeof autosavePath === 'string' ? path.resolve(autosavePath) : '';
  if (!resolved.endsWith(AUTOSAVE_EXT) || !offeredAutosaves.has(resolved)) {
    throw new Error('Refusing to delete a file that is not an autosave offered for recovery');
  }
  offeredAutosaves.delete(resolved);
  await fsp.rm(resolved, { force: true });
}

/**
 * After a successful save of `project` to a real path, drop the untitled autosave if it
 * belongs to the same project (so it is not offered for recovery on next launch).
 */
export async function clearUntitledAutosaveFor(project: Project, userData: string): Promise<void> {
  await clearUntitledAutosaveForId(project.id, userData);
}

/** Bytes of the untitled autosave read to find its project id (the second key of every file ReCut writes). */
const ID_PROBE_BYTES = 64 * 1024;

/**
 * clearUntitledAutosaveFor by project id. Reads only the head of the autosave to find its top-level id (the
 * autosave of a big project is tens of MB, and parsing it whole took longer than the save itself); parses the
 * whole file only when the head does not settle it.
 */
export async function clearUntitledAutosaveForId(projectId: unknown, userData: string): Promise<void> {
  if (typeof projectId !== 'string' || !projectId) return;
  const p = untitledAutosavePath(userData);
  try {
    let id: string | null | undefined;
    const fh = await fsp.open(p, 'r');
    try {
      const buf = Buffer.alloc(ID_PROBE_BYTES);
      const { bytesRead } = await fh.read(buf, 0, ID_PROBE_BYTES, 0);
      id = topLevelProjectId(buf.toString('utf8', 0, bytesRead));
    } finally {
      await fh.close();
    }
    if (id === undefined) {
      const raw = JSON.parse(await fsp.readFile(p, 'utf8')) as { id?: unknown } | null;
      id = raw && typeof raw.id === 'string' ? raw.id : null;
    }
    if (id === projectId) await fsp.rm(p, { force: true });
  } catch { /* nothing to do */ }
}

const JSON_WS = new Set([' ', '\n', '\r', '\t']);

/**
 * The top-level `"id"` string of a project JSON text, scanning only as far as that key: null when the object has
 * no string id, undefined when the text is not a JSON object or ends before the answer (a file head cut short).
 * The first top-level "id" key counts (ReCut never writes duplicate keys).
 */
export function topLevelProjectId(text: string): string | null | undefined {
  const n = text.length;
  let i = 0;
  const skipWs = () => { while (i < n && JSON_WS.has(text[i])) i++; };
  /** End (exclusive) of the string starting at `s` (a '"'), or -1 when it does not end within the text. */
  const stringEnd = (s: number): number => {
    for (let j = s + 1; j < n; j++) {
      const c = text[j];
      if (c === '\\') j++;
      else if (c === '"') return j + 1;
    }
    return -1;
  };
  /** End (exclusive) of the value starting at `s`, or -1. */
  const valueEnd = (s: number): number => {
    const c = text[s];
    if (c === '"') return stringEnd(s);
    if (c === '{' || c === '[') {
      let depth = 0;
      for (let j = s; j < n; j++) {
        const d = text[j];
        if (d === '"') { const e = stringEnd(j); if (e < 0) return -1; j = e - 1; }
        else if (d === '{' || d === '[') depth++;
        else if ((d === '}' || d === ']') && --depth === 0) return j + 1;
      }
      return -1;
    }
    let j = s;
    while (j < n && text[j] !== ',' && text[j] !== '}' && !JSON_WS.has(text[j])) j++;
    return j < n ? j : -1;
  };
  skipWs();
  if (text[i] !== '{') return undefined;
  i++;
  for (;;) {
    skipWs();
    if (i >= n) return undefined;
    if (text[i] === '}') return null;
    if (text[i] !== '"') return undefined;
    const keyEnd = stringEnd(i);
    if (keyEnd < 0) return undefined;
    let key: unknown;
    try { key = JSON.parse(text.slice(i, keyEnd)); } catch { return undefined; }
    i = keyEnd;
    skipWs();
    if (text[i] !== ':') return undefined;
    i++;
    skipWs();
    if (i >= n) return undefined;
    const end = valueEnd(i);
    if (end < 0) return undefined;
    if (key === 'id') {
      if (text[i] !== '"') return null;
      try { return JSON.parse(text.slice(i, end)) as string; } catch { return undefined; }
    }
    i = end;
    skipWs();
    if (text[i] === ',') { i++; continue; }
    return text[i] === '}' ? null : undefined;
  }
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
