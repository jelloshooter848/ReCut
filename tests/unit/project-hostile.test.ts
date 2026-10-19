/**
 * BUG 3 / BUG 4: normalizeProject on syntactically valid but structurally hostile project JSON.
 *
 * Contract:
 *  - malformed MEMBERS (a null / string / number / array where an entry object is expected) are dropped;
 *  - malformed FIELDS inside an otherwise usable entry are repaired to their defaults;
 *  - a present-but-wrongly-typed top-level collection holding user work (media / sequences / scenes /
 *    subtitleTracks) is damage: normalizeProject throws a plain Error (the loader then tries the .bak);
 *  - version problems throw ProjectIncompatibleError (never a .bak fallback);
 *  - valid data is never changed, and normalization is idempotent.
 */
import { describe, it, expect } from 'vitest';
import { createProject, createSequence, createMediaItem, normalizeProject, ProjectIncompatibleError, DEFAULT_BINS } from '../../shared/project';
import { PROJECT_FORMAT_VERSION } from '../../shared/model';
import type { Project, Sequence, Rational, MediaItem } from '../../shared/model';
import { makeClip, makeTrack } from '../../shared/timeline';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const V = PROJECT_FORMAT_VERSION;
const rt = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const DEFAULT_FPS: Rational = { num: 24000, den: 1001 };
const JUNK: unknown[] = [null, 42, 'str', true, [], [1, 2], ''];

/** A valid project using every optional field, so "valid data survives" is checked on more than defaults. */
function richProject(): Project {
  const p = createProject('Rich');
  const seq = p.sequences[p.activeSequenceId!];
  seq.fps = { num: 25, den: 1 };
  seq.parentSequenceId = 'seq-parent';
  seq.versionLabel = 'Alt';
  const a = makeClip({ mediaId: 'm1', name: 'A', sourceIn: 1.5, duration: 50, kind: 'video' }, 0);
  a.id = 'ca'; a.linkId = 'L1'; a.color = '#f00'; a.sceneRecordId = 'sc1'; a.originLabel = 'scene'; a.tags = ['t']; a.characters = ['Han'];
  a.plotlines = ['p']; a.locations = ['Hoth']; a.notes = 'n'; a.speed = 2; a.enabled = false;
  a.transform = { x: 10, y: -5, scale: 1.5, rotation: 90, opacity: 0.5, crop: { left: 0.1, top: 0, right: 0.2, bottom: 0 } };
  a.audio = { gain: -3, volume: 0.8, fadeIn: 5, fadeOut: 6, muted: true };
  const b = makeClip({ mediaId: 'm1', name: 'B', sourceIn: 0, duration: 40, kind: 'video' }, 50);
  b.id = 'cb';
  seq.videoTracks[0].clips = [a, b];
  seq.videoTracks[0].transitions = [{ id: 'tr1', type: 'crossDissolve', duration: 10, outClipId: 'ca', inClipId: 'cb' }];
  seq.videoTracks[1].muted = true; seq.videoTracks[1].locked = true; seq.videoTracks[1].height = 90;
  const au = makeClip({ mediaId: 'm1', name: 'A', sourceIn: 1.5, duration: 50, kind: 'audio', audioStream: 2 }, 0);
  au.id = 'cau'; au.linkId = 'L1';
  seq.audioTracks[0].clips = [au]; seq.audioTracks[0].volume = 0.5; seq.audioTracks[0].solo = true;
  seq.markers = [
    { id: 'mk1', time: 12, duration: 0, name: 'M', note: 'x', color: '#fff', kind: 'marker' },
    { id: 'mk2', time: 30, duration: 4, name: 'C', note: 'cont', color: '#0f0', kind: 'continuity', category: 'prop', resolved: true, clipId: 'ca' },
  ];
  seq.storyBlocks = [{ id: 'sb1', name: 'Act 1', start: 0, end: 90, color: '#123', notes: 'n' }];
  seq.subtitleTracks = [{
    id: 'sst1', name: 'Subs', language: 'eng', enabled: true,
    cues: [
      { id: 'q1', clipId: 'ca', srcStart: 1.5, srcEnd: 2, start: 0, duration: 12, offset: 1, text: 'hi' },
      { id: 'q2', start: 60, duration: 10, offset: 0, text: 'free' },
    ],
  }];
  seq.view = { playhead: 7, zoom: 2, scroll: 3, inPoint: 1, outPoint: 80 } as Sequence['view'];
  const { snapshots: _s, ...data } = rt(seq);
  seq.snapshots = [{ id: 'snap1', name: 'Before', createdAt: 123, data }];

  const m = createMediaItem('/media/a.mkv', 'a.mkv') as MediaItem;
  m.id = 'm1'; m.kind = 'video'; m.category = 'Movie'; m.binId = 'bin-movies';
  m.identity = { series: 'S', season: 1, episode: 2, collection: 'C', franchise: 'F', title: 'T', year: 1980 };
  m.probe = {
    container: 'matroska', duration: 100, size: 1000, startTime: 0, bitrate: 5000, browserPlayable: true,
    video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: { num: 24000, den: 1001 }, avgFps: { num: 24000, den: 1001 }, pixFmt: 'yuv420p', isVfr: false, rotation: 0, codedWidth: 1920, codedHeight: 1080, startTime: 0 },
    audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000, language: 'eng' }],
    subtitles: [{ index: 2, codec: 'subrip', language: 'eng' }],
  };
  m.proxy = { status: 'ready', path: '/p.mp4', width: 960, height: 540, audioStream: 1 };
  m.detectedScenes = [{ id: 'ds1', start: 0, end: 5, name: 'S1', tags: ['a'], characters: ['b'] }];
  m.sceneDetectStatus = 'done'; m.subtitleTrackIds = ['st1']; m.thumbnailTime = 3; m.notes = 'notes'; m.tags = ['x'];
  m.color = '#abc'; m.preferredAudioStream = 1; m.waveformStatus = 'ready'; m.fileSize = 1000; m.fileMtime = 5;
  const m2 = createMediaItem('/media/b.wav', 'b.wav'); m2.id = 'm2'; m2.kind = 'audio';
  m2.probe = { container: 'wav', duration: 3, size: 10, startTime: 0, browserPlayable: true, audio: [], subtitles: [] };
  const m3 = createMediaItem('/media/still.png', 'still.png'); m3.id = 'm3'; m3.kind = 'image';
  // ffprobe gives streams without a frame rate {0,1} ("unknown"); that is valid stored probe data
  m3.probe = { container: 'png', duration: 0, size: 10, startTime: 0, browserPlayable: true, audio: [], subtitles: [],
    video: { index: 0, codec: 'png', width: 10, height: 10, fps: { num: 0, den: 1 }, avgFps: { num: 0, den: 1 }, isVfr: false } };
  p.media = { m1: m, m2, m3 };
  p.bins.sub = { id: 'sub', name: 'Sub', parentId: 'bin-movies', color: '#f0f', kind: 'season' };
  p.scenes = { sc1: { id: 'sc1', name: 'Scene', mediaId: 'm1', in: 1, out: 4, characters: ['Han'], location: 'Hoth', arc: 'a', tags: ['t'], notes: 'n', rating: 4, color: '#123456', createdAt: 9 } };
  p.subtitleTracks = { st1: { id: 'st1', name: 'eng', language: 'eng', path: '/a.srt', mediaId: 'm1', origin: 'whisper', cues: [{ id: 'c1', start: 1, end: 2, text: 'Hello' }] } };
  p.tags = { characters: ['Han'], plotlines: ['P'], locations: ['L'], themes: ['T'], custom: ['C'] };
  p.settings = { ...p.settings, proxyHeight: 720, snapping: false, playbackResolution: '1/2', sceneThreshold: 0.5 };
  return p;
}

function base() {
  const p = rt(createProject('H')) as Any;
  const sid: string = p.activeSequenceId;
  return { p, sid, seq: p.sequences[sid] };
}

describe('valid data survives normalization unchanged', () => {
  it('a rich project round-trips through normalizeProject deep-equal', () => {
    const p = rt(richProject());
    expect(normalizeProject(rt(p))).toEqual(p);
  });

  it('normalization is idempotent on a rich project', () => {
    const once = normalizeProject(rt(richProject()));
    expect(normalizeProject(rt(once))).toEqual(rt(once));
  });
});

describe('BUG 3: malformed members are dropped, valid siblings kept', () => {
  it('lead repro: scenes {broken: null} / subtitleTracks {broken: null} / tracks [null]', () => {
    const p = rt(richProject()) as Any;
    p.scenes.broken = null;
    p.subtitleTracks.broken = null;
    const sid = p.activeSequenceId;
    p.sequences[sid].videoTracks.unshift(null);
    p.sequences[sid].audioTracks = [null];
    const n = normalizeProject(p);
    expect(Object.keys(n.scenes)).toEqual(['sc1']);
    expect(Object.keys(n.subtitleTracks)).toEqual(['st1']);
    expect(n.sequences[sid].videoTracks.map((t) => t.name)).toEqual(['V1', 'V2', 'V3']);
    expect(n.sequences[sid].videoTracks[0].clips.map((c) => c.id)).toEqual(['ca', 'cb']);
    expect(n.sequences[sid].audioTracks.map((t) => t.name)).toEqual(['A1', 'A2', 'A3']); // all junk -> template tracks
    expect(n.sequences[sid].audioTracks.every((t) => t.kind === 'audio' && Array.isArray(t.clips))).toBe(true);
  });

  for (const coll of ['media', 'bins', 'sequences', 'scenes', 'subtitleTracks'] as const) {
    it(`${coll}: non-object entries are dropped`, () => {
      const p = rt(richProject()) as Any;
      const before = Object.keys(p[coll]);
      JUNK.forEach((j, i) => { p[coll][`junk${i}`] = j; });
      const n = normalizeProject(p) as Any;
      expect(Object.keys(n[coll])).toEqual(before);
    });
  }

  it('tracks: junk entries dropped; per-track junk fields repaired', () => {
    const { p, sid, seq } = base();
    const good = makeTrack('video', 1);
    seq.videoTracks = [...JUNK, good, { id: 7, name: 9, kind: 'audio', clips: 'x', transitions: 5, muted: 'yes', solo: 1, locked: null, height: -3, volume: 'loud', patched: 'no' }];
    seq.audioTracks = [{ clips: [null, 'x'] }];
    const n = normalizeProject(p).sequences[sid];
    expect(n.videoTracks).toHaveLength(2);
    expect(n.videoTracks[0]).toEqual(good);
    const t = n.videoTracks[1];
    expect(typeof t.id).toBe('string'); expect(t.id).not.toBe('');
    expect(t.name).toBe('V2'); expect(t.kind).toBe('video'); expect(t.clips).toEqual([]); expect(t.transitions).toEqual([]);
    expect([t.muted, t.solo, t.locked, t.patched]).toEqual([false, false, false, false]);
    expect(t.height).toBe(64); expect(t.volume).toBe(1);
    expect(n.audioTracks).toHaveLength(1);
    expect(n.audioTracks[0]).toMatchObject({ kind: 'audio', name: 'A1', clips: [], transitions: [], height: 48, volume: 1, patched: true });
    expect(new Set([...n.videoTracks, ...n.audioTracks].map((x) => x.id)).size).toBe(3);
  });

  it('clips: wrongly typed fields are repaired, junk clip entries dropped', () => {
    const { p, sid, seq } = base();
    const c: Any = makeClip({ mediaId: 'm1', name: 'c', sourceIn: 0, duration: 24, kind: 'video' }, 0);
    Object.assign(c, {
      id: 5, mediaId: 5, name: null, linkId: 7, enabled: 'no', kind: 'title', audioStream: -1,
      transform: 'x', audio: [1], tags: 'a', characters: [1, 'Han', null], plotlines: {}, locations: 5, notes: 5,
      color: 5, sceneRecordId: {}, originLabel: [],
    });
    const c2: Any = makeClip({ mediaId: 'm1', name: 'c2', sourceIn: 0, duration: 24, kind: 'video' }, 24);
    c2.transform = { x: 'left', y: null, scale: -1, rotation: 'r', opacity: 7, crop: 'none' };
    c2.audio = { gain: 'loud', volume: -1, fadeIn: null, fadeOut: -2, muted: 'yes' };
    const c3: Any = makeClip({ mediaId: 'm1', name: 'c3', sourceIn: 0, duration: 24, kind: 'video' }, 48);
    c3.transform = { ...c3.transform, crop: { left: 'a', top: -1, right: 2, bottom: null } };
    seq.videoTracks[0].clips = [...JUNK, c, c2, c3, { start: 'x', duration: 24 }, { start: 0, duration: '24' }, { start: 0, duration: 24, sourceIn: '0' }];
    const clips = normalizeProject(p).sequences[sid].videoTracks[0].clips;
    expect(clips.map((x) => x.name)).toEqual(['', 'c2', 'c3']);
    const [r, r2, r3] = clips;
    expect(typeof r.id).toBe('string'); expect(r.id).not.toBe('');
    expect(r.mediaId).toBe(''); expect(r.linkId).toBeNull(); expect(r.enabled).toBe(true); expect(r.kind).toBe('video');
    expect('audioStream' in r).toBe(false);
    expect(r.transform).toEqual({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, crop: { left: 0, top: 0, right: 0, bottom: 0 } });
    expect(r.audio).toEqual({ gain: 0, volume: 1, fadeIn: 0, fadeOut: 0, muted: false });
    expect(r.tags).toEqual([]); expect(r.characters).toEqual(['Han']); expect(r.plotlines).toEqual([]); expect(r.locations).toEqual([]);
    expect(r.notes).toBe('');
    expect('color' in r || 'sceneRecordId' in r || 'originLabel' in r).toBe(false);
    expect(r2.transform).toEqual({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, crop: { left: 0, top: 0, right: 0, bottom: 0 } });
    expect(r2.audio).toEqual({ gain: 0, volume: 1, fadeIn: 0, fadeOut: 0, muted: false });
    expect(r3.transform.crop).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });

  it('transitions: junk and unknown types dropped', () => {
    const { p, sid, seq } = base();
    const a = makeClip({ mediaId: 'm', name: 'a', sourceIn: 0, duration: 24, kind: 'video' }, 0); a.id = 'a';
    const b = makeClip({ mediaId: 'm', name: 'b', sourceIn: 0, duration: 24, kind: 'video' }, 24); b.id = 'b';
    seq.videoTracks[0].clips = [a, b];
    seq.videoTracks[0].transitions = [...JUNK, { id: 'w', type: 'wipe', duration: 4, outClipId: 'a', inClipId: 'b' },
      { id: 'n', type: 5, duration: 4, outClipId: 'a', inClipId: 'b' },
      { id: 'ok', type: 'dipToBlack', duration: 4, outClipId: 'a', inClipId: 'b' }];
    expect(normalizeProject(p).sequences[sid].videoTracks[0].transitions.map((t) => t.id)).toEqual(['ok']);
  });

  it('markers / story blocks / sequence subtitle tracks and cues: junk entries dropped, fields repaired', () => {
    const { p, sid, seq } = base();
    seq.markers = [...JUNK, { time: 'x' }, { time: -1 }, { id: 'ok', time: 5, duration: 0, name: 'm', note: '', color: '#fff', kind: 'marker' },
      { time: 9, duration: 'long', name: 5, note: null, color: 1, kind: 'nope', category: 5, resolved: 'yes', clipId: 7 }];
    seq.storyBlocks = [...JUNK, { start: 'a', end: 5 }, { id: 'sb', name: 'B', start: 0, end: 10, color: '#000', notes: '' }, { start: 1, end: 2, name: 7, color: null, notes: [] }];
    seq.subtitleTracks = [...JUNK, { name: 5, language: 7, enabled: 'yes', cues: 'x' },
      { id: 'st', name: 'S', language: 'eng', enabled: false, cues: [...JUNK, { id: 'bad', start: 'x', duration: 5, offset: 0, text: 'a' },
        { id: 'q', start: 1, duration: 5, offset: 0, text: 'ok' }, { id: 'q2', start: 2, duration: 5, offset: 'x', text: 5, clipId: 9, srcStart: 'a' },
        { id: 'q3', clipId: 'c1', srcStart: 1, srcEnd: 2, start: null, duration: null, offset: 0, text: 'attached' }] }];
    const s = normalizeProject(p).sequences[sid];
    expect(s.markers).toHaveLength(2);
    expect(s.markers[0]).toEqual({ id: 'ok', time: 5, duration: 0, name: 'm', note: '', color: '#fff', kind: 'marker' });
    expect(s.markers[1]).toMatchObject({ time: 9, duration: 0, name: '', note: '', kind: 'marker' });
    expect(typeof s.markers[1].id).toBe('string'); expect(typeof s.markers[1].color).toBe('string');
    expect('category' in s.markers[1] || 'resolved' in s.markers[1] || 'clipId' in s.markers[1]).toBe(false);
    expect(s.storyBlocks).toHaveLength(2);
    expect(s.storyBlocks[0]).toEqual({ id: 'sb', name: 'B', start: 0, end: 10, color: '#000', notes: '' });
    expect(s.storyBlocks[1]).toMatchObject({ start: 1, end: 2, name: '', notes: '' });
    expect(typeof s.storyBlocks[1].color).toBe('string');
    expect(s.subtitleTracks).toHaveLength(2);
    expect(s.subtitleTracks[0]).toMatchObject({ name: '', language: 'und', enabled: true, cues: [] });
    expect(s.subtitleTracks[1].cues.map((c) => c.id)).toEqual(['q', 'q2', 'q3']);
    expect(s.subtitleTracks[1].cues[1]).toEqual({ id: 'q2', start: 2, duration: 5, offset: 0, text: '' });
    expect(s.subtitleTracks[1].cues[2]).toEqual({ id: 'q3', clipId: 'c1', srcStart: 1, srcEnd: 2, start: 0, duration: 0, offset: 0, text: 'attached' });
  });

  it('snapshots: junk / data-less entries dropped; snapshot data normalized like a sequence', () => {
    const { p, sid, seq } = base();
    const data: Any = rt({ ...seq }); delete data.snapshots;
    data.videoTracks = [null, { clips: [null, { start: 0, duration: 10 }] }];
    data.markers = [null];
    data.fps = { num: 0, den: 1 };
    data.snapshots = [{ id: 'nested' }];
    seq.snapshots = [...JUNK, { id: 'nodata', name: 'x' }, { id: 'strdata', data: 'x' }, { id: 'arrdata', data: [] },
      { id: 's1', name: 5, createdAt: 'x', data }];
    const s = normalizeProject(p).sequences[sid];
    expect(s.snapshots.map((x) => x.id)).toEqual(['s1']);
    const snap = s.snapshots[0];
    expect(snap.name).toBe(''); expect(Number.isFinite(snap.createdAt)).toBe(true);
    expect(snap.data.videoTracks).toHaveLength(1);
    expect(snap.data.videoTracks[0].clips).toHaveLength(1);
    expect(snap.data.markers).toEqual([]);
    expect(snap.data.fps).toEqual(s.fps); // invalid snapshot fps falls back to its sequence's fps
    expect('snapshots' in snap.data).toBe(false);
  });

  it('sequence scalar fields with wrong types are repaired', () => {
    const { p, sid, seq } = base();
    Object.assign(seq, { name: 5, width: 'big', height: -1, sampleRate: 0, channels: 2.5, view: 'x', createdAt: 'x', modifiedAt: null, parentSequenceId: 5, versionLabel: {} });
    const s = normalizeProject(p).sequences[sid];
    expect(s.name).toBe('Timeline');
    expect([s.width, s.height, s.sampleRate, s.channels]).toEqual([1920, 1080, 48000, 2]);
    expect(s.view).toEqual({ playhead: 0, zoom: 4, scroll: 0, inPoint: null, outPoint: null });
    expect(Number.isFinite(s.createdAt) && Number.isFinite(s.modifiedAt)).toBe(true);
    expect('parentSequenceId' in s || 'versionLabel' in s).toBe(false);
    seq.view = [1, 2];
    expect(normalizeProject(p).sequences[sid].view).toEqual({ playhead: 0, zoom: 4, scroll: 0, inPoint: null, outPoint: null });
    seq.videoTracks = 'x'; seq.audioTracks = 5; seq.markers = 'x'; seq.storyBlocks = {}; seq.subtitleTracks = 5; seq.snapshots = 'x';
    const s2 = normalizeProject(p).sequences[sid];
    expect(s2.videoTracks).toHaveLength(3); expect(s2.audioTracks).toHaveLength(3);
    expect([s2.markers, s2.storyBlocks, s2.subtitleTracks, s2.snapshots]).toEqual([[], [], [], []]);
  });

  it('media: wrongly typed fields are repaired', () => {
    const { p } = base();
    p.media = {
      a: { id: 'other', name: 5, path: 5, kind: 'hologram', category: 'Bogus', identity: 'x', binId: 7, offline: 'yes', proxy: 'x',
        detectedScenes: [...JUNK, { id: 'd', start: 'x', end: 2 }, { start: 1, end: 2, name: 5, tags: 'x', characters: [1, 'b'] }],
        subtitleTrackIds: [5, 'st1', null], tags: 'x', notes: 5, addedAt: 'x', probe: 'x', sceneDetectStatus: 5, waveformStatus: 'running',
        color: 5, thumbnailTime: 'x', preferredAudioStream: 'x', fileSize: 'x', fileMtime: null, probeError: 5 },
      b: { path: '/b.mkv', name: 'b', proxy: null, identity: { series: 5, season: '1', episode: 2, year: 'x', title: 'T' },
        probe: { duration: 'x', size: null, startTime: 'x', container: 5, browserPlayable: 'yes', video: 'x', audio: 'x', subtitles: [null, { index: 2, codec: 'srt' }] } },
      c: { path: '/c.mkv', name: 'c', proxy: { status: 'bogus' },
        probe: { container: 'mkv', duration: 5, size: 1, startTime: 0, browserPlayable: true, audio: [null, 5, { index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }], subtitles: [],
          video: { index: 0, codec: 'h264', width: 'w', height: null, fps: { num: -1, den: 0 }, avgFps: 'x', isVfr: 'no' } } },
    };
    const n = normalizeProject(p);
    const a = n.media.a;
    expect(a.id).toBe('a'); expect(a.name).toBe(''); expect(a.path).toBe(''); expect(a.offline).toBe(true);
    expect(a.kind).toBe('unknown'); expect(a.category).toBe('Other'); expect(a.identity).toEqual({}); expect(a.binId).toBeNull();
    expect(a.proxy).toEqual({ status: 'none' });
    expect(a.detectedScenes).toHaveLength(1);
    expect(a.detectedScenes[0]).toMatchObject({ start: 1, end: 2, name: '', tags: [], characters: ['b'] });
    expect(a.subtitleTrackIds).toEqual(['st1']); expect(a.tags).toEqual([]); expect(a.notes).toBe('');
    expect(Number.isFinite(a.addedAt)).toBe(true);
    expect('probe' in a).toBe(false);
    expect(a.sceneDetectStatus).toBeUndefined(); expect(a.waveformStatus).toBe('none');
    for (const k of ['color', 'thumbnailTime', 'preferredAudioStream', 'fileSize', 'fileMtime', 'probeError']) expect(k in a, k).toBe(false);
    const b = n.media.b;
    expect(b.proxy).toEqual({ status: 'none' });
    expect(b.identity).toEqual({ episode: 2, title: 'T' });
    expect(b.probe).toEqual({ container: '', duration: 0, size: 0, startTime: 0, browserPlayable: false, audio: [], subtitles: [{ index: 2, codec: 'srt' }] });
    const c = n.media.c;
    expect(c.proxy).toEqual({ status: 'none' });
    expect(c.probe!.audio).toEqual([{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }]);
    expect(c.probe!.video).toMatchObject({ width: 0, height: 0, fps: { num: 0, den: 1 }, avgFps: { num: 0, den: 1 }, isVfr: false });
  });

  it('scenes and project subtitle tracks: wrongly typed fields repaired, unplaceable entries dropped', () => {
    const { p } = base();
    p.scenes = {
      bad: { name: 'no range', mediaId: 'm', in: 'x', out: 3 },
      neg: { name: 'neg', mediaId: 'm', in: -1, out: 3 },
      ok: { id: 'wrong', name: 5, mediaId: 7, in: 1, out: 3, characters: 'x', tags: 5, notes: null, rating: 'x', color: 5, location: [], arc: {}, createdAt: 'x' },
    };
    p.subtitleTracks = {
      t: { name: 5, language: null, mediaId: 5, origin: 7, path: 5, cues: [...JUNK, { id: 'x', start: 'a', end: 2, text: 'a' }, { start: 1, end: 2, text: 5 }] },
      u: { name: 'u', cues: 'x' },
    };
    const n = normalizeProject(p);
    expect(Object.keys(n.scenes)).toEqual(['ok']);
    expect(n.scenes.ok).toMatchObject({ id: 'ok', name: '', mediaId: '', in: 1, out: 3, characters: [], tags: [], notes: '', rating: 0, location: '', arc: '' });
    expect(typeof n.scenes.ok.color).toBe('string'); expect(Number.isFinite(n.scenes.ok.createdAt)).toBe(true);
    expect(n.subtitleTracks.t).toMatchObject({ id: 't', name: '', language: 'und', mediaId: null, origin: 'srt' });
    expect('path' in n.subtitleTracks.t).toBe(false);
    expect(n.subtitleTracks.t.cues).toHaveLength(1);
    expect(n.subtitleTracks.t.cues[0]).toMatchObject({ start: 1, end: 2, text: '' });
    expect(n.subtitleTracks.u.cues).toEqual([]);
  });

  it('top-level scalars, tags, settings, sequenceOrder and activeSequenceId with wrong types are repaired', () => {
    const { p, sid } = base();
    Object.assign(p, { name: 5, id: 7, createdAt: 'x', modifiedAt: null, tags: 'x', settings: [1], sequenceOrder: 'x', activeSequenceId: 5 });
    let n = normalizeProject(p);
    expect(n.name).toBe('Untitled Project'); expect(typeof n.id).toBe('string'); expect(n.id).not.toBe('');
    expect(Number.isFinite(n.createdAt) && Number.isFinite(n.modifiedAt)).toBe(true);
    expect(n.tags).toEqual({ characters: [], plotlines: [], locations: [], themes: [], custom: [] });
    expect(n.settings).toEqual(createProject().settings);
    expect(n.sequenceOrder).toEqual([sid]); expect(n.activeSequenceId).toBe(sid);
    Object.assign(p, {
      tags: { characters: 'Han', plotlines: [1, 'a', null], locations: null },
      settings: { proxyHeight: '720', playbackResolution: '8K', snapping: 'yes', autosaveIntervalSec: null, sceneThreshold: 7, useProxies: false },
      sequenceOrder: [5, null, sid, {}],
    });
    n = normalizeProject(p);
    expect(n.tags).toEqual({ characters: [], plotlines: ['a'], locations: [], themes: [], custom: [] });
    expect(n.settings).toEqual({ ...createProject().settings, useProxies: false });
    expect(n.sequenceOrder).toEqual([sid]);
  });

  it('prototype-named ids never resolve to Object.prototype members', () => {
    const { p, sid } = base();
    p.sequenceOrder = ['toString', 'constructor', sid, '__proto__'];
    p.activeSequenceId = 'constructor';
    p.bins.x = { id: 'x', name: 'X', parentId: 'toString' };
    const m = rt(createMediaItem('/m.mkv', 'm.mkv')) as Any; m.binId = 'hasOwnProperty';
    p.media = { [m.id]: m };
    p.sequences[sid].binId = 'valueOf';
    const n = normalizeProject(p);
    expect(n.sequenceOrder).toEqual([sid]);
    expect(n.activeSequenceId).toBe(sid);
    expect(n.bins.x.parentId).toBeNull();
    expect(n.media[m.id].binId).toBeNull();
    expect(n.sequences[sid].binId).toBeNull();
  });

  it('a "__proto__" key from JSON.parse is dropped and never changes a prototype', () => {
    const { p, sid } = base();
    const text = JSON.stringify(p).replace('"media":{}', '"media":{"__proto__":{"polluted":true,"path":"/x","name":"x"}}')
      .replace('"scenes":{}', '"scenes":{"__proto__":{"in":1,"out":2,"polluted":true}}');
    const raw = JSON.parse(text);
    expect(Object.keys(raw.media)).toEqual(['__proto__']);
    const n = normalizeProject(raw) as Any;
    expect(Object.keys(n.media)).toEqual([]);
    expect(Object.keys(n.scenes)).toEqual([]);
    expect(Object.getPrototypeOf(n.media)).toBe(Object.prototype);
    expect(n.media.polluted).toBeUndefined();
    expect(({} as Any).polluted).toBeUndefined();
    expect(n.sequences[sid]).toBeDefined();
  });

  it('bins: wrongly typed fields repaired', () => {
    const { p } = base();
    p.bins.x = { name: 5, parentId: 7, kind: 'folder', color: 5 };
    const n = normalizeProject(p);
    expect(n.bins.x).toEqual({ id: 'x', name: '', parentId: null });
    expect(Object.keys(n.bins)).toEqual([...DEFAULT_BINS.map((b) => b.id), 'x']);
  });

  it('normalization of hostile input is idempotent', () => {
    const { p, sid, seq } = base();
    seq.videoTracks = [null, { clips: [null, { start: 0, duration: 10, transform: 'x' }] }];
    seq.markers = [null, { time: 3 }];
    p.scenes = { a: null, b: { in: 0, out: 1 } };
    p.media = { m: { path: '/m', proxy: 'x', probe: { video: { fps: { num: 0, den: 0 } } } } };
    const once = rt(normalizeProject(p));
    expect(rt(normalizeProject(rt(once)))).toEqual(once);
    expect(once.sequences[sid].videoTracks).toHaveLength(1);
  });
});

describe('BUG 3: damaged top-level containers and version refusals', () => {
  for (const coll of ['media', 'sequences', 'scenes', 'subtitleTracks'] as const) {
    for (const junk of [42, 'garbage', true, [], [{}]]) {
      it(`${coll} = ${JSON.stringify(junk)} is damage (plain Error, not a refusal)`, () => {
        const { p } = base();
        p[coll] = junk;
        let err: unknown;
        try { normalizeProject(p); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(ProjectIncompatibleError);
        expect((err as Error).message).toMatch(new RegExp(coll));
      });
    }
  }

  it('missing collections (older / minimal files) still load with empty defaults', () => {
    const n = normalizeProject({ formatVersion: V });
    expect(n.media).toEqual({}); expect(n.scenes).toEqual({}); expect(n.subtitleTracks).toEqual({});
    expect(n.sequenceOrder).toHaveLength(1);
    const n2 = normalizeProject({ formatVersion: V, media: null, sequences: null, scenes: null, subtitleTracks: null });
    expect(n2.sequenceOrder).toHaveLength(1);
  });

  it('newer / missing / non-numeric formatVersion is a ProjectIncompatibleError', () => {
    for (const raw of [{ formatVersion: V + 1 }, {}, { formatVersion: '1' }, { formatVersion: null }, { ...rt(createProject()), formatVersion: undefined }]) {
      expect(() => normalizeProject(raw), JSON.stringify(raw).slice(0, 40)).toThrow(ProjectIncompatibleError);
    }
    expect(() => normalizeProject({ formatVersion: V + 1 })).toThrow(/newer ReCut/);
    expect(() => normalizeProject({})).toThrow(/formatVersion/);
  });
});

describe('BUG 4: sequence frame rates are validated on load', () => {
  const INVALID: unknown[] = [
    { num: 0, den: 1 }, { num: 24, den: 0 }, { num: -24, den: 1 }, { num: '24', den: 1 }, { num: 24, den: '1' }, null, 'x', [], {},
    { num: 23.976, den: 1 }, { num: 24, den: 1.5 }, { num: 1, den: 2 }, { num: 1e9, den: 1 }, { num: 24e6, den: 1e6 }, { num: 1001, den: 1 }, true,
  ];

  for (const fps of INVALID) {
    it(`fps ${JSON.stringify(fps)} -> default 24000/1001`, () => {
      const { p, sid, seq } = base();
      seq.fps = fps;
      expect(normalizeProject(p).sequences[sid].fps).toEqual(DEFAULT_FPS);
    });
  }

  it('missing fps -> default; NaN / Infinity (runtime only, not JSON) -> default', () => {
    for (const fps of [undefined, { num: NaN, den: 1 }, { num: 24, den: NaN }, { num: Infinity, den: 1 }, { num: 24, den: Infinity }, { num: -Infinity, den: 1 }]) {
      const p = createProject('rt');
      const sid = p.activeSequenceId!;
      (p.sequences[sid] as Any).fps = fps;
      expect(normalizeProject(structuredClone(p)).sequences[sid].fps, String(fps && JSON.stringify(fps))).toEqual(DEFAULT_FPS);
    }
  });

  it('valid unusual rates are kept exactly', () => {
    const rates: Rational[] = [
      { num: 12, den: 1 }, { num: 15, den: 1 }, { num: 48, den: 1 }, { num: 120, den: 1 }, { num: 240, den: 1 }, { num: 1, den: 1 }, { num: 1000, den: 1 },
      { num: 24000, den: 1001 }, { num: 30000, den: 1001 }, { num: 60000, den: 1001 }, { num: 120000, den: 1001 }, { num: 48000, den: 2002 },
      { num: 12500, den: 1000 }, { num: 2997, den: 100 },
    ];
    for (const fps of rates) {
      const { p, sid, seq } = base();
      seq.fps = fps;
      expect(normalizeProject(p).sequences[sid].fps).toEqual(fps);
    }
  });

  it('a bare number fps (hand-edited file) is migrated through parseFps when it is a valid rate', () => {
    const cases: [unknown, Rational][] = [[25, { num: 25, den: 1 }], [23.976, DEFAULT_FPS], [29.97, { num: 30000, den: 1001 }], [0, DEFAULT_FPS], [-24, DEFAULT_FPS], [5000, DEFAULT_FPS]];
    for (const [fps, want] of cases) {
      const { p, sid, seq } = base();
      seq.fps = fps;
      expect(normalizeProject(p).sequences[sid].fps, String(fps)).toEqual(want);
    }
  });

  it('snapshot data with an invalid fps takes its sequence fps; a valid one is kept', () => {
    const { p, sid, seq } = base();
    seq.fps = { num: 25, den: 1 };
    const data = (fps: unknown) => { const d: Any = rt({ ...seq }); delete d.snapshots; d.fps = fps; return d; };
    seq.snapshots = [{ id: 'bad', name: 'b', createdAt: 1, data: data({ num: 24, den: 0 }) }, { id: 'ok', name: 'o', createdAt: 1, data: data({ num: 30, den: 1 }) }];
    const s = normalizeProject(p).sequences[sid];
    expect(s.snapshots.map((x) => x.data.fps)).toEqual([{ num: 25, den: 1 }, { num: 30, den: 1 }]);
  });

  it('media probe frame rates: valid kept, the prober\'s {0,1} "unknown" kept, garbage -> {0,1}', () => {
    const { p } = base();
    const probe = (fps: unknown, avgFps: unknown) => ({ container: 'mkv', duration: 1, size: 1, startTime: 0, browserPlayable: true, audio: [], subtitles: [],
      video: { index: 0, codec: 'h264', width: 2, height: 2, fps, avgFps, isVfr: false } });
    p.media = {
      a: { path: '/a', name: 'a', probe: probe({ num: 30000, den: 1001 }, { num: 0, den: 1 }) },
      b: { path: '/b', name: 'b', probe: probe({ num: 24, den: 0 }, { num: -1, den: 1 }) },
      c: { path: '/c', name: 'c', probe: probe('24', null) },
      d: { path: '/d', name: 'd', probe: probe({ num: 1e9, den: 1 }, { num: 1, den: 3 }) },
    };
    const n = normalizeProject(p);
    expect([n.media.a.probe!.video!.fps, n.media.a.probe!.video!.avgFps]).toEqual([{ num: 30000, den: 1001 }, { num: 0, den: 1 }]);
    for (const id of ['b', 'c', 'd']) {
      expect([n.media[id].probe!.video!.fps, n.media[id].probe!.video!.avgFps], id).toEqual([{ num: 0, den: 1 }, { num: 0, den: 1 }]);
    }
  });

  it('createSequence refuses an invalid frame rate and defaults to 24000/1001', () => {
    expect(createSequence('ok').fps).toEqual(DEFAULT_FPS);
    for (const fps of [{ num: 0, den: 1 }, { num: 24, den: 0 }, { num: -24, den: 1 }, { num: NaN, den: 1 }, { num: '24', den: 1 } as Any, null as Any]) {
      expect(() => createSequence('bad', fps), JSON.stringify(fps)).toThrow(RangeError);
    }
  });
});
