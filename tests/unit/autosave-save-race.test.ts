/**
 * bugs/closed/2026-10-08-autosave-after-save-spurious-recovery.md
 *
 * An autosave that snapshotted the project before (or while) a manual save ran must not land after that save: it
 * holds nothing the project file lacks, but written after it, it is offered for recovery on the next launch. For a
 * never-saved project it is the untitled autosave, written after the save dropped it (electron/ipc.ts afterSave ->
 * clearUntitledAutosaveForId), and startup recovery offers the untitled autosave whatever its age: a clean save +
 * quit then opened with "Recover unsaved changes?" (gauntlet TEST 1, Windows CI).
 *
 * Runs the real store, saveProject / autosaveProject and the real main-side file writers in a temp dir, with a
 * window.recut that mirrors electron/ipc.ts and lets the test hold an autosave at a chosen point. Recovery is
 * checked with the real checkRecovery.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProjectAutosaveStreamApi, ProjectSaveStreamApi } from '../../shared/projectWire';
import { autosavePathFor, checkRecovery, clearUntitledAutosaveForId, ProjectFileWriter, RENAME_RETRY, untitledAutosavePath, writeAutosaveJson, saveProjectJson, topLevelProjectId } from '../../electron/project/io';
import { useStore, resetStore } from '../../src/state/store';
import { autosaveProject, saveProject } from '../../src/state/mediaActions';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const g = globalThis as Any;
const S = () => useStore.getState();

let tmp: string;
let userData: string;
let projectPath: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'recut-autosave-race-'));
  userData = path.join(tmp, 'userData');
  projectPath = path.join(tmp, 'edit.recut');
  resetStore();
  g.window = globalThis;
});
const savedRetry = { enabled: RENAME_RETRY.enabled, delaysMs: [...RENAME_RETRY.delaysMs] };
afterEach(async () => {
  vi.restoreAllMocks();
  RENAME_RETRY.enabled = savedRetry.enabled;
  RENAME_RETRY.delaysMs = [...savedRetry.delaysMs];
  delete g.recut;
  delete g.window;
  await fsp.rm(tmp, { recursive: true, force: true });
});

/** A point the fake main stops at until the test releases it. */
interface Hold { reached: Promise<void>; release: () => void; wait: () => Promise<void> }
function hold(): Hold {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => { reach = r; });
  const released = new Promise<void>((r) => { release = r; });
  return { reached, release, wait: () => { reach(); return released; } };
}

interface Holds { autosaveBegin?: Hold; autosaveCommit?: Hold; saveCommit?: Hold }

/** window.recut streaming saves and autosaves into real ProjectFileWriters, like electron/ipc.ts does. */
function streamingMain(holds: Holds) {
  const writers = new Map<string, ProjectFileWriter>();
  let n = 0;
  const api: ProjectSaveStreamApi & ProjectAutosaveStreamApi = {
    saveProjectBegin: async (p) => {
      const w = await ProjectFileWriter.open(p); const id = `s${n++}`; writers.set(id, w); return { ok: true, id };
    },
    saveProjectChunk: (id, seq, text) => { writers.get(id)?.append(seq, text); },
    saveProjectCommit: async (id, totals) => {
      await holds.saveCommit?.wait();
      const w = writers.get(id)!;
      writers.delete(id);
      const res = await w.commit(totals);
      if (res.ok) await clearUntitledAutosaveForId(w.projectId(), userData); // ipc.ts afterSave
      return res;
    },
    saveProjectAbort: async (id) => { await writers.get(id)?.abort(); writers.delete(id); },
    autosaveProjectBegin: async (p) => {
      await holds.autosaveBegin?.wait();
      const w = await ProjectFileWriter.openAutosave(p, userData); const id = `a${n++}`; writers.set(id, w); return { ok: true, id };
    },
    autosaveProjectCommit: async (p, id, totals) => {
      await holds.autosaveCommit?.wait();
      const w = writers.get(id)!;
      writers.delete(id);
      if (autosavePathFor(p, userData) !== w.path) { await w.abort(); return { ok: false, error: 'Autosave failed: the autosave was started for another project' }; }
      return w.commit(totals);
    },
  };
  g.recut = api;
}

/** window.recut with the one-string writes (saveProjectJson / autosaveProjectJson), like electron/ipc.ts does. */
function jsonMain(holds: Holds) {
  g.recut = {
    saveProjectJson: async (p: string, json: string) => {
      await holds.saveCommit?.wait();
      const res = await saveProjectJson(p, json);
      if (res.ok) await clearUntitledAutosaveForId(topLevelProjectId(json), userData);
      return res;
    },
    autosaveProjectJson: async (p: string | null, json: string) => {
      await holds.autosaveCommit?.wait();
      return writeAutosaveJson(p, json, userData);
    },
  };
}

const ticks = async (k = 50) => { for (let i = 0; i < k; i++) await new Promise((r) => setTimeout(r, 0)); };
const leftovers = async (dir: string) => (await fsp.readdir(dir).catch(() => [] as string[])).filter((x) => x.includes('.tmp-'));
/** What the next launch offers for recovery (the save adds the project to the recent list). */
const recovery = () => checkRecovery(userData, [projectPath]);

/** A never-saved project with an edit: dirty, autosaving to the untitled autosave. */
function untitledEdit(name = 'Cut A') {
  S().newProject('Edit');
  S().renameProject(name);
  expect(S().dirty).toBe(true);
  expect(S().projectPath).toBe(null);
}

describe.each([
  ['streamed writes', streamingMain],
  ['one-string writes', jsonMain],
] as const)('a clean save + quit never leaves an autosave that recovery offers (%s)', (_label, main) => {
  it('an autosave already being written by main when the save starts lands before the save (first save of an untitled project)', async () => {
    const autosaveCommit = hold();
    main({ autosaveCommit });
    untitledEdit();
    const auto = autosaveProject();
    await autosaveCommit.reached; // main is writing the autosave
    const save = saveProject(projectPath);
    await ticks();
    autosaveCommit.release();
    await auto;
    expect((await save).ok).toBe(true);
    expect(S().dirty).toBe(false);

    // Quit (clean: nothing to save), relaunch.
    expect(fs.existsSync(untitledAutosavePath(userData))).toBe(false);
    expect(await recovery()).toBe(null);
  });

  it('an autosave that reaches its write while a save of the same content is running is dropped', async () => {
    const saveCommit = hold();
    main({ saveCommit });
    untitledEdit();
    const save = saveProject(projectPath);
    await saveCommit.reached; // the save is being written; the project is still dirty
    const auto = autosaveProject(); // the lifecycle's interval / idle autosave comes due now
    await ticks();
    saveCommit.release();
    expect((await save).ok).toBe(true);
    await auto;
    expect(S().dirty).toBe(false);
    expect(fs.existsSync(untitledAutosavePath(userData))).toBe(false);
    expect(await leftovers(path.dirname(untitledAutosavePath(userData)))).toEqual([]);
    expect(await recovery()).toBe(null);
  });
});

describe('streamed autosave serialized while a save runs', () => {
  it('an autosave that snapshotted the project before the save and commits after it is dropped (no temp file left)', async () => {
    const autosaveBegin = hold();
    streamingMain({ autosaveBegin });
    untitledEdit();
    const auto = autosaveProject(); // snapshot taken; main is slow to open its temp file (the serialization goes on)
    await autosaveBegin.reached;
    expect((await saveProject(projectPath)).ok).toBe(true);
    expect(S().dirty).toBe(false);
    autosaveBegin.release(); // the autosave reaches its commit after the save
    await auto;
    expect(fs.existsSync(untitledAutosavePath(userData))).toBe(false);
    expect(await leftovers(path.dirname(untitledAutosavePath(userData)))).toEqual([]);
    expect(await recovery()).toBe(null);
  });

  it('the same for a project saved before: its <project>.autosave is not left newer than the project file', async () => {
    const autosaveBegin = hold();
    streamingMain({});
    untitledEdit();
    expect((await saveProject(projectPath)).ok).toBe(true);
    // Make the save old, so an autosave written now is clearly newer than the project file.
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(projectPath, old, old);
    S().renameProject('Cut B');
    streamingMain({ autosaveBegin });
    const auto = autosaveProject();
    await autosaveBegin.reached;
    expect((await saveProject()).ok).toBe(true);
    fs.utimesSync(projectPath, old, old);
    autosaveBegin.release();
    await auto;
    expect(fs.existsSync(autosavePathFor(projectPath, userData))).toBe(false);
    expect(await recovery()).toBe(null);
  });
});

describe('a real crash still offers recovery', () => {
  it('edits made after the save are autosaved and offered (the stale in-flight autosave is dropped, the next one lands)', async () => {
    const autosaveBegin = hold();
    streamingMain({ autosaveBegin });
    untitledEdit();
    const stale = autosaveProject();
    await autosaveBegin.reached;
    expect((await saveProject(projectPath)).ok).toBe(true);
    S().renameProject('Cut after save'); // unsaved edit
    autosaveBegin.release();
    await stale;
    streamingMain({});
    await autosaveProject();
    // The process dies here (no save). The project file is older than the autosave.
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(projectPath, old, old);
    const info = await recovery();
    expect(info?.autosavePath).toBe(autosavePathFor(projectPath, userData));
    expect(info?.project.name).toBe('Cut after save');
  });

  it('an autosave of edits made during the save (newer than the save) is written at once, not held or dropped', async () => {
    streamingMain({});
    untitledEdit('Cut A');
    expect((await saveProject(projectPath)).ok).toBe(true);
    S().renameProject('Cut B');
    const saveCommit = hold();
    streamingMain({ saveCommit });
    const save = saveProject();
    await saveCommit.reached;
    S().renameProject('Cut during save'); // not in the file being written
    await autosaveProject(); // lands while the save is still being written
    const autoFile = autosavePathFor(projectPath, userData);
    expect(JSON.parse(fs.readFileSync(autoFile, 'utf8')).name).toBe('Cut during save');
    saveCommit.release();
    expect((await save).ok).toBe(true);
    expect(S().dirty).toBe(true);
    // (mediaActions autosaveAfterSave then autosaves again once the save is older; covered in autosave-stream.test.ts.)
    expect(fs.existsSync(autoFile)).toBe(true);
  });

  it('an untitled project that was never saved is offered after a crash', async () => {
    streamingMain({});
    untitledEdit('Never saved');
    await autosaveProject();
    const info = await checkRecovery(userData, []);
    expect(info?.projectPath).toBe(null);
    expect(info?.project.name).toBe('Never saved');
  });
});

describe('Windows: the save cannot remove the untitled autosave at once (a scan holds the just-written file)', () => {
  it('the removal is retried, so the autosave is not left to be offered', async () => {
    RENAME_RETRY.enabled = true;
    RENAME_RETRY.delaysMs = [1, 1, 1, 1];
    streamingMain({});
    untitledEdit();
    await autosaveProject();
    expect(fs.existsSync(untitledAutosavePath(userData))).toBe(true);
    const realRm = fsp.rm.bind(fsp);
    let refused = 0;
    vi.spyOn(fsp, 'rm').mockImplementation(async (p, o) => {
      if (String(p) === untitledAutosavePath(userData) && refused < 2) { refused++; throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); }
      return realRm(p, o);
    });
    expect((await saveProject(projectPath)).ok).toBe(true);
    expect(refused).toBe(2);
    expect(fs.existsSync(untitledAutosavePath(userData))).toBe(false);
    expect(await recovery()).toBe(null);
  });
});
