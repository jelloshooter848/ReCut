/**
 * src/panels/timeline/mediaSettle.ts (P-05): a clip's filmstrip / waveform request starts only once its view has been
 * stable for MEDIA_SETTLE_MS (150 ms) AND no edit has been committed for EDIT_QUIET_MS (300 ms); the quiet wait
 * restarts on every new commit (and undo / redo); view-only updates (playhead, scroll) do not count as edits; the
 * request starts as soon as the editing pauses; the returned cancel function stops it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore, resetStore } from '../../src/state/store';
import { createSequence } from '../../shared/project';
import { afterMediaSettle, EDIT_QUIET_MS } from '../../src/panels/timeline/mediaSettle';
import { MEDIA_SETTLE_MS } from '../../src/panels/timeline/viewMath';

const S = () => useStore.getState();
let seqId: string;
let markerN = 0;
/** A committed edit (new history identity). */
const edit = () => { S().addMarker(seqId, { time: ++markerN }); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
  resetStore();
  const s = createSequence('Settle', { num: 24, den: 1 });
  S().addSequence(s);
  seqId = s.id;
  // Any edit made by the setup above is long past.
  vi.advanceTimersByTime(10_000);
});
afterEach(() => { vi.useRealTimers(); });

describe('afterMediaSettle', () => {
  it('uses the documented waits', () => {
    expect(MEDIA_SETTLE_MS).toBe(150);
    expect(EDIT_QUIET_MS).toBe(300);
  });

  it('starts MEDIA_SETTLE_MS after the view settled when no edit is recent', () => {
    const start = vi.fn();
    afterMediaSettle(start);
    vi.advanceTimersByTime(MEDIA_SETTLE_MS - 1);
    expect(start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(start).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    expect(start).toHaveBeenCalledTimes(1); // once only
  });

  it('waits EDIT_QUIET_MS after the last committed edit, even past the view settle', () => {
    afterMediaSettle(() => { /* subscribe the edit watcher */ })();
    const start = vi.fn();
    edit(); // t = 0
    expect(S().history.past.length).toBeGreaterThan(0);
    afterMediaSettle(start);
    vi.advanceTimersByTime(MEDIA_SETTLE_MS); // view settled, edit still recent
    expect(start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(EDIT_QUIET_MS - MEDIA_SETTLE_MS - 1); // t = 299
    expect(start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); // t = 300: editing paused for EDIT_QUIET_MS -> starts at once
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('restarts the quiet wait on each new edit, then starts right after the editing pauses', () => {
    afterMediaSettle(() => { /* subscribe */ })();
    const start = vi.fn();
    const t0 = performance.now();
    afterMediaSettle(start);
    // A burst of edits every 100 ms for 1 s: never 300 ms quiet.
    let t = 0;
    for (let i = 0; i < 10; i++) { vi.advanceTimersByTime(100); t += 100; edit(); }
    expect(start).not.toHaveBeenCalled();
    const lastEdit = t;
    vi.advanceTimersByTime(EDIT_QUIET_MS - 1);
    expect(start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(performance.now() - t0).toBe(lastEdit + EDIT_QUIET_MS);
  });

  it('an edit that is EDIT_QUIET_MS old by the time the view settles adds no wait', () => {
    afterMediaSettle(() => { /* subscribe */ })();
    const start = vi.fn();
    edit();
    vi.advanceTimersByTime(250);
    afterMediaSettle(start); // edit 250 ms ago: settle ends at +150 (edit 400 ms ago) -> starts at the settle
    vi.advanceTimersByTime(MEDIA_SETTLE_MS - 1);
    expect(start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('undo and redo count as edits', () => {
    afterMediaSettle(() => { /* subscribe */ })();
    edit();
    vi.advanceTimersByTime(1_000);
    const start = vi.fn();
    afterMediaSettle(start);
    vi.advanceTimersByTime(100);
    S().undo();
    vi.advanceTimersByTime(200); // settle passed, undo 200 ms ago
    expect(start).not.toHaveBeenCalled();
    S().redo();
    vi.advanceTimersByTime(EDIT_QUIET_MS - 1);
    expect(start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('view-only updates (playhead, scroll, zoom) do not delay the request', () => {
    afterMediaSettle(() => { /* subscribe */ })();
    const start = vi.fn();
    afterMediaSettle(start);
    for (let i = 0; i < 10; i++) { S().setView(seqId, { playhead: i * 10, scroll: i }); vi.advanceTimersByTime(10); }
    S().setView(seqId, { zoom: 2 });
    vi.advanceTimersByTime(MEDIA_SETTLE_MS - 100);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('cancel stops a pending request, in the settle wait and in the edit wait', () => {
    afterMediaSettle(() => { /* subscribe */ })();
    const a = vi.fn();
    const cancelA = afterMediaSettle(a);
    vi.advanceTimersByTime(MEDIA_SETTLE_MS - 1);
    cancelA();
    vi.advanceTimersByTime(1_000);
    expect(a).not.toHaveBeenCalled();

    const b = vi.fn();
    edit();
    const cancelB = afterMediaSettle(b);
    vi.advanceTimersByTime(MEDIA_SETTLE_MS + 50); // now in the edit-quiet re-wait
    cancelB();
    vi.advanceTimersByTime(1_000);
    expect(b).not.toHaveBeenCalled();
    cancelB(); // idempotent
  });

  it('every pending clip starts together right after the pause', () => {
    afterMediaSettle(() => { /* subscribe */ })();
    const starts = Array.from({ length: 5 }, () => vi.fn());
    edit();
    starts.forEach((s) => { vi.advanceTimersByTime(20); afterMediaSettle(s); }); // created at +20..+100
    edit(); // at +100: restarts the quiet wait for all of them
    vi.advanceTimersByTime(EDIT_QUIET_MS - 1);
    for (const s of starts) expect(s).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    for (const s of starts) expect(s).toHaveBeenCalledTimes(1);
  });
});
