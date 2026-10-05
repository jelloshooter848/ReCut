/**
 * Selector hook over the jobs store with a custom equality function, so components only re-render when
 * the slice they care about changes (the main process ships fresh JobInfo clones up to 10×/sec).
 */
import { useRef, useSyncExternalStore } from 'react';
import type { JobInfo } from '@shared/model';
import { useJobsStore } from '@/app/jobsStore';

export function useJobsSelect<T>(selector: (jobs: JobInfo[]) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const cache = useRef<{ jobs: JobInfo[]; selector: typeof selector; value: T } | null>(null);
  const get = () => {
    const jobs = useJobsStore.getState().jobs;
    const c = cache.current;
    if (c && c.jobs === jobs && c.selector === selector) return c.value;
    const value = selector(jobs);
    if (c && isEqual(c.value, value)) { cache.current = { jobs, selector, value: c.value }; return c.value; }
    cache.current = { jobs, selector, value };
    return value;
  };
  return useSyncExternalStore(useJobsStore.subscribe, get, get);
}

/** Field-wise equality for a JobInfo (progress compared at 0.5% resolution). */
export function jobEq(a: JobInfo | undefined, b: JobInfo | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.status === b.status && a.message === b.message && a.error === b.error && a.title === b.title
    && a.startedAt === b.startedAt && a.finishedAt === b.finishedAt && !!a.result === !!b.result
    && Math.round(a.progress * 200) === Math.round(b.progress * 200);
}

export function arrayEq<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean = Object.is): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i])) return false;
  return true;
}
