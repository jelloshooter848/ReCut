import React, { useEffect } from 'react';
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
import { toast, type ToastKind as ShellToastKind } from '@/components/ui/toastStore';
import { useStore } from '@/state/store';
import type { ToastKind as StoreToastKind } from '@/state/types';
import { registerEditingCommands } from '@/app/commands';
import { initProjectLifecycle } from '@/app/project';
import { initJobsRouter } from '@/app/jobsRouter';
import { initChannelProxies } from '@/app/channelProxies';
import { DialogHost } from '@/app/dialogs/ConfirmDialog';
import { NewSequenceDialog } from '@/app/dialogs/NewSequenceDialog';
import { PreferencesDialog } from '@/app/dialogs/PreferencesDialog';
import { SpeedDialog } from '@/app/dialogs/SpeedDialog';
import { RelinkDialog } from '@/panels/project/RelinkDialog';
import { FfmpegBanner } from '@/app/FfmpegBanner';
import { ExportDialog } from '@/panels/export/ExportDialog';
import { OcrLanguagesDialog } from '@/panels/ocr/OcrLanguagesDialog';
import { OcrDialog } from '@/panels/ocr/OcrDialog';
import { recutApi, setFfmpegAvailability } from '@/state';
import '@/panels';

const TOAST_KIND: Record<StoreToastKind, ShellToastKind> = { info: 'info', success: 'ok', warning: 'warn', error: 'error' };
const STORE_TOAST_MS = 5000;
let appInitialized = false;
const bridgedToasts = new Set<string>();

/** Mirror store.ui.toasts into the shell toast host and dismiss them from the store after 5s. */
function bridgeStoreToasts(): () => void {
  const handle = (toasts: { id: string; kind: StoreToastKind; text: string }[]) => {
    for (const t of toasts) {
      if (bridgedToasts.has(t.id)) continue;
      bridgedToasts.add(t.id);
      toast(TOAST_KIND[t.kind] ?? 'info', t.text, STORE_TOAST_MS);
      window.setTimeout(() => { useStore.getState().dismissToast(t.id); bridgedToasts.delete(t.id); }, STORE_TOAST_MS);
    }
  };
  handle(useStore.getState().ui.toasts);
  return useStore.subscribe((s, prev) => { if (s.ui.toasts !== prev.ui.toasts) handle(s.ui.toasts); });
}

/** One-time wiring of editing commands, project lifecycle and job routing (idempotent across StrictMode remounts). */
function initApp(): void {
  if (appInitialized) return;
  appInitialized = true;
  registerEditingCommands();
  initProjectLifecycle();
  initJobsRouter();
  initChannelProxies();
  bridgeStoreToasts();
  recutApi()?.appInfo().then(setFfmpegAvailability).catch(() => undefined);
}

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
  useEffect(() => { initApp(); }, []);
  return (
    <>
      <Layout projectSlot={<ProjectTitle />} rightSlot={<GlobalButtons />} toolbar={<FfmpegBanner />} />
      <ContextMenuHost />
      <ToastHost />
      <ShortcutsDialog />
      <NewSequenceDialog />
      <PreferencesDialog />
      <SpeedDialog />
      <RelinkDialog />
      {/* Mounted at the root: the Jobs panel (its old host) unmounts while hidden, which made Export do nothing. */}
      <ExportDialog />
      <OcrDialog />
      <OcrLanguagesDialog />
      <DialogHost />
    </>
  );
}

export default App;
