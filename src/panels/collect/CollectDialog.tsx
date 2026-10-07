/**
 * Collect Project dialog (File › Collect Project…, roadmap §16): choose a destination folder and what to include,
 * see what will be copied (size, free space, offline media that will be skipped), then run the collect as a job
 * and follow its progress here (or in the Jobs panel after closing the dialog).
 *
 * The open project is never changed: the main process receives a serialized copy, plans the copy
 * (shared/collect.ts) and writes the collected project (electron/project/collect.ts).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FolderInput, FolderOpen } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Toggle } from '@/components/ui/Toggle';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { toast } from '@/components/ui/toastStore';
import { useStore } from '@/state/store';
import { recutApi, serializeProjectSliced } from '@/state/mediaActions';
import { useJob, isJobActive } from '@/app/jobsStore';
import { requestOpenProject } from '@/app/project';
import { formatCollectBytes, type CollectOptions, type CollectResult, type CollectSummary } from '@shared/collect';
import { closeCollectDialog, useCollectUi } from './collectUi';
import './collect.css';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function Summary({ s }: { s: Extract<CollectSummary, { ok: true }> }) {
  const parts = [
    s.byKind.media.files ? `${plural(s.byKind.media.files, 'media file')} (${formatCollectBytes(s.byKind.media.bytes)})` : null,
    s.byKind.subtitle.files ? `${plural(s.byKind.subtitle.files, 'subtitle file')} (${formatCollectBytes(s.byKind.subtitle.bytes)})` : null,
    s.byKind.proxy.files ? `${plural(s.byKind.proxy.files, 'proxy', )} (${formatCollectBytes(s.byKind.proxy.bytes)})` : null,
  ].filter(Boolean);
  return (
    <div className="collect-summary col gap-4" data-testid="collect-summary">
      <div className="row gap-6"><span className="text-dim collect-k">Creates</span><span className="mono collect-path" title={s.folder} data-testid="collect-folder">{s.folder}</span></div>
      <div className="row gap-6"><span className="text-dim collect-k">Copies</span><span data-testid="collect-total">{formatCollectBytes(s.totalBytes)}</span>
        <span className="text-dim">{parts.length ? `· ${parts.join(', ')}` : '· no media files'}</span></div>
      <div className="row gap-6"><span className="text-dim collect-k">Free space</span>
        <span data-testid="collect-free">{s.freeBytes === null ? 'unknown' : formatCollectBytes(s.freeBytes)}</span></div>
      {s.unusedMedia ? (
        <div className="text-dim text-sm">{plural(s.unusedMedia, 'media item')} not used in any sequence {s.unusedMedia === 1 ? 'is' : 'are'} not copied and keep{s.unusedMedia === 1 ? 's' : ''} {s.unusedMedia === 1 ? 'its' : 'their'} original path{s.unusedMedia === 1 ? '' : 's'}.</div>
      ) : null}
      {s.missing.length ? (
        <div className="collect-warn" data-testid="collect-missing">
          <div className="row gap-6"><AlertTriangle size={13} /> {plural(s.missing.length, 'file')} cannot be found and will be skipped (they stay offline in the collected project):</div>
          <ul>{s.missing.map((m) => <li key={m.path} title={m.path}><span className="text-bright">{m.names.join(', ') || m.path}</span> <span className="mono text-faint">{m.path}</span></li>)}</ul>
        </div>
      ) : null}
      {s.problems.map((p) => <div key={p} className="collect-problem" data-testid="collect-problem">{p}</div>)}
    </div>
  );
}

export function CollectDialog() {
  const { open, destination, options, jobId } = useCollectUi();
  const project = useStore((s) => s.project);
  const job = useJob(jobId ?? undefined);
  const running = !!job && isJobActive(job);
  const [summary, setSummary] = useState<CollectSummary | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const seq = useRef(0);
  /** The project text sent to main; recomputed when the project changes. */
  const json = useMemo(() => (open ? serializeProjectSliced(project, true) : null), [open, project]);

  useEffect(() => {
    if (!open || !destination || !json) { setSummary(null); return; }
    const api = recutApi();
    if (!api?.collectPreflight) return;
    const mine = ++seq.current;
    setChecking(true);
    void json.then((projectJson) => api.collectPreflight({ projectJson, destination, options }))
      .then((s) => { if (mine === seq.current) setSummary(s); })
      .catch((e) => { if (mine === seq.current) setSummary({ ok: false, error: errText(e) }); })
      .finally(() => { if (mine === seq.current) setChecking(false); });
  }, [open, destination, options, json, job?.status]);

  if (!open) return null;
  const api = recutApi();
  const setOptions = (patch: Partial<CollectOptions>) => useCollectUi.setState({ options: { ...options, ...patch } });

  const choose = async () => {
    if (!api) return;
    const folder = await api.openFolder({ title: 'Collect Project into folder', defaultPath: destination || undefined });
    if (folder) useCollectUi.setState({ destination: folder, jobId: null });
  };

  const start = async () => {
    if (!api || !json || !destination) return;
    setStarting(true);
    try {
      const res = await api.startCollect({ projectJson: await json, destination, options });
      if (!res.ok) { toast('error', res.error); return; }
      useCollectUi.setState({ jobId: res.jobId });
    } catch (e) {
      toast('error', `Collect failed to start: ${errText(e)}`);
    } finally {
      setStarting(false);
    }
  };

  const ready = summary?.ok === true && summary.problems.length === 0 && !checking;
  const result = job?.status === 'done' ? (job.result as CollectResult | undefined) : undefined;

  return (
    <Dialog open title={<span className="row gap-6"><FolderInput size={14} /> Collect Project</span>} onClose={closeCollectDialog} width={600}
      className="collect-dialog" submitDisabled={!ready || running || starting}
      footer={<>
        <span className="text-dim text-sm grow">{checking ? 'Checking…' : ''}</span>
        {running ? <Button variant="danger" onClick={() => { if (job) void api?.cancelJob(job.id); }} data-testid="collect-cancel">Cancel collect</Button> : null}
        <Button onClick={closeCollectDialog}>{running ? 'Hide' : 'Close'}</Button>
        {!running ? <Button variant="primary" disabled={!ready || starting} onClick={() => { void start(); }} data-testid="collect-start">Collect</Button> : null}
      </>}>
      <div className="col gap-8" data-testid="collect-dialog">
        <p className="text-dim collect-note">
          Copies the project file and its media into one new folder, with the paths in the copy pointing at the copied
          files. This project and its media are not changed.
        </p>
        <div className="row gap-6">
          <span className="collect-k">Destination</span>
          <input className="input grow mono" readOnly value={destination} placeholder="Choose a folder…" data-testid="collect-destination" />
          <Button icon={FolderOpen} onClick={() => { void choose(); }} disabled={running} data-testid="collect-choose">Choose…</Button>
        </div>
        <fieldset className="collect-options col gap-4" disabled={running}>
          <label className="row gap-6"><input type="radio" name="collect-scope" checked={options.scope === 'sequences'} onChange={() => setOptions({ scope: 'sequences' })} data-testid="collect-scope-sequences" /> Media used in sequences only</label>
          <label className="row gap-6"><input type="radio" name="collect-scope" checked={options.scope === 'all'} onChange={() => setOptions({ scope: 'all' })} data-testid="collect-scope-all" /> All project media</label>
          <Toggle checked={options.includeSubtitles} onChange={(v) => setOptions({ includeSubtitles: v })} label="Include subtitle files" className="collect-toggle" disabled={running} />
          <Toggle checked={options.includeProxies} onChange={(v) => setOptions({ includeProxies: v })} label="Include proxies (the copy opens without rebuilding them)" className="collect-toggle" disabled={running} />
        </fieldset>
        {!destination ? <div className="text-dim">Choose a destination folder. A folder named after the project is created inside it; it must not exist yet, or be empty.</div> : null}
        {summary && !summary.ok ? <div className="collect-problem">{summary.error}</div> : null}
        {summary?.ok && !result ? <Summary s={summary} /> : null}
        {job && running ? (
          <div className="col gap-4" data-testid="collect-progress">
            <ProgressBar value={job.status === 'queued' ? undefined : job.progress} />
            <span className="text-dim text-sm mono">{job.status === 'queued' ? 'Waiting for another job to finish…' : job.message ?? ''}</span>
          </div>
        ) : null}
        {job?.status === 'failed' ? <div className="collect-problem" data-testid="collect-failed">{job.error}</div> : null}
        {job?.status === 'canceled' ? <div className="collect-warn" data-testid="collect-canceled">Collect canceled. The destination folder is marked incomplete (COLLECT-INCOMPLETE.txt); delete it before collecting there again.</div> : null}
        {result ? (
          <div className="collect-done col gap-4" data-testid="collect-done">
            <div className="row gap-6"><CheckCircle2 size={13} className="text-ok" /> Collected {plural(result.files, 'file')} ({formatCollectBytes(result.bytes)}) to <span className="mono">{result.folder}</span></div>
            {result.missing.length ? <div className="text-dim">{plural(result.missing.length, 'missing file')} skipped.</div> : null}
            <div className="row gap-6">
              <Button size="sm" onClick={() => { void api?.showItemInFolder(result.projectFile); }}>Show in folder</Button>
              <Button size="sm" onClick={() => { closeCollectDialog(); void requestOpenProject(result.projectFile); }} data-testid="collect-open">Open collected project</Button>
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
