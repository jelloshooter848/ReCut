/**
 * Keyframes (Roadmap §11, first version): per-property keyframe lists on a clip's transform (position x / y, scale,
 * opacity) and audio (level), their evaluation over time, edits, and the FFmpeg expressions the export builds from
 * them. Pure: no DOM, no Node. The preview (src/playback/planner.ts) and the export (electron/export/renderGraph.ts)
 * both evaluate through this module, so they agree on every frame.
 *
 * Time: a keyframe's `frame` is in clip-relative timeline frames (0 = the clip's first frame on the timeline).
 *  - Moving a clip keeps its keyframes on the same picture.
 *  - Trimming the clip's head (trim, ripple trim, roll, slide, an overwrite that covers its head) shifts them by the
 *    trimmed frames, so each stays on the same source moment and timeline frame (shiftClipKeyframes). Trimming the tail
 *    leaves them alone. Keyframes that end up outside the visible range are kept and still shape the interpolation:
 *    trimming back out shows them again.
 *  - Razor: both parts keep every keyframe (the right part's shifted), so the animation is unchanged across the cut.
 *  - Slip keeps the keyframes where they are in the clip (the motion stays on the timeline, the source moves under it).
 *  - Speed: keyframes count timeline frames of the clip, independent of its speed. A speed change that changes the
 *    clip's length keeps them at the same clip frame (a keyframe at frame 48 stays two seconds into the clip at 24 fps).
 *
 * Values: before the first keyframe the property holds the first value, after the last it holds the last value.
 * Between two keyframes it moves from one to the other: straight (`linear`) or along the ease curve (`ease`,
 * smoothstep, slow at both ends), chosen by the earlier keyframe's `interp`.
 */
import type { AudioKeyframes, Clip, Keyframe, KeyframeInterp, TransformKeyframes } from './model';
import { MAX_TIMELINE_FRAMES } from './limits';

export type TransformKeyProp = keyof TransformKeyframes;
export type AudioKeyProp = keyof AudioKeyframes;
/** A clip property that can carry keyframes. */
export type KeyProp = TransformKeyProp | AudioKeyProp;

export const TRANSFORM_KEY_PROPS: readonly TransformKeyProp[] = ['x', 'y', 'scale', 'opacity'];
export const AUDIO_KEY_PROPS: readonly AudioKeyProp[] = ['volume'];

/** What the Inspector animates as one row: Position is x and y together. */
export type KeyframeGroup = 'position' | 'scale' | 'opacity' | 'volume';
export const KEYFRAME_GROUPS: Readonly<Record<KeyframeGroup, readonly KeyProp[]>> = {
  position: ['x', 'y'], scale: ['scale'], opacity: ['opacity'], volume: ['volume'],
};

/** More keyframes than this on one property are dropped at load (and refused by the edit helpers). */
export const MAX_KEYFRAMES_PER_PROPERTY = 2000;
/** Smallest animated scale (1 %), as the Inspector's scale field. */
export const MIN_KEYFRAME_SCALE = 0.01;
export const MAX_KEYFRAME_SCALE = 100;
/** Largest |position| (pixels) a keyframe may hold. */
export const MAX_KEYFRAME_POSITION = 100_000;

// ------------------------------------------------------------------ evaluation

/** The ease curve: smoothstep, u² (3 − 2u), for u in 0..1. The export's expression uses the same formula. */
export function easeCurve(u: number): number { return u * u * (3 - 2 * u); }

/**
 * Value of a keyframe list at clip frame `k` (may be fractional). `keys` must be non-empty, sorted by frame with one
 * keyframe per frame (normalizeKeyframes guarantees it for loaded projects; the edit helpers keep it).
 */
export function evaluateKeyframes(keys: readonly Keyframe[], k: number): number {
  const n = keys.length;
  if (!(k > keys[0].frame)) return keys[0].value; // also NaN
  if (k >= keys[n - 1].frame) return keys[n - 1].value;
  let lo = 0, hi = n - 1; // keys[lo].frame <= k < keys[hi].frame
  while (hi - lo > 1) { const mid = (lo + hi) >>> 1; if (keys[mid].frame <= k) lo = mid; else hi = mid; }
  const a = keys[lo], b = keys[hi];
  const u = (k - a.frame) / (b.frame - a.frame);
  return a.value + (b.value - a.value) * (a.interp === 'ease' ? easeCurve(u) : u);
}

/** The property's keyframes when it is animated (a non-empty list), else undefined. */
export function keyframesOf(clip: Pick<Clip, 'transform' | 'audio'>, prop: KeyProp): readonly Keyframe[] | undefined {
  const list = prop === 'volume' ? clip.audio.keyframes?.volume : clip.transform.keyframes?.[prop];
  return list && list.length ? list : undefined;
}

function staticValue(clip: Pick<Clip, 'transform' | 'audio'>, prop: KeyProp): number {
  return prop === 'volume' ? clip.audio.volume : clip.transform[prop];
}

/**
 * Evaluate(prop, clip, frame): the property's value at timeline frame `frame` (fractional allowed): the keyframes
 * at clip frame `frame - clip.start` when the property is animated, else its static value. Not clamped: callers clamp
 * as they do for the static value (opacity 0..1, level >= 0).
 */
export function evaluateClipProperty(prop: KeyProp, clip: Pick<Clip, 'start' | 'transform' | 'audio'>, frame: number): number {
  const keys = keyframesOf(clip, prop);
  return keys ? evaluateKeyframes(keys, frame - clip.start) : staticValue(clip, prop);
}

/** Any of position, scale or opacity animated. */
export function hasTransformKeyframes(clip: Pick<Clip, 'transform'>): boolean {
  const k = clip.transform.keyframes;
  return !!k && !!(k.x?.length || k.y?.length || k.scale?.length || k.opacity?.length);
}

/** Position or scale animated (the export then places the picture per frame). */
export function hasMotionKeyframes(clip: Pick<Clip, 'transform'>): boolean {
  const k = clip.transform.keyframes;
  return !!k && !!(k.x?.length || k.y?.length || k.scale?.length);
}

export function hasVolumeKeyframes(clip: Pick<Clip, 'audio'>): boolean {
  return !!clip.audio.keyframes?.volume?.length;
}

export function hasKeyframes(clip: Pick<Clip, 'transform' | 'audio'>): boolean {
  return hasTransformKeyframes(clip) || hasVolumeKeyframes(clip);
}

/** The clip's transform at timeline frame `frame`: the clip's own object when nothing is animated (no allocation). */
export function transformAt(clip: Clip, frame: number): Clip['transform'] {
  const t = clip.transform;
  if (!hasTransformKeyframes(clip)) return t;
  return {
    ...t,
    x: evaluateClipProperty('x', clip, frame),
    y: evaluateClipProperty('y', clip, frame),
    scale: evaluateClipProperty('scale', clip, frame),
    opacity: evaluateClipProperty('opacity', clip, frame),
  };
}

/** Smallest and largest value a property takes over clip frames [k0, k1] (keyframes are the extremes of every curve). */
export function keyframeRange(clip: Pick<Clip, 'transform' | 'audio'>, prop: KeyProp, k0: number, k1: number): { min: number; max: number } {
  const keys = keyframesOf(clip, prop);
  if (!keys) { const v = staticValue(clip, prop); return { min: v, max: v }; }
  let min = evaluateKeyframes(keys, k0), max = min;
  const end = evaluateKeyframes(keys, k1);
  min = Math.min(min, end); max = Math.max(max, end);
  for (const kf of keys) if (kf.frame > k0 && kf.frame < k1) { min = Math.min(min, kf.value); max = Math.max(max, kf.value); }
  return { min, max };
}

// ------------------------------------------------------------------ queries for the UI

/** Clip-relative frames that hold a keyframe of any of `props` (all properties by default), sorted, unique. */
export function clipKeyframeFrames(clip: Pick<Clip, 'transform' | 'audio'>, props: readonly KeyProp[] = [...TRANSFORM_KEY_PROPS, ...AUDIO_KEY_PROPS]): number[] {
  const set = new Set<number>();
  for (const p of props) for (const k of keyframesOf(clip, p) ?? []) set.add(k.frame);
  return [...set].sort((a, b) => a - b);
}

/** The keyframe of `keys` at clip frame `k`, if any. */
export function keyframeAt(keys: readonly Keyframe[] | undefined, k: number): Keyframe | undefined {
  if (!keys) return undefined;
  let lo = 0, hi = keys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const f = keys[mid].frame;
    if (f === k) return keys[mid];
    if (f < k) lo = mid + 1; else hi = mid - 1;
  }
  return undefined;
}

/**
 * The keyframe whose interpolation applies at clip frame `k`: the one at `k`, else the last one before it when `k` lies
 * between two keyframes. Undefined before the first and from the last keyframe on (nothing to interpolate).
 */
export function segmentKeyframe(keys: readonly Keyframe[] | undefined, k: number): Keyframe | undefined {
  if (!keys || keys.length === 0) return undefined;
  const at = keyframeAt(keys, k);
  if (at) return at;
  if (k < keys[0].frame || k >= keys[keys.length - 1].frame) return undefined;
  let found: Keyframe | undefined;
  for (const kf of keys) { if (kf.frame <= k) found = kf; else break; }
  return found;
}

// ------------------------------------------------------------------ edits (pure: new arrays, never in place)

/** Clamp a keyframe value to what the property accepts. Non-finite values return null. */
export function clampKeyframeValue(prop: KeyProp, value: number): number | null {
  if (!Number.isFinite(value)) return null;
  switch (prop) {
    case 'opacity': return Math.min(1, Math.max(0, value));
    case 'volume': return Math.min(2, Math.max(0, value));
    case 'scale': return Math.min(MAX_KEYFRAME_SCALE, Math.max(MIN_KEYFRAME_SCALE, value));
    default: return Math.min(MAX_KEYFRAME_POSITION, Math.max(-MAX_KEYFRAME_POSITION, value));
  }
}

/**
 * `keys` with a keyframe at clip frame `k` holding `value`: replaced (keeping its interpolation unless `interp` is
 * given) or inserted in order. Returns `keys` itself when the list is full.
 */
export function putKeyframe(keys: readonly Keyframe[] | undefined, k: number, value: number, interp?: KeyframeInterp): Keyframe[] {
  const list = keys ? keys.slice() : [];
  const frame = Math.round(k);
  let i = 0;
  while (i < list.length && list[i].frame < frame) i++;
  if (i < list.length && list[i].frame === frame) {
    const prev = list[i];
    const next: Keyframe = { frame, value };
    const mode = interp ?? prev.interp;
    if (mode === 'ease') next.interp = 'ease';
    list[i] = next;
    return list;
  }
  if (list.length >= MAX_KEYFRAMES_PER_PROPERTY) return list;
  const kf: Keyframe = { frame, value };
  if (interp === 'ease') kf.interp = 'ease';
  list.splice(i, 0, kf);
  return list;
}

/** `keys` without the keyframe at clip frame `k`. */
export function dropKeyframe(keys: readonly Keyframe[] | undefined, k: number): Keyframe[] {
  return (keys ?? []).filter((kf) => kf.frame !== k);
}

/** `keys` with the keyframe at `k` set to `interp` (unchanged when there is none). */
export function withKeyframeInterp(keys: readonly Keyframe[] | undefined, k: number, interp: KeyframeInterp): Keyframe[] {
  return (keys ?? []).map((kf) => {
    if (kf.frame !== k) return kf;
    const next: Keyframe = { frame: kf.frame, value: kf.value };
    if (interp === 'ease') next.interp = 'ease';
    return next;
  });
}

/** Every keyframe moved by `delta` clip frames (kept within the timeline limits). */
export function shiftKeyframes(keys: readonly Keyframe[], delta: number): Keyframe[] {
  return keys.map((kf) => ({ ...kf, frame: clampFrame(kf.frame + delta) }));
}

function clampFrame(f: number): number { return Math.max(-MAX_TIMELINE_FRAMES, Math.min(MAX_TIMELINE_FRAMES, Math.round(f))); }

type KeyedClip = Pick<Clip, 'transform' | 'audio'>;

/** Write a property's keyframe list on a (writable) clip; an empty list removes the property's keyframes. */
export function setClipKeyframes(clip: KeyedClip, prop: KeyProp, keys: Keyframe[]): void {
  if (prop === 'volume') {
    const cur = clip.audio.keyframes;
    if (keys.length) clip.audio.keyframes = { ...cur, volume: keys };
    else if (cur) {
      const { volume: _drop, ...rest } = cur;
      if (Object.keys(rest).length) clip.audio.keyframes = rest; else delete clip.audio.keyframes;
    }
    return;
  }
  const cur = clip.transform.keyframes;
  if (keys.length) clip.transform.keyframes = { ...cur, [prop]: keys };
  else if (cur) {
    const rest: TransformKeyframes = { ...cur };
    delete rest[prop];
    if (Object.keys(rest).length) clip.transform.keyframes = rest; else delete clip.transform.keyframes;
  }
}

/**
 * Head trim: the clip's first frame moved by `delta` timeline frames (start += delta, sourceIn moved with it). Its
 * keyframes move by -delta so they stay on the same source moment and timeline frame. No-op without keyframes.
 */
export function shiftClipKeyframes(clip: KeyedClip, delta: number): void {
  if (!delta) return;
  const t = clip.transform.keyframes;
  if (t) {
    const next: TransformKeyframes = {};
    for (const p of TRANSFORM_KEY_PROPS) { const l = t[p]; if (l) next[p] = shiftKeyframes(l, -delta); }
    clip.transform.keyframes = next;
  }
  const a = clip.audio.keyframes;
  if (a?.volume) clip.audio.keyframes = { ...a, volume: shiftKeyframes(a.volume, -delta) };
}

/** Clip frame of a timeline frame, kept inside the clip ([0, duration - 1]): where an edit at the playhead lands. */
export function clipFrameAt(clip: Pick<Clip, 'start' | 'duration'>, frame: number): number {
  return Math.max(0, Math.min(Math.max(0, clip.duration - 1), Math.round(frame) - clip.start));
}

/**
 * Set a property at timeline frame `frame` on a (writable) clip: when it is animated, the keyframe at that frame
 * (added if there is none); otherwise the static value. The value is clamped like a keyframe value.
 */
export function writeClipProperty(clip: Clip, prop: KeyProp, frame: number, value: number): void {
  const v = clampKeyframeValue(prop, value);
  if (v === null) return;
  const keys = keyframesOf(clip, prop);
  if (keys) {
    const k = clipFrameAt(clip, frame);
    // Position is one property in the Inspector: an animated y gets a keyframe (its current value) where x is keyed.
    for (const other of prop === 'x' ? ['y'] as const : prop === 'y' ? ['x'] as const : []) {
      const ok = keyframesOf(clip, other);
      if (ok && !keyframeAt(ok, k)) setClipKeyframes(clip, other, putKeyframe(ok, k, evaluateKeyframes(ok, k)));
    }
    setClipKeyframes(clip, prop, putKeyframe(keys, k, v));
    return;
  }
  if (prop === 'volume') clip.audio.volume = v; else clip.transform[prop] = v;
}

/** Add a keyframe at timeline frame `frame` holding the property's current value there (for each of `props`). */
export function addKeyframeAt(clip: Clip, props: readonly KeyProp[], frame: number): void {
  const k = clipFrameAt(clip, frame);
  for (const p of props) {
    const v = clampKeyframeValue(p, evaluateClipProperty(p, clip, clip.start + k));
    if (v === null) continue;
    setClipKeyframes(clip, p, putKeyframe(keyframesOf(clip, p), k, v));
  }
}

/**
 * Remove the keyframe at timeline frame `frame` (for each of `props`). Removing a property's last keyframe makes it
 * static again at that keyframe's value, so the picture does not jump.
 */
export function removeKeyframeAt(clip: Clip, props: readonly KeyProp[], frame: number): void {
  const k = clipFrameAt(clip, frame);
  for (const p of props) {
    const keys = keyframesOf(clip, p);
    const kf = keyframeAt(keys, k);
    if (!keys || !kf) continue;
    const rest = dropKeyframe(keys, k);
    if (rest.length === 0) { if (p === 'volume') clip.audio.volume = kf.value; else clip.transform[p] = kf.value; }
    setClipKeyframes(clip, p, rest);
  }
}

/** Remove every keyframe of `props`; each becomes static at its value at timeline frame `frame`. */
export function clearKeyframes(clip: Clip, props: readonly KeyProp[], frame: number): void {
  for (const p of props) {
    if (!keyframesOf(clip, p)) continue;
    const v = clampKeyframeValue(p, evaluateClipProperty(p, clip, frame));
    if (v !== null) { if (p === 'volume') clip.audio.volume = v; else clip.transform[p] = v; }
    setClipKeyframes(clip, p, []);
  }
}

/** Set the interpolation of the keyframe that governs timeline frame `frame` (segmentKeyframe), for each of `props`. */
export function setInterpAt(clip: Clip, props: readonly KeyProp[], frame: number, interp: KeyframeInterp): void {
  const k = Math.round(frame) - clip.start;
  for (const p of props) {
    const keys = keyframesOf(clip, p);
    const kf = segmentKeyframe(keys, k);
    if (keys && kf) setClipKeyframes(clip, p, withKeyframeInterp(keys, kf.frame, interp));
  }
}

// ------------------------------------------------------------------ load-time repair

/**
 * A keyframe list read from a project file: entries with a finite frame and value are kept (frames rounded, values
 * clamped to the property's range, interpolation 'ease' or dropped), sorted, one per frame (the last one wins), at most
 * MAX_KEYFRAMES_PER_PROPERTY. `repaired` says whether anything was changed or dropped.
 */
export function normalizeKeyframeList(prop: KeyProp, v: unknown): { value: Keyframe[]; repaired: boolean } {
  if (!Array.isArray(v)) return { value: [], repaired: v !== undefined };
  let repaired = false;
  const byFrame = new Map<number, Keyframe>();
  for (const e of v) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) { repaired = true; continue; }
    const o = e as Record<string, unknown>;
    const f = o.frame, val = o.value;
    if (typeof f !== 'number' || !Number.isFinite(f) || typeof val !== 'number') { repaired = true; continue; }
    const cv = clampKeyframeValue(prop, val);
    if (cv === null) { repaired = true; continue; }
    const frame = clampFrame(f);
    if (frame !== f || cv !== val) repaired = true;
    const kf: Keyframe = { frame, value: cv };
    if (o.interp === 'ease') kf.interp = 'ease';
    else if (o.interp !== undefined && o.interp !== 'linear') repaired = true;
    if (byFrame.has(frame)) repaired = true;
    byFrame.set(frame, kf);
  }
  let list = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
  if (list.length > MAX_KEYFRAMES_PER_PROPERTY) { list = list.slice(0, MAX_KEYFRAMES_PER_PROPERTY); repaired = true; }
  if (!repaired) for (let i = 1; i < v.length; i++) if ((v[i] as Keyframe).frame < (v[i - 1] as Keyframe).frame) { repaired = true; break; }
  return { value: list, repaired };
}

/** `keyframes` of a loaded transform or audio object: valid lists kept, empty / unknown entries dropped. */
export function normalizeKeyframeSet<P extends KeyProp>(props: readonly P[], v: unknown): { value?: Partial<Record<P, Keyframe[]>>; repaired: boolean } {
  if (v === undefined) return { repaired: false };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { repaired: true };
  const o = v as Record<string, unknown>;
  let repaired = Object.keys(o).some((k) => !(props as readonly string[]).includes(k));
  const out: Partial<Record<P, Keyframe[]>> = {};
  for (const p of props) {
    if (!(p in o)) continue;
    const r = normalizeKeyframeList(p, o[p]);
    if (r.repaired) repaired = true;
    if (r.value.length) out[p] = r.value;
  }
  return Object.keys(out).length ? { value: out, repaired } : { repaired };
}

// ------------------------------------------------------------------ FFmpeg expressions (the export)

/** A number for an FFmpeg expression: at most 6 decimals, never in exponent form, negative ones in parentheses. */
export function exprNum(x: number): string {
  const v = Math.round(x * 1e6) / 1e6;
  if (v === 0) return '0';
  const s = Math.abs(v).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return v < 0 ? `(-${s})` : s;
}

/**
 * FFmpeg expression for the value of `keys` at the clip frame given by the expression `k` (for example `(in-1+12)`).
 * Same values as evaluateKeyframes, written as one flat sum so it needs no nesting per keyframe:
 *   v0 + Σ (v[i+1] − v[i]) · e(clip((k − f[i]) / (f[i+1] − f[i]), 0, 1))
 * with e(u) = u (linear) or u·u·(3 − 2u) (ease). The terms are grouped in a balanced tree of parentheses, so FFmpeg's
 * recursive evaluator stays shallow with many keyframes. Its length grows linearly with the keyframes (about 60 to 110
 * characters per keyframe); the filter script that carries it has no length limit.
 */
export function keyframesExpr(keys: readonly Keyframe[], k: string): string {
  const terms: string[] = [];
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i], b = keys[i + 1];
    const dv = b.value - a.value;
    if (dv === 0) continue;
    const u = `clip((${k}-${exprNum(a.frame)})/${exprNum(b.frame - a.frame)},0,1)`;
    const e = a.interp === 'ease' ? `${u}*${u}*(3-2*${u})` : u;
    terms.push(`${exprNum(dv)}*${e}`);
  }
  if (terms.length === 0) return exprNum(keys[0].value);
  return `${exprNum(keys[0].value)}+${balancedSum(terms)}`;
}

function balancedSum(terms: string[]): string {
  if (terms.length === 1) return terms[0];
  const mid = terms.length >> 1;
  return `(${balancedSum(terms.slice(0, mid))}+${balancedSum(terms.slice(mid))})`;
}
