/**
 * In-flight job de-duplication: callers register a job under a key (proxy output path, scene-detect
 * mediaId+threshold, ...) and get the still-queued/running job back instead of starting a duplicate.
 */
import type { JobInfo } from '@shared/model';
import type { JobQueue } from './jobQueue';

export type InFlight = WeakMap<JobQueue, Map<string, string>>;
/** The still-queued/running job registered under `key`, if any. */
export function inFlightJob(queue: JobQueue, registry: InFlight, key: string): JobInfo | null {
  const id = registry.get(queue)?.get(key);
  if (!id) return null;
  const info = queue.get(id);
  if (info && (info.status === 'queued' || info.status === 'running')) return info;
  registry.get(queue)?.delete(key);
  return null;
}

/** Register `jobId` under `key` until it settles. */
export function trackInFlight(queue: JobQueue, registry: InFlight, key: string, jobId: string): void {
  let m = registry.get(queue);
  if (!m) { m = new Map(); registry.set(queue, m); }
  m.set(key, jobId);
  const map = m;
  queue.waitFor(jobId).finally(() => { if (map.get(key) === jobId) map.delete(key); }).catch(() => undefined);
}
