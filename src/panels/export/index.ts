/**
 * Export module. Registers no panel: the dialog is mounted (as a body portal) by the Jobs panel, which is
 * always part of every workspace. Also binds the shell "Export…" command to the dialog.
 */
import { registerCommand } from '@/keyboard/shortcuts';
import { COMMAND_IDS } from '@/keyboard/commandIds';
import { COMMAND_META } from '@/keyboard/commands';
import { useStore } from '@/state';

export { ExportDialog } from './ExportDialog';
export * from './settings';

if (typeof window !== 'undefined') {
  registerCommand({
    id: COMMAND_IDS.export,
    ...(COMMAND_META[COMMAND_IDS.export] ?? { title: 'Export…', category: 'File' }),
    when: () => !!useStore.getState().project.activeSequenceId,
    run: () => useStore.getState().openDialog('export'),
  });
}
