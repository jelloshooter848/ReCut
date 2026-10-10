/**
 * Continuity panel: every marker of kind 'continuity' across all sequences, as a project-wide issue list.
 * Click jumps the timeline there; Space/checkbox resolves; double-click edits inline; "Copy as text" exports open issues.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, ClipboardCopy, Film, Plus, Trash2, X } from 'lucide-react';
import type { ID, Marker, Sequence } from '@shared/model';
import { formatSequenceTimecode } from '@shared/time';
import { findClip } from '@shared/timeline';
import type { PanelProps } from '@/panels/registry';
import { useStore } from '@/state';
import { Button, Dialog, EmptyState, IconButton, SearchField, Select, TextField, Toggle } from '@/components/ui';
import { toast } from '@/components/ui/toastStore';
import './continuity.css';

export const CONTINUITY_CATEGORIES = ['wardrobe', 'prop', 'dialogue', 'music', 'lighting', 'source', 'other'] as const;
export type ContinuityCategory = typeof CONTINUITY_CATEGORIES[number];
const CATEGORY_OPTIONS = CONTINUITY_CATEGORIES.map((c) => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1) }));

export interface IssueRow { seq: Sequence; marker: Marker; clipName: string | null; timecode: string }

function categoryOf(m: Marker): ContinuityCategory {
  const c = (m.category ?? 'other').toLowerCase();
  return (CONTINUITY_CATEGORIES as readonly string[]).includes(c) ? (c as ContinuityCategory) : 'other';
}

/** Open issues as plain text, grouped per sequence — handy for a fan editor's notes file. */
export function issuesAsText(rows: IssueRow[]): string {
  const lines: string[] = [];
  let lastSeq: ID | null = null;
  for (const r of rows) {
    if (r.seq.id !== lastSeq) { if (lines.length) lines.push(''); lines.push(`# ${r.seq.name}`); lastSeq = r.seq.id; }
    const cat = categoryOf(r.marker);
    const clip = r.clipName ? ` [${r.clipName}]` : '';
    const note = r.marker.note.trim() ? ` — ${r.marker.note.trim().replace(/\s*\n\s*/g, ' / ')}` : '';
    lines.push(`- ${r.timecode}  (${cat}) ${r.marker.name}${clip}${note}`);
  }
  return lines.join('\n');
}

/** Issue rows of one sequence, cached per sequence object: an edit rebuilds only the sequence it touched. */
const rowsCache = new WeakMap<Sequence, IssueRow[]>();
function sequenceRows(seq: Sequence): IssueRow[] {
  let rows = rowsCache.get(seq);
  if (rows) return rows;
  rows = [];
  const ms = seq.markers.filter((m) => m.kind === 'continuity').sort((a, b) => a.time - b.time);
  for (const m of ms) {
    const clip = m.clipId ? findClip(seq, m.clipId)?.clip : undefined;
    rows.push({ seq, marker: m, clipName: clip?.name ?? null, timecode: formatSequenceTimecode(m.time, seq.fps) });
  }
  rowsCache.set(seq, rows);
  return rows;
}

export function ContinuityPanel({ active }: PanelProps) {
  const sequences = useStore((s) => s.project.sequences);
  const order = useStore((s) => s.project.sequenceOrder);
  const activeSeqId = useStore((s) => s.project.activeSequenceId);
  const selectedMarkerId = useStore((s) => s.ui.selectedMarkerId);
  const selectedClipIds = useStore((s) => s.ui.selectedClipIds);

  const [seqScope, setSeqScope] = useState<'all' | 'active'>('all');
  const [category, setCategory] = useState<string>('');
  const [showResolved, setShowResolved] = useState(true);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<ID>>(() => new Set());
  const [editingId, setEditingId] = useState<ID | null>(null);
  const [focusedId, setFocusedId] = useState<ID | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const allRows = useMemo<IssueRow[]>(() => {
    const out: IssueRow[] = [];
    for (const id of order) {
      const seq = sequences[id];
      if (seq) for (const r of sequenceRows(seq)) out.push(r);
    }
    return out;
  }, [sequences, order]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allRows.filter((r) => {
      if (seqScope === 'active' && r.seq.id !== activeSeqId) return false;
      if (category && categoryOf(r.marker) !== category) return false;
      if (!showResolved && r.marker.resolved) return false;
      if (q && ![r.marker.name, r.marker.note, r.seq.name, r.clipName ?? '', categoryOf(r.marker), r.timecode].join('\n').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [allRows, seqScope, category, showResolved, query, activeSeqId]);

  const counts = useMemo(() => {
    const scoped = seqScope === 'active' ? allRows.filter((r) => r.seq.id === activeSeqId) : allRows;
    const resolved = scoped.filter((r) => r.marker.resolved).length;
    return { open: scoped.length - resolved, resolved, total: scoped.length };
  }, [allRows, seqScope, activeSeqId]);

  const activeSeq = activeSeqId ? sequences[activeSeqId] : undefined;
  const selectedClip = useMemo(() => (activeSeq && selectedClipIds[0] ? findClip(activeSeq, selectedClipIds[0])?.clip ?? null : null), [activeSeq, selectedClipIds]);

  // ---- actions
  const jumpTo = useCallback((r: IssueRow) => {
    const s = useStore.getState();
    if (s.project.activeSequenceId !== r.seq.id) s.setActiveSequence(r.seq.id);
    s.setView(r.seq.id, { playhead: r.marker.time });
    s.selectMarker(r.marker.id);
    if (r.marker.clipId && findClip(r.seq, r.marker.clipId)) s.select([r.marker.clipId], 'set');
    setFocusedId(r.marker.id);
  }, []);
  const toggleResolved = useCallback((r: IssueRow, value?: boolean) => {
    useStore.getState().resolveContinuity(r.seq.id, r.marker.id, value ?? !r.marker.resolved);
  }, []);
  const remove = useCallback((r: IssueRow) => {
    const s = useStore.getState();
    s.removeMarker(r.seq.id, r.marker.id);
    if (s.ui.selectedMarkerId === r.marker.id) s.selectMarker(null);
  }, []);
  const copyAsText = async () => {
    const open = rows.filter((r) => !r.marker.resolved);
    if (!open.length) { toast.info('No open continuity issues to copy'); return; }
    const text = issuesAsText(open);
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      toast.ok(`Copied ${open.length} open issue${open.length === 1 ? '' : 's'} to the clipboard`);
    } catch {
      toast.error('Could not access the clipboard');
    }
  };
  const toggleExpanded = useCallback((r: IssueRow) => setExpanded((e) => { const n = new Set(e); const id = r.marker.id; if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);
  const startEdit = useCallback((r: IssueRow) => { setFocusedId(r.marker.id); setEditingId(r.marker.id); }, []);
  const endEdit = useCallback(() => setEditingId(null), []);

  // Keep focus row valid.
  useEffect(() => { if (focusedId && !rows.some((r) => r.marker.id === focusedId)) setFocusedId(rows[0]?.marker.id ?? null); }, [rows, focusedId]);
  // Follow timeline marker selection.
  useEffect(() => { if (selectedMarkerId && rows.some((r) => r.marker.id === selectedMarkerId)) setFocusedId(selectedMarkerId); }, [selectedMarkerId, rows]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || editingId) return;
    const idx = rows.findIndex((r) => r.marker.id === focusedId);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!rows.length) return;
      e.preventDefault(); e.stopPropagation();
      const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx < 0 ? 0 : idx - 1);
      jumpTo(rows[next]);
      listRef.current?.querySelector<HTMLElement>(`[data-marker-id="${rows[next].marker.id}"]`)?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (idx < 0) return;
    if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); e.stopPropagation(); toggleResolved(rows[idx]); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); remove(rows[idx]); return; }
    if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); e.stopPropagation(); setEditingId(rows[idx].marker.id); return; }
    if (e.key === 'Escape') { setFocusedId(null); }
  };

  return (
    <div className="panel cty-panel" data-testid="continuity-panel" data-active={active} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="cty-toolbar">
        <SearchField value={query} onChange={setQuery} size="sm" placeholder="Search issues…" className="grow" data-testid="continuity-search" />
        <Button size="sm" icon={Plus} variant="primary" disabled={!activeSeq} title={activeSeq ? `Add a continuity note at the playhead of ${activeSeq.name}` : 'No active timeline'}
          onClick={() => setAddOpen(true)} data-testid="continuity-add">Add note at playhead</Button>
      </div>
      <div className="cty-toolbar">
        <Select size="sm" value={seqScope} onChange={(v) => setSeqScope(v as 'all' | 'active')} aria-label="Timeline scope"
          options={[{ value: 'all', label: 'All timelines' }, { value: 'active', label: activeSeq ? `Only: ${activeSeq.name}` : 'Active timeline' }]} className="cty-select" />
        <Select size="sm" value={category} onChange={setCategory} aria-label="Category" options={[{ value: '', label: 'Any category' }, ...CATEGORY_OPTIONS]} className="cty-select" />
        <Toggle checked={showResolved} onChange={setShowResolved} label={<span className="text-sm">Resolved</span>} title="Show resolved issues" />
      </div>

      <div className="panel-body cty-body" ref={listRef} onClick={(e) => { if (e.target === e.currentTarget) setFocusedId(null); }}>
        {allRows.length === 0 ? (
          <EmptyState icon={AlertTriangle} title="No continuity notes yet"
            description="Flag wardrobe, prop, dialogue or music mismatches at the playhead. Notes live on the timeline as continuity markers and show up here across all cuts."
            action={activeSeq ? <Button size="sm" icon={Plus} onClick={() => setAddOpen(true)}>Add note at playhead</Button> : undefined} />
        ) : rows.length === 0 ? (
          <EmptyState icon={Check} title={counts.open === 0 && !showResolved && !query && !category ? 'All issues resolved' : 'No issues match'}
            description={counts.resolved && !showResolved ? `${counts.resolved} resolved issue${counts.resolved === 1 ? '' : 's'} hidden.` : 'Try another filter or search.'} />
        ) : (
          <div className="list cty-list" role="listbox" aria-label="Continuity issues">
            {rows.map((r) => (
              <IssueRowView key={r.marker.id} row={r} focused={focusedId === r.marker.id} selected={selectedMarkerId === r.marker.id}
                expanded={expanded.has(r.marker.id)} editing={editingId === r.marker.id} showSequence={seqScope === 'all'}
                onJump={jumpTo} onToggle={toggleResolved} onRemove={remove} onExpand={toggleExpanded} onEdit={startEdit} onEndEdit={endEdit} />
            ))}
          </div>
        )}
      </div>

      <div className="panel-footer">
        <span data-testid="continuity-counts">
          <span className={counts.open ? 'text-accent-2' : 'text-ok'}><b>{counts.open}</b> open</span>
          <span className="text-faint"> · </span>
          <span><b>{counts.resolved}</b> resolved</span>
        </span>
        <span className="grow" />
        <Button size="sm" variant="ghost" icon={ClipboardCopy} onClick={() => void copyAsText()} title="Copy the open issues (with timecodes) as plain text" data-testid="continuity-copy">Copy as text</Button>
      </div>

      {activeSeq ? (
        <AddNoteDialog open={addOpen} seq={activeSeq} selectedClip={selectedClip ? { id: selectedClip.id, name: selectedClip.name } : null}
          onClose={() => setAddOpen(false)}
          onAdd={(input) => {
            const s = useStore.getState();
            const time = s.project.sequences[activeSeq.id]?.view.playhead ?? 0;
            const id = s.addContinuityNote(activeSeq.id, { time, ...input });
            setAddOpen(false);
            if (id) { s.selectMarker(id); setFocusedId(id); toast.ok(`Continuity note added at ${formatSequenceTimecode(time, activeSeq.fps)}`); }
          }} />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ row

interface RowProps {
  row: IssueRow; focused: boolean; selected: boolean; expanded: boolean; editing: boolean; showSequence: boolean;
  onJump: (r: IssueRow) => void; onToggle: (r: IssueRow, v: boolean) => void; onRemove: (r: IssueRow) => void;
  onExpand: (r: IssueRow) => void; onEdit: (r: IssueRow) => void; onEndEdit: () => void;
}

/** Memoized: props are the cached row plus flags and stable callbacks, so only changed rows re-render. */
const IssueRowView = React.memo(function IssueRowView({ row, focused, selected, expanded, editing, showSequence, onJump, onToggle, onRemove, onExpand, onEdit, onEndEdit }: RowProps) {
  const { marker: m, seq } = row;
  const cat = categoryOf(m);
  const hasNote = m.note.trim().length > 0;
  return (
    <div className={['cty-row', m.resolved ? 'resolved' : '', focused ? 'focused' : '', selected ? 'selected' : '', editing ? 'editing' : ''].filter(Boolean).join(' ')}
      data-marker-id={m.id} data-seq-id={seq.id} data-resolved={!!m.resolved} role="option" aria-selected={focused}
      onClick={() => { if (!editing) onJump(row); }} onDoubleClick={(e) => { e.preventDefault(); if (!editing) onEdit(row); }}>
      <input type="checkbox" className="cty-check" checked={!!m.resolved} aria-label={m.resolved ? 'Reopen issue' : 'Mark resolved'} title={m.resolved ? 'Reopen' : 'Mark resolved'}
        onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onChange={(e) => onToggle(row, e.target.checked)} />
      <div className="cty-main">
        {editing ? (
          <InlineEdit marker={m} seqId={seq.id} onDone={onEndEdit} />
        ) : (
          <>
            <div className="row gap-6 cty-line1">
              {showSequence ? <span className="cty-seq ellipsis" title={seq.name}>{seq.name}</span> : null}
              <span className="mono cty-tc">{row.timecode}</span>
              <span className={`cty-cat cty-cat-${cat}`}>{cat}</span>
              {row.clipName ? <span className="cty-clip ellipsis" title={`Linked clip: ${row.clipName}`}><Film size={10} />{row.clipName}</span> : null}
            </div>
            <div className="row gap-4 cty-line2">
              <span className="cty-name ellipsis" title={m.name}>{m.name || <span className="text-faint">Untitled</span>}</span>
              {hasNote ? (
                <button type="button" className="cty-expand" aria-label={expanded ? 'Collapse note' : 'Expand note'} aria-expanded={expanded}
                  onClick={(e) => { e.stopPropagation(); onExpand(row); }} onDoubleClick={(e) => e.stopPropagation()}>
                  {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                </button>
              ) : null}
              {hasNote && !expanded ? <span className="cty-note-preview ellipsis text-dim">{m.note.replace(/\s+/g, ' ')}</span> : null}
            </div>
            {hasNote && expanded ? <div className="cty-note selectable">{m.note}</div> : null}
          </>
        )}
      </div>
      {!editing ? <IconButton icon={Trash2} label="Delete issue" size="sm" className="cty-del" onClick={(e) => { e.stopPropagation(); onRemove(row); }} onDoubleClick={(e) => e.stopPropagation()} /> : null}
    </div>
  );
});

function InlineEdit({ marker, seqId, onDone }: { marker: Marker; seqId: ID; onDone: () => void }) {
  const [name, setName] = useState(marker.name);
  const [note, setNote] = useState(marker.note);
  const [cat, setCat] = useState<string>(categoryOf(marker));
  const save = () => { useStore.getState().updateMarker(seqId, marker.id, { name: name.trim() || marker.name, note, category: cat }); onDone(); };
  return (
    <div className="cty-edit" data-testid="continuity-inline-edit" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDone(); } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'TEXTAREA') { e.preventDefault(); e.stopPropagation(); save(); } }}>
      <div className="row gap-4">
        <input className="input input-sm grow" value={name} autoFocus spellCheck={false} placeholder="Issue" onChange={(e) => setName(e.target.value)} aria-label="Issue name" />
        <Select size="sm" value={cat} onChange={setCat} options={CATEGORY_OPTIONS} aria-label="Category" />
      </div>
      <textarea className="input cty-edit-note" value={note} spellCheck={false} placeholder="What's wrong, and what should match?" onChange={(e) => setNote(e.target.value)} aria-label="Note" />
      <div className="row gap-4">
        <span className="grow" />
        <Button size="sm" icon={X} onClick={onDone}>Cancel</Button>
        <Button size="sm" variant="primary" icon={Check} onClick={save}>Save</Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ add dialog

interface AddInput { name: string; note: string; category: string; clipId?: ID }

function AddNoteDialog({ open, seq, selectedClip, onClose, onAdd }: { open: boolean; seq: Sequence; selectedClip: { id: ID; name: string } | null; onClose: () => void; onAdd: (i: AddInput) => void }) {
  // Only track the playhead while the dialog is open (the closed dialog must not re-render during playback).
  const playhead = useStore((s) => (open ? s.project.sequences[seq.id]?.view.playhead ?? 0 : 0));
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [category, setCategory] = useState<string>('other');
  const [link, setLink] = useState(true);
  useEffect(() => { if (open) { setName(''); setNote(''); setCategory('other'); setLink(true); } }, [open]);
  const submit = () => { if (!name.trim()) return; onAdd({ name: name.trim(), note, category, clipId: link && selectedClip ? selectedClip.id : undefined }); };
  return (
    <Dialog open={open} title={<span className="row gap-6"><AlertTriangle size={14} className="text-accent-2" />Continuity note at {formatSequenceTimecode(playhead, seq.fps)}</span>} onClose={onClose} width={420}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!name.trim()} onClick={submit} data-testid="continuity-dialog-add">Add note</Button>
      </>}>
      <form className="cty-dialog-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label htmlFor="cty-name">Issue</label>
        <TextField id="cty-name" value={name} onChange={setName} autoFocus placeholder="e.g. Jacket zipped in the previous shot" data-testid="continuity-name" />
        <label htmlFor="cty-cat">Category</label>
        <Select id="cty-cat" value={category} onChange={setCategory} options={CATEGORY_OPTIONS} data-testid="continuity-category" />
        <label htmlFor="cty-note">Note</label>
        <textarea id="cty-note" className="input" value={note} spellCheck={false} placeholder="What's wrong and what it should match (shot, source timecode, cut to check)…"
          onChange={(e) => setNote(e.target.value)} data-testid="continuity-note" />
        <span />
        <label className="row gap-6 cty-link">
          <input type="checkbox" checked={link && !!selectedClip} disabled={!selectedClip} onChange={(e) => setLink(e.target.checked)} data-testid="continuity-link-clip" />
          <span className={selectedClip ? '' : 'text-faint'}>{selectedClip ? <>Link to selected clip <b className="ellipsis">{selectedClip.name}</b></> : 'Link to selected clip (select a clip in the timeline first)'}</span>
        </label>
        <span />
        <span className="text-faint text-xs">Timeline: {seq.name}</span>
      </form>
    </Dialog>
  );
}
