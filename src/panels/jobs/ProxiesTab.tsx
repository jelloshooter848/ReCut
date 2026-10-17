/**
 * Proxies tab: proxy status for every project media item with per-row and bulk actions, playback proxy
 * settings and a scene-detection bulk action.
 */
import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Ban, Clapperboard, FileVideo, FolderOpen, RefreshCw, Trash2, X } from 'lucide-react';
import type { ID, JobInfo, MediaItem } from '@shared/model';
import { useStore, recutApi, startProxy, startSceneDetect } from '@/state';
import { useJobsStore } from '@/app/jobsStore';
import { Button, EmptyState, ProgressBar, Select, Toggle } from '@/components/ui';
import { toast } from '@/components/ui/toastStore';
import { jobEq, useJobsSelect } from './useJobsSelect';
import { isDisplayableImage, isStillImage, mediaNeedsProxyForPreview, previewReason } from '@/playback/mediaSource';
import { PROXY_HEIGHTS } from '@shared/limits';

const PROXY_HEIGHT_OPTIONS = PROXY_HEIGHTS.map((h) => ({ value: String(h), label: `${h}p` }));

const isActiveJob = (j: JobInfo) => j.status === 'queued' || j.status === 'running';

/** Media that can have a proxy: online video/audio with (or awaiting) a probe, or a still Chromium cannot draw (PNG proxy). */
export function proxyEligible(m: MediaItem): boolean {
  if (m.offline) return false;
  if (isStillImage(m)) return !!m.probe && !isDisplayableImage(m);
  if (m.probe) return !!m.probe.video || m.probe.audio.length > 0;
  return m.kind === 'video' || m.kind === 'audio' || m.kind === 'unknown';
}
export function needsProxy(m: MediaItem): boolean { return mediaNeedsProxyForPreview(m) && proxyEligible(m); }
export function missingProxy(m: MediaItem): boolean { return proxyEligible(m) && (m.proxy.status === 'none' || m.proxy.status === 'failed'); }
export function sceneEligible(m: MediaItem): boolean { return !m.offline && !!m.probe?.video && m.kind !== 'image'; }

async function generateFor(ids: ID[]): Promise<void> {
  let n = 0;
  for (const id of ids) {
    const r = await startProxy(id).catch((e: unknown) => { toast('error', `Proxy failed to start: ${e instanceof Error ? e.message : String(e)}`); return null; });
    if (r) n++;
  }
  if (n > 1) toast('info', `Queued ${n} proxy jobs`);
}

async function detectFor(ids: ID[]): Promise<void> {
  let n = 0;
  for (const id of ids) {
    const r = await startSceneDetect(id).catch((e: unknown) => { toast('error', `Scene detection failed to start: ${e instanceof Error ? e.message : String(e)}`); return null; });
    if (r) n++;
  }
  if (n > 0) toast('info', `Detecting scenes in ${n} file${n > 1 ? 's' : ''}`);
}

export function ProxiesTab() {
  const mediaMap = useStore((s) => s.project.media);
  const selectedIds = useStore((s) => s.ui.selectedMediaIds);
  const useProxies = useStore((s) => s.project.settings.useProxies);
  const proxyHeight = useStore((s) => s.project.settings.proxyHeight);
  const setSettings = useStore((s) => s.setSettings);
  const api = recutApi();
  const [cacheDir, setCacheDir] = useState<string | null>(null);
  useEffect(() => { api?.appInfo().then((i) => setCacheDir(i.cacheDir)).catch(() => setCacheDir(null)); }, [api]);

  const media = useMemo(() => Object.values(mediaMap).sort((a, b) => a.name.localeCompare(b.name)), [mediaMap]);
  const missing = useMemo(() => media.filter(missingProxy), [media]);
  const notDecodable = useMemo(() => media.filter((m) => needsProxy(m) && m.proxy.status !== 'ready' && m.proxy.status !== 'queued' && m.proxy.status !== 'running'), [media]);
  const selectedEligible = useMemo(() => selectedIds.map((id) => mediaMap[id]).filter((m): m is MediaItem => !!m && proxyEligible(m)), [selectedIds, mediaMap]);
  const selectedScene = useMemo(() => selectedIds.map((id) => mediaMap[id]).filter((m): m is MediaItem => !!m && sceneEligible(m) && m.sceneDetectStatus !== 'running'), [selectedIds, mediaMap]);
  const withoutScenes = useMemo(() => media.filter((m) => sceneEligible(m) && m.detectedScenes.length === 0 && m.sceneDetectStatus !== 'running'), [media]);
  const activeProxyJobs = useJobsSelect(useCallback((jobs: JobInfo[]) => jobs.filter((j) => j.kind === 'proxy' && isActiveJob(j)).length, []));
  const ready = media.filter((m) => m.proxy.status === 'ready').length;

  const cancelAll = () => {
    for (const j of useJobsStore.getState().jobs) if (j.kind === 'proxy' && isActiveJob(j)) api?.cancelJob(j.id);
    // Media left 'queued' without a job (start failed before the queue accepted it) are reset.
    const st = useStore.getState();
    const jobMedia = new Set(useJobsStore.getState().jobs.filter((j) => j.kind === 'proxy' && isActiveJob(j)).map((j) => j.mediaId));
    for (const m of Object.values(st.project.media)) if (m.proxy.status === 'queued' && !jobMedia.has(m.id)) st.setProxy(m.id, { status: 'none' });
  };

  return (
    <div className="col grow" data-testid="proxies-tab">
      <div className="toolbar" style={{ height: 'auto', flexWrap: 'wrap', padding: '3px 4px', gap: 3 }}>
        <Button size="sm" icon={FileVideo} disabled={!missing.length} title="Generate proxies for every file without one (none / failed)" onClick={() => generateFor(missing.map((m) => m.id))} data-testid="proxies-generate-missing">
          Generate missing{missing.length ? ` (${missing.length})` : ''}
        </Button>
        <Button size="sm" disabled={!selectedEligible.length} title="Generate proxies for the media selected in the Project panel" onClick={() => generateFor(selectedEligible.map((m) => m.id))}>
          For selected{selectedEligible.length ? ` (${selectedEligible.length})` : ''}
        </Button>
        <Button size="sm" icon={AlertTriangle} disabled={!notDecodable.length} title="Generate proxies for media the preview cannot decode directly (HEVC, AC-3, MKV…)" onClick={() => generateFor(notDecodable.map((m) => m.id))}>
          Not decodable{notDecodable.length ? ` (${notDecodable.length})` : ''}
        </Button>
        <Button size="sm" icon={Ban} disabled={!activeProxyJobs} title="Cancel every queued and running proxy job" onClick={cancelAll} data-testid="proxies-cancel-all">
          Cancel all{activeProxyJobs ? ` (${activeProxyJobs})` : ''}
        </Button>
        <span className="toolbar-sep" />
        <Button size="sm" icon={Clapperboard} disabled={!selectedScene.length} title="Detect scenes in the selected media (uses the project scene threshold)" onClick={() => detectFor(selectedScene.map((m) => m.id))}>
          Detect scenes: selected{selectedScene.length ? ` (${selectedScene.length})` : ''}
        </Button>
        <Button size="sm" disabled={!withoutScenes.length} title="Detect scenes in every video that has none yet" onClick={() => detectFor(withoutScenes.map((m) => m.id))}>
          All without scenes{withoutScenes.length ? ` (${withoutScenes.length})` : ''}
        </Button>
      </div>
      <div className="toolbar" style={{ height: 'auto', flexWrap: 'wrap', padding: '3px 6px', gap: 8, rowGap: 2 }}>
        <Toggle checked={useProxies} onChange={(v) => setSettings({ useProxies: v })} label={<span className="text-sm nowrap">Playback proxies</span>} title="Play ready proxies instead of originals in the monitors (export always uses originals)" />
        <span className="row gap-4 nowrap">
          <span className="text-dim text-sm">Size</span>
          <Select size="sm" value={String(PROXY_HEIGHTS.includes(proxyHeight) ? proxyHeight : PROXY_HEIGHTS[0])} options={PROXY_HEIGHT_OPTIONS} onChange={(v) => setSettings({ proxyHeight: Number(v) })} title="Height of newly generated proxies" style={{ width: 64 }} />
        </span>
        <span className="ml-auto text-faint text-xs nowrap" title={cacheDir ? `Proxy cache: ${cacheDir}/proxies` : undefined}>{ready}/{media.filter(proxyEligible).length} ready</span>
        {cacheDir ? <span className="text-faint text-xs ellipsis" style={{ flexBasis: '100%' }} title={cacheDir}>Cache: {cacheDir}</span> : null}
      </div>
      <div className="grow scroll-y">
        {media.length === 0 ? (
          <EmptyState icon={FileVideo} title="No media in the project" description="Import media in the Project panel; files the preview cannot decode directly are flagged here." />
        ) : (
          <div className="jp-table" role="list">
            {media.map((m) => <ProxyRow key={m.id} media={m} selected={selectedIds.includes(m.id)} />)}
          </div>
        )}
      </div>
    </div>
  );
}

const ProxyRow = memo(function ProxyRow({ media: m, selected }: { media: MediaItem; selected: boolean }) {
  const job = useJobsSelect(useCallback((jobs: JobInfo[]) => jobs.find((j) => j.kind === 'proxy' && j.mediaId === m.id && isActiveJob(j)), [m.id]), jobEq);
  const api = recutApi();
  const setProxy = useStore((s) => s.setProxy);
  const selectMedia = useStore((s) => s.selectMedia);
  const eligible = proxyEligible(m);
  const flagged = needsProxy(m);
  const status = m.proxy.status;
  const active = status === 'queued' || status === 'running' || !!job;
  const progress = job?.status === 'running' ? job.progress : m.proxy.progress ?? 0;
  const v = m.probe?.video;
  const source = m.offline ? 'offline' : v ? `${v.width}×${v.height} ${v.codec}` : m.probe ? (m.probe.audio.length ? `audio ${m.probe.audio[0].codec}` : m.kind) : m.probeError ? 'probe failed' : 'probing…';

  let statusNode: React.ReactNode;
  if (!eligible) statusNode = <span className="text-faint text-xs">no proxy</span>;
  else if (active) statusNode = <span className="badge">{job?.status === 'running' ? `${Math.round(progress * 100)}%` : 'queued'}</span>;
  else if (status === 'ready') statusNode = <span className="badge ok">ready</span>;
  else if (status === 'failed') statusNode = <span className="badge danger">failed</span>;
  else statusNode = <span className={`badge ${flagged ? 'warn' : 'dim'}`}>{flagged ? 'needed' : 'none'}</span>;

  const cancel = () => {
    if (job) api?.cancelJob(job.id);
    else setProxy(m.id, { status: 'none' });
  };
  const remove = () => {
    setProxy(m.id, { status: 'none' });
    toast('info', 'Proxy unlinked from the project; the cached file stays on disk.');
  };
  const proxyRes = status === 'ready' && m.proxy.height ? `proxy ${m.proxy.width ?? '?'}×${m.proxy.height}` : null;

  return (
    <div className={`jp-trow ${selected ? 'selected' : ''}`} role="listitem" data-testid="proxy-row" data-media-id={m.id} data-proxy-status={status} onClick={(e) => selectMedia([m.id], e.metaKey || e.ctrlKey ? 'toggle' : 'set')}>
      <div className="jp-trow-main">
        <FileVideo className="jp-job-icon" />
        <span className="ellipsis grow" title={m.path}>{m.name}</span>
        {flagged ? <span className="tag nowrap" style={{ borderColor: 'var(--accent-2)', color: 'var(--accent-2)' }} title={previewReason(m) ?? 'Not decodable in the preview'}>needs proxy</span> : null}
        {statusNode}
        <span className="jp-actions" onClick={(e) => e.stopPropagation()}>
          {eligible && !active && status !== 'ready' ? <Button size="sm" onClick={() => generateFor([m.id])} data-testid="proxy-generate">Generate</Button> : null}
          {active ? <Button size="sm" icon={X} onClick={cancel} data-testid="proxy-cancel">Cancel</Button> : null}
          {eligible && !active && status === 'ready' ? <button type="button" className="btn-icon btn-sm" title="Regenerate proxy" aria-label="Regenerate proxy" onClick={() => generateFor([m.id])}><RefreshCw /></button> : null}
          {status === 'ready' && m.proxy.path ? <button type="button" className="btn-icon btn-sm" title="Reveal proxy file" aria-label="Reveal proxy file" onClick={() => api?.showItemInFolder(m.proxy.path!)}><FolderOpen /></button> : null}
          {status === 'ready' ? <button type="button" className="btn-icon btn-sm" title="Delete proxy (unlink; the cache file stays)" aria-label="Delete proxy" onClick={remove}><Trash2 /></button> : null}
        </span>
      </div>
      <div className="jp-trow-sub">
        <span className="text-dim text-xs nowrap" title={previewReason(m)}>{source}</span>
        {proxyRes ? <span className="text-faint text-xs nowrap mono">· {proxyRes}</span> : null}
        {active ? <ProgressBar value={job?.status === 'running' && progress > 0 ? progress : undefined} /> : null}
        {active && job?.message ? <span className="text-faint text-xs ellipsis">{job.message}</span> : null}
        {status === 'failed' && m.proxy.error ? <span className="text-xs text-danger ellipsis" title={m.proxy.error}>{m.proxy.error}</span> : null}
      </div>
    </div>
  );
});
