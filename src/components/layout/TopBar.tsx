import React from 'react';
import { Scissors, ChevronDown } from 'lucide-react';
import { MenuButton } from '@/components/ui/Menu';
import { useLayoutStore, WORKSPACES, resetAllLayouts, type WorkspaceId } from './layoutStore';
import { getShortcutLabel } from '@/keyboard/shortcuts';
import { COMMAND_IDS } from '@/keyboard/commandIds';

export interface TopBarProps {
  /** Project name / dirty indicator / sequence name. */
  projectSlot?: React.ReactNode;
  /** Global buttons on the right (jobs, shortcuts, fullscreen…). */
  rightSlot?: React.ReactNode;
  appName?: string;
}

const WS_COMMAND: Record<WorkspaceId, string> = {
  Editing: COMMAND_IDS.workspaceEditing,
  Research: COMMAND_IDS.workspaceResearch,
  Audio: COMMAND_IDS.workspaceAudio,
  Compare: COMMAND_IDS.workspaceCompare,
};

export function TopBar({ projectSlot, rightSlot, appName = 'ReCut' }: TopBarProps) {
  const workspace = useLayoutStore((s) => s.workspace);
  const setWorkspace = useLayoutStore((s) => s.setWorkspace);
  const resetLayout = useLayoutStore((s) => s.resetLayout);
  return (
    <div className="topbar" role="banner">
      <div className="topbar-brand"><span className="logo"><Scissors /></span>{appName}</div>
      <div className="topbar-workspaces" role="tablist" aria-label="Workspaces">
        {WORKSPACES.map((ws) => (
          <button key={ws} type="button" role="tab" aria-selected={ws === workspace}
            className={['ws-tab', ws === workspace ? 'active' : ''].join(' ')}
            title={`${ws} workspace${getShortcutLabel(WS_COMMAND[ws]) ? ` (${getShortcutLabel(WS_COMMAND[ws])})` : ''}`}
            onClick={() => setWorkspace(ws)}>
            {ws}
          </button>
        ))}
        <MenuButton variant="ghost" size="sm" noChevron icon={ChevronDown} aria-label="Workspace options" title="Workspace options"
          className="btn-icon" style={{ width: 22, padding: 0 }}
          items={() => [
            { heading: `Workspace: ${workspace}` },
            { label: 'Reset to Saved Layout', shortcut: getShortcutLabel(COMMAND_IDS.resetWorkspace), onSelect: () => resetLayout() },
            { label: 'Reset All Workspaces', onSelect: () => resetAllLayouts() },
            { separator: true },
            ...WORKSPACES.map((ws) => ({ label: ws, checked: ws === workspace, shortcut: getShortcutLabel(WS_COMMAND[ws]), onSelect: () => setWorkspace(ws) })),
          ]} />
      </div>
      <div className="topbar-center">{projectSlot}</div>
      <div className="topbar-right">{rightSlot}</div>
    </div>
  );
}
