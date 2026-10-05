/**
 * Story strip: story blocks over a compressed clip-density lane, markers and a playhead.
 * Has its own zoom/scroll (independent of the timeline). All geometry is frames * ppf (px per frame).
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Palette, StickyNote, Trash2 } from 'lucide-react';
import type { Sequence, StoryBlock } from '@shared/model';
import { clipEnd, sequenceDuration } from '@shared/timeline';
import { formatTimecode, fpsValue } from '@shared/time';
import { useStore, usePlayhead } from '@/state';
import { filterMatches, filtersActive } from '@/state/selectors';
import type { FilterState } from '@/state/types';
import { openContextMenu, type MenuItem } from '@/components/ui/ContextMenu';
import { ColorSwatchPicker, LABEL_COLORS } from '@/components/ui/ColorSwatch';
import { clipColor, clipsOverlapping, contrastText, formatHMS, formatMS, snapFrame, snapTargets, stripExtent } from './util';

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 64;
const RULER_H = 20;
const BLOCK_ROW_H = 22;
const DENSITY_ROW_H = 6;
const MARKER_H = 10;
const SNAP_PX = 7;
const HANDLE_PX = 6;

export interface StoryStripProps {
  seq: Sequence;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  palette: Map<string, string>;
  filters: FilterState;
  snapping: boolean;
  selectedBlockId: string | null;
  onSelectBlock: (id: string | null) => void;
  /** Drag on empty strip finished: ask for a name. */
  onCreateRange: (start: number, end: number) => void;
  /** Double-click / rename: open the editor dialog. */
  onEditBlock: (id: string) => void;
}

type DragMode = 'move' | 'resize-start' | 'resize-end' | 'create' | 'scrub';
interface Drag {
  mode: DragMode;
  pointerId: number;
  startX: number;
  startFrame: number;
  blockId?: string;
  origStart: number;
  origEnd: number;
  moved: boolean;
  transaction: boolean;
}

interface Popover { kind: 'color' | 'notes'; blockId: string; x: number; y: number }

/** Greedy row assignment so overlapping blocks stack instead of hiding each other. */
function assignRows(blocks: StoryBlock[]): Map<string, number> {
  const rows: number[] = []; // last end per row
  const out = new Map<string, number>();
  for (const b of [...blocks].sort((x, y) => x.start - y.start || y.end - x.end)) {
    let r = rows.findIndex((end) => end <= b.start);
    if (r < 0) { r = rows.length; rows.push(b.end); } else rows[r] = b.end;
    out.set(b.id, r);
  }
  return out;
}

export interface StripTick { frame: number; major: boolean; label?: string }

/** Ruler ticks over the whole strip ([0, extent] frames) at `ppf` px per frame. Pure (exported for tests). */
export function stripRulerTicks(ppf: number, fpsNum: number, extent: number, fps: Sequence['fps']): StripTick[] {
  if (!(ppf > 0) || !(fpsNum > 0) || !Number.isFinite(extent)) return [];
  const { major, minor } = rulerStep(ppf, fpsNum);
  const out: StripTick[] = [];
  const endSec = extent / fpsNum;
  // Index-based with a hard cap (each tick is a DOM node): an accumulating `s += minor` stops advancing at
  // huge magnitudes, and the strip spans the whole sequence, not just the visible part.
  const count = Math.min(Math.floor(endSec / minor) + 1, MAX_STRIP_TICKS);
  let prevFrame = -Infinity;
  for (let i = 0; i < count; i++) {
    const s = i * minor;
    const frame = Math.round(s * fpsNum);
    if (frame <= prevFrame) continue;
    prevFrame = frame;
    const isMajor = Math.abs(s / major - Math.round(s / major)) < 1e-6;
    out.push({ frame, major: isMajor, label: isMajor ? formatHMS(frame, fps) : undefined });
  }
  return out;
}

const MAX_STRIP_TICKS = 20_000;

function rulerStep(ppf: number, fps: number): { major: number; minor: number } {
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const minPx = 72;
  for (const s of candidates) if (s * fps * ppf >= minPx) return { major: s, minor: s / (s >= 60 ? 4 : 5) };
  // Beyond the table (very long sequences): keep doubling so labels stay >= minPx apart.
  let major = 7200;
  while (major * fps * ppf < minPx && Number.isFinite(major)) major *= 2;
  return { major, minor: major / 4 };
}

export function StoryStrip({ seq, zoom, onZoomChange, palette, filters, snapping, selectedBlockId, onSelectBlock, onCreateRange, onEditBlock }: StoryStripProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [preview, setPreview] = useState<{ start: number; end: number } | null>(null);
  const [popover, setPopover] = useState<Popover | null>(null);
  const drag = useRef<Drag | null>(null);
  const pendingAnchor = useRef<{ frame: number; px: number } | null>(null);

  const fps = seq.fps;
  const fpsNum = fpsValue(fps);
  const extent = useMemo(() => stripExtent(seq), [seq]);
  const ppf = width > 0 ? (width / extent) * zoom : 0;
  const innerW = Math.max(width, Math.round(extent * ppf));
  const durationF = sequenceDuration(seq);
  const rows = useMemo(() => assignRows(seq.storyBlocks), [seq.storyBlocks]);
  let maxRow = 0;
  for (const r of rows.values()) if (r > maxRow) maxRow = r; // no spread: block count is unbounded
  const rowCount = maxRow + 1;
  const blockLaneH = rowCount * BLOCK_ROW_H + 6;
  const trackCount = Math.max(1, seq.videoTracks.length);
  const densityH = trackCount * DENSITY_ROW_H + 4;
  const totalH = RULER_H + blockLaneH + densityH + MARKER_H;
  const targets = useMemo(() => snapTargets(seq), [seq]);
  const active = filtersActive(filters);

  // Measure.
  useEffect(() => {
    const el = outerRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Keep the anchor frame under the cursor after a zoom.
  useLayoutEffect(() => {
    const a = pendingAnchor.current; const el = outerRef.current;
    if (!a || !el || ppf <= 0) return;
    pendingAnchor.current = null;
    el.scrollLeft = Math.max(0, a.frame * ppf - a.px);
  }, [ppf]);

  // Wheel: Ctrl = zoom around the cursor, plain = horizontal scroll when zoomed in.
  useEffect(() => {
    const el = outerRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const frame = (el.scrollLeft + px) / Math.max(ppf, 1e-6);
        const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25;
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
        if (next !== zoom) { pendingAnchor.current = { frame, px }; onZoomChange(next); }
      } else if (zoom > 1 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoom, ppf, onZoomChange]);

  const frameAt = useCallback((clientX: number): number => {
    const inner = innerRef.current; if (!inner || ppf <= 0) return 0;
    const rect = inner.getBoundingClientRect();
    return (clientX - rect.left) / ppf;
  }, [ppf]);

  const snap = useCallback((frame: number, e: { altKey: boolean }): number => {
    const f = Math.round(frame);
    if (!snapping || e.altKey || ppf <= 0) return Math.max(0, f);
    return Math.max(0, snapFrame(f, targets, SNAP_PX / ppf));
  }, [snapping, targets, ppf]);

  const setPlayhead = useCallback((frame: number) => {
    useStore.getState().setView(seq.id, { playhead: Math.max(0, Math.round(frame)) });
  }, [seq.id]);

  const applyBlockClick = useCallback((b: StoryBlock) => {
    const st = useStore.getState();
    st.setView(seq.id, { inPoint: b.start, outPoint: b.end });
    st.select(clipsOverlapping(seq, b.start, b.end).map((c) => c.id));
    onSelectBlock(b.id);
  }, [seq, onSelectBlock]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || ppf <= 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('.sl-block-tools')) return;
    const handle = target.closest<HTMLElement>('[data-handle]');
    const blockEl = target.closest<HTMLElement>('[data-block]');
    const lane = target.closest<HTMLElement>('[data-lane]')?.dataset.lane;
    const frame = frameAt(e.clientX);
    const base: Omit<Drag, 'mode' | 'origStart' | 'origEnd'> = { pointerId: e.pointerId, startX: e.clientX, startFrame: frame, moved: false, transaction: false };
    setPopover(null);
    if (handle && blockEl) {
      const b = seq.storyBlocks.find((x) => x.id === blockEl.dataset.block);
      if (!b) return;
      drag.current = { ...base, mode: handle.dataset.handle === 'start' ? 'resize-start' : 'resize-end', blockId: b.id, origStart: b.start, origEnd: b.end };
    } else if (blockEl) {
      const b = seq.storyBlocks.find((x) => x.id === blockEl.dataset.block);
      if (!b) return;
      drag.current = { ...base, mode: 'move', blockId: b.id, origStart: b.start, origEnd: b.end };
    } else if (lane === 'blocks') {
      drag.current = { ...base, mode: 'create', origStart: frame, origEnd: frame };
    } else {
      drag.current = { ...base, mode: 'scrub', origStart: frame, origEnd: frame };
      setPlayhead(frame);
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const st = useStore.getState();
    const frame = frameAt(e.clientX);
    if (d.mode === 'scrub') { setPlayhead(frame); return; }
    if (d.mode === 'create') {
      const a = snap(d.startFrame, e), b = snap(frame, e);
      setPreview({ start: Math.min(a, b), end: Math.max(a, b) });
      return;
    }
    if (!d.transaction) { st.beginTransaction(); d.transaction = true; }
    const delta = frame - d.startFrame;
    const len = d.origEnd - d.origStart;
    let start = d.origStart, end = d.origEnd;
    if (d.mode === 'move') {
      // Snap whichever edge is closest to a target.
      const rawStart = Math.max(0, Math.round(d.origStart + delta));
      const sStart = snap(rawStart, e);
      const sEnd = snap(rawStart + len, e) - len;
      start = Math.abs(sStart - rawStart) <= Math.abs(sEnd - rawStart) ? sStart : Math.max(0, sEnd);
      end = start + len;
    } else if (d.mode === 'resize-start') {
      start = Math.min(d.origEnd - 1, snap(d.origStart + delta, e));
    } else {
      end = Math.max(d.origStart + 1, snap(d.origEnd + delta, e));
    }
    const id = d.blockId!;
    st.updateTransient((p) => {
      const b = p.sequences[seq.id]?.storyBlocks.find((x) => x.id === id);
      if (b) { b.start = start; b.end = end; }
    });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current; if (!d) return;
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(d.pointerId); } catch { /* ignore */ }
    const st = useStore.getState();
    if (d.mode === 'create') {
      const p = preview;
      setPreview(null);
      if (d.moved && p && p.end - p.start >= 1) onCreateRange(p.start, p.end);
      else if (!d.moved) { setPlayhead(d.startFrame); onSelectBlock(null); }
      return;
    }
    if (d.mode === 'scrub') return;
    if (d.transaction) {
      st.endTransaction(d.mode === 'move' ? 'Move story block' : 'Resize story block');
      // keep the block sorted position stable for the selection
      onSelectBlock(d.blockId ?? null);
    } else if (!d.moved && d.blockId) {
      const b = seq.storyBlocks.find((x) => x.id === d.blockId);
      if (b) applyBlockClick(b);
    }
  };

  const onPointerCancel = () => {
    const d = drag.current; if (!d) return;
    drag.current = null;
    if (d.transaction) useStore.getState().cancelTransaction();
    setPreview(null);
  };

  const blockMenu = (b: StoryBlock): MenuItem[] => {
    const st = useStore.getState();
    return [
      { heading: b.name },
      { label: 'Rename / edit…', onSelect: () => onEditBlock(b.id) },
      { label: 'Set In/Out to block', onSelect: () => applyBlockClick(b) },
      { label: 'Go to block start', onSelect: () => setPlayhead(b.start) },
      { separator: true },
      {
        label: 'Color',
        submenu: LABEL_COLORS.map((c) => ({ label: c.name, checked: c.hex.toLowerCase() === b.color.toLowerCase(), onSelect: () => st.updateStoryBlock(seq.id, b.id, { color: c.hex }) })),
      },
      { label: 'Snap to clip edges', onSelect: () => {
        const s = snapFrame(b.start, targets, Math.max(1, Math.round(fpsNum))), en = snapFrame(b.end, targets, Math.max(1, Math.round(fpsNum)));
        if (en > s) st.updateStoryBlock(seq.id, b.id, { start: s, end: en });
      } },
      { separator: true },
      { label: 'Delete block', onSelect: () => { st.removeStoryBlock(seq.id, b.id); if (selectedBlockId === b.id) onSelectBlock(null); } },
    ];
  };

  // Ruler ticks.
  const ticks = useMemo(() => stripRulerTicks(ppf, fpsNum, extent, fps), [ppf, fpsNum, extent, fps]);

  const selected = seq.storyBlocks.find((b) => b.id === selectedBlockId) ?? null;
  const inX = seq.view.inPoint !== null ? seq.view.inPoint * ppf : null;
  const outX = seq.view.outPoint !== null ? seq.view.outPoint * ppf : null;

  const openPopover = (kind: Popover['kind'], blockId: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setPopover((p) => (p && p.kind === kind && p.blockId === blockId ? null : { kind, blockId, x: r.left, y: r.bottom + 4 }));
  };

  return (
    <div className="sl-strip" ref={outerRef} style={{ height: totalH + 8 }} data-testid="story-strip">
      <div
        ref={innerRef}
        className="sl-strip-inner"
        style={{ width: innerW, height: totalH }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onDoubleClick={(e) => {
          const el = (e.target as HTMLElement).closest<HTMLElement>('[data-block]');
          if (el?.dataset.block) { e.preventDefault(); onEditBlock(el.dataset.block); }
        }}
        onContextMenu={(e) => {
          const el = (e.target as HTMLElement).closest<HTMLElement>('[data-block]');
          const b = el?.dataset.block ? seq.storyBlocks.find((x) => x.id === el.dataset.block) : undefined;
          if (!b) return;
          e.preventDefault();
          onSelectBlock(b.id);
          openContextMenu(blockMenu(b), e);
        }}
      >
        {/* ruler */}
        <div className="sl-lane sl-ruler" data-lane="ruler" style={{ top: 0, height: RULER_H }}>
          {inX !== null && outX !== null && outX > inX ? <div className="sl-inout" style={{ left: inX, width: outX - inX }} /> : null}
          {ticks.map((t) => (
            <div key={t.frame} className={`sl-tick ${t.major ? 'major' : ''}`} style={{ left: t.frame * ppf }}>
              {t.label ? <span>{t.label}</span> : null}
            </div>
          ))}
          {durationF > 0 ? <div className="sl-duration-end" style={{ left: durationF * ppf }} title={`Sequence end ${formatTimecode(durationF, fps)}`} /> : null}
        </div>

        {/* story blocks */}
        <div className="sl-lane sl-blocks" data-lane="blocks" style={{ top: RULER_H, height: blockLaneH }}>
          {ppf > 0 && durationF > 0 ? <div className="sl-blocks-runtime" style={{ width: durationF * ppf }} /> : null}
          {seq.storyBlocks.map((b) => {
            const left = b.start * ppf;
            const w = Math.max(2, (b.end - b.start) * ppf);
            const row = rows.get(b.id) ?? 0;
            const isSel = b.id === selectedBlockId;
            const txt = contrastText(b.color);
            return (
              <div
                key={b.id}
                className={`sl-block ${isSel ? 'selected' : ''}`}
                data-block={b.id}
                data-testid="story-block"
                title={`${b.name}\n${formatTimecode(b.start, fps)} – ${formatTimecode(b.end, fps)} (${formatMS(b.end - b.start, fps)})${b.notes ? `\n${b.notes}` : ''}`}
                style={{ left, width: w, top: 3 + row * BLOCK_ROW_H, height: BLOCK_ROW_H - 3, background: b.color, color: txt }}
              >
                <div className="sl-block-handle l" data-handle="start" data-block={b.id} style={{ width: HANDLE_PX }} />
                <span className="sl-block-name">{b.name}</span>
                {w > 90 ? <span className="sl-block-dur">{formatMS(b.end - b.start, fps)}</span> : null}
                {b.notes && w > 60 ? <StickyNote className="sl-block-noteicon" /> : null}
                <div className="sl-block-handle r" data-handle="end" data-block={b.id} style={{ width: HANDLE_PX }} />
              </div>
            );
          })}
          {preview ? (
            <div className="sl-block sl-block-preview" style={{ left: preview.start * ppf, width: Math.max(2, (preview.end - preview.start) * ppf), top: 3, height: BLOCK_ROW_H - 3 }}>
              <span className="sl-block-name">{formatMS(preview.end - preview.start, fps)}</span>
            </div>
          ) : null}
          {selected ? (
            <div
              className="sl-block-tools"
              style={{ left: Math.max(0, Math.min(innerW - 66, selected.end * ppf - 66)), top: 3 + (rows.get(selected.id) ?? 0) * BLOCK_ROW_H + BLOCK_ROW_H - 2 }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button type="button" className="sl-tool" title="Color" aria-label="Block color" onClick={(e) => openPopover('color', selected.id, e.currentTarget)}>
                <span className="sl-tool-swatch" style={{ background: selected.color }} /><Palette />
              </button>
              <button type="button" className={`sl-tool ${selected.notes ? 'has-notes' : ''}`} title="Notes" aria-label="Block notes" onClick={(e) => openPopover('notes', selected.id, e.currentTarget)}><StickyNote /></button>
              <button type="button" className="sl-tool danger" title="Delete block" aria-label="Delete block" onClick={() => { useStore.getState().removeStoryBlock(seq.id, selected.id); onSelectBlock(null); }}><Trash2 /></button>
            </div>
          ) : null}
        </div>

        {/* clip density */}
        <div className="sl-lane sl-density" data-lane="density" style={{ top: RULER_H + blockLaneH, height: densityH }}>
          {seq.videoTracks.map((t, i) => t.clips.map((c) => {
            const match = !active || filterMatches(c, filters);
            return (
              <div
                key={c.id}
                className={`sl-clip ${c.enabled ? '' : 'disabled'} ${match ? '' : 'dim'}`}
                title={`${c.name}${c.characters.length ? ` · ${c.characters.join(', ')}` : ''}\n${formatTimecode(c.start, fps)} – ${formatTimecode(clipEnd(c), fps)}${c.enabled ? '' : '\n(disabled)'}`}
                style={{ left: c.start * ppf, width: Math.max(1, c.duration * ppf - 1), top: 2 + (trackCount - 1 - i) * DENSITY_ROW_H, height: DENSITY_ROW_H - 1, background: clipColor(c, palette) }}
              />
            );
          }))}
        </div>

        {/* markers */}
        <div className="sl-lane sl-markers" data-lane="markers" style={{ top: RULER_H + blockLaneH + densityH, height: MARKER_H }}>
          {seq.markers.map((m) => (
            <div key={m.id} className={`sl-marker ${m.kind}`} title={`${m.name || m.kind} · ${formatTimecode(m.time, fps)}${m.note ? `\n${m.note}` : ''}`}
              style={{ left: m.time * ppf, width: Math.max(2, m.duration * ppf), background: m.color || 'var(--accent-2)' }} />
          ))}
        </div>

        {/* playhead */}
        {ppf > 0 ? (
          <StoryPlayhead seqId={seq.id} ppf={ppf} />
        ) : null}
      </div>

      {popover && selected && popover.blockId === selected.id ? (
        <BlockPopover popover={popover} block={selected} seqId={seq.id} onClose={() => setPopover(null)} />
      ) : null}
    </div>
  );
}

/** Only this line re-renders on playhead moves (the playhead is mutated in place; see setView). */
function StoryPlayhead({ seqId, ppf }: { seqId: string; ppf: number }) {
  const playhead = usePlayhead(seqId);
  return (
    <div className="sl-playhead" style={{ left: playhead * ppf }} data-testid="story-playhead">
      <div className="sl-playhead-head" />
    </div>
  );
}

function BlockPopover({ popover, block, seqId, onClose }: { popover: Popover; block: StoryBlock; seqId: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [notes, setNotes] = useState(block.notes);
  useEffect(() => { setNotes(block.notes); }, [block.id, block.notes]);
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey, true); };
  }, [onClose]);
  const x = Math.min(popover.x, window.innerWidth - 250);
  const y = Math.min(popover.y, window.innerHeight - 140);
  const commitNotes = () => { if (notes !== block.notes) useStore.getState().updateStoryBlock(seqId, block.id, { notes }); };
  return (
    <div ref={ref} className="sl-popover" style={{ left: x, top: y }} onKeyDown={(e) => e.stopPropagation()}>
      {popover.kind === 'color' ? (
        <div className="col gap-6">
          <div className="uppercase text-dim">Block color</div>
          <ColorSwatchPicker value={block.color} size="lg" onChange={(hex) => { useStore.getState().updateStoryBlock(seqId, block.id, { color: hex }); onClose(); }} />
        </div>
      ) : (
        <div className="col gap-6" style={{ width: 240 }}>
          <div className="uppercase text-dim">Notes · {block.name}</div>
          <textarea className="input" rows={4} value={notes} autoFocus placeholder="What happens in this block…"
            onChange={(e) => setNotes(e.target.value)} onBlur={commitNotes}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { commitNotes(); onClose(); } }} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => { commitNotes(); onClose(); }}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
