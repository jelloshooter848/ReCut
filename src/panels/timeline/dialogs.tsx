import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { Clip, Marker, MarkerKind, MediaItem, Rational, Track } from '@shared/model';
import { formatSequenceTimecode } from '@shared/time';
import { clipSourceOut } from '@shared/timeline';
import { useStore, mediaSourceTimecode, originalTimecode } from '@/state';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { NumberField } from '@/components/ui/NumberField';
import { Select } from '@/components/ui/Select';
import { TagInput } from '@/components/ui/TagInput';
import { TextField } from '@/components/ui/TextField';
import { Toggle } from '@/components/ui/Toggle';
import { ColorSwatchPicker } from '@/components/ui/ColorSwatch';

// ------------------------------------------------------------------ popover
export function Popover({ x, y, width = 270, onClose, children, title }: { x: number; y: number; width?: number; onClose: () => void; children: React.ReactNode; title?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(y + 8, window.innerHeight - r.height - 4)) });
  }, [x, y]);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true); };
  }, [onClose]);
  return (
    <div ref={ref} className="tl-popover" style={{ left: pos.x, top: pos.y, width }} onKeyDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      {title ? <div className="tl-popover-title">{title}</div> : null}
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ marker editor
const MARKER_KINDS: { value: MarkerKind; label: string }[] = [{ value: 'marker', label: 'Marker' }, { value: 'continuity', label: 'Continuity' }, { value: 'chapter', label: 'Chapter' }];
const CATEGORIES = ['wardrobe', 'prop', 'dialogue', 'music', 'lighting', 'source', 'other'].map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) }));

export function MarkerEditor({ seqId, marker, fps, x, y, onClose }: { seqId: string; marker: Marker; fps: Rational; x: number; y: number; onClose: () => void }) {
  const [name, setName] = useState(marker.name);
  const [note, setNote] = useState(marker.note);
  const patch = (p: Partial<Omit<Marker, 'id'>>) => useStore.getState().updateMarker(seqId, marker.id, p);
  const commitText = () => { if (name !== marker.name || note !== marker.note) patch({ name, note }); };
  return (
    <Popover x={x} y={y} onClose={() => { commitText(); onClose(); }} title={<><span className="grow">Marker</span><span className="mono text-dim text-xs">{formatSequenceTimecode(marker.time, fps)}</span></>}>
      <div className="tl-form-row"><label>Name</label><TextField value={name} onChange={setName} onCommit={() => commitText()} autoFocus selectOnFocus placeholder="Marker name" /></div>
      <div className="tl-form-row"><label>Note</label><textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} onBlur={commitText} /></div>
      <div className="tl-form-row"><label>Kind</label><Select size="sm" value={marker.kind} options={MARKER_KINDS} onChange={(v) => patch({ kind: v })} /></div>
      {marker.kind === 'continuity' ? (
        <>
          <div className="tl-form-row"><label>Category</label><Select size="sm" value={marker.category ?? 'other'} options={CATEGORIES} onChange={(v) => patch({ category: v })} /></div>
          <div className="tl-form-row"><label>Resolved</label><Toggle checked={!!marker.resolved} onChange={(v) => patch({ resolved: v })} /></div>
        </>
      ) : null}
      <div className="tl-form-row"><label>Color</label><ColorSwatchPicker value={marker.color} onChange={(hex) => patch({ color: hex })} /></div>
      <div className="tl-form-row"><label>Duration</label>
        <NumberField value={marker.duration} min={0} step={1} unit="f" onChange={() => { /* commit only */ }} onCommit={(v) => patch({ duration: Math.max(0, Math.round(v)) })} />
      </div>
      <div className="tl-form-actions">
        <Button size="sm" variant="danger" icon={Trash2} onClick={() => { useStore.getState().removeMarker(seqId, marker.id); onClose(); }}>Delete</Button>
        <Button size="sm" variant="primary" onClick={() => { commitText(); onClose(); }}>Done</Button>
      </div>
    </Popover>
  );
}

// ------------------------------------------------------------------ speed / duration
export function SpeedDialog({ seqId, clip, fps, onClose }: { seqId: string; clip: Clip; fps: Rational; onClose: () => void }) {
  const [pct, setPct] = useState(Math.round(clip.speed * 1000) / 10);
  const [ripple, setRipple] = useState(false);
  const newDur = Math.max(1, Math.round(clip.duration * clip.speed / Math.max(0.01, pct / 100)));
  const apply = () => { useStore.getState().setClipSpeed(seqId, clip.id, Math.max(0.01, pct / 100), { ripple }); onClose(); };
  return (
    <Dialog open title={`Speed / Duration — ${clip.name}`} onClose={onClose} width={360} onSubmit={apply}
      footer={<><Button size="sm" onClick={onClose}>Cancel</Button><Button size="sm" variant="primary" onClick={apply}>Apply</Button></>}>
      <div className="tl-form-row"><label>Speed</label><NumberField value={pct} min={1} max={1000} step={1} precision={1} unit="%" defaultValue={100} onChange={setPct} onCommit={setPct} /></div>
      <div className="tl-form-row"><label>Duration</label><span className="mono text-dim">{formatSequenceTimecode(clip.duration, fps)} → <span className="text-bright">{formatSequenceTimecode(newDur, fps)}</span></span></div>
      <div className="tl-form-row"><label>Ripple</label><Toggle checked={ripple} onChange={setRipple} label="Shift following clips" /></div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ rename
export function RenameDialog({ title, value, onClose, onCommit }: { title: string; value: string; onClose: () => void; onCommit: (v: string) => void }) {
  const [name, setName] = useState(value);
  const commit = () => { const v = name.trim(); if (v && v !== value) onCommit(v); onClose(); };
  return (
    <Dialog open title={title} onClose={onClose} width={360} onSubmit={commit}
      footer={<><Button size="sm" onClick={onClose}>Cancel</Button><Button size="sm" variant="primary" onClick={commit}>Rename</Button></>}>
      <TextField value={name} onChange={setName} autoFocus selectOnFocus data-testid="rename-input" />
    </Dialog>
  );
}

// ------------------------------------------------------------------ tags
export function TagsDialog({ seqId, clip, onClose }: { seqId: string; clip: Clip; onClose: () => void }) {
  const vocab = useStore((s) => s.project.tags);
  const [characters, setCharacters] = useState(clip.characters);
  const [plotlines, setPlotlines] = useState(clip.plotlines);
  const [locations, setLocations] = useState(clip.locations);
  const [tags, setTags] = useState(clip.tags);
  const apply = () => { useStore.getState().setClipTags(seqId, clip.id, { characters, plotlines, locations, tags }); onClose(); };
  return (
    <Dialog open title={`Tags — ${clip.name}`} onClose={onClose} width={420} onSubmit={apply}
      footer={<><Button size="sm" onClick={onClose}>Cancel</Button><Button size="sm" variant="primary" onClick={apply}>Apply</Button></>}>
      <div className="tl-form-row"><label>Characters</label><TagInput value={characters} onChange={setCharacters} suggestions={vocab.characters} placeholder="Add character…" /></div>
      <div className="tl-form-row"><label>Plotlines</label><TagInput value={plotlines} onChange={setPlotlines} suggestions={vocab.plotlines} placeholder="Add plotline…" /></div>
      <div className="tl-form-row"><label>Locations</label><TagInput value={locations} onChange={setLocations} suggestions={vocab.locations} placeholder="Add location…" /></div>
      <div className="tl-form-row"><label>Tags</label><TagInput value={tags} onChange={setTags} suggestions={[...vocab.custom, ...vocab.themes]} placeholder="Add tag…" /></div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ properties
export function PropertiesPopover({ clip, track, media, fps, playhead, x, y, onClose }: { clip: Clip; track: Track; media: MediaItem | undefined; fps: Rational; playhead: number; x: number; y: number; onClose: () => void }) {
  const atPlayhead = originalTimecode(clip, playhead, fps, media);
  const inside = playhead >= clip.start && playhead < clip.start + clip.duration;
  return (
    <Popover x={x} y={y} width={320} onClose={onClose} title={<span className="ellipsis">{clip.name}</span>}>
      <div className="tl-props">
        <span>Track</span><span>{track.name}</span>
        <span>Timeline</span><span>{formatSequenceTimecode(clip.start, fps)} – {formatSequenceTimecode(clip.start + clip.duration, fps)}</span>
        <span>Duration</span><span>{formatSequenceTimecode(clip.duration, fps)} ({clip.duration} f)</span>
        <span>Source</span><span>{mediaSourceTimecode(clip.sourceIn, media, fps)} – {mediaSourceTimecode(clipSourceOut(clip, fps), media, fps)}</span>
        {inside ? <><span>At playhead</span><span>{atPlayhead.sourceTimecode}</span></> : null}
        <span>Speed</span><span>{Math.round(clip.speed * 100)}%</span>
        <span>File</span><span title={media?.path}>{atPlayhead.fileName || '—'}</span>
        <span>Identity</span><span>{atPlayhead.identityLabel || '—'}</span>
        {clip.originLabel ? <><span>Origin</span><span>{clip.originLabel}</span></> : null}
        {clip.characters.length ? <><span>Characters</span><span>{clip.characters.join(', ')}</span></> : null}
        <span>State</span><span>{[clip.enabled ? 'enabled' : 'disabled', clip.linkId ? 'linked' : 'unlinked', media?.offline ? 'OFFLINE' : ''].filter(Boolean).join(' · ')}</span>
      </div>
    </Popover>
  );
}
