/**
 * Project lifecycle: new / open / save / save-as, autosave + startup recovery, quit confirmation,
 * window + top-bar title sync, missing-media check after open.
 *
 * Every `window.recut` access is guarded so this module is importable under vitest/node.
 */
import { useStore } from '@/state/store';
import {
  DEFAULT_PROJECT_NAME, autosaveProject, openProject, projectFromReply, projectNameFromPath, recutApi, repairedMessage, saveProject,
  verifyMediaOnline,
} from '@/state/mediaActions';
import { activeSequence } from '@/state/selectors';
import type { RecoveryReply } from '@shared/ipc';
import { useShellStore } from './shellStore';
import { setBeforeQuitHandler, setOpenProjectPathHandler } from './bootstrap';
import { registerCommand } from '@/keyboard/shortcuts';
import { toast } from '@/components/ui/toastStore';
import { confirm, confirmInApp, type ConfirmOptions } from './dialogs/ConfirmDialog';
import { createAutosaveGate } from './autosaveGate';

export const PROJECT_FILTERS = [{ name: 'ReCut Project', extensions: ['recut'] }];
/** Debounce after the last change before an autosave is written. */
export const AUTOSAVE_DEBOUNCE_MS = 5000;
const DEFAULT_AUTOSAVE_INTERVAL_SEC = 60;
/**
 * An autosave waits for a pause in the user's work (autosaveGate.ts): no store update and no input for
 * AUTOSAVE_QUIET_MS; after AUTOSAVE_PATIENCE_MS of waiting, any AUTOSAVE_SHORT_QUIET_MS pause; after
 * AUTOSAVE_MAX_DEFER_MS, regardless.
 */
export const AUTOSAVE_QUIET_MS = 3000;
export const AUTOSAVE_SHORT_QUIET_MS = 250;
export const AUTOSAVE_PATIENCE_MS = 20_000;
export const AUTOSAVE_MAX_DEFER_MS = 60_000;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function fileName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

// One definition (src/state/mediaActions.ts) shared by every open path.
export { DEFAULT_PROJECT_NAME, projectNameFromPath, repairedMessage };

/** A still-default project name is replaced by the file's basename (first save / Save As / open). */
function adoptFileName(target: string): void {
  const st = useStore.getState();
  const name = projectNameFromPath(target);
  if (name && st.project.name === DEFAULT_PROJECT_NAME) st.renameProject(name);
}

// ------------------------------------------------------------------
// Save / open / new
// ------------------------------------------------------------------

/** Save to the current path, or ask for one. Resolves true when the project was saved. */
export async function requestSave(): Promise<boolean> {
  const st = useStore.getState();
  if (!st.projectPath) return requestSaveAs();
  try {
    const res = await saveProject(st.projectPath);
    if (!res.ok) { toast('error', res.error); return false; }
    toast('ok', `Saved ${fileName(res.path)}`);
    return true;
  } catch (e) { toast('error', `Save failed: ${errText(e)}`); return false; }
}

/** Save-as via the native save dialog. Resolves true when saved. */
export async function requestSaveAs(): Promise<boolean> {
  const api = recutApi();
  if (!api) { toast('warn', 'Saving requires the desktop app'); return false; }
  const st = useStore.getState();
  try {
    const target = await api.saveFile({
      title: 'Save Project As', filters: PROJECT_FILTERS,
      defaultPath: st.projectPath ?? `${st.project.name.replace(/[\\/:*?"<>|]+/g, '_') || 'Untitled'}.recut`,
    });
    if (!target) return false;
    adoptFileName(target);
    const res = await saveProject(target);
    if (!res.ok) { toast('error', res.error); return false; }
    toast('ok', `Saved ${fileName(res.path)}`);
    return true;
  } catch (e) { toast('error', `Save failed: ${errText(e)}`); return false; }
}

/**
 * Save before the project is closed or replaced. True only when nothing is left unsaved: edits made while the
 * save was in flight are not in the file and keep the project dirty, so closing now would lose them.
 */
async function saveBeforeClose(): Promise<boolean> {
  if (!(await requestSave())) return false;
  if (!useStore.getState().dirty) return true;
  toast('warn', 'Changes made while saving are not saved yet. Save again.');
  return false;
}

/**
 * When the project has unsaved changes, ask Save / Don't Save / Cancel.
 * Resolves true when it is safe to proceed (saved or discarded).
 */
export async function confirmDiscardIfDirty(): Promise<boolean> {
  const st = useStore.getState();
  if (!st.dirty) return true;
  const i = await confirm({
    type: 'question', title: 'Unsaved changes',
    message: `Save changes to "${st.project.name}"?`,
    detail: 'Your changes will be lost if you don\'t save them.',
    buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2,
  });
  if (i === 0) return saveBeforeClose();
  return i === 1;
}

export async function requestNewProject(): Promise<boolean> {
  if (!(await confirmDiscardIfDirty())) return false;
  useStore.getState().newProject();
  return true;
}

/** After a project was loaded: check media files exist; prompt relink when some are missing. */
export async function checkMissingMedia(): Promise<string[]> {
  try {
    const missing = await verifyMediaOnline();
    if (missing.length) {
      toast('warn', `${missing.length} media file${missing.length === 1 ? ' is' : 's are'} offline`);
      useStore.getState().openDialog('relink');
    }
    return missing;
  } catch { return []; }
}

/** Open a project from `path`, or ask for one. Resolves true when a project was loaded. */
export async function requestOpenProject(path?: string): Promise<boolean> {
  const api = recutApi();
  if (!api) { toast('warn', 'Opening projects requires the desktop app'); return false; }
  if (!(await confirmDiscardIfDirty())) return false;
  try {
    let target = path;
    if (!target) {
      const picked = await api.openFiles({ title: 'Open Project', filters: PROJECT_FILTERS, multi: false });
      target = picked[0];
    }
    if (!target) return false;
    // Same load + backup / repair warnings as actions.openProject; warnings use the shell toasts here.
    const res = await openProject(target, { notify: (kind, text, ms) => { toast(kind, text, ms); } });
    if (!res.ok) { toast('error', res.error); return false; }
    if (!res.warned) toast('ok', `Opened ${res.project.name}`);
    void checkMissingMedia();
    return true;
  } catch (e) { toast('error', `Open failed: ${errText(e)}`); return false; }
}

// ------------------------------------------------------------------
// Title sync
// ------------------------------------------------------------------

function syncTitle(): void {
  const st = useStore.getState();
  const seq = activeSequence(st);
  const name = st.project.name || 'Untitled Project';
  useShellStore.getState().setProjectTitle({ projectName: name, sequenceName: seq?.name ?? null, dirty: st.dirty });
  // "<project>[ *] — ReCut"; the Electron window title follows document.title (main.ts does not override it).
  if (typeof document !== 'undefined') document.title = `${name}${st.dirty ? ' *' : ''} — ReCut`;
}

// ------------------------------------------------------------------
// Autosave
// ------------------------------------------------------------------

let autosaveInFlight = false;
let lastAutosaveAt = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let idleHandle: number | null = null;
/** Waiting for the user to be quiet before asking for idle time again (autosaveGate). */
let quietTimer: ReturnType<typeof setTimeout> | null = null;
const gate = createAutosaveGate({
  quietMs: AUTOSAVE_QUIET_MS, shortQuietMs: AUTOSAVE_SHORT_QUIET_MS, patienceMs: AUTOSAVE_PATIENCE_MS, maxDeferMs: AUTOSAVE_MAX_DEFER_MS,
  now: () => performance.now(),
});
/** An autosave came due while playing; run it (debounced) once playback stops. */
let deferredWhilePlaying = false;

type IdleApi = { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void };
const idleApi = (): IdleApi => globalThis as unknown as IdleApi;

/**
 * Run `fn` when the renderer is idle (after paint / input) and the user has paused (autosaveGate): idle time alone
 * is not enough, a scrub or a drag leaves some after every frame, and the save is one long task.
 */
function whenIdle(fn: () => void): void {
  if (idleHandle !== null || quietTimer !== null) return; // one pending idle autosave is enough
  const run = () => {
    idleHandle = null;
    const wait = gate.waitMs();
    if (wait > 0) { quietTimer = setTimeout(() => { quietTimer = null; whenIdle(fn); }, wait); return; }
    fn();
  };
  const ric = idleApi().requestIdleCallback;
  if (ric) idleHandle = ric(run, { timeout: 3000 });
  else { idleHandle = -1; setTimeout(run, 0); }
}
function cancelIdle(): void {
  if (idleHandle !== null && idleHandle >= 0) idleApi().cancelIdleCallback?.(idleHandle);
  idleHandle = null;
  if (quietTimer !== null) { clearTimeout(quietTimer); quietTimer = null; }
  gate.reset();
}

async function runAutosave(force = false): Promise<void> {
  if (autosaveInFlight) return;
  const st = useStore.getState();
  if (!st.dirty || st.transaction) return;
  // Never autosave while playing: serialising + cloning a big project stalls playback (P-06).
  if (!force && st.playback.playing) { deferredWhilePlaying = true; return; }
  autosaveInFlight = true;
  try { await autosaveProject(); lastAutosaveAt = Date.now(); }
  catch (e) { console.warn('[autosave] failed', e); }
  finally { autosaveInFlight = false; }
}

function scheduleDebouncedAutosave(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { debounceTimer = null; whenIdle(() => { void runAutosave(); }); }, AUTOSAVE_DEBOUNCE_MS);
}

function autosaveTick(): void {
  const st = useStore.getState();
  if (!st.dirty) return;
  if (st.playback.playing) { deferredWhilePlaying = true; return; }
  const sec = st.project.settings.autosaveIntervalSec > 0 ? st.project.settings.autosaveIntervalSec : DEFAULT_AUTOSAVE_INTERVAL_SEC;
  if (Date.now() - lastAutosaveAt >= sec * 1000) whenIdle(() => { void runAutosave(); });
}

/** Force an autosave now (tests / before risky operations). */
export function autosaveNow(): Promise<void> { return runAutosave(true); }

// ------------------------------------------------------------------
// Recovery
// ------------------------------------------------------------------

/** The startup recovery prompt; warns when the autosave needed repairs to load (RecoveryInfo.repaired). */
export function recoveryPrompt(info: RecoveryReply): ConfirmOptions {
  const when = new Date(info.savedAt).toLocaleString();
  const name = 'projectWire' in info ? info.projectName : info.project?.name;
  const what = info.projectPath ? `"${name ?? fileName(info.projectPath)}" (${fileName(info.projectPath)})` : 'an unsaved project';
  const repaired = Array.isArray(info.repaired) ? info.repaired : [];
  const n = repaired.length;
  const damage = n
    ? ` The autosave was damaged and has been repaired (${repaired.slice(0, 3).join('; ')}${n > 3 ? `; and ${n - 3} more` : ''}): check the recovered edit before saving over the project.`
    : '';
  return {
    title: 'Recover unsaved changes?',
    message: `Recover unsaved changes from ${when}?`,
    detail: `ReCut found an autosave for ${what} that is newer than the last save.${damage}`,
    buttons: ['Recover', 'Discard'], defaultId: 0, cancelId: 1, testId: 'recovery-dialog',
    ...(n ? { type: 'warning' as const } : {}),
  };
}

export async function checkStartupRecovery(): Promise<boolean> {
  const api = recutApi();
  if (!api?.checkRecovery) return false;
  let info: Awaited<ReturnType<typeof api.checkRecovery>> = null;
  try { info = await api.checkRecovery(); } catch (e) { console.warn('[recovery] check failed', e); return false; }
  if (!info) return false;
  const choice = await confirmInApp(recoveryPrompt(info));
  if (choice === 0) {
    try {
      // Normalized once: by main for a projectWire, here for a plain object (older bridge).
      const project = await projectFromReply(info);
      useStore.getState().loadProjectData(project, info.projectPath);
      // Recovered content differs from the file on disk: keep it dirty so the user is asked to save.
      useStore.setState({ dirty: true });
      lastAutosaveAt = Date.now();
      toast('ok', `Recovered unsaved changes to ${project.name}`);
      void checkMissingMedia();
      return true;
    } catch (e) { toast('error', `Could not recover autosave: ${errText(e)}`); return false; }
  }
  try { await api.discardRecovery(info.autosavePath); } catch { /* ignore */ }
  return false;
}

// ------------------------------------------------------------------
// Quit
// ------------------------------------------------------------------

async function handleBeforeQuit(): Promise<void> {
  const api = recutApi();
  if (!api) return;
  // Tell main we are alive and handling the request: it drops its hung-renderer fallback timer.
  try { await api.quitAck?.(); } catch { /* older main: falls back to its timer */ }
  const st = useStore.getState();
  if (!st.dirty) { await api.quit(true); return; }
  let i = 2;
  try {
    i = await api.message({
      type: 'question', title: 'Quit ReCut', message: `Save changes to "${st.project.name}" before quitting?`,
      buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2,
    });
  } catch (e) { console.error('[quit] prompt failed', e); }
  if (i === 0) {
    if (await saveBeforeClose()) { await api.quit(true); return; }
  } else if (i === 1) {
    await api.quit(true);
    return;
  }
  // Cancel, or the save was cancelled / failed / left edits unsaved: stay open.
  await api.quitCancel?.();
}

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------

let initialized = false;
let disposers: (() => void)[] = [];

/** Wire project lifecycle. Idempotent; returns a dispose function. */
export function initProjectLifecycle(): () => void {
  if (initialized) return disposeProjectLifecycle;
  initialized = true;

  // (e) title sync
  syncTitle();
  let prevCommitKey: unknown = null;
  disposers.push(useStore.subscribe((s, prev) => {
    // The user at work: an edit, a playhead / view move (viewTick: setView moves the playhead in place), a selection.
    if (s.project !== prev.project || s.viewTick !== prev.viewTick || s.ui !== prev.ui || s.transaction !== prev.transaction) gate.activity();
    if (s.project !== prev.project || s.dirty !== prev.dirty || s.projectPath !== prev.projectPath) syncTitle();
    // (c) debounced autosave after the last committed change (history grows / project replaced)
    const key = s.history.past.length + ':' + s.history.future.length;
    if (s.dirty && !s.transaction && (key !== prevCommitKey || !prev.dirty)) scheduleDebouncedAutosave();
    prevCommitKey = key;
    if (!s.dirty && debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (!s.dirty) { cancelIdle(); deferredWhilePlaying = false; }
    // Playback stopped with an autosave pending: save once things settle.
    if (prev.playback.playing && !s.playback.playing && deferredWhilePlaying && s.dirty) { deferredWhilePlaying = false; scheduleDebouncedAutosave(); }
  }));

  // (c) interval autosave
  intervalTimer = setInterval(autosaveTick, 1000);
  // Input that may not reach the store (a drag before it commits, hover-free keys, wheel) also defers a save.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const onInput = (e: Event) => { if (e.type !== 'pointermove' || (e as PointerEvent).buttons !== 0) gate.activity(); };
    const types = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;
    for (const t of types) window.addEventListener(t, onInput, { capture: true, passive: true });
    disposers.push(() => { for (const t of types) window.removeEventListener(t, onInput, { capture: true }); });
  }
  disposers.push(() => { if (intervalTimer) clearInterval(intervalTimer); intervalTimer = null; });

  // (b) OS / recent-menu open requests
  setOpenProjectPathHandler((path) => { void requestOpenProject(path); });

  // (d) quit
  setBeforeQuitHandler(handleBeforeQuit);

  // (h) clear recent
  disposers.push(registerCommand({
    id: 'file.clearRecent', title: 'Clear Recent Projects', category: 'File',
    run: () => { recutApi()?.setPrefs({ recentProjects: [] }).then(() => toast('info', 'Recent projects cleared')).catch(() => { /* ignore */ }); },
  }));

  // (a) recovery
  void checkStartupRecovery();

  return disposeProjectLifecycle;
}

export function disposeProjectLifecycle(): void {
  disposers.forEach((d) => { try { d(); } catch { /* ignore */ } });
  disposers = [];
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  cancelIdle();
  deferredWhilePlaying = false;
  initialized = false;
}
