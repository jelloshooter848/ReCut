import { describe, it, expect } from 'vitest';
import { createMediaItem, createProject, createSequence } from '../../shared/project';
import { makeClip } from '../../shared/timeline';
import type { MediaItem, Project, SubtitleCue, SubtitleTrack } from '../../shared/model';
import {
  buildTranscriptIndex, searchTranscript, parseQueryTerms, compileQuery, matchRanges, highlightSegments,
  scopeOptions, seasonScopeValue, encodeScope, decodeScope, timelineHitsFor,
} from '../../src/transcript/index';

const FPS = { num: 24, den: 1 };

let n = 0;
function cue(start: number, end: number, text: string): SubtitleCue { return { id: `c${++n}`, start, end, text }; }

function track(mediaId: string, cues: SubtitleCue[], language = 'en'): SubtitleTrack {
  return { id: `t${++n}`, name: `${language}.srt`, language, mediaId, cues, origin: 'srt' };
}

function media(name: string, identity: MediaItem['identity'] = {}): MediaItem {
  return { ...createMediaItem(`/m/${name}`, name), kind: 'video', identity };
}

function attach(p: Project, m: MediaItem, ...tracks: SubtitleTrack[]) {
  p.media[m.id] = { ...m, subtitleTrackIds: tracks.map((t) => t.id) };
  for (const t of tracks) p.subtitleTracks[t.id] = t;
}

function fixture() {
  const p = createProject('T');
  const ep1 = media('Station Eleven S01E01.mp4', { series: 'Station Eleven', season: 1, episode: 1 });
  const ep2 = media('Station Eleven S01E02.mp4', { series: 'Station Eleven', season: 1, episode: 2 });
  const ep3 = media('Station Eleven S02E01.mp4', { series: 'Station Eleven', season: 2, episode: 1 });
  const movie = media('Galaxy Saga 1.mp4', { franchise: 'Galaxy Saga', collection: 'Original Trilogy', title: 'A New Dawn' });
  const loose = media('zzz loose.mp4');
  attach(p, ep1, track(ep1.id, [cue(1, 3.5, 'Welcome to the station.'), cue(5, 7.5, 'Where is the doctor?'), cue(9, 11.5, 'The doctor is in the lab.')]));
  attach(p, ep2, track(ep2.id, [cue(1, 3.5, 'The doctor has a secret.'), cue(5, 7.5, 'Open the airlock.'), cue(9, 11.5, 'We are not alone.')]));
  attach(p, ep3, track(ep3.id, [cue(1, 3.5, 'Nobody trusts the doctor now.'), cue(5, 7.5, 'Seal the station.')]));
  attach(p, movie, track(movie.id, [cue(1, 3.5, 'Chapter one begins at dawn.'), cue(5, 7.5, 'I am your father, Luke.'), cue(9, 11.5, 'The ship is ready,\ncaptain.')]));
  attach(p, loose, track(loose.id, [cue(0, 1, 'Doctor Who?')]));
  return { p, ep1, ep2, ep3, movie, loose };
}

describe('buildTranscriptIndex', () => {
  it('indexes every cue with labels and scope keys, ordered by identity', () => {
    const { p, ep1, movie, loose } = fixture();
    const idx = buildTranscriptIndex(p);
    expect(idx.stats).toEqual({ mediaWithTranscripts: 5, cues: 12, tracks: 5 });
    // Galaxy Saga (franchise) sorts before Station Eleven; loose media last.
    expect(idx.mediaOrder[0]).toBe(movie.id);
    expect(idx.mediaOrder[idx.mediaOrder.length - 1]).toBe(loose.id);
    const e = idx.byMedia.get(ep1.id)![1];
    expect(e.label).toBe('Station Eleven S01E01');
    expect(e.cueIndex).toBe(1);
    expect(e.scopeKeys).toEqual({ series: 'Station Eleven', season: seasonScopeValue('Station Eleven', 1), franchise: undefined, collection: undefined });
    const mv = idx.byMedia.get(movie.id)![0];
    expect(mv.label).toBe('Galaxy Saga › A New Dawn');
    expect(mv.scopeKeys.franchise).toBe('Galaxy Saga');
    expect(mv.scopeKeys.collection).toBe('Original Trilogy');
  });

  it('skips media without cues', () => {
    const p = createProject('T');
    const m = media('empty.mp4');
    attach(p, m, track(m.id, []));
    const idx = buildTranscriptIndex(p);
    expect(idx.entries).toHaveLength(0);
    expect(idx.mediaOrder).toEqual([]);
  });
});

describe('query parsing', () => {
  it('splits terms and keeps quoted phrases', () => {
    expect(parseQueryTerms('doctor  lab')).toEqual([{ text: 'doctor', phrase: false }, { text: 'lab', phrase: false }]);
    expect(parseQueryTerms('"the doctor" secret')).toEqual([{ text: 'the doctor', phrase: true }, { text: 'secret', phrase: false }]);
    expect(parseQueryTerms('""')).toEqual([]);
  });

  it('compiles whole-word and regex modes', () => {
    expect(matchRanges('doctors and the doctor', compileQuery('doctor').matchers)).toEqual([[0, 6], [16, 22]]);
    expect(matchRanges('doctors and the doctor', compileQuery('doctor', { wholeWord: true }).matchers)).toEqual([[16, 22]]);
    expect(matchRanges('doctors', compileQuery('doctor', { wholeWord: true }).matchers)).toBeNull();
    expect(matchRanges('I am your father', compileQuery('fa.her', { regex: true }).matchers)).toEqual([[10, 16]]);
    expect(matchRanges('I am your father', compileQuery('fa.her').matchers)).toBeNull();
    expect(compileQuery('(', { regex: true }).error).toBeTruthy();
    expect(compileQuery('a*', { regex: true }).error).toBe('Pattern matches empty text');
  });

  it('merges overlapping ranges and builds highlight segments', () => {
    const ranges = matchRanges('the doctor', compileQuery('"the doctor" doctor').matchers)!;
    expect(ranges).toEqual([[0, 10]]);
    expect(highlightSegments('a doctor b', [[2, 8]])).toEqual([{ text: 'a ', hit: false }, { text: 'doctor', hit: true }, { text: ' b', hit: false }]);
  });

  it('phrases match across line breaks', () => {
    expect(matchRanges('The ship is ready,\ncaptain.', compileQuery('"ready, captain"').matchers)).toEqual([[12, 26]]);
  });
});

describe('searchTranscript', () => {
  it('finds multi-term AND matches across the project, grouped by media and sorted by time', () => {
    const { p, ep1, ep2, ep3, loose } = fixture();
    const idx = buildTranscriptIndex(p);
    const r = searchTranscript(idx, 'doctor', { kind: 'project' }, { limit: 100 });
    expect(r.error).toBeUndefined();
    expect(r.total).toBe(5);
    expect(r.groups.map((g) => g.mediaId)).toEqual([ep1.id, ep2.id, ep3.id, loose.id]);
    expect(r.groups[0].label).toBe('Station Eleven S01E01');
    expect(r.groups[0].matches.map((m) => m.entry.cue.start)).toEqual([5, 9]);
    // Context lines
    const first = r.groups[0].matches[0];
    expect(first.before).toBe('Welcome to the station.');
    expect(first.after).toBe('The doctor is in the lab.');
    expect(first.ranges).toEqual([[13, 19]]);
    const andR = searchTranscript(idx, 'doctor lab', { kind: 'project' });
    expect(andR.total).toBe(1);
    expect(andR.matches[0].entry.cue.text).toBe('The doctor is in the lab.');
    const phrase = searchTranscript(idx, '"the doctor has"', { kind: 'project' });
    expect(phrase.total).toBe(1);
    expect(phrase.matches[0].entry.mediaId).toBe(ep2.id);
  });

  it('respects limit and reports truncation', () => {
    const { p } = fixture();
    const idx = buildTranscriptIndex(p);
    const r = searchTranscript(idx, 'the', { kind: 'project' }, { limit: 2 });
    expect(r.matches).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(r.total).toBeGreaterThan(2);
  });

  it('returns nothing for an empty query and an error for a bad regex', () => {
    const { p } = fixture();
    const idx = buildTranscriptIndex(p);
    expect(searchTranscript(idx, '   ', { kind: 'project' }).total).toBe(0);
    const bad = searchTranscript(idx, '[', { kind: 'project' }, { regex: true });
    expect(bad.total).toBe(0);
    expect(bad.error).toBeTruthy();
  });

  it('supports whole-word and regex options', () => {
    const { p } = fixture();
    const idx = buildTranscriptIndex(p);
    expect(searchTranscript(idx, 'doc', { kind: 'project' }).total).toBe(5);
    expect(searchTranscript(idx, 'doc', { kind: 'project' }, { wholeWord: true }).total).toBe(0);
    expect(searchTranscript(idx, '^the doctor', { kind: 'project' }, { regex: true }).total).toBe(2);
  });

  it('scopes by media, series, season, franchise and collection', () => {
    const { p, ep1, ep3 } = fixture();
    const idx = buildTranscriptIndex(p);
    expect(searchTranscript(idx, 'doctor', { kind: 'media', mediaId: ep1.id }).total).toBe(2);
    expect(searchTranscript(idx, 'doctor', { kind: 'series', value: 'Station Eleven' }).total).toBe(4);
    expect(searchTranscript(idx, 'doctor', { kind: 'season', value: seasonScopeValue('Station Eleven', 2) }).matches.map((m) => m.entry.mediaId)).toEqual([ep3.id]);
    expect(searchTranscript(idx, 'father', { kind: 'franchise', value: 'Galaxy Saga' }).total).toBe(1);
    expect(searchTranscript(idx, 'father', { kind: 'collection', value: 'Original Trilogy' }).total).toBe(1);
    expect(searchTranscript(idx, 'father', { kind: 'series', value: 'Station Eleven' }).total).toBe(0);
    expect(searchTranscript(idx, 'doctor', { kind: 'series' }).total).toBe(0);
  });

  it('sequence scope searches only media on the timeline and maps hits to timeline frames', () => {
    const { p, ep1, ep2 } = fixture();
    const seq = createSequence('Cut', FPS);
    // ep1 from 4s..12s placed at frame 100 (covers both "doctor" cues); ep2 from 6s..12s at 400 (misses its doctor cue at 1s).
    const v1 = makeClip({ mediaId: ep1.id, name: 'ep1', sourceIn: 4, duration: 8 * 24, kind: 'video', linkId: 'L1' }, 100);
    const a1 = makeClip({ mediaId: ep1.id, name: 'ep1', sourceIn: 4, duration: 8 * 24, kind: 'audio', linkId: 'L1' }, 100);
    const v2 = makeClip({ mediaId: ep2.id, name: 'ep2', sourceIn: 6, duration: 6 * 24, kind: 'video' }, 400);
    seq.videoTracks[0].clips.push(v1, v2);
    seq.audioTracks[0].clips.push(a1);
    p.sequences[seq.id] = seq; p.sequenceOrder.push(seq.id);
    const idx = buildTranscriptIndex(p);
    const r = searchTranscript(idx, 'doctor', { kind: 'sequence', sequenceId: seq.id });
    expect(r.total).toBe(2);
    expect(r.matches.map((m) => m.entry.cue.start)).toEqual([5, 9]);
    const hits = r.matches[0].timeline!;
    expect(hits).toHaveLength(1); // linked audio clip is not reported twice
    expect(hits[0].clipId).toBe(v1.id);
    expect(hits[0].frame).toBe(100 + 24); // 5s - 4s = 1s = 24 frames
    expect(hits[0].endFrame).toBe(100 + Math.round(3.5 * 24));
    expect(r.matches[1].timeline![0].frame).toBe(100 + 5 * 24);
    // Cues outside the used source range are not reported.
    expect(searchTranscript(idx, 'secret', { kind: 'sequence', sequenceId: seq.id }).total).toBe(0);
    expect(searchTranscript(idx, 'alone', { kind: 'sequence', sequenceId: seq.id }).total).toBe(1);
    // A cue that starts before the clip's source in point is clamped to the clip start.
    const airlock = searchTranscript(idx, 'airlock', { kind: 'sequence', sequenceId: seq.id });
    expect(airlock.total).toBe(1);
    expect(airlock.matches[0].timeline![0].frame).toBe(400);
    // Speed changes are respected and multiple placements are all reported.
    const fast = makeClip({ mediaId: ep1.id, name: 'fast', sourceIn: 0, duration: 6 * 24, speed: 2, kind: 'video' }, 1000);
    seq.videoTracks[1].clips.push(fast);
    const hits2 = timelineHitsFor(seq, ep1.id, 5, 7.5);
    expect(hits2.map((h) => h.frame)).toEqual([124, 1000 + Math.round(5 / 2 * 24)]);
    expect(searchTranscript(idx, 'doctor', { kind: 'sequence', sequenceId: 'nope' }).total).toBe(0);
  });
});

describe('scope options', () => {
  it('builds options from identities and round-trips keys', () => {
    const { p, ep1 } = fixture();
    const seqId = p.activeSequenceId!;
    const opts = scopeOptions(p, { sourceMediaId: ep1.id, activeSequenceId: seqId });
    const labels = opts.map((o) => o.label);
    expect(labels[0]).toBe('Entire project');
    expect(labels).toContain('Source: Station Eleven S01E01');
    expect(labels).toContain('Sequence: Sequence 01');
    expect(labels).toContain('Series: Station Eleven');
    expect(labels).toContain('Season: Station Eleven S01');
    expect(labels).toContain('Season: Station Eleven S02');
    expect(labels).toContain('Franchise: Galaxy Saga');
    expect(labels).toContain('Collection: Original Trilogy');
    for (const o of opts) expect(decodeScope(encodeScope(o.scope))).toEqual(o.scope);
    expect(decodeScope('project')).toEqual({ kind: 'project' });
  });
});
