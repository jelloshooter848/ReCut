import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, FolderPlus, Import, Layers as LayersIcon, LayoutGrid, List } from 'lucide-react';
import type { ID, Project, Sequence } from '@shared/model';
import { Button, EmptyState, IconButton, SearchField, Select, Toggle, useContextMenu } from '@/components/ui';
import { toast } from '@/components/ui/toastStore';
import { pathOfDroppedFile, setClipDrag, type ClipDragPayload } from '@/app/dnd';
import { isEditableTarget } from '@/keyboard/useShortcuts';
import { useStore, seriesTree, verifyMediaOnline, onMediaImported } from '@/state';
import type { PanelProps } from '../registry';
import { VirtualList, type VirtualListHandle } from './VirtualList';
import { ITEMS_DND_TYPE, RowView, type ItemsDragPayload, type RowCallbacks } from './rows';
import {
  CARD_W, SORT_OPTIONS, buildBinRows, buildSeriesRows, expandKey, filterSortSeriesTree, groupMediaByBin, reuseRows, rowHeight, rowId,
  type BinRow, type ExpandedMap, type GroupRow, type ItemRow, type Row, type SceneRow, type SortKey, type TreeMode, type ViewMode,
} from './tree';
import { PanelDialogs, type PanelDialog } from './dialogs';
import { InfoFooter } from './InfoFooter';
import { deleteSequenceConfirmed, importPaths, importViaDialog, loadInSource, locateMedia, openSequence, removeMediaConfirmed } from './actions';
import { backgroundMenu, binMenu, groupMenu, mediaMenu, sceneMenu, sequenceMenu, type MenuEnv } from './menus';

type SelectableRow = ItemRow | BinRow;
type ClickableRow = SelectableRow | GroupRow;

function filePaths(dt: DataTransfer): string[] {
  const out: string[] = [];
  for (const f of Array.from(dt.files)) {
    const p = pathOfDroppedFile(f);
    if (p) out.push(p);
  }
  return out;
}

/**
 * What the tree shows and sorts by of a sequence, cached per sequence object. Not its duration: that cell reads the
 * store itself (rows.tsx SequenceDuration), so a timeline edit neither rebuilds the tree nor re-renders the panel.
 */
const seqSigCache = new WeakMap<Sequence, string>();
function sequenceSig(s: Sequence): string {
  let sig = seqSigCache.get(s);
  if (sig === undefined) {
    sig = [s.id, s.name, s.fps.num, s.fps.den, s.width, s.height, s.createdAt, s.parentSequenceId ?? '', s.binId ?? '', s.versionLabel ?? ''].join('\u0001');
    seqSigCache.set(s, sig);
  }
  return sig;
}
/** Changes only when a sequence's tree-visible fields change, not on clip edits (P-04). */
let lastSig: { sequences: Project['sequences']; order: Project['sequenceOrder']; sig: string } | null = null;
function sequencesSignature(p: Project): string {
  // Runs on every store update (each playhead step): reuse the last result while the map and order are the same.
  if (lastSig && lastSig.sequences === p.sequences && lastSig.order === p.sequenceOrder) return lastSig.sig;
  let out = p.sequenceOrder.join(',');
  for (const s of Object.values(p.sequences)) out += '\u0002' + sequenceSig(s);
  lastSig = { sequences: p.sequences, order: p.sequenceOrder, sig: out };
  return out;
}

export function ProjectPanel(_props: PanelProps) {
  const media = useStore((s) => s.project.media);
  const bins = useStore((s) => s.project.bins);
  // Rebuild the tree only when what it shows of the sequences changes (name / format / bin / lineage).
  const seqSig = useStore((s) => sequencesSignature(s.project));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sequences = useMemo(() => useStore.getState().project.sequences, [seqSig]);
  const sequenceOrder = useStore((s) => s.project.sequenceOrder);
  const useProxies = useStore((s) => s.project.settings.useProxies);
  const selectedMediaIds = useStore((s) => s.ui.selectedMediaIds);
  const selectedSceneIds = useStore((s) => s.ui.selectedSceneIds);
  const selectedBinId = useStore((s) => s.ui.selectedBinId);

  const [query, setQuery] = useState('');
  const [view, setView] = useState<ViewMode>('list');
  const [sort, setSort] = useState<SortKey>('name');
  const [mode, setMode] = useState<TreeMode>('bins');
  const [expanded, setExpanded] = useState<ExpandedMap>({});
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [dialog, setDialog] = useState<PanelDialog>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [fileDrag, setFileDrag] = useState(false);
  const [selSeqIds, setSelSeqIds] = useState<ID[]>([]);
  const [cols, setCols] = useState(2);

  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<VirtualListHandle>(null);
  const anchorRef = useRef<string | null>(null);
  const fileDragDepth = useRef(0);
  const { open: openMenu } = useContextMenu();

  // ---- derived rows ----
  const tree = useMemo(() => (mode === 'series' ? seriesTree(useStore.getState()) : null), [mode, media]);
  // The media lists (filtered + sorted) depend on the media, the search and the sort only: never re-sorted for a
  // sequence change, bin expansion or resize.
  const mediaByBin = useMemo(() => (mode === 'bins' ? groupMediaByBin(media, query, sort) : null), [mode, media, query, sort]);
  const seriesLists = useMemo(() => (tree ? filterSortSeriesTree(tree, query, sort) : null), [tree, query, sort]);
  const input = useMemo(() => ({ media, bins, sequences, sequenceOrder, expanded, query, sort, view, cols }), [media, bins, sequences, sequenceOrder, expanded, query, sort, view, cols]);
  // Rows keep their identity while unchanged (reuseRows), so the memoised row views re-render only what changed.
  const prevRows = useRef<Row[] | null>(null);
  const rows = useMemo(() => {
    const next = mode === 'series' && tree && seriesLists ? buildSeriesRows(tree, input, seriesLists) : buildBinRows(input, mediaByBin ?? undefined);
    return (prevRows.current = reuseRows(prevRows.current, next));
  }, [mode, tree, seriesLists, mediaByBin, input]);
  const navRows = useMemo(() => rows.flatMap((r) => (r.kind === 'cards' ? r.items : [r])) as ClickableRow[], [rows]);
  const selected = useMemo(() => {
    const s = new Set<string>(selectedMediaIds);
    for (const id of selectedSceneIds) s.add(id);
    if (selectedBinId) s.add(selectedBinId);
    for (const id of selSeqIds) s.add(id);
    return s;
  }, [selectedMediaIds, selectedSceneIds, selectedBinId, selSeqIds]);
  const offlineCount = useMemo(() => Object.values(media).filter((m) => m.offline).length, [media]);
  const mediaCount = Object.keys(media).length;

  // Refs so the (memoized) row callbacks always see current data without re-creating.
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const navRef = useRef(navRows); navRef.current = navRows;
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const selSeqRef = useRef(selSeqIds); selSeqRef.current = selSeqIds;
  const stateRef = useRef({ dialog, renamingKey, selectedBinId }); stateRef.current = { dialog, renamingKey, selectedBinId };

  useEffect(() => {
    const el = rootRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setCols(Math.max(1, Math.floor((el.clientWidth - 16) / (CARD_W + 6)))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // After an import: open the bins (or series groups) that received files and scroll the first new item into view.
  const revealRef = useRef<ID[] | null>(null);
  // Bumped per import: the rows keep their identity when nothing they show changed (reuseRows, e.g. re-importing
  // a file whose bins are already open), and the reveal must still run.
  const [revealTick, setRevealTick] = useState(0);
  useEffect(() => onMediaImported((r) => {
    const ids = r.added.length ? r.added : r.existing;
    if (!ids.length) return;
    const { media: med, bins: bs } = useStore.getState().project;
    setExpanded((m) => {
      const next: ExpandedMap = { ...m, [expandKey.group('root')]: true };
      for (const id of ids) {
        const it = med[id];
        if (!it) continue;
        for (let b = it.binId, guard = 0; b && guard < 64; b = bs[b]?.parentId ?? null, guard++) next[expandKey.bin(b)] = true;
        const { series, season } = it.identity;
        if (series) { next[expandKey.group(`series:${series}`)] = true; next[expandKey.group(`season:${series}:${season ?? 0}`)] = true; }
        else next[expandKey.group('loose')] = true;
      }
      return next;
    });
    revealRef.current = ids;
    setRevealTick((n) => n + 1);
  }), []);
  useEffect(() => {
    const ids = revealRef.current;
    if (!ids) return;
    const want = new Set(ids);
    const i = rows.findIndex((r) => (r.kind === 'media' && want.has(r.media.id)) || (r.kind === 'cards' && r.items.some((x) => x.kind === 'media' && want.has(x.media.id))));
    if (i < 0) return;
    revealRef.current = null;
    anchorRef.current = rows[i].kind === 'media' ? rows[i].key : anchorRef.current;
    requestAnimationFrame(() => listRef.current?.scrollToIndex(i, 'center'));
  }, [rows, revealTick]);

  // Offline check once per mount (cheap stat per file).
  useEffect(() => { if (Object.keys(useStore.getState().project.media).length) void verifyMediaOnline(); }, []);

  // ---- selection ----
  const applySelection = useCallback((targets: ClickableRow[], smode: 'set' | 'add' | 'toggle') => {
    const st = useStore.getState();
    const mediaIds: ID[] = [], sceneIds: ID[] = [], seqIds: ID[] = [];
    let binId: ID | null = null;
    for (const r of targets) {
      if (r.kind === 'media') mediaIds.push(r.media.id);
      else if (r.kind === 'scene') sceneIds.push(r.scene.id);
      else if (r.kind === 'sequence') seqIds.push(r.seq.id);
      else if (r.kind === 'bin') binId = r.bin.id;
    }
    st.selectMedia(mediaIds, smode);
    st.selectScenes(sceneIds, smode);
    if (smode === 'set') { st.selectBin(binId); setSelSeqIds(seqIds); }
    else {
      if (binId) st.selectBin(smode === 'toggle' && st.ui.selectedBinId === binId ? null : binId);
      setSelSeqIds((prev) => (smode === 'add'
        ? [...new Set([...prev, ...seqIds])]
        : seqIds.reduce((acc, id) => (acc.includes(id) ? acc.filter((x) => x !== id) : [...acc, id]), prev)));
    }
  }, []);

  const indexInRows = (r: Row): number => rowsRef.current.findIndex((x) => x === r || (x.kind === 'cards' && x.items.includes(r as ItemRow)));

  const openRow = useCallback((row: ClickableRow) => {
    switch (row.kind) {
      case 'media': if (!row.media.offline) loadInSource(row.media.id, 0); else void locateMedia(row.media.id); break;
      case 'scene': loadInSource(row.media.id, row.scene.start, { in: row.scene.start, out: row.scene.end }); break;
      case 'sequence': openSequence(row.seq.id); break;
      case 'bin': setExpanded((m) => ({ ...m, [expandKey.bin(row.bin.id)]: !row.expanded })); break;
      case 'group': setExpanded((m) => ({ ...m, [expandKey.group(row.id)]: !row.expanded })); break;
    }
  }, []);

  const newBin = useCallback((parentId: ID | null) => {
    const st = useStore.getState();
    const id = st.addBin('New Bin', parentId);
    setExpanded((m) => (parentId ? { ...m, [expandKey.bin(parentId)]: true, [expandKey.group('root')]: true } : { ...m, [expandKey.group('root')]: true }));
    st.selectBin(id);
    setMode('bins');
    setRenamingKey(`bin:${id}`);
  }, []);

  const menuEnv = useCallback((): MenuEnv => ({
    selectedMedia: useStore.getState().ui.selectedMediaIds,
    openPanelDialog: setDialog,
    startRename: setRenamingKey,
    expandScenes: (id) => setExpanded((m) => ({ ...m, [expandKey.scenes(id)]: true })),
    newBin,
  }), [newBin]);

  const handleDrop = useCallback((dt: DataTransfer, binId: ID | null) => {
    const raw = dt.getData(ITEMS_DND_TYPE);
    if (raw) {
      try {
        const p = JSON.parse(raw) as ItemsDragPayload;
        const ids = (p.ids ?? []).filter((id) => id !== binId);
        if (ids.length) useStore.getState().moveToBin(ids, binId);
      } catch { /* ignore malformed payload */ }
      return;
    }
    if (dt.files.length) {
      const paths = filePaths(dt);
      if (!paths.length) { toast('warn', 'Dropped files carry no filesystem path (preload needs webUtils.getPathForFile)'); return; }
      void importPaths(paths, binId);
    }
  }, []);

  const deleteSelection = useCallback(async () => {
    const st = useStore.getState();
    const sel = selectedRef.current;
    const mediaIds = st.ui.selectedMediaIds.filter((id) => st.project.media[id]);
    const scenes = navRef.current.filter((r): r is SceneRow => r.kind === 'scene' && sel.has(r.scene.id));
    const seqIds = selSeqRef.current;
    const binId = st.ui.selectedBinId;
    if (mediaIds.length) await removeMediaConfirmed(mediaIds);
    for (const s of scenes) useStore.getState().deleteDetectedScene(s.media.id, s.scene.id);
    if (scenes.length) useStore.getState().selectScenes([], 'set');
    for (const id of seqIds) await deleteSequenceConfirmed(id);
    if (seqIds.length) setSelSeqIds([]);
    if (binId && !mediaIds.length && !scenes.length && !seqIds.length) { useStore.getState().deleteBin(binId); useStore.getState().selectBin(null); }
  }, []);

  // ---- row callbacks (stable) ----
  const cb = useMemo<RowCallbacks>(() => ({
    onClick(e, row) {
      if (row.kind === 'group') { anchorRef.current = row.key; return; }
      const nav = navRef.current;
      const idx = nav.findIndex((r) => r.key === row.key);
      if (e.shiftKey && anchorRef.current) {
        const a = nav.findIndex((r) => r.key === anchorRef.current);
        if (a >= 0 && idx >= 0) {
          const [lo, hi] = a < idx ? [a, idx] : [idx, a];
          applySelection(nav.slice(lo, hi + 1).filter((r) => r.kind !== 'group'), e.ctrlKey || e.metaKey ? 'add' : 'set');
          return;
        }
      }
      anchorRef.current = row.key;
      applySelection([row], e.ctrlKey || e.metaKey ? 'toggle' : 'set');
    },
    onOpen: openRow,
    onContextMenu(e, row) {
      const id = rowId(row);
      if (id && !selectedRef.current.has(id)) { anchorRef.current = row.key; applySelection([row], 'set'); }
      const env = menuEnv();
      const items = row.kind === 'media' ? mediaMenu(row.media, env)
        : row.kind === 'scene' ? sceneMenu(row, env)
          : row.kind === 'sequence' ? sequenceMenu(row, env)
            : row.kind === 'bin' ? binMenu(row, env)
              : groupMenu(row, env);
      openMenu(e, items);
    },
    onToggle(key) { setExpanded((m) => { const cur = m[key]; const def = !key.startsWith('scn:'); return { ...m, [key]: !(cur ?? def) }; }); },
    onRenameCommit(row, name) {
      const st = useStore.getState();
      if (row.kind === 'media') st.updateMedia(row.media.id, { name });
      else if (row.kind === 'scene') st.renameDetectedScene(row.media.id, row.scene.id, name);
      else if (row.kind === 'sequence') st.renameSequence(row.seq.id, name);
      else if (row.kind === 'bin') st.renameBin(row.bin.id, name);
      setRenamingKey(null);
      rootRef.current?.focus();
    },
    onRenameCancel() { setRenamingKey(null); rootRef.current?.focus(); },
    onDragStart(e, row) {
      const sel = selectedRef.current;
      const id = rowId(row);
      const inSel = !!id && sel.has(id);
      const nav = navRef.current;
      const items: ID[] = row.kind === 'scene' ? []
        : inSel ? nav.filter((r) => (r.kind === 'media' || r.kind === 'sequence' || r.kind === 'bin') && sel.has(rowId(r)!)).map((r) => rowId(r)!)
          : id ? [id] : [];
      if (items.length) e.dataTransfer.setData(ITEMS_DND_TYPE, JSON.stringify({ ids: items } satisfies ItemsDragPayload));
      if (row.kind === 'media') {
        const list: ClipDragPayload[] = inSel
          ? nav.filter((r): r is Extract<ClickableRow, { kind: 'media' }> => r.kind === 'media' && sel.has(r.media.id)).map((r) => ({ mediaId: r.media.id, name: r.media.name, origin: 'media' }))
          : [{ mediaId: row.media.id, name: row.media.name, origin: 'media' }];
        setClipDrag(e.dataTransfer, list);
      } else if (row.kind === 'scene') {
        setClipDrag(e.dataTransfer, { mediaId: row.media.id, in: row.scene.start, out: row.scene.end, name: row.scene.name, origin: 'scene', characters: row.scene.characters, tags: row.scene.tags });
      } else e.dataTransfer.effectAllowed = 'move';
    },
    onDragEnd() { setDropKey(null); },
    onDragOverTarget(e, key) {
      const t = Array.from(e.dataTransfer.types);
      if (!t.includes(ITEMS_DND_TYPE) && !t.includes('Files')) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = t.includes('Files') ? 'copy' : 'move';
      setDropKey((k) => (k === key ? k : key));
    },
    onDragLeaveTarget(key) { setDropKey((k) => (k === key ? null : k)); },
    onDropTarget(e, binId, key) {
      e.preventDefault(); e.stopPropagation();
      setDropKey(null); setFileDrag(false); fileDragDepth.current = 0;
      void key;
      handleDrop(e.dataTransfer, binId);
    },
    onRelink(mediaId) { void locateMedia(mediaId); },
  }), [applySelection, openRow, menuEnv, openMenu, handleDrop]);

  // ---- keyboard ----
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isEditableTarget(e.target)) return;
    if (stateRef.current.dialog || stateRef.current.renamingKey) return;
    const nav = navRef.current;
    const sel = selectedRef.current;
    const anchorIdx = nav.findIndex((r) => r.key === anchorRef.current);
    const firstSel = nav.find((r) => { const id = rowId(r); return !!id && sel.has(id); });
    const cur: ClickableRow | null = (anchorIdx >= 0 ? nav[anchorIdx] : firstSel) ?? null;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    switch (e.key) {
      case 'ArrowDown': case 'ArrowUp': {
        stop();
        if (!nav.length) return;
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        let i = anchorIdx >= 0 ? anchorIdx : nav.indexOf(firstSel as ClickableRow);
        i = i < 0 ? (dir > 0 ? 0 : nav.length - 1) : Math.max(0, Math.min(nav.length - 1, i + dir));
        const r = nav[i];
        anchorRef.current = r.key;
        if (r.kind !== 'group') applySelection([r], e.shiftKey ? 'add' : 'set');
        listRef.current?.scrollToIndex(indexInRows(r));
        return;
      }
      case 'ArrowRight': case 'ArrowLeft': {
        if (!cur) return;
        const key = cur.kind === 'bin' ? expandKey.bin(cur.bin.id) : cur.kind === 'group' ? expandKey.group(cur.id) : cur.kind === 'media' && cur.media.detectedScenes.length ? expandKey.scenes(cur.media.id) : null;
        if (!key) return;
        stop();
        const want = e.key === 'ArrowRight';
        setExpanded((m) => ({ ...m, [key]: want }));
        return;
      }
      case 'Enter': if (cur && cur.kind !== 'group') { stop(); openRow(cur); } return;
      case 'F2': if (cur && cur.kind !== 'group') { stop(); setRenamingKey(cur.key); } return;
      case 'Delete': case 'Backspace': stop(); void deleteSelection(); return;
      case 'Escape': stop(); applySelection([], 'set'); return;
      case 'a': case 'A': if (e.ctrlKey || e.metaKey) { stop(); applySelection(nav.filter((r) => r.kind === 'media'), 'set'); } return;
      default: return;
    }
  };

  // ---- OS file drag over the whole panel ----
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const onDragEnter = (e: React.DragEvent) => { if (hasFiles(e)) { e.preventDefault(); fileDragDepth.current++; setFileDrag(true); } };
  const onDragOver = (e: React.DragEvent) => { if (hasFiles(e) || Array.from(e.dataTransfer.types).includes(ITEMS_DND_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = hasFiles(e) ? 'copy' : 'move'; } };
  const onDragLeave = () => { if (fileDragDepth.current > 0) fileDragDepth.current--; if (fileDragDepth.current === 0) setFileDrag(false); };
  const onDrop = (e: React.DragEvent) => {
    fileDragDepth.current = 0; setFileDrag(false); setDropKey(null);
    const t = Array.from(e.dataTransfer.types);
    if (!t.includes('Files') && !t.includes(ITEMS_DND_TYPE)) return;
    e.preventDefault();
    // Items dropped on empty space go to the selected bin (files) or the root (items).
    handleDrop(e.dataTransfer, t.includes('Files') ? stateRef.current.selectedBinId : null);
  };

  const infoMediaId = selectedMediaIds[0] ?? (selectedSceneIds.length ? navRows.find((r): r is SceneRow => r.kind === 'scene' && selectedSceneIds.includes(r.scene.id))?.media.id ?? null : null);
  const infoSeqId = !infoMediaId && selSeqIds.length ? selSeqIds[0] : null;
  const st = useStore.getState();

  return (
    <div ref={rootRef} className="pp" tabIndex={0} data-testid="project-panel" onKeyDown={onKeyDown}
      onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
      onContextMenu={(e) => { if ((e.target as HTMLElement).closest('.pp-row, .pp-card, .pp-toolbar, .pp-info, .pp-banner')) return; openMenu(e, backgroundMenu(menuEnv(), selectedBinId)); }}>
      <div className="pp-toolbar">
        <div className="pp-seg" role="tablist" aria-label="Tree mode">
          <button type="button" role="tab" aria-selected={mode === 'bins'} className={mode === 'bins' ? 'active' : ''} onClick={() => setMode('bins')} data-testid="mode-bins">Bins</button>
          <button type="button" role="tab" aria-selected={mode === 'series'} className={mode === 'series' ? 'active' : ''} onClick={() => setMode('series')} data-testid="mode-series">Series</button>
        </div>
        <SearchField size="sm" value={query} onChange={setQuery} placeholder="Search name, S01E03, tag…" data-testid="project-search" />
        <IconButton size="sm" icon={view === 'list' ? LayoutGrid : List} label={view === 'list' ? 'Icon view' : 'List view'} onClick={() => setView((v) => (v === 'list' ? 'grid' : 'list'))} data-testid="view-toggle" />
        <Select size="sm" value={sort} options={SORT_OPTIONS} onChange={setSort} title="Sort by" aria-label="Sort by" />
      </div>
      <div className="pp-toolbar">
        <Button size="sm" icon={Import} onClick={() => { void importViaDialog(selectedBinId, selectedMediaIds.length === 1 ? selectedMediaIds[0] : null); }} data-testid="import-btn">Import…</Button>
        <IconButton size="sm" icon={FolderPlus} label="New Bin" onClick={() => newBin(selectedBinId)} data-testid="new-bin" />
        <IconButton size="sm" icon={LayersIcon} label="New Sequence…" onClick={() => st.openDialog('newSequence')} data-testid="new-sequence" />
        <span className="grow" />
        <Toggle checked={useProxies} onChange={(v) => useStore.getState().setSettings({ useProxies: v })} label={<span className="text-sm">Use proxies</span>} title="Play proxies instead of originals when available (export always uses originals)" />
      </div>
      {offlineCount > 0 ? (
        <div className="pp-banner" data-testid="offline-banner">
          <AlertTriangle />
          <span className="grow ellipsis">{offlineCount} media file{offlineCount === 1 ? ' is' : 's are'} offline</span>
          <Button size="sm" variant="danger" onClick={() => st.openDialog('relink')}>Relink…</Button>
        </div>
      ) : null}
      <div className={['pp-body', fileDrag ? 'drop-files' : ''].filter(Boolean).join(' ')}>
        {mediaCount === 0 && !query ? (
          <EmptyState icon={Import} className="pp-first-run" title="Import media to start"
            description="Import movies or episodes, or drop files here — subtitles next to media are picked up automatically."
            action={<Button variant="primary" icon={Import} onClick={() => { void importViaDialog(selectedBinId); }} data-testid="empty-import">Import media… <span className="text-dim">Ctrl+I</span></Button>} />
        ) : null}
        <VirtualList
          ref={listRef}
          rows={rows}
          heightOf={rowHeight}
          keyOf={(r) => r.key}
          render={(row) => <RowView row={row} selected={selected} renamingKey={renamingKey} dropKey={dropKey} sort={sort} cb={cb} />}
          containerProps={{ 'data-testid': 'project-list', role: 'tree' } as React.HTMLAttributes<HTMLDivElement>}
          footer={rows.length <= 1 && query ? <EmptyState title="No matches" description={`Nothing matches "${query}".`} /> : null}
        />
      </div>
      <InfoFooter mediaId={infoMediaId} sequenceId={infoSeqId} open={infoOpen} onToggle={() => setInfoOpen((v) => !v)} />
      <PanelDialogs dialog={dialog} onClose={() => { setDialog(null); rootRef.current?.focus(); }} />
    </div>
  );
}
