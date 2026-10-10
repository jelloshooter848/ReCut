/**
 * Flat row model for the Project panel tree (pure, DOM-free, unit-testable).
 */
import type { Bin, DetectedScene, ID, MediaItem, Sequence } from '@shared/model';
import type { SeriesTree } from '@/state/selectors';
import { fileNameOf } from '@/state/selectors';
import { episodeLabel } from './parseIdentity';

export type SortKey = 'name' | 'duration' | 'added' | 'category' | 'resolution';
export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'duration', label: 'Duration' },
  { value: 'added', label: 'Date added' },
  { value: 'category', label: 'Category' },
  { value: 'resolution', label: 'Resolution' },
];
export type ViewMode = 'list' | 'grid';
export type TreeMode = 'bins' | 'series';

export type GroupKind = 'root' | 'series' | 'season' | 'collection' | 'loose' | 'sequences';

interface BaseRow { key: string; depth: number }
export interface BinRow extends BaseRow { kind: 'bin'; bin: Bin; expanded: boolean; count: number }
export interface GroupRow extends BaseRow { kind: 'group'; id: string; label: string; groupKind: GroupKind; expanded: boolean; count: number }
export interface MediaRow extends BaseRow { kind: 'media'; media: MediaItem; expanded: boolean }
export interface SequenceRow extends BaseRow { kind: 'sequence'; seq: Sequence; parentName?: string }
export interface SceneRow extends BaseRow { kind: 'scene'; media: MediaItem; scene: DetectedScene; index: number }
export type ItemRow = MediaRow | SequenceRow | SceneRow;
export interface CardsRow extends BaseRow { kind: 'cards'; items: ItemRow[] }
export type Row = BinRow | GroupRow | MediaRow | SequenceRow | SceneRow | CardsRow;

export const ROW_H_ITEM = 40;
export const ROW_H_SMALL = 24;
export const ROW_H_CARDS = 102;
export const CARD_W = 110;

export function rowHeight(row: Row): number {
  switch (row.kind) {
    case 'media': case 'scene': return ROW_H_ITEM;
    case 'cards': return ROW_H_CARDS;
    default: return ROW_H_SMALL;
  }
}

/** Keys used in the expanded map. */
export const expandKey = {
  bin: (id: ID) => `bin:${id}`,
  group: (id: string) => `grp:${id}`,
  scenes: (mediaId: ID) => `scn:${mediaId}`,
};
export type ExpandedMap = Record<string, boolean>;
export function isExpanded(map: ExpandedMap, key: string): boolean {
  const v = map[key];
  if (v !== undefined) return v;
  return !key.startsWith('scn:'); // bins & groups default open, scene expanders default closed
}

// ---------------------------------------------------------------- search

export function searchTerms(q: string): string[] { return q.toLowerCase().split(/\s+/).filter(Boolean); }

export function mediaHaystack(m: MediaItem): string {
  const idn = m.identity;
  return [m.name, fileNameOf(m.path), m.category, idn.series, idn.title, idn.collection, idn.franchise, episodeLabel(idn), idn.year, ...m.tags, m.notes]
    .filter((x) => x !== undefined && x !== null && x !== '').join(' ').toLowerCase();
}
export function mediaMatches(m: MediaItem, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const hay = mediaHaystack(m);
  return terms.every((t) => hay.includes(t));
}
export function textMatches(text: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const hay = text.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

// ---------------------------------------------------------------- sorting

/**
 * Name order: exactly `a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })`. localeCompare with
 * options builds a collator on every call (ECMA-402: `new Intl.Collator(locales, options).compare(a, b)`), which made
 * the sort of a 2,500-item project the panel's top cost; one module-level collator gives the same order.
 */
export const compareNames: (a: string, b: string) => number = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
/** Exactly `a.localeCompare(b)` (default locale and options). */
const compareText: (a: string, b: string) => number = new Intl.Collator().compare;

export function compareMedia(a: MediaItem, b: MediaItem, sort: SortKey): number {
  switch (sort) {
    case 'duration': return ((b.probe?.duration ?? -1) - (a.probe?.duration ?? -1)) || compareNames(a.name, b.name);
    case 'added': return (b.addedAt - a.addedAt) || compareNames(a.name, b.name);
    case 'category': return compareText(a.category, b.category) || compareNames(a.name, b.name);
    case 'resolution': {
      const px = (m: MediaItem) => (m.probe?.video ? m.probe.video.width * m.probe.video.height : -1);
      return (px(b) - px(a)) || compareNames(a.name, b.name);
    }
    default: {
      // Episodes in order when they share a series
      if (a.identity.series && a.identity.series === b.identity.series) {
        const d = ((a.identity.season ?? 0) - (b.identity.season ?? 0)) || ((a.identity.episode ?? 0) - (b.identity.episode ?? 0));
        if (d) return d;
      }
      return compareNames(a.name, b.name);
    }
  }
}
export function compareSequences(a: Sequence, b: Sequence, sort: SortKey): number {
  if (sort === 'added') return (b.createdAt - a.createdAt) || compareNames(a.name, b.name);
  return compareNames(a.name, b.name);
}
const byBinName = (a: Bin, b: Bin) => compareNames(a.name, b.name);

/**
 * Media per bin, filtered by the search and sorted: what the bins tree lists of the media. It depends only on the
 * media, the query and the sort, so the panel memoises it apart from the sequences: a timeline edit (a new sequence
 * object) never re-sorts the media.
 */
export type MediaByBin = Map<ID | null, MediaItem[]>;
export function groupMediaByBin(media: Record<ID, MediaItem>, query: string, sort: SortKey): MediaByBin {
  const terms = searchTerms(query);
  const out: MediaByBin = new Map();
  for (const m of Object.values(media)) {
    if (terms.length && !mediaMatches(m, terms)) continue;
    const l = out.get(m.binId) ?? [];
    l.push(m);
    out.set(m.binId, l);
  }
  for (const l of out.values()) l.sort((a, b) => compareMedia(a, b, sort));
  return out;
}

/** The series tree with each list filtered by the search and sorted (memoised like groupMediaByBin). */
export function filterSortSeriesTree(tree: SeriesTree, query: string, sort: SortKey): SeriesTree {
  const terms = searchTerms(query);
  const visible = (list: MediaItem[]) => (terms.length ? list.filter((m) => mediaMatches(m, terms)) : list);
  // Name order is the tree's own (episode, then year); other sorts reorder each list.
  const sorted = (list: MediaItem[]) => (sort === 'name' ? list : [...list].sort((a, b) => compareMedia(a, b, sort)));
  return {
    series: tree.series.map((s) => ({ name: s.name, seasons: s.seasons.map((se) => ({ number: se.number, episodes: sorted(visible(se.episodes)) })) })),
    collections: tree.collections.map((c) => ({ name: c.name, items: sorted(visible(c.items)) })),
    loose: sorted(visible(tree.loose)),
  };
}

// ---------------------------------------------------------------- building

export interface BuildInput {
  media: Record<ID, MediaItem>;
  bins: Record<ID, Bin>;
  sequences: Record<ID, Sequence>;
  sequenceOrder: ID[];
  expanded: ExpandedMap;
  query: string;
  sort: SortKey;
  view: ViewMode;
  /** Cards per row in grid view. */
  cols: number;
}

function sceneRows(m: MediaItem, depth: number, terms: string[]): SceneRow[] {
  const out: SceneRow[] = [];
  m.detectedScenes.forEach((scene, index) => {
    if (terms.length && !textMatches(`${scene.name} ${scene.tags.join(' ')} ${scene.characters.join(' ')}`, terms) && !mediaMatches(m, terms)) return;
    out.push({ kind: 'scene', key: `scene:${scene.id}`, depth, media: m, scene, index });
  });
  return out;
}

function pushMedia(out: Row[], m: MediaItem, depth: number, input: BuildInput, terms: string[]): void {
  const expanded = m.detectedScenes.length > 0 && isExpanded(input.expanded, expandKey.scenes(m.id));
  out.push({ kind: 'media', key: `media:${m.id}`, depth, media: m, expanded });
  if (expanded) out.push(...sceneRows(m, depth + 1, terms));
}

function pushSequence(out: Row[], s: Sequence, depth: number, input: BuildInput): void {
  const parent = s.parentSequenceId ? input.sequences[s.parentSequenceId] : undefined;
  out.push({ kind: 'sequence', key: `seq:${s.id}`, depth, seq: s, parentName: parent?.name });
}

/** Collapse consecutive item rows into card rows for grid view; bins/groups stay as full-width rows. */
export function chunkCards(rows: Row[], cols: number): Row[] {
  const n = Math.max(1, cols);
  const out: Row[] = [];
  let buf: ItemRow[] = [];
  let depth = 0;
  const flush = () => {
    for (let i = 0; i < buf.length; i += n) out.push({ kind: 'cards', key: `cards:${buf[i].key}`, depth, items: buf.slice(i, i + n) });
    buf = [];
  };
  for (const r of rows) {
    if (r.kind === 'media' || r.kind === 'sequence' || r.kind === 'scene') {
      if (buf.length && depth !== r.depth) flush();
      depth = r.depth; buf.push(r);
    } else { flush(); out.push(r); }
  }
  flush();
  return out;
}

/** Bins mode: Project root → bins (nested) → sequences + media, scenes under media. */
export function buildBinRows(input: BuildInput, mediaIn: MediaByBin = groupMediaByBin(input.media, input.query, input.sort)): Row[] {
  const terms = searchTerms(input.query);
  const filtering = terms.length > 0;
  const allSeqs = input.sequenceOrder.map((id) => input.sequences[id]).filter((s): s is Sequence => !!s);
  const binList = Object.values(input.bins);
  const childBins = new Map<ID | null, Bin[]>();
  for (const b of binList) { const l = childBins.get(b.parentId) ?? []; l.push(b); childBins.set(b.parentId, l); }
  for (const l of childBins.values()) l.sort(byBinName);
  const seqIn = new Map<ID | null, Sequence[]>();
  for (const s of allSeqs) { if (filtering && !textMatches(s.name, terms)) continue; const l = seqIn.get(s.binId) ?? []; l.push(s); seqIn.set(s.binId, l); }
  for (const l of seqIn.values()) l.sort((a, b) => compareSequences(a, b, input.sort));

  // Count of items under each bin (recursive), used for filtering empty bins and the "(n)" count.
  const countCache = new Map<ID | null, number>();
  const countUnder = (binId: ID | null): number => {
    const hit = countCache.get(binId);
    if (hit !== undefined) return hit;
    let n = (mediaIn.get(binId)?.length ?? 0) + (seqIn.get(binId)?.length ?? 0);
    for (const b of childBins.get(binId) ?? []) n += countUnder(b.id);
    countCache.set(binId, n);
    return n;
  };

  const out: Row[] = [];
  const walk = (parentId: ID | null, depth: number) => {
    for (const b of childBins.get(parentId) ?? []) {
      const count = countUnder(b.id);
      const nameHit = filtering && textMatches(b.name, terms);
      if (filtering && count === 0 && !nameHit) continue;
      const expanded = filtering ? true : isExpanded(input.expanded, expandKey.bin(b.id));
      out.push({ kind: 'bin', key: `bin:${b.id}`, depth, bin: b, expanded, count });
      if (!expanded) continue;
      walk(b.id, depth + 1);
      for (const s of seqIn.get(b.id) ?? []) pushSequence(out, s, depth + 1, input);
      for (const m of mediaIn.get(b.id) ?? []) pushMedia(out, m, depth + 1, input, terms);
    }
  };
  const rootCount = countUnder(null);
  const rootExpanded = filtering ? true : isExpanded(input.expanded, expandKey.group('root'));
  out.push({ kind: 'group', key: 'grp:root', depth: 0, id: 'root', label: 'Project', groupKind: 'root', expanded: rootExpanded, count: rootCount });
  if (rootExpanded) {
    walk(null, 1);
    for (const s of seqIn.get(null) ?? []) pushSequence(out, s, 1, input);
    for (const m of mediaIn.get(null) ?? []) pushMedia(out, m, 1, input, terms);
  }
  return input.view === 'grid' ? chunkCards(out, input.cols) : out;
}

/** Series mode: Series → Season → Episodes; Collections → items; Loose; Sequences. */
export function buildSeriesRows(tree: SeriesTree, input: BuildInput, lists: SeriesTree = filterSortSeriesTree(tree, input.query, input.sort)): Row[] {
  const terms = searchTerms(input.query);
  const filtering = terms.length > 0;
  const out: Row[] = [];
  const group = (id: string, label: string, groupKind: GroupKind, depth: number, items: () => void, count: number) => {
    if (filtering && count === 0) return;
    const expanded = filtering ? true : isExpanded(input.expanded, expandKey.group(id));
    out.push({ kind: 'group', key: `grp:${id}`, depth, id, label, groupKind, expanded, count });
    if (expanded) items();
  };

  for (const s of lists.series) {
    const eps = s.seasons.reduce((n, se) => n + se.episodes.length, 0);
    group(`series:${s.name}`, s.name, 'series', 0, () => {
      for (const se of s.seasons) {
        const list = se.episodes;
        group(`season:${s.name}:${se.number}`, se.number === 0 ? 'Specials' : `Season ${se.number}`, 'season', 1, () => {
          for (const m of list) pushMedia(out, m, 2, input, terms);
        }, list.length);
      }
    }, eps);
  }
  for (const c of lists.collections) {
    const list = c.items;
    group(`collection:${c.name}`, c.name, 'collection', 0, () => { for (const m of list) pushMedia(out, m, 1, input, terms); }, list.length);
  }
  const loose = lists.loose;
  if (loose.length) group('loose', 'Other media', 'loose', 0, () => { for (const m of loose) pushMedia(out, m, 1, input, terms); }, loose.length);
  const seqs = input.sequenceOrder.map((id) => input.sequences[id]).filter((s): s is Sequence => !!s && (!filtering || textMatches(s.name, terms)))
    .sort((a, b) => compareSequences(a, b, input.sort));
  if (seqs.length) group('sequences', 'Timelines', 'sequences', 0, () => { for (const s of seqs) pushSequence(out, s, 1, input); }, seqs.length);
  return input.view === 'grid' ? chunkCards(out, input.cols) : out;
}

// ---------------------------------------------------------------- row identity

function sameFields(a: object, b: object): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
  return true;
}

/**
 * Keep the previous row object for every row whose content is unchanged (the same fields by identity; for a cards
 * row, the same items), so the memoised row views skip re-rendering when the tree is rebuilt: a change re-renders
 * only the rows that show something that changed. Returns `prev` itself when nothing changed.
 */
export function reuseRows(prev: readonly Row[] | null, next: Row[]): Row[] {
  if (!prev || prev.length === 0) return next;
  const old = new Map<string, Row>();
  for (const r of prev) {
    old.set(r.key, r);
    if (r.kind === 'cards') for (const it of r.items) old.set(it.key, it);
  }
  const keep = <T extends Row>(r: T): T => {
    const o = old.get(r.key);
    return o && o.kind === r.kind && sameFields(o, r) ? (o as T) : r;
  };
  let same = prev.length === next.length;
  const out = next.map((r, i) => {
    let k: Row;
    if (r.kind === 'cards') {
      const items = r.items.map(keep);
      const o = old.get(r.key);
      k = o && o.kind === 'cards' && o.depth === r.depth && o.items.length === items.length && o.items.every((it, j) => it === items[j]) ? o : { ...r, items };
    } else k = keep(r);
    if (k !== prev[i]) same = false;
    return k;
  });
  return same ? (prev as Row[]) : out;
}

/** Ids of selectable things in a row (for keyboard navigation / shift ranges). */
export function rowId(row: Row): string | null {
  switch (row.kind) {
    case 'media': return row.media.id;
    case 'sequence': return row.seq.id;
    case 'scene': return row.scene.id;
    case 'bin': return row.bin.id;
    default: return null;
  }
}
