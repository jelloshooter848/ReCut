/**
 * Background job queue for the main process.
 *
 * - Two lanes: 'export' jobs run one at a time; every other kind shares a lane with concurrency 2.
 * - Jobs expose a run context with progress reporting, cancellation callbacks and an AbortSignal.
 * - Subscribers receive JobInfo[] snapshots, throttled to at most 10 updates/sec.
 *
 * Pure Node (no Electron) so it can be unit-tested.
 */
import type { ID, JobInfo, JobKind, JobStatus } from '@shared/model';
import { uid } from '@shared/ids';

export interface JobRunContext {
  readonly jobId: ID;
  readonly signal: AbortSignal;
  setProgress(progress: number, message?: string): void;
  /** Register a callback invoked when the job is canceled while running. */
  onCancel(fn: () => void): void;
  /** True once cancel() has been requested. */
  readonly canceled: boolean;
}

export interface JobSpec<T = unknown> {
  kind: JobKind;
  title: string;
  mediaId?: ID;
  run: (ctx: JobRunContext) => Promise<T>;
}

interface InternalJob {
  info: JobInfo;
  spec: JobSpec;
  controller: AbortController;
  cancelFns: (() => void)[];
  lane: 'export' | 'media';
  waiters: { resolve: (j: JobInfo) => void }[];
  promise?: Promise<void>;
}

export type JobsListener = (jobs: JobInfo[]) => void;

export class JobCanceledError extends Error {
  constructor(message = 'job canceled') { super(message); this.name = 'JobCanceledError'; }
}

export interface JobQueueOptions {
  mediaConcurrency?: number;
  exportConcurrency?: number;
  /** Minimum ms between snapshot emissions (default 100 → ≤10/sec). */
  throttleMs?: number;
}

export class JobQueue {
  private jobs = new Map<ID, InternalJob>();
  private order: ID[] = [];
  private listeners = new Set<JobsListener>();
  private running = { media: 0, export: 0 };
  private readonly limits: { media: number; export: number };
  private readonly throttleMs: number;
  private emitTimer: NodeJS.Timeout | null = null;
  private lastEmit = 0;
  private dirty = false;

  constructor(opts: JobQueueOptions = {}) {
    this.limits = { media: opts.mediaConcurrency ?? 2, export: opts.exportConcurrency ?? 1 };
    this.throttleMs = opts.throttleMs ?? 100;
  }

  /** Enqueue a job. Returns its initial JobInfo snapshot (status 'queued'). */
  add<T>(spec: JobSpec<T>): JobInfo {
    const id = uid('job_');
    const info: JobInfo = {
      id,
      kind: spec.kind,
      title: spec.title,
      status: 'queued',
      progress: 0,
      mediaId: spec.mediaId,
    };
    const job: InternalJob = {
      info,
      spec: spec as JobSpec,
      controller: new AbortController(),
      cancelFns: [],
      lane: spec.kind === 'export' ? 'export' : 'media',
      waiters: [],
    };
    this.jobs.set(id, job);
    this.order.push(id);
    this.scheduleEmit();
    this.pump();
    return { ...info };
  }

  get(id: ID): JobInfo | undefined {
    const j = this.jobs.get(id);
    return j ? { ...j.info } : undefined;
  }

  list(): JobInfo[] {
    return this.order.map((id) => ({ ...this.jobs.get(id)!.info }));
  }

  /** Resolves when the job reaches a terminal status (done / failed / canceled). */
  waitFor(id: ID): Promise<JobInfo> {
    const j = this.jobs.get(id);
    if (!j) return Promise.reject(new Error(`unknown job ${id}`));
    if (isTerminal(j.info.status)) return Promise.resolve({ ...j.info });
    return new Promise((resolve) => j.waiters.push({ resolve }));
  }

  /** Cancel a queued or running job. No-op for finished/unknown jobs. */
  cancel(id: ID): void {
    const j = this.jobs.get(id);
    if (!j || isTerminal(j.info.status)) return;
    if (j.info.status === 'queued') {
      this.finish(j, 'canceled');
      return;
    }
    // running: signal the run; status flips to 'canceled' once run() settles
    j.controller.abort();
    const fns = j.cancelFns.splice(0);
    for (const fn of fns) {
      try { fn(); } catch { /* ignore */ }
    }
    j.info.message = 'Canceling…';
    this.scheduleEmit();
  }

  /** Cancel every non-finished job. */
  cancelAll(): void {
    for (const id of [...this.order]) this.cancel(id);
  }

  /** Remove finished (done / failed / canceled) jobs from the list. */
  clear(): void {
    const keep: ID[] = [];
    for (const id of this.order) {
      const j = this.jobs.get(id)!;
      if (isTerminal(j.info.status)) this.jobs.delete(id);
      else keep.push(id);
    }
    this.order = keep;
    this.scheduleEmit();
  }

  /** Subscribe to throttled JobInfo[] snapshots. Returns an unsubscribe function. */
  subscribe(cb: JobsListener): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** Number of jobs currently running (all lanes). */
  get activeCount(): number { return this.running.media + this.running.export; }

  // ------------------------------------------------------------------

  private pump(): void {
    for (const id of this.order) {
      const j = this.jobs.get(id)!;
      if (j.info.status !== 'queued') continue;
      if (this.running[j.lane] >= this.limits[j.lane]) continue;
      this.start(j);
    }
  }

  private start(j: InternalJob): void {
    this.running[j.lane]++;
    j.info.status = 'running';
    j.info.startedAt = Date.now();
    j.info.message = undefined;
    this.scheduleEmit();

    const ctx: JobRunContext = {
      jobId: j.info.id,
      signal: j.controller.signal,
      get canceled() { return j.controller.signal.aborted; },
      setProgress: (p, message) => {
        if (j.info.status !== 'running') return;
        j.info.progress = clamp01(p);
        if (message !== undefined) j.info.message = message;
        this.scheduleEmit();
      },
      onCancel: (fn) => {
        if (j.controller.signal.aborted) { try { fn(); } catch { /* ignore */ } return; }
        j.cancelFns.push(fn);
      },
    };

    j.promise = Promise.resolve()
      .then(() => j.spec.run(ctx))
      .then(
        (result) => {
          if (j.controller.signal.aborted) this.finish(j, 'canceled');
          else { j.info.result = result; j.info.progress = 1; this.finish(j, 'done'); }
        },
        (err: unknown) => {
          if (j.controller.signal.aborted) this.finish(j, 'canceled');
          else this.finish(j, 'failed', errorMessage(err));
        },
      )
      .finally(() => {
        this.running[j.lane]--;
        this.pump();
      });
  }

  private finish(j: InternalJob, status: Exclude<JobStatus, 'queued' | 'running'>, error?: string): void {
    if (isTerminal(j.info.status)) return;
    j.info.status = status;
    j.info.finishedAt = Date.now();
    j.info.message = undefined;
    if (error) j.info.error = error;
    if (status === 'canceled' && !j.info.error) j.info.message = undefined;
    j.cancelFns.length = 0;
    const waiters = j.waiters.splice(0);
    const snap = { ...j.info };
    for (const w of waiters) w.resolve(snap);
    this.scheduleEmit();
  }

  private scheduleEmit(): void {
    if (this.listeners.size === 0) return;
    this.dirty = true;
    if (this.emitTimer) return;
    const since = Date.now() - this.lastEmit;
    const delay = since >= this.throttleMs ? 0 : this.throttleMs - since;
    this.emitTimer = setTimeout(() => this.emitNow(), delay);
    this.emitTimer.unref?.();
  }

  private emitNow(): void {
    this.emitTimer = null;
    if (!this.dirty) return;
    this.dirty = false;
    this.lastEmit = Date.now();
    const snapshot = this.list();
    for (const cb of this.listeners) {
      try { cb(snapshot); } catch { /* listener errors must not break the queue */ }
    }
  }

  /** Flush any pending snapshot immediately (useful in tests / before quit). */
  flush(): void {
    if (this.emitTimer) { clearTimeout(this.emitTimer); this.emitTimer = null; }
    this.emitNow();
  }
}

function isTerminal(s: JobStatus): boolean {
  return s === 'done' || s === 'failed' || s === 'canceled';
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}
