/**
 * Pure helpers for the Storyline panel (no DOM, no store).
 */
import type { Clip, Rational, Sequence, StoryBlock } from '@shared/model';
import { allTracks, clipEnd, sequenceDuration } from '@shared/timeline';
import { framesToSeconds } from '@shared/time';
import type { FilterState } from '@/state/types';
import { filterMatches, filtersActive } from '@/state/selectors';
import { LABEL_COLORS } from '@/components/ui/ColorSwatch';

export type TagKind = 'characters' | 'plotlines' | 'locations' | 'tags';
export const TAG_KINDS: { kind: TagKind; title: string }[] = [
  { kind: 'characters', title: 'Characters' },
  { kind: 'plotlines', title: 'Plotlines' },
  { kind: 'locations', title: 'Locations' },
  { kind: 'tags', title: 'Tags' },
];

export interface TagCount { value: string; count: number }

/** Distinct clip "groups": linked video+audio pairs count once. */
function groupKey(c: Clip): string { return c.linkId ?? c.id; }

/** Every tag value present in the sequence's clips with the number of clip groups carrying it. */
export function tagCounts(seq: Sequence): Record<TagKind, TagCount[]> {
  const maps: Record<TagKind, Map<string, Set<string>>> = { characters: new Map(), plotlines: new Map(), locations: new Map(), tags: new Map() };
  for (const t of allTracks(seq)) {
    for (const c of t.clips) {
      for (const { kind } of TAG_KINDS) {
        for (const v of c[kind]) {
          const set = maps[kind].get(v) ?? new Set<string>();
          set.add(groupKey(c));
          maps[kind].set(v, set);
        }
      }
    }
  }
  const out = {} as Record<TagKind, TagCount[]>;
  for (const { kind } of TAG_KINDS) {
    out[kind] = [...maps[kind].entries()].map(([value, set]) => ({ value, count: set.size })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }
  return out;
}

/** Stable color per character within a sequence (alphabetical → label palette). */
export function characterPalette(seq: Sequence): Map<string, string> {
  const names = new Set<string>();
  for (const t of seq.videoTracks) for (const c of t.clips) for (const ch of c.characters) names.add(ch);
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  const map = new Map<string, string>();
  sorted.forEach((n, i) => map.set(n, LABEL_COLORS[i % LABEL_COLORS.length].hex));
  return map;
}

export const NO_CHARACTER_COLOR = '#5a5a5a';

export function clipColor(c: Clip, palette: Map<string, string>): string {
  const first = c.characters[0];
  return (first && palette.get(first)) || NO_CHARACTER_COLOR;
}

/** Visible extent of the story strip in frames: sequence duration, blocks and markers, with a little headroom. */
export function stripExtent(seq: Sequence): number {
  let end = sequenceDuration(seq);
  for (const b of seq.storyBlocks) end = Math.max(end, b.end);
  for (const m of seq.markers) end = Math.max(end, m.time + m.duration + 1);
  if (end <= 0) end = Math.round((seq.fps.num / seq.fps.den) * 60); // one empty minute
  return Math.ceil(end * 1.02);
}

/** Clips (any track) that overlap [start, end). */
export function clipsOverlapping(seq: Sequence, start: number, end: number, opts: { videoOnly?: boolean } = {}): Clip[] {
  const tracks = opts.videoOnly ? seq.videoTracks : allTracks(seq);
  const out: Clip[] = [];
  for (const t of tracks) for (const c of t.clips) if (c.start < end && clipEnd(c) > start) out.push(c);
  return out;
}

export interface BlockStats { clipCount: number; characters: string[]; durationFrames: number; percent: number }

export function blockStats(seq: Sequence, b: StoryBlock, totalFrames: number): BlockStats {
  const clips = clipsOverlapping(seq, b.start, b.end, { videoOnly: true });
  const chars = new Set<string>();
  for (const c of clips) for (const ch of c.characters) chars.add(ch);
  const durationFrames = Math.max(0, b.end - b.start);
  return {
    clipCount: clips.length,
    characters: [...chars].sort((x, y) => x.localeCompare(y)),
    durationFrames,
    percent: totalFrames > 0 ? (durationFrames / totalFrames) * 100 : 0,
  };
}

/** Frames every clip edge, in/out point and the sequence bounds sit on (for snapping). */
export function snapTargets(seq: Sequence): number[] {
  const set = new Set<number>([0, sequenceDuration(seq)]);
  for (const t of seq.videoTracks) for (const c of t.clips) { set.add(c.start); set.add(clipEnd(c)); }
  if (seq.view.inPoint !== null) set.add(seq.view.inPoint);
  if (seq.view.outPoint !== null) set.add(seq.view.outPoint);
  for (const m of seq.markers) set.add(m.time);
  return [...set].sort((a, b) => a - b);
}

/** Snap `frame` to the nearest target within `thresholdFrames`; returns the frame unchanged when none is close. */
export function snapFrame(frame: number, targets: number[], thresholdFrames: number): number {
  let best = frame;
  let bestDist = thresholdFrames;
  for (const t of targets) {
    const d = Math.abs(t - frame);
    if (d <= bestDist) { best = t; bestDist = d; }
  }
  return best;
}

/** HH:MM:SS from frames. */
export function formatHMS(frames: number, fps: Rational): string {
  const neg = frames < 0;
  const total = Math.round(framesToSeconds(Math.abs(frames), fps));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${neg ? '-' : ''}${p(h)}:${p(m)}:${p(s)}`;
}

/** MM:SS (or H:MM:SS) from frames, used for compact deltas. */
export function formatMS(frames: number, fps: Rational): string {
  const total = Math.round(framesToSeconds(Math.abs(frames), fps));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

export interface WhatIf {
  /** Frames of matching clips on V1 (approximation of removed runtime). */
  matchingV1Frames: number;
  /** Estimated runtime after removing matching clips. */
  runtimeIfRemoved: number;
  /** Estimated runtime if only matching clips stay. */
  runtimeIfKept: number;
  matchingCount: number;
  nonMatchingCount: number;
}

export function whatIf(seq: Sequence, filters: FilterState): WhatIf | null {
  if (!filtersActive(filters)) return null;
  const total = sequenceDuration(seq);
  const v1 = seq.videoTracks[0];
  let matchingV1 = 0;
  if (v1) for (const c of v1.clips) if (filterMatches(c, filters)) matchingV1 += c.duration;
  let matching = 0, non = 0;
  for (const t of allTracks(seq)) for (const c of t.clips) { if (filterMatches(c, filters)) matching++; else non++; }
  return {
    matchingV1Frames: matchingV1,
    runtimeIfRemoved: Math.max(0, total - matchingV1),
    runtimeIfKept: matchingV1,
    matchingCount: matching,
    nonMatchingCount: non,
  };
}

/** Pick a readable text color for a block background. */
export function contrastText(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return '#fff';
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16) / 255);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.6 ? '#111' : '#fff';
}

export const BLOCK_PRESET_NAMES = ['Opening', 'Act I', 'Act II', 'Act III', 'Climax', 'Resolution', 'Character Arc A', 'Character Arc B', 'Subplot', 'Montage'];
