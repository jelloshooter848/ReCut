import { useMemo } from 'react';
import { create } from 'zustand';
import type { ID, JobInfo } from '@shared/model';

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
