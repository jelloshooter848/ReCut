/**
 * Deterministic random export requests for the export-plan parity tests (tests/unit/export-warnings.test.ts):
 * sequences with adjacent and gapped clips, transitions of every length (odd ones too), fades, short source handles
 * at both ends, stills, speed changes, overlaps, disabled clips, missing / offline / unprobed media, linked pairs,
 * muted / soloed tracks, In/Out ranges and media at other frame rates. Ids are fixed, so a seed always builds the
 * same request.
 */
import type { Clip, ExportSettings, MediaItem, MediaProbe, Rational, Sequence, Track, TransitionType } from '../../shared/model';
import type { ExportRequest } from '../../shared/ipc';
import { createSequence } from '../../shared/project';
import { makeClip } from '../../shared/timeline';

export function mulberry32(a: number): () => number {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ri = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

const R = (num: number, den = 1): Rational => ({ num, den });
export const FIXTURE_RATES: Rational[] = [R(24), R(25), R(24000, 1001), R(30000, 1001), R(30)];

export function fixtureProbe(over: { duration: number; fps?: Rational; vfr?: boolean; video?: boolean; audio?: boolean; container?: string }): MediaProbe {
  const fps = over.fps ?? R(24);
  return {
    container: over.container ?? 'mov,mp4,m4a,3gp,3g2,mj2', duration: over.duration, size: 1000, startTime: 0, browserPlayable: true, subtitles: [],
    video: over.video === false ? undefined : { index: 0, codec: 'h264', width: 640, height: 360, fps, avgFps: over.vfr ? R(fps.num * 2, fps.den * 3) : fps, isVfr: !!over.vfr },
    audio: over.audio === false ? [] : [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
  };
}

export function fixtureMedia(id: string, kind: MediaItem['kind'], probe: MediaProbe | undefined, over: Partial<MediaItem> = {}): MediaItem {
  return {
    id, name: `${id}.${kind === 'image' ? 'png' : kind === 'audio' ? 'm4a' : 'mp4'}`, path: `/media/${id}`, kind, category: 'Other', identity: {}, binId: null,
    probe, offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0, ...over,
  };
}

export function fixtureSettings(over: Partial<ExportSettings> = {}): ExportSettings {
  return {
    outputDir: '/out', fileName: 'out.mp4', width: 640, height: 360, fps: R(24),
    videoCodec: 'libx264', qualityMode: 'crf', crf: 23, videoBitrateKbps: 2000, preset: 'ultrafast',
    audioCodec: 'aac', audioBitrateKbps: 128, audioChannels: 2, sampleRate: 48000,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false, ...over,
  };
}

/** A sequence with fixed ids (tracks V1..V3, A1..A3). */
export function fixtureSequence(fps: Rational): Sequence {
  const s = createSequence('Fixture', fps, 640, 360);
  s.id = 'seq';
  s.videoTracks.forEach((t, i) => { t.id = `V${i + 1}`; });
  s.audioTracks.forEach((t, i) => { t.id = `A${i + 1}`; });
  return s;
}

let clipN = 0;
export function fixtureClip(track: Track, media: MediaItem | { id: string; name: string }, start: number, frames: number, sourceIn: number, speed = 1, over: Partial<Clip> = {}): Clip {
  const c = makeClip({ mediaId: media.id, name: `${media.name}@${start}`, sourceIn, duration: frames, speed, kind: track.kind }, start);
  c.id = `c${clipN++}`;
  Object.assign(c, over);
  track.clips.push(c);
  track.clips.sort((a, b) => a.start - b.start);
  return c;
}

/** One random export request for `seed`. */
export function randomExportRequest(seed: number): ExportRequest {
  const r = mulberry32(seed);
  clipN = 0;
  const fps = pick(r, FIXTURE_RATES);
  const media: Record<string, MediaItem> = {};
  const add = (m: MediaItem) => { media[m.id] = m; return m; };
  const pool: MediaItem[] = [
    add(fixtureMedia('m10', 'video', fixtureProbe({ duration: 10, fps }))),
    add(fixtureMedia('m3', 'video', fixtureProbe({ duration: 3.7, fps: pick(r, FIXTURE_RATES) }))),
    add(fixtureMedia('m1', 'video', fixtureProbe({ duration: 1.25, fps }))),
    add(fixtureMedia('vfr', 'video', fixtureProbe({ duration: 6, fps: R(30), vfr: true }))),
    add(fixtureMedia('still', 'image', fixtureProbe({ duration: 0, audio: false, container: 'png_pipe' }))),
    add(fixtureMedia('song', 'audio', fixtureProbe({ duration: 8, video: false }))),
    add(fixtureMedia('raw', 'video', undefined)),
    add(fixtureMedia('gone', 'video', fixtureProbe({ duration: 10, fps }), { offline: true })),
  ];
  const seq = fixtureSequence(fps);
  const fd = fps.den / fps.num;
  const tracks = [seq.videoTracks[0], seq.videoTracks[1], seq.audioTracks[0], seq.audioTracks[1]];
  const linkable: Clip[] = [];
  for (const t of tracks) {
    let pos = ri(r, 0, 6);
    const n = ri(r, 1, 6);
    let prev: Clip | null = null;
    for (let i = 0; i < n; i++) {
      const m = r() < 0.05 ? { id: 'nope', name: 'nope' } : pick(r, pool);
      const md = 'probe' in m && m.probe && m.probe.duration > 0 ? m.probe.duration : 12;
      const frames = ri(r, 2, 60);
      const speed = pick(r, [1, 1, 1, 1, 0.5, 2, 1.5]);
      const srcLen = frames * fd * speed;
      // Source in: at 0 (no head handle), near the end (no / short tail handle, or past the end), or in between.
      const mode = ri(r, 0, 4);
      const sourceIn = mode === 0 ? 0 : mode === 1 ? Math.max(0, md - srcLen + (r() < 0.3 ? 0.2 : -ri(r, 0, 4) * fd * speed))
        : mode === 2 ? ri(r, 1, 8) * fd * speed : Math.max(0, (md - srcLen) * r());
      const c = fixtureClip(t, m, pos, frames, Math.round(sourceIn * 1e6) / 1e6, speed, { enabled: r() > 0.07 });
      if (t.kind === 'video') linkable.push(c);
      // Transition into this clip from the previous one (adjacent), or a fade.
      const type: TransitionType = t.kind === 'video' ? pick(r, ['crossDissolve', 'dipToBlack'] as const) : pick(r, ['audioCrossfade', 'crossDissolve'] as const);
      if (prev && prev.start + prev.duration === c.start && r() < 0.7) {
        t.transitions.push({ id: `t${t.transitions.length}${t.id}`, type, duration: ri(r, 1, 48), outClipId: prev.id, inClipId: c.id });
      } else if (r() < 0.15) {
        t.transitions.push({ id: `f${t.transitions.length}${t.id}`, type, duration: ri(r, 1, 30), outClipId: null, inClipId: c.id });
      }
      if (r() < 0.06 && prev) {
        // A stale transition (not on an adjacent cut).
        t.transitions.push({ id: `s${t.transitions.length}${t.id}`, type, duration: ri(r, 2, 20), outClipId: prev.id, inClipId: c.id });
      }
      prev = c;
      const gap = r() < 0.6 ? 0 : r() < 0.1 ? -ri(r, 1, 5) : ri(r, 1, 30); // adjacent, overlapping, or a gap
      pos = Math.max(0, pos + frames + gap);
    }
    if (prev && r() < 0.2) t.transitions.push({ id: `e${t.transitions.length}${t.id}`, type: t.kind === 'video' ? 'dipToBlack' : 'audioCrossfade', duration: ri(r, 1, 30), outClipId: prev.id, inClipId: null });
  }
  // Linked audio partners for some video clips (sometimes slipped out of sync).
  for (const v of linkable) {
    if (r() < 0.3) {
      const a = fixtureClip(seq.audioTracks[2], { id: v.mediaId, name: v.name }, v.start + (r() < 0.4 ? ri(r, -3, 3) : 0), v.duration, v.sourceIn, v.speed);
      a.linkId = v.linkId = `L${v.id}`;
    }
  }
  if (r() < 0.15) seq.videoTracks[1].muted = true;
  if (r() < 0.1) seq.audioTracks[0].solo = true;
  const inOut = r() < 0.4;
  if (inOut) {
    const a = ri(r, 0, 80), b = a + ri(r, 1, 120);
    seq.view.inPoint = a; seq.view.outPoint = b;
  }
  return { sequence: seq, media, settings: fixtureSettings({ fps, rangeMode: inOut ? 'inOut' : 'entire' }) };
}
