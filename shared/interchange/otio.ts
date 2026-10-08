/**
 * OpenTimelineIO JSON writer (`.otio`). Pure.
 *
 * Schemas: Timeline.1, Stack.1, Track.1, Clip.1, Gap.1, Transition.1, ExternalReference.1, LinearTimeWarp.1,
 * Marker.2, RationalTime.1, TimeRange.1. Clips are written as Clip.1 (one `media_reference`) rather than Clip.2
 * (`media_references` + `active_media_reference_key`): every OTIO reader since 0.12 reads Clip.1 (newer ones upgrade
 * it), while readers older than 0.15, such as the one in DaVinci Resolve 18.5, do not know Clip.2.
 *
 * Timing: a RationalTime's `rate` is the frame rate as a float (num / den) and its `value` a frame count at that rate.
 * Record positions follow from the track order (gaps between clips); a clip's `source_range.duration` is its length
 * at the sequence rate (what it occupies in the track) and `source_range.start_time` its in point in frames at the
 * media's own rate, on the file's timecode: an ExternalReference's `available_range.start_time` is the file's embedded
 * start timecode (0 without one) and source ranges count from it, as OTIO's readers expect. Constant speed is a LinearTimeWarp (time_scalar = speed), which by OTIO convention does not
 * change the clip's duration in the track. Dissolves are SMPTE_Dissolve transitions centred on the cut (in_offset =
 * out_offset = half); fades from / to black are SMPTE_Dissolve transitions against the gap (or track edge) with one
 * offset 0. ReCut-only properties (transform, opacity, levels, channel selection, keyframes, links) are kept under
 * `metadata.recut`, which other tools ignore. A marker's note is its `comment` and also `metadata.Resolve_OTIO.Note`,
 * where DaVinci Resolve's own OTIO files keep it (Resolve 21 imported the marker without its note from `comment`).
 */
import type { Rational } from '../model';
import { clipProps, count, fileUrl, isAre, markerColorName, type Issues, type PClip, type Prepared, type PTrack, type PTransition } from './common';
import { fpsValue } from '../time';

type Json = Record<string, unknown>;

const rt = (value: number, rate: number): Json => ({ OTIO_SCHEMA: 'RationalTime.1', rate, value });
const range = (start: Json, duration: Json): Json => ({ OTIO_SCHEMA: 'TimeRange.1', duration, start_time: start });

export function writeOtio(p: Prepared, issues: Issues): string {
  const rate = fpsValue(p.fps);
  const R = (f: number) => rt(f, rate);
  const rateOf = (r: Rational) => fpsValue(r);

  const clipJson = (pc: PClip): Json => {
    const m = pc.media;
    const props = clipProps(pc);
    const item = { id: pc.id, outerId: pc.outerId };
    const c = pc.clip;
    const recut: Json = { clipId: pc.outerId };
    if (pc.id !== pc.outerId) recut.flattenedId = pc.id;
    if (c.linkId) recut.linkId = c.linkId;
    if (pc.kind === 'video' && (props.move || props.rotation || props.crop || props.opacity || props.keyframes)) {
      const t = c.transform;
      recut.transform = { x: t.x, y: t.y, scale: t.scale, rotation: t.rotation, opacity: t.opacity, crop: t.crop, ...(t.keyframes ? { keyframes: t.keyframes } : {}) };
    }
    if (pc.kind === 'audio' && (props.level || props.channels || props.stream || props.keyframes)) {
      const a = c.audio;
      recut.audio = {
        gainDb: a.gain, level: a.volume, trackVolume: pc.track.volume, fadeIn: a.fadeIn, fadeOut: a.fadeOut,
        ...(a.channelSelection ? { channelSelection: a.channelSelection } : {}),
        ...(c.audioStream !== undefined ? { audioStream: c.audioStream } : {}),
        ...(a.keyframes?.volume?.length ? { keyframes: a.keyframes } : {}),
      };
    }
    if (pc.env.length) recut.ramps = pc.env;
    const keep = (key: string, kind: Parameters<Issues['add']>[1], what: string) =>
      issues.add(key, kind, 'warning', (n) => `${what} of ${count(n)}: kept only as ReCut metadata, which other editors ignore.`, item);
    if (props.move) keep('move', 'transform', 'Position and scale');
    if (props.rotation) keep('rotation', 'rotation', 'Rotation');
    if (props.crop) keep('crop', 'crop', 'Crop');
    if (props.opacity && !pc.env.length) keep('opacity', 'opacity', 'Opacity');
    if (props.level) keep('level', 'level', 'Audio levels and fades');
    if (props.keyframes) keep('keyframes', 'keyframes', 'Keyframes');
    if (props.channels) keep('channels', 'audio-channels', 'Channel selection');
    if (props.stream) keep('stream', 'audio-stream', 'The audio stream choice');
    if (pc.env.length) issues.add('ramps', 'nested', 'warning', (n) => `Fades at the edges of nested clips are not exported (${count(n)}).`, item);
    if (c.linkId) issues.add('linked', 'other', 'info', (n) => `Linked video and audio are exported as separate clips (${count(n)}); the link is kept as ReCut metadata.`, item);

    const mr = pc.still ? 1 : rateOf(pc.srcRate);
    const pr = m.probe;
    const available = pc.still || !pr || !(pr.duration > 0) ? null
      : range(rt(pc.tc?.frames ?? 0, mr), rt(Math.round(pr.duration * pc.srcRate.num / pc.srcRate.den), mr));
    return {
      OTIO_SCHEMA: 'Clip.1',
      metadata: { recut },
      name: pc.name,
      source_range: range(pc.still ? R(0) : rt(pc.srcIn + (pc.tc?.frames ?? 0), mr), R(pc.duration)),
      effects: pc.speed !== 1 && !pc.still ? [{ OTIO_SCHEMA: 'LinearTimeWarp.1', metadata: {}, name: '', effect_name: 'LinearTimeWarp', time_scalar: pc.speed }] : [],
      markers: [],
      enabled: pc.enabled,
      media_reference: {
        OTIO_SCHEMA: 'ExternalReference.1',
        metadata: { recut: { mediaId: m.id, ...(m.offline ? { offline: true } : {}) } },
        name: m.name,
        available_range: available,
        target_url: fileUrl(m.path),
      },
    };
  };

  const gap = (n: number): Json => ({ OTIO_SCHEMA: 'Gap.1', metadata: {}, name: '', source_range: range(R(0), R(n)), effects: [], markers: [], enabled: true });
  const transition = (tr: PTransition, inOff: number, outOff: number): Json => ({
    OTIO_SCHEMA: 'Transition.1', metadata: { recut: { transitionId: tr.id, type: tr.type } },
    name: tr.kind === 'dissolve' ? (tr.type === 'audioCrossfade' ? 'Audio Crossfade' : 'Cross Dissolve') : tr.kind === 'fadeIn' ? 'Fade In' : 'Fade Out',
    transition_type: 'SMPTE_Dissolve', in_offset: R(inOff), out_offset: R(outOff),
  });

  const trackJson = (t: PTrack): Json => {
    const children: Json[] = [];
    const before = new Map<string, PTransition>(), after = new Map<string, PTransition>();
    for (const tr of t.transitions) {
      if (tr.kind === 'dip') {
        issues.add('dip', 'transition', 'warning', (n) => `OTIO has no Dip to Black: ${count(n, 'dip')} ${isAre(n)} exported as ${n === 1 ? 'a cut' : 'cuts'}.`, { id: tr.id, outerId: tr.out!.outerId });
        continue;
      }
      if (tr.kind === 'fadeIn') before.set(tr.in!.id, tr);
      else after.set(tr.out!.id, tr); // dissolve (between out and in) or fadeOut
    }
    let pos = 0;
    for (const pc of t.clips) {
      if (pc.start > pos) children.push(gap(pc.start - pos));
      const fi = before.get(pc.id);
      // Two transitions cannot touch (a fade-out ending where a fade-in starts): keep the first.
      if (fi && children.length && children[children.length - 1].OTIO_SCHEMA === 'Transition.1') {
        issues.add('fade-touch', 'transition', 'warning', (n) => `${count(n, 'fade')} touching another fade ${isAre(n)} exported as ${n === 1 ? 'a cut' : 'cuts'}.`, { id: fi.id, outerId: pc.outerId });
      } else if (fi) children.push(transition(fi, 0, fi.frames));
      children.push(clipJson(pc));
      const tr = after.get(pc.id);
      if (tr) children.push(tr.kind === 'dissolve' ? transition(tr, tr.half, tr.half) : transition(tr, tr.frames, 0));
      pos = pc.end;
    }
    return {
      OTIO_SCHEMA: 'Track.1',
      metadata: { recut: { trackId: t.id, volume: t.volume, ...(t.active ? {} : { muted: true }) } },
      name: t.name, source_range: null, effects: [], markers: [], enabled: t.active,
      children, kind: t.kind === 'video' ? 'Video' : 'Audio',
    };
  };

  const markers = p.markers.map((m) => ({
    OTIO_SCHEMA: 'Marker.2',
    metadata: {
      // DaVinci Resolve 21 imported the note empty from `comment`; its own OTIO exports keep notes here.
      ...(m.note ? { Resolve_OTIO: { Keywords: [], Note: m.note } } : {}),
      recut: { markerId: m.id, kind: m.kind, color: m.color, ...(m.kind === 'continuity' ? { resolved: !!m.resolved, category: m.category } : {}) },
    },
    name: m.name, color: markerColorName(m.color),
    marked_range: range(R(m.time), R(Math.max(0, m.duration))),
    comment: m.note ?? '',
  }));
  if (p.markers.some((m) => m.kind === 'chapter')) issues.add('chapters', 'markers', 'info', (n) => `${count(n, 'chapter marker')} ${isAre(n)} exported as ${n === 1 ? 'a plain marker' : 'plain markers'}.`, null, p.markers.filter((m) => m.kind === 'chapter').length);

  const timeline = {
    OTIO_SCHEMA: 'Timeline.1',
    metadata: { recut: { sequenceId: p.seq.id, fps: p.fps, width: p.width, height: p.height, sampleRate: p.seq.sampleRate, channels: p.seq.channels } },
    name: p.name,
    global_start_time: R(0),
    tracks: {
      OTIO_SCHEMA: 'Stack.1', metadata: {}, name: 'tracks', source_range: null, effects: [], markers, enabled: true,
      children: [...p.videoTracks.map(trackJson), ...p.audioTracks.map(trackJson)],
    },
  };
  return `${JSON.stringify(timeline, null, 4)}\n`;
}
