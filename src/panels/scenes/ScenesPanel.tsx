/**
 * Scene Library panel: a database view over project.scenes (SceneRecords = references into source media).
 * Rows/cards select, double-click loads in Source, drag feeds the Timeline, the context menu inserts at the playhead.
 */
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  ArrowDownAZ, ArrowUpAZ, Captions, ChevronDown, ChevronRight, Clapperboard, Copy, Film, LayoutGrid, List, ListOrdered, ListPlus, Palette, Pencil, Plus, Scissors, Star, Trash2, Wand2, Filter, X,
} from 'lucide-react';
import type { ID, MediaItem, SceneRecord } from '@shared/model';
import { formatSequenceSecondsTimecode } from '@shared/time';
import type { PanelProps } from '@/panels/registry';
import { useStore } from '@/state';
import { activeSequence, selectedClips } from '@/state/selectors';
import { Button, EmptyState, IconButton, LABEL_COLORS, SearchField, Select, labelColorHex, useContextMenu, type MenuItem } from '@/components/ui';
import { toast } from '@/components/ui/toastStore';
import { useLayoutStore } from '@/components/layout/layoutStore';
import {
  EMPTY_FILTERS, collectFacets, compareScenes, defaultSceneName, duplicateScene, durationLabel, filtersActive, groupScenes, importDetectedScenes,
  insertSceneAtPlayhead, insertScenesAtPlayhead, loadSceneInSource, matchesFilters, mediaFps, nameScenesFromTranscript, nextSequenceName, rangeLabel, sourceLabel, startSceneDrag,
  type GroupKey, type SceneFilters, type SortKey, type ViewMode,
} from './sceneUtils';
import { useThumb } from './useThumb';
import { NamePromptDialog, ConfirmDialog } from './NamePromptDialog';
import { RatingStars, SceneBatchEditor, SceneEditor } from './SceneEditor';
import { VirtualList, type VirtualListHandle } from '@/panels/transcript/VirtualList';
import './scenes.css';

/** Virtualised body rows (P-09): group headers, list rows, or grid rows of `cols` cards. Heights are fixed. */
type VRow =
  | { kind: 'head'; key: string; group: { key: string; label: string; count: number } }
  | { kind: 'row'; key: string; scene: SceneRecord }
  | { kind: 'cards'; key: string; scenes: SceneRecord[] };
const HEAD_H = 22;
const ROW_H = 58;
const ROW_CHIPS_H = 76;
const CARD_MIN_W = 150;
const GRID_GAP = 6;
const CARD_BODY_H = 70;
const hasChips = (s: SceneRecord) => !!(s.characters.length || s.location || s.arc || s.tags.length);

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'name', label: 'Name' }, { value: 'source', label: 'Source' }, { value: 'rating', label: 'Rating' }, { value: 'created', label: 'Created' }, { value: 'duration', label: 'Duration' },
];
const GROUP_OPTIONS: { value: GroupKey; label: string }[] = [
  { value: 'none', label: 'Ungrouped' }, { value: 'media', label: 'Group: Movie / episode' }, { value: 'character', label: 'Group: Character' }, { value: 'arc', label: 'Group: Arc' }, { value: 'location', label: 'Group: Location' },
];

type Prompt = { kind: 'source'; initial: string } | { kind: 'clip'; seqId: ID; clipId: ID; initial: string } | null;

export function ScenesPanel({ active }: PanelProps) {
  const scenesMap = useStore((s) => s.project.scenes);
  const media = useStore((s) => s.project.media);
  const selectedIds = useStore((s) => s.ui.selectedSceneIds);
  // Narrow selectors: the Source clip's playback time and the timeline selection must not re-render the library.
  const sourceClip = useStore(useShallow((s) => (s.ui.sourceClip
    ? { mediaId: s.ui.sourceClip.mediaId, inPoint: s.ui.sourceClip.inPoint, outPoint: s.ui.sourceClip.outPoint } : null)));
  const hasSelectedClip = useStore((s) => s.ui.selectedClipIds.length > 0);
  const selectedMediaIds = useStore((s) => s.ui.selectedMediaIds);
  const activeSeqId = useStore((s) => s.project.activeSequenceId);

  const [filters, setFilters] = useState<SceneFilters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('source');
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [view, setView] = useState<ViewMode>('list');
  const [groupBy, setGroupBy] = useState<GroupKey>('none');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [editorOpen, setEditorOpen] = useState(false);
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [confirmDelete, setConfirmDelete] = useState<ID[] | null>(null);
  /** Scenes for a new sequence (Make Sequence…), in list order. */
  const [seqPrompt, setSeqPrompt] = useState<ID[] | null>(null);
  const anchorRef = useRef<ID | null>(null);
  const listRef = useRef<VirtualListHandle>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyW, setBodyW] = useState(0);
  useLayoutEffect(() => {
    const el = bodyRef.current; if (!el) return;
    const measure = () => setBodyW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const menu = useContextMenu();

  const all = useMemo(() => Object.values(scenesMap), [scenesMap]);
  const facets = useMemo(() => collectFacets(all), [all]);
  const filtered = useMemo(
    () => all.filter((s) => matchesFilters(s, filters, media[s.mediaId])).sort((a, b) => compareScenes(a, b, sortKey, sortDir, media)),
    [all, filters, sortKey, sortDir, media],
  );
  const groups = useMemo(() => groupScenes(filtered, groupBy, media), [filtered, groupBy, media]);
  const visibleIds = useMemo(() => {
    const out: ID[] = [];
    for (const g of groups) if (!collapsed.has(g.key)) for (const s of g.scenes) if (!out.includes(s.id)) out.push(s.id);
    return out;
  }, [groups, collapsed]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const visibleRef = useRef(visibleIds); visibleRef.current = visibleIds;
  const selectedScenes = useMemo(() => selectedIds.map((id) => scenesMap[id]).filter((s): s is SceneRecord => !!s), [selectedIds, scenesMap]);

  // Detected-scenes import helper candidate: selected media first, then the Source clip's media.
  const importCandidate = useMemo<MediaItem | undefined>(() => {
    const ids = [...selectedMediaIds, sourceClip?.mediaId].filter((x): x is ID => !!x);
    for (const id of ids) { const m = media[id]; if (m && m.detectedScenes.length) return m; }
    return undefined;
  }, [selectedMediaIds, sourceClip?.mediaId, media]);
  const importable = useMemo(() => {
    if (!importCandidate) return 0;
    const existing = all.filter((s) => s.mediaId === importCandidate.id);
    return importCandidate.detectedScenes.filter((d) => !existing.some((x) => Math.abs(x.in - d.start) < 0.05 && Math.abs(x.out - d.end) < 0.05)).length;
  }, [importCandidate, all]);

  const canNewFromSource = !!sourceClip && sourceClip.inPoint !== null && sourceClip.outPoint !== null && sourceClip.outPoint > sourceClip.inPoint && !!media[sourceClip.mediaId];
  const canNewFromClip = !!activeSeqId && hasSelectedClip;

  // ---- selection
  const selectScene = useCallback((id: ID, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    const s = useStore.getState();
    if (e.shiftKey && anchorRef.current && visibleIds.includes(anchorRef.current)) {
      const a = visibleIds.indexOf(anchorRef.current), b = visibleIds.indexOf(id);
      if (b >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; s.selectScenes(visibleIds.slice(lo, hi + 1), 'set'); return; }
    }
    if (e.ctrlKey || e.metaKey) { s.selectScenes([id], 'toggle'); anchorRef.current = id; return; }
    s.selectScenes([id], 'set'); anchorRef.current = id;
  }, [visibleIds]);

  const openEditor = useCallback((id: ID) => { useStore.getState().selectScenes([id], 'set'); anchorRef.current = id; setEditorOpen(true); }, []);

  // ---- creation
  const createFromSource = () => { if (sourceClip) setPrompt({ kind: 'source', initial: defaultSceneName(sourceClip.mediaId) }); };
  const createFromClip = () => {
    const s = useStore.getState();
    const seq = activeSequence(s); const clip = selectedClips(s)[0];
    if (!seq || !clip) return;
    setPrompt({ kind: 'clip', seqId: seq.id, clipId: clip.id, initial: clip.name });
  };
  const confirmPrompt = (name: string) => {
    const s = useStore.getState();
    let id: ID | null = null;
    if (prompt?.kind === 'source') id = s.sceneFromSource(name);
    else if (prompt?.kind === 'clip') id = s.sceneFromClip(prompt.seqId, prompt.clipId, name);
    setPrompt(null);
    if (id) { openEditor(id); toast.ok(`Scene "${name}" added to the library`); } else toast.warn('Could not create scene record');
  };
  const runImport = () => {
    if (!importCandidate) return;
    const n = importDetectedScenes(importCandidate.id);
    toast.ok(n ? `Imported ${n} detected shot${n === 1 ? '' : 's'} from ${importCandidate.name}` : 'All detected shots are already in the library');
  };

  // ---- deletion
  const requestDelete = (ids: ID[]) => { if (ids.length) setConfirmDelete(ids); };
  const doDelete = () => {
    const s = useStore.getState();
    const ids = confirmDelete ?? [];
    if (ids.length === 1) s.removeScene(ids[0]);
    else if (ids.length > 1) s.commit(`Remove ${ids.length} scenes`, (d) => { for (const id of ids) delete d.scenes[id]; });
    s.selectScenes(ids, 'clear');
    setConfirmDelete(null);
  };

  // ---- context menu
  const sceneMenu = useCallback((scene: SceneRecord): MenuItem[] => {
    const s = useStore.getState();
    const targets = s.ui.selectedSceneIds.includes(scene.id) && s.ui.selectedSceneIds.length > 1
      ? s.ui.selectedSceneIds.map((id) => s.project.scenes[id]).filter((x): x is SceneRecord => !!x) : [scene];
    const many = targets.length > 1;
    const setAll = (p: Partial<SceneRecord>) => { for (const t of targets) useStore.getState().updateScene(t.id, p); };
    const hasSeq = !!s.project.activeSequenceId;
    // Sequences (#146) take the scenes in the order the list shows them.
    const order = visibleRef.current;
    const ordered = [...targets].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)).map((t) => t.id);
    const sequences = Object.values(s.project.sceneSequences ?? {}).sort((a, b) => a.name.localeCompare(b.name));
    return [
      { label: 'Load in Source', icon: Film, onSelect: () => loadSceneInSource(scene) },
      { label: many ? `Insert ${targets.length} at playhead` : 'Insert at playhead', icon: Plus, disabled: !hasSeq, onSelect: () => (many ? insertScenesAtPlayhead(targets, 'insert') : insertSceneAtPlayhead(scene, 'insert')) },
      { label: many ? `Overwrite ${targets.length} at playhead` : 'Overwrite at playhead', icon: Scissors, disabled: !hasSeq, onSelect: () => (many ? insertScenesAtPlayhead(targets, 'overwrite') : insertSceneAtPlayhead(scene, 'overwrite')) },
      { separator: true },
      { label: many ? `Make Sequence from ${targets.length} Scenes…` : 'Make Sequence…', icon: ListOrdered, onSelect: () => setSeqPrompt(ordered) },
      {
        label: 'Add to Sequence', icon: ListPlus, disabled: !sequences.length, title: sequences.length ? undefined : 'No sequences yet: use Make Sequence…',
        submenu: sequences.map((q) => ({
          label: q.name,
          onSelect: () => { useStore.getState().updateSceneSequence(q.id, { sceneIds: [...q.sceneIds, ...ordered] }); toast.ok(`Added ${ordered.length} scene${ordered.length === 1 ? '' : 's'} to "${q.name}"`); },
        })),
      },
      { separator: true },
      { label: 'Edit…', icon: Pencil, onSelect: () => openEditor(scene.id) },
      { label: many ? `Name ${targets.length} from Transcript` : 'Name from Transcript', icon: Captions, title: 'Uses the first words spoken in the scene (Whisper transcript or subtitles)', onSelect: () => { nameScenesFromTranscript(targets); } },
      { label: many ? `Duplicate ${targets.length}` : 'Duplicate', icon: Copy, onSelect: () => { const ids = targets.map(duplicateScene); useStore.getState().selectScenes(ids, 'set'); } },
      {
        label: 'Set color', icon: Palette,
        submenu: LABEL_COLORS.map((c) => ({ label: c.name, checked: !many && (scene.color ?? '').toLowerCase() === c.hex.toLowerCase(), onSelect: () => setAll({ color: c.hex }) })),
      },
      {
        label: 'Set rating', icon: Star,
        submenu: [0, 1, 2, 3, 4, 5].map((n) => ({ label: n === 0 ? 'None' : '★'.repeat(n) + '☆'.repeat(5 - n), checked: !many && scene.rating === n, onSelect: () => setAll({ rating: n }) })),
      },
      { separator: true },
      { label: many ? `Delete ${targets.length} scenes…` : 'Delete…', icon: Trash2, onSelect: () => requestDelete(targets.map((t) => t.id)) },
    ];
  }, [openEditor]);

  // ---- keyboard
  const onKeyDown = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const s = useStore.getState();
    if (e.key === 'Delete' || e.key === 'Backspace') { if (selectedIds.length) { e.preventDefault(); e.stopPropagation(); requestDelete(selectedIds); } return; }
    if (e.key === 'Enter' && selectedScenes[0]) { e.preventDefault(); e.stopPropagation(); loadSceneInSource(selectedScenes[0]); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!visibleIds.length) return;
      e.preventDefault(); e.stopPropagation();
      const cur = anchorRef.current ? visibleIds.indexOf(anchorRef.current) : -1;
      const next = e.key === 'ArrowDown' ? Math.min(visibleIds.length - 1, cur + 1) : Math.max(0, cur - 1);
      const id = visibleIds[next];
      if (e.shiftKey && anchorRef.current) { const a = visibleIds.indexOf(anchorRef.current); const [lo, hi] = a < next ? [a, next] : [next, a]; s.selectScenes(visibleIds.slice(lo, hi + 1), 'set'); }
      else { s.selectScenes([id], 'set'); anchorRef.current = id; }
      const ri = rowOfScene.get(id);
      if (ri !== undefined) listRef.current?.scrollToIndex(ri);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); e.stopPropagation(); s.selectScenes(visibleIds, 'set'); }
  };

  // Close the editor if its scene disappears.
  useEffect(() => { if (editorOpen && selectedIds.length === 0) setEditorOpen(false); }, [editorOpen, selectedIds.length]);

  const toggleGroup = (key: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const setFilter = <K extends keyof SceneFilters>(k: K, v: SceneFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const activeFilterCount = [filters.character, filters.location, filters.arc, filters.tag, filters.mediaId, filters.color].filter(Boolean).length + (filters.minRating > 0 ? 1 : 0);

  // ---- virtual rows
  const cols = view === 'grid' ? Math.max(1, Math.floor((Math.max(bodyW, CARD_MIN_W) - 2 * GRID_GAP + GRID_GAP) / (CARD_MIN_W + GRID_GAP))) : 1;
  const cardRowH = useMemo(() => {
    const colW = (Math.max(bodyW, CARD_MIN_W) - 2 * GRID_GAP - GRID_GAP * (cols - 1)) / cols;
    return Math.round(colW * 9 / 16 + CARD_BODY_H + GRID_GAP);
  }, [bodyW, cols]);
  const vrows = useMemo<VRow[]>(() => {
    const out: VRow[] = [];
    for (const g of groups) {
      if (groupBy !== 'none') out.push({ kind: 'head', key: `h:${g.key}`, group: { key: g.key, label: g.label, count: g.scenes.length } });
      if (collapsed.has(g.key)) continue;
      if (view === 'grid') for (let i = 0; i < g.scenes.length; i += cols) out.push({ kind: 'cards', key: `c:${g.key}:${i}`, scenes: g.scenes.slice(i, i + cols) });
      else for (const sc of g.scenes) out.push({ kind: 'row', key: `r:${g.key}:${sc.id}`, scene: sc });
    }
    return out;
  }, [groups, groupBy, collapsed, view, cols]);
  const rowOfScene = useMemo(() => {
    const m = new Map<ID, number>();
    vrows.forEach((r, i) => {
      if (r.kind === 'row') { if (!m.has(r.scene.id)) m.set(r.scene.id, i); }
      else if (r.kind === 'cards') for (const sc of r.scenes) if (!m.has(sc.id)) m.set(sc.id, i);
    });
    return m;
  }, [vrows]);
  const rowHeight = useCallback((r: VRow) => (r.kind === 'head' ? HEAD_H : r.kind === 'cards' ? cardRowH : hasChips(r.scene) ? ROW_CHIPS_H : ROW_H), [cardRowH]);

  // Stable per-item handlers (rows / cards are memoised): read the latest panel state through a ref.
  const live = useRef({ selectScene, sceneMenu, menu, selectedSet });
  live.current = { selectScene, sceneMenu, menu, selectedSet };
  const handlers = useMemo<ItemHandlers>(() => ({
    onSelect: (scene, e) => live.current.selectScene(scene.id, e),
    onOpen: (scene) => loadSceneInSource(scene),
    onMenu: (scene, e) => {
      if (!live.current.selectedSet.has(scene.id)) { useStore.getState().selectScenes([scene.id], 'set'); anchorRef.current = scene.id; }
      live.current.menu.open(e, live.current.sceneMenu(scene));
    },
    onDragStart: (scene, e) => {
      const s = useStore.getState();
      const sel = s.ui.selectedSceneIds.includes(scene.id) ? s.ui.selectedSceneIds.map((id) => s.project.scenes[id]).filter((x): x is SceneRecord => !!x) : [scene];
      startSceneDrag(e.dataTransfer, sel.length ? sel : [scene]);
    },
    onRate: (scene, v) => useStore.getState().updateScene(scene.id, { rating: v }),
  }), []);

  const renderRow = (r: VRow) => {
    if (r.kind === 'head') {
      const open = !collapsed.has(r.group.key);
      return (
        <div className="scn-group-head" data-group={r.group.key} onClick={() => toggleGroup(r.group.key)} role="button" aria-expanded={open}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="ellipsis grow">{r.group.label}</span>
          <span className="badge dim">{r.group.count}</span>
        </div>
      );
    }
    if (r.kind === 'row') return <SceneRow scene={r.scene} media={media[r.scene.mediaId]} selected={selectedSet.has(r.scene.id)} h={handlers} />;
    return (
      <div className="scn-grid scn-grid-row" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {r.scenes.map((sc) => <SceneCard key={sc.id} scene={sc} media={media[sc.mediaId]} selected={selectedSet.has(sc.id)} h={handlers} />)}
      </div>
    );
  };

  const editing = editorOpen && selectedScenes.length === 1 ? selectedScenes[0] : null;
  const batch = editorOpen && selectedScenes.length > 1 ? selectedScenes : null;

  return (
    <div className="panel scn-panel" data-testid="scenes-panel" data-active={active} tabIndex={0} onKeyDown={onKeyDown}>
      {/* ---- toolbar row 1: search / view / sort */}
      <div className="scn-toolbar">
        <SearchField value={filters.query} onChange={(v) => setFilter('query', v)} size="sm" placeholder="Search scenes…" className="grow" data-testid="scenes-search" />
        <IconButton icon={Filter} label="Filters" size="sm" toggled={showFilters || activeFilterCount > 0} onClick={() => setShowFilters((v) => !v)} />
        {activeFilterCount > 0 ? <span className="badge" title="Active filters">{activeFilterCount}</span> : null}
        <span className="toolbar-sep" />
        <Select<SortKey> size="sm" value={sortKey} options={SORT_OPTIONS} onChange={setSortKey} title="Sort by" aria-label="Sort by" className="scn-select" />
        <IconButton icon={sortDir === 1 ? ArrowDownAZ : ArrowUpAZ} label={sortDir === 1 ? 'Ascending' : 'Descending'} size="sm" onClick={() => setSortDir((d) => (d === 1 ? -1 : 1))} />
        <span className="toolbar-sep" />
        <div className="btn-group">
          <Button size="sm" icon={List} active={view === 'list'} title="List view" aria-label="List view" onClick={() => setView('list')} />
          <Button size="sm" icon={LayoutGrid} active={view === 'grid'} title="Grid view" aria-label="Grid view" onClick={() => setView('grid')} />
        </div>
      </div>
      {/* ---- toolbar row 2: create / group */}
      <div className="scn-toolbar">
        <Button size="sm" icon={Plus} disabled={!canNewFromSource} title={canNewFromSource ? 'Create a scene record from the Source monitor In/Out range' : 'Mark In and Out in the Source monitor first'}
          onClick={createFromSource} data-testid="scene-new-from-source">From Source In/Out</Button>
        <Button size="sm" icon={Clapperboard} disabled={!canNewFromClip} title={canNewFromClip ? 'Create a scene record from the selected timeline clip' : 'Select a clip in the timeline first'}
          onClick={createFromClip} data-testid="scene-new-from-clip">From clip</Button>
        <span className="grow" />
        <Select<GroupKey> size="sm" value={groupBy} options={GROUP_OPTIONS} onChange={(v) => { setGroupBy(v); setCollapsed(new Set()); }} title="Group by" aria-label="Group by" className="scn-select" />
      </div>
      {/* ---- filters */}
      {showFilters ? (
        <div className="scn-filters" data-testid="scenes-filters">
          <Select size="sm" value={filters.mediaId} aria-label="Movie / episode" onChange={(v) => setFilter('mediaId', v)}
            options={[{ value: '', label: 'All movies / episodes' }, ...facets.mediaIds.map((id) => ({ value: id, label: sourceLabel(media[id]) }))]} />
          <Select size="sm" value={filters.character} aria-label="Character" onChange={(v) => setFilter('character', v)}
            options={[{ value: '', label: 'Any character' }, ...facets.characters.map((c) => ({ value: c, label: c }))]} />
          <Select size="sm" value={filters.location} aria-label="Location" onChange={(v) => setFilter('location', v)}
            options={[{ value: '', label: 'Any location' }, ...facets.locations.map((c) => ({ value: c, label: c }))]} />
          <Select size="sm" value={filters.arc} aria-label="Arc" onChange={(v) => setFilter('arc', v)}
            options={[{ value: '', label: 'Any arc' }, ...facets.arcs.map((c) => ({ value: c, label: c }))]} />
          <Select size="sm" value={filters.tag} aria-label="Tag" onChange={(v) => setFilter('tag', v)}
            options={[{ value: '', label: 'Any tag' }, ...facets.tags.map((c) => ({ value: c, label: c }))]} />
          <Select size="sm" value={String(filters.minRating)} aria-label="Minimum rating" onChange={(v) => setFilter('minRating', Number(v))}
            options={[{ value: '0', label: 'Any rating' }, ...[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${'★'.repeat(n)} and up` }))]} />
          <div className="row gap-4 scn-color-filter" role="radiogroup" aria-label="Color">
            <button type="button" className={['swatch', 'scn-swatch-any', !filters.color ? 'selected' : ''].join(' ')} title="Any color" aria-label="Any color" onClick={() => setFilter('color', '')} />
            {LABEL_COLORS.map((c) => (
              <button key={c.id} type="button" className={['swatch', filters.color.toLowerCase() === c.hex.toLowerCase() ? 'selected' : ''].join(' ')} style={{ background: c.hex }}
                title={c.name} aria-label={c.name} disabled={!facets.colors.includes(c.hex.toLowerCase())} onClick={() => setFilter('color', c.hex)} />
            ))}
            {filtersActive(filters) ? <Button size="sm" variant="ghost" icon={X} className="ml-auto" onClick={() => setFilters(EMPTY_FILTERS)}>Clear</Button> : null}
          </div>
        </div>
      ) : null}
      {/* ---- detected scenes helper */}
      {importCandidate && importable > 0 ? (
        <div className="scn-import" data-testid="scene-import-detected">
          <Wand2 size={13} />
          <span className="grow ellipsis" title={importCandidate.name}>
            <b>{importable}</b> detected shot{importable === 1 ? '' : 's'} in <b>{importCandidate.name}</b>
          </span>
          <Button size="sm" onClick={runImport} title={`Make one scene per detected shot of ${importCandidate.name}`}>Import as records</Button>
        </div>
      ) : null}

      {/* ---- body */}
      <div className="panel-body scn-body" ref={bodyRef} onClick={(e) => { if (!(e.target as HTMLElement).closest('[data-scene-id], .scn-group-head')) useStore.getState().selectScenes([], 'clear'); }}>
        {all.length === 0 ? (
          <EmptyState icon={Clapperboard} title="No scenes in the library yet"
            description="Mark In/Out in the Source monitor and press “From Source In/Out”, or select shots in the Project panel and choose Make Scene. Scene records only reference the source — nothing is copied." />
        ) : filtered.length === 0 ? (
          <EmptyState icon={Filter} title="No scenes match" description="Try a different search or clear the filters." action={<Button size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</Button>} />
        ) : (
          <VirtualList ref={listRef} className={view === 'grid' ? 'scn-vlist grid' : 'scn-vlist list scn-list'} items={vrows} itemKey={rowKey} itemHeight={rowHeight}
            threshold={40} overscan={4} render={renderRow} />
        )}
      </div>

      {/* ---- editor sheet */}
      {editing ? <SceneEditor scene={editing} media={media[editing.mediaId]} onClose={() => setEditorOpen(false)} onDelete={() => requestDelete([editing.id])} /> : null}
      {batch ? <SceneBatchEditor scenes={batch} onClose={() => setEditorOpen(false)} /> : null}

      {/* ---- footer */}
      <div className="panel-footer">
        <span data-testid="scenes-count">{filtered.length === all.length ? `${all.length} scene${all.length === 1 ? '' : 's'}` : `${filtered.length} of ${all.length} scenes`}</span>
        {selectedIds.length ? <span>· {selectedIds.length} selected</span> : null}
        <span className="grow" />
        {selectedIds.length && !editorOpen ? <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditorOpen(true)} data-testid="scene-edit-selected">Edit</Button> : null}
      </div>

      <NamePromptDialog open={!!prompt} title={prompt?.kind === 'clip' ? 'New scene from clip' : 'New scene from Source In/Out'} label="Scene name"
        initial={prompt?.initial ?? ''} onConfirm={confirmPrompt} onCancel={() => setPrompt(null)}>
        {prompt?.kind === 'source' && sourceClip ? (
          <div className="text-dim text-sm mono">
            {formatSequenceSecondsTimecode(sourceClip.inPoint ?? 0, mediaFps(media[sourceClip.mediaId]))} → {formatSequenceSecondsTimecode(sourceClip.outPoint ?? 0, mediaFps(media[sourceClip.mediaId]))}
            <span className="text-faint"> · {media[sourceClip.mediaId]?.name}</span>
          </div>
        ) : null}
      </NamePromptDialog>
      <NamePromptDialog open={!!seqPrompt} title={seqPrompt && seqPrompt.length > 1 ? `Make Sequence from ${seqPrompt.length} Scenes` : 'Make Sequence'} label="Sequence name"
        initial={seqPrompt ? nextSequenceName() : ''} confirmLabel="Make Sequence" onCancel={() => setSeqPrompt(null)}
        onConfirm={(name) => {
          const ids = seqPrompt ?? [];
          setSeqPrompt(null);
          useStore.getState().addSceneSequence(name, ids);
          toast.ok(`Sequence "${name}" made from ${ids.length} scene${ids.length === 1 ? '' : 's'}`);
        }}>
        <div className="text-dim text-xs">The scenes keep the order of the list. Find the sequence in the Sequences tab.</div>
      </NamePromptDialog>
      <ConfirmDialog open={!!confirmDelete} title={confirmDelete && confirmDelete.length > 1 ? `Delete ${confirmDelete.length} scenes?` : 'Delete scene?'}
        message={<>Removes the record{confirmDelete && confirmDelete.length > 1 ? 's' : ''} from the library. Source media and timeline clips are not affected. This can be undone.</>}
        onConfirm={doDelete} onCancel={() => setConfirmDelete(null)} />
    </div>
  );
}

// ------------------------------------------------------------------ row / card

interface ItemHandlers {
  onSelect: (scene: SceneRecord, e: React.MouseEvent) => void;
  onOpen: (scene: SceneRecord) => void;
  onMenu: (scene: SceneRecord, e: React.MouseEvent) => void;
  onDragStart: (scene: SceneRecord, e: React.DragEvent) => void;
  onRate: (scene: SceneRecord, v: number) => void;
}

interface ItemProps {
  scene: SceneRecord;
  media: MediaItem | undefined;
  selected: boolean;
  /** Stable handler bundle shared by every row / card. */
  h: ItemHandlers;
}

const rowKey = (r: VRow) => r.key;

function Thumb({ media, time, width, className }: { media: MediaItem | undefined; time: number; width: number; className: string }) {
  const url = useThumb(media?.offline ? undefined : media?.path, time, width, media?.id);
  return (
    <div className={className}>
      {url ? <img src={url} alt="" draggable={false} /> : <Film size={14} className="text-faint" />}
    </div>
  );
}

const SceneRow = memo(function SceneRow(p: ItemProps) {
  const { scene, media, selected, h } = p;
  const fps = mediaFps(media);
  return (
    <div className={['scn-row', selected ? 'selected' : '', media ? '' : 'missing'].filter(Boolean).join(' ')} data-scene-id={scene.id} aria-selected={selected} role="option"
      draggable onDragStart={(e) => h.onDragStart(scene, e)} onClick={(e) => h.onSelect(scene, e)} onDoubleClick={() => h.onOpen(scene)} onContextMenu={(e) => h.onMenu(scene, e)}>
      <span className="scn-row-color" style={{ background: labelColorHex(scene.color) ?? 'transparent' }} />
      <Thumb media={media} time={scene.in} width={160} className="scn-thumb" />
      <div className="scn-row-main">
        <div className="row gap-6">
          <span className="scn-name ellipsis" title={scene.name}>{scene.name}</span>
          <RatingStars value={scene.rating} onChange={(v) => h.onRate(scene, v)} size={10} className="ml-auto" />
        </div>
        <div className="row gap-6 text-sm">
          <span className="text-dim ellipsis grow" title={sourceLabel(media)}>{sourceLabel(media)}</span>
          <span className="mono text-dim nowrap" title="Duration">{durationLabel(scene)}</span>
        </div>
        <div className="mono text-faint text-xs ellipsis scn-range" title={rangeLabel(scene, fps)}>{rangeLabel(scene, fps)}</div>
        {(scene.characters.length || scene.location || scene.arc || scene.tags.length) ? (
          <div className="scn-chips">
            {scene.characters.map((c) => <span key={`c-${c}`} className="tag accent" title="Character">{c}</span>)}
            {scene.location ? <span className="tag scn-chip-loc" title="Location">{scene.location}</span> : null}
            {scene.arc ? <span className="tag scn-chip-arc" title="Arc">{scene.arc}</span> : null}
            {scene.tags.map((t) => <span key={`t-${t}`} className="tag" title="Tag">#{t}</span>)}
          </div>
        ) : null}
      </div>
    </div>
  );
});

const SceneCard = memo(function SceneCard(p: ItemProps) {
  const { scene, media, selected, h } = p;
  const fps = mediaFps(media);
  return (
    <div className={['scn-card', selected ? 'selected' : '', media ? '' : 'missing'].filter(Boolean).join(' ')} data-scene-id={scene.id} aria-selected={selected} role="option"
      draggable onDragStart={(e) => h.onDragStart(scene, e)} onClick={(e) => h.onSelect(scene, e)} onDoubleClick={() => h.onOpen(scene)} onContextMenu={(e) => h.onMenu(scene, e)}>
      <Thumb media={media} time={scene.in} width={160} className="scn-card-thumb" />
      <span className="scn-card-dur mono">{durationLabel(scene)}</span>
      <span className="scn-card-color" style={{ background: labelColorHex(scene.color) ?? 'transparent' }} />
      <div className="scn-card-body">
        <div className="scn-name ellipsis" title={scene.name}>{scene.name}</div>
        <div className="text-dim text-xs ellipsis" title={sourceLabel(media)}>{sourceLabel(media)}</div>
        <div className="text-faint text-xs mono ellipsis">{formatSequenceSecondsTimecode(scene.in, fps)}</div>
        <div className="row gap-4">
          <RatingStars value={scene.rating} onChange={(v) => h.onRate(scene, v)} size={9} />
          {scene.characters.length ? <span className="text-xs text-dim ellipsis ml-auto" title={scene.characters.join(', ')}>{scene.characters.join(', ')}</span> : null}
        </div>
      </div>
    </div>
  );
});

/** Used by the e2e tests / command palette: bring the Scenes panel to front. */
export function focusScenesPanel(): void { useLayoutStore.getState().focusPanel('scenes'); }
