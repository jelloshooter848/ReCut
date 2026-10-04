/** Markers panel: every marker of the active sequence (markers, chapters, continuity notes). */
import React, { useMemo, useState } from 'react';
import { Bookmark, Check, Plus, Trash2 } from 'lucide-react';
import type { PanelProps } from '@/panels/registry';
import { useStore } from '@/state/store';
import { activeSequence } from '@/state/selectors';
import { formatTimecode } from '@shared/time';
import type { Marker, MarkerKind } from '@shared/model';
import { Select } from '@/components/ui/Select';
import { IconButton } from '@/components/ui/IconButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { TextField } from '@/components/ui/TextField';
import { ColorSwatchPicker } from '@/components/ui/ColorSwatch';
import { getTransport } from '@/app/transport';

type KindFilter = 'all' | MarkerKind;
const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: 'All kinds' }, { value: 'marker', label: 'Markers' }, { value: 'chapter', label: 'Chapters' }, { value: 'continuity', label: 'Continuity' },
];
const KIND_LABEL: Record<MarkerKind, string> = { marker: 'Marker', chapter: 'Chapter', continuity: 'Continuity' };
const EDIT_KINDS: { value: MarkerKind; label: string }[] = [{ value: 'marker', label: 'Marker' }, { value: 'chapter', label: 'Chapter' }, { value: 'continuity', label: 'Continuity' }];

function seekTo(seqId: string, frame: number): void {
  const t = getTransport('program');
  if (t) t.seekFrame(frame); else useStore.getState().setView(seqId, { playhead: frame });
}

function MarkerEditor({ seqId, marker, onDone }: { seqId: string; marker: Marker; onDone: () => void }) {
  const [name, setName] = useState(marker.name);
  const [note, setNote] = useState(marker.note);
  const [kind, setKind] = useState<MarkerKind>(marker.kind);
  const [category, setCategory] = useState(marker.category ?? '');
  const [color, setColor] = useState(marker.color);
  const save = () => {
    useStore.getState().updateMarker(seqId, marker.id, { name: name.trim() || marker.name, note, kind, color, category: kind === 'continuity' ? (category.trim() || 'other') : undefined });
    onDone();
  };
  return (
    <form className="col" style={{ gap: 6, padding: '6px 8px', background: 'var(--bg-2)', borderBottom: '1px solid var(--border)' }} data-testid="marker-editor"
      onSubmit={(e) => { e.preventDefault(); save(); }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDone(); } }}>
      <div className="row" style={{ gap: 6 }}>
        <TextField autoFocus selectOnFocus size="sm" value={name} onChange={setName} placeholder="Name" className="grow" />
        <Select size="sm" value={kind} options={EDIT_KINDS} onChange={setKind} />
      </div>
      {kind === 'continuity' ? <TextField size="sm" value={category} onChange={setCategory} placeholder="Category (wardrobe, prop, dialogue, music…)" /> : null}
      <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note" />
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        <ColorSwatchPicker value={color} onChange={(hex) => setColor(hex)} />
        <span className="grow" />
        <button type="button" className="btn btn-sm" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn btn-sm btn-primary">Save</button>
      </div>
    </form>
  );
}

export function MarkersPanel(_props: PanelProps) {
  const seq = useStore((s) => activeSequence(s));
  const selectedId = useStore((s) => s.ui.selectedMarkerId);
  const [filter, setFilter] = useState<KindFilter>('all');
  const [editing, setEditing] = useState<string | null>(null);
  const markers = useMemo(() => {
    if (!seq) return [];
    const list = filter === 'all' ? seq.markers : seq.markers.filter((m) => m.kind === filter);
    return [...list].sort((a, b) => a.time - b.time);
  }, [seq, filter]);

  if (!seq) return <div className="panel"><EmptyState icon={Bookmark} title="No sequence" description="Create or open a sequence to see its markers." /></div>;
  const st = useStore.getState;
  const addAtPlayhead = () => {
    const id = st().addMarker(seq.id, { time: seq.view.playhead });
    if (id) { st().selectMarker(id); setEditing(id); }
  };
  const remove = (id: string) => { st().removeMarker(seq.id, id); if (editing === id) setEditing(null); };
  const counts = { all: seq.markers.length, marker: 0, chapter: 0, continuity: 0 } as Record<KindFilter, number>;
  for (const m of seq.markers) counts[m.kind]++;

  return (
    <div className="panel" data-testid="markers-panel">
      <div className="toolbar">
        <Select size="sm" value={filter} options={KIND_OPTIONS.map((o) => ({ ...o, label: `${o.label} (${counts[o.value]})` }))} onChange={setFilter} />
        <span className="grow" />
        <IconButton size="sm" icon={Plus} label="Add marker at playhead (M)" onClick={addAtPlayhead} data-testid="markers-add" />
        <IconButton size="sm" icon={Trash2} label="Delete selected marker" disabled={!selectedId} onClick={() => selectedId && remove(selectedId)} />
      </div>
      <div className="panel-body scroll-y">
        {markers.length === 0 ? (
          <EmptyState icon={Bookmark} title={filter === 'all' ? 'No markers yet' : `No ${KIND_LABEL[filter as MarkerKind].toLowerCase()} markers`}
            description="Press M on the timeline to add a marker at the playhead." />
        ) : (
          <div className="list">
            {markers.map((m) => (
              <React.Fragment key={m.id}>
                <div className={['list-item', m.id === selectedId ? 'selected' : ''].join(' ')} data-testid="marker-row" data-marker-id={m.id}
                  style={{ height: 'auto', minHeight: 'var(--control-h)', padding: '3px 8px', alignItems: 'flex-start' }}
                  onClick={() => { st().selectMarker(m.id); seekTo(seq.id, m.time); }}
                  onDoubleClick={() => { st().selectMarker(m.id); setEditing(m.id); }}
                  title={m.note || undefined}>
                  <span className="swatch" style={{ background: m.color, width: 8, height: 8, borderRadius: 2, marginTop: 5, flexShrink: 0 }} />
                  <span className="mono text-dim text-sm" style={{ width: 86, flexShrink: 0, marginTop: 2 }}>{formatTimecode(m.time, seq.fps)}</span>
                  <div className="col grow" style={{ minWidth: 0, gap: 1 }}>
                    <div className="row" style={{ gap: 6, minWidth: 0 }}>
                      <span className="ellipsis" style={{ textDecoration: m.resolved ? 'line-through' : undefined }}>{m.name}</span>
                      {m.duration > 0 ? <span className="text-faint text-xs">+{formatTimecode(m.duration, seq.fps)}</span> : null}
                    </div>
                    {m.note ? <div className="text-dim text-sm ellipsis">{m.note}</div> : null}
                  </div>
                  <span className="badge dim text-xs" style={{ flexShrink: 0, marginTop: 2 }}>{m.kind === 'continuity' && m.category ? m.category : KIND_LABEL[m.kind]}</span>
                  {m.kind === 'continuity' ? (
                    <button type="button" className={['btn-icon', 'btn-sm', m.resolved ? 'toggled' : ''].join(' ')} title={m.resolved ? 'Resolved — click to reopen' : 'Mark resolved'}
                      onClick={(e) => { e.stopPropagation(); st().resolveContinuity(seq.id, m.id, !m.resolved); }}><Check /></button>
                  ) : null}
                </div>
                {editing === m.id ? <MarkerEditor seqId={seq.id} marker={m} onDone={() => setEditing(null)} /> : null}
              </React.Fragment>
            ))}
          </div>
        )}
      </div>
      <div className="panel-footer">
        <span>{markers.length} of {seq.markers.length} marker{seq.markers.length === 1 ? '' : 's'}</span>
        <span className="grow" />
        <span className="text-faint">Double-click to edit</span>
      </div>
    </div>
  );
}
