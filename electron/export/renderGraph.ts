/**
 * Pure ffmpeg render-graph builder for sequence export.
 *
 * Turns an ExportRequest (sequence + media + settings) into a complete ffmpeg argument list and a
 * filter_complex graph. No Electron / Node I/O here (only `node:path` for joining the output path),
 * so it is unit-testable and can be used to preview the command.
 *
 * See docs/export-pipeline.md for the design (per-track segment chains, centered transitions,
 * exact frame counts, compositing, audio mixing).
 */
import path from 'node:path';
import type { Clip, ExportSettings, ID, MediaItem, Rational, Sequence, Track, Transition, VideoStreamInfo } from '@shared/model';
import type { ExportRequest } from '@shared/ipc';
import { clipEnd, sequenceDuration, sourceTimeAt } from '@shared/timeline';
import { framesToSeconds } from '@shared/time';
import { serializeSrt } from '@shared/subtitles';

/** Placeholder in `args` for the path of the filter script file (see exporter.ts). */
export const FILTER_SCRIPT_TOKEN = '__FILTER_SCRIPT__';

export interface RenderGraph {
  /** Complete ffmpeg args (without the binary). Contains `-filter_complex_script FILTER_SCRIPT_TOKEN`. */
  args: string[];
  /** The filter_complex graph (chains separated by ";\n"). */
  filterGraph: string;
  /** Exact output duration in seconds (= range length). */
  durationSec: number;
  /** Exact output frame count. */
  frameCount: number;
  /** Final output path (outputDir/fileName.mp4). This is the last element of `args`. */
  outputPath: string;
  warnings: string[];
  /** SRT content to burn in (range-relative), present when settings.burnSubtitles and cues exist in range. */
  subtitleContent?: string;
  /** Number of ffmpeg inputs (one per rendered clip segment). */
  inputCount: number;
  /** The `-i` input args alone (flattened), as they appear in `args`. */
  inputArgs: string[];
  /** Video encoder args (`-c:v` .. `-fps_mode cfr`), as they appear in `args`. */
  videoCodecArgs: string[];
  /** Audio encoder args (`-c:a` .. `-ac N`), as they appear in `args`. */
  audioCodecArgs: string[];
  /** Output audio sample rate and channel count. */
  sampleRate: number;
  channels: number;
  /** Rendered range in absolute sequence frames `[startF, endF)`. */
  startF: number;
  endF: number;
}

export interface RenderGraphOptions {
  /** Path of the SRT file the caller wrote `subtitleContent` to; enables the `subtitles=` filter. */
  subtitleFilePath?: string;
  /**
   * Canonicalize a path for the "output overwrites a source" check (exporter passes an fs.realpath
   * based resolver). Defaults to path.resolve, keeping this module free of file-system I/O.
   */
  canonicalPath?: (p: string) => string;
  /** Platform for case-insensitive path comparison (defaults to process.platform). */
  platform?: NodeJS.Platform;
  /**
   * Render only this sub-range `[startF, endF)` (absolute sequence frames, inside the request's range).
   * Used by chunked export (exporter.ts); burn-in subtitles become relative to the sub-range.
   * The "nothing enabled in range" check is skipped (a chunk may be all gap).
   */
  range?: { startF: number; endF: number };
  /** Build only the video (`[vout]`) or only the audio (`[aout]`) part of the graph. Default: both. */
  streams?: 'video' | 'audio';
  /** Make `[aout]` exactly this many samples long (padded with silence / trimmed). */
  audioSamples?: number;
}

/** Output dimension limits (mirror src/panels/export/settings.ts MIN_DIMENSION / MAX_DIMENSION). */
export const MIN_EXPORT_DIMENSION = 16;
export const MAX_EXPORT_DIMENSION = 8192;

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

/** Format seconds for filter options (fixed decimals, no exponent). */
export function sec(x: number): string {
  const v = Math.round(x * 1e6) / 1e6;
  return v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}
function num(x: number): string {
  return String(Math.round(x * 1e4) / 1e4);
}
function fpsStr(fps: Rational): string { return `${fps.num}/${fps.den}`; }

/**
 * Escape a file path for use as a filter option value inside a filtergraph string.
 * Two parsing levels apply (graph level and option level), each consuming `\` escapes and quotes.
 */
export function escapeFilterPath(p: string): string {
  const option = p.replace(/[\\':]/g, (m) => '\\' + m);          // option-level: \ ' :
  return option.replace(/[\\'\[\],;]/g, (m) => '\\' + m);         // graph-level: \ ' [ ] , ;
}

function isImageMedia(m: MediaItem): boolean {
  if (m.kind === 'image') return true;
  const p = m.probe;
  return !!(p && p.video && (!p.duration || p.duration <= 0) && p.audio.length === 0);
}

function mediaDurationSec(m: MediaItem): number {
  if (isImageMedia(m)) return Infinity;
  const d = m.probe?.duration;
  return d && d > 0 ? d : Infinity;
}

export function activeTracks(tracks: Track[]): Track[] {
  const live = tracks.filter((t) => !t.muted);
  const solo = live.filter((t) => t.solo);
  return solo.length ? solo : live;
}

function resolveRange(seq: Sequence, settings: ExportSettings, warnings: string[]): { startF: number; endF: number } {
  const total = sequenceDuration(seq);
  if (settings.rangeMode === 'inOut') {
    const i = seq.view.inPoint, o = seq.view.outPoint;
    if (i !== null && o !== null && o > i) return { startF: Math.max(0, Math.round(i)), endF: Math.round(o) };
    warnings.push('In/Out range is not set or empty; exporting the entire sequence instead.');
  }
  if (total <= 0) throw new Error('Nothing to export: the sequence is empty.');
  return { startF: 0, endF: total };
}

// ---------------------------------------------------------------------------------------------------
// Segment model
// ---------------------------------------------------------------------------------------------------

interface ClipSeg {
  kind: 'clip';
  clip: Clip;
  media: MediaItem;
  /** Timeline frames relative to range start (before transition extension). */
  start: number;
  frames: number;
  /** Source position (seconds) at `start`. */
  srcStart: number;
  /** Transition handles, in frames. */
  extBefore: number;
  extAfter: number;
  /** Transition INTO this segment from the previous segment (centered on the cut). */
  transIn?: { type: Transition['type']; frames: number };
  /** Fade from black/silence at segment start (transition with outClipId null). */
  fadeIn?: number;
  /** Fade to black/silence at segment end (transition with inClipId null). */
  fadeOut?: number;
  isImage: boolean;
  speed: number;
  /** Set once the segment is assigned an ffmpeg input index. */
  input: number;
}
interface GapSeg { kind: 'gap'; frames: number }
type Seg = ClipSeg | GapSeg;

interface TrackPlan { track: Track; segs: Seg[] }

function collectTrackSegments(
  track: Track, seq: Sequence, media: Record<ID, MediaItem>, startF: number, endF: number,
  need: 'video' | 'audio', warnings: string[],
): TrackPlan {
  const fps = seq.fps;
  const fd = fps.den / fps.num;
  const clipSegs: ClipSeg[] = [];
  const sorted = track.clips
    .filter((c) => c.enabled && c.start < endF && clipEnd(c) > startF)
    .sort((a, b) => a.start - b.start);
  let cursor = startF;
  for (const clip of sorted) {
    const m = media[clip.mediaId];
    if (!m) { warnings.push(`Clip "${clip.name}" on ${track.name}: media is missing from the project; rendered as ${need === 'video' ? 'black' : 'silence'}.`); continue; }
    if (m.offline) { warnings.push(`Clip "${clip.name}" on ${track.name}: media "${m.name}" is offline; rendered as ${need === 'video' ? 'black' : 'silence'}.`); continue; }
    if (need === 'video' && m.probe && !m.probe.video) { warnings.push(`Clip "${clip.name}" on ${track.name}: media "${m.name}" has no video stream; rendered as black.`); continue; }
    if (need === 'audio' && m.probe && m.probe.audio.length === 0) { warnings.push(`Clip "${clip.name}" on ${track.name}: media "${m.name}" has no audio stream; rendered as silence.`); continue; }
    if (need === 'audio' && clip.audio.muted) continue; // muted clip => silence
    let speed = clip.speed;
    if (!(speed > 0) || !Number.isFinite(speed)) { warnings.push(`Clip "${clip.name}": invalid speed ${clip.speed}; using 1.0.`); speed = 1; }
    const segStartAbs = Math.max(clip.start, startF, cursor);
    const segEndAbs = Math.min(clipEnd(clip), endF);
    if (segEndAbs <= segStartAbs) continue;
    if (segStartAbs > Math.max(clip.start, startF)) warnings.push(`Clip "${clip.name}" overlaps the previous clip on ${track.name}; the overlap is trimmed.`);
    const mediaDur = mediaDurationSec(m);
    if (Number.isFinite(mediaDur)) {
      const srcEnd = sourceTimeAt({ ...clip, speed }, segEndAbs, fps);
      if (srcEnd > mediaDur + fd / 2 + 1e-6) {
        warnings.push(`Clip "${clip.name}" on ${track.name} extends past the end of its media "${m.name}" (needs ${srcEnd.toFixed(2)}s, media is ${mediaDur.toFixed(2)}s); ${need === 'video' ? 'the last frame is held' : 'the rest is silent'}.`);
      }
    }
    clipSegs.push({
      kind: 'clip', clip, media: m,
      start: segStartAbs - startF, frames: segEndAbs - segStartAbs,
      srcStart: sourceTimeAt({ ...clip, speed }, segStartAbs, fps),
      extBefore: 0, extAfter: 0, isImage: isImageMedia(m), speed, input: -1,
    });
    cursor = segEndAbs;
  }

  // Transitions (centered on cuts; handles taken from source media).
  const byId = new Map(clipSegs.map((s) => [s.clip.id, s] as const));
  for (const tr of track.transitions) {
    const wantAudio = need === 'audio';
    const typeOk = wantAudio ? (tr.type === 'audioCrossfade' || tr.type === 'crossDissolve') : (tr.type === 'crossDissolve' || tr.type === 'dipToBlack');
    if (!typeOk) continue;
    const D = Math.max(0, Math.round(tr.duration));
    if (D <= 0) continue;
    const outSeg = tr.outClipId ? byId.get(tr.outClipId) : undefined;
    const inSeg = tr.inClipId ? byId.get(tr.inClipId) : undefined;
    if (tr.outClipId && tr.inClipId) {
      if (!outSeg || !inSeg) { continue; } // one side skipped/out of range -> hard cut (already warned if media problem)
      const cutAbs = clipEnd(outSeg.clip);
      if (inSeg.clip.start !== cutAbs) { warnings.push(`Transition between "${outSeg.clip.name}" and "${inSeg.clip.name}" is not on an adjacent cut; ignored.`); continue; }
      const cut = cutAbs - startF;
      if (outSeg.start + outSeg.frames !== cut || inSeg.start !== cut) { warnings.push(`Transition at the edge of the export range is dropped (hard cut).`); continue; }
      // Handles (frames) available on each side.
      const outDur = mediaDurationSec(outSeg.media);
      const srcOut = outSeg.srcStart + outSeg.frames * fd * outSeg.speed;
      const handleOut = Number.isFinite(outDur) ? Math.floor(((outDur - srcOut) / outSeg.speed) / fd + 1e-6) : Infinity;
      const handleIn = inSeg.isImage ? Infinity : Math.floor((inSeg.srcStart / inSeg.speed) / fd + 1e-6);
      const h = Math.max(0, Math.min(Math.floor(D / 2), outSeg.frames, inSeg.frames, handleOut, handleIn));
      if (h < 1) { warnings.push(`Transition between "${outSeg.clip.name}" and "${inSeg.clip.name}" dropped: not enough source handles.`); continue; }
      if (2 * h < D) warnings.push(`Transition between "${outSeg.clip.name}" and "${inSeg.clip.name}" shortened from ${D} to ${2 * h} frames (source handles).`);
      outSeg.extAfter = h;
      inSeg.extBefore = h;
      inSeg.transIn = { type: tr.type, frames: 2 * h };
    } else if (inSeg && !tr.outClipId) {
      if (inSeg.start + startF !== inSeg.clip.start) continue; // clip start is outside range
      inSeg.fadeIn = Math.min(D, inSeg.frames);
    } else if (outSeg && !tr.inClipId) {
      if (outSeg.start + outSeg.frames + startF !== clipEnd(outSeg.clip)) continue;
      outSeg.fadeOut = Math.min(D, outSeg.frames);
    }
  }
  // Guard: a clip cannot carry overlapping transitions on both ends.
  for (let i = 0; i < clipSegs.length; i++) {
    const s = clipSegs[i];
    if (s.extBefore + s.extAfter > s.frames) {
      const next = clipSegs[i + 1];
      warnings.push(`Transitions on both sides of "${s.clip.name}" overlap; the outgoing transition is dropped.`);
      s.extAfter = 0;
      if (next) { next.extBefore = 0; next.transIn = undefined; }
    }
  }

  // Interleave gaps so the track covers the whole range.
  const total = endF - startF;
  const segs: Seg[] = [];
  let pos = 0;
  for (const s of clipSegs) {
    if (s.start > pos) segs.push({ kind: 'gap', frames: s.start - pos });
    segs.push(s);
    pos = s.start + s.frames;
  }
  if (pos < total) segs.push({ kind: 'gap', frames: total - pos });
  return { track, segs };
}

// ---------------------------------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------------------------------

interface Ctx {
  seq: Sequence;
  settings: ExportSettings;
  W: number; H: number;
  fps: Rational;
  fd: number;
  SR: number;
  layout: string;
  inputs: string[][];    // per-input ffmpeg args
  chains: string[];
  warnings: string[];
  labelCounter: number;
  /** Absolute frame of the export range start. */
  rangeStartF: number;
  /** Input args key -> input index and the stream kinds already taken from it (V+A input sharing). */
  inputKeys: Map<string, { index: number; kinds: Set<'video' | 'audio'> }[]>;
}

function newLabel(ctx: Ctx, prefix: string): string { return `[${prefix}${ctx.labelCounter++}]`; }

/** Containers whose input seek (`-ss` before `-i`) is frame-exact in ffmpeg: no decoder pre-roll needed. */
const EXACT_SEEK_CONTAINERS = new Set(['mp4', 'mov', 'm4v', 'm4a', 'matroska', 'webm']);

/** Seconds of pre-roll decoded before the trim point (a small margin for exact containers, 1 s otherwise). */
function inputPreroll(m: MediaItem): number {
  const c = m.probe?.container;
  return c && EXACT_SEEK_CONTAINERS.has(c) ? 0.04 : 1;
}

/** Half a media frame (seconds) when the media has video; 0 otherwise. */
function halfMediaFrame(m: MediaItem): number {
  const f = m.probe?.video?.fps;
  const v = f && f.num > 0 && f.den > 0 ? f.num / f.den : 0;
  return v > 0 ? 0.5 / v : 0;
}

/**
 * Start of the video stream relative to the container start (seconds), when the probe recorded it
 * (`startTime` on the probed video stream, see electron/media/probe.ts); 0 otherwise.
 */
function videoStreamStart(m: MediaItem): number {
  const v = m.probe?.video as (VideoStreamInfo & { startTime?: number }) | undefined;
  const st = v?.startTime;
  return typeof st === 'number' && Number.isFinite(st) && st > 0 ? st : 0;
}

/** `PTS-x/TB` with a signed offset (x may be negative). */
function ptsMinus(x: number, ptsName = 'PTS'): string {
  return x >= 0 ? `${ptsName}-${sec(x)}/TB` : `${ptsName}+${sec(-x)}/TB`;
}

interface InputInfo {
  index: number;
  /** Container-relative source second the segment's media time starts at (transition handle included). */
  srcStart: number;
  /** Source seconds of the segment (timeline length * speed). */
  srcLen: number;
  /** Source seconds read before srcStart (half a media frame for the video frame choice). */
  lead: number;
}

/**
 * Adds (or reuses) an ffmpeg input for the segment and returns its index.
 *
 * Timestamps: every media input is opened with `-copyts -start_at_zero`, so decoded pts are
 * container-relative source seconds (pts - format start_time) whatever the container does on seek
 * (MPEG-TS does not rebase to the `-ss` point, M-02) and whatever each stream's own start is
 * (late audio/video keeps its offset, M-04). The filters then trim on those absolute source times.
 * `-ss` is only a decode shortcut: exact containers seek right before the trim point, others keep 1 s
 * of pre-roll (M-09). A linked video+audio pair with the same range shares one input.
 */
function addInput(ctx: Ctx, seg: ClipSeg, kind: 'video' | 'audio'): InputInfo {
  const totalFrames = seg.extBefore + seg.frames + seg.extAfter;
  const tlLen = totalFrames * ctx.fd;
  const srcLen = tlLen * seg.speed;
  if (seg.isImage && kind === 'video') {
    ctx.inputs.push(['-loop', '1', '-framerate', fpsStr(ctx.fps), '-t', sec(tlLen + 0.5), '-i', seg.media.path]);
    return { index: ctx.inputs.length - 1, srcStart: 0, srcLen: tlLen, lead: 0 };
  }
  const srcStart = Math.max(0, seg.srcStart - seg.extBefore * ctx.fd * seg.speed);
  // Same lead for video and audio so a linked pair produces identical input args (and shares the input).
  const lead = halfMediaFrame(seg.media);
  const from = Math.max(0, srcStart - lead);
  const seek = Math.max(0, from - inputPreroll(seg.media));
  const args: string[] = ['-copyts', '-start_at_zero'];
  if (seek > 0) args.push('-ss', sec(seek));
  args.push('-t', sec((srcStart - seek) + srcLen + 0.25), '-i', seg.media.path);
  const key = args.join('\u0000');
  const same = ctx.inputKeys.get(key) ?? [];
  const shared = same.find((e) => !e.kinds.has(kind));
  if (shared) {
    shared.kinds.add(kind);
    return { index: shared.index, srcStart, srcLen, lead };
  }
  ctx.inputs.push(args);
  const index = ctx.inputs.length - 1;
  same.push({ index, kinds: new Set([kind]) });
  ctx.inputKeys.set(key, same);
  return { index, srcStart, srcLen, lead };
}

/** Transform placement: returns the extra filters applied after the fit scale, or [] for identity. */
function transformFilters(ctx: Ctx, seg: ClipSeg): string[] {
  const t = seg.clip.transform;
  const { W, H } = ctx;
  const crop = t.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const cl = clamp01(crop.left), cr = clamp01(crop.right), ct = clamp01(crop.top), cb = clamp01(crop.bottom);
  const hasCrop = cl + cr > 0 || ct + cb > 0;
  let S = t.scale;
  if (!(S > 0) || !Number.isFinite(S)) { ctx.warnings.push(`Clip "${seg.clip.name}": invalid scale ${t.scale}; using 1.0.`); S = 1; }
  const rot = ((t.rotation % 360) + 360) % 360;
  const X = Math.round(t.x || 0), Y = Math.round(t.y || 0);
  const identity = !hasCrop && Math.abs(S - 1) < 1e-6 && rot === 0 && X === 0 && Y === 0;
  if (identity) return [`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`];

  const f: string[] = [];
  // Crop offset (the cropped region keeps its on-screen position).
  let ox = 0, oy = 0;
  if (hasCrop) {
    if (cl + cr >= 1 || ct + cb >= 1) { ctx.warnings.push(`Clip "${seg.clip.name}": crop removes the whole image.`); }
    f.push(`crop=w='max(2,trunc(iw*${num(1 - cl - cr)}/2)*2)':h='max(2,trunc(ih*${num(1 - ct - cb)}/2)*2)':x='iw*${num(cl)}':y='ih*${num(ct)}'`);
    const v = seg.media.probe?.video;
    if (v && v.width > 0 && v.height > 0) {
      const k = Math.min(W / v.width, H / v.height);
      ox = v.width * k * (cl - cr) / 2;
      oy = v.height * k * (ct - cb) / 2;
    }
  }
  if (Math.abs(S - 1) >= 1e-6) {
    f.push(`scale=w='max(2,trunc(iw*${num(S)}/2)*2)':h='max(2,trunc(ih*${num(S)}/2)*2)':flags=bicubic`);
    ox *= S; oy *= S;
  }
  if (rot !== 0) {
    const a = rot * Math.PI / 180;
    f.push(`rotate=a=${num(a)}:ow='ceil(rotw(${num(a)})/2)*2':oh='ceil(roth(${num(a)})/2)*2':c=black@0`);
    const rx = ox * Math.cos(a) - oy * Math.sin(a);
    const ry = ox * Math.sin(a) + oy * Math.cos(a);
    ox = rx; oy = ry;
  }
  const px = Math.round(ox + X), py = Math.round(oy + Y);
  // Place on a transparent canvas centered on the sequence frame, then crop the frame out of it.
  f.push(`pad=w='max(${W},ceil((iw+2*${Math.abs(px)})/2)*2+2)':h='max(${H},ceil((ih+2*${Math.abs(py)})/2)*2+2)':x='(ow-iw)/2+${px}':y='(oh-ih)/2+${py}':color=black@0`);
  f.push(`crop=${W}:${H}`);
  return f;
}

function clamp01(v: number): number { return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0; }

/** Builds the exact-length video stream for a clip segment. Returns its label. */
function videoSegment(ctx: Ctx, seg: ClipSeg): string {
  const totalFrames = seg.extBefore + seg.frames + seg.extAfter;
  const { index, srcStart, srcLen, lead } = addInput(ctx, seg, 'video');
  seg.input = index;
  const f: string[] = [];
  if (seg.isImage) {
    f.push(`trim=duration=${sec(srcLen + 0.25)}`, 'setpts=PTS-STARTPTS', `fps=${fpsStr(ctx.fps)}`, 'format=yuva420p');
  } else {
    // Frame choice = the editor's: timeline frame n shows the media frame covering
    // srcStart + n*fd*speed + 0.5/mediaFps (SequencePlayer seeks to frame centres). Keep frames from
    // half a media frame before the in-point and keep their sub-frame phase, biased by
    // c = 0.5/mediaFps - 0.5*fd*speed so that fps= (which keeps the last frame whose pts rounds to a slot)
    // picks exactly that frame (M-03). pts are container-relative (-copyts -start_at_zero, see addInput).
    const from = Math.max(0, srcStart - lead);
    // +1 µs: a frame starting exactly at the seek time belongs to that time (the editor model floors t*fps + 0.5).
    const c = lead > 0 ? lead - 0.5 * ctx.fd * seg.speed + 1e-6 : 0;
    // settb=AVTB first: setpts truncates to the stream time base (1/1000 in MKV, 1/120 in some MP4s), which
    // would move frames across fps slot boundaries.
    f.push(`trim=start=${sec(from)}:duration=${sec(srcStart - from + srcLen + 0.25)}`, 'settb=AVTB', `setpts=${ptsMinus(srcStart + c)}`);
    if (Math.abs(seg.speed - 1) > 1e-9) f.push(`setpts=PTS/${num(seg.speed)}`);
    // start_time=0 anchors slot 0 at the in-point; earlier frames are dropped and a stream that starts after
    // the in-point is padded with copies of its first frame...
    f.push(`fps=${fpsStr(ctx.fps)}:start_time=0`, 'format=yuva420p');
    // ...which are made transparent when the probe knows the video stream starts late (M-04: the gap shows
    // what is under the clip, like an empty timeline region).
    const vStart = videoStreamStart(seg.media);
    if (vStart > from + 1e-3) {
      const firstOut = (vStart - srcStart - c) / seg.speed;
      const hideBefore = firstOut - 0.5 * ctx.fd;
      if (hideBefore > 0) f.push(`lut=a=0:enable='lt(t,${sec(hideBefore)})'`);
    }
  }
  f.push(`scale=${ctx.W}:${ctx.H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic`);
  f.push(...transformFilters(ctx, seg));
  const op = seg.clip.transform.opacity;
  if (Number.isFinite(op) && op < 1) f.push(`lut=a='val*${num(Math.max(0, op))}'`);
  f.push(`tpad=stop=${totalFrames}:stop_mode=clone`, `trim=end_frame=${totalFrames}`, 'setpts=PTS-STARTPTS');
  if (seg.fadeIn) f.push(`fade=t=in:st=0:d=${sec(seg.fadeIn * ctx.fd)}`);
  if (seg.fadeOut) f.push(`fade=t=out:st=${sec((totalFrames - seg.fadeOut) * ctx.fd)}:d=${sec(seg.fadeOut * ctx.fd)}`);
  const label = newLabel(ctx, 'v');
  ctx.chains.push(`[${index}:v:0]${f.join(',')}${label}`);
  return label;
}

function videoGap(ctx: Ctx, frames: number): string {
  const label = newLabel(ctx, 'vg');
  ctx.chains.push(`color=c=black@0.0:s=${ctx.W}x${ctx.H}:r=${fpsStr(ctx.fps)}:d=${sec((frames + 1) * ctx.fd)},format=yuva420p,trim=end_frame=${frames}${label}`);
  return label;
}

/** Builds one full-range video track stream. Returns its label, or null when the track is empty. */
function videoTrack(ctx: Ctx, plan: TrackPlan): string | null {
  if (!plan.segs.some((s) => s.kind === 'clip')) return null;
  const parts: string[] = [];
  let run: { label: string; frames: number } | null = null;
  const flush = () => { if (run) { parts.push(run.label); run = null; } };
  for (const s of plan.segs) {
    if (s.kind === 'gap') { flush(); parts.push(videoGap(ctx, s.frames)); continue; }
    const label = videoSegment(ctx, s);
    const frames = s.extBefore + s.frames + s.extAfter;
    if (run && s.transIn) {
      const D = s.transIn.frames;
      const out = newLabel(ctx, 'x');
      const kind = s.transIn.type === 'dipToBlack' ? 'fadeblack' : 'fade';
      ctx.chains.push(`${run.label}${label}xfade=transition=${kind}:duration=${sec(D * ctx.fd)}:offset=${sec((run.frames - D) * ctx.fd)}${out}`);
      run = { label: out, frames: run.frames + frames - D };
    } else {
      flush();
      run = { label, frames };
    }
  }
  flush();
  const trackLabel = newLabel(ctx, 'tv');
  if (parts.length === 1) {
    // Integer timestamps in the frame time base: N*den/num/TB evaluated in floating point truncates to
    // N-1 for many N when TB is already den/num, which duplicated pts and dropped/doubled frames (M-01).
    ctx.chains.push(`${parts[0]}settb=${ctx.fps.den}/${ctx.fps.num},setpts=N${trackLabel}`);
  } else {
    ctx.chains.push(`${parts.join('')}concat=n=${parts.length}:v=1:a=0,settb=${ctx.fps.den}/${ctx.fps.num},setpts=N${trackLabel}`);
  }
  return trackLabel;
}

// ---------------------------------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------------------------------

function audioStreamIndex(seg: ClipSeg, warnings: string[]): number | null {
  const probe = seg.media.probe;
  const want = seg.clip.audioStream ?? seg.media.preferredAudioStream;
  if (probe) {
    if (probe.audio.length === 0) return null;
    if (want !== undefined && probe.audio.some((a) => a.index === want)) return want;
    if (want !== undefined) warnings.push(`Clip "${seg.clip.name}": audio stream ${want} not found in "${seg.media.name}"; using the first audio stream.`);
    return probe.audio[0].index;
  }
  return want ?? null;
}

function atempoChain(speed: number): string[] {
  // atempo accepts 0.5..100 per stage; chain stages within 0.5..2 for quality.
  const out: string[] = [];
  let remaining = speed;
  while (remaining > 2 + 1e-9) { out.push('atempo=2'); remaining /= 2; }
  while (remaining < 0.5 - 1e-9) { out.push('atempo=0.5'); remaining /= 0.5; }
  if (Math.abs(remaining - 1) > 1e-9) out.push(`atempo=${num(remaining)}`);
  return out;
}

function audioSegment(ctx: Ctx, seg: ClipSeg): string {
  const totalFrames = seg.extBefore + seg.frames + seg.extAfter;
  const lenSec = totalFrames * ctx.fd;
  const { index, srcStart, srcLen } = addInput(ctx, seg, 'audio');
  seg.input = index;
  const streamIdx = audioStreamIndex(seg, ctx.warnings);
  const inLabel = streamIdx === null ? `[${index}:a:0]` : `[${index}:${streamIdx}]`;
  const f: string[] = [];
  // Rebase to the in-point (not to the stream's first sample) and fill a late start with silence, so a
  // stream that starts after the container start keeps its offset (M-04). pts are container-relative.
  f.push(`atrim=start=${sec(srcStart)}:duration=${sec(srcLen + 0.25)}`, `asetpts=${ptsMinus(srcStart)}`, 'aresample=async=1:first_pts=0');
  if (Math.abs(seg.speed - 1) > 1e-9) f.push(...atempoChain(seg.speed));
  f.push(`aresample=${ctx.SR}`, `aformat=sample_fmts=fltp:channel_layouts=${ctx.layout}`);
  const a = seg.clip.audio;
  if (Number.isFinite(a.gain) && a.gain !== 0) f.push(`volume=${num(a.gain)}dB`);
  if (Number.isFinite(a.volume) && a.volume !== 1) f.push(`volume=${num(Math.max(0, a.volume))}`);
  // Fades are authored relative to the clip; the visible part is kept when the range clips the clip.
  const headCut = seg.start + ctx.rangeStartF - seg.clip.start; // frames of the clip hidden before the segment
  const tailCut = clipEnd(seg.clip) - (seg.start + seg.frames + ctx.rangeStartF);
  const fadeIn = Math.max(0, Math.min(totalFrames, (a.fadeIn || 0) - headCut));
  const fadeOut = Math.max(0, Math.min(totalFrames, (a.fadeOut || 0) - tailCut));
  if (fadeIn > 0) f.push(`afade=t=in:st=0:d=${sec(fadeIn * ctx.fd)}`);
  if (fadeOut > 0) f.push(`afade=t=out:st=${sec(lenSec - fadeOut * ctx.fd)}:d=${sec(fadeOut * ctx.fd)}`);
  if (seg.fadeIn) f.push(`afade=t=in:st=0:d=${sec(seg.fadeIn * ctx.fd)}`);
  if (seg.fadeOut) f.push(`afade=t=out:st=${sec(lenSec - seg.fadeOut * ctx.fd)}:d=${sec(seg.fadeOut * ctx.fd)}`);
  f.push(`apad=whole_dur=${sec(lenSec)}`, `atrim=duration=${sec(lenSec)}`, 'asetpts=PTS-STARTPTS');
  const label = newLabel(ctx, 'a');
  ctx.chains.push(`${inLabel}${f.join(',')}${label}`);
  return label;
}

function audioGap(ctx: Ctx, frames: number): string {
  const label = newLabel(ctx, 'ag');
  const d = frames * ctx.fd;
  ctx.chains.push(`anullsrc=r=${ctx.SR}:cl=${ctx.layout}:d=${sec(d + 0.1)},aformat=sample_fmts=fltp,atrim=duration=${sec(d)},asetpts=PTS-STARTPTS${label}`);
  return label;
}

function audioTrack(ctx: Ctx, plan: TrackPlan): string | null {
  if (!plan.segs.some((s) => s.kind === 'clip')) return null;
  const parts: string[] = [];
  let run: { label: string; frames: number } | null = null;
  const flush = () => { if (run) { parts.push(run.label); run = null; } };
  for (const s of plan.segs) {
    if (s.kind === 'gap') { flush(); parts.push(audioGap(ctx, s.frames)); continue; }
    const label = audioSegment(ctx, s);
    const frames = s.extBefore + s.frames + s.extAfter;
    if (run && s.transIn) {
      const D = s.transIn.frames;
      const out = newLabel(ctx, 'ax');
      ctx.chains.push(`${run.label}${label}acrossfade=d=${sec(D * ctx.fd)}:c1=tri:c2=tri${out}`);
      run = { label: out, frames: run.frames + frames - D };
    } else {
      flush();
      run = { label, frames };
    }
  }
  flush();
  const trackLabel = newLabel(ctx, 'ta');
  const vol = plan.track.volume;
  const post = Number.isFinite(vol) && vol !== 1 ? `,volume=${num(Math.max(0, vol))}` : '';
  if (parts.length === 1) {
    ctx.chains.push(`${parts[0]}asetpts=PTS-STARTPTS${post}${trackLabel}`);
  } else {
    ctx.chains.push(`${parts.join('')}concat=n=${parts.length}:v=0:a=1${post}${trackLabel}`);
  }
  return trackLabel;
}

// ---------------------------------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------------------------------

/** Range-relative SRT for the request's subtitles (sidecar or burn-in), or null when there are none. */
export function buildSubtitleSrt(req: ExportRequest, range?: { startF: number; endF: number }): string | null {
  const cues = req.subtitles;
  if (!cues || cues.length === 0) return null;
  const warnings: string[] = [];
  const { startF, endF } = range ?? resolveRange(req.sequence, req.settings, warnings);
  const s0 = framesToSeconds(startF, req.sequence.fps);
  const s1 = framesToSeconds(endF, req.sequence.fps);
  const out = cues
    .filter((c) => c.end > s0 && c.start < s1 && c.text.trim().length > 0)
    .map((c) => ({ start: Math.max(0, c.start - s0), end: Math.min(s1, c.end) - s0, text: c.text }))
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start);
  return out.length ? serializeSrt(out) : null;
}

// ---------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------

/**
 * Server-side file-name sanitizer (the dialog sanitizes too, but IPC callers may not): keep only the
 * last path component and strip characters illegal on common file systems (/ \\ : * ? " < > |,
 * control characters) and leading dots.
 */
export function sanitizeExportFileName(name: string): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  return cleaned || 'export';
}

/** Temp file ffmpeg writes to before the rename: `<out>.part.mp4`. */
export function exportPartPath(outputPath: string): string {
  return outputPath.replace(/\.mp4$/i, '') + '.part.mp4';
}

/** Sidecar subtitle path next to the output: `<out>.srt`. */
export function exportSidecarPath(outputPath: string): string {
  return outputPath.replace(/\.mp4$/i, '') + '.srt';
}

/** Temp file the sidecar is written to before its rename: `<out>.part.srt`. */
export function exportSidecarTempPath(outputPath: string): string {
  return outputPath.replace(/\.mp4$/i, '') + '.part.srt';
}

/** Output path for a request: outputDir/fileName with a .mp4 extension (file name sanitized to a basename). */
export function exportOutputPath(settings: ExportSettings): string {
  let name = sanitizeExportFileName(settings.fileName || 'export');
  if (!/\.mp4$/i.test(name)) name = name.replace(/\.(mov|mkv|m4v|avi)$/i, '') + '.mp4';
  return path.join(settings.outputDir, name);
}

function validateDimensions(W: number, H: number): void {
  if (!Number.isFinite(W) || !Number.isFinite(H)) throw new Error('Output dimensions are not valid numbers.');
  for (const [label, v] of [['width', W], ['height', H]] as const) {
    if (v < MIN_EXPORT_DIMENSION || v > MAX_EXPORT_DIMENSION) {
      throw new Error(`Output ${label} ${v} is out of range: dimensions must be between ${MIN_EXPORT_DIMENSION} and ${MAX_EXPORT_DIMENSION} pixels.`);
    }
    if (v % 2 !== 0) throw new Error(`Output ${label} ${v} must be an even number (required for yuv420p).`);
  }
}

/** True when an enabled clip on a rendered (non-muted / soloed) track overlaps [startF, endF). */
function hasEnabledClipInRange(seq: Sequence, startF: number, endF: number): boolean {
  return [...activeTracks(seq.videoTracks), ...activeTracks(seq.audioTracks)]
    .some((t) => t.clips.some((c) => c.enabled && c.start < endF && clipEnd(c) > startF));
}

/**
 * Refuse an export that would write over a project source asset: the output, its `.part` temp or the
 * sidecar `.srt` (and its temp) must not be a file the sequence reads from (ffmpeg would truncate the
 * source, and the final rename replaces it), nor any other media / proxy in `req.media` or path in
 * `req.protectedPaths` (bin media not on this timeline, imported subtitle files).
 */
function assertOutputNotASource(req: ExportRequest, outputPath: string, opts: RenderGraphOptions): void {
  const platform = opts.platform ?? process.platform;
  const fold = platform === 'win32' || platform === 'darwin';
  const canon = (p: string) => {
    let c: string;
    try { c = opts.canonicalPath ? opts.canonicalPath(p) : path.resolve(p); } catch { c = path.resolve(p); }
    return fold ? c.toLowerCase() : c;
  };
  const sources = new Map<string, string>();
  const add = (p: string | undefined, why: string) => {
    if (typeof p !== 'string' || !p) return;
    const k = canon(p);
    if (!sources.has(k)) sources.set(k, `${why} (${p})`);
  };
  const tracks = [...req.sequence.videoTracks, ...req.sequence.audioTracks];
  for (const t of tracks) {
    for (const c of t.clips) {
      const m = req.media[c.mediaId];
      if (m) for (const p of [m.path, m.proxy?.path]) add(p, 'used by the sequence');
    }
  }
  for (const m of Object.values(req.media)) if (m) for (const p of [m.path, m.proxy?.path]) add(p, 'a source file of the project');
  if (Array.isArray(req.protectedPaths)) for (const p of req.protectedPaths) add(p, 'a source file of the project');
  const outputs = [outputPath, exportPartPath(outputPath)];
  if (req.settings.exportSubtitleSidecar) outputs.push(exportSidecarPath(outputPath), exportSidecarTempPath(outputPath));
  for (const o of outputs) {
    const hit = sources.get(canon(o));
    if (hit) throw new Error(`Refusing to export to "${o}": that file is ${hit}. Choose a different file name or folder.`);
  }
}

export function buildRenderGraph(req: ExportRequest, opts: RenderGraphOptions = {}): RenderGraph {
  const { sequence: seq, media, settings } = req;
  const warnings: string[] = [];
  const fps = settings.fps && settings.fps.num > 0 && settings.fps.den > 0 ? settings.fps : seq.fps;
  if (fps.num * seq.fps.den !== seq.fps.num * fps.den) warnings.push(`Export frame rate ${fpsStr(fps)} differs from the sequence frame rate ${fpsStr(seq.fps)}; timing is computed at the sequence rate.`);
  const W = Math.round(Number(settings.width) || seq.width);
  const H = Math.round(Number(settings.height) || seq.height);
  validateDimensions(W, H);
  const SR = settings.sampleRate > 0 ? Math.round(settings.sampleRate) : seq.sampleRate || 48000;
  const channels = settings.audioChannels === 6 ? 6 : 2;
  const layout = channels === 6 ? '5.1' : 'stereo';

  let { startF, endF } = resolveRange(seq, settings, warnings);
  if (opts.range) {
    const r = opts.range;
    if (!Number.isInteger(r.startF) || !Number.isInteger(r.endF) || r.startF < startF || r.endF > endF || r.endF <= r.startF) {
      throw new Error(`Invalid export sub-range ${r.startF}..${r.endF} (export range is ${startF}..${endF}).`);
    }
    startF = r.startF; endF = r.endF;
  }
  const frameCount = endF - startF;
  if (frameCount <= 0) throw new Error('Nothing to export: the range is empty.');
  if (!opts.range && !hasEnabledClipInRange(seq, startF, endF)) throw new Error('Nothing enabled to export in the selected range');
  const wantVideo = opts.streams !== 'audio';
  const wantAudio = opts.streams !== 'video';
  assertOutputNotASource(req, exportOutputPath(settings), opts);
  const seqFd = seq.fps.den / seq.fps.num;
  const durationSec = frameCount * seqFd;

  const ctx: Ctx = {
    seq, settings, W, H, fps: seq.fps, fd: seqFd, SR, layout,
    inputs: [], chains: [], warnings, labelCounter: 0, rangeStartF: startF, inputKeys: new Map(),
  };

  // ---- Video
  const videoLabels: string[] = [];
  let subtitleContent: string | undefined;
  if (wantVideo) {
    for (const track of activeTracks(seq.videoTracks)) {
      const plan = collectTrackSegments(track, seq, media, startF, endF, 'video', warnings);
      const label = videoTrack(ctx, plan);
      if (label) videoLabels.push(label);
    }
    ctx.chains.push(`color=c=black:s=${W}x${H}:r=${fpsStr(seq.fps)}:d=${sec(durationSec + seqFd)},format=yuv420p,trim=end_frame=${frameCount},setpts=PTS-STARTPTS[vbase]`);
    let vcur = '[vbase]';
    videoLabels.forEach((lbl, i) => {
      const out = i === videoLabels.length - 1 ? '[vcomp]' : `[vc${i}]`;
      ctx.chains.push(`${vcur}${lbl}overlay=0:0:eof_action=pass:shortest=0${out}`);
      vcur = out;
    });
    const finalVideo: string[] = [];
    if (settings.burnSubtitles) {
      const srt = buildSubtitleSrt(req, opts.range ? { startF, endF } : undefined);
      if (srt) {
        subtitleContent = srt;
        if (opts.subtitleFilePath) finalVideo.push(`subtitles=filename=${escapeFilterPath(opts.subtitleFilePath)}`);
        else warnings.push('Subtitle burn-in requested but no subtitle file path was provided; subtitles are not burned in.');
      }
    }
    finalVideo.push('format=yuv420p');
    ctx.chains.push(`${vcur}${finalVideo.join(',')}[vout]`);
  }

  // ---- Audio
  if (wantAudio) {
    const audioLabels: string[] = [];
    for (const track of activeTracks(seq.audioTracks)) {
      const plan = collectTrackSegments(track, seq, media, startF, endF, 'audio', warnings);
      const label = audioTrack(ctx, plan);
      if (label) audioLabels.push(label);
    }
    // Exact sample count (chunked export: sample-exact chunk boundaries).
    const N = opts.audioSamples !== undefined ? Math.max(0, Math.round(opts.audioSamples)) : -1;
    const tail = N >= 0 ? `,apad=whole_len=${N},atrim=end_sample=${N}` : '';
    if (audioLabels.length === 0) {
      ctx.chains.push(`anullsrc=r=${SR}:cl=${layout}:d=${sec(durationSec + 0.1)},aformat=sample_fmts=fltp,atrim=duration=${sec(durationSec)},asetpts=PTS-STARTPTS${tail}[aout]`);
    } else if (audioLabels.length === 1) {
      ctx.chains.push(`${audioLabels[0]}aresample=${SR},aformat=sample_fmts=fltp:channel_layouts=${layout}${tail}[aout]`);
    } else {
      ctx.chains.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:normalize=0:duration=longest,aresample=${SR},aformat=sample_fmts=fltp:channel_layouts=${layout}${tail}[aout]`);
    }
  }

  // ---- Args
  const outputPath = exportOutputPath(settings);
  const inputArgs: string[] = [];
  for (const inp of ctx.inputs) inputArgs.push(...inp);
  const videoCodecArgs: string[] = [];
  const vcodec = settings.videoCodec === 'libx265' ? 'libx265' : 'libx264';
  videoCodecArgs.push('-c:v', vcodec, '-preset', settings.preset || 'medium');
  if (settings.qualityMode === 'bitrate' && settings.videoBitrateKbps > 0) {
    const kb = Math.round(settings.videoBitrateKbps);
    videoCodecArgs.push('-b:v', `${kb}k`, '-maxrate', `${kb}k`, '-bufsize', `${kb * 2}k`);
  } else {
    videoCodecArgs.push('-crf', String(Math.round(Number.isFinite(settings.crf) ? settings.crf : 18)));
  }
  if (vcodec === 'libx265') videoCodecArgs.push('-tag:v', 'hvc1');
  videoCodecArgs.push('-pix_fmt', 'yuv420p', '-r', fpsStr(seq.fps), '-fps_mode', 'cfr');
  const acodec = settings.audioCodec === 'ac3' ? 'ac3' : 'aac';
  const audioCodecArgs = ['-c:a', acodec, '-b:a', `${Math.round(settings.audioBitrateKbps || (channels === 6 ? 640 : 192))}k`, '-ar', String(SR), '-ac', String(channels)];

  const args: string[] = ['-hide_banner', '-nostdin', '-y', ...inputArgs];
  args.push('-filter_complex_script', FILTER_SCRIPT_TOKEN);
  if (wantVideo) args.push('-map', '[vout]');
  if (wantAudio) args.push('-map', '[aout]');
  if (wantVideo) args.push(...videoCodecArgs); else args.push('-vn');
  if (wantAudio) args.push(...audioCodecArgs); else args.push('-an');
  args.push('-movflags', '+faststart', '-t', sec(durationSec), '-f', 'mp4', outputPath);

  return {
    args, filterGraph: ctx.chains.join(';\n'), durationSec, frameCount, outputPath, warnings,
    subtitleContent, inputCount: ctx.inputs.length,
    inputArgs, videoCodecArgs, audioCodecArgs, sampleRate: SR, channels, startF, endF,
  };
}
