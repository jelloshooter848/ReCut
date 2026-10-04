/**
 * Jobs panel: "Jobs" and "Proxies" tabs. It also hosts the Export dialog as a body portal, because the
 * Jobs panel is part of every workspace and stays mounted (hidden) when its tab is inactive.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, FileVideo } from 'lucide-react';
import type { JobInfo } from '@shared/model';
import type { PanelProps } from '@/panels/registry';
import { Tabs } from '@/components/ui';
import { ExportDialog } from '@/panels/export/ExportDialog';
import { injectStyle } from '@/panels/export/injectStyle';
import { JobsTab } from './JobsTab';
import { ProxiesTab } from './ProxiesTab';
import { useJobsSelect } from './useJobsSelect';

const CSS = `
.jp-list { padding: 2px 0; }
.jp-job { display: flex; flex-direction: column; gap: 3px; padding: 4px 8px; border-bottom: 1px solid var(--border); min-width: 0; }
.jp-job:hover { background: var(--bg-2); }
.jp-job-main { display: flex; align-items: center; gap: 6px; min-width: 0; height: 20px; }
.jp-job-icon { width: 13px; height: 13px; flex-shrink: 0; color: var(--text-dim); }
.jp-job-title { flex: 1 1 auto; min-width: 0; color: var(--text); }
.jp-job.failed .jp-job-title { color: var(--text); } .jp-job.canceled .jp-job-title { color: var(--text-dim); }
.jp-job-time { flex-shrink: 0; }
.jp-job-actions { display: inline-flex; gap: 1px; flex-shrink: 0; }
.jp-job-sub { display: flex; align-items: center; gap: 8px; min-width: 0; padding-left: 19px; }
.jp-job-errtoggle { display: flex; align-items: center; gap: 3px; background: none; border: none; padding: 0; color: var(--danger); font-size: var(--font-size-xs); text-align: left; min-width: 0; width: 100%; }
.jp-job-errtoggle > svg { width: 11px; height: 11px; flex-shrink: 0; }
.jp-job-err { margin: 2px 0 0; padding: 6px; background: var(--bg-0); border: 1px solid var(--border); border-radius: var(--radius); font-family: var(--font-mono); font-size: var(--font-size-xs); white-space: pre-wrap; word-break: break-all; max-height: 160px; overflow: auto; color: var(--text); }
.jp-table { display: flex; flex-direction: column; min-width: 0; }
.jp-trow { display: flex; flex-direction: column; gap: 2px; padding: 4px 8px; border-bottom: 1px solid var(--border); min-width: 0; }
.jp-trow:hover { background: var(--bg-2); }
.jp-trow.selected { background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent); }
.jp-trow-main { display: flex; align-items: center; gap: 6px; min-width: 0; height: 20px; }
.jp-trow-sub { display: flex; align-items: center; gap: 6px; min-width: 0; padding-left: 19px; height: 14px; }
.jp-trow-sub .progress { max-width: 160px; }
.jp-actions { display: inline-flex; align-items: center; gap: 2px; justify-content: flex-end; }
`;

type TabId = 'jobs' | 'proxies';
const activeCount = (jobs: JobInfo[]) => jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;

/** Only one Jobs panel instance hosts the dialog, even if the panel were ever mounted twice. */
let dialogHost: symbol | null = null;

export function JobsPanel(_props: PanelProps) {
  injectStyle('recut-jobs-panel-css', CSS);
  const [tab, setTab] = useState<TabId>(() => {
    try { return (localStorage.getItem('recut.jobsPanel.tab') as TabId) === 'proxies' ? 'proxies' : 'jobs'; } catch { return 'jobs'; }
  });
  const change = useCallback((t: TabId) => { setTab(t); try { localStorage.setItem('recut.jobsPanel.tab', t); } catch { /* ignore */ } }, []);
  const active = useJobsSelect(activeCount);
  const [me] = useState(() => Symbol('jobs-panel'));
  const [hostsDialog, setHostsDialog] = useState(false);
  useEffect(() => {
    if (!dialogHost) { dialogHost = me; setHostsDialog(true); }
    return () => { if (dialogHost === me) { dialogHost = null; } };
  }, [me]);

  return (
    <div className="panel" data-testid="jobs-panel">
      <Tabs<TabId>
        tabs={[{ id: 'jobs', label: 'Jobs', icon: Activity, count: active || undefined }, { id: 'proxies', label: 'Proxies', icon: FileVideo }]}
        active={tab} onChange={change}
      />
      <div className="panel-body col">
        {tab === 'jobs' ? <JobsTab /> : <ProxiesTab />}
      </div>
      {hostsDialog ? createPortal(<ExportDialog />, document.body) : null}
    </div>
  );
}
