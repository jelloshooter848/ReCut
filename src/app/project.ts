/**
 * Project lifecycle: new / open / save / save-as, autosave + startup recovery, quit confirmation,
 * window + top-bar title sync, missing-media check after open.
 *
 * Every `window.recut` access is guarded so this module is importable under vitest/node.
 */
import { useStore } from '@/state/store';
import { autosaveProject, openProject, recutApi, saveProject, verifyMediaOnline } from '@/state/mediaActions';
import { activeSequence } from '@/state/selectors';
import { normalizeProject } from '@shared/project';
import { useShellStore } from './shellStore';
import { setBeforeQuitHandler, setOpenProjectPathHandler } from './bootstrap';
import { registerCommand } from '@/keyboard/shortcuts';
import { toast } from '@/components/ui/toastStore';
import { confirm, confirmInApp } from './dialogs/ConfirmDialog';

export const PROJECT_FILTERS = [{ name: 'ReCut Project', extensions: ['recut'] }];
/** Debounce after the last change before an autosave is written. */
export const AUTOSAVE_DEBOUNCE_MS = 5000;
const DEFAULT_AUTOSAVE_INTERVAL_SEC = 60;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function fileName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
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
    const res = await saveProject(target);
    if (!res.ok) { toast('error', res.error); return false; }
    toast('ok', `Saved ${fileName(res.path)}`);
    return true;
  } catch (e) { toast('error', `Save failed: ${errText(e)}`); return false; }
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
  if (i === 0) return requestSave();
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
    const res = await openProject(target);
    if (!res.ok) { toast('error', res.error); return false; }
    toast('ok', `Opened ${res.project.name}`);
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
  if (typeof document !== 'undefined') document.title = `${name}${st.dirty ? ' *' : ''} — ReCut`;
}

// ------------------------------------------------------------------
// Autosave
// ------------------------------------------------------------------

let autosaveInFlight = false;
let lastAutosaveAt = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;

async function runAutosave(): Promise<void> {
  if (autosaveInFlight) return;
  const st = useStore.getState();
  if (!st.dirty || st.transaction) return;
  autosaveInFlight = true;
  try { await autosaveProject(); lastAutosaveAt = Date.now(); }
  catch (e) { console.warn('[autosave] failed', e); }
  finally { autosaveInFlight = false; }
}

function scheduleDebouncedAutosave(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { debounceTimer = null; void runAutosave(); }, AUTOSAVE_DEBOUNCE_MS);
}

function autosaveTick(): void {
  const st = useStore.getState();
  if (!st.dirty) return;
  const sec = st.project.settings.autosaveIntervalSec > 0 ? st.project.settings.autosaveIntervalSec : DEFAULT_AUTOSAVE_INTERVAL_SEC;
  if (Date.now() - lastAutosaveAt >= sec * 1000) void runAutosave();
}

/** Force an autosave now (tests / before risky operations). */
export function autosaveNow(): Promise<void> { return runAutosave(); }

// ------------------------------------------------------------------
// Recovery
// ------------------------------------------------------------------

export async function checkStartupRecovery(): Promise<boolean> {
  const api = recutApi();
  if (!api?.checkRecovery) return false;
  let info: Awaited<ReturnType<typeof api.checkRecovery>> = null;
  try { info = await api.checkRecovery(); } catch (e) { console.warn('[recovery] check failed', e); return false; }
  if (!info) return false;
  const when = new Date(info.savedAt).toLocaleString();
  const what = info.projectPath ? `"${info.project?.name ?? fileName(info.projectPath)}" (${fileName(info.projectPath)})` : 'an unsaved project';
  const choice = await confirmInApp({
    title: 'Recover unsaved changes?',
    message: `Recover unsaved changes from ${when}?`,
    detail: `ReCut found an autosave for ${what} that is newer than the last save.`,
    buttons: ['Recover', 'Discard'], defaultId: 0, cancelId: 1, testId: 'recovery-dialog',
  });
  if (choice === 0) {
    try {
      const project = normalizeProject(info.project);
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
  const st = useStore.getState();
  if (!st.dirty) { await api?.quit(true); return; }
  if (!api) return;
  const i = await api.message({
    type: 'question', title: 'Quit ReCut', message: `Save changes to "${st.project.name}" before quitting?`,
    buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2,
  });
  if (i === 0) {
    const ok = await requestSave();
    if (ok) await api.quit(true);
    // Save cancelled/failed: stay open (the main process only quits on quit(true)).
  } else if (i === 1) {
    await api.quit(true);
  }
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
    if (s.project !== prev.project || s.dirty !== prev.dirty || s.projectPath !== prev.projectPath) syncTitle();
    // (c) debounced autosave after the last committed change (history grows / project replaced)
    const key = s.history.past.length + ':' + s.history.future.length;
    if (s.dirty && !s.transaction && (key !== prevCommitKey || !prev.dirty)) scheduleDebouncedAutosave();
    prevCommitKey = key;
    if (!s.dirty && debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  }));

  // (c) interval autosave
  intervalTimer = setInterval(autosaveTick, 1000);
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
  initialized = false;
}
