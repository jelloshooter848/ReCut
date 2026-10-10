import { describe, it, expect } from 'vitest';
import { createProject, createSequence, createMediaItem, normalizeProject, serializeProject, defaultSettings, DEFAULT_BINS } from '../../shared/project';
import { PROJECT_FORMAT_VERSION } from '../../shared/model';
import { makeClip } from '../../shared/timeline';

describe('createProject', () => {
  it('builds a complete project with default bins and one active sequence', () => {
    const p = createProject('Fan Edit');
    expect(p.formatVersion).toBe(PROJECT_FORMAT_VERSION);
    expect(p.name).toBe('Fan Edit');
    expect(p.id).toMatch(/^proj/);
    expect(Object.keys(p.bins)).toEqual(DEFAULT_BINS.map((b) => b.id));
    expect(p.sequenceOrder).toHaveLength(1);
    const seq = p.sequences[p.sequenceOrder[0]];
    expect(seq).toBeDefined();
    expect(p.activeSequenceId).toBe(seq.id);
    expect(seq.binId).toBe('bin-sequences');
    expect(seq.name).toBe('Timeline 01');
    expect(seq.fps).toEqual({ num: 24000, den: 1001 });
    expect(seq.videoTracks.map((t) => t.name)).toEqual(['V1', 'V2', 'V3']);
    expect(seq.audioTracks.map((t) => t.name)).toEqual(['A1', 'A2', 'A3']);
    expect(seq.videoTracks[0].patched).toBe(true);
    expect(seq.videoTracks[1].patched).toBe(false);
    expect(p.media).toEqual({});
    expect(p.scenes).toEqual({});
    expect(p.subtitleTracks).toEqual({});
    expect(p.tags).toEqual({ characters: [], plotlines: [], locations: [], themes: [], custom: [] });
    expect(p.settings).toEqual(defaultSettings());
  });

  it('createSequence honours fps/size arguments and createMediaItem has safe defaults', () => {
    const s = createSequence('S', { num: 25, den: 1 }, 1280, 720);
    expect(s.fps).toEqual({ num: 25, den: 1 });
    expect(s.width).toBe(1280); expect(s.height).toBe(720);
    expect(s.subtitleTracks).toEqual([]); expect(s.markers).toEqual([]); expect(s.storyBlocks).toEqual([]);
    const m = createMediaItem('/x/y.mkv', 'y.mkv');
    expect(m.proxy).toEqual({ status: 'none' });
    expect(m.kind).toBe('unknown');
    expect(m.offline).toBe(false);
  });

  it('serializeProject roundtrips through JSON', () => {
    const p = createProject('R');
    expect(JSON.parse(serializeProject(p))).toEqual(JSON.parse(JSON.stringify(p)));
  });
});

describe('normalizeProject', () => {
  it('throws on non-object / missing / newer formatVersion', () => {
    expect(() => normalizeProject(null)).toThrow(/not a JSON object/);
    expect(() => normalizeProject('nope')).toThrow(/not a JSON object/);
    expect(() => normalizeProject({})).toThrow(/formatVersion/);
    expect(() => normalizeProject({ formatVersion: PROJECT_FORMAT_VERSION + 1 })).toThrow(/newer ReCut/);
  });

  it('a freshly created project normalizes to itself', () => {
    const p = createProject('Same');
    const n = normalizeProject(JSON.parse(serializeProject(p)));
    expect(n).toEqual(p);
  });

  it('repairs missing arrays, bad clips, proxy status and the active sequence', () => {
    const seq = createSequence('Broken', { num: 24, den: 1 });
    const good = makeClip({ mediaId: 'm1', name: 'good', sourceIn: 0, duration: 48, kind: 'video' }, 48);
    const zero = makeClip({ mediaId: 'm1', name: 'zero', sourceIn: 0, duration: 10, kind: 'video' }, 0);
    zero.duration = 0;
    const neg = { ...makeClip({ mediaId: 'm1', name: 'neg', sourceIn: 0, duration: 10, kind: 'video' }, 200), duration: -5 };
    const bare = { id: 'bare', mediaId: 'm1', name: 'bare', start: 0, duration: 24 } as unknown as typeof good; // missing transform/audio/etc
    const raw = {
      formatVersion: PROJECT_FORMAT_VERSION,
      name: 'Repair me',
      sequences: {
        [seq.id]: {
          ...seq,
          videoTracks: [{ ...seq.videoTracks[0], clips: [good, zero, neg, bare, null], transitions: undefined }],
          audioTracks: undefined,
          subtitleTracks: undefined, markers: undefined, storyBlocks: undefined, snapshots: undefined,
          view: { playhead: 12 },
        },
      },
      sequenceOrder: ['does-not-exist'],
      activeSequenceId: 'does-not-exist',
      media: {
        m1: { id: 'm1', name: 'a.mkv', path: '/a.mkv', proxy: { status: 'running', progress: 0.4 }, sceneDetectStatus: 'running', waveformStatus: 'running' },
        m2: { id: 'm2', name: 'b.mkv', path: '/b.mkv', proxy: { status: 'queued' } },
        m3: { id: 'm3', name: 'c.mkv', path: '/c.mkv', proxy: { status: 'ready', path: '/p.mp4' } },
      },
      scenes: { s1: { id: 's1', name: 'scene', mediaId: 'm1', in: 0, out: 1 } },
      subtitleTracks: { st1: { id: 'st1', name: 'eng', mediaId: 'm1' } },
      settings: { proxyHeight: 720 },
      tags: { characters: ['Han'] },
    };
    const n = normalizeProject(raw);
    expect(n.name).toBe('Repair me');
    expect(n.formatVersion).toBe(PROJECT_FORMAT_VERSION);
    expect(n.bins).toBeDefined();
    expect(Object.keys(n.bins).length).toBe(DEFAULT_BINS.length);

    // sequence repairs
    expect(n.sequenceOrder).toEqual([seq.id]);
    expect(n.activeSequenceId).toBe(seq.id);
    const s = n.sequences[seq.id];
    expect(s.id).toBe(seq.id);
    expect(s.audioTracks).toHaveLength(3);
    expect(s.subtitleTracks).toEqual([]); expect(s.markers).toEqual([]); expect(s.storyBlocks).toEqual([]); expect(s.snapshots).toEqual([]);
    expect(s.view).toEqual({ playhead: 12, zoom: 4, scroll: 0, inPoint: null, outPoint: null });
    const v1 = s.videoTracks[0];
    expect(v1.transitions).toEqual([]);
    expect(v1.clips.map((c) => c.name)).toEqual(['bare', 'good']); // zero/neg/null dropped; sorted by start
    const b = v1.clips[0];
    expect(b.transform.scale).toBe(1); expect(b.transform.crop).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
    expect(b.audio.volume).toBe(1); expect(b.speed).toBe(1); expect(b.enabled).toBe(true); expect(b.kind).toBe('video');
    expect(b.tags).toEqual([]); expect(b.notes).toBe('');

    // media repairs
    expect(n.media.m1.proxy).toEqual({ status: 'none' });
    expect(n.media.m2.proxy).toEqual({ status: 'none' });
    expect(n.media.m3.proxy).toEqual({ status: 'ready', path: '/p.mp4' });
    expect(n.media.m1.sceneDetectStatus).toBe('none');
    expect(n.media.m1.waveformStatus).toBe('none');
    expect(n.media.m1.detectedScenes).toEqual([]); expect(n.media.m1.subtitleTrackIds).toEqual([]);
    expect(n.media.m1.category).toBe('Other'); expect(n.media.m1.identity).toEqual({}); expect(n.media.m1.offline).toBe(false);

    // scenes / subtitle tracks / settings / tags
    expect(n.scenes.s1).toMatchObject({ characters: [], tags: [], notes: '', rating: 0, location: '', arc: '' });
    expect(n.subtitleTracks.st1).toMatchObject({ cues: [], origin: 'srt', language: 'und' });
    expect(n.settings).toEqual({ ...defaultSettings(), proxyHeight: 720 });
    expect(n.tags).toEqual({ characters: ['Han'], plotlines: [], locations: [], themes: [], custom: [] });
  });

  it('creates a sequence when there are none (and drops non-object sequences)', () => {
    const n = normalizeProject({ formatVersion: PROJECT_FORMAT_VERSION, sequences: { junk: 42 } });
    expect(Object.keys(n.sequences)).toHaveLength(1);
    const id = Object.keys(n.sequences)[0];
    expect(id).not.toBe('junk');
    expect(n.sequenceOrder).toEqual([id]);
    expect(n.activeSequenceId).toBe(id);
    expect(n.sequences[id].name).toBe('Timeline 01');
    expect(n.sequences[id].binId).toBe('bin-sequences');
  });

  it('appends sequences missing from sequenceOrder and keeps a valid activeSequenceId', () => {
    const a = createSequence('A'); const b = createSequence('B');
    const n = normalizeProject({ formatVersion: PROJECT_FORMAT_VERSION, sequences: { [a.id]: a, [b.id]: b }, sequenceOrder: [b.id], activeSequenceId: a.id });
    expect(n.sequenceOrder).toEqual([b.id, a.id]);
    expect(n.activeSequenceId).toBe(a.id);
  });
});

describe('normalizeProject hostile-input repairs (QA-08/09/16/18)', () => {
  const roundTrip = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
  function withClips() {
    const p = createProject('x');
    const s = p.sequences[p.activeSequenceId!];
    const mk = (start: number, extra: Record<string, unknown> = {}) => ({ ...makeClip({ mediaId: 'm', name: `c${start}`, sourceIn: 0, duration: 24, kind: 'video' }, start), ...extra });
    return { p, s, mk };
  }

  it('drops clips with non-finite / negative start or sourceIn and duration < 1; repairs bad speed', () => {
    const { p, s, mk } = withClips();
    s.videoTracks[0].clips = [
      mk(0), mk(100, { id: 'nanStart', start: NaN }), mk(200, { id: 'negStart', start: -1 }), mk(300, { id: 'infStart', start: Infinity }),
      mk(400, { id: 'negIn', sourceIn: -2 }), mk(500, { id: 'nanIn', sourceIn: NaN }), mk(600, { id: 'half', duration: 0.5 }),
      mk(700, { id: 'infDur', duration: Infinity }), mk(800, { id: 'negSpeed', speed: -1 }), mk(900, { id: 'nanSpeed', speed: NaN }),
      mk(1000, { id: 'infSpeed', speed: Infinity }),
    ] as typeof s.videoTracks[0]['clips'];
    // NaN / Infinity become null through JSON, so test both the raw object and a JSON round trip
    for (const n of [normalizeProject(structuredClone(p)), normalizeProject(roundTrip(p))]) {
      const clips = n.sequences[s.id].videoTracks[0].clips;
      expect(clips.map((c) => c.id).filter((id) => !id.startsWith('clip'))).toEqual(['negSpeed', 'nanSpeed', 'infSpeed']);
      expect(clips.every((c) => c.speed === 1)).toBe(true);
    }
  });

  it('reconciles transitions on load: dangling ones dropped, overlapping ones clamped', () => {
    const { p, s, mk } = withClips();
    const a = mk(0, { id: 'a', duration: 100 }); const b = mk(100, { id: 'b', duration: 12 }); const c = mk(112, { id: 'c', duration: 100 });
    s.videoTracks[0].clips = [a, b, c] as typeof s.videoTracks[0]['clips'];
    s.videoTracks[0].transitions = [
      { id: 'ghost', type: 'crossDissolve', duration: 10, outClipId: 'nope', inClipId: 'nada' },
      { id: 't1', type: 'crossDissolve', duration: 12, outClipId: 'a', inClipId: 'b' },
      { id: 't2', type: 'crossDissolve', duration: 12, outClipId: 'b', inClipId: 'c' },
    ];
    const n = normalizeProject(roundTrip(p));
    const trs = n.sequences[s.id].videoTracks[0].transitions;
    expect(trs.map((t) => t.id)).toEqual(['t1']); // t2 had no room left on b and was dropped
  });

  it('breaks bin cycles / self-parents / unknown parents and clears binIds pointing at unknown bins', () => {
    const p = createProject('bins');
    p.bins.a = { id: 'a', name: 'A', parentId: 'b' };
    p.bins.b = { id: 'b', name: 'B', parentId: 'a' };
    p.bins.self = { id: 'self', name: 'S', parentId: 'self' };
    p.bins.orphan = { id: 'orphan', name: 'O', parentId: 'missing' };
    p.bins.child = { id: 'child', name: 'C', parentId: 'a' };
    const m = createMediaItem('/x.mp4', 'x.mp4'); m.binId = 'gone';
    const m2 = createMediaItem('/y.mp4', 'y.mp4'); m2.binId = 'child';
    p.media[m.id] = m; p.media[m2.id] = m2;
    p.sequences[p.activeSequenceId!].binId = 'gone';
    const n = normalizeProject(roundTrip(p));
    expect(n.bins.self.parentId).toBeNull();
    expect(n.bins.orphan.parentId).toBeNull();
    // every bin reaches the root
    for (const id of Object.keys(n.bins)) {
      const seen = new Set<string>(); let cur: string | null = id;
      while (cur) { expect(seen.has(cur)).toBe(false); seen.add(cur); cur = n.bins[cur].parentId; }
    }
    expect([n.bins.a.parentId, n.bins.b.parentId].filter((x) => x === null)).toHaveLength(1);
    expect(n.bins.child.parentId).toBe('a');
    expect(n.media[m.id].binId).toBeNull();
    expect(n.media[m2.id].binId).toBe('child');
    expect(n.sequences[p.activeSequenceId!].binId).toBeNull();
  });

  it('dedupes sequenceOrder and repairs the view', () => {
    const p = createProject('v');
    const id = p.activeSequenceId!;
    p.sequenceOrder = [id, id];
    p.sequences[id].view = { playhead: NaN, zoom: 0, scroll: -5, inPoint: Infinity, outPoint: 12 };
    const n = normalizeProject(structuredClone(p));
    expect(n.sequenceOrder).toEqual([id]);
    expect(n.sequences[id].view).toEqual({ playhead: 0, zoom: 4, scroll: 0, inPoint: null, outPoint: 12 });
    p.sequences[id].view = { playhead: -3, zoom: -1, scroll: 3, inPoint: -1, outPoint: null };
    expect(normalizeProject(structuredClone(p)).sequences[id].view).toEqual({ playhead: 0, zoom: 4, scroll: 3, inPoint: null, outPoint: null });
  });
});
