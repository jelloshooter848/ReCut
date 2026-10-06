/**
 * Pure selectors over StoreState. None of these touch zustand; pass `useStore.getState()` or use them
 * inside `useStore((s) => ...)`.
 */
import type { Clip, ID, Marker, MediaItem, Rational, SceneRecord, Sequence, SubtitleCue, Track } from '../../shared/model';
import { allTracks, clipEnd, findClip, sequenceDuration, sourceTimeAt } from '../../shared/timeline';
import { formatSequenceSecondsTimecode, validFpsOr } from '../../shared/time';
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

const durationCache = new WeakMap<Track[], { audioTracks: Track[]; frames: number }>();
/**
 * End frame of the sequence's last clip (shared/timeline `sequenceDuration`), cached on the identity of its track
 * arrays. Selectors run on every store update (each playhead step while scrubbing or playing), and a scan over every
 * clip of a 6,700-clip sequence on each of them is a measurable part of the frame; edits replace the arrays.
 */
export function sequenceDurationOf(seq: Sequence | null | undefined): number {
  if (!seq) return 0;
  const hit = durationCache.get(seq.videoTracks);
  if (hit && hit.audioTracks === seq.audioTracks) return hit.frames;
  const frames = sequenceDuration(seq);
  durationCache.set(seq.videoTracks, { audioTracks: seq.audioTracks, frames });
  return frames;
}

/** Duration (frames) of the active sequence; cached like sequenceDurationOf. 0 when there is none. */
export function activeSequenceDuration(state: StoreState): number {
  return sequenceDurationOf(activeSequence(state));
}

export function clipById(seq: Sequence | null | undefined, id: ID): Clip | undefined {
  return seq ? findClip(seq, id)?.clip : undefined;
}

const NO_CLIPS: Clip[] = [];

/** Selection derived data for the active sequence, recomputed only when its tracks or the selection change. */
interface SelectionInfo {
  videoTracks: Track[]; audioTracks: Track[]; ids: readonly ID[];
  clips: Clip[]; tracks: Track[]; linkedAudio: Clip[] | null; linkedCount: number | null;
}
let selectionCache: SelectionInfo | null = null;

/**
 * Selected clips of the active sequence plus their tracks. Selectors run on every store update (each playhead
 * step), so this is cached on the identity of the sequence's track arrays and of `ui.selectedClipIds`: a scan
 * over every clip of the sequence happens once per edit or selection change, not once per update.
 */
function selectionInfo(state: StoreState): SelectionInfo | null {
  const seq = activeSequence(state);
  const ids = state.ui.selectedClipIds;
  if (!seq || ids.length === 0) return null;
  const c = selectionCache;
  if (c && c.videoTracks === seq.videoTracks && c.audioTracks === seq.audioTracks && c.ids === ids) return c;
  const want = new Set(ids);
  const clips: Clip[] = []; const tracks: Track[] = [];
  for (const t of allTracks(seq)) for (const cl of t.clips) if (want.has(cl.id)) { clips.push(cl); tracks.push(t); }
  selectionCache = { videoTracks: seq.videoTracks, audioTracks: seq.audioTracks, ids, clips, tracks, linkedAudio: null, linkedCount: null };
  return selectionCache;
}

export function selectedClips(state: StoreState): Clip[] {
  return selectionInfo(state)?.clips ?? NO_CLIPS;
}

/** The track of each clip of `selectedClips(state)` (same order). Cached like selectedClips. */
export function selectedClipTracks(state: StoreState): Track[] {
  return selectionInfo(state)?.tracks ?? [];
}

/**
 * Audio clips an edit of the selection's audio applies to: the selected audio clips plus the audio clips linked to
 * selected video clips (in selection order, each once). Cached like selectedClips.
 */
export function selectedAudioTargets(state: StoreState): Clip[] {
  const info = selectionInfo(state);
  if (!info) return NO_CLIPS;
  if (info.linkedAudio) return info.linkedAudio;
  const out: Clip[] = []; const seen = new Set<ID>();
  let byLink: Map<ID, Clip[]> | null = null;
  for (const c of info.clips) {
    if (c.kind === 'audio') { if (!seen.has(c.id)) { seen.add(c.id); out.push(c); } continue; }
    if (!c.linkId) continue;
    if (!byLink) {
      byLink = new Map();
      for (const t of info.audioTracks) for (const a of t.clips) if (a.linkId) { const g = byLink.get(a.linkId); if (g) g.push(a); else byLink.set(a.linkId, [a]); }
    }
    for (const a of byLink.get(c.linkId) ?? []) if (!seen.has(a.id)) { seen.add(a.id); out.push(a); }
  }
  info.linkedAudio = out;
  return out;
}

/** linkedClips(seq, clip).length for a single selected clip (0 otherwise). Cached like selectedClips. */
export function selectedLinkedCount(state: StoreState): number {
  const info = selectionInfo(state);
  if (!info || info.clips.length !== 1) return 0;
  if (info.linkedCount === null) {
    const clip = info.clips[0];
    let n = 0;
    if (!clip.linkId) n = 1;
    else for (const t of info.videoTracks) for (const c of t.clips) if (c.linkId === clip.linkId) n++;
    if (clip.linkId) for (const t of info.audioTracks) for (const c of t.clips) if (c.linkId === clip.linkId) n++;
    info.linkedCount = n;
  }
  return info.linkedCount;
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
    sourceTimecode: formatSequenceSecondsTimecode(sourceSeconds, mediaFps),
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
