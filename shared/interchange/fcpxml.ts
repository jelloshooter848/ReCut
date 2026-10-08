/**
 * FCPXML 1.9 writer (DaVinci Resolve 18 / 19 import FCPXML 1.8 to 1.10; 1.9 is the first with `media-rep`, which
 * carries the original file URL, and the version Resolve itself exports). Pure.
 *
 * Layout (the one converters use, and the one Resolve maps back to tracks most reliably):
 * - The primary `<spine>` is V1: its clips with `<gap>`s between them, filled to the sequence's end, so every
 *   other item has a parent at its start time.
 * - Every other track is attached to the spine element under its start: video track Vn on `lane="n-1"`, audio
 *   track An on `lane="-n"`. A track without dissolves is written as connected clips; a track with dissolves as one
 *   connected storyline (`<spine lane=...>`), the only way FCPXML puts transitions on a track other than V1.
 * - Times are exact rationals (`N/Ds`). An item's `offset` is in its parent's local time: for a gap
 *   `start + (t - offset)` with start 0; for a clip `start` is the source in point (media time), and local time runs
 *   with the timeline from there. Media time starts at the asset's `start`: the file's embedded start timecode
 *   (MediaProbe.startTimecode; its clips then carry `tcFormat`), else 0s. A storyline's children are in the same
 *   local time as the storyline's own offset (the anchor clip's), as the primary spine's children are in the
 *   sequence's time.
 * - Speed: `<timeMap>` with two linear points, (start -> start) and (start + duration -> start + duration * speed),
 *   so `start` stays the media time of the in point.
 * - Video clips are written with `srcEnable="video"` and audio clips with `srcEnable="audio"`: ReCut's linked A/V
 *   pairs are separate clips on separate tracks, and keeping them separate keeps every track exactly where it is.
 *
 * Transform units (derivation): ReCut places a layer by fitting it into the frame, then scale, rotation (degrees,
 * clockwise on screen) and an offset (x, y) in sequence pixels with y down; crop is a fraction of the source,
 * removed in place. FCPXML `adjust-transform` uses the same order around the frame centre after its own "fit"
 * conform, but `position` is in percent of the frame HEIGHT (100 = one frame height, both axes) with y UP, and
 * `rotation` is counter-clockwise. So position = (x / H * 100, -y / H * 100), scale = (s, s), rotation = -r.
 * `adjust-crop mode="trim"` edges use the same height-percent units, measured on the fitted (unscaled) picture:
 * left = crop.left * fittedWidth / H * 100 (top / bottom with fittedHeight).
 */
import type { ID, Keyframe, Rational } from '../model';
import { Q } from './rational';
import { el, serialize, type XNode } from './xml';
import { clipProps, count, fileUrl, isAre, num, type Issues, type PClip, type Prepared, type PTrack, type PTransition } from './common';
import { evaluateKeyframes } from '../keyframes';
import { envelopeWeight, type Envelope } from '../nest';
import { dropFramesPerMinute } from '../time';
import { videoDisplaySize } from '../media';

export const FCPXML_VERSION = '1.9';

const CROSS_DISSOLVE_UID = 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265';
const AUDIO_CROSSFADE_UID = 'FFAudioTransition';

interface AssetInfo { id: string; hasVideo: boolean; hasAudio: boolean }

class Resources {
  readonly nodes: XNode[] = [];
  private next = 1;
  private formats = new Map<string, string>();
  private assets = new Map<ID, AssetInfo>();
  private effects = new Map<string, string>();
  readonly seqFormat: string;
  constructor(private p: Prepared) { this.seqFormat = this.format(p.fps, p.width, p.height); }
  private id(): string { return `r${this.next++}`; }
  format(fps: Rational | null, width: number, height: number): string {
    const fd = fps ? Q.frameDuration(fps).toTime() : '';
    const key = `${fd}|${width}x${height}`;
    let id = this.formats.get(key);
    if (id) return id;
    id = this.id();
    this.formats.set(key, id);
    this.nodes.push(el('format', [['id', id], ['name', fps ? undefined : 'FFVideoFormatRateUndefined'], ['frameDuration', fps ? fd : undefined], ['width', String(width)], ['height', String(height)]]));
    return id;
  }
  asset(pc: PClip): AssetInfo {
    const m = pc.media;
    let a = this.assets.get(m.id);
    if (a) return a;
    const pr = m.probe;
    const v = pr?.video;
    const hasVideo = !!v || m.kind === 'image' || (!pr && m.kind === 'video');
    const audio = pr?.audio ?? [];
    const hasAudio = audio.length > 0 || (!pr && (m.kind === 'audio' || m.kind === 'video'));
    let format: string | undefined;
    if (hasVideo) {
      const size = videoDisplaySize(v, 'element') ?? { width: this.p.width, height: this.p.height };
      format = this.format(pc.still ? null : pc.srcRate, size.width, size.height);
    }
    const id = this.id();
    const rate = pc.srcRate;
    const start = pc.tc ? Q.frames(pc.tc.frames, rate).toTime() : '0s';
    const duration = pc.still ? '0s' : pr && pr.duration > 0 ? Q.frames(Math.round(pr.duration * rate.num / rate.den), rate).toTime() : undefined;
    this.nodes.push(el('asset', [
      ['id', id], ['name', m.name], ['start', start], ['duration', duration],
      ['hasVideo', hasVideo ? '1' : undefined], ['format', format],
      ['hasAudio', hasAudio ? '1' : undefined],
      ['audioSources', audio.length ? String(audio.length) : undefined],
      ['audioChannels', audio.length ? String(audio[0].channels) : undefined],
      ['audioRate', audio.length ? String(audio[0].sampleRate) : undefined],
    ], [el('media-rep', [['kind', 'original-media'], ['src', fileUrl(m.path)]])]));
    a = { id, hasVideo, hasAudio };
    this.assets.set(m.id, a);
    return a;
  }
  effect(name: string, uid: string): string {
    let id = this.effects.get(name);
    if (id) return id;
    id = this.id();
    this.effects.set(name, id);
    this.nodes.push(el('effect', [['id', id], ['name', name], ['uid', uid]]));
    return id;
  }
}

/** Media time of a clip's in point: its source frame from the file's start timecode (0 for stills). */
function mediaTime(pc: PClip): Q {
  return pc.still ? new Q(0n) : Q.frames(pc.srcIn + (pc.tc?.frames ?? 0), pc.srcRate);
}

type Item = { kind: 'gap'; start: number; dur: number } | { kind: 'clip'; pc: PClip } | { kind: 'tr'; tr: PTransition };

/** A track as spine items from `from` (gaps between clips, dissolves after their outgoing clip), filled to `to`. */
function trackItems(t: PTrack | undefined, from: number, to?: number): Item[] {
  const out: Item[] = [];
  let pos = from;
  const after = new Map<ID, PTransition>();
  if (t) for (const tr of t.transitions) if (tr.kind === 'dissolve' && tr.out) after.set(tr.out.id, tr);
  for (const pc of t?.clips ?? []) {
    if (pc.start > pos) out.push({ kind: 'gap', start: pos, dur: pc.start - pos });
    out.push({ kind: 'clip', pc });
    const tr = after.get(pc.id);
    if (tr) out.push({ kind: 'tr', tr });
    pos = pc.end;
  }
  if (to !== undefined && to > pos) out.push({ kind: 'gap', start: pos, dur: to - pos });
  return out;
}

/** Last keyframe at or before `k` and whether its segment eases. */
function easedAt(keys: readonly Keyframe[] | undefined, k: number): boolean {
  if (!keys || keys.length < 2) return false;
  let j = -1;
  for (let i = 0; i < keys.length; i++) if (keys[i].frame <= k + 1e-9) j = i;
  return j >= 0 && j < keys.length - 1 && keys[j].interp === 'ease';
}
const varies = (keys: readonly Keyframe[] | undefined) => !!keys && keys.length > 1 && keys.some((x) => x.value !== keys[0].value);
const fixed = (keys: readonly Keyframe[] | undefined, v: number) => (keys && keys.length ? evaluateKeyframes(keys, 0) : v);

interface Point { rel: number; values: number[]; ease: boolean }

/**
 * Sample a clip property for keyframes: at the clip's edges and at every keyframe / ramp end inside it (`rel` =
 * frames from the clip's original start). `lists` are the keyframe lists (with their static values), the product
 * of `env` ramps multiplies value 0. Exact (with linear interpolation) when on every segment at most one factor of
 * a product varies, linearly; `approx` otherwise. Null when nothing varies.
 */
function sample(lists: { keys?: Keyframe[]; value: number }[], env: Envelope[], clipStart: number, lo: number, hi: number, product: boolean): { points: Point[]; approx: boolean; ease: boolean } | null {
  const live = lists.filter((l) => varies(l.keys));
  const liveEnv = env.filter((e) => Math.min(e.from, e.to) < clipStart + hi && Math.max(e.from, e.to) > clipStart + lo);
  if (!live.length && !liveEnv.length) return null;
  const set = new Set<number>([lo, hi]);
  const q = (x: number) => Math.round(x * 1e6) / 1e6;
  for (const l of live) for (const k of l.keys!) if (k.frame > lo && k.frame < hi) set.add(q(k.frame));
  for (const e of liveEnv) for (const f of [e.from, e.to]) { const r = q(f - clipStart); if (r > lo && r < hi) set.add(r); }
  const rels = [...set].sort((a, b) => a - b);
  let approx = false, anyEase = false;
  const points: Point[] = rels.map((rel, i) => {
    const values = lists.map((l) => (l.keys && l.keys.length ? evaluateKeyframes(l.keys, rel) : l.value));
    if (product) for (const e of env) values[0] *= envelopeWeight(e, rel + clipStart);
    let ease = false;
    if (i < rels.length - 1) {
      const b = rels[i + 1];
      let n = 0;
      for (const l of live) {
        if (evaluateKeyframes(l.keys!, rel) === evaluateKeyframes(l.keys!, b)) continue;
        n++;
        if (easedAt(l.keys, rel)) ease = true;
      }
      for (const e of liveEnv) {
        if (!(e.to > e.from)) { approx = true; continue; }
        if (Math.max(rel, e.from - clipStart) < Math.min(b, e.to - clipStart)) n++;
      }
      if (product && n > 1) approx = true;
      if (ease) { anyEase = true; approx = true; }
    }
    return { rel, values, ease };
  });
  return { points, approx, ease: anyEase };
}

export function writeFcpxml(p: Prepared, issues: Issues): string {
  const fd = Q.frameDuration(p.fps);
  const T = (f: number) => fd.mul(Q.int(f));
  const R = new Resources(p);
  const total = p.durationFrames;
  const W = p.width, H = p.height;

  // Opacity ramps of video clips: nested-edge ramps, fades from / to black and Dip to Black halves.
  const envOf = new Map<PClip, Envelope[]>();
  for (const t of p.videoTracks) {
    for (const pc of t.clips) envOf.set(pc, [...pc.env]);
    for (const tr of t.transitions) {
      const add = (pc: PClip | undefined, e: Envelope) => { if (pc) envOf.get(pc)!.push(e); };
      if (tr.kind === 'fadeIn') add(tr.in, { from: tr.at, to: tr.at + tr.frames, dir: 1 });
      else if (tr.kind === 'fadeOut') add(tr.out, { from: tr.at - tr.frames, to: tr.at, dir: -1 });
      else if (tr.kind === 'dip') {
        add(tr.out, { from: tr.at - tr.frames / 2, to: tr.at, dir: -1 });
        add(tr.in, { from: tr.at, to: tr.at + tr.frames / 2, dir: 1 });
      }
      if (tr.kind === 'dip') issues.add('fx-dip', 'transition', 'info', (n) => `${count(n, 'Dip to Black transition')} ${isAre(n)} exported as opacity fades on the two clips.`, { id: tr.id, outerId: (tr.out ?? tr.in)!.outerId });
      if (tr.kind === 'fadeIn' || tr.kind === 'fadeOut') issues.add('fx-fade', 'transition', 'info', (n) => `${count(n, 'fade')} from or to black ${isAre(n)} exported as ${n === 1 ? 'an opacity fade' : 'opacity fades'}.`, { id: tr.id, outerId: (tr.out ?? tr.in)!.outerId });
    }
  }
  // Audio fades from / to silence: the clip's fade handles.
  const fadeOf = new Map<PClip, { fadeIn: number; fadeOut: number }>();
  for (const t of p.audioTracks) for (const tr of t.transitions) {
    const pc = tr.kind === 'fadeIn' ? tr.in : tr.kind === 'fadeOut' ? tr.out : undefined;
    if (!pc) continue;
    const f = fadeOf.get(pc) ?? { fadeIn: 0, fadeOut: 0 };
    if (tr.kind === 'fadeIn') f.fadeIn = Math.max(f.fadeIn, tr.frames); else f.fadeOut = Math.max(f.fadeOut, tr.frames);
    fadeOf.set(pc, f);
  }

  const clipNode = (pc: PClip, lane: number | undefined, offset: Q): XNode => {
    const a = R.asset(pc);
    const S = mediaTime(pc);
    const D = T(pc.duration);
    const video = pc.kind === 'video';
    const props = clipProps(pc);
    const item = { id: pc.id, outerId: pc.outerId };
    const node = el('asset-clip', [
      ['ref', a.id], ['lane', lane === undefined ? undefined : String(lane)], ['offset', offset.toTime()], ['name', pc.name],
      ['start', S.toTime()], ['duration', D.toTime()],
      ['srcEnable', video ? (a.hasAudio ? 'video' : undefined) : (a.hasVideo ? 'audio' : undefined)],
      ['enabled', pc.enabled ? undefined : '0'],
      ['tcFormat', pc.tc ? (pc.tc.dropFrame ? 'DF' : 'NDF') : undefined],
    ]);
    const relLo = pc.keyShift, relHi = pc.keyShift + pc.duration;
    const keyTime = (rel: number) => S.add(Q.dec(rel - pc.keyShift).mul(fd)).toTime();
    const keyframes = (pts: Point[], value: (pt: Point) => string) => el('keyframeAnimation', [], pts.map((pt) =>
      el('keyframe', [['time', keyTime(pt.rel)], ['value', value(pt)], ['interp', pt.ease ? 'ease' : 'linear'], ['curve', 'linear']])));

    if (pc.speed !== 1 && !pc.still) {
      const sp = Q.dec(pc.speed, 6);
      if (Math.abs(sp.toNumber() - pc.speed) > 1e-9) issues.add('speed-approx', 'speed', 'warning', (n) => `The speed of ${count(n)} is rounded to 6 decimals.`, item);
      node.kids.push(el('timeMap', [], [
        el('timept', [['time', S.toTime()], ['value', S.toTime()], ['interp', 'linear']]),
        el('timept', [['time', S.add(D).toTime()], ['value', S.add(D.mul(sp)).toTime()], ['interp', 'linear']]),
      ]));
    }
    const c = pc.clip;
    if (video) {
      const t = c.transform, k = t.keyframes ?? {};
      const crop = t.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
      if (props.crop) {
        const size = videoDisplaySize(pc.media.probe?.video, 'element');
        const fit = size ? Math.min(W / size.width, H / size.height) : 1;
        const fw = size ? size.width * fit : W, fh = size ? size.height * fit : H;
        const u = (frac: number, len: number) => num(Math.min(1, Math.max(0, frac)) * len / H * 100);
        node.kids.push(el('adjust-crop', [['mode', 'trim']], [el('trim-rect', [['left', u(crop.left, fw)], ['top', u(crop.top, fh)], ['right', u(crop.right, fw)], ['bottom', u(crop.bottom, fh)]])]));
      }
      if (props.move || props.rotation) {
        const pos = (x: number, y: number) => `${num((x / H) * 100)} ${num((-y / H) * 100)}`;
        const at0 = (keys: Keyframe[] | undefined, v: number) => (keys && keys.length ? evaluateKeyframes(keys, relLo) : v);
        const params: XNode[] = [];
        const ps = sample([{ keys: k.x, value: t.x || 0 }, { keys: k.y, value: t.y || 0 }], [], c.start, relLo, relHi, false);
        if (ps) params.push(el('param', [['name', 'position']], [keyframes(ps.points, (pt) => pos(pt.values[0], pt.values[1]))]));
        const ss = sample([{ keys: k.scale, value: t.scale ?? 1 }], [], c.start, relLo, relHi, false);
        if (ss) params.push(el('param', [['name', 'scale']], [keyframes(ss.points, (pt) => `${num(pt.values[0])} ${num(pt.values[0])}`)]));
        if (ps?.ease || ss?.ease) issues.add('ease', 'keyframes', 'info', (n) => `Eased keyframes on ${count(n)} use the other editor's ease curve, which differs slightly.`, item);
        const s0 = at0(k.scale, t.scale ?? 1);
        node.kids.push(el('adjust-transform', [
          ['position', pos(at0(k.x, t.x || 0), at0(k.y, t.y || 0))], ['scale', `${num(s0)} ${num(s0)}`],
          ['rotation', props.rotation ? num(-(t.rotation || 0)) : undefined],
        ], params));
      }
      const env = envOf.get(pc) ?? [];
      if (props.opacity || env.length) {
        const os = sample([{ keys: k.opacity, value: t.opacity ?? 1 }], env, c.start, relLo, relHi, true);
        const o0 = os ? os.points[0].values[0] : fixed(k.opacity, t.opacity ?? 1);
        if (os?.ease) issues.add('ease', 'keyframes', 'info', (n) => `Eased keyframes on ${count(n)} use the other editor's ease curve, which differs slightly.`, item);
        else if (os?.approx) issues.add('opacity-approx', 'opacity', 'info', (n) => `Opacity on ${count(n)} combines keyframes and fades; it is approximated with keyframes.`, item);
        node.kids.push(el('adjust-blend', [['amount', num(o0)]], os ? [el('param', [['name', 'amount']], [keyframes(os.points, (pt) => num(pt.values[0]))])] : []));
      }
    } else {
      const a0 = c.audio;
      const trackVol = pc.track.volume;
      const db = (lin: number) => Math.max(-96, (Number.isFinite(a0.gain) ? a0.gain : 0) + 20 * Math.log10(Math.max(1e-6, lin)));
      const dbs = (lin: number) => `${num(db(lin), 3)}dB`;
      const vs = sample([{ keys: a0.keyframes?.volume, value: a0.volume ?? 1 }], pc.env, c.start, relLo, relHi, true);
      const f = fadeOf.get(pc);
      const fadeIn = Math.min(pc.duration, Math.max(a0.fadeIn || 0, f?.fadeIn ?? 0));
      const fadeOut = Math.min(pc.duration, Math.max(a0.fadeOut || 0, f?.fadeOut ?? 0));
      if (f && ((f.fadeIn && a0.fadeIn > 0) || (f.fadeOut && a0.fadeOut > 0))) issues.add('fade-merge', 'level', 'info', (n) => `${count(n)} with both a fade and a fade transition on one edge use the longer one.`, item);
      if (vs) issues.add('level-approx', 'level', 'info', (n) => `Level keyframes and nested fades on ${count(n)} are written in dB and may differ slightly between keyframes.`, item);
      if (props.level || fadeIn || fadeOut || vs) {
        const kids: XNode[] = [];
        if (fadeIn) kids.push(el('fadeIn', [['type', 'linear'], ['duration', T(fadeIn).toTime()]]));
        if (fadeOut) kids.push(el('fadeOut', [['type', 'linear'], ['duration', T(fadeOut).toTime()]]));
        if (vs) kids.push(keyframes(vs.points, (pt) => dbs(pt.values[0] * trackVol)));
        const amount = vs ? vs.points[0].values[0] : fixed(a0.keyframes?.volume, a0.volume ?? 1);
        node.kids.push(el('adjust-volume', [['amount', dbs(amount * trackVol)]], kids.length ? [el('param', [['name', 'amount']], kids)] : []));
      }
      if (props.channels) issues.add('channels', 'audio-channels', 'warning', (n) => `Channel selection (one channel or a downmix) on ${count(n)} is not exported; the stream's normal mix plays.`, item);
      if (props.stream) issues.add('stream', 'audio-stream', 'warning', (n) => `${count(n)} play${n === 1 ? 's' : ''} an audio stream other than the file's first; check the stream after import.`, item);
    }
    if (c.linkId) issues.add('linked', 'other', 'info', (n) => `Linked video and audio are exported as separate clips (${count(n)}).`, item);
    return node;
  };

  const trNode = (tr: PTransition, kind: 'video' | 'audio', offset: Q): XNode => el('transition', [['name', 'Cross Dissolve'], ['offset', offset.toTime()], ['duration', T(tr.frames).toTime()]], [
    kind === 'video'
      ? el('filter-video', [['ref', R.effect('Cross Dissolve', CROSS_DISSOLVE_UID)], ['name', 'Cross Dissolve']])
      : el('filter-audio', [['ref', R.effect('Audio Crossfade', AUDIO_CROSSFADE_UID)], ['name', 'Audio Crossfade']]),
  ]);

  const itemNodes = (items: Item[], kind: 'video' | 'audio', off: (t: number) => Q, onEl?: (e: SpineEl) => void): XNode[] => items.map((it) => {
    if (it.kind === 'gap') {
      const node = el('gap', [['name', 'Gap'], ['offset', off(it.start).toTime()], ['start', '0s'], ['duration', T(it.dur).toTime()]]);
      onEl?.({ offset: it.start, dur: it.dur, start: new Q(0n), node });
      return node;
    }
    if (it.kind === 'clip') {
      const node = clipNode(it.pc, undefined, off(it.pc.start));
      onEl?.({ offset: it.pc.start, dur: it.pc.duration, start: mediaTime(it.pc), node });
      return node;
    }
    return trNode(it.tr, kind, off(it.tr.at - it.tr.half));
  });

  // Primary spine: V1, filled to the end of the sequence.
  interface SpineEl { offset: number; dur: number; start: Q; node: XNode }
  const prim: SpineEl[] = [];
  const spine = el('spine', [], itemNodes(trackItems(p.videoTracks[0], 0, total), 'video', T, (e) => prim.push(e)));
  const local = (e: SpineEl, t: number) => e.start.add(T(t - e.offset));
  const parentAt = (t: number): SpineEl | undefined => {
    let lo = 0, hi = prim.length - 1, best: SpineEl | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (prim[mid].offset <= t) { best = prim[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  };

  // Every other track: connected clips, or one connected storyline when it has dissolves.
  const attach = (t: PTrack, lane: number) => {
    if (!t.clips.length) return;
    if (t.transitions.some((x) => x.kind === 'dissolve')) {
      const first = t.clips[0];
      const parent = parentAt(first.start)!;
      const story = el('spine', [['lane', String(lane)], ['offset', local(parent, first.start).toTime()], ['name', t.name]],
        itemNodes(trackItems(t, first.start), t.kind, (x) => local(parent, x)));
      parent.node.anchors.push(story);
      return;
    }
    for (const pc of t.clips) {
      const parent = parentAt(pc.start)!;
      parent.node.anchors.push(clipNode(pc, lane, local(parent, pc.start)));
    }
  };
  p.videoTracks.slice(1).forEach((t) => attach(t, t.index));
  p.audioTracks.forEach((t) => attach(t, -(t.index + 1)));

  // Markers: on the spine element under them, in its local time.
  let dropped = 0;
  for (const m of p.markers) {
    const parent = m.time < total ? parentAt(m.time) : undefined;
    if (!parent) { dropped++; continue; }
    const start = local(parent, m.time).toTime();
    const dur = T(Math.max(1, Math.round(m.duration) || 1)).toTime();
    if (m.kind === 'chapter') parent.node.marks.push(el('chapter-marker', [['start', start], ['duration', dur], ['value', m.name || 'Chapter'], ['posterOffset', '0s']]));
    else parent.node.marks.push(el('marker', [['start', start], ['duration', dur], ['value', m.name || 'Marker'], ['completed', m.kind === 'continuity' ? (m.resolved ? '1' : '0') : undefined], ['note', m.note || undefined]]));
  }
  if (dropped) issues.add('markers-end', 'markers', 'warning', (n) => `${count(n, 'marker')} after the end of the sequence ${isAre(n)} left out.`, null, dropped);
  if (p.markers.length - dropped > 0) issues.add('marker-colour', 'markers', 'info', (n) => `FCPXML has no marker colours: ${count(n, 'marker')} import${n === 1 ? 's' : ''} in the default colour.`, null, p.markers.length - dropped);

  const df = dropFramesPerMinute(p.fps) > 0;
  const sampleRate = p.seq.sampleRate;
  const rates: Record<number, string> = { 32000: '32k', 44100: '44.1k', 48000: '48k', 88200: '88.2k', 96000: '96k', 176400: '176.4k', 192000: '192k' };
  const sequence = el('sequence', [
    ['format', R.seqFormat], ['duration', T(total).toTime()], ['tcStart', '0s'], ['tcFormat', df ? 'DF' : 'NDF'],
    ['audioLayout', p.seq.channels === 6 ? 'surround' : 'stereo'], ['audioRate', rates[sampleRate] ?? '48k'],
  ], [spine]);
  const root = el('fcpxml', [['version', FCPXML_VERSION]], [
    el('resources', [], R.nodes),
    el('library', [], [el('event', [['name', p.project.name || 'ReCut']], [el('project', [['name', p.name]], [sequence])])]),
  ]);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n\n${serialize(root)}`;
}
