import React from 'react';
import {
  ArrowLeftRight, ChevronsLeftRight, Filter, Hand, Link, Magnet, MousePointer2, MoveHorizontal, Plus, Rows3, Scissors, UnfoldHorizontal, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import type { Rational } from '@shared/model';
import { useStore, filtersActive } from '@/state';
import type { Tool } from '@/state';
import { TimecodeField } from '@/components/ui/TimecodeField';
import { Slider } from '@/components/ui/Slider';
import { useTimelineUi } from './timelineStore';
import { frameToX, sliderToZoom, zoomAround, zoomToSlider } from './viewMath';

export const TOOLS: { id: Tool; key: string; icon: LucideIcon; label: string }[] = [
  { id: 'select', key: 'V', icon: MousePointer2, label: 'Selection Tool' },
  { id: 'track', key: 'A', icon: Rows3, label: 'Track Select Tool' },
  { id: 'ripple', key: 'B', icon: ChevronsLeftRight, label: 'Ripple Edit Tool' },
  { id: 'rolling', key: 'N', icon: ArrowLeftRight, label: 'Rolling Edit Tool' },
  { id: 'razor', key: 'C', icon: Scissors, label: 'Razor Tool' },
  { id: 'slip', key: 'Y', icon: MoveHorizontal, label: 'Slip Tool' },
  { id: 'slide', key: 'U', icon: UnfoldHorizontal, label: 'Slide Tool' },
  { id: 'hand', key: 'H', icon: Hand, label: 'Hand Tool' },
];

function PlayheadTimecode({ seqId, fps }: { seqId: string; fps: Rational }) {
  const playhead = useStore((s) => s.project.sequences[seqId]?.view.playhead ?? 0);
  return <TimecodeField value={playhead} fps={fps} min={0} onChange={(f) => useStore.getState().setView(seqId, { playhead: f })} title="Playhead (click to type, drag to scrub)" />;
}

export interface TimelineHeaderProps { seqId: string; fps: Rational; zoom: number; scroll: number; viewWidth: number }

export function TimelineHeader({ seqId, fps, zoom, scroll, viewWidth }: TimelineHeaderProps) {
  // Primitives only: useShallow compares array items with Object.is, so fresh objects would re-render forever.
  const order = useStore((s) => s.project.sequenceOrder);
  const names = useStore(useShallow((s) => s.project.sequenceOrder.map((id) => s.project.sequences[id]?.name ?? id)));
  const tabs = order.map((id, i) => ({ id, name: names[i] }));
  const tool = useStore((s) => s.ui.tool);
  const snapping = useStore((s) => s.project.settings.snapping);
  const filters = useStore((s) => s.ui.filters);
  const linked = useTimelineUi((s) => s.linkedSelection);
  const active = filtersActive(filters);

  const applyZoom = (newZoom: number) => {
    const st = useStore.getState();
    const seq = st.project.sequences[seqId];
    if (!seq) return;
    const phX = frameToX(seq.view.playhead, zoom, scroll);
    const anchorX = phX >= 0 && phX <= viewWidth ? phX : viewWidth / 2;
    st.setView(seqId, zoomAround(zoom, scroll, anchorX, newZoom));
  };

  return (
    <div className="toolbar tl-header">
      <div className="tl-seq-tabs" role="tablist">
        {tabs.map((t) => (
          <div key={t.id} role="tab" aria-selected={t.id === seqId} className={['tl-seq-tab', t.id === seqId ? 'active' : ''].join(' ')} title={t.name}
            data-seq-tab={t.id} onMouseDown={(e) => { if (e.button === 0 && t.id !== seqId) useStore.getState().setActiveSequence(t.id); }}>
            {t.name}
          </div>
        ))}
      </div>
      <div className="sep" />
      <PlayheadTimecode seqId={seqId} fps={fps} />
      <div className="sep" />
      <div className="tl-tools" role="toolbar" aria-label="Tools">
        {TOOLS.map((t) => {
          const Icon = t.icon;
          return (
            <button key={t.id} type="button" data-tool={t.id} aria-pressed={tool === t.id}
              className={['btn-icon', 'btn-sm', 'tl-tool', tool === t.id ? 'active' : ''].join(' ')} title={`${t.label} (${t.key})`}
              onClick={() => useStore.getState().setTool(t.id)}>
              <Icon /><span className="tl-tool-key">{t.key}</span>
            </button>
          );
        })}
      </div>
      <div className="sep" />
      <button type="button" className={['btn-icon', 'btn-sm', snapping ? 'toggled accent-2' : ''].join(' ')} title={`Snap (${snapping ? 'on' : 'off'}) — hold Alt to bypass`} aria-pressed={snapping}
        data-snapping onClick={() => useStore.getState().setSettings({ snapping: !snapping })}><Magnet /></button>
      <button type="button" className={['btn-icon', 'btn-sm', linked ? 'toggled' : ''].join(' ')} title={`Linked selection (${linked ? 'on' : 'off'}) — hold Alt to select one side`} aria-pressed={linked}
        data-linked onClick={() => useTimelineUi.getState().setLinkedSelection(!linked)}><Link /></button>
      <div className="sep" />
      <button type="button" className="btn btn-sm btn-ghost" title="Add video track" data-add-video onClick={() => useStore.getState().addTrack(seqId, 'video')}><Plus />V</button>
      <button type="button" className="btn btn-sm btn-ghost" title="Add audio track" data-add-audio onClick={() => useStore.getState().addTrack(seqId, 'audio')}><Plus />A</button>
      <div className="grow" />
      {active ? (
        <span className="tag accent tl-filter-chip" title={`Story filters active (${filters.mode}) — click to clear`} onClick={() => useStore.getState().clearFilters()}>
          <Filter size={10} /> filters: {filters.mode} <X size={9} />
        </span>
      ) : null}
      <div className="tl-zoom" title={`${zoom.toFixed(2)} px/frame`}>
        <button type="button" className="btn-icon btn-sm" title="Zoom out (-)" onClick={() => applyZoom(zoom / 1.25)}><ZoomOut /></button>
        <Slider value={zoomToSlider(zoom)} min={0} max={1} onChange={(t) => applyZoom(sliderToZoom(t))} title="Zoom" />
        <button type="button" className="btn-icon btn-sm" title="Zoom in (=)" onClick={() => applyZoom(zoom * 1.25)}><ZoomIn /></button>
      </div>
    </div>
  );
}
