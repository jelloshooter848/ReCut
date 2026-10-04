/**
 * Mirrors main-process job results (proxy, scene detection) into the project store.
 * Guarded by job id + the media's current status so a second subscriber (e.g. the Jobs panel) cannot double-apply.
 */
import { useEffect } from 'react';
import type { ID, JobInfo, JobKind } from '@shared/model';
import type { SceneDetectResult } from '@shared/ipc';
import { useJobsStore } from '@/app/jobsStore';
import { invalidateMediaPath } from '@/app/media';
import { useStore } from '@/state';

const applied = new Set<string>();

interface ProxyResultLike { path?: string; width?: number; height?: number }

export function applyJobResults(jobs: JobInfo[]): void {
  const st = useStore.getState();
  for (const j of jobs) {
    if (!j.mediaId) continue;
    if (j.status !== 'done' && j.status !== 'failed' && j.status !== 'canceled') continue;
    const key = `${j.id}:${j.status}`;
    if (applied.has(key)) continue;
    const m = st.project.media[j.mediaId];
    if (!m) continue;
    if (j.kind === 'sceneDetect') {
      if (m.sceneDetectStatus !== 'running') continue;
      applied.add(key);
      if (j.status === 'done') {
        const r = j.result as SceneDetectResult | undefined;
        if (r && Array.isArray(r.boundaries)) st.setDetectedScenes(m.id, r.boundaries, r.duration || m.probe?.duration || 0);
        else st.setSceneDetectStatus(m.id, 'failed');
      } else st.setSceneDetectStatus(m.id, j.status === 'failed' ? 'failed' : 'none');
    } else if (j.kind === 'proxy') {
      if (m.proxy.status !== 'queued' && m.proxy.status !== 'running') continue;
      applied.add(key);
      if (j.status === 'done') {
        const r = j.result as ProxyResultLike | undefined;
        if (r?.path) { st.setProxy(m.id, { status: 'ready', path: r.path, width: r.width, height: r.height, progress: 1 }); invalidateMediaPath(m.path); }
        else st.setProxy(m.id, { status: 'failed', error: 'Proxy job produced no output' });
      } else if (j.status === 'failed') st.setProxy(m.id, { status: 'failed', error: j.error ?? 'Proxy failed' });
      else st.setProxy(m.id, { status: 'none' });
    }
  }
}

/** Subscribe once (per mounted panel) to job updates. */
export function useJobSync(): void {
  useEffect(() => {
    applyJobResults(useJobsStore.getState().jobs);
    return useJobsStore.subscribe((s) => applyJobResults(s.jobs));
  }, []);
}

export function activeJobFor(jobs: JobInfo[], mediaId: ID, kind: JobKind): JobInfo | undefined {
  return jobs.find((j) => j.mediaId === mediaId && j.kind === kind && (j.status === 'queued' || j.status === 'running'));
}

/** Live job (queued/running) for a media item, read from the jobs mirror (no store commits for progress). */
export function useMediaJob(mediaId: ID, kind: JobKind): JobInfo | undefined {
  return useJobsStore((s) => activeJobFor(s.jobs, mediaId, kind));
}
