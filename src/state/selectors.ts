/**
 * Pure selectors over StoreState. None of these touch zustand; pass `useStore.getState()` or use them
 * inside `useStore((s) => ...)`.
 */
import type { Clip, ID, Marker, MediaItem, Rational, SceneRecord, Sequence, SubtitleCue } from '../../shared/model';
import { allTracks, clipEnd, findClip, sourceTimeAt } from '../../shared/timeline';
import { formatSecondsTimecode, validFpsOr } from '../../shared/time';
import type { FilterState, StoreState } from './types';

export function activeSequence(state: StoreState): Sequence | null {
  const id = state.project.activeSequenceId;
  return id ? state.project.sequences[id] ?? null : null;
}

export function sequenceById(state: StoreState, id: ID | null | undefined): Sequence | null {
  return id ? state.project.sequences[id] ?? null : null;
}

export function sequenceFps(state: StoreState, seqId?: ID): Rational {
  const seq = seqId ? sequenceById(state, seqId) : activeSequence(state);
  return seq?.fps ?? { num: 24000, den: 1001 };
}

export function mediaById(state: StoreState, id: ID | null | undefined): MediaItem | undefined {
  return id ? state.project.media[id] : undefined;
}

/** Media duration lookup in seconds (Infinity when unknown / still image), shaped for shared/timeline.ts. */
export function mediaDuration(state: StoreState): (id: ID) => number {
  const media = state.project.media;
  return (id) => {
    const m = media[id];
    if (!m) return Infinity;
    if (m.kind === 'image') return Infinity;
    return m.probe?.duration ?? Infinity;
  };
}

export function clipById(seq: Sequence | null | undefined, id: ID): Clip | undefined {
  return seq ? findClip(seq, id)?.clip : undefined;
}

export function selectedClips(state: StoreState): Clip[] {
  const seq = activeSequence(state);
  if (!seq || state.ui.selectedClipIds.length === 0) return [];
  const ids = new Set(state.ui.selectedClipIds);
  const out: Clip[] = [];
  for (const t of allTracks(seq)) for (const c of t.clips) if (ids.has(c.id)) out.push(c);
  return out;
}

export function sequenceList(state: StoreState): Sequence[] {
  return state.project.sequenceOrder.map((id) => state.project.sequences[id]).filter((s): s is Sequence => !!s);
}

export function mediaList(state: StoreState): MediaItem[] {
  return Object.values(state.project.media).sort((a, b) => a.name.localeCompare(b.name));
}

export function mediaInBin(state: StoreState, binId: ID | null): MediaItem[] {
  return mediaList(state).filter((m) => m.binId === binId);
}

export function childBins(state: StoreState, parentId: ID | null) {
  return Object.values(state.project.bins).filter((b) => b.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name));
}

export function scenesForMedia(state: StoreState, mediaId: ID): SceneRecord[] {
  return Object.values(state.project.scenes).filter((s) => s.mediaId === mediaId).sort((a, b) => a.in - b.in);
}

/** All subtitle cues (seconds) attached to a media item across its subtitle tracks, sorted by start. */
export function mediaSubtitleCues(state: StoreState, mediaId: ID): SubtitleCue[] {
  const m = state.project.media[mediaId];
  if (!m) return [];
  const out: SubtitleCue[] = [];
  for (const tid of m.subtitleTrackIds) {
    const t = state.project.subtitleTracks[tid];
    if (t) out.push(...t.cues);
  }
  return out.sort((a, b) => a.start - b.start);
}

export function mediaSubtitleTracks(state: StoreState, mediaId: ID) {
  const m = state.project.media[mediaId];
  if (!m) return [];
  return m.subtitleTrackIds.map((id) => state.project.subtitleTracks[id]).filter((t) => !!t);
}

// ------------------------------------------------------------------
// Series / collection tree
// ------------------------------------------------------------------

export interface SeasonNode { number: number; episodes: MediaItem[] }
export interface SeriesNode { name: string; seasons: SeasonNode[] }
export interface CollectionNode { name: string; items: MediaItem[] }
export interface SeriesTree { series: SeriesNode[]; collections: CollectionNode[]; loose: MediaItem[] }

export function seriesTree(state: StoreState): SeriesTree {
  const series = new Map<string, Map<number, MediaItem[]>>();
  const collections = new Map<string, MediaItem[]>();
  const loose: MediaItem[] = [];
  for (const m of mediaList(state)) {
    const idn = m.identity;
    if (idn.series) {
      const seasons = series.get(idn.series) ?? new Map<number, MediaItem[]>();
      series.set(idn.series, seasons);
      const n = idn.season ?? 0;
      const list = seasons.get(n) ?? [];
      list.push(m);
      seasons.set(n, list);
    } else if (idn.collection || idn.franchise) {
      const key = idn.collection ?? idn.franchise!;
      const list = collections.get(key) ?? [];
      list.push(m);
      collections.set(key, list);
    } else loose.push(m);
  }
  const byEpisode = (a: MediaItem, b: MediaItem) => (a.identity.episode ?? 0) - (b.identity.episode ?? 0) || a.name.localeCompare(b.name);
  const byYear = (a: MediaItem, b: MediaItem) => (a.identity.year ?? 0) - (b.identity.year ?? 0) || a.name.localeCompare(b.name);
  return {
    series: [...series.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, seasons]) => ({
      name,
      seasons: [...seasons.entries()].sort((a, b) => a[0] - b[0]).map(([number, episodes]) => ({ number, episodes: episodes.sort(byEpisode) })),
    })),
    collections: [...collections.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, items]) => ({ name, items: items.sort(byYear) })),
    loose,
  };
}

// ------------------------------------------------------------------
// Story filters
// ------------------------------------------------------------------

export function filtersActive(filters: FilterState): boolean {
  return filters.characters.length + filters.plotlines.length + filters.locations.length + filters.tags.length > 0;
}

/**
 * A clip matches when it carries ANY of the selected characters / plotlines / locations / tags.
 * With no active filter every clip matches.
 */
export function filterMatches(clip: Clip, filters: FilterState): boolean {
  if (!filtersActive(filters)) return true;
  const any = (have: string[], want: string[]) => want.length > 0 && have.some((h) => want.includes(h));
  return any(clip.characters, filters.characters) || any(clip.plotlines, filters.plotlines)
    || any(clip.locations, filters.locations) || any(clip.tags, filters.tags);
}

// ------------------------------------------------------------------
// Continuity
// ------------------------------------------------------------------

export interface ContinuityIssue { sequenceId: ID; sequenceName: string; marker: Marker }

export function continuityIssues(state: StoreState): ContinuityIssue[] {
  const out: ContinuityIssue[] = [];
  for (const seq of sequenceList(state)) {
    for (const m of seq.markers) if (m.kind === 'continuity') out.push({ sequenceId: seq.id, sequenceName: seq.name, marker: m });
  }
  return out;
}

// ------------------------------------------------------------------
// Original source timecode
// ------------------------------------------------------------------

export interface OriginalTimecode { sourceSeconds: number; sourceTimecode: string; fileName: string; identityLabel: string }

export function fileNameOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

export function identityLabel(media: MediaItem | undefined): string {
  if (!media) return '';
  const idn = media.identity;
  const p = (n: number) => String(n).padStart(2, '0');
  if (idn.series) {
    const se = idn.season !== undefined || idn.episode !== undefined
      ? ` S${p(idn.season ?? 0)}${idn.episode !== undefined ? `E${p(idn.episode)}` : ''}` : '';
    return `${idn.series}${se}${idn.title ? ` › ${idn.title}` : ''}`;
  }
  const parent = idn.franchise ?? idn.collection;
  const title = idn.title ?? media.name;
  return parent ? `${parent} › ${title}` : title;
}

export function originalTimecode(clip: Clip, frame: number, fps: Rational, media: MediaItem | undefined): OriginalTimecode {
  const f = Math.max(clip.start, Math.min(clipEnd(clip) - 1, frame));
  const sourceSeconds = Math.max(0, sourceTimeAt(clip, f, fps));
  const mediaFps = validFpsOr(media?.probe?.video?.fps, fps);
  return {
    sourceSeconds,
    sourceTimecode: formatSecondsTimecode(sourceSeconds, mediaFps),
    fileName: media ? fileNameOf(media.path) : '',
    identityLabel: identityLabel(media),
  };
}

export function undoLabels(state: StoreState): { undo: string | null; redo: string | null } {
  const h = state.history;
  return {
    undo: h.past.length ? h.pastLabels[h.pastLabels.length - 1] ?? '' : null,
    redo: h.future.length ? h.futureLabels[h.futureLabels.length - 1] ?? '' : null,
  };
}
