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
import type { ExportContainer, ExportSettings, ID, Keyframe, MediaItem, Rational, Sequence, VideoStreamInfo } from '@shared/model';
import type { ExportRequest } from '@shared/ipc';
import { clipEnd, sequenceDuration } from '@shared/timeline';
import { activeTracks, planTrackSegments, widenRangeForTransitions, type ClipSeg, type TrackPlan } from '@shared/exportPlan';
import { framesToSeconds, isValidFps } from '@shared/time';
import { serializeSrt } from '@shared/subtitles';
import { flatOrigin, flattenSequence, flattenWarnings, trackGroupId } from '@shared/nest';
import { videoDisplaySize } from '@shared/media';
import { audioStreamInfo, channelPanFilter, channelSelectionLabel, channelSelectionProblem } from '@shared/audioChannels';
import { evaluateKeyframes, exprNum, hasMotionKeyframes, keyframeRange, keyframesExpr, keyframesOf, MIN_KEYFRAME_SCALE } from '@shared/keyframes';
import {
  audioEncoder, audioOutputPlan, audioStreamArgs, CONTAINERS, dispositionValue, DNXHR_MIN_HEIGHT, DNXHR_MIN_WIDTH, exportContainer, isPerTrackAudio,
  PER_TRACK_SKIP_REASON, perTrackAudioPlan, subtitleOutputPlan, supportsPackaging, usesAc3, videoEncoder, withExportExtension, workingLayout,
} from '@shared/exportFormat';

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
   * Final output path (absolute outputDir/fileName.<format extension>). This is the last element of `args`; the exporter runs
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
   * the input after the media inputs (`-f ffmetadata -i <path>`; MKV soft subtitle files follow it) and `-map_chapters` reads it.
   */
  chaptersContent?: string;
  /** Number of media inputs (the chapters file is not counted): one per rendered clip segment, except that a video and an audio segment with identical input args (a linked V+A pair) share one. */
  inputCount: number;
  /** The `-i` input args alone (flattened), as they appear in `args`. */
  inputArgs: string[];
  /** Video encoder args (`-c:v` .. `-fps_mode cfr`), as they appear in `args`; empty for an audio-only format. */
  videoCodecArgs: string[];
  /**
   * Audio encoder args (`-c:a` .. `-ac N`: AAC / AC-3, PCM or FLAC), as they appear in `args`. MKV: every output
   * track's args with stream specifiers (`-c:a:0 ac3 -b:a:0 640k -ac:a:0 6 -c:a:1 aac ...`) and one `-ar`.
   */
  audioCodecArgs: string[];
  /** Output audio sample rate and channel count (of the first output audio track). */
  sampleRate: number;
  channels: number;
  /**
   * The output audio streams in order: their graph label (`[aout]`, then `[aout1]`, `[aout2]`, ...), channel count and
   * description. One for every format but MKV with several output tracks (shared/exportFormat.ts audioOutputPlan).
   */
  audioOutputs: RenderAudioOutput[];
  /** MKV: soft subtitle streams (range-relative SRT); empty for other formats and for a sub-range (chunk) graph. */
  softSubtitles: SoftSubtitleStream[];
  /** Subtitle encoder args (`-c:s subrip`) when there are soft subtitles, as they appear in `args`. */
  subtitleCodecArgs: string[];
  /** MKV: per-stream language / title metadata and default / forced flags, as they appear in `args`. */
  streamArgs: string[];
  /** Rendered range in absolute sequence frames `[startF, endF)`. */
  startF: number;
  endF: number;
  /** Output file format (shared/exportFormat.ts). */
  container: ExportContainer;
  /** True when the output has no video stream (WAV / FLAC). */
  audioOnly: boolean;
  /** Muxer args (`-movflags +faststart`, `-rf64 auto`, ...) and the `-f` value, as they appear in `args`. */
  muxArgs: string[];
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
  /** Paths the caller wrote the `softSubtitles` contents to, in order; enables the soft subtitle streams (MKV). */
  softSubtitleFilePaths?: string[];
  /** Build only the video (`[vout]`) or only the audio (`[aout]`) part of the graph. Default: both. */
  streams?: 'video' | 'audio';
  /** Make `[aout]` exactly this many samples long (padded with silence / trimmed). */
  audioSamples?: number;
  /**
   * Per-track audio export: mix only this audio track into `[aout]` (it must be one the full export renders). The
   * range, its widening for transitions and every other timing are the full export's, so the per-track files line
   * up sample for sample with each other and with the mixed export.
   */
  audioTrackId?: ID;
}

/** One output audio stream of a render graph. */
export interface RenderAudioOutput {
  /** Filter graph label, `[aout]` for the first, `[aout1]`, `[aout2]`, ... for the others. */
  label: string;
  channels: number;
  /** `Track 2 "Commentary" (A3)` (shared/exportFormat.ts AudioOutputPlan.name). */
  name: string;
}

/** One soft subtitle stream (MKV): a sequence subtitle track's cues in the range, as SRT. */
export interface SoftSubtitleStream {
  trackId: ID;
  /** Range-relative SRT (exact cue times, like the sidecar). */
  content: string;
  language: string;
  title: string;
  isDefault: boolean;
  forced: boolean;
}

/** Label of output audio stream `i` in the filter graph. */
export function audioOutputLabel(i: number): string {
  return i === 0 ? '[aout]' : `[aout${i}]`;
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
  // The input covers the frames read but not shown too (ClipSeg readBefore / readAfter); the trims pick the segment.
  const readBefore = seg.readBefore ?? 0, readAfter = seg.readAfter ?? 0;
  const readStart = Math.max(0, srcStart - readBefore * ctx.fd * seg.speed);
  const readLen = srcLen + (readBefore + readAfter) * ctx.fd * seg.speed;
  const from = Math.max(0, readStart - lead);
  const seek = Math.max(0, from - inputPreroll(seg.media));
  const args: string[] = ['-copyts', '-start_at_zero'];
  if (seek > 0) args.push('-ss', sec(seek));
  args.push('-t', sec((readStart - seek) + readLen + 0.25), '-i', seg.media.path);
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
  // Keyframes (Roadmap §11): a clip with keyframed position / scale is placed per frame after the exact-length
  // trim (motionFilters), keyframed opacity is set per frame there too (opacityFilters); otherwise the static chain.
  const motion = hasMotionKeyframes(seg.clip);
  const opacityKeys = keyframesOf(seg.clip, 'opacity');
  const k0 = segmentClipFrame(ctx, seg);
  if (motion) f.push(...motionCanvasFilters(ctx, seg, k0, totalFrames));
  else f.push(...transformFilters(ctx, seg));
  const op = seg.clip.transform.opacity;
  const fades = fadeWeights(seg);
  if (!opacityKeys && !fades && Number.isFinite(op) && op < 1) f.push(`lut=a='val*${num(Math.max(0, op))}'`);
  f.push(`tpad=stop=${totalFrames}:stop_mode=clone`, `trim=end_frame=${totalFrames}`, 'setpts=PTS-STARTPTS');
  if (motion) f.push(...motionFilters(ctx, seg, k0, totalFrames));
  // Opacity (keyframed, or static with a fade) times the fade to / from black, as one alpha value per frame.
  if (opacityKeys || fades) {
    const opacityAt = (n: number) => clamp01(opacityKeys ? evaluateKeyframes(opacityKeys, k0 + n) : op);
    f.push(...opacityFilters(ctx, fades ? (n) => opacityAt(n) * fades(n) : opacityAt, totalFrames));
  }
  f.push(...dipFilters(seg));
  f.push(...envelopeFilters(ctx, seg, 'video', totalFrames));
  const label = newLabel(ctx, 'v');
  ctx.chains.push(`[${index}:v:0]${f.join(',')}${label}`);
  return label;
}

/**
 * Ramps of a clip of a flattened nested sequence (shared/nest.ts Envelope): alpha fades for video, gain fades for
 * audio, at absolute timeline frames (the preview planner multiplies the same ramps per frame). A ramp that starts
 * before the segment's first frame is applied on a stream padded at the front, then the padding is cut off again.
 */
function envelopeFilters(ctx: Ctx, seg: ClipSeg, kind: 'video' | 'audio', totalFrames: number): string[] {
  const o = flatOrigin(seg.clip);
  if (!o || o.env.length === 0) return [];
  const first = ctx.rangeStartF + seg.start - seg.extBefore; // absolute frame of the segment's first output frame
  const f: string[] = [];
  for (const e of o.env) {
    const a = e.from - first, b = e.to - first;
    if (!(b > a)) continue;
    if (e.dir > 0 ? b <= 0 : a >= totalFrames) continue; // the ramp is over (or not started) for the whole segment
    const t = e.dir > 0 ? 'in' : 'out';
    if (kind === 'video') {
      const pre = a < 0 ? Math.ceil(-a) : 0;
      if (pre) f.push(`tpad=start=${pre}:start_mode=clone`);
      f.push(`fade=t=${t}:st=${sec((a + pre) * ctx.fd)}:d=${sec((b - a) * ctx.fd)}:alpha=1`);
      if (pre) f.push(`trim=start_frame=${pre}`, 'setpts=PTS-STARTPTS');
    } else {
      const aSec = a * ctx.fd;
      const pre = aSec < 0 ? Math.ceil(-aSec * ctx.SR - 1e-9) : 0;
      if (pre) f.push(`adelay=delays=${pre}S:all=1`);
      f.push(`afade=t=${t}:st=${sec(aSec + pre / ctx.SR)}:d=${sec((b - a) * ctx.fd)}`);
      if (pre) f.push(`atrim=start_sample=${pre}`, 'asetpts=PTS-STARTPTS');
    }
  }
  return f;
}

// ---------------------------------------------------------------------------------------------------
// Keyframes (Roadmap §11): values per frame from shared/keyframes.ts, the same evaluation as the preview
// ---------------------------------------------------------------------------------------------------

/** Clip frame (shared/keyframes.ts) of the segment's first rendered frame (transition handle included). */
function segmentClipFrame(ctx: Ctx, seg: ClipSeg): number {
  return seg.start + ctx.rangeStartF - seg.clip.start - seg.extBefore;
}

/** Margin (pixels) the motion canvas keeps around the frame, so the picture's edge resamples to transparent. */
const MOTION_MARGIN = 4;

/**
 * Before the exact-length trim: the static crop, a down-scale to the largest scale the segment uses (when it is below
 * 100 %, so a small moving picture is filtered with bicubic, not resampled from full size), and a transparent canvas at
 * least the frame size plus a margin, with the picture exactly in its centre (its offsets are even, so 4:2:0 chroma
 * stays aligned). motionFilters then moves and scales it per frame.
 */
function motionCanvasFilters(ctx: Ctx, seg: ClipSeg, k0: number, totalFrames: number): string[] {
  const t = seg.clip.transform;
  const crop = t.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const cl = clamp01(crop.left), cr = clamp01(crop.right), ct = clamp01(crop.top), cb = clamp01(crop.bottom);
  const f: string[] = [];
  if (cl + cr > 0 || ct + cb > 0) {
    if (cl + cr >= 1 || ct + cb >= 1) ctx.warnings.push(`Clip "${seg.clip.name}": crop removes the whole image.`);
    f.push(`crop=w='max(2,trunc(iw*${num(1 - cl - cr)}/2)*2)':h='max(2,trunc(ih*${num(1 - ct - cb)}/2)*2)':x='iw*${num(cl)}':y='ih*${num(ct)}'`);
  }
  const k = motionPrescale(seg, k0, totalFrames);
  if (k < 1) f.push(`scale=w='max(2,trunc(iw*${exprNum(k)}/2)*2)':h='max(2,trunc(ih*${exprNum(k)}/2)*2)':flags=bicubic`, 'setsar=1');
  const padW = ctx.W + 2 * MOTION_MARGIN, padH = ctx.H + 2 * MOTION_MARGIN;
  f.push(`pad=w='iw+4*ceil((${padW}-iw)/4)':h='ih+4*ceil((${padH}-ih)/4)':x='2*ceil((${padW}-iw)/4)':y='2*ceil((${padH}-ih)/4)':color=black@0`);
  return f;
}

/** The pre-scale motionCanvasFilters applies: the largest animated scale over the segment, when below 1 (else 1). */
function motionPrescale(seg: ClipSeg, k0: number, totalFrames: number): number {
  const { max } = keyframeRange(seg.clip, 'scale', k0, k0 + totalFrames - 1);
  return Number.isFinite(max) && max > 0 && max < 0.999 ? Math.max(MIN_KEYFRAME_SCALE, max) : 1;
}

/**
 * After the exact-length trim: place the canvas per frame with `perspective` (sense=destination: the canvas corners
 * go to the given points; eval=frame), then cut the frame out of it. Sub-pixel exact (bilinear), like the canvas
 * preview, and frame-exact: perspective's frame counter `in` is 1 on the segment's first frame, so the clip frame is
 * `in-1+k0`. The corners follow the preview's geometry: the uncropped picture's centre at the frame centre plus
 * (x, y), scaled by `scale` and rotated by the (static) rotation about it, the crop keeping its place.
 */
function motionFilters(ctx: Ctx, seg: ClipSeg, k0: number, totalFrames: number): string[] {
  const clip = seg.clip;
  const t = clip.transform;
  const K = `(in-1${k0 >= 0 ? '+' : ''}${k0})`;
  const prop = (p: 'x' | 'y' | 'scale'): string => {
    const keys = keyframesOf(clip, p);
    if (keys) return `(${keyframesExpr(keys, K)})`;
    const v = t[p];
    if (p === 'scale') return exprNum(Number.isFinite(v) && v > 0 ? v : 1);
    return exprNum(Number.isFinite(v) ? v : 0);
  };
  const X = prop('x'), Y = prop('y'), S = prop('scale');
  // Crop offset: the cropped region's centre relative to the picture centre, in fitted pixels (as transformFilters).
  const crop = t.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const cl = clamp01(crop.left), cr = clamp01(crop.right), ct = clamp01(crop.top), cb = clamp01(crop.bottom);
  let ox = 0, oy = 0;
  const d = fitInputSize(seg.media.probe?.video);
  if (d && (cl + cr > 0 || ct + cb > 0)) {
    const kf = Math.min(ctx.W / d.w, ctx.H / d.h);
    ox = d.w * kf * (cl - cr) / 2;
    oy = d.h * kf * (ct - cb) / 2;
  }
  const rot = ((Number.isFinite(t.rotation) ? t.rotation : 0) % 360 + 360) % 360;
  const a = rot * Math.PI / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const rox = ox * cos - oy * sin, roy = ox * sin + oy * cos;
  // A canvas point p (from the canvas centre) lands at F + (X, Y) + S·(R·o + R·p / k), in area coordinates (a
  // pixel's centre at +0.5, as the canvas preview draws). perspective maps pixel indexes (a pixel at its index), so
  // the corner it is given for canvas corner c is that map at c + 0.5, minus 0.5: c ± W/2 becomes (±W + 1) / 2.
  const k = motionPrescale(seg, k0, totalFrames);
  const A = cos / (2 * k), B = sin / (2 * k);
  const fx = `(2*floor((W-${ctx.W})/4)+${(ctx.W - 1) / 2})`, fy = `(2*floor((H-${ctx.H})/4)+${(ctx.H - 1) / 2})`;
  const corner = (sx: number, sy: number): [string, string] => [
    `${fx}+${X}+${S}*(${exprNum(rox)}+${exprNum(A)}*(${sx}*W+1)-${exprNum(B)}*(${sy}*H+1))`,
    `${fy}+${Y}+${S}*(${exprNum(roy)}+${exprNum(B)}*(${sx}*W+1)+${exprNum(A)}*(${sy}*H+1))`,
  ];
  const [x0, y0] = corner(-1, -1), [x1, y1] = corner(1, -1), [x2, y2] = corner(-1, 1), [x3, y3] = corner(1, 1);
  return [
    `perspective=x0='${x0}':y0='${y0}':x1='${x1}':y1='${y1}':x2='${x2}':y2='${y2}':x3='${x3}':y3='${y3}':interpolation=linear:sense=destination:eval=frame`,
    `crop=w=${ctx.W}:h=${ctx.H}:x='2*floor((iw-${ctx.W})/4)':y='2*floor((ih-${ctx.H})/4)'`,
    'setsar=1',
  ];
}

/** A Dip to Black half that is not a whole number of frames (an odd length), else 0. */
function halfFrameDip(half: number | undefined): number {
  return half && half > 0 && !Number.isInteger(half) ? half : 0;
}

/**
 * The halves of a two-sided Dip to Black (ClipSeg dipIn / dipOut) that are a whole number of frames H: `fade` with
 * alpha=1 counting frames (start_frame, nb_frames) multiplies the alpha by k / H on frame k of the incoming clip's
 * first H, and by (H - k) / H on its last H, the planner's weights (src/playback/planner.ts contribute), so a dip shows
 * what is below the clip (black on V1). It leaves the frames outside the ramp untouched and keeps the graph short
 * (a lut + sendcmd ramp costs a command per frame). An odd length has half-frame ramps, which `fade` cannot place
 * (its time options round them); fadeWeights takes those into the per-frame lut.
 */
function dipFilters(seg: ClipSeg): string[] {
  const f: string[] = [];
  const whole = (h: number | undefined): h is number => !!h && h > 0 && Number.isInteger(h);
  if (whole(seg.dipIn)) f.push(`fade=t=in:start_frame=${seg.extBefore}:nb_frames=${seg.dipIn}:alpha=1`);
  if (whole(seg.dipOut)) f.push(`fade=t=out:start_frame=${Math.max(0, seg.extBefore + seg.frames - seg.dipOut)}:nb_frames=${seg.dipOut}:alpha=1`);
  return f;
}

/**
 * Fade from / to black of a single-sided transition (ClipSeg fadeIn / fadeOut), or a half-frame half of a Dip to
 * Black (dipIn / dipOut; whole ones are dipFilters): the weight of segment frame n, the preview planner's
 * (src/playback/planner.ts contribute): (frame - start) / D over the first D frames of the clip and (end - frame) / D
 * over its last D, multiplied. It scales the alpha, so the fade shows what is below the clip (black
 * on V1), as the preview draws it. Null when the segment has no fade. (FFmpeg's `fade` darkened the colour instead,
 * and towards luma 0, not 16: it treats yuva420p as full range.)
 */
function fadeWeights(seg: ClipSeg): ((n: number) => number) | null {
  // A dip half of a whole number of frames is a `fade` filter instead (dipFilters).
  const fadeIn = seg.fadeIn || halfFrameDip(seg.dipIn), fadeOut = seg.fadeOut || halfFrameDip(seg.dipOut);
  if (!(fadeIn > 0) && !(fadeOut > 0)) return null;
  const end = seg.extBefore + seg.frames;
  return (n) => {
    let w = 1;
    if (fadeIn > 0 && n - seg.extBefore < fadeIn) w *= (n - seg.extBefore) / fadeIn;
    if (fadeOut > 0 && n >= end - fadeOut) w *= (end - n) / fadeOut;
    return clamp01(w);
  };
}

/**
 * Per-frame opacity (keyframed opacity, fades): `lut` multiplies the alpha by `valueAt(n)` on segment frame n, set
 * per frame by `sendcmd` from values computed here with the preview's evaluation (no FFmpeg formula to keep in step).
 * A value is sent only when it changes by at least 1/1024 (the alpha is 8-bit), so a long fade sends at most about a
 * thousand commands.
 */
function opacityFilters(ctx: Ctx, valueAt: (n: number) => number, totalFrames: number): string[] {
  const name = `lut@kfo${ctx.labelCounter++}`;
  const q = (v: number) => Math.round(clamp01(v) * 1024) / 1024;
  const first = q(valueAt(0));
  const cmds: string[] = [];
  let last = first, startN = 0;
  // Interval [start, end) in segment seconds, half a frame early so a frame's own timestamp is inside it.
  const flush = (endN: number) => {
    if (startN > 0) cmds.push(`${sec((startN - 0.5) * ctx.fd)}-${sec((endN - 0.5) * ctx.fd)} ${name} a val*${exprNum(last)}`);
  };
  for (let n = 1; n < totalFrames; n++) {
    const v = q(valueAt(n));
    if (v === last) continue;
    flush(n);
    startN = n; last = v;
  }
  flush(totalFrames + 1);
  const out: string[] = [];
  if (cmds.length) out.push(`sendcmd=c='${cmds.join(';')}'`);
  out.push(`${name}=a='val*${exprNum(first)}'`);
  return out;
}

/** Samples per evaluation of keyframed level (5.3 ms at 48 kHz). */
export const LEVEL_BLOCK_SAMPLES = 256;

/**
 * Keyframed level: `volume` evaluated per block of LEVEL_BLOCK_SAMPLES samples (asetnsamples) at the block's middle,
 * from the keyframes' FFmpeg expression (shared/keyframes.ts keyframesExpr: the preview's formula). `t` is the
 * segment's time from its first sample (the chain re-stamps it just before), so the clip frame is t·fps + k0.
 * (`volume` has no usable `nb_samples` per frame, and `t` is NaN when it evaluates once at start-up: 0 then.)
 */
function levelFilters(ctx: Ctx, keys: readonly Keyframe[], k0: number): string[] {
  const k = `(if(isnan(t),0,t)+${LEVEL_BLOCK_SAMPLES / 2}/sample_rate)*${ctx.fps.num}/${ctx.fps.den}${k0 >= 0 ? '+' : ''}${k0}`;
  return [`asetnsamples=n=${LEVEL_BLOCK_SAMPLES}:p=0`, `volume=volume='st(0,${k});${keyframesExpr(keys, 'ld(0)')}':eval=frame`];
}

function videoGap(ctx: Ctx, frames: number): string {
  const label = newLabel(ctx, 'vg');
  ctx.chains.push(`color=c=black@0.0:s=${ctx.W}x${ctx.H}:r=${fpsStr(ctx.fps)}:d=${sec((frames + 1) * ctx.fd)},format=yuva420p,trim=end_frame=${frames}${label}`);
  return label;
}

/**
 * Cross Dissolve of two `D`-frame windows (the outgoing segment's last `D` frames, the incoming one's first `D`): the
 * linear mix `(1 - t) * out + t * in` with `t = k / D` on frame k, so the result composites over the tracks below as
 * `(1 - t) * (out over below) + t * (in over below)`, the preview's picture (src/playback/planner.ts LayerPlan.mixWith).
 * `xfade` mixes straight-alpha pixels, which is that mix only where the two alphas are equal; where they may differ
 * (`premultiply`: see windowAlpha) the windows are mixed premultiplied, in 4:4:4 (premultiply
 * needs the alpha at every chroma sample), only over the window's frames. In 16 bits: FFmpeg 9's 8-bit premultiply
 * is not the identity at alpha 255 (luma 235 became 234 and unpremultiply did not restore it), so an opaque pixel came
 * back a level dark; the 16-bit round trip returns the 8-bit values exactly on FFmpeg 6.1 and 9.0.
 */
function dissolveWindow(ctx: Ctx, tail: string, head: string, D: number, premultiply: boolean): string {
  const out = newLabel(ctx, 'x');
  const xfade = `xfade=transition=fade:duration=${sec(D * ctx.fd)}:offset=0`;
  if (!premultiply) {
    ctx.chains.push(`${tail}${head}${xfade}${out}`);
    return out;
  }
  const a = newLabel(ctx, 'xa'), b = newLabel(ctx, 'xb');
  ctx.chains.push(`${tail}format=yuva444p16le,premultiply=inplace=1${a}`, `${head}format=yuva444p16le,premultiply=inplace=1${b}`);
  ctx.chains.push(`${a}${b}${xfade},unpremultiply=inplace=1,format=yuva420p${out}`);
  return out;
}

/**
 * The alpha of segment frames `[a, b)` as a key, when it is known to be the same on all of them and to depend only on
 * the key: a picture without an alpha channel (the probe says so), no motion keyframes, a static opacity, no fade or
 * dip ramp over those frames, no nested ramp and no late-starting video stream (made transparent). The key is
 * `full@<opacity>` when the picture fills the frame (its display shape is the frame's, no transform or crop), else the
 * fitted size and the transform. Null otherwise. Two windows with the same key have equal alphas, so dissolveWindow's
 * plain xfade is already the premultiplied mix and skips the 4:4:4 round trip (the costly part: on a 1080p export with
 * a 24-frame dissolve at every 3-second cut, about 40 % longer).
 */
function windowAlpha(ctx: Ctx, seg: ClipSeg, a: number, b: number): string | null {
  const c = seg.clip, t = c.transform;
  const v = seg.media.probe?.video;
  if (!v?.pixFmt || /^(rgba|bgra|argb|abgr|ya\d|yuva|gbrap|ayuv|pal8)/.test(v.pixFmt)) return null;
  const d = fitInputSize(v);
  if (!d || hasMotionKeyframes(c) || keyframesOf(c, 'opacity') || !Number.isFinite(t.opacity)) return null;
  // Fade / dip ramps: weight < 1 on frames n < extBefore + ramp-in and n > end - ramp-out (fadeWeights, dipFilters).
  const rampIn = Math.max(seg.fadeIn ?? 0, seg.dipIn ?? 0), rampOut = Math.max(seg.fadeOut ?? 0, seg.dipOut ?? 0);
  if (rampIn > 0 && a < seg.extBefore + rampIn) return null;
  if (rampOut > 0 && b > seg.extBefore + seg.frames - rampOut) return null;
  if (flatOrigin(c)?.env.length || videoStreamStart(seg.media) > 0) return null;
  const crop = t.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const cr = [crop.left, crop.right, crop.top, crop.bottom].map(clamp01);
  const rot = ((t.rotation % 360) + 360) % 360, X = Math.round(t.x || 0), Y = Math.round(t.y || 0);
  const op = num(clamp01(t.opacity));
  const identity = cr.every((x) => x === 0) && t.scale === 1 && rot === 0 && X === 0 && Y === 0;
  if (identity && d.w * ctx.H === d.h * ctx.W) return `full@${op}`;
  return `${d.w}x${d.h}:${cr.join(',')}:${t.scale}:${rot}:${X}:${Y}@${op}`;
}

/**
 * Builds one full-range video track stream. Returns its label, or null when the track is empty.
 *
 * A segment with a Cross Dissolve at an edge is split into its transition windows (the `2h` frames of the incoming
 * transition at its head, of the outgoing one at its tail) and its body; each pair of windows is mixed
 * (dissolveWindow) and everything is joined with one concat. A Dip to Black is a per-frame alpha ramp inside each
 * clip (exportPlan.ts; dipFilters, fadeWeights), so it needs no join.
 */
function videoTrack(ctx: Ctx, plan: TrackPlan): string | null {
  if (!plan.segs.some((s) => s.kind === 'clip')) return null;
  const parts: string[] = [];
  /** The previous segment's tail window, waiting for the incoming segment's head window. */
  let tail: { label: string; frames: number; alpha: string | null } | null = null;
  const internal = (why: string) => new Error(`Internal error in the render graph: ${why} on ${plan.track.name}.`);
  for (const s of plan.segs) {
    if (tail ? s.kind === 'gap' || s.transIn?.frames !== tail.frames : s.kind === 'clip' && s.transIn) throw internal('a Cross Dissolve has no window on one side');
    if (s.kind === 'gap') { parts.push(videoGap(ctx, s.frames)); continue; }
    const label = videoSegment(ctx, s);
    const frames = s.extBefore + s.frames + s.extAfter;
    const headN = tail ? tail.frames : 0;
    const tailN = 2 * s.extAfter;
    if (!headN && !tailN) { parts.push(label); continue; }
    const bodyN = frames - headN - tailN;
    const pieces: [number, number][] = [];
    if (headN) pieces.push([0, headN]);
    if (bodyN > 0) pieces.push([headN, headN + bodyN]);
    if (tailN) pieces.push([frames - tailN, frames]);
    const outs = pieces.map(() => newLabel(ctx, 'vs'));
    const srcs = pieces.length > 1 ? pieces.map(() => newLabel(ctx, 'vsp')) : [label];
    if (pieces.length > 1) ctx.chains.push(`${label}split=${pieces.length}${srcs.join('')}`);
    pieces.forEach(([a, b], i) => ctx.chains.push(`${srcs[i]}trim=start_frame=${a}:end_frame=${b},setpts=PTS-STARTPTS${outs[i]}`));
    let i = 0;
    if (headN) {
      const alpha = windowAlpha(ctx, s, 0, headN);
      parts.push(dissolveWindow(ctx, tail!.label, outs[i++], headN, alpha === null || alpha !== tail!.alpha));
    }
    if (bodyN > 0) parts.push(outs[i++]);
    tail = tailN ? { label: outs[i++], frames: tailN, alpha: windowAlpha(ctx, s, frames - tailN, frames) } : null;
  }
  if (tail) throw internal('a Cross Dissolve has no window on one side');
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
  const levelKeys = keyframesOf(seg.clip, 'volume');
  if (Number.isFinite(a.gain) && a.gain !== 0) f.push(`volume=${num(a.gain)}dB`);
  if (!levelKeys && Number.isFinite(a.volume) && a.volume !== 1) f.push(`volume=${num(Math.max(0, a.volume))}`);
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
  f.push(...envelopeFilters(ctx, seg, 'audio', totalFrames));
  if (levelKeys) f.push(...levelFilters(ctx, levelKeys, segmentClipFrame(ctx, seg)));
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
  return rangeSrt(req, cues, startF, endF);
}

/** SRT of `cues` (sequence seconds) in `[startF, endF)`, relative to startF with exact times; null when none is in it. */
function rangeSrt(req: ExportRequest, cues: { start: number; end: number; text: string }[], startF: number, endF: number): string | null {
  const s0 = framesToSeconds(startF, req.sequence.fps);
  const s1 = framesToSeconds(endF, req.sequence.fps);
  const out = cues
    .filter((c) => c && Number.isFinite(c.start) && Number.isFinite(c.end) && typeof c.text === 'string' && c.end > s0 && c.start < s1 && c.text.trim().length > 0)
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

/** The output's extension (`.mp4`, `.mov`, `.wav`, `.flac`, `.mkv`), or '' when it has none of those. */
function outputExt(outputPath: string): string {
  const m = /\.(mp4|mov|wav|flac|mkv)$/i.exec(outputPath);
  return m ? m[0] : '';
}

/** `outputPath` without its output extension. */
function outputStem(outputPath: string): string {
  const ext = outputExt(outputPath);
  return ext ? outputPath.slice(0, -ext.length) : outputPath;
}

/**
 * Temp file ffmpeg writes to before the rename: `<out>.recut-part-<token>.<ext>` (`.mp4`, `.mov`, ...). The exporter
 * picks a random token and creates the file exclusively, so the temp is never a file that existed before (a user's
 * file, a hard link).
 */
export function exportPartPath(outputPath: string, token: string): string {
  return `${outputStem(outputPath)}.recut-part-${token}${outputExt(outputPath).toLowerCase() || '.mp4'}`;
}

/** Sidecar subtitle path next to the output: `<out>.srt`. */
export function exportSidecarPath(outputPath: string): string {
  return outputStem(outputPath) + '.srt';
}

/** Temp file the sidecar is written to (exclusively, random token) before its rename: `<out>.recut-part-<token>.srt`. */
export function exportSidecarTempPath(outputPath: string, token: string): string {
  return `${outputStem(outputPath)}.recut-part-${token}.srt`;
}

/** Where a finished render is kept when the final move fails: `<out>.recut-unsaved-<stamp>.<ext>`. */
export function exportUnsavedPath(outputPath: string, stamp: string): string {
  return `${outputStem(outputPath)}.recut-unsaved-${stamp}${outputExt(outputPath).toLowerCase() || '.mp4'}`;
}

/**
 * Output path for a request: outputDir/fileName with the format's extension (`.mp4` unless the settings choose
 * another format; file name sanitized to a basename). The folder must be absolute: a relative one would resolve
 * against the main process cwd for Node while ffmpeg reads a prefix such as `tee:`, `concat:` or `pipe:` as a
 * protocol, bypassing the source-file check.
 */
export function exportOutputPath(settings: ExportSettings): string {
  const dir = typeof settings.outputDir === 'string' ? settings.outputDir : '';
  if (!path.isAbsolute(dir)) {
    throw new Error(`The output folder must be an absolute path (a full path such as ${process.platform === 'win32' ? 'C:\\Videos' : '/home/me/Videos'}); got "${dir}".`);
  }
  const name = withExportExtension(sanitizeExportFileName(settings.fileName || 'export'), exportContainer(settings));
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

/** True when an enabled clip on a rendered (non-muted / soloed) track overlaps [startF, endF); audio tracks only for an audio-only export. */
function hasEnabledClipInRange(seq: Sequence, startF: number, endF: number, audioOnly = false): boolean {
  return [...(audioOnly ? [] : activeTracks(seq.videoTracks)), ...activeTracks(seq.audioTracks)]
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
  const outputs = [outputPath];
  if (req.settings.exportSubtitleSidecar) outputs.push(exportSidecarPath(outputPath));
  // The sidecar is only written when there are cues to write.
  const written = req.settings.exportSubtitleSidecar && req.subtitles?.length ? outputs : [outputPath];
  assertExportPathsSafe(req, outputs, written, opts);
}

/**
 * The checks of assertOutputNotASource for a list of paths: none of `outputs` may be a project source; with
 * `opts.statPath`, none of `written` may be a folder or the same file as a source, nor (unless `req.overwrite`)
 * exist already. Per-track audio export checks every file and the shared sidecar with it (exportOutputFiles).
 */
export function assertExportPathsSafe(req: ExportRequest, outputs: string[], written: string[], opts: RenderGraphOptions): void {
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
  for (const o of outputs) {
    const hit = sources.get(canon(o));
    if (hit) throw new Error(`Refusing to export to "${o}": that file is ${describe(hit)}. Choose a different file name or folder.`);
  }

  if (!opts.statPath) return;
  const stat = (p: string): ExportPathStat | null => { try { return opts.statPath!(p); } catch { return null; } };
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

/**
 * The sequence an export renders: the request's sequence with its nested sequences (`req.sequences`) flattened into
 * media clips (shared/nest.ts flattenSequence; memoized, so every chunk of an export shares it). Tracks made for
 * nested content belong to their outer track (trackGroupId) for the audio mixes.
 */
export function renderSequence(req: ExportRequest): Sequence {
  return flattenSequence(req.sequence, req.sequences ?? {}, req.media);
}

export function buildRenderGraph(req: ExportRequest, opts: RenderGraphOptions = {}): RenderGraph {
  const { sequence: outer, media, settings } = req;
  // Nested sequences are expanded into media clips (Roadmap §8): ranges, chapters, subtitles and the audio output
  // plan read the outer sequence; segments, transitions and mixes the flattened one.
  const seq = renderSequence(req);
  const warnings: string[] = [...flattenWarnings(seq)];
  const container = exportContainer(settings);
  const audioOnly = CONTAINERS[container].audioOnly;
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
  if (!audioOnly) validateDimensions(W, H);
  const vEnc = videoEncoder(settings);
  if (vEnc?.codec === 'dnxhd' && (W < DNXHR_MIN_WIDTH || H < DNXHR_MIN_HEIGHT)) {
    throw new Error(`DNxHR needs a frame of at least ${DNXHR_MIN_WIDTH}×${DNXHR_MIN_HEIGHT} pixels; the export is ${W}×${H}.`);
  }
  let SR = settings.sampleRate > 0 ? Math.round(settings.sampleRate) : seq.sampleRate || 48000;
  if (usesAc3(settings) && !AC3_SAMPLE_RATES.includes(SR)) {
    // The AC-3 encoder only takes 32 / 44.1 / 48 kHz: fail-safe for IPC callers (the dialog validates this).
    const to = SR > 48000 ? 48000 : AC3_SAMPLE_RATES.find((r) => r >= SR) ?? 48000;
    warnings.push(`AC-3 audio supports 32, 44.1 and 48 kHz only; exporting at ${to} Hz instead of ${SR} Hz.`);
    SR = to;
  }
  // Output audio tracks (shared/exportFormat.ts): one main mix, or (MKV) one mix per output track. MKV always writes
  // stream-addressed codec args, languages and default flags (`packaging`); the other formats keep one `[aout]` with
  // `-c:a ... -ac N`. Every sequence track is rendered once, at the widest output layout (`layout`), and each output
  // mixes its tracks from there into its own layout.
  const packaging = supportsPackaging(settings) && opts.audioTrackId === undefined;
  const outPlans = audioOutputPlan(outer.audioTracks ? outer : { audioTracks: [] }, settings);
  if (!packaging) outPlans.splice(1);
  const channels = packaging ? outPlans[0].channels : settings.audioChannels === 6 ? 6 : 2;
  const layout = packaging ? workingLayout(outPlans) : channels === 6 ? '5.1' : 'stereo';

  let { startF, endF } = resolveRange(outer, settings, warnings);
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
  if (!opts.range && !hasEnabledClipInRange(outer, startF, endF, audioOnly)) {
    throw new Error(audioOnly ? 'Nothing to export: no enabled audio clips in the selected range.' : 'Nothing enabled to export in the selected range');
  }
  const wantVideo = opts.streams !== 'audio' && !audioOnly;
  const wantAudio = opts.streams !== 'video';
  if (audioOnly && opts.streams === 'video') throw new Error('An audio-only export has no video to render.');
  if (audioOnly && settings.burnSubtitles && req.subtitles?.length) warnings.push('Subtitle burn-in does not apply to an audio-only export (there is no picture); subtitles were not burned in.');
  const trackFilter = opts.audioTrackId;
  if (trackFilter !== undefined && !activeTracks(outer.audioTracks).some((t) => t.id === trackFilter)) {
    throw new Error(`Audio track ${String(trackFilter)} is not rendered by this export (muted, not soloed or missing).`);
  }
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
    finalVideo.push(`format=${vEnc?.pixFmt ?? 'yuv420p'}`);
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
  const audioOutputs: RenderAudioOutput[] = outPlans.map((p, i) => ({ label: audioOutputLabel(i), channels: packaging ? p.channels : channels, name: p.name }));
  if (wantAudio) {
    // The sequence tracks each output mixes: per-track audio export, that one track; otherwise the plan's (only
    // tracks the export renders).
    const mixes: { ids: Set<ID>; layout: string }[] = trackFilter !== undefined
      ? [{ ids: new Set([trackFilter]), layout }]
      : outPlans.map((p) => ({ ids: new Set(p.mixed), layout: packaging ? p.layout : layout }));
    const trackLabels = new Map<ID, string[]>();
    for (const track of activeTracks(seq.audioTracks)) {
      const uses = mixes.filter((m) => m.ids.has(trackGroupId(track))).length;
      if (uses === 0) continue;
      const plan = planTrackSegments(track, seq, media, renderStartF, renderEndF, 'audio', warnings);
      const label = audioTrack(ctx, plan);
      if (!label) continue;
      if (uses === 1) { trackLabels.set(track.id, [label]); continue; }
      // A track in several outputs: render it once and split it.
      const copies = Array.from({ length: uses }, () => newLabel(ctx, 'as'));
      ctx.chains.push(`${label}asplit=${uses}${copies.join('')}`);
      trackLabels.set(track.id, copies);
    }
    // Exact sample count (chunked export: sample-exact chunk boundaries). Audio-only files always have exactly the
    // range's samples, so per-track files have equal lengths; so do all output tracks of an MKV.
    const rangeSamples = Math.round((frameCount * SR * seq.fps.den) / seq.fps.num);
    const N = opts.audioSamples !== undefined ? Math.max(0, Math.round(opts.audioSamples)) : audioOnly || packaging ? rangeSamples : -1;
    const tail = N >= 0 ? `,apad=whole_len=${N},atrim=end_sample=${N}` : '';
    // Widened render (D2): keep the samples of [startF, endF).
    const sampleAt = (f: number) => Math.round((f * SR * seq.fps.den) / seq.fps.num);
    const cut = renderFrames !== frameCount ? `,atrim=start_sample=${sampleAt(lead)}:end_sample=${sampleAt(lead + frameCount)},asetpts=PTS-STARTPTS` : '';
    mixes.forEach((mix, i) => {
      const out = audioOutputLabel(i);
      const labels: string[] = [];
      for (const track of activeTracks(seq.audioTracks)) if (mix.ids.has(trackGroupId(track))) { const l = trackLabels.get(track.id)?.shift(); if (l) labels.push(l); }
      const ml = mix.layout;
      if (labels.length === 0) {
        ctx.chains.push(`anullsrc=r=${SR}:cl=${ml}:d=${sec(durationSec + 0.1)},aformat=sample_fmts=fltp,atrim=duration=${sec(durationSec)},asetpts=PTS-STARTPTS${tail}${out}`);
      } else if (labels.length === 1) {
        ctx.chains.push(`${labels[0]}aresample=${SR},aformat=sample_fmts=fltp:channel_layouts=${ml}${cut}${tail}${out}`);
      } else {
        ctx.chains.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest,aresample=${SR},aformat=sample_fmts=fltp:channel_layouts=${ml}${cut}${tail}${out}`);
      }
    });
  }

  // ---- Args
  const outputPath = exportOutputPath(settings);
  const inputArgs: string[] = [];
  for (const inp of ctx.inputs) inputArgs.push(...inp);
  // Encoder args (shared/exportFormat.ts): H.264 / H.265 (MP4), ProRes / DNxHR (MOV); AAC / AC-3, PCM or FLAC.
  const videoCodecArgs: string[] = vEnc ? [...vEnc.args, '-pix_fmt', vEnc.pixFmt, '-r', fpsStr(outFps), '-fps_mode', 'cfr'] : [];
  const audioCodecArgs = packaging
    ? [...outPlans.flatMap((p, i) => [...audioStreamArgs(p.encoder.args, i), `-ac:a:${i}`, String(p.channels)]), '-ar', String(SR)]
    : [...audioEncoder(settings).args, '-ar', String(SR), '-ac', String(channels)];
  const cinfo = CONTAINERS[container];
  const muxArgs = [...cinfo.muxArgs, '-f', cinfo.muxer];

  // Soft subtitle streams (MKV): the whole export only (a chunked export adds them when joining the chunks).
  const softSubtitles: SoftSubtitleStream[] = [];
  if (packaging && !opts.range && !opts.streams) {
    // Names and languages from the sequence's tracks, cues from the request (resolved to seconds by the dialog).
    const cueTracks = Array.isArray(req.subtitleTracks) ? req.subtitleTracks.filter((t) => t && typeof t.id === 'string') : [];
    const seqTracks = (Array.isArray(outer.subtitleTracks) ? outer.subtitleTracks : []).filter((t) => t && typeof t.id === 'string')
      .map((t) => ({ id: t.id, name: String(t.name ?? ''), language: String(t.language ?? '') }));
    for (const p of subtitleOutputPlan(seqTracks, settings)) {
      const t = cueTracks.find((x) => x.id === p.track.id);
      const content = t ? rangeSrt(req, Array.isArray(t.cues) ? t.cues : [], startF, endF) : null;
      if (!content) { warnings.push(`Subtitle track "${p.track.name}" has no cues in the export range; it is not included.`); continue; }
      softSubtitles.push({ trackId: p.track.id, content, language: p.language, title: p.title, isDefault: p.isDefault, forced: p.forced });
    }
  }
  const subtitleCodecArgs = softSubtitles.length ? ['-c:s', 'subrip'] : [];
  // MKV stream tags and flags: the picture and the first audio track are the default ones, every other audio track
  // is not; subtitles as chosen. Nothing else is tagged (no metadata comes from the sources).
  const streamArgs: string[] = [];
  if (packaging) {
    if (wantVideo) streamArgs.push('-disposition:v:0', 'default');
    if (wantAudio) {
      outPlans.forEach((p, i) => {
        streamArgs.push(`-metadata:s:a:${i}`, `language=${p.language}`);
        if (p.title) streamArgs.push(`-metadata:s:a:${i}`, `title=${p.title}`);
        streamArgs.push(`-disposition:a:${i}`, dispositionValue(p.isDefault));
      });
    }
  }

  // A converted video can end up to half an output frame after the audio: never cut its last frame.
  const outputSec = wantVideo ? Math.max(durationSec, outputDurationSec) : durationSec;
  // Chapters: the whole export only (a chunked export writes them when joining the chunks, exporter.ts).
  const chapters = opts.range || !cinfo.chapters ? [] : exportChapters(outer, startF, endF, outputSec);
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
  // Soft subtitle files follow the chapters file: `-f srt -i <file>`, one input each.
  let subtitleInput = ctx.inputs.length + (chaptersInput !== null ? 1 : 0);
  const subtitleMaps: string[] = [];
  if (softSubtitles.length) {
    const paths = opts.softSubtitleFilePaths;
    if (paths && paths.length >= softSubtitles.length) {
      softSubtitles.forEach((sub, i) => {
        args.push('-f', 'srt', '-i', paths[i]);
        subtitleMaps.push('-map', `${subtitleInput++}:s:0`);
        streamArgs.push(`-metadata:s:s:${i}`, `language=${sub.language}`);
        if (sub.title) streamArgs.push(`-metadata:s:s:${i}`, `title=${sub.title}`);
        streamArgs.push(`-disposition:s:${i}`, dispositionValue(sub.isDefault, sub.forced));
      });
    } else {
      warnings.push('Subtitle tracks chosen but no subtitle file paths were provided; soft subtitles are not written.');
      softSubtitles.length = 0;
      subtitleCodecArgs.length = 0;
    }
  }
  args.push('-filter_complex_script', FILTER_SCRIPT_TOKEN);
  if (wantVideo) args.push('-map', '[vout]');
  if (wantAudio) for (const o of audioOutputs) args.push('-map', o.label);
  args.push(...subtitleMaps);
  args.push(...outputMetadataArgs(chaptersInput));
  if (wantVideo) args.push(...videoCodecArgs); else args.push('-vn');
  if (wantAudio) args.push(...audioCodecArgs); else args.push('-an');
  args.push(...subtitleCodecArgs, ...streamArgs);
  args.push(...cinfo.muxArgs, '-t', sec(outputSec), '-f', cinfo.muxer, outputPath);

  return {
    args, filterGraph: ctx.chains.join(';\n'), durationSec, frameCount, outputFps: outFps, outputFrameCount, outputDurationSec, outputPath, warnings,
    subtitleContent, chapters, chaptersContent, inputCount: ctx.inputs.length,
    inputArgs, videoCodecArgs, audioCodecArgs, sampleRate: SR, channels, startF, endF, container, audioOnly, muxArgs,
    audioOutputs: wantAudio ? audioOutputs : [], softSubtitles, subtitleCodecArgs, streamArgs,
  };
}

// ---------------------------------------------------------------------------------------------------
// Output files (one, or one per audio track)
// ---------------------------------------------------------------------------------------------------

/** One file an export writes. */
export interface ExportOutputFile {
  /** The request for this file (per-track: the file's own name and no sidecar). */
  req: ExportRequest;
  /** Per-track audio export: the audio track mixed into this file (RenderGraphOptions.audioTrackId). */
  audioTrackId?: ID;
  /** Per-track audio export: "A1 Dialogue". */
  label?: string;
}

export interface ExportOutputs {
  files: ExportOutputFile[];
  /** True for a per-track audio export (shared/exportFormat.ts isPerTrackAudio). */
  perTrack: boolean;
  /** The sidecar .srt path when the settings ask for one (per-track: `<base>.srt`, written once). */
  sidecarPath?: string;
  /** Per-track: the audio tracks that get no file and why ("A3 (muted)"). */
  skipped: string[];
}

/**
 * The files `req` writes. A per-track audio export (WAV / FLAC with `audioPerTrack`) writes one file per audio
 * track the mixed export renders that has an enabled clip in the range (shared/exportFormat.ts perTrackAudioPlan),
 * named `<base> - A1 <track name>.wav`; every other export writes one file.
 */
export function exportOutputFiles(req: ExportRequest): ExportOutputs {
  const { settings } = req;
  const sidecarPath = settings.exportSubtitleSidecar ? exportSidecarPath(exportOutputPath(settings)) : undefined;
  if (!isPerTrackAudio(settings)) return { files: [{ req }], perTrack: false, sidecarPath, skipped: [] };
  const { startF, endF } = resolveRange(req.sequence, settings, []);
  const plan = perTrackAudioPlan(req.sequence, settings, startF, endF);
  if (plan.files.length === 0) throw new Error('Nothing to export: no audio track has enabled clips in the selected range (muted and empty tracks get no file).');
  return {
    perTrack: true, sidecarPath,
    files: plan.files.map((f) => ({
      req: { ...req, settings: { ...settings, fileName: f.fileName, exportSubtitleSidecar: false, burnSubtitles: false, audioPerTrack: false } },
      audioTrackId: f.track.id,
      label: trackLabel(f),
    })),
    skipped: plan.skipped.map((k) => `${trackLabel(k)} (${PER_TRACK_SKIP_REASON[k.reason]})`),
  };
}

/** "A1 Dialogue" ("A1" for a track named "A1"). */
function trackLabel(t: { label: string; track: { name: string } }): string {
  const name = typeof t.track.name === 'string' ? t.track.name.trim() : '';
  return name && name.toLowerCase() !== t.label.toLowerCase() ? `${t.label} ${name}` : t.label;
}

/**
 * Builds (and so validates) the graph of every file of `req` (exportOutputFiles). For a per-track export it also
 * checks the shared sidecar path and refuses two files with the same name.
 */
export function buildExportGraphs(req: ExportRequest, opts: RenderGraphOptions = {}): { outputs: ExportOutputs; graphs: RenderGraph[] } {
  const outputs = exportOutputFiles(req);
  const graphs = outputs.files.map((f) => buildRenderGraph(f.req, { ...opts, audioTrackId: f.audioTrackId }));
  if (outputs.perTrack) {
    const seen = new Set<string>();
    for (const g of graphs) {
      const k = g.outputPath.toLowerCase();
      if (seen.has(k)) throw new Error(`Two audio tracks would be written to the same file "${g.outputPath}". Rename one of the tracks.`);
      seen.add(k);
    }
    if (outputs.sidecarPath) {
      const sc = outputs.sidecarPath;
      if (seen.has(sc.toLowerCase())) throw new Error(`The subtitle sidecar "${sc}" has the name of an audio file.`);
      assertExportPathsSafe(req, [sc], req.subtitles?.length ? [sc] : [], opts);
    }
    if (outputs.skipped.length) graphs[0].warnings.push(`No file for ${outputs.skipped.join(', ')}.`);
  }
  return { outputs, graphs };
}
