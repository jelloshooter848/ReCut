/**
 * Shell-level command registrations + stub reservations for editing commands.
 * Other modules register the real editing implementations with `registerCommand({ id: COMMAND_IDS.x, ... })`;
 * re-registering an id replaces the stub.
 */
import { COMMAND_IDS } from './commandIds';
import { registerCommand, type CommandInput } from './shortcuts';
import { useLayoutStore, type WorkspaceId } from '@/components/layout/layoutStore';
import { openShortcutsDialog } from './shortcutsDialogStore';
import { toast } from '@/components/ui/toastStore';

export { COMMAND_IDS };
export type { CommandId } from './commandIds';

/** Panel ids focused by Shift+1..9. */
export const PANEL_FOCUS_ORDER: string[] = ['project', 'source', 'program', 'timeline', 'inspector', 'transcript', 'scenes', 'subtitles', 'markers'];

const CAT = {
  playback: 'Playback',
  marks: 'Marks & Markers',
  edit: 'Editing',
  tools: 'Tools',
  file: 'File',
  view: 'View & Panels',
  workspace: 'Workspaces',
  help: 'Help',
} as const;

/** Titles/categories for every command id, used for stubs and for the shortcuts dialog. */
export const COMMAND_META: Record<string, { title: string; category: string }> = {
  [COMMAND_IDS.playPause]: { title: 'Play / Pause', category: CAT.playback },
  [COMMAND_IDS.shuttleBack]: { title: 'Shuttle Backward (J)', category: CAT.playback },
  [COMMAND_IDS.shuttleStop]: { title: 'Shuttle Stop (K)', category: CAT.playback },
  [COMMAND_IDS.shuttleForward]: { title: 'Shuttle Forward (L)', category: CAT.playback },
  [COMMAND_IDS.stepBack]: { title: 'Step Back 1 Frame', category: CAT.playback },
  [COMMAND_IDS.stepForward]: { title: 'Step Forward 1 Frame', category: CAT.playback },
  [COMMAND_IDS.stepBack5]: { title: 'Step Back 5 Frames', category: CAT.playback },
  [COMMAND_IDS.stepForward5]: { title: 'Step Forward 5 Frames', category: CAT.playback },
  [COMMAND_IDS.prevEdit]: { title: 'Go to Previous Edit Point', category: CAT.playback },
  [COMMAND_IDS.nextEdit]: { title: 'Go to Next Edit Point', category: CAT.playback },
  [COMMAND_IDS.goToStart]: { title: 'Go to Sequence Start', category: CAT.playback },
  [COMMAND_IDS.goToEnd]: { title: 'Go to Sequence End', category: CAT.playback },
  [COMMAND_IDS.goToIn]: { title: 'Go to In Point', category: CAT.playback },
  [COMMAND_IDS.goToOut]: { title: 'Go to Out Point', category: CAT.playback },
  [COMMAND_IDS.nudgeLeft]: { title: 'Nudge Selection Left', category: CAT.edit },
  [COMMAND_IDS.nudgeRight]: { title: 'Nudge Selection Right', category: CAT.edit },
  [COMMAND_IDS.markIn]: { title: 'Mark In', category: CAT.marks },
  [COMMAND_IDS.markOut]: { title: 'Mark Out', category: CAT.marks },
  [COMMAND_IDS.clearInOut]: { title: 'Clear In and Out', category: CAT.marks },
  [COMMAND_IDS.addMarker]: { title: 'Add Marker', category: CAT.marks },
  [COMMAND_IDS.matchFrame]: { title: 'Match Frame', category: CAT.marks },
  [COMMAND_IDS.deleteSelection]: { title: 'Delete', category: CAT.edit },
  [COMMAND_IDS.rippleDelete]: { title: 'Ripple Delete', category: CAT.edit },
  [COMMAND_IDS.addEdit]: { title: 'Add Edit (Cut at Playhead)', category: CAT.edit },
  [COMMAND_IDS.insert]: { title: 'Insert', category: CAT.edit },
  [COMMAND_IDS.overwrite]: { title: 'Overwrite', category: CAT.edit },
  [COMMAND_IDS.lift]: { title: 'Lift', category: CAT.edit },
  [COMMAND_IDS.extract]: { title: 'Extract', category: CAT.edit },
  [COMMAND_IDS.rippleTrimPrev]: { title: 'Ripple Trim Previous Edit to Playhead', category: CAT.edit },
  [COMMAND_IDS.rippleTrimNext]: { title: 'Ripple Trim Next Edit to Playhead', category: CAT.edit },
  [COMMAND_IDS.defaultVideoTransition]: { title: 'Apply Default Video Transition', category: CAT.edit },
  [COMMAND_IDS.defaultAudioTransition]: { title: 'Apply Default Audio Transition', category: CAT.edit },
  [COMMAND_IDS.toggleClipEnabled]: { title: 'Enable / Disable Clip', category: CAT.edit },
  [COMMAND_IDS.linkUnlink]: { title: 'Link / Unlink', category: CAT.edit },
  [COMMAND_IDS.undo]: { title: 'Undo', category: CAT.edit },
  [COMMAND_IDS.redo]: { title: 'Redo', category: CAT.edit },
  [COMMAND_IDS.cut]: { title: 'Cut', category: CAT.edit },
  [COMMAND_IDS.copy]: { title: 'Copy', category: CAT.edit },
  [COMMAND_IDS.paste]: { title: 'Paste', category: CAT.edit },
  [COMMAND_IDS.selectAll]: { title: 'Select All', category: CAT.edit },
  [COMMAND_IDS.deselectAll]: { title: 'Deselect All', category: CAT.edit },
  [COMMAND_IDS.toolSelect]: { title: 'Selection Tool', category: CAT.tools },
  [COMMAND_IDS.toolRazor]: { title: 'Razor Tool', category: CAT.tools },
  [COMMAND_IDS.toolRipple]: { title: 'Ripple Edit Tool', category: CAT.tools },
  [COMMAND_IDS.toolRolling]: { title: 'Rolling Edit Tool', category: CAT.tools },
  [COMMAND_IDS.toolSlip]: { title: 'Slip Tool', category: CAT.tools },
  [COMMAND_IDS.toolSlide]: { title: 'Slide Tool', category: CAT.tools },
  [COMMAND_IDS.toolTrack]: { title: 'Track Select Tool', category: CAT.tools },
  [COMMAND_IDS.newProject]: { title: 'New Project', category: CAT.file },
  [COMMAND_IDS.openProject]: { title: 'Open Project…', category: CAT.file },
  [COMMAND_IDS.save]: { title: 'Save Project', category: CAT.file },
  [COMMAND_IDS.saveAs]: { title: 'Save Project As…', category: CAT.file },
  [COMMAND_IDS.importMedia]: { title: 'Import Media…', category: CAT.file },
  [COMMAND_IDS.export]: { title: 'Export…', category: CAT.file },
  [COMMAND_IDS.newSequence]: { title: 'New Sequence…', category: CAT.file },
  [COMMAND_IDS.zoomIn]: { title: 'Zoom In (Timeline)', category: CAT.view },
  [COMMAND_IDS.zoomOut]: { title: 'Zoom Out (Timeline)', category: CAT.view },
  [COMMAND_IDS.zoomToFit]: { title: 'Zoom to Fit Sequence', category: CAT.view },
  [COMMAND_IDS.maximizePanel]: { title: 'Maximize / Restore Focused Panel', category: CAT.view },
  [COMMAND_IDS.fullscreenProgram]: { title: 'Program Monitor Full Screen', category: CAT.view },
  [COMMAND_IDS.toggleFullscreen]: { title: 'Toggle Window Full Screen', category: CAT.view },
  [COMMAND_IDS.focusPanel1]: { title: 'Focus Panel 1 (Project)', category: CAT.view },
  [COMMAND_IDS.focusPanel2]: { title: 'Focus Panel 2 (Source)', category: CAT.view },
  [COMMAND_IDS.focusPanel3]: { title: 'Focus Panel 3 (Program)', category: CAT.view },
  [COMMAND_IDS.focusPanel4]: { title: 'Focus Panel 4 (Timeline)', category: CAT.view },
  [COMMAND_IDS.focusPanel5]: { title: 'Focus Panel 5 (Inspector)', category: CAT.view },
  [COMMAND_IDS.focusPanel6]: { title: 'Focus Panel 6 (Transcript)', category: CAT.view },
  [COMMAND_IDS.focusPanel7]: { title: 'Focus Panel 7 (Scenes)', category: CAT.view },
  [COMMAND_IDS.focusPanel8]: { title: 'Focus Panel 8 (Subtitles)', category: CAT.view },
  [COMMAND_IDS.focusPanel9]: { title: 'Focus Panel 9 (Markers)', category: CAT.view },
  [COMMAND_IDS.workspaceEditing]: { title: 'Workspace: Editing', category: CAT.workspace },
  [COMMAND_IDS.workspaceResearch]: { title: 'Workspace: Research', category: CAT.workspace },
  [COMMAND_IDS.workspaceAudio]: { title: 'Workspace: Audio', category: CAT.workspace },
  [COMMAND_IDS.workspaceCompare]: { title: 'Workspace: Compare', category: CAT.workspace },
  [COMMAND_IDS.resetWorkspace]: { title: 'Reset Current Workspace Layout', category: CAT.workspace },
  [COMMAND_IDS.openShortcuts]: { title: 'Keyboard Shortcuts…', category: CAT.help },
};

const stub = (id: string): CommandInput => ({ id, ...COMMAND_META[id], placeholder: true, run: () => { /* reserved until an implementation registers */ } });

let registered = false;

/** Registers shell commands (idempotent). Called from bootstrap(). */
export function registerShellCommands(): void {
  if (registered) return;
  registered = true;

  const layout = () => useLayoutStore.getState();
  const ws = (id: WorkspaceId) => () => layout().setWorkspace(id);

  const shell: CommandInput[] = [
    { id: COMMAND_IDS.maximizePanel, ...COMMAND_META[COMMAND_IDS.maximizePanel], run: () => layout().toggleMaximize() },
    { id: COMMAND_IDS.workspaceEditing, ...COMMAND_META[COMMAND_IDS.workspaceEditing], run: ws('Editing') },
    { id: COMMAND_IDS.workspaceResearch, ...COMMAND_META[COMMAND_IDS.workspaceResearch], run: ws('Research') },
    { id: COMMAND_IDS.workspaceAudio, ...COMMAND_META[COMMAND_IDS.workspaceAudio], run: ws('Audio') },
    { id: COMMAND_IDS.workspaceCompare, ...COMMAND_META[COMMAND_IDS.workspaceCompare], run: ws('Compare') },
    { id: COMMAND_IDS.resetWorkspace, ...COMMAND_META[COMMAND_IDS.resetWorkspace], run: () => { layout().resetLayout(); toast('info', `Workspace "${layout().workspace}" reset`); } },
    { id: COMMAND_IDS.openShortcuts, ...COMMAND_META[COMMAND_IDS.openShortcuts], run: () => openShortcutsDialog() },
    {
      id: COMMAND_IDS.toggleFullscreen, ...COMMAND_META[COMMAND_IDS.toggleFullscreen],
      run: () => { window.recut?.toggleFullscreen?.().catch(() => { /* ignore */ }); },
    },
    {
      id: COMMAND_IDS.fullscreenProgram, ...COMMAND_META[COMMAND_IDS.fullscreenProgram],
      run: () => {
        const l = layout();
        const zone = l.zoneOf('program');
        if (!zone) return;
        if (l.maximized === zone) l.toggleMaximize(zone);
        else { l.focusPanel('program'); if (!l.maximized) l.toggleMaximize(zone); else { l.toggleMaximize(); l.toggleMaximize(zone); } }
      },
    },
  ];
  const focusIds = [COMMAND_IDS.focusPanel1, COMMAND_IDS.focusPanel2, COMMAND_IDS.focusPanel3, COMMAND_IDS.focusPanel4, COMMAND_IDS.focusPanel5, COMMAND_IDS.focusPanel6, COMMAND_IDS.focusPanel7, COMMAND_IDS.focusPanel8, COMMAND_IDS.focusPanel9];
  focusIds.forEach((id, i) => shell.push({ id, ...COMMAND_META[id], run: () => { const p = PANEL_FOCUS_ORDER[i]; if (p) layout().focusPanel(p); } }));

  const shellIds = new Set(shell.map((c) => c.id));
  for (const id of Object.values(COMMAND_IDS)) if (!shellIds.has(id)) registerCommand(stub(id));
  for (const c of shell) registerCommand(c);
}
