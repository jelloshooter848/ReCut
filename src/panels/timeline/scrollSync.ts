/**
 * Keeps a horizontal scroller (the tracks content, the ruler) at the view's scroll position: its scrollLeft holds the
 * whole device pixels of view.scroll * zoom (splitScroll; the caller supplies the sub-pixel rest with a transform).
 *
 * The write happens while the component renders the new position, i.e. before React commits that update's DOM
 * changes: written from a layout effect after the commit, setting scrollLeft forces a synchronous style + layout of
 * everything the commit changed (a page flip's new page of clips), which the frame then lays out again. Not in a store
 * subscription either: that would run inside setView and charge its caller. The render-time write is idempotent (a
 * repeated render writes nothing). A layout effect writes what it could not (first mount, content not yet wide enough
 * for the new position, a resized or re-shown scroller). A content width change alone (an edit that changes the
 * sequence duration) writes nothing: the content always reaches past the view, so the offset stays valid, and a write
 * there would force a layout of the edit's commit.
 */
import { useCallback, useLayoutEffect, useRef } from 'react';

export function useViewScrollLeft(
  ref: React.RefObject<HTMLElement>, base: number, contentPx: number, clientW: number,
): () => void {
  const st = useRef({ set: NaN, want: base, contentPx: 0, clientW: 0, writtenW: -1 });
  st.current.want = base;
  {
    // Render-time write against the committed geometry (what the scroller can hold right now).
    const c = st.current; const el = ref.current;
    if (el && c.set !== base && base <= c.contentPx - c.clientW) { el.scrollLeft = base; c.set = base; }
  }
  useLayoutEffect(() => {
    const c = st.current; const el = ref.current;
    c.contentPx = contentPx; c.clientW = clientW;
    if (!el || (c.set === base && c.writtenW === clientW)) return;
    el.scrollLeft = base; c.set = base; c.writtenW = clientW;
  }, [ref, base, contentPx, clientW]);
  /** Re-applies the position (after a resize, being shown again, or a scroll by something else). Reads layout. */
  return useCallback(() => {
    const el = ref.current; const c = st.current; if (!el) return;
    if (Math.abs(el.scrollLeft - c.want) > 1) el.scrollLeft = c.want;
    c.set = c.want;
  }, [ref]);
}
