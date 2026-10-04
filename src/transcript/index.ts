/**
 * Transcript search index: a pure, project-wide index over media subtitle cues.
 *
 * Build once per project (memoize on `project.subtitleTracks` / `project.media` identity) and query it with
 * `searchTranscript`. No DOM, no store — safe to unit-test under node.
 */
import type { Clip, ID, MediaItem, Project, Rational, Sequence, SubtitleCue } from '../../shared/model';
import { clipSourceOut } from '../../shared/timeline';
import { identityLabel } from '../state/selectors';

// ------------------------------------------------------------------
// Index
// ------------------------------------------------------------------

export interface ScopeKeys { series?: string; season?: string; franchise?: string; collection?: string }

export interface TranscriptEntry {
  mediaId: ID;
  trackId: ID;
  /** Position of the cue within its track (for context lookup). */
  cueIndex: number;
  cue: SubtitleCue;
  mediaName: string;
  /** Human label, e.g. "Station Eleven S01E02" (falls back to the media name). */
  label: string;
  language: string;
  scopeKeys: ScopeKeys;
}

export interface TranscriptIndexStats { mediaWithTranscripts: number; cues: number; tracks: number }

export interface TranscriptIndex {
  project: Project;
  /** All entries, ordered by media (display order) then cue start. */
  entries: TranscriptEntry[];
  byMedia: Map<ID, TranscriptEntry[]>;
  /** Media ids in display order (series › season › episode, then name). */
  mediaOrder: ID[];
  stats: TranscriptIndexStats;
}

const SEASON_SEP = '\u001f';

/** Scope value for `{ kind: 'season' }`: encodes series + season number. */
export function seasonScopeValue(series: string, season: number | undefined): string {
  return `${series}${SEASON_SEP}${season ?? 0}`;
}
export function parseSeasonScopeValue(value: string): { series: string; season: number } {
  const i = value.lastIndexOf(SEASON_SEP);
  if (i < 0) return { series: value, season: 0 };
  return { series: value.slice(0, i), season: Number(value.slice(i + 1)) || 0 };
}

function scopeKeysOf(m: MediaItem): ScopeKeys {
  const idn = m.identity ?? {};
  return {
    series: idn.series,
    season: idn.series ? seasonScopeValue(idn.series, idn.season) : undefined,
    franchise: idn.franchise,
    collection: idn.collection,
  };
}

/** Display order: series name, season, episode, then year/name. Loose items sort by name after series items. */
export function compareMediaForDisplay(a: MediaItem, b: MediaItem): number {
  const ia = a.identity ?? {}; const ib = b.identity ?? {};
  const ga = ia.series ?? ia.franchise ?? ia.collection ?? '';
  const gb = ib.series ?? ib.franchise ?? ib.collection ?? '';
  if (ga !== gb) {
    if (!ga) return 1; if (!gb) return -1;
    return ga.localeCompare(gb);
  }
  const d = (ia.season ?? 0) - (ib.season ?? 0) || (ia.episode ?? 0) - (ib.episode ?? 0) || (ia.year ?? 0) - (ib.year ?? 0);
  return d || a.name.localeCompare(b.name);
}

export function buildTranscriptIndex(project: Project): TranscriptIndex {
  const entries: TranscriptEntry[] = [];
  const byMedia = new Map<ID, TranscriptEntry[]>();
  const mediaOrder: ID[] = [];
  let tracks = 0;
  const mediaSorted = Object.values(project.media).sort(compareMediaForDisplay);
  for (const m of mediaSorted) {
    const label = identityLabel(m) || m.name;
    const keys = scopeKeysOf(m);
    const list: TranscriptEntry[] = [];
    for (const tid of m.subtitleTrackIds) {
      const t = project.subtitleTracks[tid];
      if (!t || t.cues.length === 0) continue;
      tracks++;
      // Tracks are stored sorted by parseSubtitles; keep the stored order so cueIndex ±1 is the neighbouring line.
      t.cues.forEach((cue, cueIndex) => {
        list.push({ mediaId: m.id, trackId: t.id, cueIndex, cue, mediaName: m.name, label, language: t.language, scopeKeys: keys });
      });
    }
    if (list.length === 0) continue;
    list.sort((a, b) => a.cue.start - b.cue.start || a.trackId.localeCompare(b.trackId) || a.cueIndex - b.cueIndex);
    byMedia.set(m.id, list);
    mediaOrder.push(m.id);
    entries.push(...list);
  }
  return { project, entries, byMedia, mediaOrder, stats: { mediaWithTranscripts: byMedia.size, cues: entries.length, tracks } };
}

// ------------------------------------------------------------------
// Query parsing
// ------------------------------------------------------------------

export type ScopeKind = 'project' | 'media' | 'series' | 'season' | 'franchise' | 'collection' | 'sequence';
export interface SearchScope { kind: ScopeKind; value?: string; mediaId?: string; sequenceId?: string }
export interface SearchOptions { limit?: number; regex?: boolean; wholeWord?: boolean; caseSensitive?: boolean }

export interface QueryTerm { text: string; phrase: boolean }

/** Split a query into AND-ed terms; "quoted phrases" stay together. */
export function parseQueryTerms(query: string): QueryTerm[] {
  const out: QueryTerm[] = [];
  const re = /"([^"]*)"|“([^”]*)”|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query))) {
    const phrase = m[1] ?? m[2];
    if (phrase !== undefined) { const p = phrase.trim(); if (p) out.push({ text: p, phrase: true }); }
    else if (m[3]) out.push({ text: m[3].replace(/^"+|"+$/g, ''), phrase: false });
  }
  return out.filter((t) => t.text.length > 0);
}

export function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export interface CompiledQuery { matchers: RegExp[]; error?: string }

/** Compile the query into one regex per AND-term (all must match a cue's text). */
export function compileQuery(query: string, opts: SearchOptions = {}): CompiledQuery {
  const flags = opts.caseSensitive ? 'g' : 'gi';
  const q = query.trim();
  if (!q) return { matchers: [] };
  if (opts.regex) {
    try {
      const src = opts.wholeWord ? `\\b(?:${q})\\b` : q;
      const re = new RegExp(src, flags);
      // Reject patterns that match the empty string: they would flag every cue.
      if (re.test('')) return { matchers: [], error: 'Pattern matches empty text' };
      return { matchers: [new RegExp(src, flags)] };
    } catch (e) {
      return { matchers: [], error: e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '') : 'Invalid regular expression' };
    }
  }
  const terms = parseQueryTerms(q);
  return {
    matchers: terms.map((t) => {
      // Phrases match across any whitespace (cue text may wrap lines).
      const body = t.phrase ? t.text.split(/\s+/).map(escapeRegExp).join('\\s+') : escapeRegExp(t.text);
      const src = opts.wholeWord || t.phrase ? `(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])` : body;
      return new RegExp(src, flags + 'u');
    }),
  };
}

/** Character ranges [start, end) matched by all matchers, merged and sorted. Empty when any matcher fails. */
export function matchRanges(text: string, matchers: RegExp[]): [number, number][] | null {
  if (matchers.length === 0) return null;
  const ranges: [number, number][] = [];
  for (const re of matchers) {
    re.lastIndex = 0;
    let found = false;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      found = true;
      if (m[0].length === 0) { re.lastIndex++; continue; }
      ranges.push([m.index, m.index + m[0].length]);
    }
    if (!found) return null;
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** Split text into alternating plain/highlighted segments for rendering. */
export function highlightSegments(text: string, ranges: [number, number][]): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let pos = 0;
  for (const [s, e] of ranges) {
    if (s > pos) out.push({ text: text.slice(pos, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    pos = e;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}

// ------------------------------------------------------------------
// Search
// ------------------------------------------------------------------

export interface TimelineHit {
  sequenceId: ID;
  clipId: ID;
  clipName: string;
  trackId: ID;
  /** Timeline frame where the cue starts (clamped to the clip). */
  frame: number;
  /** Timeline frame where the cue ends (clamped to the clip). */
  endFrame: number;
}

export interface TranscriptMatch {
  entry: TranscriptEntry;
  before: string;
  after: string;
  ranges: [number, number][];
  /** Sequence scope only: where this moment appears on the timeline. */
  timeline?: TimelineHit[];
}

export interface MediaGroup { mediaId: ID; mediaName: string; label: string; matches: TranscriptMatch[] }

export interface SearchResult {
  query: string;
  scope: SearchScope;
  /** Flat matches, sorted by media display order then cue start. */
  matches: TranscriptMatch[];
  groups: MediaGroup[];
  total: number;
  truncated: boolean;
  error?: string;
}

function emptyResult(query: string, scope: SearchScope, error?: string): SearchResult {
  return { query, scope, matches: [], groups: [], total: 0, truncated: false, error };
}

/** Media ids used by clips in a sequence. */
export function sequenceMediaIds(seq: Sequence): Set<ID> {
  const ids = new Set<ID>();
  for (const t of seq.videoTracks) for (const c of t.clips) ids.add(c.mediaId);
  for (const t of seq.audioTracks) for (const c of t.clips) ids.add(c.mediaId);
  return ids;
}

/** Timeline positions where source range [start, end) of `mediaId` appears in `seq` (video clips first; audio only when unlinked). */
export function timelineHitsFor(seq: Sequence, mediaId: ID, start: number, end: number): TimelineHit[] {
  const out: TimelineHit[] = [];
  const fps: Rational = seq.fps;
  const seenLinks = new Set<ID>();
  const consider = (c: Clip, trackId: ID) => {
    if (c.mediaId !== mediaId) return;
    if (c.linkId) { if (seenLinks.has(c.linkId)) return; }
    const srcOut = clipSourceOut(c, fps);
    if (end <= c.sourceIn || start >= srcOut) return;
    if (c.linkId) seenLinks.add(c.linkId);
    const toFrame = (sec: number) => c.start + Math.round((sec - c.sourceIn) / c.speed * fps.num / fps.den);
    const f = Math.max(c.start, Math.min(c.start + c.duration - 1, toFrame(start)));
    const ef = Math.max(f + 1, Math.min(c.start + c.duration, toFrame(end)));
    out.push({ sequenceId: seq.id, clipId: c.id, clipName: c.name, trackId, frame: f, endFrame: ef });
  };
  for (const t of seq.videoTracks) for (const c of t.clips) consider(c, t.id);
  for (const t of seq.audioTracks) for (const c of t.clips) consider(c, t.id);
  out.sort((a, b) => a.frame - b.frame);
  return out;
}

function scopeFilter(index: TranscriptIndex, scope: SearchScope): ((e: TranscriptEntry) => boolean) | null {
  switch (scope.kind) {
    case 'project': return () => true;
    case 'media': { const id = scope.mediaId ?? scope.value; return id ? (e) => e.mediaId === id : null; }
    case 'series': return scope.value ? (e) => e.scopeKeys.series === scope.value : null;
    case 'season': return scope.value ? (e) => e.scopeKeys.season === scope.value : null;
    case 'franchise': return scope.value ? (e) => e.scopeKeys.franchise === scope.value : null;
    case 'collection': return scope.value ? (e) => e.scopeKeys.collection === scope.value : null;
    case 'sequence': {
      const seq = scope.sequenceId ? index.project.sequences[scope.sequenceId] : undefined;
      if (!seq) return null;
      const ids = sequenceMediaIds(seq);
      return (e) => ids.has(e.mediaId);
    }
    default: return null;
  }
}

export function searchTranscript(index: TranscriptIndex, query: string, scope: SearchScope = { kind: 'project' }, opts: SearchOptions = {}): SearchResult {
  const limit = opts.limit ?? 500;
  const compiled = compileQuery(query, opts);
  if (compiled.error) return emptyResult(query, scope, compiled.error);
  if (compiled.matchers.length === 0) return emptyResult(query, scope);
  const filter = scopeFilter(index, scope);
  if (!filter) return emptyResult(query, scope);
  const seq = scope.kind === 'sequence' && scope.sequenceId ? index.project.sequences[scope.sequenceId] : undefined;

  const matches: TranscriptMatch[] = [];
  let total = 0;
  let truncated = false;
  for (const mediaId of index.mediaOrder) {
    const list = index.byMedia.get(mediaId)!;
    if (!filter(list[0])) continue;
    for (const entry of list) {
      const ranges = matchRanges(entry.cue.text, compiled.matchers);
      if (!ranges) continue;
      total++;
      if (matches.length >= limit) { truncated = true; continue; }
      const track = index.project.subtitleTracks[entry.trackId];
      const before = track?.cues[entry.cueIndex - 1]?.text ?? '';
      const after = track?.cues[entry.cueIndex + 1]?.text ?? '';
      const m: TranscriptMatch = { entry, before, after, ranges };
      if (seq) {
        const hits = timelineHitsFor(seq, entry.mediaId, entry.cue.start, entry.cue.end);
        // In sequence scope only moments that are actually on the timeline count.
        if (hits.length === 0) { total--; continue; }
        m.timeline = hits;
      }
      matches.push(m);
    }
  }

  const groups: MediaGroup[] = [];
  let current: MediaGroup | null = null;
  for (const m of matches) {
    if (!current || current.mediaId !== m.entry.mediaId) {
      current = { mediaId: m.entry.mediaId, mediaName: m.entry.mediaName, label: m.entry.label, matches: [] };
      groups.push(current);
    }
    current.matches.push(m);
  }
  return { query, scope, matches, groups, total, truncated };
}

// ------------------------------------------------------------------
// Scope options (for the panel's scope selector)
// ------------------------------------------------------------------

export interface ScopeOption { key: string; label: string; scope: SearchScope }

export function encodeScope(scope: SearchScope): string {
  switch (scope.kind) {
    case 'project': return 'project';
    case 'media': return `media:${scope.mediaId ?? scope.value ?? ''}`;
    case 'sequence': return `sequence:${scope.sequenceId ?? ''}`;
    default: return `${scope.kind}:${scope.value ?? ''}`;
  }
}

export function decodeScope(key: string): SearchScope {
  const i = key.indexOf(':');
  if (i < 0) return { kind: key === 'project' ? 'project' : (key as ScopeKind) };
  const kind = key.slice(0, i) as ScopeKind; const value = key.slice(i + 1);
  if (kind === 'media') return { kind, mediaId: value };
  if (kind === 'sequence') return { kind, sequenceId: value };
  return { kind, value };
}

/** Build the scope selector options from the identities present in the project. */
export function scopeOptions(project: Project, current: { sourceMediaId?: ID | null; activeSequenceId?: ID | null }): ScopeOption[] {
  const out: ScopeOption[] = [{ key: 'project', label: 'Entire project', scope: { kind: 'project' } }];
  if (current.sourceMediaId && project.media[current.sourceMediaId]) {
    const m = project.media[current.sourceMediaId];
    out.push({ key: `media:${m.id}`, label: `Source: ${identityLabel(m) || m.name}`, scope: { kind: 'media', mediaId: m.id } });
  }
  if (current.activeSequenceId && project.sequences[current.activeSequenceId]) {
    const s = project.sequences[current.activeSequenceId];
    out.push({ key: `sequence:${s.id}`, label: `Sequence: ${s.name}`, scope: { kind: 'sequence', sequenceId: s.id } });
  }
  const series = new Map<string, Set<number>>();
  const franchises = new Set<string>();
  const collections = new Set<string>();
  for (const m of Object.values(project.media)) {
    const idn = m.identity ?? {};
    if (idn.series) {
      const s = series.get(idn.series) ?? new Set<number>();
      s.add(idn.season ?? 0);
      series.set(idn.series, s);
    }
    if (idn.franchise) franchises.add(idn.franchise);
    if (idn.collection) collections.add(idn.collection);
  }
  const p = (n: number) => String(n).padStart(2, '0');
  for (const [name, seasons] of [...series.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push({ key: `series:${name}`, label: `Series: ${name}`, scope: { kind: 'series', value: name } });
    for (const n of [...seasons].sort((a, b) => a - b)) {
      const value = seasonScopeValue(name, n);
      out.push({ key: `season:${value}`, label: `Season: ${name} S${p(n)}`, scope: { kind: 'season', value } });
    }
  }
  for (const f of [...franchises].sort()) out.push({ key: `franchise:${f}`, label: `Franchise: ${f}`, scope: { kind: 'franchise', value: f } });
  for (const c of [...collections].sort()) out.push({ key: `collection:${c}`, label: `Collection: ${c}`, scope: { kind: 'collection', value: c } });
  return out;
}
