/**
 * Timeline panel: Premiere-style sequence editor (header bar, track headers, ruler, virtualised clip lanes,
 * drag interactions, context menus, drop target for other panels).
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import type { Clip, ID, Marker, Sequence, Track, TransitionType } from '@shared/model';
import { formatSequenceSecondsTimecode, formatSequenceTimecode, fpsLabel, validFpsOr } from '@shared/time';
import { clipEnd, clipSourceOut, editPoints, findClip, removableDisabledClipIds, resolveSubtitleCues, sequenceDuration, sourceTimeAt } from '@shared/timeline';
import { useStore, filterMatches, filtersActive, usePlayhead } from '@/state';
import { hasClipDrag, readClipDrag } from '@/app/dnd';
import { openContextMenu, type MenuItem } from '@/components/ui/ContextMenu';
import { Splitter } from '@/components/ui/Splitter';
import { LABEL_COLORS } from '@/components/ui/ColorSwatch';
import { toast } from '@/components/ui/toastStore';
import { useLayoutStore } from '@/components/layout/layoutStore';
import { isEditableTarget } from '@/keyboard/useShortcuts';
import type { PanelProps } from '../registry';
import type { FilterLook } from './ClipView';
import { transitionSpan, TRANSITION_LABEL } from './TransitionView';
import { ClipLane } from './ClipLane';
import { Ruler } from './Ruler';
import { Playhead } from './Playhead';
import { useDevicePixelRatio } from './useDevicePixelRatio';
import { TrackHeader, SubtitleLaneHeader } from './TrackHeader';
import { TimelineHeader } from './TimelineHeader';
import { MarkerEditor, PropertiesPopover, RenameDialog, SpeedDialog, TagsDialog } from './dialogs';
import { useTimelineDrag, snapTargets, type InteractionCtx } from './interactions';
import { useTimelineUi } from './timelineStore';
import { useViewScrollLeft } from './scrollSync';
import { clipboardHasClips, copyClipsToClipboard, pasteClipboardAt } from '@/app/clipboard';
import { setTimelineViewportWidth } from '@/app/commands';
import { setActiveTransport } from '@/app/transport';
import { getShortcutLabel, runCommand } from '@/keyboard/shortcuts';
import { COMMAND_IDS } from '@/keyboard/commandIds';
import { maybeConformSequence, performSourceEdit } from '@/panels/source/insert';
import { linkedSyncOffsets, syncOffsetsByTrack } from './clipBadges';
import type { DialogState, DragPreview } from './types';
import { RULER_H } from './types';
import {
  frameToX, itemsInRange, layoutTracks, lodHit, minZoomFor, nextMountRange, prefetchMountRange, rowAtY, scrollContentFrames, snapFrame, snapThresholdFrames, splitScroll,
  xToFrame, xToFrameInt, zoomAround, zoomToFit, type MountRange, type TrackLayout,
} from './viewMath';

const DROP_GHOST_FRAMES = 48;
/** Clips within this many px outside the viewport are mounted too (rounding slack only). */
const MOUNT_SLACK_PX = 16;
/** Filmstrip / waveform ranges reach this many px past the viewport (prefetch for scrolling). */
const MEDIA_MARGIN_PX = 200;
/** Px an incremental scroll mounts ahead when it leaves the mounted range (more: rarer but longer remount steps). */
const MOUNT_AHEAD_PX = 256;
/**
 * Idle-time mounting ahead of an incremental scroll: when fewer than PREFETCH_LOW_PX of mounted range are left ahead
 * of the view in the scroll direction, an idle callback extends it to PREFETCH_AHEAD_PX ahead (and drops what is
 * behind the view), so the scroll steps that follow change no lane and the mounting runs between frames instead of
 * inside a step. A step that still leaves the mounted range (scrolling faster than idle time allows) mounts
 * synchronously as before (MOUNT_AHEAD_PX).
 */
const PREFETCH_LOW_PX = 160;
const PREFETCH_AHEAD_PX = 416;
/** Idle time (ms) an idle callback needs left to start mounting; with less it waits for the next idle period. */
const PREFETCH_MIN_IDLE_MS = 3;
/** Pixels per line / page for a wheel event in DOM_DELTA_LINE / DOM_DELTA_PAGE mode (as Chromium scrolls them). */
const WHEEL_LINE_PX = 40;

const cueStart = (c: { start: number }) => c.start;
const cueEnd = (c: { end: number }) => c.end;
const CUT_MENU_PX = 10;

export function TimelinePanel(props: PanelProps) {
  const seqId = useStore((s) => s.project.activeSequenceId);
  if (!seqId) return <div className="panel"><div className="panel-placeholder">No sequence — create one with Ctrl+Shift+N</div></div>;
  return <TimelineBody key={seqId} seqId={seqId} active={props.active} />;
}

function TimelineBody({ seqId, active }: { seqId: ID; active: boolean }) {
  const seq = useStore(useShallow((s) => {
    const q = s.project.sequences[seqId];
    return q ? {
      id: q.id, name: q.name, fps: q.fps, videoTracks: q.videoTracks, audioTracks: q.audioTracks, markers: q.markers, subtitleTracks: q.subtitleTracks,
      zoom: q.view.zoom, scroll: q.view.scroll, inPoint: q.view.inPoint, outPoint: q.view.outPoint,
    } : null;
  }));
  const tool = useStore((s) => s.ui.tool);
  const selectedIds = useStore((s) => s.ui.selectedClipIds);
  const selectedTransitionId = useStore((s) => s.ui.selectedTransitionId);
  const selectedMarkerId = useStore((s) => s.ui.selectedMarkerId);
  const filters = useStore((s) => s.ui.filters);
  const snapping = useStore((s) => s.project.settings.snapping);
  const showSourceTc = useStore((s) => s.project.settings.showSourceTimecodeOnClips);
  const linkedSelection = useTimelineUi((s) => s.linkedSelection);
  const headerWidth = useTimelineUi((s) => s.headerWidth);
  const liveHeights = useTimelineUi((s) => s.liveHeights);
  /** Waveform canvases and the playhead snap to device pixels. */
  const dpr = useDevicePixelRatio();

  const rootRef = useRef<HTMLDivElement>(null);
  const tracksColRef = useRef<HTMLDivElement>(null);
  /** The tracks scroller (vertical, scrolled by the user). */
  const scrollRef = useRef<HTMLDivElement>(null);
  /** The tracks content: pointer / drag handlers, and the horizontal scroller that shows view.scroll. */
  const areaRef = useRef<HTMLDivElement>(null);
  /** The viewport-aligned lane view inside it (sticky): x / y of pointer positions are measured against its box. */
  const contentRef = useRef<HTMLDivElement>(null);
  const headersScrollRef = useRef<HTMLDivElement>(null);
  const hscrollRef = useRef<HTMLDivElement>(null);
  const suppressFlip = useRef(false);
  const headerStart = useRef(headerWidth);
  const [width, setWidth] = useState(0);
  /**
   * Viewport x (CSS px) of the tracks column's left edge, the playhead layer's containing block: the playhead snaps
   * to the window's device pixel grid, which a zone split can put at a fractional device offset (e.g. x.5 at dpr 1.5).
   * Re-measured whenever the column is resized (which also covers header-width and zone-split changes) or dpr changes.
   */
  const [colLeft, setColLeft] = useState(0);
  /** Client width of the tracks content (the tracks column minus a vertical scrollbar). */
  const [viewW, setViewW] = useState(0);
  const mountRef = useRef<MountRange | null>(null);
  /** Direction (+1 / -1) of the last incremental scroll, 0 after a jump / zoom; the view it was computed from. */
  const scrollDirRef = useRef<{ dir: number; scrollPx: number; zoom: number; width: number }>({ dir: 0, scrollPx: NaN, zoom: NaN, width: NaN });
  const [, bumpMount] = useReducer((n: number) => n + 1, 0);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [drop, setDrop] = useState<Extract<DragPreview, { kind: 'drop' }> | null>(null);
  const [hasFocus, setHasFocus] = useState(false);

  // ---- geometry -----------------------------------------------------------------------------
  useLayoutEffect(() => {
    const el = tracksColRef.current; const sc = areaRef.current; if (!el || !sc) return;
    const measure = () => { setWidth(el.clientWidth); setViewW(sc.clientWidth); setColLeft(el.getBoundingClientRect().left); syncScrollLeft(); syncHScroll(); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el); ro.observe(sc);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (active) { setWidth(tracksColRef.current?.clientWidth ?? 0); setViewW(areaRef.current?.clientWidth ?? 0); syncScrollLeft(); syncHScroll(); } }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { const el = tracksColRef.current; if (el) setColLeft(el.getBoundingClientRect().left); }, [dpr, active, width]);
  // Let the global View › Zoom commands use the real viewport width.
  useEffect(() => { if (width > 0) setTimelineViewportWidth(width); }, [width]);

  const zoom = seq?.zoom ?? 4;
  const scroll = seq?.scroll ?? 0;
  const fps = seq?.fps ?? { num: 24000, den: 1001 };
  const scrollPx = scroll * zoom;
  const hasSubs = (seq?.subtitleTracks.length ?? 0) > 0;
  const layout: TrackLayout = useMemo(() => layoutTracks(seq?.videoTracks ?? [], seq?.audioTracks ?? [], { subtitleLane: hasSubs, heights: liveHeights }), [seq?.videoTracks, seq?.audioTracks, hasSubs, liveHeights]);
  const duration = useMemo(() => (seq ? sequenceDuration(seq as unknown as Sequence) : 0), [seq?.videoTracks, seq?.audioTracks]); // eslint-disable-line react-hooks/exhaustive-deps
  const visible = width / zoom;
  const contentFrames = scrollContentFrames(duration, scroll, visible);
  const contentPx = Math.ceil(contentFrames * zoom);
  const trackById = useMemo(() => { const m = new Map<ID, Track>(); for (const t of [...(seq?.videoTracks ?? []), ...(seq?.audioTracks ?? [])]) m.set(t.id, t); return m; }, [seq?.videoTracks, seq?.audioTracks]);
  const rowById = useMemo(() => new Map(layout.rows.map((r) => [r.id, r])), [layout]);
  const cues = useMemo(() => (seq && hasSubs ? resolveSubtitleCues(seq as unknown as Sequence) : []), [seq?.videoTracks, seq?.audioTracks, seq?.subtitleTracks, seq?.fps, hasSubs]); // eslint-disable-line react-hooks/exhaustive-deps
  const filterOn = filtersActive(filters);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const syncPrev = useRef<Map<ID, ReadonlyMap<ID, number>> | null>(null);
  const syncOffsets = useMemo(() => {
    const tracks = [...(seq?.videoTracks ?? []), ...(seq?.audioTracks ?? [])];
    return (syncPrev.current = syncOffsetsByTrack(tracks, linkedSyncOffsets(tracks, fps), syncPrev.current));
  }, [seq?.videoTracks, seq?.audioTracks, fps]); // eslint-disable-line react-hooks/exhaustive-deps
  const media = useStore((s) => s.project.media);
  const isOffline = useCallback((clip: Clip) => { const m = media[clip.mediaId]; return !m || !!m.offline; }, [media]);
  const lookFor = useCallback((clip: Clip): FilterLook => (!filterOn ? 'none' : filterMatches(clip, filters) ? 'none' : filters.mode === 'solo' ? 'hide' : 'dim'), [filterOn, filters]);
  const selectedLoc = useMemo(() => (seq && selectedIds.length ? findClip(seq as unknown as Sequence, selectedIds[0]) : undefined), [seq?.videoTracks, seq?.audioTracks, selectedIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const onRenameTrack = useCallback((trackId: ID) => setDialog({ kind: 'renameTrack', trackId }), []);
  const minZoom = minZoomFor(duration, width);
  const minZoomRef = useRef(minZoom);
  minZoomRef.current = minZoom;

  // ---- interactions ---------------------------------------------------------------------------
  const ctxRef = useRef<InteractionCtx>({ seqId, zoom, scroll, layout, tool, snapping, linkedSelection, contentEl: null });
  ctxRef.current = { seqId, zoom, scroll, layout, tool, snapping, linkedSelection, contentEl: contentRef.current };
  const drag = useTimelineDrag(ctxRef, suppressFlip);
  const preview = drag.preview;

  const setView = useCallback((patch: Parameters<ReturnType<typeof useStore.getState>['setView']>[1]) => useStore.getState().setView(seqId, patch), [seqId]);
  const fullSeq = () => useStore.getState().project.sequences[seqId];
  const snapCandidates = useCallback(() => { const s = fullSeq(); return s ? snapTargets(s) : []; }, [seqId]); // eslint-disable-line react-hooks/exhaustive-deps
  const focusPanel = (id: string) => { useStore.getState().setActivePanel(id); useLayoutStore.getState().focusPanel(id); };
  const doZoomToFit = useCallback(() => { const s = fullSeq(); if (!s || width <= 0) return; setView({ zoom: zoomToFit(Math.max(1, sequenceDuration(s)), width), scroll: 0 }); }, [width, setView]); // eslint-disable-line react-hooks/exhaustive-deps

  // Idle-time mounting ahead of an incremental scroll (see PREFETCH_LOW_PX). Checked after every commit; the callback
  // re-reads the latest mounted range, so a jump or zoom in between (direction 0) cancels it.
  const prefetchIdle = useRef(0);
  useEffect(() => {
    if (!scrollDirRef.current.dir || prefetchIdle.current || typeof requestIdleCallback !== 'function') return;
    const run = (deadline: IdleDeadline) => {
      prefetchIdle.current = 0;
      const m = mountRef.current; const dir = scrollDirRef.current.dir;
      if (!m || !dir) return;
      const next = prefetchMountRange(m, dir, MOUNT_SLACK_PX, PREFETCH_LOW_PX, PREFETCH_AHEAD_PX);
      if (!next) return;
      if (deadline.timeRemaining() < PREFETCH_MIN_IDLE_MS) { prefetchIdle.current = requestIdleCallback(run); return; }
      mountRef.current = next;
      flushSync(bumpMount);
      // Style + layout of the newly mounted clips now, in idle time, rather than in the next frame.
      void areaRef.current?.offsetWidth;
    };
    prefetchIdle.current = requestIdleCallback(run);
  });
  useEffect(() => () => { if (prefetchIdle.current) cancelIdleCallback(prefetchIdle.current); prefetchIdle.current = 0; }, []);
  // The tracks content is a horizontal scroller (bar hidden, opaque: composited) whose scroll offset shows view.scroll,
  // set from the store before paint. A scroll offset change of a composited scroller moves the clips without a
  // repaint, re-layout or re-layerization of the page, which a transform on the clip layer costs on every step. A
  // scroll offset holds whole device pixels: the clip layer's translateX supplies the rest (constant, usually 0, while
  // wheel steps move by whole pixels), so content sits exactly where translateX(-scrollPx) put it.
  // See useViewScrollLeft for when it is written.
  const split = splitScroll(scrollPx, window.devicePixelRatio || 1);
  // Any other scroll of it (e.g. drag-and-drop autoscroll at an edge) is undone: the horizontal offset belongs to the store.
  const areaScroll = useViewScrollLeft(areaRef, split.base, contentPx, viewW);
  const syncScrollLeft = areaScroll.sync;
  // Horizontal scrollbar <-> view.scroll. The scrollbar is written like the scrollers above (useViewScrollLeft: while
  // this renders, before the commit changes the DOM, so the write forces no layout of a page flip's new clips). Read
  // or written after the commit (a layout effect, or the next frame's animation callback, by when the next scrub step
  // has been committed), it forces a synchronous style + layout of the whole commit. A user scroll of it moves the view.
  const onUserHScroll = (scrollLeft: number) => {
    const st = useStore.getState(); const s = st.project.sequences[seqId]; if (!s) return;
    if (Math.abs(scrollLeft - s.view.scroll * s.view.zoom) <= 1) return;
    st.setView(seqId, { scroll: scrollLeft / s.view.zoom });
  };
  const hScroll = useViewScrollLeft(hscrollRef, Math.round(scrollPx), contentPx, width, onUserHScroll);
  const syncHScroll = hScroll.sync;
  const onVScroll = () => { if (headersScrollRef.current && scrollRef.current) headersScrollRef.current.scrollTop = scrollRef.current.scrollTop; };

  // Wheel: Ctrl = zoom around pointer, Shift / trackpad-x = horizontal scroll, otherwise native vertical scroll.
  useEffect(() => {
    const el = tracksColRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const st = useStore.getState(); const s = st.project.sequences[seqId]; if (!s) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const factor = Math.exp(-e.deltaY * 0.002);
        st.setView(seqId, zoomAround(s.view.zoom, s.view.scroll, e.clientX - r.left, s.view.zoom * factor, minZoomRef.current));
        return;
      }
      const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (horizontal) {
        e.preventDefault();
        const d = e.deltaX !== 0 && !e.shiftKey ? e.deltaX : e.deltaY;
        st.setView(seqId, { scroll: Math.max(0, s.view.scroll + d / s.view.zoom) });
        return;
      }
      // Vertical: native scrolling, except that the tracks content is a horizontal scroller (it shows view.scroll): a
      // wheel over it with some horizontal delta (trackpads) would scroll it sideways and latch the gesture to it, so
      // apply the vertical part to the tracks scroller. The ruler's marker layer is such a scroller too (and scrolled
      // nothing vertically): drop it there.
      const sc = scrollRef.current;
      if (e.deltaX !== 0 && sc && sc.contains(e.target as Node | null)) {
        e.preventDefault();
        sc.scrollTop += e.deltaY * (e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? sc.clientHeight : 1);
      } else if (e.deltaX !== 0 && (e.target as Element | null)?.closest?.('.tl-ruler-scroll')) e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [seqId]);

  // Hover timecode
  const onHover = (e: React.PointerEvent) => {
    const el = contentRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    useTimelineUi.getState().setHoverFrame(xToFrameInt(e.clientX - r.left, ctxRef.current.zoom, ctxRef.current.scroll));
  };

  // ---- match frame / marker editor requests --------------------------------------------------
  /** Premiere double-click: load the clip's media in the Source with In/Out = the clip's source range (E-17). */
  const openClipInSource = (clip: Clip) => {
    const st = useStore.getState();
    if (!st.project.media[clip.mediaId]) { toast('warn', 'Clip media is missing from the project'); return; }
    const ph = fullSeq()?.view.playhead ?? clip.start;
    const inside = ph >= clip.start && ph < clipEnd(clip);
    st.setSourceClip(clip.mediaId, sourceTimeAt(clip, inside ? ph : clip.start, fps));
    st.setSourceIn(clip.sourceIn);
    st.setSourceOut(clipSourceOut(clip, fps));
    focusPanel('source');
    setActiveTransport('source');
  };
  useEffect(() => {
    if (!active) return;
    useTimelineUi.getState().setMarkerEditorHost(1);
    return () => useTimelineUi.getState().setMarkerEditorHost(-1);
  }, [active]);
  const markerReq = useTimelineUi((s) => s.markerEditRequest);
  useEffect(() => {
    if (!markerReq || !active) return;
    useTimelineUi.getState().requestMarkerEdit(null);
    const s = fullSeq(); const m = s?.markers.find((x) => x.id === markerReq.markerId);
    const r = tracksColRef.current?.getBoundingClientRect();
    if (!s || !m || !r) return;
    const px = (m.time - s.view.scroll) * s.view.zoom;
    setDialog({ kind: 'marker', markerId: m.id, x: r.left + Math.max(0, Math.min(r.width - 20, px)), y: r.top + RULER_H });
  }, [markerReq, active]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- razor preview (UX-20) -------------------------------------------------------------------
  const [razorLine, setRazorLine] = useState<{ frame: number; top: number; height: number } | null>(null);
  const updateRazorLine = (e: React.PointerEvent) => {
    const ctx = ctxRef.current;
    if (ctx.tool !== 'razor') { if (razorLine) setRazorLine(null); return; }
    const el = contentRef.current; if (!el) return;
    const tgt = e.target as HTMLElement;
    const clipEl = tgt.closest<HTMLElement>('[data-clip-id]');
    const s = fullSeq();
    const lodTrack = !clipEl && tgt.closest('[data-lod-lane]') ? tgt.closest<HTMLElement>('[data-track-id]')?.dataset.trackId : undefined;
    const loc = !s ? undefined : clipEl ? findClip(s, clipEl.dataset.clipId!)
      : lodTrack ? lodHit(s, lodTrack, xToFrame(e.clientX - el.getBoundingClientRect().left, ctx.zoom, ctx.scroll), ctx.zoom) : undefined;
    const row = loc ? ctx.layout.rows.find((x) => x.id === loc.track.id) : undefined;
    if (!loc || !row || loc.track.locked || !s) { if (razorLine) setRazorLine(null); return; }
    const r = el.getBoundingClientRect();
    let f = Math.round(xToFrame(e.clientX - r.left, ctx.zoom, ctx.scroll));
    if (ctx.snapping && !e.altKey) f = snapFrame(f, snapTargets(s), snapThresholdFrames(ctx.zoom)).frame;
    if (f <= loc.clip.start || f >= clipEnd(loc.clip)) { if (razorLine) setRazorLine(null); return; }
    const next = e.shiftKey ? { frame: f, top: 0, height: ctx.layout.total } : { frame: f, top: row.top, height: row.height };
    if (!razorLine || razorLine.frame !== next.frame || razorLine.top !== next.top || razorLine.height !== next.height) setRazorLine(next);
  };
  useEffect(() => { if (tool !== 'razor') setRazorLine(null); }, [tool]);

  // ---- clipboard ------------------------------------------------------------------------------
  const copySelection = () => { const s = fullSeq(); if (!s) return 0; return copyClipsToClipboard(s, useStore.getState().ui.selectedClipIds); };
  const cutSelection = () => { if (copySelection()) useStore.getState().deleteSelected(seqId); };
  const pasteAtPlayhead = () => {
    const st = useStore.getState(); const s = st.project.sequences[seqId]; if (!s) return;
    const ids = pasteClipboardAt(s, s.view.playhead);
    if (ids.length) st.select(ids, 'set');
  };
  const selectAll = () => { const s = fullSeq(); if (!s) return; useStore.getState().select([...s.videoTracks, ...s.audioTracks].flatMap((t) => t.clips.map((c) => c.id)), 'set'); };

  // ---- keyboard -------------------------------------------------------------------------------
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isEditableTarget(e.target)) return;
    const st = useStore.getState();
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;
    if (k === 'Escape') {
      e.preventDefault();
      if (drag.dragging) { drag.cancel(); return; }
      if (dialog) { setDialog(null); return; }
      st.select([], 'clear'); st.selectTransition(null); st.selectMarker(null);
      return;
    }
    if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      if (e.shiftKey) st.rippleDeleteSelected(seqId);
      else if (st.ui.selectedTransitionId) st.removeTransition(seqId, st.ui.selectedTransitionId);
      else if (st.ui.selectedClipIds.length) st.deleteSelected(seqId);
      else if (st.ui.selectedMarkerId) st.removeMarker(seqId, st.ui.selectedMarkerId);
      return;
    }
    if (mod && !e.altKey && k.toLowerCase() === 'a') { e.preventDefault(); if (e.shiftKey) st.select([], 'clear'); else selectAll(); return; }
    if (mod && !e.altKey && !e.shiftKey && k.toLowerCase() === 'c') { e.preventDefault(); copySelection(); return; }
    if (mod && !e.altKey && !e.shiftKey && k.toLowerCase() === 'x') { e.preventDefault(); cutSelection(); return; }
    if (mod && !e.altKey && !e.shiftKey && k.toLowerCase() === 'v') { e.preventDefault(); pasteAtPlayhead(); return; }
    if (!mod && !e.altKey && !e.shiftKey && k.toLowerCase() === 'h') { e.preventDefault(); st.setTool('hand'); }
  };

  // ---- context menus --------------------------------------------------------------------------
  const transitionTypes = (track: Track): { type: TransitionType; label: string }[] => (track.kind === 'audio'
    ? [{ type: 'audioCrossfade', label: 'Audio Crossfade' }]
    : [{ type: 'crossDissolve', label: 'Cross Dissolve' }, { type: 'dipToBlack', label: 'Dip to Black' }]);
  const addTransitionItems = (track: Track, frame: number, prefix = ''): MenuItem[] => transitionTypes(track).map((t) => ({
    label: `${prefix}${t.label}`, onSelect: () => { if (!useStore.getState().addTransitionAtCut(seqId, track.id, frame, t.type)) toast('warn', 'No cut at that position'); },
  }));
  const addContinuityAt = (time: number, clip?: Clip, at?: { x: number; y: number }) => {
    const id = useStore.getState().addContinuityNote(seqId, { time, name: clip ? `Continuity: ${clip.name}` : 'Continuity note', note: '', clipId: clip?.id });
    if (id) { useStore.getState().selectMarker(id); if (at) setDialog({ kind: 'marker', markerId: id, x: at.x, y: at.y }); }
  };
  const addMarkerAt = (time: number, at?: { x: number; y: number }) => {
    const id = useStore.getState().addMarker(seqId, { time });
    if (id) { useStore.getState().selectMarker(id); if (at) setDialog({ kind: 'marker', markerId: id, x: at.x, y: at.y }); }
  };

  const clipMenu = (clip: Clip, track: Track, frame: number, px: number, at: { x: number; y: number }): MenuItem[] => {
    const st = useStore.getState();
    const s = st.project.sequences[seqId]!;
    const sel = st.ui.selectedClipIds;
    const ph = s.view.playhead;
    const inside = ph >= clip.start && ph < clipEnd(clip);
    const nearStart = Math.abs(px - clip.start * zoom) <= CUT_MENU_PX;
    const nearEnd = Math.abs(px - clipEnd(clip) * zoom) <= CUT_MENU_PX;
    const existing = track.transitions.find((t) => (nearStart && t.inClipId === clip.id) || (nearEnd && t.outClipId === clip.id));
    const cutItems: MenuItem[] = [];
    if ((nearStart || nearEnd) && !existing) cutItems.push({ heading: `Cut at ${formatSequenceTimecode(nearStart ? clip.start : clipEnd(clip), fps)}` }, ...addTransitionItems(track, nearStart ? clip.start : clipEnd(clip), 'Add '), { separator: true });
    else if (existing) cutItems.push(...transitionMenu(existing, track), { separator: true });
    const colorItems: MenuItem[] = [
      { label: 'None', checked: !clip.color, onSelect: () => st.setClipTags(seqId, clip.id, { color: undefined }) },
      ...LABEL_COLORS.map((c) => ({ label: c.name, checked: clip.color === c.hex, onSelect: () => st.setClipTags(seqId, clip.id, { color: c.hex }) })),
    ];
    return [
      { heading: clip.name },
      ...cutItems,
      { label: clip.enabled ? 'Disable' : 'Enable', shortcut: 'Shift+E', onSelect: () => st.setClipEnabled(seqId, clip.id, !clip.enabled) },
      ...(() => {
        const s = st.project.sequences[seqId];
        const n = s ? removableDisabledClipIds(s).length : 0;
        return n ? [{ label: `Remove Disabled Clips (${n})…`, onSelect: () => runCommand('sequence.removeDisabledClips') }] : [];
      })(),
      { label: clip.linkId ? 'Unlink' : 'Link', shortcut: 'Ctrl+L', disabled: !clip.linkId && sel.length < 2, onSelect: () => (clip.linkId ? st.unlinkSelected(seqId) : st.linkSelected(seqId)) },
      { label: 'Speed / Duration…', shortcut: getShortcutLabel('clip.speedDuration') || undefined, onSelect: () => setDialog({ kind: 'speed', clipId: clip.id }) },
      { label: 'Rename…', onSelect: () => setDialog({ kind: 'rename', clipId: clip.id }) },
      { label: 'Color Label', submenu: colorItems },
      { label: 'Tag…', onSelect: () => setDialog({ kind: 'tags', clipId: clip.id }) },
      { label: 'Add Transition', submenu: [
        { heading: 'At start' }, ...addTransitionItems(track, clip.start), { heading: 'At end' }, ...addTransitionItems(track, clipEnd(clip)),
      ] },
      { separator: true },
      { label: 'Add Continuity Note…', onSelect: () => addContinuityAt(inside ? ph : clip.start, clip, at) },
      { label: 'Add to Scene Library', onSelect: () => { if (st.sceneFromClip(seqId, clip.id)) toast('ok', `Added “${clip.name}” to the scene library`); } },
      { label: 'Reveal in Project', onSelect: () => { st.selectMedia([clip.mediaId], 'set'); focusPanel('project'); } },
      { label: 'Match Frame', shortcut: getShortcutLabel(COMMAND_IDS.matchFrame) || 'F', onSelect: () => { st.setSourceClip(clip.mediaId, sourceTimeAt(clip, inside ? ph : clip.start, fps)); focusPanel('source'); } },
      { separator: true },
      { label: 'Ripple Trim Start to Playhead', shortcut: getShortcutLabel(COMMAND_IDS.rippleTrimPrev) || 'Q', disabled: !(ph > clip.start && ph < clipEnd(clip)) || track.locked,
        onSelect: () => { if (!st.ui.selectedClipIds.includes(clip.id)) st.select([clip.id], 'set'); runCommand(COMMAND_IDS.rippleTrimPrev); } },
      { label: 'Ripple Trim End to Playhead', shortcut: getShortcutLabel(COMMAND_IDS.rippleTrimNext) || 'W', disabled: !(ph > clip.start && ph < clipEnd(clip)) || track.locked,
        onSelect: () => { if (!st.ui.selectedClipIds.includes(clip.id)) st.select([clip.id], 'set'); runCommand(COMMAND_IDS.rippleTrimNext); } },
      { separator: true },
      { label: 'Cut', shortcut: 'Ctrl+X', onSelect: cutSelection },
      { label: 'Copy', shortcut: 'Ctrl+C', onSelect: () => { copySelection(); } },
      { label: 'Paste', shortcut: 'Ctrl+V', disabled: !clipboardHasClips(), onSelect: pasteAtPlayhead },
      { separator: true },
      { label: 'Ripple Delete', shortcut: 'Shift+Del', onSelect: () => st.rippleDeleteSelected(seqId) },
      { label: 'Delete', shortcut: 'Del', onSelect: () => st.deleteSelected(seqId) },
      { separator: true },
      { label: 'Properties…', onSelect: () => setDialog({ kind: 'props', clipId: clip.id, x: at.x, y: at.y }) },
    ];
  };

  const transitionMenu = (tr: Track['transitions'][number], track: Track): MenuItem[] => {
    const st = useStore.getState();
    const clipsById = new Map(track.clips.map((c) => [c.id, c]));
    const span = transitionSpan(tr, clipsById, zoom);
    const retype = (type: TransitionType) => { if (!span) return; st.removeTransition(seqId, tr.id); st.addTransitionAtCut(seqId, track.id, span.anchor, type, tr.duration); };
    const setDur = (frames: number) => st.setTransitionDuration(seqId, tr.id, frames);
    return [
      { heading: `${TRANSITION_LABEL[tr.type]} · ${tr.duration} f` },
      ...transitionTypes(track).map((t) => ({ label: t.label, checked: tr.type === t.type, onSelect: () => retype(t.type) })),
      { label: 'Duration', submenu: [12, 24, 48, 72].map((f) => ({ label: `${f} frames (${formatSequenceTimecode(f, fps)})`, checked: tr.duration === f, onSelect: () => setDur(f) })) },
      { label: 'Remove', shortcut: 'Del', onSelect: () => st.removeTransition(seqId, tr.id) },
    ];
  };

  const emptyMenu = (track: Track | null, frame: number, at: { x: number; y: number }): MenuItem[] => {
    const st = useStore.getState();
    const items: MenuItem[] = [];
    if (track) {
      const nearest = editPoints(fullSeq()!, [track.id]).filter((f) => f > 0).sort((a, b) => Math.abs(a - frame) - Math.abs(b - frame))[0];
      if (nearest !== undefined && Math.abs(nearest - frame) * zoom <= CUT_MENU_PX && track.clips.some((c) => c.start === nearest || clipEnd(c) === nearest)) {
        items.push({ heading: `Cut at ${formatSequenceTimecode(nearest, fps)}` }, ...addTransitionItems(track, nearest, 'Add '), { separator: true });
      }
    }
    items.push(
      { label: 'Add Marker Here', onSelect: () => addMarkerAt(frame, at) },
      { label: 'Add Continuity Note Here…', onSelect: () => addContinuityAt(frame, undefined, at) },
      { separator: true },
      { label: 'Paste at Playhead', shortcut: 'Ctrl+V', disabled: !clipboardHasClips(), onSelect: pasteAtPlayhead },
      { label: 'Select All', shortcut: 'Ctrl+A', onSelect: selectAll },
      { separator: true },
      { label: 'Add Video Track', onSelect: () => st.addTrack(seqId, 'video') },
      { label: 'Add Audio Track', onSelect: () => st.addTrack(seqId, 'audio') },
      { separator: true },
      { label: 'Zoom to Fit', shortcut: '\\', onSelect: doZoomToFit },
    );
    return items;
  };

  const markerMenu = (m: Marker, at: { x: number; y: number }): MenuItem[] => [
    { heading: m.name || 'Marker' },
    { label: 'Edit…', onSelect: () => setDialog({ kind: 'marker', markerId: m.id, x: at.x, y: at.y }) },
    { label: 'Go to Marker', onSelect: () => setView({ playhead: m.time }) },
    ...(m.kind === 'continuity' ? [{ label: m.resolved ? 'Mark Unresolved' : 'Mark Resolved', onSelect: () => useStore.getState().resolveContinuity(seqId, m.id, !m.resolved) }] : []),
    { separator: true },
    { label: 'Delete Marker', onSelect: () => useStore.getState().removeMarker(seqId, m.id) },
  ];

  const onContentContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const target = e.target as HTMLElement;
    const el = contentRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const px = scrollPx + (e.clientX - r.left);
    const frame = xToFrameInt(e.clientX - r.left, zoom, scroll);
    const at = { x: e.clientX, y: e.clientY };
    const trEl = target.closest<HTMLElement>('[data-transition-id]');
    const clipEl = target.closest<HTMLElement>('[data-clip-id]');
    const trackId = target.closest<HTMLElement>('[data-track-id]')?.dataset.trackId ?? rowAtY(layout, e.clientY - r.top)?.id ?? null;
    const track = trackId ? trackById.get(trackId) ?? null : null;
    if (trEl && track) { const tr = track.transitions.find((t) => t.id === trEl.dataset.transitionId); if (tr) { openContextMenu(transitionMenu(tr, track), e); return; } }
    if (clipEl && track) { const clip = track.clips.find((c) => c.id === clipEl.dataset.clipId); if (clip) { openContextMenu(clipMenu(clip, track, frame, px, at), e); return; } }
    if (!clipEl && track && target.closest('[data-lod-lane]')) {
      const hit = lodHit({ videoTracks: [track], audioTracks: [] }, track.id, xToFrame(e.clientX - r.left, zoom, scroll), zoom);
      if (hit) { openContextMenu(clipMenu(hit.clip, track, frame, px, at), e); return; }
    }
    openContextMenu(emptyMenu(track, frame, at), e);
  };

  // ---- drop from other panels -----------------------------------------------------------------
  const dropTarget = (e: React.DragEvent) => {
    const el = contentRef.current!; const r = el.getBoundingClientRect();
    const x = e.clientX - r.left; const y = e.clientY - r.top;
    let frame = xToFrameInt(x, zoom, scroll);
    if (snapping && !e.altKey) frame = snapFrame(frame, snapCandidates(), snapThresholdFrames(zoom)).frame;
    return { row: rowAtY(layout, y), frame };
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!hasClipDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const { row, frame } = dropTarget(e);
    setDrop((d) => (d && d.trackId === (row?.id ?? null) && d.frame === frame && d.insert === e.ctrlKey ? d : { kind: 'drop', trackId: row?.id ?? null, frame, insert: e.ctrlKey }));
  };
  const onDragLeave = (e: React.DragEvent) => { if (!areaRef.current?.contains(e.relatedTarget as Node | null)) setDrop(null); };
  const onDrop = (e: React.DragEvent) => {
    setDrop(null);
    const payloads = readClipDrag(e.dataTransfer);
    if (!payloads?.length) return;
    e.preventDefault();
    const { row, frame } = dropTarget(e);
    const insertMode = e.ctrlKey;
    const st = useStore.getState();
    const valid = payloads.filter((p) => !!st.project.media[p.mediaId]);
    if (!valid.length) return;
    // Same edit path as `,` / `.` and the Source buttons (three-point resolution, conform prompt), at the drop frame.
    const run = () => {
      let at = frame;
      const created: ID[] = [];
      for (const p of valid) {
        const extra: NonNullable<Parameters<typeof st.insertFromSource>[1]['extra']> = {};
        if (p.name) extra.name = p.name;
        if (p.characters?.length) extra.characters = p.characters;
        if (p.tags?.length) extra.tags = p.tags;
        if (p.origin) extra.originLabel = p.origin;
        if (p.sceneRecordId) extra.sceneRecordId = p.sceneRecordId;
        const res = performSourceEdit({
          mode: insertMode ? 'insert' : 'overwrite', mediaId: p.mediaId, srcIn: p.in ?? null, srcOut: p.out ?? null, at,
          videoTrackId: row?.kind === 'video' ? row.id : undefined, audioTrackId: row?.kind === 'audio' ? row.id : undefined,
          includeVideo: p.includeVideo, includeAudio: p.includeAudio, extra, quiet: true,
        }, seqId);
        if (!res.ok || res.endFrame === null) continue;
        created.push(...res.clipIds);
        at = Math.max(at + 1, res.endFrame);
      }
      if (created.length) useStore.getState().select(created, 'set');
      else toast('warn', 'Could not place the clip here (target tracks locked?)');
      rootRef.current?.focus({ preventScroll: true });
    };
    const pending = maybeConformSequence(seqId, valid[0].mediaId);
    if (pending) void pending.then(run); else run();
  };

  // ---- focus -----------------------------------------------------------------------------------
  /** The Timeline drives the sequence: focusing / clicking it hands the transport keys to the Program side (E-01). */
  const claimTransport = () => {
    setActiveTransport('program');
    const st = useStore.getState();
    if (st.ui.activePanel !== 'timeline') st.setActivePanel('timeline');
  };
  const onFocus = () => { setHasFocus(true); useStore.getState().setTimelineFocus(true); claimTransport(); };
  const onBlur = (e: React.FocusEvent) => { if (!rootRef.current?.contains(e.relatedTarget as Node | null)) { setHasFocus(false); useStore.getState().setTimelineFocus(false); } };
  const focusSelf = (e: React.PointerEvent) => { claimTransport(); if (!isEditableTarget(e.target) && document.activeElement !== rootRef.current && !rootRef.current?.contains(document.activeElement as Node | null)) rootRef.current?.focus({ preventScroll: true }); };

  if (!seq) return <div className="panel"><div className="panel-placeholder">Sequence not found</div></div>;

  // ---- render helpers --------------------------------------------------------------------------
  // Clips are mounted for the viewport (anything in a margin is invisible, and a page flip would mount and paint the
  // margins too), kept while small scroll steps stay inside the mounted range and extended ahead when they leave it
  // (nextMountRange), or ahead of time in idle callbacks (prefetchMountRange): a wheel step then changes no lane, LOD
  // canvas or filmstrip range, only the scroll offset. The scroll direction is tracked for the latter. Their
  // filmstrip / waveform ranges extend MEDIA_MARGIN_PX past the mounted range (prefetch for scrolling).
  {
    const sd = scrollDirRef.current;
    if (sd.scrollPx !== scrollPx || sd.zoom !== zoom || sd.width !== width) {
      const incremental = sd.zoom === zoom && sd.width === width && Math.abs(scrollPx - sd.scrollPx) <= width / 2;
      scrollDirRef.current = { dir: incremental ? Math.sign(scrollPx - sd.scrollPx) : 0, scrollPx, zoom, width };
    }
  }
  const mount = (mountRef.current = nextMountRange(mountRef.current, scrollPx, width, zoom, MOUNT_SLACK_PX, MOUNT_AHEAD_PX));
  const mountX0 = mount.x0, mountX1 = mount.x1;
  const viewX0 = mountX0 - (MEDIA_MARGIN_PX - MOUNT_SLACK_PX), viewX1 = mountX1 + (MEDIA_MARGIN_PX - MOUNT_SLACK_PX);
  const lodOriginPx = Math.floor(mountX0), lodWidthPx = Math.ceil(mountX1) - lodOriginPx + 1;
  const previewTransition = preview?.kind === 'transition' ? preview : null;
  const dropRow = drop?.trackId ? rowById.get(drop.trackId) : undefined;
  const totalH = layout.total + 24;

  let tip: { x: number; y: number; text: string } | null = null;
  const ghosts: React.ReactNode[] = [];
  const pushGhost = (key: string, cls: string, trackId: ID, start: number, dur: number, label?: string) => {
    const row = rowById.get(trackId); if (!row) return;
    ghosts.push(<div key={key} className={`tl-ghost ${cls}`} style={{ left: start * zoom, top: row.top + 1, width: Math.max(2, dur * zoom), height: row.height - 2 }}>{label}</div>);
    if (!tip) tip = { x: start * zoom - scrollPx, y: row.top - 20, text: '' };
  };
  if (preview) {
    switch (preview.kind) {
      case 'move': for (const g of preview.ghosts) pushGhost(g.clipId, preview.insert ? 'insert' : '', g.trackId, g.start, g.duration, g.name); if (tip) (tip as { text: string }).text = preview.tip; if (preview.snapTarget !== null) ghosts.push(<div key="snap" className="tl-snapline" style={{ left: preview.snapTarget * zoom, top: 0, height: layout.total }} />); break;
      case 'trim': pushGhost('trim', `trim${preview.ripple ? ' ripple' : ''}`, preview.trackId, preview.start, preview.duration); if (tip) { (tip as { text: string }).text = preview.tip; (tip as { x: number }).x = (preview.edge === 'start' ? preview.start : preview.start + preview.duration) * zoom - scrollPx; } if (preview.snapTarget !== null) ghosts.push(<div key="snap" className="tl-snapline" style={{ left: preview.snapTarget * zoom, top: 0, height: layout.total }} />); break;
      case 'roll': { const row = rowById.get(preview.trackId); if (row) { ghosts.push(<div key="roll" className="tl-rollline" style={{ left: preview.frame * zoom - 1, top: row.top, height: row.height }} />); tip = { x: preview.frame * zoom - scrollPx, y: row.top - 20, text: preview.tip }; } break; }
      case 'slip': pushGhost('slip', 'trim', preview.trackId, preview.start, preview.duration); if (tip) (tip as { text: string }).text = preview.tip; break;
      case 'slide': pushGhost('slide', '', preview.trackId, preview.start, preview.duration); if (tip) (tip as { text: string }).text = preview.tip; break;
      case 'transition': { const row = rowById.get(preview.trackId); if (row) tip = { x: 0, y: row.top - 20, text: preview.tip }; break; }
      default: break;
    }
  }
  if (drop && dropRow) pushGhost('drop', `drop${drop.insert ? ' insert' : ''}`, dropRow.id, drop.frame, DROP_GHOST_FRAMES, drop.insert ? 'Insert' : 'Overwrite');
  if (tip) { const t = tip as { x: number; y: number; text: string }; t.x = Math.max(4, Math.min(width - 160, t.x)); if (t.y < 2) t.y = 4; if (!t.text) tip = null; }

  const selectedClip = selectedLoc;
  const dialogClip = dialog && 'clipId' in dialog ? findClip(seq as unknown as Sequence, dialog.clipId) : undefined;
  const dialogMarker = dialog?.kind === 'marker' ? seq.markers.find((m) => m.id === dialog.markerId) : undefined;
  const videoCount = seq.videoTracks.length, audioCount = seq.audioTracks.length;

  return (
    <div
      ref={rootRef} className={['panel', 'tl-root', hasFocus ? 'focused' : '', drag.dragging ? 'dragging' : ''].filter(Boolean).join(' ')}
      data-tool={tool} data-timeline tabIndex={0}
      onKeyDown={onKeyDown} onFocus={onFocus} onBlur={onBlur} onPointerDownCapture={focusSelf}
    >
      <TimelineHeader seqId={seqId} fps={fps} zoom={zoom} viewWidth={width} minZoom={minZoom} />

      <div className="tl-body">
        {/* ---- track headers ---- */}
        <div className="tl-headers" style={{ width: headerWidth }}>
          <div className="tl-corner"><span>{fpsLabel(fps)} fps</span><span className="grow" /><span>{formatSequenceTimecode(duration, fps)}</span></div>
          <div className="tl-headers-scroll" ref={headersScrollRef}>
            <div className="tl-headers-content" style={{ height: totalH }}>
              {hasSubs ? <SubtitleLaneHeader height={layout.subtitleLane} count={cues.length} /> : null}
              {layout.rows.map((row) => {
                const track = trackById.get(row.id)!;
                return <TrackHeader key={row.id} seqId={seqId} track={track} top={row.top} height={row.height} number={row.index + 1}
                  canRemove={(row.kind === 'video' ? videoCount : audioCount) > 1} onRename={onRenameTrack} />;
              })}
              <div className="tl-th-divider" style={{ top: layout.dividerTop, height: layout.rows.length ? layout.total - layout.dividerTop - layout.rows.filter((r) => r.kind === 'audio').reduce((a, r) => a + r.height, 0) : 0 }} />
            </div>
          </div>
          <div className="tl-headers-hscroll-pad" />
        </div>
        <Splitter direction="h" onDragStart={() => { headerStart.current = useTimelineUi.getState().headerWidth; }} onDrag={(d) => useTimelineUi.getState().setHeaderWidth(headerStart.current + d)} onDoubleClick={() => useTimelineUi.getState().setHeaderWidth(170)} />

        {/* ---- ruler + tracks ---- */}
        <div className="tl-tracks-col" ref={tracksColRef}>
          <Ruler
            seqId={seqId} fps={fps} zoom={zoom} scroll={scroll} width={width} contentPx={contentPx} mountX0={mountX0} mountX1={mountX1}
            markers={seq.markers} selectedMarkerId={selectedMarkerId}
            inPoint={seq.inPoint} outPoint={seq.outPoint} snapping={snapping} snapCandidates={snapCandidates}
            onMarkerEdit={(m, at) => setDialog({ kind: 'marker', markerId: m.id, x: at.x, y: at.y })}
            onMarkerMenu={(m, e) => { e.preventDefault(); openContextMenu(markerMenu(m, { x: e.clientX, y: e.clientY }), e); }}
            onContextMenu={(frame, e) => openContextMenu([
              { label: 'Add Marker Here', onSelect: () => addMarkerAt(frame, { x: e.clientX, y: e.clientY }) },
              { label: 'Add Continuity Note Here…', onSelect: () => addContinuityAt(frame, undefined, { x: e.clientX, y: e.clientY }) },
              { separator: true },
              { label: 'Set In Point Here', onSelect: () => setView({ inPoint: frame }) },
              { label: 'Set Out Point Here', onSelect: () => setView({ outPoint: frame }) },
              { label: 'Clear In / Out', disabled: seq.inPoint === null && seq.outPoint === null, onSelect: () => setView({ inPoint: null, outPoint: null }) },
              { separator: true },
              { label: 'Zoom to Fit', shortcut: '\\', onSelect: doZoomToFit },
            ], e)}
            onScrubStart={() => { suppressFlip.current = true; }} onScrubEnd={() => { suppressFlip.current = false; }}
          />
          <div className="tl-tracks-scroll" ref={scrollRef} onScroll={onVScroll}>
            <div
              ref={areaRef} className="tl-tracks-content" style={{ height: totalH }} onScroll={areaScroll.onScroll}
              onPointerDown={drag.onPointerDown} onPointerMove={(e) => { drag.onPointerMove(e); onHover(e); if (!drag.dragging) updateRazorLine(e); }} onPointerUp={drag.onPointerUp} onPointerCancel={drag.onPointerUp}
              onPointerLeave={() => { useTimelineUi.getState().setHoverFrame(null); if (razorLine) setRazorLine(null); }}
              onContextMenu={onContentContextMenu}
              onDragOver={onDragOver} onDragEnter={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
              onDoubleClick={(e) => {
                if (tool !== 'select') return;
                // Hit-test by position: pointer capture from the click-drag retargets dblclick to the content element.
                const el = contentRef.current; if (!el) return;
                const r = el.getBoundingClientRect();
                const row = rowAtY(layout, e.clientY - r.top);
                const track = row ? trackById.get(row.id) : undefined;
                const f = xToFrame(e.clientX - r.left, zoom, scroll);
                const clip = track?.clips.find((c) => c.start <= f && f < clipEnd(c));
                if (clip) openClipInSource(clip);
              }}
            >
              <div className="tl-tracks-inner" style={{ width: contentPx, height: totalH }}>
                {/* lane backgrounds: static (the view sticks to the scroller's left edge) */}
                <div ref={contentRef} className="tl-tracks-view" style={{ width: viewW, height: totalH }}>
                  {hasSubs ? <div className="tl-sub-lane" style={{ height: layout.subtitleLane }} /> : null}
                  {layout.rows.map((row) => {
                    const t = trackById.get(row.id)!;
                    return <div key={row.id} className={['tl-lane', row.kind, t.locked ? 'locked' : '', drop?.trackId === row.id ? 'drop' : ''].filter(Boolean).join(' ')} style={{ top: row.top, height: row.height }} />;
                  })}
                  <div className="tl-lane-divider" style={{ top: layout.dividerTop, height: 6 }} />
                </div>

                {/* scrolling layer (content coordinates, scrolled by the scroller) */}
                <div className="tl-layer" style={{ width: contentPx, transform: `translateX(${-split.frac}px)` }}>
                  {hasSubs ? itemsInRange(cues, Math.max(0, viewX0 / zoom), viewX1 / zoom, cueStart, cueEnd).map((c) => {
                    return (
                      <div key={c.id} className={['tl-cue', c.orphan ? 'orphan' : ''].filter(Boolean).join(' ')} style={{ left: c.start * zoom, width: Math.max(4, (c.end - c.start) * zoom) }} title={c.text}
                        onPointerDown={(e) => { e.stopPropagation(); if (e.button !== 0) return; const r = contentRef.current!.getBoundingClientRect(); setView({ playhead: xToFrameInt(e.clientX - r.left, zoom, scroll) }); }}
                        onDoubleClick={(e) => { e.stopPropagation(); focusPanel('subtitles'); }}>
                        {c.text}
                      </div>
                    );
                  }) : null}
                  {layout.rows.map((row) => {
                    const track = trackById.get(row.id)!;
                    return (
                      <ClipLane key={row.id} track={track} top={row.top} height={row.height} contentPx={contentPx} zoom={zoom} mountX0={mountX0} mountX1={mountX1} viewX0={viewX0} viewX1={viewX1}
                        selected={selectedSet} look={lookFor} offline={isOffline} media={media} fps={fps} showSourceTc={showSourceTc}
                        syncOffsets={syncOffsets.get(track.id)} previewTransition={previewTransition && previewTransition.trackId === track.id ? previewTransition : null}
                        selectedTransitionId={selectedTransitionId} lodOriginPx={lodOriginPx} lodWidthPx={lodWidthPx} dpr={dpr} />
                    );
                  })}
                  {ghosts}
                  {razorLine ? <div className="tl-razor-line" data-razor-preview style={{ left: razorLine.frame * zoom, top: razorLine.top, height: razorLine.height }} /> : null}
                </div>

                {/* static overlays (viewport-aligned like the lane view, above the layer) */}
                <div className="tl-tracks-view over" style={{ width: viewW, height: totalH }}>
                  {duration === 0 && !drop ? <div className="tl-empty-hint">Drag media from the Project, Source, Scenes or Transcript panels here — or press , / . to insert from the Source monitor</div> : null}
                  <div className="tl-overlay">
                    {preview?.kind === 'marquee' ? (
                      <div className="tl-marquee" style={{ left: Math.min(preview.x0, preview.x1), top: Math.min(preview.y0, preview.y1), width: Math.abs(preview.x1 - preview.x0), height: Math.abs(preview.y1 - preview.y0) }} />
                    ) : null}
                    {tip ? <div className="tl-drag-tip" style={{ left: (tip as { x: number }).x, top: (tip as { y: number }).y }}>{(tip as { text: string }).text}</div> : null}
                  </div>
                </div>
              </div>
            </div>
          </div>
          <Playhead seqId={seqId} zoom={zoom} scroll={scroll} width={width} dpr={dpr} originPx={colLeft} suppressFlip={suppressFlip} />
          <div className="tl-hscroll" ref={hscrollRef} onScroll={hScroll.onScroll}><div style={{ width: contentPx }} /></div>
        </div>
      </div>

      <StatusStrip name={seq.name} fps={fps} selectedClip={selectedClip?.clip} selectedCount={selectedIds.length} media={selectedClip ? media[selectedClip.clip.mediaId] : undefined} duration={duration} zoom={zoom} />

      {dialog?.kind === 'speed' && dialogClip ? <SpeedDialog seqId={seqId} clip={dialogClip.clip} fps={fps} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'rename' && dialogClip ? <RenameDialog title="Rename Clip" value={dialogClip.clip.name} onClose={() => setDialog(null)} onCommit={(v) => useStore.getState().setClipTags(seqId, dialogClip.clip.id, { name: v })} /> : null}
      {dialog?.kind === 'tags' && dialogClip ? <TagsDialog seqId={seqId} clip={dialogClip.clip} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'props' && dialogClip ? <LivePropertiesPopover seqId={seqId} clip={dialogClip.clip} track={dialogClip.track} media={media[dialogClip.clip.mediaId]} fps={fps} x={dialog.x} y={dialog.y} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'marker' && dialogMarker ? <MarkerEditor seqId={seqId} marker={dialogMarker} fps={fps} x={dialog.x} y={dialog.y} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'renameTrack' ? (() => { const t = trackById.get(dialog.trackId); return t ? <RenameDialog title="Rename Track" value={t.name} onClose={() => setDialog(null)} onCommit={(v) => useStore.getState().setTrackFlags(seqId, t.id, { name: v })} /> : null; })() : null}
    </div>
  );
}

/** Properties popover with a live "at playhead" readout: only this (open) popover subscribes to the playhead. */
function LivePropertiesPopover(p: Omit<React.ComponentProps<typeof PropertiesPopover>, 'playhead'> & { seqId: ID }) {
  const { seqId, ...rest } = p;
  const playhead = usePlayhead(seqId);
  return <PropertiesPopover {...rest} playhead={playhead} />;
}

function HoverTimecode({ fps }: { fps: { num: number; den: number } }) {
  const hover = useTimelineUi((s) => s.hoverFrame);
  return <span title="Timecode under the pointer">{hover === null ? '--:--:--:--' : formatSequenceTimecode(hover, fps)}</span>;
}

const StatusStrip = React.memo(function StatusStrip({ name, fps, selectedClip, selectedCount, media, duration, zoom }: {
  name: string; fps: { num: number; den: number }; selectedClip: Clip | undefined; selectedCount: number; media: ReturnType<typeof useStore.getState>['project']['media'][string] | undefined; duration: number; zoom: number;
}) {
  const mediaFps = validFpsOr(media?.probe?.video?.fps, fps);
  return (
    <div className="toolbar toolbar-bottom tl-status" data-status>
      {selectedClip ? (
        <>
          <span className="tl-status-name ellipsis" style={{ maxWidth: 220 }}>{selectedClip.name}</span>
          <span>src {formatSequenceSecondsTimecode(selectedClip.sourceIn, mediaFps)} – {formatSequenceSecondsTimecode(clipSourceOut(selectedClip, fps), mediaFps)}</span>
          <span>dur {formatSequenceTimecode(selectedClip.duration, fps)}</span>
          <span>@ {formatSequenceTimecode(selectedClip.start, fps)}</span>
          {selectedCount > 1 ? <span className="badge dim">+{selectedCount - 1}</span> : null}
        </>
      ) : (
        <><span className="tl-status-name">{name}</span><span>{formatSequenceTimecode(duration, fps)}</span></>
      )}
      <div className="grow" />
      <HoverTimecode fps={fps} />
      <span className="text-faint">{zoom >= 1 ? zoom.toFixed(1) : zoom.toFixed(2)} px/f</span>
    </div>
  );
});

export { frameToX, xToFrame };
