/**
 * When an autosave may run: only in a pause of the user's work.
 *
 * An autosave serializes the whole project in one task (JSON.stringify + the IPC send: 160-430 ms on the bench's
 * 2,500-clip project with its 3 h sequence). Run from an idle callback alone, it still landed between the frames of a
 * scrub, a drag or a wheel scroll, which leave idle time after every frame: a long freeze in the middle of the
 * interaction (the perf bench's "long tasks during scrub" rows). The gate defers it:
 * - until the user has been quiet (no store update, no pointer / key / wheel input) for `quietMs`;
 * - once it has waited `patienceMs`, any pause of `shortQuietMs` will do (the end of a drag, between scrub strokes),
 *   so a busy session still saves soon, just never mid-stroke;
 * - after `maxDeferMs` it runs anyway, so a session is never left unsaved for long.
 *
 * Pure (an injected clock), so the policy is unit tested without timers.
 */
export interface AutosaveGateOptions {
  quietMs: number;
  shortQuietMs: number;
  patienceMs: number;
  maxDeferMs: number;
  now: () => number;
}

export interface AutosaveGate {
  /** Note user activity (a store update, a pointer press / drag, a key, a wheel step). */
  activity(): void;
  /**
   * 0 when the save may run now; otherwise the ms to wait before asking again. The first deferred ask starts the
   * deferral; it ends (and the patience / max-defer clocks reset) when an ask returns 0 or `reset()` is called.
   */
  waitMs(): number;
  /** The pending save was dropped (project clean, lifecycle disposed): the next ask starts a fresh deferral. */
  reset(): void;
}

export function createAutosaveGate(opts: AutosaveGateOptions): AutosaveGate {
  let lastActivity = -Infinity;
  let deferredSince: number | null = null;
  return {
    activity() { lastActivity = opts.now(); },
    waitMs() {
      const now = opts.now();
      const since = deferredSince ?? now;
      const waited = now - since;
      const quiet = waited >= opts.patienceMs ? opts.shortQuietMs : opts.quietMs;
      const wait = lastActivity + quiet - now;
      if (wait <= 0 || waited >= opts.maxDeferMs) { deferredSince = null; return 0; }
      deferredSince = since;
      // Ask again when the current quiet requirement is met, or when patience / the cap changes the answer.
      const nextChange = waited < opts.patienceMs ? opts.patienceMs - waited : opts.maxDeferMs - waited;
      return Math.max(1, Math.ceil(Math.min(wait, nextChange)));
    },
    reset() { deferredSince = null; },
  };
}
