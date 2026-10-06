/**
 * Project panel tree (src/panels/project/tree.ts), roadmap §1 perf G:
 *  - the media sort uses one module-level Intl.Collator instead of localeCompare(…, options) per comparison, and the
 *    order is exactly the one localeCompare gave (numeric runs, case and accents, ties, every sort key);
 *  - the sort is a separate stage (groupMediaByBin / filterSortSeriesTree) the panel memoises on the media, the search
 *    and the sort only; building the rows from it gives the same rows as before;
 *  - reuseRows keeps unchanged row objects so the memoised row views skip re-rendering.
 */
import { describe, it, expect } from 'vitest';
import { createMediaItem, createSequence } from '../../shared/project';
import type { Bin, ID, MediaItem, Sequence } from '../../shared/model';
import { seriesTree } from '../../src/state/selectors';
import type { StoreState } from '../../src/state/types';
import {
  SORT_OPTIONS, buildBinRows, buildSeriesRows, compareMedia, compareNames, compareSequences, filterSortSeriesTree, groupMediaByBin, mediaMatches, reuseRows, searchTerms,
  type BuildInput, type Row, type SortKey,
} from '../../src/panels/project/tree';

/** The comparators as they were (localeCompare per comparison): the reference order. */
function refCompareMedia(a: MediaItem, b: MediaItem, sort: SortKey): number {
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
      if (a.identity.series && a.identity.series === b.identity.series) {
        const d = ((a.identity.season ?? 0) - (b.identity.season ?? 0)) || ((a.identity.episode ?? 0) - (b.identity.episode ?? 0));
        if (d) return d;
      }
      return byName;
    }
  }
}
function refCompareSequences(a: Sequence, b: Sequence, sort: SortKey): number {
  const byName = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  if (sort === 'added') return (b.createdAt - a.createdAt) || byName;
  return byName;
}

const NAMES = [
  'Episode 10', 'Episode 2', 'episode 1', 'EPISODE 1', 'Episode 01', 'Episode 1b', 'Episode 1.5', 'Episode -3', 'Ep 100', 'ep 20',
  'alpha', 'Alpha', 'ALPHA', 'Älpha', 'alpha2', 'alpha10', 'alpha 10', 'Zeta', 'zeta', 'Éclair', 'eclair', 'Eclair', 'ecLair 2',
  'S01E03', 's01e10', 'S1E2', 'Star Wars 4', 'Star Wars IV', 'Star Wars 10', 'star wars 9', '', ' ', '007', '7', '0007 Bond', '10', '9',
  'a-b', 'a_b', 'a b', 'ab', 'a.b', 'Straße', 'Strasse', 'résumé', 'resume', '日本 2', '日本 10', '🎬 clip', 'clip 🎬', 'x́', 'ẋ',
];

let seq = 0;
function media(name: string, over: Partial<MediaItem> = {}, identity: Partial<MediaItem['identity']> = {}): MediaItem {
  const m = createMediaItem(`/m/${seq}.mp4`, name);
  return { ...m, id: `m${seq++}`, ...over, identity: { ...m.identity, ...identity } };
}
function probe(duration: number, w: number, h: number): MediaItem['probe'] {
  return { duration, video: { width: w, height: h } } as unknown as MediaItem['probe'];
}

/** A varied media set: ties on every sort key, series with seasons / episodes, categories, missing probes. */
function mediaSet(): MediaItem[] {
  const out: MediaItem[] = [];
  const cats = ['Movie', 'Episode', 'movie', 'Other', 'Trailer', 'épisode'];
  NAMES.forEach((name, i) => {
    out.push(media(name, {
      category: cats[i % cats.length] as MediaItem['category'],
      addedAt: 1000 + (i % 7),
      probe: i % 5 === 0 ? undefined : probe(i % 4 === 0 ? 60 : 30 + (i % 3), [1920, 1280, 3840][i % 3], [1080, 720, 2160][i % 3]),
      binId: i % 3 === 0 ? 'b1' : null,
    }, i % 4 === 0 ? { series: i % 8 === 0 ? 'Station Eleven' : 'station eleven', season: i % 3, episode: (i * 7) % 5 } : i % 4 === 1 ? { collection: 'Galaxy Saga', year: 1977 + (i % 3) } : {}));
  });
  return out;
}

const sortedBy = (list: MediaItem[], cmp: (a: MediaItem, b: MediaItem) => number) => [...list].sort(cmp).map((m) => m.id);

describe('media sort: one collator, the same order as localeCompare(…, { numeric, sensitivity: base })', () => {
  it('compareNames agrees in sign with localeCompare on every pair', () => {
    for (const a of NAMES) for (const b of NAMES) {
      expect([a, b, Math.sign(compareNames(a, b))]).toEqual([a, b, Math.sign(a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))]);
    }
  });

  it('numeric runs compare as numbers; case and accents do not order (base sensitivity)', () => {
    expect(compareNames('Episode 2', 'Episode 10')).toBeLessThan(0);
    expect(compareNames('alpha2', 'alpha10')).toBeLessThan(0);
    expect(compareNames('9', '10')).toBeLessThan(0);
    expect(compareNames('Episode 1', 'Episode 01')).toBe(0);
    expect(compareNames('alpha', 'ALPHA')).toBe(0);
    expect(compareNames('Éclair', 'eclair')).toBe(0);
    expect(compareNames('Zeta', 'alpha')).toBeGreaterThan(0);
    const names = ['Episode 10', 'episode 2', 'Episode 1', 'EPISODE 3', 'Episode 21'];
    expect([...names].sort(compareNames)).toEqual(['Episode 1', 'episode 2', 'EPISODE 3', 'Episode 10', 'Episode 21']);
    // Ties keep their input order (stable sort), as before.
    expect(['b', 'A', 'a', 'B'].sort(compareNames)).toEqual(['A', 'a', 'b', 'B']);
  });

  it('compareMedia / compareSequences sort exactly as before for every sort key', () => {
    const list = mediaSet();
    for (const { value: sort } of SORT_OPTIONS) {
      expect(sortedBy(list, (a, b) => compareMedia(a, b, sort))).toEqual(sortedBy(list, (a, b) => refCompareMedia(a, b, sort)));
      expect(sortedBy([...list].reverse(), (a, b) => compareMedia(a, b, sort))).toEqual(sortedBy([...list].reverse(), (a, b) => refCompareMedia(a, b, sort)));
    }
    const seqs = NAMES.map((n, i) => ({ ...createSequence(n), id: `s${i}`, createdAt: 5 + (i % 4) }));
    for (const { value: sort } of SORT_OPTIONS) {
      expect([...seqs].sort((a, b) => compareSequences(a, b, sort)).map((s) => s.id)).toEqual([...seqs].sort((a, b) => refCompareSequences(a, b, sort)).map((s) => s.id));
    }
  });
});

describe('sort stage memoised apart from the rows', () => {
  const list = mediaSet();
  const mediaMap: Record<ID, MediaItem> = Object.fromEntries(list.map((m) => [m.id, m]));
  const bins: Record<ID, Bin> = { b1: { id: 'b1', name: 'Bin 1', parentId: null, kind: 'bin' } as Bin };
  const s1 = { ...createSequence('Cut 10'), id: 'q1', createdAt: 1 };
  const s2 = { ...createSequence('cut 2'), id: 'q2', createdAt: 2 };
  const input = (over: Partial<BuildInput> = {}): BuildInput => ({
    media: mediaMap, bins, sequences: { q1: s1, q2: s2 }, sequenceOrder: ['q1', 'q2'], expanded: {}, query: '', sort: 'name', view: 'list', cols: 3, ...over,
  });
  const ids = (rows: Row[]) => rows.map((r) => r.key);

  it('groupMediaByBin lists each bin\'s media in the reference order, filtered by the search', () => {
    for (const { value: sort } of SORT_OPTIONS) {
      for (const query of ['', 'episode', 'station']) {
        const g = groupMediaByBin(mediaMap, query, sort);
        for (const bin of [null, 'b1']) {
          const want = sortedBy(list.filter((m) => m.binId === bin && mediaMatches(m, searchTerms(query))), (a, b) => refCompareMedia(a, b, sort));
          expect((g.get(bin) ?? []).map((m) => m.id)).toEqual(want);
        }
      }
    }
  });

  it('rows built from the memoised stage equal rows built in one go (bins and series, list and grid, searching)', () => {
    const tree = seriesTree({ project: { media: mediaMap } } as unknown as StoreState);
    for (const { value: sort } of SORT_OPTIONS) {
      for (const over of [{}, { query: 'ep' }, { view: 'grid' as const }, { expanded: { 'bin:b1': false } }]) {
        const inp = input({ sort, ...over });
        expect(buildBinRows(inp, groupMediaByBin(inp.media, inp.query, inp.sort))).toEqual(buildBinRows(inp));
        expect(buildSeriesRows(tree, inp, filterSortSeriesTree(tree, inp.query, inp.sort))).toEqual(buildSeriesRows(tree, inp));
      }
    }
    // Series mode lists each season / collection in the reference order.
    const lists = filterSortSeriesTree(tree, '', 'duration');
    for (const [i, s] of tree.series.entries()) for (const [j, se] of s.seasons.entries()) {
      expect(lists.series[i].seasons[j].episodes.map((m) => m.id)).toEqual(sortedBy(se.episodes, (a, b) => refCompareMedia(a, b, 'duration')));
    }
  });

  it('sequences sort numerically and case-insensitively in the tree', () => {
    const rows = buildBinRows(input());
    expect(ids(rows).filter((k) => k.startsWith('seq:'))).toEqual(['seq:q2', 'seq:q1']);
  });
});

describe('reuseRows keeps unchanged rows', () => {
  const list = mediaSet().slice(0, 12);
  const mediaMap: Record<ID, MediaItem> = Object.fromEntries(list.map((m) => [m.id, m]));
  const bins = { b1: { id: 'b1', name: 'Bin 1', parentId: null, kind: 'bin' } as Bin };
  const sequences = { q1: { ...createSequence('Cut'), id: 'q1' } };
  const base = (over: Partial<BuildInput> = {}): BuildInput => ({
    media: mediaMap, bins, sequences,
    sequenceOrder: ['q1'], expanded: {}, query: '', sort: 'name', view: 'list', cols: 3, ...over,
  });

  it('returns the previous array when nothing changed, and the previous row objects for unchanged rows', () => {
    const a = buildBinRows(base());
    const b = buildBinRows(base());
    expect(b).not.toBe(a);
    expect(reuseRows(a, b)).toBe(a);
    // A new sequence object (a timeline edit) with the same visible fields: rows unchanged.
    const seq2 = { ...base().sequences.q1 };
    expect(reuseRows(a, buildBinRows(base({ sequences: { q1: seq2 } }))).filter((r, i) => r !== a[i]).map((r) => r.key)).toEqual(['seq:q1']);
    // One media item changes: only its row is new.
    const changed = { ...mediaMap[list[3].id], offline: true };
    const c = reuseRows(a, buildBinRows(base({ media: { ...mediaMap, [changed.id]: changed } })));
    expect(c).not.toBe(a);
    expect(c.filter((r, i) => r !== a[i]).map((r) => r.key)).toEqual([`media:${changed.id}`]);
  });

  it('keeps cards rows whose items are unchanged (grid view)', () => {
    const a = buildBinRows(base({ view: 'grid' }));
    expect(reuseRows(a, buildBinRows(base({ view: 'grid' })))).toBe(a);
    const changed = { ...mediaMap[list[3].id], name: `${mediaMap[list[3].id].name} (renamed)` };
    const c = reuseRows(a, buildBinRows(base({ view: 'grid', media: { ...mediaMap, [changed.id]: changed } })));
    const fresh = c.filter((r, i) => r !== a[i]);
    expect(fresh.length).toBeGreaterThan(0);
    for (const r of fresh) {
      expect(r.kind).toBe('cards');
      if (r.kind === 'cards') expect(r.items.filter((it) => it.kind === 'media' && it.media === changed)).toHaveLength(1);
    }
    // Inside a changed cards row, the unchanged items keep their objects.
    const prevItems = new Set(a.flatMap((r) => (r.kind === 'cards' ? r.items : [])));
    for (const r of fresh) if (r.kind === 'cards') for (const it of r.items) if (!(it.kind === 'media' && it.media === changed)) expect(prevItems.has(it)).toBe(true);
  });
});
