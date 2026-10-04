import React from 'react';
import { Keyboard, Loader2, Maximize } from 'lucide-react';
import { Layout } from '@/components/layout';
import { ContextMenuHost } from '@/components/ui/ContextMenu';
import { ToastHost } from '@/components/ui/Toast';
import { IconButton } from '@/components/ui/IconButton';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { ShortcutsDialog } from '@/keyboard/ShortcutsDialog';
import { useShortcuts } from '@/keyboard/useShortcuts';
import { runCommand, getShortcutLabel } from '@/keyboard/shortcuts';
import { COMMAND_IDS } from '@/keyboard/commandIds';
import { useActiveJobs } from '@/app/jobsStore';
import { useShellStore } from '@/app/shellStore';
import { useLayoutStore } from '@/components/layout/layoutStore';
import '@/panels';

function ProjectTitle() {
  const name = useShellStore((s) => s.projectName);
  const seq = useShellStore((s) => s.sequenceName);
  const dirty = useShellStore((s) => s.dirty);
  return (
    <>
      <span className="project-name" title={name}>{name}</span>
      {dirty ? <span className="project-dirty" title="Unsaved changes">●</span> : null}
      {seq ? <><span className="text-faint">/</span><span className="text-dim ellipsis">{seq}</span></> : null}
    </>
  );
}

function JobsIndicator() {
  const active = useActiveJobs();
  const focusPanel = useLayoutStore((s) => s.focusPanel);
  if (!active.length) return null;
  const progress = active.reduce((a, j) => a + (j.progress || 0), 0) / active.length;
  const running = active.find((j) => j.status === 'running') ?? active[0];
  return (
    <button type="button" className="jobs-indicator btn btn-ghost" title={`${active.length} job(s) running — ${running.title}`} onClick={() => focusPanel('jobs')}>
      <Loader2 size={12} className="spin" />
      <span className="ellipsis" style={{ maxWidth: 160 }}>{running.title}</span>
      <ProgressBar value={progress} />
      {active.length > 1 ? <span className="badge dim">{active.length}</span> : null}
    </button>
  );
}

function GlobalButtons() {
  return (
    <>
      <JobsIndicator />
      <IconButton icon={Keyboard} label="Keyboard shortcuts" shortcut={getShortcutLabel(COMMAND_IDS.openShortcuts)} onClick={() => runCommand(COMMAND_IDS.openShortcuts)} />
      <IconButton icon={Maximize} label="Toggle full screen" shortcut={getShortcutLabel(COMMAND_IDS.toggleFullscreen)} onClick={() => runCommand(COMMAND_IDS.toggleFullscreen)} />
    </>
  );
}

export function App() {
  useShortcuts();
  return (
    <>
      <Layout projectSlot={<ProjectTitle />} rightSlot={<GlobalButtons />} />
      <ContextMenuHost />
      <ToastHost />
      <ShortcutsDialog />
    </>
  );
}

export default App;
