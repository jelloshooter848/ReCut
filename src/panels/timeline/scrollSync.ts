/**
 * Keeps a horizontal scroller (the tracks content, the ruler, the scrollbar) at the view's scroll position: its
 * scrollLeft holds `base` (for the tracks and the ruler the whole device pixels of view.scroll * zoom, see splitScroll;
 * the caller supplies the sub-pixel rest with a transform).
 *
 * The write happens while the component renders the new position, i.e. before React commits that update's DOM
 * changes: written from a layout effect after the commit, setting scrollLeft forces a synchronous style + layout of
 * everything the commit changed (a page flip's new page of clips), which the frame then lays out again. Not in a store
 * subscription either: that would run inside setView and charge its caller. The render-time write is idempotent (a
 * repeated render writes nothing). A layout effect writes what it could not (first mount, content not yet wide enough
 * for the new position, a resized or re-shown scroller). A content width change alone (an edit that changes the
 * sequence duration) writes nothing: the content always reaches past the view, so the offset stays valid, and a write
 * there would force a layout of the edit's commit.
 *
 * Scroll events: each write is answered by a scroll event at the start of the next frame. Reading scrollLeft there to
 * tell it from a scroll by something else (the user, drag-and-drop autoscroll) forces a style + layout of whatever
 * changed since the last frame (hover state, loaded images), which the frame lays out again right after: during a
 * scrub that is every frame. So `onScroll` takes the event that answers a write as ours without reading, and checks
 * the position once the renderer is idle instead (a scroll by something else in that same frame is caught there).
 */
import { useCallback, useLayoutEffect, useRef } from 'react';

export interface ViewScrollLeft {
  /** Re-applies the position (after a resize, being shown again, or a scroll by something else). Reads layout. */
  sync: () => void;
  /**
   * The scroller's scroll event handler. A position the hook did not write (seen at once, or from an idle callback
   * when the event answered one of its writes) goes to `external(scrollLeft)`, or without one is put back.
   */
  onScroll: () => void;
}

export function useViewScrollLeft(
  ref: React.RefObject<HTMLElement>, base: number, contentPx: number, clientW: number, external?: (scrollLeft: number) => void,
): ViewScrollLeft {
  const st = useRef({ set: NaN, want: base, contentPx: 0, clientW: 0, writtenW: -1, echo: false, idle: 0 });
  const externalRef = useRef(external);
  externalRef.current = external;
  st.current.want = base;
  {
    // Render-time write against the committed geometry (what the scroller can hold right now).
    const c = st.current; const el = ref.current;
    if (el && c.set !== base && base <= c.contentPx - c.clientW) { el.scrollLeft = base; c.set = base; c.echo = true; }
  }
  useLayoutEffect(() => {
    const c = st.current; const el = ref.current;
    c.contentPx = contentPx; c.clientW = clientW;
    if (!el || (c.set === base && c.writtenW === clientW)) return;
    if (c.set !== base) c.echo = true;
    el.scrollLeft = base; c.set = base; c.writtenW = clientW;
  }, [ref, base, contentPx, clientW]);
  useLayoutEffect(() => () => { const c = st.current; if (c.idle && typeof cancelIdleCallback === 'function') cancelIdleCallback(c.idle); c.idle = 0; }, []);
  const sync = useCallback(() => {
    const el = ref.current; const c = st.current; if (!el) return;
    if (Math.abs(el.scrollLeft - c.want) > 1) el.scrollLeft = c.want;
    c.set = c.want;
  }, [ref]);
  const check = useCallback(() => {
    const el = ref.current; const c = st.current; if (!el) return;
    const at = el.scrollLeft;
    if (Math.abs(at - c.want) <= 1) return;
    const ext = externalRef.current;
    if (!ext) { el.scrollLeft = c.want; c.set = c.want; return; }
    // Where the scroller is now: a render that follows this position writes nothing.
    c.set = at;
    ext(at);
  }, [ref]);
  const onScroll = useCallback(() => {
    const c = st.current;
    if (!c.echo) { check(); return; }
    c.echo = false;
    if (c.idle) return;
    if (typeof requestIdleCallback !== 'function') { check(); return; }
    c.idle = requestIdleCallback(() => { c.idle = 0; check(); });
  }, [check]);
  return { sync, onScroll };
}
