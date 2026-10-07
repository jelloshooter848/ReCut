/**
 * Wires the Electron bridge (window.recut) into the renderer: menu → commands, jobs → jobsStore, before-quit handling.
 * Safe to call without the preload (every window.recut access is guarded).
 */
import { COMMAND_IDS } from '@/keyboard/commandIds';
import { registerShellCommands } from '@/keyboard/commands';
import { getCommand, loadOverrides, runCommand } from '@/keyboard/shortcuts';
import { useJobsStore } from './jobsStore';
import { toast } from '@/components/ui/toastStore';

/** Menu command names (sent by the main process menu) → command ids. Unknown names are tried as command ids directly. */
export const menuCommandMap: Record<string, string> = {
  'file.new': COMMAND_IDS.newProject,
  'file.newProject': COMMAND_IDS.newProject,
  'file.open': COMMAND_IDS.openProject,
  'file.openProject': COMMAND_IDS.openProject,
  'file.save': COMMAND_IDS.save,
  'file.saveAs': COMMAND_IDS.saveAs,
  'file.import': COMMAND_IDS.importMedia,
  'file.importMedia': COMMAND_IDS.importMedia,
  'file.export': COMMAND_IDS.export,
  'file.newSequence': COMMAND_IDS.newSequence,
  'sequence.new': COMMAND_IDS.newSequence,
  'edit.undo': COMMAND_IDS.undo,
  'edit.redo': COMMAND_IDS.redo,
  'edit.cut': COMMAND_IDS.cut,
  'edit.copy': COMMAND_IDS.copy,
  'edit.paste': COMMAND_IDS.paste,
  'edit.delete': COMMAND_IDS.deleteSelection,
  'edit.rippleDelete': COMMAND_IDS.rippleDelete,
  'edit.selectAll': COMMAND_IDS.selectAll,
  'edit.deselectAll': COMMAND_IDS.deselectAll,
  'edit.addEdit': COMMAND_IDS.addEdit,
  'sequence.addEdit': COMMAND_IDS.addEdit,
  'sequence.addMarker': COMMAND_IDS.addMarker,
  'marker.add': COMMAND_IDS.addMarker,
  'mark.in': COMMAND_IDS.markIn,
  'mark.out': COMMAND_IDS.markOut,
  'mark.clear': COMMAND_IDS.clearInOut,
  'clip.enable': COMMAND_IDS.toggleClipEnabled,
  'clip.link': COMMAND_IDS.linkUnlink,
  'view.zoomIn': COMMAND_IDS.zoomIn,
  'view.zoomOut': COMMAND_IDS.zoomOut,
  'view.zoomToFit': COMMAND_IDS.zoomToFit,
  'view.zoomFit': COMMAND_IDS.zoomToFit,
  'view.fullscreen': COMMAND_IDS.toggleFullscreen,
  'view.toggleFullscreen': COMMAND_IDS.toggleFullscreen,
  'view.maximizePanel': COMMAND_IDS.maximizePanel,
  'window.maximizePanel': COMMAND_IDS.maximizePanel,
  'window.workspace.editing': COMMAND_IDS.workspaceEditing,
  'window.workspace.research': COMMAND_IDS.workspaceResearch,
  'window.workspace.audio': COMMAND_IDS.workspaceAudio,
  'window.workspace.compare': COMMAND_IDS.workspaceCompare,
  'window.workspace.reset': COMMAND_IDS.resetWorkspace,
  'window.resetLayout': COMMAND_IDS.resetWorkspace,
  'help.shortcuts': COMMAND_IDS.openShortcuts,
  'help.keyboardShortcuts': COMMAND_IDS.openShortcuts,
  // Names sent by electron/menu.ts whose ids are registered by src/app/commands.ts / project.ts (identity mappings kept explicit).
  'file.clearRecent': 'file.clearRecent',
  'file.importSubtitles': 'file.importSubtitles',
  'sequence.duplicate': 'sequence.duplicate',
  'sequence.duplicateWithoutDisabled': 'sequence.duplicateWithoutDisabled',
  'sequence.removeDisabledClips': 'sequence.removeDisabledClips',
  'app.preferences': 'app.preferences',
  'app.ocrLanguages': 'app.ocrLanguages',
  'help.about': 'help.about',
};

/** Dispatch a menu command string. Returns true when a command ran. */
export function dispatchMenuCommand(command: string): boolean {
  const id = menuCommandMap[command] ?? command;
  if (!getCommand(id)) { console.warn(`[menu] no command for '${command}'`); return false; }
  return runCommand(id);
}

// ---- before quit ----
type BeforeQuitHandler = () => void | Promise<void>;
let beforeQuitHandler: BeforeQuitHandler = () => { void window.recut?.quit?.(true); };
/** Replace the before-quit handler (e.g. to prompt for unsaved changes). The handler must eventually call window.recut.quit(true). */
export function setBeforeQuitHandler(fn: BeforeQuitHandler): void { beforeQuitHandler = fn; }
export function getBeforeQuitHandler(): BeforeQuitHandler { return beforeQuitHandler; }

// ---- open project path (forwarded for the project agent to subscribe) ----
type OpenPathHandler = (path: string) => void;
let openPathHandler: OpenPathHandler | null = null;
let pendingOpenPath: string | null = null;
/** Register the handler for OS "open file" / recovery requests. A path received before registration is replayed. */
export function setOpenProjectPathHandler(fn: OpenPathHandler): void {
  openPathHandler = fn;
  if (pendingOpenPath) { const p = pendingOpenPath; pendingOpenPath = null; fn(p); }
}

let disposers: (() => void)[] = [];
let booted = false;

/** Initialize shell wiring. Idempotent; returns a dispose function. */
export function bootstrap(): () => void {
  if (booted) return dispose;
  booted = true;
  registerShellCommands();
  void loadOverrides();

  const api = window.recut;
  if (api) {
    try {
      if (api.onMenu) disposers.push(api.onMenu((cmd) => { dispatchMenuCommand(cmd); }));
      if (api.onJobs) disposers.push(api.onJobs((jobs) => useJobsStore.getState().setJobs(jobs)));
      if (api.onBeforeQuit) disposers.push(api.onBeforeQuit(() => { void Promise.resolve(beforeQuitHandler()).catch((e) => { console.error(e); void api.quit?.(true); }); }));
      if (api.onOpenProjectPath) disposers.push(api.onOpenProjectPath((p) => { if (openPathHandler) openPathHandler(p); else pendingOpenPath = p; }));
      api.listJobs?.().then((jobs) => useJobsStore.getState().setJobs(jobs)).catch(() => { /* ignore */ });
    } catch (err) {
      console.error('[bootstrap] failed to wire window.recut', err);
      toast('error', 'Failed to connect to the main process bridge');
    }
  } else {
    console.info('[bootstrap] window.recut not available — running without the Electron bridge');
  }
  return dispose;
}

function dispose() {
  disposers.forEach((d) => { try { d(); } catch { /* ignore */ } });
  disposers = [];
  booted = false;
}

export { COMMAND_IDS };
