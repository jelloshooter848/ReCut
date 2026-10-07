/**
 * Routes main-process job results into the project store:
 *  - proxy: queued/running/ready/failed → media.proxy (+ media element invalidation when ready)
 *  - sceneDetect: done → detected scenes; failed → status
 *  - export: toasts
 *  - download (OCR language installs): toasts + refresh of the OCR language list (src/state/ocrStatus.ts)
 * This is the ONLY job→project mirror (jobsStore → store): each terminal result is applied once (by job id) and
 * every write is additionally guarded by the media's current state, so results survive a project reload without
 * double-applying. Jobs are also mirrored into store.jobs so panels may read either store consistently.
 *
 * Note: status writes are quiet (not undoable) but per-tick progress is still NOT written to the store (only
 * status transitions); live progress is read from jobsStore by the UI.
 */
import type { JobInfo } from '@shared/model';
import type { SceneDetectResult } from '@shared/ipc';
import { useStore } from '@/state/store';
import { useJobsStore } from './jobsStore';
import { invalidateMediaPath } from './media';
import { requeueStaleProxy } from '@/state/mediaActions';
import { toast } from '@/components/ui/toastStore';
import { useOcrStatus } from '@/state/ocrStatus';

interface ProxyResultLike { path: string; width?: number; height?: number; cached?: boolean; audioStreams?: number[] }
interface ExportResultLike { outputPath?: string; sidecarPath?: string; warnings?: string[] }

const handled = new Set<string>();
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const isTerminal = (j: JobInfo) => j.status === 'done' || j.status === 'failed' || j.status === 'canceled';

/** Claim a terminal job id; false when it was already applied. */
function claim(job: JobInfo): boolean {
  if (handled.has(job.id)) return false;
  handled.add(job.id);
  return true;
}

function routeProxy(job: JobInfo): void {
  const st = useStore.getState();
  const media = job.mediaId ? st.project.media[job.mediaId] : undefined;
  if (!media) return;
  switch (job.status) {
    case 'queued':
      if (media.proxy.status === 'none' || media.proxy.status === 'failed') st.setProxy(media.id, { status: 'queued', progress: 0 });
      break;
    case 'running':
      if (media.proxy.status !== 'running') st.setProxy(media.id, { status: 'running', progress: job.progress || 0 });
      break;
    case 'done': {
      if (!claim(job)) return;
      const r = (job.result ?? null) as ProxyResultLike | null;
      if (!r?.path) { if (media.proxy.status !== 'failed') st.setProxy(media.id, { status: 'failed', error: 'Proxy job finished without a result' }); return; }
      if (media.proxy.status === 'ready' && media.proxy.path === r.path) return; // already applied by another mirror
      // Drop stale elements BEFORE the store change: setProxy synchronously re-renders the paused Program frame, which
      // acquires a fresh element for the proxy path; invalidating afterwards disposed that element (BUG-6).
      invalidateMediaPath(media.path);
      invalidateMediaPath(r.path);
      // Record the streams the proxy carries: a fallback proxy lacks the ones FFmpeg could not decode or encode.
      st.setProxy(media.id, { status: 'ready', path: r.path, progress: 1, width: r.width, height: r.height, ...(Array.isArray(r.audioStreams) ? { audioStreams: [...r.audioStreams] } : {}) });
      // The media's audio stream changed while this proxy was being built: it carries the old track.
      if (requeueStaleProxy(media.id)) break;
      if (!r.cached) toast('ok', `Proxy ready: ${media.name}`);
      break;
    }
    case 'failed':
      if (!claim(job)) return;
      if (media.proxy.status === 'failed' && media.proxy.error === (job.error ?? 'Proxy failed')) return;
      st.setProxy(media.id, { status: 'failed', error: job.error ?? 'Proxy failed' });
      toast('error', `Proxy failed for ${media.name}: ${job.error ?? 'unknown error'}`);
      break;
    case 'canceled':
      if (!claim(job)) return;
      if (media.proxy.status === 'queued' || media.proxy.status === 'running') st.setProxy(media.id, { status: 'none' });
      break;
  }
}

function routeSceneDetect(job: JobInfo): void {
  const st = useStore.getState();
  const media = job.mediaId ? st.project.media[job.mediaId] : undefined;
  if (!media) return;
  switch (job.status) {
    case 'queued':
    case 'running':
      if (media.sceneDetectStatus !== 'running') st.setSceneDetectStatus(media.id, 'running');
      break;
    case 'done': {
      if (!claim(job)) return;
      const r = (job.result ?? null) as SceneDetectResult | null;
      if (!r || !Array.isArray(r.boundaries)) {
        if (media.sceneDetectStatus !== 'failed') { st.setSceneDetectStatus(media.id, 'failed'); toast('error', `Scene detection returned no result for ${media.name}`); }
        return;
      }
      if (media.sceneDetectStatus === 'done' && media.detectedScenes.length > 0) return; // already applied
      st.setDetectedScenes(media.id, r.boundaries, r.duration > 0 ? r.duration : media.probe?.duration ?? 0);
      toast('ok', `${r.boundaries.length} cut${r.boundaries.length === 1 ? '' : 's'} detected in ${media.name}`);
      break;
    }
    case 'failed':
      if (!claim(job)) return;
      if (media.sceneDetectStatus === 'failed') return;
      st.setSceneDetectStatus(media.id, 'failed');
      toast('error', `Scene detection failed for ${media.name}: ${job.error ?? 'unknown error'}`);
      break;
    case 'canceled':
      if (!claim(job)) return;
      if (media.sceneDetectStatus === 'running') st.setSceneDetectStatus(media.id, media.detectedScenes.length ? 'done' : 'none');
      break;
  }
}

function routeExport(job: JobInfo): void {
  if (!isTerminal(job) || !claim(job)) return;
  const r = (job.result ?? null) as ExportResultLike | null;
  if (job.status === 'done') {
    const out = r?.outputPath;
    toast('ok', out ? `Export finished: ${baseName(out)}` : 'Export finished', 8000);
    if (r?.warnings?.length) toast('warn', `Export warnings: ${r.warnings[0]}${r.warnings.length > 1 ? ` (+${r.warnings.length - 1})` : ''}`);
  } else if (job.status === 'failed') {
    toast('error', `Export failed: ${job.error ?? 'unknown error'}`);
  } else {
    toast('info', 'Export canceled');
  }
}

/** "English" from a download job titled "Install English OCR data (4.1 MB)"; the title itself otherwise. */
function downloadName(job: JobInfo): string {
  return /^Install (.+) OCR data\b/.exec(job.title)?.[1] ?? job.title;
}

function routeDownload(job: JobInfo): void {
  if (!isTerminal(job) || !claim(job)) return;
  const name = downloadName(job);
  if (job.status === 'done') toast('ok', `${name} OCR language installed`);
  else if (job.status === 'failed') toast('error', `Could not install ${name} OCR data: ${job.error ?? 'unknown error'}`);
  else toast('info', `${name} OCR download canceled`);
  void useOcrStatus.getState().refresh();
}

/** Reveal an exported file in the OS file manager (for UI that renders export results). */
export function revealExport(path: string): void { void window.recut?.showItemInFolder?.(path).catch(() => { /* ignore */ }); }

/** Apply a job list to the store (exported for tests). */
export function routeJobs(jobs: JobInfo[]): void {
  useStore.getState().setJobs(jobs);
  for (const job of jobs) {
    try {
      if (job.kind === 'proxy') routeProxy(job);
      else if (job.kind === 'sceneDetect') routeSceneDetect(job);
      else if (job.kind === 'export') routeExport(job);
      else if (job.kind === 'download') routeDownload(job);
    } catch (e) {
      console.error('[jobsRouter] failed to route job', job.id, e);
    }
  }
  // Forget ids that left the main-process list so a cleared queue cannot grow the set unbounded.
  if (handled.size > 1000) { const alive = new Set(jobs.map((j) => j.id)); for (const id of handled) if (!alive.has(id)) handled.delete(id); }
}

/** Mark terminal jobs as already handled (e.g. after loading a project whose media reflects them). */
export function markJobsHandled(jobs: JobInfo[]): void { for (const j of jobs) if (isTerminal(j)) handled.add(j.id); }

export function resetJobsRouter(): void { handled.clear(); }

let unsubscribe: (() => void) | null = null;

/** Subscribe to the jobs mirror. Idempotent; returns a dispose function. */
export function initJobsRouter(): () => void {
  if (unsubscribe) return unsubscribe;
  routeJobs(useJobsStore.getState().jobs);
  const off = useJobsStore.subscribe((s, prev) => { if (s.jobs !== prev.jobs) routeJobs(s.jobs); });
  unsubscribe = () => { off(); unsubscribe = null; };
  return unsubscribe;
}
