/**
 * When a clip's filmstrip / waveform request may start (P-05): once its visible range has been stable for
 * MEDIA_SETTLE_MS, and no edit has been committed for EDIT_QUIET_MS.
 *
 * Every edit (commit, undo, redo) re-renders the clips it touches (split tails, rippled clips, the inserted clip), and
 * each of those used to request its frames MEDIA_SETTLE_MS later. During a burst of edits (an editor inserting or
 * nudging clip after clip, a keyboard-repeated command) those requests start ffmpeg processes in the main process
 * while the next edits are still being committed and painted: on a 4-core machine up to three ffmpeg processes then
 * compete with the renderer for the CPU, and edit -> paint slows down by a third. So the requests wait for a pause in
 * the editing (restarting on each new edit) and then start at once: the filmstrips still appear shortly after the
 * editing stops.
 */
import { useStore } from '@/state';
import { MEDIA_SETTLE_MS } from './viewMath';

/** Quiet time after the last committed edit before a clip starts its media requests (ms). */
export const EDIT_QUIET_MS = 300;

let lastEditAt = -Infinity;
let watching = false;

function watchEdits(): void {
  if (watching) return;
  watching = true;
  // History identity changes on every commit, undo, redo and project load; view changes (scroll, zoom, playhead) and
  // other uncommitted updates leave it alone.
  useStore.subscribe((s, prev) => { if (s.history !== prev.history) lastEditAt = performance.now(); });
}

/**
 * Runs `start` once the clip's view has settled and edits have paused; returns a cancel function (call it from the
 * effect's cleanup).
 */
export function afterMediaSettle(start: () => void): () => void {
  watchEdits();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const check = () => {
    const wait = lastEditAt + EDIT_QUIET_MS - performance.now();
    if (wait > 0) { timer = setTimeout(check, wait); return; }
    timer = null;
    start();
  };
  timer = setTimeout(check, MEDIA_SETTLE_MS);
  return () => { if (timer) clearTimeout(timer); timer = null; };
}

