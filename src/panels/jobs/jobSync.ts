/**
 * Mirrors main-process job outcomes into the project: proxy jobs → media.proxy, scene detection jobs →
 * detectedScenes. Only status transitions are committed (never per-tick progress), so undo history is not
 * flooded; live progress is read from the jobs store by the UI. Every write is guarded by the media's current
 * state, so a second mirror (src/app/jobsRouter.ts, the Project panel) cannot double-apply. Toasts are left to
 * the app-level router; the Export dialog shows export results itself.
 */
import type { ID, JobInfo, JobStatus, MediaItem } from '@shared/model';
import { useJobsStore } from '@/app/jobsStore';
import { invalidateMediaPath } from '@/app/media';
import { useStore } from '@/state';

interface ProxyResultLike { path?: string; width?: number; height?: number }
interface SceneResultLike { boundaries?: number[]; duration?: number }

const seen = new Map<ID, JobStatus>();
let started = false;
let stop: (() => void) | null = null;

function mediaOf(id: ID | undefined): MediaItem | undefined {
  return id ? useStore.getState().project.media[id] : undefined;
}

function handleProxy(job: JobInfo): void {
  const m = mediaOf(job.mediaId);
  if (!m) return;
  const st = useStore.getState();
  switch (job.status) {
    case 'running':
      if (m.proxy.status !== 'running') st.setProxy(m.id, { ...m.proxy, status: 'running', progress: job.progress, error: undefined });
      break;
    case 'done': {
      const r = (job.result ?? {}) as ProxyResultLike;
      if (!r.path) return;
      if (m.proxy.status === 'ready' && m.proxy.path === r.path) return;
      st.setProxy(m.id, { status: 'ready', path: r.path, progress: 1, width: r.width, height: r.height });
      invalidateMediaPath(m.path);
      break;
    }
    case 'failed':
      if (m.proxy.status !== 'failed' || m.proxy.error !== job.error) st.setProxy(m.id, { status: 'failed', error: job.error ?? 'Proxy failed', progress: job.progress });
      break;
    case 'canceled':
      if (m.proxy.status === 'queued' || m.proxy.status === 'running') st.setProxy(m.id, { status: 'none' });
      break;
    default:
      break;
  }
}

function handleSceneDetect(job: JobInfo): void {
  const m = mediaOf(job.mediaId);
  if (!m) return;
  const st = useStore.getState();
  switch (job.status) {
    case 'running':
      if (m.sceneDetectStatus !== 'running') st.setSceneDetectStatus(m.id, 'running');
      break;
    case 'done': {
      const r = (job.result ?? {}) as SceneResultLike;
      if (!Array.isArray(r.boundaries)) return;
      // startSceneDetect() flips the media to 'running' before the job exists; a media already 'done' with
      // scenes means this (older) result was applied before (e.g. the job list survived a project reload).
      if (m.sceneDetectStatus === 'done' && m.detectedScenes.length > 0) return;
      st.setDetectedScenes(m.id, r.boundaries, r.duration ?? m.probe?.duration ?? 0);
      break;
    }
    case 'failed':
      if (m.sceneDetectStatus !== 'failed') st.setSceneDetectStatus(m.id, 'failed');
      break;
    case 'canceled':
      if (m.sceneDetectStatus === 'running') st.setSceneDetectStatus(m.id, m.detectedScenes.length ? 'done' : 'none');
      break;
    default:
      break;
  }
}

function onJobs(jobs: JobInfo[]): void {
  const alive = new Set<ID>();
  for (const job of jobs) {
    alive.add(job.id);
    const prev = seen.get(job.id);
    if (prev === job.status) continue;
    seen.set(job.id, job.status);
    try {
      if (job.kind === 'proxy') handleProxy(job);
      else if (job.kind === 'sceneDetect') handleSceneDetect(job);
    } catch (err) {
      console.error('[jobs] failed to apply job update', job, err);
    }
  }
  for (const id of [...seen.keys()]) if (!alive.has(id)) seen.delete(id);
}

/** Start mirroring job outcomes into the project store (idempotent). Returns a stop function. */
export function startJobSync(): () => void {
  if (started) return stop!;
  started = true;
  // Statuses already present when we start are treated as "seen" only if the project already reflects them;
  // simplest correct behaviour is to process the current snapshot once.
  onJobs(useJobsStore.getState().jobs);
  const unsub = useJobsStore.subscribe((s) => onJobs(s.jobs));
  stop = () => { unsub(); started = false; stop = null; seen.clear(); };
  return stop;
}
