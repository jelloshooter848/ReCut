/**
 * Keeps a horizontal scroller (the tracks content, the ruler) at the view's scroll position: its scrollLeft holds the
 * whole device pixels of view.scroll * zoom (splitScroll; the caller supplies the sub-pixel rest with a transform).
 *
 * The write happens in a store subscription, synchronously inside the setView that moved the view and before React
 * commits that update: layout is still clean then, so setting scrollLeft costs no forced layout (written from a layout
 * effect after the commit it forces a synchronous style + layout of everything the commit changed, e.g. a page flip's
 * new page of clips, which the frame then lays out again). A layout effect writes what the subscription could not
 * (first mount, content not yet wide enough, a resized or re-shown scroller).
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useStore } from '@/state';
import { splitScroll } from './viewMath';

export function useViewScrollLeft(
  ref: React.RefObject<HTMLElement>, seqId: string, base: number, contentPx: number, clientW: number,
): () => void {
  const st = useRef({ set: NaN, want: base, contentPx: 0, clientW: 0, geom: '' });
  st.current.want = base;
  useLayoutEffect(() => {
    const c = st.current; const el = ref.current;
    c.contentPx = contentPx; c.clientW = clientW;
    const geom = `${contentPx}|${clientW}`;
    if (!el || (c.set === base && c.geom === geom)) return;
    el.scrollLeft = base; c.set = base; c.geom = geom;
  }, [ref, base, contentPx, clientW]);
  useEffect(() => useStore.subscribe((s) => {
    const v = s.project.sequences[seqId]?.view; const el = ref.current; const c = st.current;
    if (!v || !el) return;
    const b = splitScroll(v.scroll * v.zoom, window.devicePixelRatio || 1).base;
    if (b === c.set || b > c.contentPx - c.clientW) return;
    el.scrollLeft = b; c.set = b;
  }), [ref, seqId]);
  /** Re-applies the position (after a resize, being shown again, or a scroll by something else). Reads layout. */
  return useCallback(() => {
    const el = ref.current; const c = st.current; if (!el) return;
    if (Math.abs(el.scrollLeft - c.want) > 1) el.scrollLeft = c.want;
    c.set = c.want;
  }, [ref]);
}
