/**
 * Jobs tab: every main-process job with status, progress, timing, errors and per-job actions.
 */
import React, { memo, useCallback, useEffect, useState } from 'react';
import {
  Activity, AudioWaveform, Ban, ChevronDown, ChevronRight, Clapperboard, Download, Film, FileVideo, FolderInput, FolderOpen, Images, Loader2, Mic, ScanText, Search,
  Trash2, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { JobInfo, JobKind, JobStatus } from '@shared/model';
import { recutApi } from '@/state';
import { useJobsStore } from '@/app/jobsStore';
import { Button, EmptyState, ProgressBar } from '@/components/ui';
import { estimateEtaSeconds, formatDuration } from '@/panels/export/settings';
import { arrayEq, jobEq, useJobsSelect } from './useJobsSelect';

const KIND_ICON: Record<JobKind, LucideIcon> = {
  probe: Search, proxy: FileVideo, waveform: AudioWaveform, sceneDetect: Clapperboard, export: Film, thumbnails: Images, transcribe: Mic,
  ocr: ScanText, download: Download, collect: FolderInput,
};
const KIND_LABEL: Record<JobKind, string> = {
  probe: 'Probe', proxy: 'Proxy', waveform: 'Waveform', sceneDetect: 'Scene detection', export: 'Export', thumbnails: 'Thumbnails', transcribe: 'Transcribe',
  ocr: 'OCR', download: 'Download', collect: 'Collect',
};
const STATUS_BADGE: Record<JobStatus, { label: string; cls: string }> = {
  queued: { label: 'Queued', cls: 'dim' },
  running: { label: 'Running', cls: '' },
  done: { label: 'Done', cls: 'ok' },
  failed: { label: 'Failed', cls: 'danger' },
  canceled: { label: 'Canceled', cls: 'dim' },
};

const isActive = (j: JobInfo) => j.status === 'queued' || j.status === 'running';

/** Re-renders once per second while `on`, for elapsed/ETA readouts. */
function useClock(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [on]);
  return now;
}

interface Summary { total: number; running: number; queued: number; failed: number; finished: number }
const selectSummary = (jobs: JobInfo[]): Summary => {
  const s: Summary = { total: jobs.length, running: 0, queued: 0, failed: 0, finished: 0 };
  for (const j of jobs) {
    if (j.status === 'running') s.running++;
    else if (j.status === 'queued') s.queued++;
    else { s.finished++; if (j.status === 'failed') s.failed++; }
  }
  return s;
};
const summaryEq = (a: Summary, b: Summary) => a.total === b.total && a.running === b.running && a.queued === b.queued && a.failed === b.failed && a.finished === b.finished;
const selectIds = (jobs: JobInfo[]) => jobs.map((j) => j.id).reverse();

export function JobsTab() {
  const summary = useJobsSelect(selectSummary, summaryEq);
  const ids = useJobsSelect(selectIds, arrayEq);
  const api = recutApi();
  const now = useClock(summary.running + summary.queued > 0);

  const parts: string[] = [];
  if (summary.running) parts.push(`${summary.running} running`);
  if (summary.queued) parts.push(`${summary.queued} queued`);
  if (summary.failed) parts.push(`${summary.failed} failed`);
  const headline = parts.length ? parts.join(' · ') : summary.total ? `${summary.finished} finished` : 'No jobs';

  return (
    <div className="col grow" data-testid="jobs-tab">
      <div className="toolbar">
        {summary.running ? <Loader2 size={12} className="spin text-accent" /> : <Activity size={12} className="text-dim" />}
        <span className="text-dim text-sm ellipsis" data-testid="jobs-summary">{headline}</span>
        <div className="ml-auto row gap-2">
          <Button size="sm" icon={Ban} disabled={!(summary.running + summary.queued)} title="Cancel every queued and running job"
            onClick={() => { for (const j of selectActive()) api?.cancelJob(j.id); }}>Cancel all</Button>
          <Button size="sm" icon={Trash2} disabled={!summary.finished} title="Remove finished, failed and canceled jobs from the list"
            onClick={() => api?.clearJobs()} data-testid="jobs-clear">Clear finished</Button>
        </div>
      </div>
      <div className="grow scroll-y">
        {ids.length === 0 ? (
          <EmptyState icon={Activity} title="No background jobs" description="Proxies, scene detection, waveforms and exports show up here with live progress." />
        ) : (
          <div className="list jp-list">
            {ids.map((id) => <JobRow key={id} id={id} now={now} />)}
          </div>
        )}
      </div>
    </div>
  );
}

/** Live snapshot of active jobs (for click handlers). */
function selectActive(): JobInfo[] { return useJobsStore.getState().jobs.filter(isActive); }

const JobRow = memo(function JobRow({ id, now }: { id: string; now: number }) {
  const job = useJobsSelect(useCallback((jobs: JobInfo[]) => jobs.find((j) => j.id === id), [id]), jobEq);
  const [showError, setShowError] = useState(false);
  if (!job) return null;
  const api = recutApi();
  const Icon = KIND_ICON[job.kind] ?? Activity;
  const badge = STATUS_BADGE[job.status];
  const active = isActive(job);
  const elapsedMs = job.startedAt ? (job.finishedAt ?? now) - job.startedAt : 0;
  const eta = job.status === 'running' ? estimateEtaSeconds(job.progress, elapsedMs) : null;
  const outputPath = job.kind === 'export' && job.status === 'done' ? (job.result as { outputPath?: string } | undefined)?.outputPath : undefined;
  const timing = job.status === 'running'
    ? `${formatDuration(elapsedMs / 1000)} elapsed${eta !== null ? ` · ≈ ${formatDuration(eta)} left` : ''}`
    : job.status === 'queued' ? 'waiting' : job.startedAt ? `${formatDuration(elapsedMs / 1000)}` : '';

  return (
    <div className={`jp-job ${job.status}`} data-testid="job-row" data-kind={job.kind} data-status={job.status} title={`${KIND_LABEL[job.kind] ?? job.kind}: ${job.title}`}>
      <div className="jp-job-main">
        <Icon className={`jp-job-icon ${job.status === 'running' ? 'text-accent' : ''}`} />
        <span className="jp-job-title ellipsis">{job.title}</span>
        <span className={`badge ${badge.cls}`}>{job.status === 'running' ? `${Math.round(job.progress * 100)}%` : badge.label}</span>
        <span className="jp-job-time text-faint text-xs mono nowrap">{timing}</span>
        <span className="jp-job-actions">
          {outputPath ? <button type="button" className="btn-icon btn-sm" title="Reveal in folder" aria-label="Reveal in folder" onClick={() => api?.showItemInFolder(outputPath)}><FolderOpen /></button> : null}
          {active ? <button type="button" className="btn-icon btn-sm" title="Cancel" aria-label="Cancel job" onClick={() => api?.cancelJob(job.id)} data-testid="job-cancel"><X /></button> : null}
        </span>
      </div>
      {active ? (
        <div className="jp-job-sub">
          <ProgressBar value={job.status === 'running' && job.progress > 0 ? job.progress : undefined} />
          {job.message ? <span className="text-dim text-xs ellipsis" style={{ maxWidth: '50%' }}>{job.message}</span> : null}
        </div>
      ) : null}
      {job.error ? (
        <div className="jp-job-sub col" style={{ alignItems: 'stretch' }}>
          <button type="button" className="jp-job-errtoggle" onClick={() => setShowError((v) => !v)}>
            {showError ? <ChevronDown /> : <ChevronRight />}<span className="ellipsis">{job.error.split('\n')[0]}</span>
          </button>
          {showError ? <pre className="jp-job-err selectable">{job.error}</pre> : null}
        </div>
      ) : null}
    </div>
  );
});
