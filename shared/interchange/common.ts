/**
 * Shared front end of the interchange writers: the sequence flattened (nested clips expanded, shared/nest.ts) and laid
 * out per track as the writers need it (clips in time order with integer source frames at the media's own rate, the
 * transitions the export would render, markers), plus the issue collector, file URLs and small text helpers. Pure.
 */
import type { Clip, ID, Keyframe, Marker, MediaItem, Project, Rational, Sequence, Track, TransitionType } from '../model';
import type { InterchangeIssue, InterchangeIssueKind } from './index';
import { flatOrigin, flattenSequence, flattenWarnings, isNestedClip, outerClipId, trackGroupId, type Envelope } from '../nest';
import { activeTracks, isImageMedia, mediaDurationSec } from '../exportPlan';
import { clipAudioStream } from '../audioChannels';
import { sequenceDuration } from '../timeline';
import { fpsValue, parseFps, validFpsOr } from '../time';
import { hasKeyframes } from '../keyframes';

// ---------------------------------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------------------------------

type Text = (n: number) => string;
interface IssueAcc { kind: InterchangeIssueKind; severity: 'info' | 'warning'; text: Text; items: Set<ID>; clipIds: Set<ID>; count: number }

/** Collects issues by key; each distinct item (clip) counts once per key. */
export class Issues {
  private acc = new Map<string, IssueAcc>();
  add(key: string, kind: InterchangeIssueKind, severity: 'info' | 'warning', text: Text, item?: { id: ID; outerId: ID } | null, count = 1): void {
    let a = this.acc.get(key);
    if (!a) { a = { kind, severity, text, items: new Set(), clipIds: new Set(), count: 0 }; this.acc.set(key, a); }
    if (item) {
      if (a.items.has(item.id)) return;
      a.items.add(item.id);
      a.clipIds.add(item.outerId);
      a.count += 1;
    } else a.count += count;
  }
  list(): InterchangeIssue[] {
    const out: InterchangeIssue[] = [];
    for (const a of this.acc.values()) {
      if (a.count <= 0) continue;
      const i: InterchangeIssue = { kind: a.kind, severity: a.severity, message: a.text(a.count), count: a.count };
      if (a.clipIds.size) i.clipIds = [...a.clipIds];
      out.push(i);
    }
    // Warnings first (what is lost), then infos; insertion order within each.
    return [...out.filter((i) => i.severity === 'warning'), ...out.filter((i) => i.severity === 'info')];
  }
}

/** "1 clip" / "3 clips" (and other nouns). */
export function count(n: number, noun = 'clip', plural = `${noun}s`): string { return `${n} ${n === 1 ? noun : plural}`; }
/** "is" / "are" for a count. */
export function isAre(n: number): string { return n === 1 ? 'is' : 'are'; }

// ---------------------------------------------------------------------------------------------------
// Prepared timeline
// ---------------------------------------------------------------------------------------------------

export interface PClip {
  /** Id of the clip in the flattened sequence (nested copies: "outer>inner"). */
  id: ID;
  /** Clip of the exported sequence it belongs to (the nested clip for copies of inner clips). */
  outerId: ID;
  name: string;
  kind: 'video' | 'audio';
  /** The flattened clip (transform, audio, keyframes, link). */
  clip: Clip;
  media: MediaItem;
  /** Record range, sequence frames. */
  start: number;
  duration: number;
  end: number;
  /** Frame rate of the source frame numbers (the media's video rate; the sequence rate for stills and audio-only). */
  srcRate: Rational;
  /** Source in point: integer frames at srcRate (0 for stills). */
  srcIn: number;
  /** Source in point in seconds (what ReCut plays, after overlap trimming). */
  sourceIn: number;
  speed: number;
  still: boolean;
  /** ReCut plays it (clip enabled and, for audio, not muted). */
  renders: boolean;
  /** Exported enabled: renders and its track is active (not muted / hidden, or another track is soloed). */
  enabled: boolean;
  /** Keyframe frames are relative to the clip's original start: subtract this to get frames from `start`. */
  keyShift: number;
  /** Gain / alpha ramps from transitions at nested clip edges (absolute sequence frames). */
  env: Envelope[];
  track: PTrack;
}

export type PTransitionKind = 'dissolve' | 'dip' | 'fadeIn' | 'fadeOut';

export interface PTransition {
  id: ID;
  type: TransitionType;
  /**
   * dissolve: centered on the cut between `out` and `in`, `frames` = 2 * `half` (what ReCut renders: limited by the
   * clips and their media handles). dip: Dip to Black between `out` and `in`, `frames` = its full length (each clip
   * fades over `frames / 2` of its own frames). fadeIn / fadeOut: from / to black (silence) over the first / last
   * `frames` frames of `in` / `out`.
   */
  kind: PTransitionKind;
  out?: PClip;
  in?: PClip;
  frames: number;
  half: number;
  /** The cut (dissolve, dip), or the faded clip's start (fadeIn) / end (fadeOut). */
  at: number;
}

export interface PTrack {
  id: ID;
  name: string;
  kind: 'video' | 'audio';
  /** 0-based index among the flattened tracks of its kind (V1 = 0, bottom). */
  index: number;
  active: boolean;
  volume: number;
  clips: PClip[];
  transitions: PTransition[];
}

export interface Prepared {
  project: Project;
  /** The flattened sequence. */
  seq: Sequence;
  name: string;
  fps: Rational;
  width: number;
  height: number;
  durationFrames: number;
  videoTracks: PTrack[];
  audioTracks: PTrack[];
  markers: Marker[];
  /** Subtitle tracks that have cues (never exported). */
  subtitleTracks: number;
  mediaIds: Set<ID>;
}

/** Frame rate of a media file's frame numbers (see PClip.srcRate). */
export function mediaRate(m: MediaItem | undefined, seqFps: Rational): Rational {
  const v = m?.probe?.video;
  if (!m || !v || isImageMedia(m)) return seqFps;
  if (v.isVfr) {
    const avg = validFpsOr(v.avgFps, seqFps);
    return parseFps(fpsValue(avg)) ?? avg;
  }
  return validFpsOr(v.fps, validFpsOr(v.avgFps, seqFps));
}

export function prepare(project: Project, sequenceId: ID, issues: Issues): Prepared {
  const outer = Object.hasOwn(project.sequences, sequenceId) ? project.sequences[sequenceId] : undefined;
  if (!outer) throw new Error(`exportTimeline: unknown sequence "${sequenceId}"`);
  const seq = flattenSequence(outer, project.sequences, project.media);
  let nested = 0;
  for (const t of [...outer.videoTracks, ...outer.audioTracks]) for (const c of t.clips) if (isNestedClip(c)) nested++;
  if (nested) issues.add('nested', 'nested', 'info', (n) => `${count(n, 'nested clip')} ${n === 1 ? 'was' : 'were'} flattened into ${n === 1 ? 'its' : 'their'} source clips.`, null, nested);
  for (const w of flattenWarnings(seq)) issues.add(`nested:${w}`, 'nested', 'warning', () => w);

  const mediaIds = new Set<ID>();
  const activeV = new Set(activeTracks(seq.videoTracks));
  const activeA = new Set(activeTracks(seq.audioTracks));
  const names = new Map<string, number>();
  const prep = (t: Track, index: number, kind: 'video' | 'audio', active: boolean): PTrack => {
    // Tracks made for nested content share their outer track's name: number them.
    const k = `${kind}:${t.name}`;
    const seen = names.get(k) ?? 0;
    names.set(k, seen + 1);
    const pt: PTrack = { id: t.id, name: seen ? `${t.name} (${seen + 1})` : t.name, kind, index, active, volume: Number.isFinite(t.volume) && t.volume >= 0 ? t.volume : 1, clips: [], transitions: [] };
    prepTrack(project, seq, t, pt, issues, mediaIds);
    return pt;
  };
  // Tracks made for a nested clip's empty inner tracks carry nothing: leave them out.
  const keep = (t: Track) => trackGroupId(t) === t.id || t.clips.length > 0;
  const videoTracks = seq.videoTracks.filter(keep).map((t, i) => prep(t, i, 'video', activeV.has(t)));
  const audioTracks = seq.audioTracks.filter(keep).map((t, i) => prep(t, i, 'audio', activeA.has(t)));
  const markers = [...seq.markers].sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    project, seq, name: outer.name || 'Sequence', fps: seq.fps, width: seq.width, height: seq.height,
    durationFrames: sequenceDuration(seq),
    videoTracks, audioTracks, markers,
    subtitleTracks: outer.subtitleTracks.filter((s) => s.cues.length > 0).length,
    mediaIds,
  };
}

function prepTrack(project: Project, seq: Sequence, t: Track, pt: PTrack, issues: Issues, mediaIds: Set<ID>): void {
  const fps = seq.fps;
  const fd = fps.den / fps.num;
  const sorted = t.clips.filter((c) => !isNestedClip(c)).sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let cursor = -Infinity;
  for (const c of sorted) {
    const item = { id: c.id, outerId: outerClipId(c) };
    const m = Object.hasOwn(project.media, c.mediaId) ? project.media[c.mediaId] : undefined;
    if (!m) {
      issues.add('missing', 'offline', 'warning', (n) => `${count(n)} with no media in the project ${isAre(n)} left out.`, item);
      continue;
    }
    let speed = c.speed;
    if (!(speed > 0) || !Number.isFinite(speed)) {
      issues.add('bad-speed', 'speed', 'warning', (n) => `${count(n)} with an invalid speed ${isAre(n)} exported at 100%.`, item);
      speed = 1;
    }
    let start = c.start, duration = c.duration, sourceIn = Number.isFinite(c.sourceIn) ? Math.max(0, c.sourceIn) : 0;
    if (!(duration >= 1)) continue;
    if (start < cursor) {
      // Never in a normalized project; the export trims the overlap the same way (shared/exportPlan.ts).
      const cut = cursor - start;
      if (cut >= duration) { issues.add('overlap', 'other', 'warning', (n) => `${count(n)} hidden by an overlapping clip ${isAre(n)} left out or trimmed.`, item); continue; }
      issues.add('overlap', 'other', 'warning', (n) => `${count(n)} hidden by an overlapping clip ${isAre(n)} left out or trimmed.`, item);
      start = cursor; duration -= cut; sourceIn += cut * fd * speed;
    }
    cursor = start + duration;
    const still = isImageMedia(m);
    const srcRate = mediaRate(m, fps);
    const srcIn = still ? 0 : Math.round(sourceIn * srcRate.num / srcRate.den + 1e-9);
    const renders = c.enabled && !(pt.kind === 'audio' && c.audio.muted);
    const enabled = renders && pt.active;
    if (renders && !pt.active) issues.add('track-off', 'disabled', 'info', (n) => `${count(n)} on muted or hidden tracks ${isAre(n)} exported disabled.`, item);
    if (c.enabled && pt.kind === 'audio' && c.audio.muted) issues.add('clip-muted', 'disabled', 'info', (n) => `${count(n, 'muted audio clip')} ${isAre(n)} exported disabled.`, item);
    if (m.offline) issues.add('offline', 'offline', 'warning', (n) => `${count(n)} use${n === 1 ? 's' : ''} offline media; ${n === 1 ? 'it points' : 'they point'} to the file's last known location.`, item);
    mediaIds.add(m.id);
    pt.clips.push({
      id: c.id, outerId: item.outerId, name: c.name || m.name, kind: pt.kind, clip: c, media: m,
      start, duration, end: start + duration, srcRate, srcIn, sourceIn, speed, still, renders, enabled,
      keyShift: start - c.start, env: flatOrigin(c)?.env ?? [], track: pt,
    });
  }
  prepTransitions(seq, t, pt, issues);
}

const typeOk = (kind: 'video' | 'audio', t: TransitionType) =>
  kind === 'audio' ? t === 'audioCrossfade' || t === 'crossDissolve' : t === 'crossDissolve' || t === 'dipToBlack';

/** Source frames (sequence frames) past the end of a clip's source range; Infinity for stills / unknown length. */
function handleAfter(p: PClip, fd: number): number {
  const dur = mediaDurationSec(p.media);
  if (!Number.isFinite(dur)) return Infinity;
  const srcOut = p.sourceIn + p.duration * fd * p.speed;
  return Math.max(0, Math.floor(((dur - srcOut) / p.speed) / fd + 1e-6));
}
function handleBefore(p: PClip, fd: number): number {
  return p.still ? Infinity : Math.max(0, Math.floor((p.sourceIn / p.speed) / fd + 1e-6));
}

/** The transitions ReCut's export renders on a track (shared/exportPlan.ts planTrackSegments), cut-ordered. */
function prepTransitions(seq: Sequence, t: Track, pt: PTrack, issues: Issues): void {
  const fd = seq.fps.den / seq.fps.num;
  const byId = new Map(pt.clips.map((p) => [p.id, p] as const));
  const out: PTransition[] = [];
  for (const tr of t.transitions) {
    if (!typeOk(pt.kind, tr.type)) continue;
    const D = Math.round(tr.duration);
    if (!Number.isFinite(D) || D < 1) continue;
    const o = tr.outClipId ? byId.get(tr.outClipId) : undefined;
    const i = tr.inClipId ? byId.get(tr.inClipId) : undefined;
    if ((tr.outClipId && !o) || (tr.inClipId && !i) || (!o && !i)) continue;
    if ((o && !o.renders) || (i && !i.renders)) continue;
    if (o && i) {
      if (o.end !== i.start) continue;
      if (tr.type === 'dipToBlack') { out.push({ id: tr.id, type: tr.type, kind: 'dip', out: o, in: i, frames: D, half: D / 2, at: i.start }); continue; }
      const h = Math.min(Math.floor(D / 2), o.duration, i.duration, handleAfter(o, fd), handleBefore(i, fd));
      if (h < 1) {
        issues.add('no-handles', 'transition', 'warning', (n) => `${count(n, 'dissolve')} without enough source media ${isAre(n)} exported as ${n === 1 ? 'a cut' : 'cuts'} (as ReCut renders ${n === 1 ? 'it' : 'them'}).`, { id: tr.id, outerId: o.outerId });
        continue;
      }
      out.push({ id: tr.id, type: tr.type, kind: 'dissolve', out: o, in: i, frames: 2 * h, half: h, at: i.start });
    } else if (i) {
      const f = Math.min(D, i.duration);
      out.push({ id: tr.id, type: tr.type, kind: 'fadeIn', in: i, frames: f, half: f, at: i.start });
    } else if (o) {
      const f = Math.min(D, o.duration);
      out.push({ id: tr.id, type: tr.type, kind: 'fadeOut', out: o, frames: f, half: f, at: o.end });
    }
  }
  // One clip cannot carry overlapping dissolves on both edges: the outgoing one gives way (as in the export).
  const inHalf = new Map<ID, number>();
  for (const x of out) if (x.kind === 'dissolve' && x.in) inHalf.set(x.in.id, x.half);
  const kept = out.filter((x) => {
    if (x.kind !== 'dissolve' || !x.out) return true;
    if ((inHalf.get(x.out.id) ?? 0) + x.half <= x.out.duration) return true;
    issues.add('overlap-tr', 'transition', 'warning', (n) => `${count(n, 'dissolve')} overlapping another on the same clip ${isAre(n)} exported as ${n === 1 ? 'a cut' : 'cuts'}.`, { id: x.id, outerId: x.out.outerId });
    return false;
  });
  // At most one transition per clip edge (the first wins).
  const used = new Set<string>();
  pt.transitions = kept.filter((x) => {
    const keys = [x.out ? `o:${x.out.id}` : '', x.in ? `i:${x.in.id}` : ''].filter(Boolean);
    if (keys.some((k) => used.has(k))) return false;
    keys.forEach((k) => used.add(k));
    return true;
  }).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------------
// Clip properties (what a format carries)
// ---------------------------------------------------------------------------------------------------

const nonEmpty = (k: readonly Keyframe[] | undefined): k is Keyframe[] => !!k && k.length > 0;

export interface ClipProps {
  move: boolean;      // position / scale (static or keyframed)
  rotation: boolean;
  crop: boolean;
  opacity: boolean;   // static, keyframed, or ramps from nested transitions
  level: boolean;     // gain, level, track volume, fades, level keyframes, ramps
  keyframes: boolean;
  channels: boolean;  // channel selection
  stream: boolean;    // plays an audio stream other than the file's first
}

export function clipProps(p: PClip): ClipProps {
  const c = p.clip;
  const t = c.transform, a = c.audio, k = t.keyframes ?? {};
  const video = p.kind === 'video';
  const crop = t.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const st = clipAudioStream(p.media, c);
  const first = p.media.probe?.audio?.[0];
  return {
    move: video && ((t.x || 0) !== 0 || (t.y || 0) !== 0 || (t.scale ?? 1) !== 1 || nonEmpty(k.x) || nonEmpty(k.y) || nonEmpty(k.scale)),
    rotation: video && ((((t.rotation || 0) % 360) + 360) % 360) !== 0,
    crop: video && (crop.left > 0 || crop.right > 0 || crop.top > 0 || crop.bottom > 0),
    opacity: video && ((t.opacity ?? 1) !== 1 || nonEmpty(k.opacity) || p.env.length > 0),
    level: !video && ((a.gain || 0) !== 0 || (a.volume ?? 1) !== 1 || p.track.volume !== 1 || a.fadeIn > 0 || a.fadeOut > 0 || nonEmpty(a.keyframes?.volume) || p.env.length > 0),
    keyframes: video ? hasKeyframes({ transform: t, audio: { ...a, keyframes: undefined } }) : nonEmpty(a.keyframes?.volume),
    channels: !video && !!a.channelSelection,
    stream: !video && !!st && !!first && st.index !== first.index,
  };
}

// ---------------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------------

/**
 * `file://` URL of an absolute path, each segment percent-encoded as UTF-8 (spaces, `#`, `%`, non-ASCII...).
 * Windows: `C:\a b\c.mp4` -> `file:///C:/a%20b/c.mp4`; UNC `\\server\share\x` -> `file://server/share/x`.
 */
export function fileUrl(path: string): string {
  const enc = (segs: string[]) => segs.map((s) => encodeURIComponent(s)).join('/');
  const win = /^([A-Za-z]):[\\/]/.exec(path);
  if (win) return `file:///${win[1].toUpperCase()}:/${enc(path.slice(3).split(/[\\/]/))}`;
  if (/^(\\\\|\/\/)[^\\/]/.test(path)) {
    const segs = path.slice(2).split(/[\\/]/);
    return `file://${encodeURIComponent(segs[0])}/${enc(segs.slice(1))}`;
  }
  return `file://${path.startsWith('/') ? '' : '/'}${enc(path.split('/'))}`;
}

/** Base name of a path (either separator). */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** A file name stem from a sequence name (no path separators, reserved or control characters). */
export function safeFileStem(name: string): string {
  // eslint-disable-next-line no-control-regex
  const s = name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return s.slice(0, 120) || 'Sequence';
}

/** Number for a file: at most `digits` decimals, no trailing zeros, no "-0". */
export function num(v: number, digits = 6): string {
  if (!Number.isFinite(v)) return '0';
  const s = v.toFixed(digits).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/** OTIO / CMX marker colour name nearest to a CSS hex colour. */
export function markerColorName(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex?.trim() ?? '');
  if (!m) return 'RED';
  const v = parseInt(m[1], 16);
  const r = ((v >> 16) & 255) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d < 0.12) return l > 0.5 ? 'WHITE' : 'BLACK';
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const hues: [number, string][] = [[0, 'RED'], [30, 'ORANGE'], [55, 'YELLOW'], [120, 'GREEN'], [180, 'CYAN'], [225, 'BLUE'], [270, 'PURPLE'], [300, 'MAGENTA'], [335, 'PINK'], [360, 'RED']];
  let best = hues[0];
  for (const x of hues) if (Math.abs(x[0] - h) < Math.abs(best[0] - h)) best = x;
  return best[1];
}

/** Every clip of the prepared timeline, video tracks first, in track order. */
export function allClips(p: Prepared): PClip[] {
  return [...p.videoTracks, ...p.audioTracks].flatMap((t) => t.clips);
}
