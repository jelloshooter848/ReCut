import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, GripVertical, MonitorPlay, Regex, Search, WholeWord } from 'lucide-react';
import { useStore } from '@/state';
import { IconButton, SearchField, Select, EmptyState } from '@/components/ui';
import { setClipDrag } from '@/app/dnd';
import { formatTimecode } from '../../../shared/time';
import {
  searchTranscript, scopeOptions, decodeScope, highlightSegments,
  type TranscriptIndex, type TranscriptMatch, type MediaGroup, type SearchScope,
} from '@/transcript/index';
import { VirtualList, type VirtualListHandle } from './VirtualList';
import { insertAtPlayhead, loadInSource, sourceTimecode } from './shared';

const ROW_H = 58;
const HEADER_H = 22;
const LIMIT = 1000;

type Row = { kind: 'header'; group: MediaGroup; key: string } | { kind: 'match'; match: TranscriptMatch; index: number; key: string };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = window.setTimeout(() => setV(value), ms); return () => window.clearTimeout(t); }, [value, ms]);
  return v;
}

export function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const segs = useMemo(() => highlightSegments(text, ranges), [text, ranges]);
  return <>{segs.map((s, i) => (s.hit ? <mark key={i} className="tr-hit">{s.text}</mark> : <React.Fragment key={i}>{s.text}</React.Fragment>))}</>;
}

export interface SearchTabProps { index: TranscriptIndex; active: boolean }

export function SearchTab({ index, active }: SearchTabProps) {
  const [query, setQuery] = useState('');
  const [scopeKey, setScopeKey] = useState('project');
  const [regex, setRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [selected, setSelected] = useState(-1);
  const listRef = useRef<VirtualListHandle>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const sourceMediaId = useStore((s) => s.ui.sourceClip?.mediaId ?? null);
  const activeSequenceId = useStore((s) => s.project.activeSequenceId);
  const sequences = useStore((s) => s.project.sequences);
  const media = useStore((s) => s.project.media);
  const seqFps = activeSequenceId ? sequences[activeSequenceId]?.fps : undefined;

  const options = useMemo(() => scopeOptions(index.project, { sourceMediaId, activeSequenceId }), [index, sourceMediaId, activeSequenceId]);
  const optionList = useMemo(() => options.map((o) => ({ value: o.key, label: o.label })), [options]);
  useEffect(() => { if (!options.some((o) => o.key === scopeKey)) setScopeKey('project'); }, [options, scopeKey]);
  const scope: SearchScope = useMemo(() => options.find((o) => o.key === scopeKey)?.scope ?? decodeScope(scopeKey), [options, scopeKey]);

  const debounced = useDebounced(query, 120);
  // Sequence scope depends on the timeline, which the memoized index does not track: search against the live
  // sequences then (and only then, so playhead moves do not re-run project-wide searches).
  const liveSequences = scope.kind === 'sequence' ? sequences : null;
  const result = useMemo(() => {
    const idx = liveSequences ? { ...index, project: { ...index.project, sequences: liveSequences } } : index;
    return searchTranscript(idx, debounced, scope, { limit: LIMIT, regex, wholeWord });
  }, [index, debounced, scope, regex, wholeWord, liveSequences]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let i = 0;
    for (const g of result.groups) {
      out.push({ kind: 'header', group: g, key: `h:${g.mediaId}` });
      for (const m of g.matches) { out.push({ kind: 'match', match: m, index: i, key: `m:${m.entry.cue.id}:${m.entry.trackId}` }); i++; }
    }
    return out;
  }, [result]);
  const matchRowIndex = useMemo(() => rows.map((r, i) => (r.kind === 'match' ? i : -1)).filter((i) => i >= 0), [rows]);

  // Reset the selection when the question changes; otherwise just keep it in range (results may shrink on edits).
  useEffect(() => { setSelected(result.matches.length ? 0 : -1); }, [debounced, scopeKey, regex, wholeWord]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setSelected((s) => (s >= result.matches.length ? result.matches.length - 1 : s)); }, [result.matches.length]);
  useEffect(() => { if (selected >= 0 && matchRowIndex[selected] !== undefined) listRef.current?.scrollToIndex(matchRowIndex[selected]); }, [selected, matchRowIndex]);
  // Focus the search box when the user switches to this panel/tab — not on mount, so launching the app with the
  // Transcript tab visible does not steal keyboard focus from the global single-key shortcuts.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) barRef.current?.querySelector('input')?.focus();
    wasActive.current = active;
  }, [active]);

  const load = useCallback((m: TranscriptMatch) => loadInSource(m.entry.mediaId, m.entry.cue.start, m.entry.cue.end), []);
  const insert = useCallback((m: TranscriptMatch) => insertAtPlayhead(m.entry.mediaId, m.entry.cue.start, m.entry.cue.end), []);
  const jumpTimeline = useCallback((m: TranscriptMatch) => {
    const hit = m.timeline?.[0];
    if (!hit) return;
    useStore.getState().setView(hit.sequenceId, { playhead: hit.frame });
    useStore.getState().select([hit.clipId], 'set');
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = result.matches.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!n) return;
      e.preventDefault(); e.stopPropagation();
      setSelected((s) => (e.key === 'ArrowDown' ? Math.min(n - 1, s + 1) : Math.max(0, s - 1)));
    } else if (e.key === 'Enter') {
      const m = result.matches[selected];
      if (!m) return;
      e.preventDefault(); e.stopPropagation();
      if (e.ctrlKey || e.metaKey) insert(m); else load(m);
    } else if (e.key === 'Escape' && !query) {
      (e.target as HTMLElement).blur();
    }
  };

  const renderRow = (row: Row) => {
    if (row.kind === 'header') {
      return (
        <div className="tr-group" title={row.group.mediaName}>
          <span className="ellipsis">{row.group.label}</span>
          <span className="tr-group-count">{row.group.matches.length}</span>
        </div>
      );
    }
    const m = row.match; const e = m.entry; const med = media[e.mediaId];
    const sel = row.index === selected;
    const tc = sourceTimecode(e.cue.start, med, seqFps);
    const hit = m.timeline?.[0];
    return (
      <div
        className={['tr-result', sel ? 'selected' : ''].filter(Boolean).join(' ')}
        data-testid="transcript-result" data-media-id={e.mediaId} data-cue-id={e.cue.id} data-start={e.cue.start} data-end={e.cue.end}
        onClick={() => { setSelected(row.index); load(m); }}
        onDoubleClick={() => insert(m)}
        draggable
        onDragStart={(ev) => setClipDrag(ev.dataTransfer, { mediaId: e.mediaId, in: e.cue.start, out: e.cue.end, name: e.cue.text.replace(/\s+/g, ' ').slice(0, 60), origin: 'transcript' })}
      >
        <div className="tr-tc mono" title={`Source ${tc}`}>
          <span data-testid="transcript-result-tc">{tc}</span>
          {hit && seqFps ? <span className="tr-tl" title={`On timeline in "${hit.clipName}"${m.timeline!.length > 1 ? ` (+${m.timeline!.length - 1} more)` : ''}`} onClick={(ev) => { ev.stopPropagation(); jumpTimeline(m); }}>▸ {formatTimecode(hit.frame, seqFps)}</span> : null}
        </div>
        <div className="tr-body">
          <div className="tr-ctx ellipsis">{m.before}</div>
          <div className="tr-text ellipsis" title={e.cue.text} data-testid="transcript-result-text"><Highlighted text={e.cue.text} ranges={m.ranges} /></div>
          <div className="tr-ctx ellipsis">{m.after}</div>
        </div>
        <div className="tr-actions" onClick={(ev) => ev.stopPropagation()}>
          <IconButton size="sm" icon={MonitorPlay} label="Load in Source" shortcut="Enter" onClick={() => { setSelected(row.index); load(m); }} />
          <IconButton size="sm" icon={ArrowDownToLine} label="Insert at playhead" shortcut="Ctrl+Enter" onClick={() => insert(m)} />
          <span className="tr-grip" title="Drag to the timeline or Source"><GripVertical /></span>
        </div>
      </div>
    );
  };

  const count = result.total;
  const mediaCount = result.groups.length;
  return (
    <div className="tr-search col grow" onKeyDown={onKeyDown}>
      <div className="tr-bar" ref={barRef}>
        <SearchField size="sm" value={query} onChange={setQuery} placeholder="Search dialogue…" data-testid="transcript-search" />
        <IconButton size="sm" icon={Regex} label="Regular expression" toggled={regex} onClick={() => setRegex((v) => !v)} />
        <IconButton size="sm" icon={WholeWord} label="Whole word" toggled={wholeWord} onClick={() => setWholeWord((v) => !v)} />
      </div>
      <div className="tr-bar">
        <Select size="sm" className="grow" value={scopeKey} options={optionList} onChange={setScopeKey} data-testid="transcript-scope" title="Search scope" />
        <span className="tr-count text-dim nowrap" data-testid="transcript-count">
          {result.error ? <span className="text-danger" title={result.error}>Invalid pattern</span>
            : debounced.trim() ? `${count}${result.truncated ? '+' : ''} result${count === 1 ? '' : 's'} in ${mediaCount} media` : `${index.stats.cues} cues indexed`}
        </span>
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={Search}
          title={index.stats.cues === 0 ? 'No transcripts yet' : debounced.trim() ? 'No matches' : 'Search dialogue across the project'}
          description={index.stats.cues === 0 ? 'Import an .srt/.vtt for a media item (toolbar) to search its dialogue.' : debounced.trim() ? 'Try fewer words, a different scope, or turn off Whole word.' : 'Type words to match (all must appear), "a quoted phrase", or enable regex. Enter loads the line in the Source monitor; Ctrl+Enter inserts it at the playhead.'} />
      ) : (
        <VirtualList ref={listRef} className="tr-results grow" items={rows} itemKey={(r) => r.key} itemHeight={(r) => (r.kind === 'header' ? HEADER_H : ROW_H)} render={renderRow} tabIndex={0} data-testid="transcript-results" />
      )}
    </div>
  );
}
