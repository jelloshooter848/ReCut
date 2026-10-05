import { useMemo } from 'react';
import { create } from 'zustand';
import type { ID, JobInfo, JobKind } from '@shared/model';

export interface JobsState {
  jobs: JobInfo[];
  setJobs(jobs: JobInfo[]): void;
  upsert(job: JobInfo): void;
  remove(id: ID): void;
}

/** Mirror of the main process job list (fed by bootstrap via window.recut.onJobs). */
export const useJobsStore = create<JobsState>()((set) => ({
  jobs: [],
  setJobs: (jobs) => set({ jobs }),
  upsert: (job) => set((s) => {
    const i = s.jobs.findIndex((j) => j.id === job.id);
    if (i < 0) return { jobs: [...s.jobs, job] };
    const jobs = s.jobs.slice(); jobs[i] = job; return { jobs };
  }),
  remove: (id) => set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })),
}));

export const isJobActive = (j: JobInfo) => j.status === 'queued' || j.status === 'running';
export const selectActiveJobs = (s: JobsState) => s.jobs.filter(isJobActive);
export function useActiveJobs(): JobInfo[] {
  const jobs = useJobsStore((s) => s.jobs);
  return useMemo(() => jobs.filter(isJobActive), [jobs]);
}
export function useJob(id: ID | undefined): JobInfo | undefined { return useJobsStore((s) => (id ? s.jobs.find((j) => j.id === id) : undefined)); }

/** The queued/running job of a kind for a media item, if any. */
export function activeJobFor(jobs: JobInfo[], mediaId: ID, kind: JobKind): JobInfo | undefined {
  return jobs.find((j) => j.mediaId === mediaId && j.kind === kind && isJobActive(j));
}

/** Live job (queued/running) for a media item, read from the jobs mirror (no store commits for progress). */
export function useMediaJob(mediaId: ID, kind: JobKind): JobInfo | undefined {
  return useJobsStore((s) => activeJobFor(s.jobs, mediaId, kind));
}
