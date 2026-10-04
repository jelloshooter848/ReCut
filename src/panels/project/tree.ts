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

export function compareMedia(a: MediaItem, b: MediaItem, sort: SortKey): number {
  const byName = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  switch (sort) {
    case 'duration': return ((b.probe?.duration ?? -1) - (a.probe?.duration ?? -1)) || byName;
    case 'added': return (b.addedAt - a.addedAt) || byName;
    case 'category': return a.category.localeCompare(b.category) || byName;
    case 'resolution': {
      const px = (m: MediaItem) => (m.probe?.video ? m.probe.video.width * m.probe.video.height : -1);
      return (px(b) - px(a)) || byName;
    }
    default: {
      // Episodes in order when they share a series
      if (a.identity.series && a.identity.series === b.identity.series) {
        const d = ((a.identity.season ?? 0) - (b.identity.season ?? 0)) || ((a.identity.episode ?? 0) - (b.identity.episode ?? 0));
        if (d) return d;
      }
      return byName;
    }
  }
}
export function compareSequences(a: Sequence, b: Sequence, sort: SortKey): number {
  const byName = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  if (sort === 'added') return (b.createdAt - a.createdAt) || byName;
  return byName;
}
const byBinName = (a: Bin, b: Bin) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

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
export function buildBinRows(input: BuildInput): Row[] {
  const terms = searchTerms(input.query);
  const filtering = terms.length > 0;
  const allMedia = Object.values(input.media);
  const allSeqs = input.sequenceOrder.map((id) => input.sequences[id]).filter((s): s is Sequence => !!s);
  const binList = Object.values(input.bins);
  const childBins = new Map<ID | null, Bin[]>();
  for (const b of binList) { const l = childBins.get(b.parentId) ?? []; l.push(b); childBins.set(b.parentId, l); }
  for (const l of childBins.values()) l.sort(byBinName);
  const mediaIn = new Map<ID | null, MediaItem[]>();
  for (const m of allMedia) { if (filtering && !mediaMatches(m, terms)) continue; const l = mediaIn.get(m.binId) ?? []; l.push(m); mediaIn.set(m.binId, l); }
  for (const l of mediaIn.values()) l.sort((a, b) => compareMedia(a, b, input.sort));
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
export function buildSeriesRows(tree: SeriesTree, input: BuildInput): Row[] {
  const terms = searchTerms(input.query);
  const filtering = terms.length > 0;
  const out: Row[] = [];
  const group = (id: string, label: string, groupKind: GroupKind, depth: number, items: () => void, count: number) => {
    if (filtering && count === 0) return;
    const expanded = filtering ? true : isExpanded(input.expanded, expandKey.group(id));
    out.push({ kind: 'group', key: `grp:${id}`, depth, id, label, groupKind, expanded, count });
    if (expanded) items();
  };
  const visible = (list: MediaItem[]) => (filtering ? list.filter((m) => mediaMatches(m, terms)) : list);
  const sorted = (list: MediaItem[]) => (input.sort === 'name' ? list : [...list].sort((a, b) => compareMedia(a, b, input.sort)));

  for (const s of tree.series) {
    const eps = s.seasons.reduce((n, se) => n + visible(se.episodes).length, 0);
    group(`series:${s.name}`, s.name, 'series', 0, () => {
      for (const se of s.seasons) {
        const list = sorted(visible(se.episodes));
        group(`season:${s.name}:${se.number}`, se.number === 0 ? 'Specials' : `Season ${se.number}`, 'season', 1, () => {
          for (const m of list) pushMedia(out, m, 2, input, terms);
        }, list.length);
      }
    }, eps);
  }
  for (const c of tree.collections) {
    const list = sorted(visible(c.items));
    group(`collection:${c.name}`, c.name, 'collection', 0, () => { for (const m of list) pushMedia(out, m, 1, input, terms); }, list.length);
  }
  const loose = sorted(visible(tree.loose));
  if (loose.length) group('loose', 'Loose media', 'loose', 0, () => { for (const m of loose) pushMedia(out, m, 1, input, terms); }, loose.length);
  const seqs = input.sequenceOrder.map((id) => input.sequences[id]).filter((s): s is Sequence => !!s && (!filtering || textMatches(s.name, terms)))
    .sort((a, b) => compareSequences(a, b, input.sort));
  if (seqs.length) group('sequences', 'Sequences', 'sequences', 0, () => { for (const s of seqs) pushSequence(out, s, 1, input); }, seqs.length);
  return input.view === 'grid' ? chunkCards(out, input.cols) : out;
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
