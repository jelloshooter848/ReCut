/**
 * Collect Project (roadmap §16): copy the project and the media it uses into one folder, as a cancellable job.
 *
 * The plan (which files, which names, the rewritten project) is shared/collect.ts; this file stats the sources,
 * checks the destination, and runs the copy:
 *  - `<destination>/<Project name>/` must be new or empty. The job creates it and first writes
 *    COLLECT-INCOMPLETE.txt, which stays (with the reason) if the collect fails or is canceled, and is removed last.
 *  - Each file is streamed to `<name>.part` (byte progress, cancellable), checked (same size as the original, same
 *    fast fingerprint at start / middle / end, electron/media/identity.ts), then renamed and given the original's
 *    modification time.
 *  - Only after every copy is verified is `<Project name>.recut` written, with paths rewritten to the copies. So an
 *    incomplete folder never holds a project file pointing into it.
 *  - Originals are only read. The open project is not changed (the renderer sends a serialized copy).
 *  - Missing (offline) media are skipped and reported; their items keep their original paths.
 *
 * Pure Node (no Electron): unit-tested with a JobQueue and injected failures (CollectDeps).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { JobInfo, Project } from '../../shared/model';
import {
  COLLECT_INCOMPLETE_MARKER, collectTotalsByKind, formatCollectBytes, planCollect, rewriteCollectedProject,
  type CollectOptions, type CollectPlan, type CollectRequest, type CollectResult, type CollectSourceStat,
  type CollectStartResult, type CollectSummary,
} from '../../shared/collect';
import { normalizeProject, serializeProject } from '../../shared/project';
import type { JobQueue, JobRunContext } from '../jobs/jobQueue';
import { fingerprintFile } from '../media/identity';
import { ensureDirSafe } from '../safeMkdir';
import { atomicWriteFile } from './io';

/** Copy `src` to `dest` (a new file), reporting bytes as they are written; rejects when `signal` aborts. */
export type CollectCopyFn = (src: string, dest: string, o: { signal: AbortSignal; onBytes(n: number): void }) => Promise<void>;

/** Injection points for tests (disk errors, free space). */
export interface CollectDeps {
  copyFile?: CollectCopyFn;
  /** Free bytes on the volume of `dir`, null when unknown. */
  freeBytes?: (dir: string) => Promise<number | null>;
  fingerprint?: (file: string) => Promise<string>;
}

/** Bytes kept free beyond the plan (the project file, file system overhead). */
export const COLLECT_SPACE_MARGIN = 64 * 1024 * 1024;
/** OS clutter that does not make a folder "not empty". */
const IGNORABLE = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Stream copy with a byte counter; the file is created exclusively (`wx`) and synced before it resolves. */
export const streamCopy: CollectCopyFn = async (src, dest, { signal, onBytes }) => {
  const counter = new Transform({ transform(chunk: Buffer, _enc, cb) { onBytes(chunk.length); cb(null, chunk); } });
  await pipeline(fs.createReadStream(src, { highWaterMark: 1 << 20 }), counter, fs.createWriteStream(dest, { flags: 'wx' }), { signal });
  const fh = await fsp.open(dest, 'r+');
  try { await fh.sync(); } catch { /* fsync unsupported on some file systems */ } finally { await fh.close(); }
};

async function defaultFreeBytes(dir: string): Promise<number | null> {
  try {
    const s = await fsp.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

async function statSource(p: string): Promise<CollectSourceStat> {
  try {
    const st = await fsp.stat(p);
    return { exists: true, isFile: st.isFile(), size: st.size };
  } catch {
    return { exists: false };
  }
}

/** Why `folder` cannot receive a collect (exists and is not an empty folder), or null when it can. */
export async function collectFolderProblem(folder: string): Promise<string | null> {
  let st: fs.Stats;
  try { st = await fsp.lstat(folder); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return `Cannot use ${folder}: ${errText(e)}`;
  }
  if (!st.isDirectory()) return `${folder} already exists and is not a folder. Choose another destination.`;
  const names = (await fsp.readdir(folder)).filter((n) => !IGNORABLE.has(n));
  if (names.length) return `The folder ${folder} already exists and is not empty. Choose another destination, or empty or rename that folder.`;
  return null;
}

/** A parsed request: the project copy, its plan and where it goes. */
export interface PreparedCollect {
  project: Project;
  plan: CollectPlan;
  options: CollectOptions;
  folder: string;
  projectFile: string;
  freeBytes: number | null;
  /** Reasons the collect cannot start. */
  problems: string[];
}

function parseOptions(o: unknown): CollectOptions {
  const v = (o ?? {}) as Partial<CollectOptions>;
  return { scope: v.scope === 'sequences' ? 'sequences' : 'all', includeSubtitles: v.includeSubtitles !== false, includeProxies: v.includeProxies === true };
}

/** Parse and check a request; stats every source and the destination. Throws for a malformed request. */
export async function prepareCollect(req: CollectRequest, deps: CollectDeps = {}): Promise<PreparedCollect> {
  if (!req || typeof req !== 'object') throw new Error('Collect: no request');
  if (typeof req.destination !== 'string' || !path.isAbsolute(req.destination) || req.destination.includes('\0')) {
    throw new Error('Collect: the destination must be an absolute folder path');
  }
  if (typeof req.projectJson !== 'string') throw new Error('Collect: no project');
  let raw: unknown;
  try { raw = JSON.parse(req.projectJson); } catch (e) { throw new Error(`Collect: the project is not valid JSON (${errText(e)})`); }
  const project = normalizeProject(raw);
  const options = parseOptions(req.options);

  const destination = path.resolve(req.destination);
  const problems: string[] = [];
  let destOk = false;
  try { destOk = (await fsp.stat(destination)).isDirectory(); } catch { /* missing */ }
  if (!destOk) problems.push(`The destination ${destination} does not exist or is not a folder.`);

  const paths = new Set<string>();
  const probe = planCollect(project, options, () => ({ exists: true, isFile: true, size: 0 }));
  for (const e of probe.entries) paths.add(e.source);
  for (const m of probe.missing) paths.add(m.path);
  const stats = new Map<string, CollectSourceStat>();
  await Promise.all([...paths].map(async (p) => { stats.set(p, path.isAbsolute(p) ? await statSource(p) : { exists: false }); }));
  const plan = planCollect(project, options, (p) => stats.get(p));

  const folder = path.join(destination, plan.folderName);
  const projectFile = path.join(folder, plan.projectFileName);
  if (destOk) {
    const fp = await collectFolderProblem(folder);
    if (fp) problems.push(fp);
  }
  const freeBytes = destOk ? await (deps.freeBytes ?? defaultFreeBytes)(destination) : null;
  if (freeBytes !== null && plan.totalBytes + COLLECT_SPACE_MARGIN > freeBytes) {
    problems.push(`Not enough free space on the destination: the collect needs ${formatCollectBytes(plan.totalBytes)}, ${formatCollectBytes(freeBytes)} is free.`);
  }
  return { project, plan, options, folder, projectFile, freeBytes, problems };
}

/** The dialog's summary (IPC collect:preflight). Never throws: a bad request is `{ ok: false }`. */
export async function collectPreflight(req: CollectRequest, deps: CollectDeps = {}): Promise<CollectSummary> {
  try {
    const p = await prepareCollect(req, deps);
    return {
      ok: true, folder: p.folder, projectFile: p.projectFile,
      files: p.plan.entries.length, totalBytes: p.plan.totalBytes, byKind: collectTotalsByKind(p.plan),
      freeBytes: p.freeBytes, missing: p.plan.missing, unusedMedia: p.plan.unusedMedia, problems: [...activeProblem(p.folder), ...p.problems],
    };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

function markerText(projectName: string, state: string): string {
  return [
    `This folder is an UNFINISHED copy of the ReCut project "${projectName}" (File > Collect Project).`,
    '',
    state,
    '',
    'Do not use it: some media may be missing or partly copied, and there is no project file yet.',
    'Delete this folder and run Collect Project again. The original project and media were not changed.',
    '',
  ].join('\n');
}

/** Folders a queued or running collect is writing (so a second collect cannot target them). */
const activeFolders = new Set<string>();
function activeProblem(folder: string): string[] {
  return activeFolders.has(path.resolve(folder)) ? [`Another collect is already writing to ${folder}.`] : [];
}

/** The body of a 'collect' job. Exported for tests; prefer startCollectJob. */
export async function runCollect(prep: PreparedCollect, ctx: JobRunContext, deps: CollectDeps = {}): Promise<CollectResult> {
  const copy = deps.copyFile ?? streamCopy;
  const fingerprint = deps.fingerprint ?? ((f: string) => fingerprintFile(f));
  const { plan, folder, projectFile, project } = prep;
  const marker = path.join(folder, COLLECT_INCOMPLETE_MARKER);
  const canceledError = () => Object.assign(new Error('Collect canceled'), { name: 'AbortError' });

  // Re-check: the folder may have been filled since the preflight.
  const fp = await collectFolderProblem(folder);
  if (fp) throw new Error(fp);
  await ensureDirSafe(folder);
  await fsp.writeFile(marker, markerText(project.name, 'Copying…'));

  const total = Math.max(1, plan.totalBytes);
  let done = 0;
  let current: string | null = null;
  try {
    for (let i = 0; i < plan.entries.length; i++) {
      if (ctx.signal.aborted) throw canceledError();
      const e = plan.entries[i];
      const dest = path.join(folder, ...e.rel.split('/'));
      const part = `${dest}.part`;
      const base = done;
      const label = `${i + 1}/${plan.entries.length} ${path.basename(e.source)}`;
      ctx.setProgress(done / total, `${formatCollectBytes(done)} of ${formatCollectBytes(plan.totalBytes)} · ${label}`);
      await ensureDirSafe(path.dirname(dest));
      let before: fs.Stats;
      try { before = await fsp.stat(e.source); } catch (err) { throw new Error(`cannot read ${e.source}: ${errText(err)}`); }
      current = part;
      try {
        await copy(e.source, part, {
          signal: ctx.signal,
          onBytes: (n) => { done += n; ctx.setProgress(done / total, `${formatCollectBytes(done)} of ${formatCollectBytes(plan.totalBytes)} · ${label}`); },
        });
      } catch (err) {
        if (ctx.signal.aborted) throw canceledError();
        throw new Error(`copying ${e.source} failed: ${errText(err)}`);
      }
      if (ctx.signal.aborted) throw canceledError();
      // Verify: the original did not change while it was copied, and the copy has its size and fingerprint.
      const after = await fsp.stat(e.source);
      const copied = await fsp.stat(part);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error(`${e.source} changed while it was being copied`);
      if (copied.size !== before.size) throw new Error(`the copy of ${e.source} is ${copied.size} bytes, the original ${before.size}`);
      const [a, b] = await Promise.all([fingerprint(e.source), fingerprint(part)]);
      if (a !== b) throw new Error(`the copy of ${e.source} does not match the original (fingerprint differs)`);
      await fsp.rename(part, dest);
      current = null;
      await fsp.utimes(dest, before.atime, before.mtime).catch(() => undefined);
      done = base + before.size;
    }
    if (ctx.signal.aborted) throw canceledError();
    ctx.setProgress(1, 'Writing the project file');
    rewriteCollectedProject(project, plan, (rel) => path.join(folder, ...rel.split('/')));
    await atomicWriteFile(projectFile, serializeProject(project), { backup: false });
    await fsp.rm(marker, { force: true });
    return { folder, projectFile, files: plan.entries.length, bytes: plan.totalBytes, missing: plan.missing };
  } catch (err) {
    if (current) await fsp.rm(current, { force: true }).catch(() => undefined);
    const canceled = ctx.signal.aborted;
    const reason = canceled ? 'The collect was canceled.' : `The collect failed: ${errText(err)}`;
    await fsp.writeFile(marker, markerText(project.name, reason)).catch(() => undefined);
    if (canceled) throw err;
    throw new Error(`${errText(err)}. ${folder} is incomplete (see ${COLLECT_INCOMPLETE_MARKER}); the original project and media were not changed.`);
  }
}

/**
 * Check the request and queue a 'collect' job (export lane: one heavy write job at a time). Refused (`ok: false`)
 * when the preflight finds a problem. `onDone` fires when the job settles.
 */
export async function startCollectJob(
  queue: JobQueue, req: CollectRequest, deps: CollectDeps = {},
  onDone?: (job: JobInfo) => void,
): Promise<CollectStartResult> {
  let prep: PreparedCollect;
  try { prep = await prepareCollect(req, deps); } catch (e) { return { ok: false, error: errText(e) }; }
  const problems = [...activeProblem(prep.folder), ...prep.problems];
  if (problems.length) return { ok: false, error: problems.join(' ') };
  const key = path.resolve(prep.folder);
  activeFolders.add(key);
  const job = queue.add<CollectResult>({
    kind: 'collect',
    title: `Collect project · ${prep.project.name}`,
    run: (ctx) => runCollect(prep, ctx, deps),
  });
  void queue.waitFor(job.id).then((final) => { activeFolders.delete(key); onDone?.(final); });
  return { ok: true, jobId: job.id, folder: prep.folder, projectFile: prep.projectFile };
}
