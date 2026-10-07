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
import type { ExportSettings, MediaItem, Rational, Sequence, VideoStreamInfo } from '@shared/model';
import type { ExportRequest } from '@shared/ipc';
import { clipEnd, sequenceDuration } from '@shared/timeline';
import { activeTracks, planTrackSegments, widenRangeForTransitions, type ClipSeg, type TrackPlan } from '@shared/exportPlan';
import { framesToSeconds, isValidFps } from '@shared/time';
import { serializeSrt } from '@shared/subtitles';
import { videoDisplaySize } from '@shared/media';
import { audioStreamInfo, channelPanFilter, channelSelectionLabel, channelSelectionProblem } from '@shared/audioChannels';

/** Placeholder in `args` for the path of the filter script file (see exporter.ts). */
export const FILTER_SCRIPT_TOKEN = '__FILTER_SCRIPT__';

export interface RenderGraph {
  /** Complete ffmpeg args (without the binary). Contains `-filter_complex_script FILTER_SCRIPT_TOKEN`. */
  args: string[];
  /** The filter_complex graph (chains separated by ";\n"). */
  filterGraph: string;
  /** Exact output duration in seconds (= range length at the sequence rate; the audio is exactly this long). */
  durationSec: number;
  /** Sequence frames rendered (`endF - startF`). Equals `outputFrameCount` when the output rate is the sequence rate. */
  frameCount: number;
  /** Output video frame rate: settings.fps when valid, otherwise the sequence rate. */
  outputFps: Rational;
  /**
   * Exact output video frame count. With a different output rate this is
   * `outputFrameIndex(endF - exportStart) - outputFrameIndex(startF - exportStart)` (absolute, so chunks add up).
   */
  outputFrameCount: number;
  /** Duration of the output video stream (`outputFrameCount / outputFps`; `durationSec` at the sequence rate). */
  outputDurationSec: number;
  /**
   * Final output path (absolute outputDir/fileName.mp4). This is the last element of `args`; the exporter runs
   * ffmpeg on a `file:` URL of a temp next to it instead (exporter.ts).
   */
  outputPath: string;
  warnings: string[];
  /** SRT content to burn in (range-relative), present when settings.burnSubtitles and cues exist in range. */
  subtitleContent?: string;
  /** Output chapters (the sequence's Chapter markers in the range); empty for a sub-range (chunk) graph. */
  chapters: ExportChapter[];
  /**
   * FFMETADATA1 file content for `chapters`, present when there are chapters. With `chaptersFilePath` the file is
   * the last input (`-f ffmetadata -i <path>`) and `-map_chapters` reads it.
   */
  chaptersContent?: string;
  /** Number of media inputs (the chapters file is not counted): one per rendered clip segment, except that a video and an audio segment with identical input args (a linked V+A pair) share one. */
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
  /**
   * @deprecated No effect: output and source paths are compared case-folded on every platform (Linux mounts
   * case-insensitive volumes too: exFAT, vfat, CIFS, ext4 casefold). Kept so existing callers still compile.
   */
  platform?: NodeJS.Platform;
  /**
   * What is at a path, or null when nothing is (exporter: fs.statSync(p, { bigint: true })). When given, the
   * output and sidecar are also refused when they are a folder, when they are the same file as a project source
   * (same `id`: hard link, case-insensitive volume, any alias realpath misses) and, unless `req.overwrite`, when
   * they already exist (ExportOutputExistsError). Without it buildRenderGraph does no file-system I/O.
   */
  statPath?: (p: string) => ExportPathStat | null;
  /**
   * Render only this sub-range `[startF, endF)` (absolute sequence frames, inside the request's range).
   * Used by chunked export (exporter.ts); burn-in subtitles become relative to the sub-range.
   * The "nothing enabled in range" check is skipped (a chunk may be all gap).
   */
  range?: { startF: number; endF: number };
  /** Path of the FFMETADATA file the caller wrote `chaptersContent` to; enables chapters in the output. */
  chaptersFilePath?: string;
  /** Build only the video (`[vout]`) or only the audio (`[aout]`) part of the graph. Default: both. */
  streams?: 'video' | 'audio';
  /** Make `[aout]` exactly this many samples long (padded with silence / trimmed). */
  audioSamples?: number;
}

/** Result of RenderGraphOptions.statPath. */
export interface ExportPathStat {
  /** File identity (`dev:ino`); undefined when the file system has no stable one (ino 0). */
  id?: string;
  isDirectory: boolean;
}

/** The output or sidecar already exists and the request does not say `overwrite` (ExportStartResult code 'exists'). */
export class ExportOutputExistsError extends Error {
  readonly code = 'exists' as const;
  constructor(readonly path: string) {
    super(`"${path}" already exists.`);
    this.name = 'ExportOutputExistsError';
  }
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

function sameRate(a: Rational, b: Rational): boolean {
  return BigInt(a.num) * BigInt(b.den) === BigInt(b.num) * BigInt(a.den);
}

function gcd(a: number, b: number): number { while (b) { [a, b] = [b, a % b]; } return a; }

/**
 * Output frame-rate conversion: index of the first output frame at or after sequence frame `relFrame`
 * (counted from the export range start), i.e. `round(relFrame * outFps / seqFps)`, rounding halves up.
 * This is FFmpeg's `fps` filter rounding (av_rescale_q_rnd, NEAR_INF) of a frame at pts `relFrame` in the
 * sequence time base, so output frame n shows the last sequence frame i with outputFrameIndex(i) <= n: the
 * sequence frame on screen at the middle of output frame n. Exact integer maths (BigInt).
 */
export function outputFrameIndex(relFrame: number, seqFps: Rational, outFps: Rational): number {
  if (!Number.isSafeInteger(relFrame)) throw new Error(`Output frame index: frame ${relFrame} is not a whole number of frames.`);
  for (const f of [seqFps, outFps]) {
    if (!Number.isSafeInteger(f.num) || !Number.isSafeInteger(f.den) || f.num <= 0 || f.den <= 0) {
      throw new Error(`Output frame index: frame rate ${f.num}/${f.den} is not valid.`);
    }
  }
  const n = BigInt(relFrame) * BigInt(seqFps.den) * BigInt(outFps.num);
  const d = BigInt(seqFps.num) * BigInt(outFps.den);
  // floor((2n + d) / 2d): BigInt division truncates toward zero, so step down for negative non-exact quotients.
  const a = 2n * n + d, b = 2n * d;
  const q = a / b;
  return Number(a % b !== 0n && a < 0n ? q - 1n : q);
}

/**
 * Escape a file path for use as a filter option value inside a filtergraph string.
 * Two parsing levels apply (graph level and option level), each consuming `\` escapes and quotes.
 */
export function escapeFilterPath(p: string): string {
  const option = p.replace(/[\\':]/g, (m) => '\\' + m);          // option-level: \ ' :
  return option.replace(/[\\'\[\],;]/g, (m) => '\\' + m);         // graph-level: \ ' [ ] , ;
}

/**
 * Whether a still can be opened with `-loop 1` (the image2 demuxer and its `*_pipe` variants accept it). Unprobed
 * stills keep the loop input (an image file by extension, usually image2).
 */
function loopableStill(m: MediaItem): boolean {
  const c = (m.probe?.container ?? '').toLowerCase();
  return !c || c === 'image2' || c.startsWith('image2') || /_pipe$/.test(c);
}

/** The tracks an export renders (shared/exportPlan.ts; electron/export/chunks.ts imports it from here). */
export { activeTracks };

/** Longest export accepted (seconds): anything longer is a corrupt In/Out point or clip position. */
export const MAX_EXPORT_SECONDS = 24 * 3600;
function resolveRange(seq: Sequence, settings: ExportSettings, warnings: string[]): { startF: number; endF: number } {
  const check = (r: { startF: number; endF: number }) => {
    if (!Number.isSafeInteger(r.startF) || !Number.isSafeInteger(r.endF)) {
      throw new Error(`The export range ${String(r.startF)}..${String(r.endF)} is not valid: check the In/Out points and clip positions.`);
    }
    const sec = framesToSeconds(r.endF - r.startF, seq.fps);
    if (sec > MAX_EXPORT_SECONDS) {
      throw new Error(`The export range is too long (${Math.round(sec / 3600)} h; the maximum is ${MAX_EXPORT_SECONDS / 3600} h): check the In/Out points and clip positions.`);
    }
    return r;
  };
  const total = sequenceDuration(seq);
  if (settings.rangeMode === 'inOut') {
    const i = seq.view.inPoint, o = seq.view.outPoint;
    if (i !== null && o !== null && o > i) return check({ startF: Math.max(0, Math.round(i)), endF: Math.round(o) });
    warnings.push('In/Out range is not set or empty; exporting the entire sequence instead.');
  }
  if (total <= 0) throw new Error('Nothing to export: the sequence is empty.');
  return check({ startF: 0, endF: total });
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
    // `-loop` is an image2-family demuxer option: a still in another container (AVIF / HEIC demux as mov, a GIF as
    // gif) fails with "Option loop not found". Those decode their one picture and videoSegment's tpad holds it.
    ctx.inputs.push(loopableStill(seg.media)
      ? ['-loop', '1', '-framerate', fpsStr(ctx.fps), '-t', sec(tlLen + 0.5), '-i', seg.media.path]
      : ['-i', seg.media.path]);
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
    const d = fitInputSize(seg.media.probe?.video);
    if (d) {
      // The crop runs on the fitted picture (display shape, see fitFilters), so the offset uses that size.
      const k = Math.min(W / d.w, H / d.h);
      ox = d.w * k * (cl - cr) / 2;
      oy = d.h * k * (ct - cb) / 2;
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
  // The even-rounding crop / scale above leave a non-square SAR, which concat and xfade refuse to join (D1).
  f.push(`crop=${W}:${H}`, 'setsar=1');
  return f;
}

function clamp01(v: number): number { return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0; }

/**
 * Size of a probed video stream as fitFilters' fit scale receives it: the display axes un-squeezed by the sample
 * aspect ratio, rounded like the first scale in fitFilters (shared/media.ts videoDisplaySize, 'filter' mode).
 * Null when unknown.
 */
function fitInputSize(v: VideoStreamInfo | undefined): { w: number; h: number } | null {
  const d = videoDisplaySize(v, 'filter');
  return d && { w: d.width, h: d.height };
}

/**
 * Fit the source into the W x H frame (letterbox / pillarbox), with square pixels.
 *
 * Non-square pixels (anamorphic DVD / HDV, SAR from the stream) are first un-squeezed to their display shape
 * (the editor preview draws the video element, whose size is the display size), widening when SAR > 1 and
 * heightening when SAR < 1; a square-pixel source passes through that scale untouched. The fit scale rounds to
 * even sizes, which changes the SAR slightly: `setsar=1` keeps every segment, gap and transition input at SAR 1
 * (concat and xfade fail on mismatched SARs, D1).
 */
function fitFilters(ctx: Ctx): string[] {
  return [
    "scale=w='if(gt(sar,1.000001),max(2,round(iw*sar/2)*2),iw)':h='if(lt(sar,0.999999),max(2,round(ih/sar/2)*2),ih)':flags=bicubic",
    'setsar=1',
    `scale=${ctx.W}:${ctx.H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic`,
    'setsar=1',
  ];
}

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
  f.push(...fitFilters(ctx));
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

/**
 * The `pan` filter of a clip's channel selection for the export's channel layout, or null for the stream's normal
 * mix. A selection the stream cannot honour falls back to the normal mix with a warning (sequenceExportWarnings says
 * the same before the export).
 */
function clipChannelPan(ctx: Ctx, seg: ClipSeg, streamIdx: number | null): string | null {
  const sel = seg.clip.audio.channelSelection;
  if (!sel) return null;
  const stream = audioStreamInfo(seg.media.probe?.audio, streamIdx);
  const pan = channelPanFilter(sel, stream, ctx.layout);
  if (!pan) {
    const why = stream ? channelSelectionProblem(sel, stream) : 'the source has no probed audio stream';
    ctx.warnings.push(`Clip "${seg.clip.name}": ${channelSelectionLabel(sel)} cannot be used (${why}); exporting the stream's normal mix.`);
  }
  return pan;
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
  // Channel selection (Roadmap §9): one source channel as mono, or a controlled stereo downmix, picked from the
  // stream before anything else. The preview's channel proxy is made with this same filter (channelProxy.ts).
  const pan = clipChannelPan(ctx, seg, streamIdx);
  if (pan) f.push(pan);
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
// Chapters and metadata
// ---------------------------------------------------------------------------------------------------

/** One output chapter, in seconds from the start of the export (sequence timeline time). */
export interface ExportChapter {
  start: number;
  end: number;
  title: string;
}

/**
 * The output chapters of `[startF, endF)`: the sequence's Chapter markers (kind 'chapter'; other kinds are editor
 * notes), relative to the range start. A chapter marker at or before `startF` covers the range start (the latest
 * one wins); markers at or after `endF` are dropped. When no chapter marker is at or before `startF`, an untitled
 * leading chapter runs from 0 to the first marker, so that marker's break is kept: MP4 chapter text tracks cannot
 * leave a gap before the first chapter (FFmpeg reads such a file back with the first chapter at 0). Each chapter
 * ends where the next one starts, the last at `endSec` (the output duration). Two markers on one frame: the later
 * one in the marker list wins. Times are sequence time, so an output frame-rate conversion does not move them.
 */
export function exportChapters(seq: Pick<Sequence, 'markers' | 'fps'>, startF: number, endF: number, endSec: number): ExportChapter[] {
  const marks = (Array.isArray(seq.markers) ? seq.markers : [])
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m && m.kind === 'chapter' && Number.isFinite(m.time) && m.time < endF)
    .sort((a, b) => a.m.time - b.m.time || a.i - b.i);
  const starts: { f: number; title: string }[] = [];
  for (const { m } of marks) {
    const f = Math.max(startF, Math.round(m.time));
    if (f >= endF) continue;
    const title = typeof m.name === 'string' ? m.name : String(m.name ?? '');
    if (starts.length && starts[starts.length - 1].f === f) starts[starts.length - 1].title = title;
    else starts.push({ f, title });
  }
  if (starts.length && starts[0].f > startF) starts.unshift({ f: startF, title: '' });
  return starts.map((c, i) => ({
    start: i === 0 ? 0 : framesToSeconds(c.f - startF, seq.fps),
    end: i + 1 < starts.length ? framesToSeconds(starts[i + 1].f - startF, seq.fps) : endSec,
    title: c.title,
  }));
}

/**
 * A value for an FFMETADATA1 file: `=`, `;`, `#`, `\` and line breaks are backslash-escaped, NULs removed.
 * Trailing backslashes are dropped: FFmpeg's reader (6.1 to 9.0) takes a line break after an escaped backslash
 * as escaped, so a value cannot end in a backslash.
 */
export function ffmetadataEscape(value: string): string {
  return value.replace(/\0/g, '').replace(/\\+$/, '').replace(/[=;#\\\n\r]/g, (c) => `\\${c}`);
}

/** FFMETADATA1 file content with `chapters` (no global tags), times in microseconds. */
export function ffmetadataChapters(chapters: ExportChapter[]): string {
  const us = (s: number) => String(Math.max(0, Math.round(s * 1e6)));
  return ';FFMETADATA1\n' + chapters.map((c) =>
    `[CHAPTER]\nTIMEBASE=1/1000000\nSTART=${us(c.start)}\nEND=${us(c.end)}\ntitle=${ffmetadataEscape(c.title)}\n`).join('');
}

/**
 * Output metadata args: no global or stream metadata from any input (FFmpeg copies the first input's title,
 * comment, ... and its chapters by default), and chapters only from input `chaptersInput` (the FFMETADATA file),
 * or none. `-map_metadata -1` is not used because it also drops the chapter titles of `-map_chapters`.
 */
export function outputMetadataArgs(chaptersInput: number | null): string[] {
  return ['-map_metadata:g', '-1', '-map_metadata:s', '-1', '-map_chapters', chaptersInput === null ? '-1' : String(chaptersInput)];
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

/**
 * Temp file ffmpeg writes to before the rename: `<out>.recut-part-<token>.mp4`. The exporter picks a random token
 * and creates the file exclusively, so the temp is never a file that existed before (a user's file, a hard link).
 */
export function exportPartPath(outputPath: string, token: string): string {
  return `${outputPath.replace(/\.mp4$/i, '')}.recut-part-${token}.mp4`;
}

/** Sidecar subtitle path next to the output: `<out>.srt`. */
export function exportSidecarPath(outputPath: string): string {
  return outputPath.replace(/\.mp4$/i, '') + '.srt';
}

/** Temp file the sidecar is written to (exclusively, random token) before its rename: `<out>.recut-part-<token>.srt`. */
export function exportSidecarTempPath(outputPath: string, token: string): string {
  return `${outputPath.replace(/\.mp4$/i, '')}.recut-part-${token}.srt`;
}

/**
 * Output path for a request: outputDir/fileName with a .mp4 extension (file name sanitized to a basename).
 * The folder must be absolute: a relative one would resolve against the main process cwd for Node while ffmpeg
 * reads a prefix such as `tee:`, `concat:` or `pipe:` as a protocol, bypassing the source-file check.
 */
export function exportOutputPath(settings: ExportSettings): string {
  const dir = typeof settings.outputDir === 'string' ? settings.outputDir : '';
  if (!path.isAbsolute(dir)) {
    throw new Error(`The output folder must be an absolute path (a full path such as ${process.platform === 'win32' ? 'C:\\Videos' : '/home/me/Videos'}); got "${dir}".`);
  }
  let name = sanitizeExportFileName(settings.fileName || 'export');
  if (!/\.mp4$/i.test(name)) name = name.replace(/\.(mov|mkv|m4v|avi)$/i, '') + '.mp4';
  return path.resolve(dir, name);
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
 * Refuse an export that would write over a project source asset: the output or the sidecar `.srt` must not be a
 * file the sequence reads from (the final rename would replace it), nor any other media / proxy in `req.media` or
 * path in `req.protectedPaths` (bin media not on this timeline, imported subtitle files). Paths are compared
 * canonicalized and case-folded on every platform (refusing a case variant on a case-sensitive volume is harmless).
 * The temps (`exportPartPath` / `exportSidecarTempPath`) are random names created exclusively by the exporter, so
 * they can never be an existing file. With `opts.statPath` (exporter) also refuses: an output / sidecar that is a
 * folder, one that is the same file as a source (hard link, alias), and an existing one unless `req.overwrite`.
 */
function assertOutputNotASource(req: ExportRequest, outputPath: string, opts: RenderGraphOptions): void {
  const canon = (p: string) => {
    let c: string;
    try { c = opts.canonicalPath ? opts.canonicalPath(p) : path.resolve(p); } catch { c = path.resolve(p); }
    return c.toLowerCase();
  };
  const sources = new Map<string, { path: string; why: string }>();
  const add = (p: string | undefined, why: string) => {
    if (typeof p !== 'string' || !p) return;
    const k = canon(p);
    if (!sources.has(k)) sources.set(k, { path: p, why });
  };
  const describe = (s: { path: string; why: string }) => `${s.why} (${s.path})`;
  const tracks = [...req.sequence.videoTracks, ...req.sequence.audioTracks];
  for (const t of tracks) {
    for (const c of t.clips) {
      const m = Object.hasOwn(req.media, c.mediaId) ? req.media[c.mediaId] : undefined; // "constructor" etc. are not media
      if (m) for (const p of [m.path, m.proxy?.path]) add(p, 'used by the sequence');
    }
  }
  for (const m of Object.values(req.media)) if (m) for (const p of [m.path, m.proxy?.path]) add(p, 'a source file of the project');
  if (Array.isArray(req.protectedPaths)) for (const p of req.protectedPaths) add(p, 'a source file of the project');
  const outputs = [outputPath];
  if (req.settings.exportSubtitleSidecar) outputs.push(exportSidecarPath(outputPath));
  for (const o of outputs) {
    const hit = sources.get(canon(o));
    if (hit) throw new Error(`Refusing to export to "${o}": that file is ${describe(hit)}. Choose a different file name or folder.`);
  }

  if (!opts.statPath) return;
  const stat = (p: string): ExportPathStat | null => { try { return opts.statPath!(p); } catch { return null; } };
  // The sidecar is only written when there are cues to write.
  const written = req.settings.exportSubtitleSidecar && req.subtitles?.length ? outputs : [outputPath];
  const existing = written.map((o) => ({ o, st: stat(o) })).filter((e): e is { o: string; st: ExportPathStat } => e.st !== null);
  for (const { o, st } of existing) {
    if (st.isDirectory) throw new Error(`Cannot export to "${o}": "${o}" is a folder. Choose a different file name or folder.`);
  }
  if (existing.some((e) => e.st.id !== undefined)) {
    const byId = new Map<string, { path: string; why: string }>();
    for (const s of sources.values()) {
      const id = stat(s.path)?.id;
      if (id !== undefined && !byId.has(id)) byId.set(id, s);
    }
    for (const { o, st } of existing) {
      const hit = st.id !== undefined ? byId.get(st.id) : undefined;
      if (hit) throw new Error(`Refusing to export to "${o}": that is the same file as ${describe(hit)} (a hard link or another name for it). Choose a different file name or folder.`);
    }
  }
  if (!req.overwrite && existing.length) throw new ExportOutputExistsError(existing[0].o);
}

/** Sample rates the FFmpeg AC-3 encoder accepts. */
const AC3_SAMPLE_RATES = [32000, 44100, 48000];

/**
 * Burn-in SRT for `[startF, endF)` (relative to startF). Cues are snapped to the sequence frames the editor shows
 * them on (start frame inclusive, end frame exclusive) and written at frame midpoints, half a frame before those
 * frames: libass picks cues by frame time in whole milliseconds, so exact frame times (rounded to the nearest
 * millisecond in the SRT) showed or hid about half the cue edges one frame late or early (D3). Burn-in runs on the
 * sequence-rate frames, before any output frame-rate conversion. The sidecar keeps exact times (buildSubtitleSrt).
 */
function buildBurnInSrt(req: ExportRequest, startF: number, endF: number): string | null {
  const cues = req.subtitles;
  if (!cues || cues.length === 0) return null;
  const { num, den } = req.sequence.fps;
  const fd = den / num;
  const out = cues
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.text.trim().length > 0)
    .map((c) => ({ a: Math.max(startF, Math.round((c.start * num) / den)), b: Math.min(endF, Math.round((c.end * num) / den)), text: c.text }))
    .filter((c) => c.b > c.a)
    .sort((x, y) => x.a - y.a)
    .map((c) => ({ start: Math.max(0, (c.a - startF - 0.5) * fd), end: (c.b - startF - 0.5) * fd, text: c.text }));
  return out.length ? serializeSrt(out) : null;
}

export function buildRenderGraph(req: ExportRequest, opts: RenderGraphOptions = {}): RenderGraph {
  const { sequence: seq, media, settings } = req;
  const warnings: string[] = [];
  // Output frame rate. Everything on the timeline (trims, transitions, fades, subtitles, audio) is computed at
  // the sequence rate; a different output rate only resamples the final video (see the end of the video graph).
  let outFps: Rational = seq.fps;
  const reqFps = settings.fps as Rational | null | undefined; // IPC input: may be missing or malformed
  if (reqFps !== undefined && reqFps !== null) {
    if (!isValidFps(reqFps)) {
      const bad = reqFps as Rational;
      warnings.push(`Export frame rate ${String(bad.num)}/${String(bad.den)} is not valid; using the sequence frame rate ${fpsStr(seq.fps)}.`);
    } else if (!sameRate(reqFps, seq.fps)) {
      const g = gcd(reqFps.num, reqFps.den);
      outFps = { num: reqFps.num / g, den: reqFps.den / g };
    }
  }
  const convert = outFps !== seq.fps;
  const W = Math.round(Number(settings.width) || seq.width);
  const H = Math.round(Number(settings.height) || seq.height);
  validateDimensions(W, H);
  let SR = settings.sampleRate > 0 ? Math.round(settings.sampleRate) : seq.sampleRate || 48000;
  if (settings.audioCodec === 'ac3' && !AC3_SAMPLE_RATES.includes(SR)) {
    // The AC-3 encoder only takes 32 / 44.1 / 48 kHz: fail-safe for IPC callers (the dialog validates this).
    const to = SR > 48000 ? 48000 : AC3_SAMPLE_RATES.find((r) => r >= SR) ?? 48000;
    warnings.push(`AC-3 audio supports 32, 44.1 and 48 kHz only; exporting at ${to} Hz instead of ${SR} Hz.`);
    SR = to;
  }
  const channels = settings.audioChannels === 6 ? 6 : 2;
  const layout = channels === 6 ? '5.1' : 'stereo';

  let { startF, endF } = resolveRange(seq, settings, warnings);
  const exportStartF = startF, exportEndF = endF;
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
  // Output frames [outStart, outStart + outputFrameCount) of the whole export (absolute, so the chunks of a
  // chunked export join with no drift).
  const outStart = convert ? outputFrameIndex(startF - exportStartF, seq.fps, outFps) : 0;
  let outputFrameCount = convert ? outputFrameIndex(endF - exportStartF, seq.fps, outFps) - outStart : frameCount;
  if (outputFrameCount <= 0) {
    if (startF !== exportStartF || endF !== exportEndF) throw new Error(`Export sub-range ${startF}..${endF} has no output frames at ${fpsStr(outFps)} fps.`);
    outputFrameCount = 1; // a range shorter than half an output frame still exports one frame
  }
  const outputDurationSec = convert ? outputFrameCount * (outFps.den / outFps.num) : durationSec;

  // Render [renderStartF, renderEndF) so no transition is cut by the range, then trim the composite (D2).
  const { startF: renderStartF, endF: renderEndF } = widenRangeForTransitions(seq, startF, endF);
  const lead = startF - renderStartF;
  const renderFrames = renderEndF - renderStartF;

  const ctx: Ctx = {
    seq, settings, W, H, fps: seq.fps, fd: seqFd, SR, layout,
    inputs: [], chains: [], warnings, labelCounter: 0, rangeStartF: renderStartF, inputKeys: new Map(),
  };

  // ---- Video
  const videoLabels: string[] = [];
  let subtitleContent: string | undefined;
  if (wantVideo) {
    for (const track of activeTracks(seq.videoTracks)) {
      const plan = planTrackSegments(track, seq, media, renderStartF, renderEndF, 'video', warnings);
      const label = videoTrack(ctx, plan);
      if (label) videoLabels.push(label);
    }
    ctx.chains.push(`color=c=black:s=${W}x${H}:r=${fpsStr(seq.fps)}:d=${sec((renderFrames + 1) * seqFd)},format=yuv420p,trim=end_frame=${renderFrames},setpts=PTS-STARTPTS[vbase]`);
    let vcur = '[vbase]';
    videoLabels.forEach((lbl, i) => {
      const out = i === videoLabels.length - 1 ? '[vcomp]' : `[vc${i}]`;
      ctx.chains.push(`${vcur}${lbl}overlay=0:0:eof_action=pass:shortest=0${out}`);
      vcur = out;
    });
    const finalVideo: string[] = [];
    if (renderFrames !== frameCount) finalVideo.push(`trim=start_frame=${lead}:end_frame=${lead + frameCount}`, 'setpts=PTS-STARTPTS');
    if (settings.burnSubtitles) {
      const srt = buildBurnInSrt(req, startF, endF);
      if (srt) {
        subtitleContent = srt;
        if (opts.subtitleFilePath) finalVideo.push(`subtitles=filename=${escapeFilterPath(opts.subtitleFilePath)}`);
        else warnings.push('Subtitle burn-in requested but no subtitle file path was provided; subtitles are not burned in.');
      }
    }
    finalVideo.push('format=yuv420p');
    if (convert) {
      // Output frame-rate conversion. Frames get their absolute sequence index (pts in 1/seqFps units), so
      // `fps` places output frame n on the last sequence frame i with round(i * out / seq) <= n (see
      // outputFrameIndex) whatever chunk renders it. Cloned frames past the end (at least one output frame's worth:
      // `fps` stops at the output slot of the end of its input, D4) let `fps` emit the last output frames; trim keeps
      // exactly outputFrameCount.
      const pad = Math.ceil((seq.fps.num * outFps.den) / (seq.fps.den * outFps.num)) + 1;
      finalVideo.push(
        `tpad=stop=${pad}:stop_mode=clone`, `settb=${seq.fps.den}/${seq.fps.num}`,
        `setpts=N${startF - exportStartF > 0 ? `+${startF - exportStartF}` : ''}`,
        `fps=fps=${fpsStr(outFps)}`, `trim=end_frame=${outputFrameCount}`, 'setpts=PTS-STARTPTS',
      );
    }
    ctx.chains.push(`${vcur}${finalVideo.join(',')}[vout]`);
  }

  // ---- Audio
  if (wantAudio) {
    const audioLabels: string[] = [];
    for (const track of activeTracks(seq.audioTracks)) {
      const plan = planTrackSegments(track, seq, media, renderStartF, renderEndF, 'audio', warnings);
      const label = audioTrack(ctx, plan);
      if (label) audioLabels.push(label);
    }
    // Exact sample count (chunked export: sample-exact chunk boundaries).
    const N = opts.audioSamples !== undefined ? Math.max(0, Math.round(opts.audioSamples)) : -1;
    const tail = N >= 0 ? `,apad=whole_len=${N},atrim=end_sample=${N}` : '';
    // Widened render (D2): keep the samples of [startF, endF).
    const sampleAt = (f: number) => Math.round((f * SR * seq.fps.den) / seq.fps.num);
    const cut = renderFrames !== frameCount ? `,atrim=start_sample=${sampleAt(lead)}:end_sample=${sampleAt(lead + frameCount)},asetpts=PTS-STARTPTS` : '';
    if (audioLabels.length === 0) {
      ctx.chains.push(`anullsrc=r=${SR}:cl=${layout}:d=${sec(durationSec + 0.1)},aformat=sample_fmts=fltp,atrim=duration=${sec(durationSec)},asetpts=PTS-STARTPTS${tail}[aout]`);
    } else if (audioLabels.length === 1) {
      ctx.chains.push(`${audioLabels[0]}aresample=${SR},aformat=sample_fmts=fltp:channel_layouts=${layout}${cut}${tail}[aout]`);
    } else {
      ctx.chains.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:normalize=0:duration=longest,aresample=${SR},aformat=sample_fmts=fltp:channel_layouts=${layout}${cut}${tail}[aout]`);
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
  videoCodecArgs.push('-pix_fmt', 'yuv420p', '-r', fpsStr(outFps), '-fps_mode', 'cfr');
  const acodec = settings.audioCodec === 'ac3' ? 'ac3' : 'aac';
  const audioCodecArgs = ['-c:a', acodec, '-b:a', `${Math.round(settings.audioBitrateKbps || (channels === 6 ? 640 : 192))}k`, '-ar', String(SR), '-ac', String(channels)];

  // A converted video can end up to half an output frame after the audio: never cut its last frame.
  const outputSec = wantVideo ? Math.max(durationSec, outputDurationSec) : durationSec;
  // Chapters: the whole export only (a chunked export writes them when joining the chunks, exporter.ts).
  const chapters = opts.range ? [] : exportChapters(seq, startF, endF, outputSec);
  const chaptersContent = chapters.length ? ffmetadataChapters(chapters) : undefined;
  let chaptersInput: number | null = null;
  const args: string[] = ['-hide_banner', '-nostdin', '-y', ...inputArgs];
  if (chaptersContent) {
    if (opts.chaptersFilePath) {
      args.push('-f', 'ffmetadata', '-i', opts.chaptersFilePath);
      chaptersInput = ctx.inputs.length;
    } else {
      warnings.push('Chapter markers present but no chapters file path was provided; chapters are not written.');
    }
  }
  args.push('-filter_complex_script', FILTER_SCRIPT_TOKEN);
  if (wantVideo) args.push('-map', '[vout]');
  if (wantAudio) args.push('-map', '[aout]');
  args.push(...outputMetadataArgs(chaptersInput));
  if (wantVideo) args.push(...videoCodecArgs); else args.push('-vn');
  if (wantAudio) args.push(...audioCodecArgs); else args.push('-an');
  args.push('-movflags', '+faststart', '-t', sec(outputSec), '-f', 'mp4', outputPath);

  return {
    args, filterGraph: ctx.chains.join(';\n'), durationSec, frameCount, outputFps: outFps, outputFrameCount, outputDurationSec, outputPath, warnings,
    subtitleContent, chapters, chaptersContent, inputCount: ctx.inputs.length,
    inputArgs, videoCodecArgs, audioCodecArgs, sampleRate: SR, channels, startF, endF,
  };
}
