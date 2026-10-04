/**
 * Storyline panel: higher-level structure view of the active sequence — story blocks over a clip-density strip,
 * a tag filter bar with what-if experiments, and a block table.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { BetweenHorizontalStart, Brackets, Map as MapIcon, Minus, Plus, Scan } from 'lucide-react';
import { sequenceDuration } from '@shared/timeline';
import { useStore, activeSequence } from '@/state';
import type { PanelProps } from '@/panels/registry';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { LABEL_COLORS } from '@/components/ui/ColorSwatch';
import { StoryStrip, MAX_ZOOM, MIN_ZOOM } from './StoryStrip';
import { FilterBar } from './FilterBar';
import { BlockTable } from './BlockTable';
import { BlockDialog, type BlockDialogState } from './BlockDialog';
import { characterPalette } from './util';
import './storyline.css';

export function StorylinePanel(_props: PanelProps) {
  const seq = useStore(activeSequence);
  const filters = useStore((s) => s.ui.filters);
  const selectedClipIds = useStore((s) => s.ui.selectedClipIds);
  const snapping = useStore((s) => s.project.settings.snapping);
  const [zoom, setZoom] = useState(1);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<BlockDialogState | null>(null);

  const palette = useMemo(() => (seq ? characterPalette(seq) : new Map<string, string>()), [seq]);
  const totalFrames = seq ? sequenceDuration(seq) : 0;
  const nextColor = LABEL_COLORS[(seq?.storyBlocks.length ?? 0) % LABEL_COLORS.length].hex;

  const inOut = seq && seq.view.inPoint !== null && seq.view.outPoint !== null && seq.view.outPoint > seq.view.inPoint
    ? { start: seq.view.inPoint, end: seq.view.outPoint } : null;
  const selectionSpan = useMemo(() => {
    if (!seq || !selectedClipIds.length) return null;
    const ids = new Set(selectedClipIds);
    let s = Infinity, e = -Infinity;
    for (const t of [...seq.videoTracks, ...seq.audioTracks]) for (const c of t.clips) if (ids.has(c.id)) { s = Math.min(s, c.start); e = Math.max(e, c.start + c.duration); }
    return Number.isFinite(s) && e > s ? { start: s, end: e } : null;
  }, [seq, selectedClipIds]);

  const openCreate = useCallback((start: number, end: number) => setDialog({ mode: 'create', start, end }), []);
  const openEdit = useCallback((id: string) => {
    const b = seq?.storyBlocks.find((x) => x.id === id);
    if (b) setDialog({ mode: 'edit', block: b });
  }, [seq]);
  const closeDialog = useCallback(() => setDialog(null), []);

  const submitDialog = (values: { name: string; color: string; notes: string }) => {
    if (!seq || !dialog) return;
    const st = useStore.getState();
    if (dialog.mode === 'create') {
      const id = st.addStoryBlock(seq.id, { ...values, start: dialog.start, end: dialog.end });
      if (id) setSelectedBlockId(id);
    } else {
      st.updateStoryBlock(seq.id, dialog.block.id, values);
    }
    setDialog(null);
  };

  const zoomTo = useCallback((z: number) => setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))), []);
  const selectedBlock = seq?.storyBlocks.find((b) => b.id === selectedBlockId) ? selectedBlockId : null;

  if (!seq) {
    return (
      <div className="panel storyline-panel">
        <EmptyState icon={MapIcon} title="No active sequence" description="Open or create a sequence to see its storyline." />
      </div>
    );
  }

  return (
    <div className="panel storyline-panel" data-testid="storyline-panel">
      <div className="toolbar">
        <Button size="sm" icon={Brackets} disabled={!inOut} data-testid="block-from-inout" title="Create a story block spanning the sequence In/Out range"
          onClick={() => inOut && openCreate(inOut.start, inOut.end)}>Block from In/Out</Button>
        <Button size="sm" icon={BetweenHorizontalStart} disabled={!selectionSpan} data-testid="block-from-selection" title="Create a story block spanning the selected clips"
          onClick={() => selectionSpan && openCreate(selectionSpan.start, selectionSpan.end)}>Block from Selection</Button>
        <span className="toolbar-sep" />
        <IconButton size="sm" icon={Minus} label="Zoom out" onClick={() => zoomTo(zoom / 1.5)} disabled={zoom <= MIN_ZOOM} />
        <span className="sl-zoom-label" title="Strip zoom (independent of the timeline). Ctrl+wheel to zoom at the cursor.">{zoom >= 10 ? `${Math.round(zoom)}×` : `${zoom.toFixed(1)}×`}</span>
        <IconButton size="sm" icon={Plus} label="Zoom in" onClick={() => zoomTo(zoom * 1.5)} disabled={zoom >= MAX_ZOOM} />
        <IconButton size="sm" icon={Scan} label="Fit to width" onClick={() => zoomTo(1)} disabled={zoom === 1} />
        <span className="toolbar-sep" />
        <span className="text-dim text-sm nowrap">{seq.storyBlocks.length} block{seq.storyBlocks.length === 1 ? '' : 's'}</span>
        <div className="sl-legend" data-testid="storyline-legend">
          {palette.size ? <span className="uppercase text-faint">Characters</span> : <span className="text-faint text-sm">Drag on the strip to create a block</span>}
          {[...palette.entries()].map(([name, color]) => (
            <span key={name} className="sl-legend-item" title={name}><span className="sl-dot" style={{ background: color }} />{name}</span>
          ))}
        </div>
      </div>

      <FilterBar seq={seq} filters={filters} palette={palette} />

      <StoryStrip
        seq={seq} zoom={zoom} onZoomChange={zoomTo} palette={palette} filters={filters} snapping={snapping}
        selectedBlockId={selectedBlock} onSelectBlock={setSelectedBlockId} onCreateRange={openCreate} onEditBlock={openEdit}
      />

      <div className="sl-table-wrap">
        {seq.storyBlocks.length ? (
          <BlockTable seq={seq} totalFrames={totalFrames} palette={palette} selectedBlockId={selectedBlock} onSelectBlock={setSelectedBlockId} onEditBlock={openEdit} />
        ) : (
          <div className="sl-empty">
            No story blocks yet.<br />
            Drag across the strip above, use <b>Block from In/Out</b>, or select clips and use <b>Block from Selection</b>.
          </div>
        )}
      </div>

      <BlockDialog state={dialog} fps={seq.fps} nextColor={nextColor} onClose={closeDialog} onSubmit={submitDialog} />
    </div>
  );
}
