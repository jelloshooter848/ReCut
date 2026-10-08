/**
 * Projects for the interchange tests (tests/unit/interchange-*.test.ts): deterministic ids, a representative fan-edit
 * sequence at 23.976, a drop-frame one at 29.97 and one cut from camera files with embedded start timecode. The goldens next to this file are their exports; the
 * `*.expected.json` sidecars are what ReCut intended (read by scripts/interchange-check.py through OpenTimelineIO).
 */
import type { Clip, ID, MediaItem, Project, Rational, Sequence, Track, Transition } from '../../../shared/model';
import { createProject, createSequence } from '../../../shared/project';
import { defaultAudio, defaultTransform } from '../../../shared/timeline';
import { parseStartTimecode } from '../../../shared/time';

export const R23: Rational = { num: 24000, den: 1001 };
export const R29: Rational = { num: 30000, den: 1001 };

export function media(id: string, path: string, over: Partial<MediaItem> = {}, opts: { fps?: Rational; dur?: number; audio?: number[]; video?: boolean; tc?: string } = {}): MediaItem {
  const fps = opts.fps ?? R23;
  const startTimecode = opts.tc ? parseStartTimecode(opts.tc, fps) : null;
  if (opts.tc && !startTimecode) throw new Error(`fixture: bad timecode ${opts.tc}`);
  const audio = (opts.audio ?? [2]).map((channels, i) => ({ index: i + 1, codec: 'aac', channels, layout: channels === 6 ? '5.1(side)' : 'stereo', sampleRate: 48000 }));
  return {
    id, name: path.split(/[\\/]/).pop()!, path, kind: opts.video === false ? 'audio' : 'video', category: 'Movie', identity: {}, binId: null,
    probe: {
      container: 'matroska,webm', duration: opts.dur ?? 3600, size: 1, audio, subtitles: [], startTime: 0, browserPlayable: true,
      ...(opts.video === false ? {} : { video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps, avgFps: fps, isVfr: false } }),
      ...(startTimecode ? { startTimecode } : {}),
    },
    offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0, ...over,
  };
}

export function still(id: string, path: string): MediaItem {
  return {
    id, name: path.split(/[\\/]/).pop()!, path, kind: 'image', category: 'Other', identity: {}, binId: null,
    probe: { container: 'png_pipe', duration: 0, size: 1, audio: [], subtitles: [], startTime: 0, browserPlayable: true, video: { index: 0, codec: 'png', width: 1280, height: 720, fps: { num: 25, den: 1 }, avgFps: { num: 25, den: 1 }, isVfr: false } },
    offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
  };
}

export function clip(id: string, mediaId: string, start: number, duration: number, sourceIn: number, over: Partial<Clip> = {}): Clip {
  return {
    id, mediaId, name: id, start, duration, sourceIn, speed: 1, linkId: null, enabled: true, kind: 'video',
    transform: defaultTransform(), audio: defaultAudio(), tags: [], characters: [], plotlines: [], locations: [], notes: '', ...over,
  };
}

export function tr(id: string, type: Transition['type'], duration: number, outClipId: string | null, inClipId: string | null): Transition {
  return { id, type, duration, outClipId, inClipId };
}

export function mkSeq(id: string, name: string, fps: Rational): Sequence {
  const s = createSequence(name, fps, 1920, 1080);
  s.id = id;
  s.createdAt = 0; s.modifiedAt = 0;
  s.videoTracks.forEach((t, i) => { t.id = `${id}-V${i + 1}`; });
  s.audioTracks.forEach((t, i) => { t.id = `${id}-A${i + 1}`; });
  return s;
}

export function put(t: Track, ...clips: Clip[]): void {
  for (const c of clips) { if (t.kind === 'audio') c.kind = 'audio'; t.clips.push(c); }
  t.clips.sort((a, b) => a.start - b.start);
}

export function mkProject(name: string, media: MediaItem[], seqs: Sequence[]): Project {
  const p = createProject(name);
  p.id = 'proj-fixture'; p.createdAt = 0; p.modifiedAt = 0;
  p.media = Object.fromEntries(media.map((m) => [m.id, m]));
  p.sequences = Object.fromEntries(seqs.map((s) => [s.id, s]));
  p.sequenceOrder = seqs.map((s) => s.id);
  p.activeSequenceId = seqs[0].id;
  return p;
}

/**
 * The representative 23.976 sequence: two video tracks (+ an offline clip on V3), linked stereo audio, an extra
 * music track, a gap, a speed change, a cross dissolve, a dip to black, an audio crossfade, a disabled clip, a nested
 * compound clip (video + linked audio), a still with a transform, markers of each kind, awkward names and paths.
 */
export function representative(): { project: Project; seqId: ID } {
  const M: MediaItem[] = [
    media('m-movie', '/media/Films/Movie One.mkv', {}, { audio: [2, 6] }),
    media('m-ep', 'C:\\Users\\Fan\\Vidéos\\Épisode #2 & "Pilot".mp4'),
    media('m-music', '/media/Music/Theme & <Song>.flac', {}, { video: false, dur: 240 }),
    still('m-card', '/media/Graphics/title card.png'),
    media('m-gone', '/media/Missing/gone.mov', { offline: true }),
  ];
  const inner = mkSeq('seq-inner', 'Inner Compound', R23);
  put(inner.videoTracks[0], clip('in-v', 'm-ep', 0, 120, 50, { linkId: 'L-in' }));
  put(inner.audioTracks[0], clip('in-a', 'm-ep', 0, 120, 50, { linkId: 'L-in' }));

  const s = mkSeq('seq-main', 'Fan Edit: Tom & Jerry <Cut> "Final" ✂', R23);
  const [V1, V2, V3] = s.videoTracks;
  const [A1, A2, A3] = s.audioTracks;
  put(V1,
    clip('c1', 'm-movie', 0, 48, 10, { linkId: 'L1', name: 'Opening' }),
    clip('c2', 'm-ep', 72, 96, 100, { linkId: 'L2', name: 'Rooftop & Chase' }),
    clip('c3', 'm-movie', 168, 72, 200, { linkId: 'L3', speed: 2, name: 'Fast run' }),
    clip('c4', 'm-ep', 240, 48, 300, { linkId: 'L4' }),
    clip('c5', 'm-movie', 300, 24, 400, { enabled: false, name: 'Cut scene' }),
  );
  V1.transitions.push(tr('t-diss', 'crossDissolve', 24, 'c2', 'c3'), tr('t-dip', 'dipToBlack', 12, 'c3', 'c4'), tr('t-fadein', 'crossDissolve', 12, null, 'c1'));
  const card = clip('card', 'm-card', 24, 36, 0, { name: 'Title card' });
  card.transform = { ...card.transform, x: 192, y: -108, scale: 0.5, opacity: 0.8, rotation: 15, crop: { left: 0.1, top: 0, right: 0, bottom: 0.05 } };
  put(V2, card, clip('nest', 'seq-inner', 120, 48, 1, { sequenceId: 'seq-inner', linkId: 'L-nest', name: 'Compound' }));
  put(V3, clip('gone', 'm-gone', 288, 24, 0));
  put(A1,
    clip('a1', 'm-movie', 0, 48, 10, { linkId: 'L1', name: 'Opening' }),
    clip('a2', 'm-ep', 72, 96, 100, { linkId: 'L2' }),
    clip('a3', 'm-movie', 168, 72, 200, { linkId: 'L3', speed: 2 }),
    clip('a4', 'm-ep', 240, 48, 300, { linkId: 'L4' }),
  );
  A1.transitions.push(tr('t-xfade', 'audioCrossfade', 12, 'a2', 'a3'));
  const music = clip('music', 'm-music', 0, 300, 0, { name: 'Theme & Song' });
  music.audio = { ...music.audio, gain: -6, fadeIn: 24, fadeOut: 48 };
  put(A2, music);
  put(A3, clip('nest-a', 'seq-inner', 120, 48, 1, { sequenceId: 'seq-inner', linkId: 'L-nest', name: 'Compound' }));
  s.markers.push(
    { id: 'mk1', time: 10, duration: 0, name: 'Intro & <title>', note: 'first beat', color: '#e5484d', kind: 'marker' },
    { id: 'mk2', time: 72, duration: 24, name: 'Part 2', note: '', color: '#4d7cfe', kind: 'chapter' },
    { id: 'mk3', time: 200, duration: 0, name: 'Jacket colour', note: 'wardrobe', color: '#f5a623', kind: 'continuity', resolved: false },
  );
  return { project: mkProject('Fixture Project', M, [s, inner]), seqId: s.id };
}

/** A 29.97 drop-frame sequence that crosses a minute boundary, with a dissolve and linked audio. */
export function dropFrame(): { project: Project; seqId: ID } {
  const M = [media('m-ntsc', '/media/NTSC/Show 01.mp4', {}, { fps: R29 })];
  const s = mkSeq('seq-df', 'NTSC Cut', R29);
  const [V1] = s.videoTracks;
  const [A1] = s.audioTracks;
  put(V1, clip('d1', 'm-ntsc', 0, 1790, 5, { linkId: 'D1' }), clip('d2', 'm-ntsc', 1790, 300, 120, { linkId: 'D2' }));
  V1.transitions.push(tr('t-df', 'crossDissolve', 30, 'd1', 'd2'));
  put(A1, clip('da1', 'm-ntsc', 0, 1790, 5, { linkId: 'D1' }), clip('da2', 'm-ntsc', 1790, 300, 120, { linkId: 'D2' }));
  s.markers.push({ id: 'mdf', time: 1800, duration: 0, name: 'One minute', note: '', color: '#30a46c', kind: 'marker' });
  return { project: mkProject('NTSC Project', M, [s]), seqId: s.id };
}

/**
 * A 29.97 sequence cut from camera files with embedded start timecode: a drop-frame one (01:00:00;00), a non-drop one
 * at the same rate (01:00:00:00 NDF = frame 108000), and a file without timecode; a dissolve, linked audio, a speed
 * change and a marker.
 */
export function sourceTimecode(): { project: Project; seqId: ID } {
  const M = [
    media('m-cam-df', '/media/Camera/A001_C002.mov', {}, { fps: R29, dur: 600, tc: '01:00:00;00' }),
    media('m-cam-ndf', '/media/Camera/B001 NDF.mp4', {}, { fps: R29, dur: 600, tc: '01:00:00:00' }),
    media('m-plain', '/media/Plain/screen.mkv', {}, { fps: R29, dur: 600 }),
  ];
  const s = mkSeq('seq-tc', 'Camera Cut', R29);
  const [V1] = s.videoTracks;
  const [A1] = s.audioTracks;
  put(V1,
    clip('k1', 'm-cam-df', 0, 120, 2, { linkId: 'K1', name: 'Camera A' }),
    clip('k2', 'm-cam-ndf', 120, 150, 10, { linkId: 'K2', name: 'Camera B' }),
    clip('k3', 'm-plain', 270, 60, 1),
    clip('k4', 'm-cam-ndf', 330, 60, 30, { speed: 2, name: 'Camera B fast' }),
  );
  V1.transitions.push(tr('t-k', 'crossDissolve', 20, 'k1', 'k2'));
  put(A1, clip('ka1', 'm-cam-df', 0, 120, 2, { linkId: 'K1' }), clip('ka2', 'm-cam-ndf', 120, 150, 10, { linkId: 'K2' }));
  s.markers.push({ id: 'mtc', time: 200, duration: 0, name: 'B roll', note: '', color: '#4d7cfe', kind: 'marker' });
  return { project: mkProject('Camera Project', M, [s]), seqId: s.id };
}
