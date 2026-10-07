/**
 * Centre-channel utility (Roadmap §9 quick utility): per-clip channel selection on multichannel streams and Extract
 * Centre Channel (Dialogue).
 *
 * Covers the pure channel maths (layouts, channel ids, pan filter strings), model defaults and load-time repair,
 * the timeline ops and store actions (one undo step each), the render graph's per-clip `pan` filter and its
 * fallback warning, the pre-export warning, the preview planner (channel proxy pending / ready), the Program
 * monitor's missing-media split, which channel proxies the clips need, and the channel proxy job's arguments.
 * FFmpeg runs in centre-channel-ffmpeg.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { AudioStreamInfo, Clip, ExportSettings, MediaItem, Sequence } from '../../shared/model';
import type { ExportRequest } from '../../shared/ipc';
import { createMediaItem, createProject, createSequence, normalizeProject, normalizeProjectWithReport } from '../../shared/project';
import { addChannelClip, defaultAudio, defaultTransform, findClip, makeClip, setClipChannelSelection } from '../../shared/timeline';
import {
  canDownmix, centreExtraction, channelIndex, channelLabel, channelPanFilter, channelProxyKey, channelSelectionLabel, channelSelectionProblem,
  CHANNEL_PROXY_KEY, hasCentreChannel, isMultichannel, layoutChannelNames, normalizeChannelSelection, resolveChannelSelection, streamChannelIds,
} from '../../shared/audioChannels';
import { buildRenderGraph } from '../../electron/export/renderGraph';
import { buildChannelProxyArgs, channelProxyOutputPath } from '../../electron/media/channelProxy';
import { planFrame } from '../../src/playback/planner';
import { clipChannelProxy } from '../../src/playback/mediaSource';
import { classifyMissing, sequenceMissing } from '../../src/panels/program/missing';
import { sequenceExportWarnings } from '../../src/panels/export/settings';
import { wantedChannelProxies } from '../../src/app/channelProxies';
import { useStore, resetStore, getUndoLabels } from '../../src/state/store';
import { activeSequence } from '../../src/state/selectors';

const FPS = { num: 24, den: 1 };
const st = (layout: string, channels: number, index = 1, extra: Partial<AudioStreamInfo> = {}): AudioStreamInfo =>
  ({ index, codec: 'ac3', channels, layout, sampleRate: 48000, ...extra });

/** A film with H.264 #0, AC-3 5.1 #1 and AAC stereo commentary #2. */
function film(over: Partial<MediaItem> = {}): MediaItem {
  return {
    ...createMediaItem('/media/film.mkv', 'film.mkv'),
    id: 'F', kind: 'video', preferredAudioStream: 1,
    probe: {
      container: 'matroska', duration: 600, size: 1, startTime: 0, browserPlayable: false, subtitles: [],
      audio: [st('5.1(side)', 6, 1), st('stereo', 2, 2, { codec: 'aac' })],
      video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: FPS, avgFps: FPS, isVfr: false },
    },
    ...over,
  };
}

function clip(id: string, kind: 'video' | 'audio', start: number, duration: number, over: Partial<Clip> = {}): Clip {
  return {
    id, mediaId: 'F', name: id, start, duration, sourceIn: 10, speed: 1, linkId: null, enabled: true, kind,
    transform: defaultTransform(), audio: defaultAudio(), tags: [], characters: [], plotlines: [], locations: [], notes: '', ...over,
  };
}

// ------------------------------------------------------------------ channel maths

describe('channel layouts and ids', () => {
  it('names channels from the layout ffprobe reports, in FFmpeg decode order', () => {
    expect(layoutChannelNames(st('5.1', 6))).toEqual(['FL', 'FR', 'FC', 'LFE', 'BL', 'BR']);
    expect(layoutChannelNames(st('5.1(side)', 6))).toEqual(['FL', 'FR', 'FC', 'LFE', 'SL', 'SR']);
    expect(layoutChannelNames(st('7.1', 8))).toEqual(['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR']);
    expect(layoutChannelNames(st('stereo', 2))).toEqual(['FL', 'FR']);
    expect(layoutChannelNames(st('6 channels (FL+FR+FC+LFE+SL+SR)', 6))).toEqual(['FL', 'FR', 'FC', 'LFE', 'SL', 'SR']);
    expect(layoutChannelNames(st('FL+FR+FC', 3))).toEqual(['FL', 'FR', 'FC']);
  });

  it('falls back to channel numbers when the layout is unknown (guessed, unknown name, wrong count)', () => {
    expect(layoutChannelNames(st('5.1', 6, 1, { layoutGuessed: true }))).toBeNull();
    expect(layoutChannelNames(st('6 channels', 6))).toBeNull();
    expect(layoutChannelNames(st('5.1', 8))).toBeNull();
    expect(layoutChannelNames({ channels: 6, layout: 42 as unknown as string })).toBeNull();
    expect(streamChannelIds(st('6 channels', 6))).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
    expect(channelLabel('c2')).toBe('Channel 3');
    expect(channelLabel('FC')).toBe('Centre (FC)');
    expect(channelIndex(st('6 channels', 6), 'c5')).toBe(5);
    expect(channelIndex(st('6 channels', 6), 'c6')).toBe(-1);
    expect(channelIndex(st('6 channels', 6), 'FC')).toBe(-1);
    expect(channelIndex(st('5.1', 6), 'c2')).toBe(2); // a number addresses a known layout by position too
  });

  it('what a stream offers: selection from 2 channels, downmix from 3 in a known layout, centre only with FC', () => {
    expect(isMultichannel(st('mono', 1))).toBe(false);
    expect(isMultichannel(st('stereo', 2))).toBe(true);
    expect(canDownmix(st('stereo', 2))).toBe(false);
    expect(canDownmix(st('5.1', 6))).toBe(true);
    expect(canDownmix(st('5.1', 6, 1, { layoutGuessed: true }))).toBe(false);
    expect(hasCentreChannel(st('5.1', 6))).toBe(true);
    expect(hasCentreChannel(st('7.1', 8))).toBe(true);
    expect(hasCentreChannel(st('quad', 4))).toBe(false);
    expect(hasCentreChannel(st('mono', 1))).toBe(false); // mono is "FC" in FFmpeg, but not a centre channel
    expect(hasCentreChannel(st('stereo', 2))).toBe(false);
    expect(hasCentreChannel(st('5.1', 6, 1, { layoutGuessed: true }))).toBe(false);
  });
});

describe('pan filter strings (export and channel proxy share them)', () => {
  const FC = { mode: 'channel', channel: 'FC' } as const;
  it('one channel as mono: centred at -3.01 dB per side in stereo, the centre speaker in 5.1', () => {
    expect(channelPanFilter(FC, st('5.1', 6), 'stereo')).toBe('pan=stereo|c0=0.707107*c2|c1=0.707107*c2');
    expect(channelPanFilter(FC, st('5.1', 6), '5.1')).toBe('pan=5.1|c2=1*c2');
    expect(channelPanFilter(FC, st('5.1', 6), 'mono')).toBe('pan=mono|c0=1*c2');
    expect(channelPanFilter({ mode: 'channel', channel: 'LFE' }, st('7.1', 8), 'stereo')).toBe('pan=stereo|c0=0.707107*c3|c1=0.707107*c3');
    expect(channelPanFilter({ mode: 'channel', channel: 'FR' }, st('stereo', 2), 'stereo')).toBe('pan=stereo|c0=0.707107*c1|c1=0.707107*c1');
    expect(channelPanFilter({ mode: 'channel', channel: 'c4' }, st('6 channels', 6), 'stereo')).toBe('pan=stereo|c0=0.707107*c4|c1=0.707107*c4');
  });

  it('controlled downmix: BS.775 defaults, LFE omitted, exact gains (no renormalisation)', () => {
    const dm = { mode: 'downmix', centreDb: -3, surroundDb: -3 } as const;
    expect(channelPanFilter(dm, st('5.1', 6), 'stereo')).toBe('pan=stereo|c0=1*c0+0.707946*c2+0.707946*c4|c1=1*c1+0.707946*c2+0.707946*c5');
    expect(channelPanFilter(dm, st('5.1(side)', 6), 'stereo')).toBe('pan=stereo|c0=1*c0+0.707946*c2+0.707946*c4|c1=1*c1+0.707946*c2+0.707946*c5');
    expect(channelPanFilter({ mode: 'downmix', centreDb: 0, surroundDb: -6 }, st('7.1', 8), 'stereo'))
      .toBe('pan=stereo|c0=1*c0+1*c2+0.501187*c4+0.501187*c6|c1=1*c1+1*c2+0.501187*c5+0.501187*c7');
    // 4.0 has a back centre: both sides at the surround level (BS.775 3/1).
    expect(channelPanFilter(dm, st('4.0', 4), 'stereo')).toBe('pan=stereo|c0=1*c0+0.707946*c2+0.707946*c3|c1=1*c1+0.707946*c2+0.707946*c3');
    // A 5.1 mix takes the stereo downmix on its front pair (aformat upmixes stereo after the pan).
    expect(channelPanFilter(dm, st('5.1', 6), '5.1')).toBe('pan=stereo|c0=1*c0+0.707946*c2+0.707946*c4|c1=1*c1+0.707946*c2+0.707946*c5');
  });

  it('no filter for the normal mix or a selection the stream cannot honour, with the reason', () => {
    expect(channelPanFilter(undefined, st('5.1', 6), 'stereo')).toBeNull();
    expect(channelPanFilter(FC, st('stereo', 2), 'stereo')).toBeNull();
    expect(channelSelectionProblem(FC, st('stereo', 2))).toMatch(/has no Centre \(FC\) channel/);
    expect(channelPanFilter(FC, st('mono', 1), 'stereo')).toBeNull();
    expect(channelSelectionProblem(FC, st('mono', 1))).toBe('the stream is mono');
    const dm = { mode: 'downmix', centreDb: -3, surroundDb: -3 } as const;
    expect(channelPanFilter(dm, st('stereo', 2), 'stereo')).toBeNull();
    expect(channelSelectionProblem(dm, st('6 channels', 6))).toMatch(/unknown/);
    expect(channelSelectionProblem(FC, st('5.1', 6))).toBeNull();
    expect(resolveChannelSelection(FC, st('5.1', 6))).toEqual({ mode: 'channel', index: 2, channel: 'FC' });
  });

  it('labels and proxy keys', () => {
    expect(channelSelectionLabel(undefined)).toBe('Normal mix');
    expect(channelSelectionLabel({ mode: 'channel', channel: 'FC' })).toBe('Centre (FC)');
    expect(channelSelectionLabel({ mode: 'downmix', centreDb: -3, surroundDb: 1.5 })).toBe('Stereo downmix (centre −3 dB, surround +1.5 dB)');
    const keys = [
      channelProxyKey(1, { mode: 'channel', channel: 'FC' }), channelProxyKey(12, { mode: 'channel', channel: 'c3' }),
      channelProxyKey(1, { mode: 'downmix', centreDb: -3, surroundDb: -3 }), channelProxyKey(1, { mode: 'downmix', centreDb: 0, surroundDb: -4.5 }),
      channelProxyKey(1, { mode: 'downmix', centreDb: 6, surroundDb: -60 }),
    ];
    expect(keys).toEqual(['1.ch-FC', '12.ch-c3', '1.dm-c-3-s-3', '1.dm-c0-s-4.5', '1.dm-c6-s-60']);
    for (const k of keys) expect(CHANNEL_PROXY_KEY.test(k)).toBe(true);
    for (const k of ['x.ch-FC', '1.ch-fc', '1.ch-FC/..', '1.dm-c-3', '__proto__']) expect(CHANNEL_PROXY_KEY.test(k)).toBe(false);
  });
});

// ------------------------------------------------------------------ model

describe('model defaults and normalizeProject', () => {
  it('new clips play the normal mix; the format version stays 1', () => {
    expect(defaultAudio()).not.toHaveProperty('channelSelection');
    expect(makeClip({ mediaId: 'F', name: 'c', sourceIn: 0, duration: 10, kind: 'audio' }, 0).audio).not.toHaveProperty('channelSelection');
    expect(createProject('p').formatVersion).toBe(1);
  });

  it('normalizeChannelSelection keeps valid selections, clamps levels, drops the rest', () => {
    expect(normalizeChannelSelection(undefined)).toEqual({ value: undefined, repaired: false });
    expect(normalizeChannelSelection({ mode: 'channel', channel: 'FC' })).toEqual({ value: { mode: 'channel', channel: 'FC' }, repaired: false });
    expect(normalizeChannelSelection({ mode: 'channel', channel: 'c11' }).value).toEqual({ mode: 'channel', channel: 'c11' });
    expect(normalizeChannelSelection({ mode: 'downmix', centreDb: -3, surroundDb: -4.5 })).toEqual({ value: { mode: 'downmix', centreDb: -3, surroundDb: -4.5 }, repaired: false });
    expect(normalizeChannelSelection({ mode: 'downmix', centreDb: -300, surroundDb: 99 })).toEqual({ value: { mode: 'downmix', centreDb: -60, surroundDb: 6 }, repaired: true });
    expect(normalizeChannelSelection({ mode: 'downmix' })).toEqual({ value: { mode: 'downmix', centreDb: -3, surroundDb: -3 }, repaired: true });
    expect(normalizeChannelSelection({ mode: 'downmix', centreDb: -3.04, surroundDb: -3 }).value).toEqual({ mode: 'downmix', centreDb: -3, surroundDb: -3 });
    for (const bad of [null, 3, 'FC', [], { mode: 'channel' }, { mode: 'channel', channel: 'fc' }, { mode: 'channel', channel: 'c' }, { mode: 'stems' }]) {
      expect(normalizeChannelSelection(bad)).toEqual({ value: undefined, repaired: true });
    }
  });

  function projectWith(audio: unknown, channelProxies?: unknown): unknown {
    const p = createProject('p') as unknown as { media: Record<string, unknown>; sequences: Record<string, Sequence>; activeSequenceId: string };
    const m: Record<string, unknown> = { ...film() };
    if (channelProxies !== undefined) m.channelProxies = channelProxies;
    p.media.F = m;
    const seq = p.sequences[p.activeSequenceId];
    seq.audioTracks[0].clips.push({ ...clip('a', 'audio', 0, 24), audio: audio as Clip['audio'] });
    return JSON.parse(JSON.stringify(p));
  }
  const loadedClip = (raw: unknown) => { const p = normalizeProject(raw); return p.sequences[p.activeSequenceId!].audioTracks[0].clips[0]; };

  it('a loaded clip keeps a valid selection and loses an unusable one (reported as a repair)', () => {
    expect(loadedClip(projectWith({ ...defaultAudio(), channelSelection: { mode: 'channel', channel: 'FC' } })).audio.channelSelection).toEqual({ mode: 'channel', channel: 'FC' });
    expect(normalizeProjectWithReport(projectWith({ ...defaultAudio(), channelSelection: { mode: 'channel', channel: 'FC' } })).repairs).toEqual([]);
    const bad = normalizeProjectWithReport(projectWith({ ...defaultAudio(), channelSelection: { mode: 'karaoke' } }));
    expect(bad.project.sequences[bad.project.activeSequenceId!].audioTracks[0].clips[0].audio).not.toHaveProperty('channelSelection');
    expect(bad.repairs.length).toBeGreaterThan(0);
    expect(loadedClip(projectWith(defaultAudio())).audio).not.toHaveProperty('channelSelection');
  });

  it('channel proxies: ready / failed kept, unfinished jobs and bad keys dropped, an empty record removed', () => {
    const p = normalizeProject(projectWith(defaultAudio(), {
      '1.ch-FC': { status: 'ready', path: '/c/x_ch1.ch-FC_v1.m4a', progress: 1 },
      '1.dm-c-3-s-3': { status: 'failed', error: 'boom' },
      '1.ch-FL': { status: 'running', progress: 0.4 },
      'nonsense': { status: 'ready', path: '/x' },
    }));
    expect(p.media.F.channelProxies).toEqual({
      '1.ch-FC': { status: 'ready', path: '/c/x_ch1.ch-FC_v1.m4a', progress: 1 },
      '1.dm-c-3-s-3': { status: 'failed', error: 'boom' },
    });
    expect(normalizeProject(projectWith(defaultAudio(), { '1.ch-FL': { status: 'queued' } })).media.F).not.toHaveProperty('channelProxies');
    expect(normalizeProject(projectWith(defaultAudio(), 'oops')).media.F).not.toHaveProperty('channelProxies');
    expect(normalizeProject(projectWith(defaultAudio())).media.F).not.toHaveProperty('channelProxies');
  });
});

// ------------------------------------------------------------------ timeline ops

describe('timeline ops', () => {
  it('setClipChannelSelection: audio clips only, never on locked tracks, unchanged clips untouched', () => {
    const s = createSequence('x', FPS);
    s.audioTracks[0].clips.push(clip('a', 'audio', 0, 10));
    s.audioTracks[1].clips.push(clip('b', 'audio', 0, 10));
    s.videoTracks[0].clips.push(clip('v', 'video', 0, 10));
    s.audioTracks[1].locked = true;
    const FC = { mode: 'channel', channel: 'FC' } as const;
    expect(setClipChannelSelection(s, ['a', 'b', 'v'], FC).map((c) => c.id)).toEqual(['a']);
    expect(s.audioTracks[0].clips[0].audio.channelSelection).toEqual(FC);
    expect(s.audioTracks[1].clips[0].audio).not.toHaveProperty('channelSelection');
    expect(s.videoTracks[0].clips[0].audio).not.toHaveProperty('channelSelection');
    expect(setClipChannelSelection(s, ['a'], { ...FC })).toEqual([]);
    expect(setClipChannelSelection(s, ['a'], undefined).map((c) => c.id)).toEqual(['a']);
    expect(s.audioTracks[0].clips[0].audio).not.toHaveProperty('channelSelection');
  });

  it('addChannelClip: same range, position, speed and levels; linked; first free track below', () => {
    const s = createSequence('x', FPS);
    const a = clip('a', 'audio', 24, 48, { linkId: 'L', speed: 2, audioStream: 1, audio: { ...defaultAudio(), gain: -2, fadeIn: 3, muted: true } });
    s.videoTracks[0].clips.push(clip('v', 'video', 24, 48, { linkId: 'L', speed: 2 }));
    s.audioTracks[0].clips.push(a);
    s.audioTracks[1].clips.push(clip('busy', 'audio', 60, 10)); // A2 overlaps [24, 72): skip it
    const r = addChannelClip(s, 'v', { name: 'a (centre)', audioStream: 1, selection: { mode: 'channel', channel: 'FC' } })!;
    expect(r.trackId).toBe(s.audioTracks[2].id);
    expect(r.newTrack).toBe(false);
    expect(s.audioTracks[2].clips).toHaveLength(1);
    expect(r.clip).toMatchObject({
      mediaId: 'F', name: 'a (centre)', start: 24, duration: 48, sourceIn: 10, speed: 2, linkId: 'L', kind: 'audio', audioStream: 1, enabled: true,
      audio: { gain: -2, volume: 1, fadeIn: 3, fadeOut: 0, muted: false, channelSelection: { mode: 'channel', channel: 'FC' } },
    });
    // Nothing else moved.
    expect(s.audioTracks[0].clips.map((c) => [c.id, c.start])).toEqual([['a', 24]]);
    expect(s.audioTracks[1].clips.map((c) => [c.id, c.start])).toEqual([['busy', 60]]);
  });

  it('addChannelClip: a new bottom track when no track below is free; a new link when there was none', () => {
    const s = createSequence('x', FPS);
    s.audioTracks[0].clips.push(clip('top', 'audio', 0, 100));
    s.audioTracks[1].clips.push(clip('a', 'audio', 10, 20));
    s.audioTracks[2].clips.push(clip('x', 'audio', 0, 100));
    const n = s.audioTracks.length;
    const r = addChannelClip(s, 'a', { name: 'c', selection: { mode: 'channel', channel: 'FC' } })!;
    expect(r.newTrack).toBe(true);
    expect(s.audioTracks).toHaveLength(n + 1);
    expect(s.audioTracks[n].id).toBe(r.trackId);
    expect(s.audioTracks[n].name).toBe(`A${n + 1}`);
    const src = findClip(s, 'a')!.clip;
    expect(src.linkId).toBeTruthy();
    expect(r.clip.linkId).toBe(src.linkId);
    expect(r.clip).not.toHaveProperty('audioStream');
    expect(addChannelClip(s, 'nope', { name: 'c', selection: { mode: 'channel', channel: 'FC' } })).toBeNull();
  });

  it('addChannelClip: a picture without sound searches from the top; locked tracks are skipped', () => {
    const s = createSequence('x', FPS);
    s.videoTracks[0].clips.push(clip('v', 'video', 0, 10));
    s.audioTracks[0].locked = true;
    const r = addChannelClip(s, 'v', { name: 'c', selection: { mode: 'channel', channel: 'FC' } })!;
    expect(r.trackId).toBe(s.audioTracks[1].id);
  });
});

// ------------------------------------------------------------------ store

describe('store: Extract Centre Channel and channel selection', () => {
  const S = () => useStore.getState();
  let seqId = '';
  beforeEach(() => {
    resetStore();
    const s = createSequence('t', FPS);
    S().addSequence(s);
    seqId = s.id;
    S().clearHistory();
  });
  const seq = () => activeSequence(S())!;
  function insert(m: MediaItem): { v: string; a: string } {
    S().addMedia([m]);
    const [v, a] = S().insertFromSource(seqId, { mediaId: m.id, in: 1, out: 3, atFrame: 12, mode: 'insert' });
    S().clearHistory();
    return { v, a };
  }

  it('extracts the centre of a 5.1 source as one undo step, selected, linked, on the track below', () => {
    const { v, a } = insert(film());
    const before = S().project;
    const r = S().extractCentreChannel(seqId, v);
    if (!r.ok) throw new Error(r.reason);
    expect(getUndoLabels(S()).undo).toBe('Extract Centre Channel');
    expect(S().ui.selectedClipIds).toEqual([r.clipId]);
    const loc = findClip(seq(), r.clipId)!;
    const src = findClip(seq(), a)!;
    expect(loc.track.id).toBe(seq().audioTracks[seq().audioTracks.indexOf(src.track) + 1].id);
    expect(loc.clip).toMatchObject({
      name: `${src.clip.name} (centre)`, start: src.clip.start, duration: src.clip.duration, sourceIn: src.clip.sourceIn,
      linkId: src.clip.linkId, audioStream: 1, audio: { channelSelection: { mode: 'channel', channel: 'FC' } },
    });
    expect(src.clip.audio).not.toHaveProperty('channelSelection');
    S().undo();
    expect(S().project.sequences[seqId]).toBe(before.sequences[seqId]);
    S().redo();
    expect(findClip(seq(), r.clipId)).toBeTruthy();
  });

  it('is refused with the reason when the source has no centre channel, and changes nothing', () => {
    const { a } = insert(film({ id: 'S', preferredAudioStream: 2 }));
    const before = S().project;
    const r = S().extractCentreChannel(seqId, a);
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/stereo\) has no centre channel/) });
    expect(S().project).toBe(before);
    expect(centreExtraction(seq(), S().project.media, a)).toMatchObject({ ok: false });
    expect(centreExtraction(seq(), S().project.media, 'nope')).toEqual({ ok: false, reason: 'Select a clip first.' });
  });

  it('follows the clip stream: a clip on the stereo commentary has no centre even though the media has 5.1', () => {
    const { a } = insert(film());
    S().setClipAudioStream(seqId, [a], 2);
    expect(S().extractCentreChannel(seqId, a).ok).toBe(false);
    S().setClipAudioStream(seqId, [a], 1);
    expect(S().extractCentreChannel(seqId, a).ok).toBe(true);
  });

  it('setClipChannelSelection is one undo step and clears back to the normal mix', () => {
    const { v, a } = insert(film());
    S().setClipChannelSelection(seqId, [v, a], { mode: 'downmix', centreDb: -3, surroundDb: -3 });
    expect(findClip(seq(), a)!.clip.audio.channelSelection).toEqual({ mode: 'downmix', centreDb: -3, surroundDb: -3 });
    expect(findClip(seq(), v)!.clip.audio).not.toHaveProperty('channelSelection');
    expect(getUndoLabels(S()).undo).toBe('Audio channels');
    S().setClipChannelSelection(seqId, [a], undefined);
    expect(findClip(seq(), a)!.clip.audio).not.toHaveProperty('channelSelection');
    S().undo();
    expect(findClip(seq(), a)!.clip.audio.channelSelection).toMatchObject({ mode: 'downmix' });
  });

  it('channel proxy mirrors are quiet and survive undo', () => {
    const { a } = insert(film());
    S().setClipChannelSelection(seqId, [a], { mode: 'channel', channel: 'FC' });
    S().setChannelProxies('F', { '1.ch-FC': { status: 'ready', path: '/cache/p.m4a', progress: 1 } });
    expect(getUndoLabels(S()).undo).toBe('Audio channels');
    S().undo();
    expect(S().project.media.F.channelProxies).toEqual({ '1.ch-FC': { status: 'ready', path: '/cache/p.m4a', progress: 1 } });
    S().setChannelProxies('F', { '1.ch-FC': null });
    expect(S().project.media.F).not.toHaveProperty('channelProxies');
  });
});

// ------------------------------------------------------------------ export

function exportReq(seq: Sequence, media: MediaItem[], over: Partial<ExportSettings> = {}): ExportRequest {
  const settings: ExportSettings = {
    outputDir: '/tmp/out', fileName: 'x.mp4', width: 320, height: 240, fps: FPS, videoCodec: 'libx264', qualityMode: 'crf', crf: 23,
    videoBitrateKbps: 2000, preset: 'ultrafast', audioCodec: 'aac', audioBitrateKbps: 192, audioChannels: 2, sampleRate: 48000,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false, ...over,
  };
  return { sequence: seq, media: Object.fromEntries(media.map((m) => [m.id, m])), settings };
}

describe('render graph: the per-clip pan filter', () => {
  function seqWith(sel: Clip['audio']['channelSelection'], audioStream?: number): Sequence {
    const s = createSequence('x', FPS, 320, 240);
    s.audioTracks[0].clips.push(clip('a', 'audio', 0, 24, { audioStream, audio: { ...defaultAudio(), channelSelection: sel } }));
    return s;
  }

  it('applies the selection first in the clip chain, for stereo and 5.1 exports', () => {
    const g = buildRenderGraph(exportReq(seqWith({ mode: 'channel', channel: 'FC' }, 1), [film()]));
    expect(g.filterGraph).toMatch(/\[0:1\]pan=stereo\|c0=0\.707107\*c2\|c1=0\.707107\*c2,atrim=start=/);
    expect(g.warnings).toEqual([]);
    const six = buildRenderGraph(exportReq(seqWith({ mode: 'channel', channel: 'FC' }, 1), [film()], { audioChannels: 6, audioCodec: 'ac3' }));
    expect(six.filterGraph).toMatch(/\[0:1\]pan=5\.1\|c2=1\*c2,atrim=/);
    const dm = buildRenderGraph(exportReq(seqWith({ mode: 'downmix', centreDb: -3, surroundDb: -6 }, 1), [film()]));
    expect(dm.filterGraph).toContain('[0:1]pan=stereo|c0=1*c0+0.707946*c2+0.501187*c4|c1=1*c1+0.707946*c2+0.501187*c5,atrim=');
  });

  it('the normal mix has no pan; an unavailable selection exports the normal mix with a warning', () => {
    expect(buildRenderGraph(exportReq(seqWith(undefined, 1), [film()])).filterGraph).not.toContain('pan=');
    const g = buildRenderGraph(exportReq(seqWith({ mode: 'channel', channel: 'FC' }, 2), [film()]));
    expect(g.filterGraph).not.toContain('pan=');
    expect(g.warnings).toEqual([expect.stringMatching(/^Clip "a": Centre \(FC\) cannot be used \(the stream \(stereo\) has no Centre \(FC\) channel\); exporting the stream's normal mix\.$/)]);
  });

  it('the pre-export checklist predicts the fallback (and nothing for an available selection)', () => {
    const ok = sequenceExportWarnings(seqWith({ mode: 'channel', channel: 'FC' }, 1), { F: film() }, 0, 24);
    expect(ok.filter((i) => /Channel selection/.test(i.text))).toEqual([]);
    const bad = sequenceExportWarnings(seqWith({ mode: 'channel', channel: 'FC' }, 2), { F: film() }, 0, 24);
    const item = bad.find((i) => /Channel selection/.test(i.text))!;
    expect(item.level).toBe('warning');
    expect(item.text).toMatch(/"a" \(Centre \(FC\): the stream \(stereo\) has no Centre \(FC\) channel\)\. These clips export the stream's normal mix\./);
    expect(item.target).toEqual({ frame: 0, clipIds: ['a'] });
  });
});

// ------------------------------------------------------------------ preview

describe('preview: channel proxies', () => {
  function seqWith(sel: Clip['audio']['channelSelection']): Sequence {
    const s = createSequence('x', FPS, 320, 240);
    s.audioTracks[0].clips.push(clip('a', 'audio', 0, 24, { audioStream: 1, audio: { ...defaultAudio(), channelSelection: sel } }));
    return s;
  }
  const FC = { mode: 'channel', channel: 'FC' } as const;

  it('a pending channel proxy is reported like a pending proxy (silent), a ready one plays from offset 0', () => {
    const s = seqWith(FC);
    const proxied = film({ proxy: { status: 'ready', path: '/cache/film_540p_all.mp4', audioStreams: [1, 2] } });
    const pending = planFrame(s, { F: { ...proxied, channelProxies: { '1.ch-FC': { status: 'running', progress: 0.3 } } } }, 5, true);
    expect(pending.audio).toEqual([]);
    expect(pending.missing).toEqual([{ clipId: 'a', mediaId: 'F', reason: 'preview audio for Centre (FC) in progress', channelProxy: true }]);
    const none = planFrame(s, { F: proxied }, 5, true);
    expect(none.missing[0].reason).toBe('preview audio for Centre (FC) not built yet');
    const failed = planFrame(s, { F: { ...proxied, channelProxies: { '1.ch-FC': { status: 'failed', error: 'x' } } } }, 5, true);
    expect(failed.missing[0].reason).toBe('preview audio for Centre (FC) failed: x');
    const ready = planFrame(s, { F: { ...proxied, channelProxies: { '1.ch-FC': { status: 'ready', path: '/cache/fc.m4a' } } } }, 5, true);
    expect(ready.missing).toEqual([]);
    expect(ready.audio).toEqual([expect.objectContaining({ clipId: 'a', path: '/cache/fc.m4a', usingProxy: true, timeOffset: 0, audioTrack: -1, audioStream: 1, gain: 1 })]);
    expect(ready.audio[0].sourceTime).toBeCloseTo(10 + 5 / 24, 9);
  });

  it('the normal mix and an unavailable selection play the media as before', () => {
    const m = film({ proxy: { status: 'ready', path: '/cache/film_540p_all.mp4', audioStreams: [1, 2] } });
    const normal = planFrame(seqWith(undefined), { F: m }, 5, true);
    expect(normal.audio[0]).toMatchObject({ path: '/cache/film_540p_all.mp4', audioTrack: 0 });
    const s = seqWith(FC);
    s.audioTracks[0].clips[0].audioStream = 2; // stereo commentary: no centre, the normal mix (as the export)
    expect(planFrame(s, { F: m }, 5, true).audio[0]).toMatchObject({ path: '/cache/film_540p_all.mp4', audioTrack: 1 });
    expect(clipChannelProxy(m, s.audioTracks[0].clips[0])).toBeNull();
  });

  it('offline media stays offline; the Program monitor counts pending channel proxies as needing a proxy', () => {
    const s = seqWith(FC);
    expect(planFrame(s, { F: film({ offline: true }) }, 5, true).missing[0].reason).toBe('media offline');
    const m = film({ probe: { ...film().probe!, browserPlayable: true }, channelProxies: { '1.ch-FC': { status: 'queued' } } });
    const missing = sequenceMissing(s, { F: m }, true, () => undefined);
    expect(missing).toEqual([{ clipId: 'a', mediaId: 'F', reason: 'preview audio for Centre (FC) in progress', channelProxy: true }]);
    expect(classifyMissing(missing, { F: m })).toEqual({ offline: 0, needsProxy: 1, other: 0, proxyMediaIds: [], proxyBusy: true });
    const ready = { ...m, channelProxies: { '1.ch-FC': { status: 'ready' as const, path: '/c.m4a' } } };
    expect(sequenceMissing(s, { F: ready }, true, () => undefined)).toEqual([]);
  });

  it('wantedChannelProxies: one per (media, stream, selection) that a clip can play', () => {
    const p = createProject('p');
    const s = p.sequences[p.activeSequenceId!];
    s.audioTracks[0].clips.push(clip('a', 'audio', 0, 24, { audioStream: 1, audio: { ...defaultAudio(), channelSelection: FC } }));
    s.audioTracks[1].clips.push(clip('b', 'audio', 0, 24, { audio: { ...defaultAudio(), channelSelection: FC } })); // preferred #1: same key
    s.audioTracks[2].clips.push(clip('c', 'audio', 0, 24, { audioStream: 2, audio: { ...defaultAudio(), channelSelection: FC } })); // stereo: none
    s.audioTracks[2].clips.push(clip('d', 'audio', 30, 24, { audioStream: 1, audio: { ...defaultAudio(), channelSelection: { mode: 'downmix', centreDb: -3, surroundDb: -3 } } }));
    p.media.F = film();
    const w = wantedChannelProxies(p);
    expect([...w.get('F')!.values()]).toEqual([
      { mediaId: 'F', key: '1.ch-FC', stream: 1, selection: FC },
      { mediaId: 'F', key: '1.dm-c-3-s-3', stream: 1, selection: { mode: 'downmix', centreDb: -3, surroundDb: -3 } },
    ]);
    p.media.F = film({ offline: true });
    expect(wantedChannelProxies(p).size).toBe(0);
  });

  it('the channel proxy job: the stream through the export\'s stereo pan, padded to the container start', () => {
    const args = buildChannelProxyArgs('/media/film.mkv', 1, 'pan=stereo|c0=0.707107*c2|c1=0.707107*c2', '/cache/p.m4a.part-1');
    expect(args).toEqual([
      '-i', 'file:/media/film.mkv', '-map', '0:1', '-vn', '-sn', '-dn',
      '-af', 'pan=stereo|c0=0.707107*c2|c1=0.707107*c2,aresample=async=1:first_pts=0',
      '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart',
      '-f', 'mp4', 'file:/cache/p.m4a.part-1',
    ]);
    expect(channelProxyOutputPath('abc', '1.ch-FC')).toMatch(/[\\/]proxies[\\/]abc_ch1\.ch-FC_v1\.m4a$/);
  });
});
