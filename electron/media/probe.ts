/**
 * ffprobe → MediaProbe.
 */
import path from 'node:path';
import fsp from 'node:fs/promises';
import type { AudioStreamInfo, MediaKind, MediaProbe, Rational, SubtitleStreamInfo, VideoStreamInfo } from '@shared/model';
import { STILL_IMAGE_CODECS, STILL_IMAGE_EXTS } from '@shared/media';
import { assertAbsoluteMediaPath, ffmpegFileArg, runFfprobeJson } from './ffmpeg';

// ------------------------------------------------------------------
// Raw ffprobe JSON shapes (subset)
// ------------------------------------------------------------------
export interface FfprobeStream {
  index: number;
  codec_name?: string;
  codec_type?: 'video' | 'audio' | 'subtitle' | 'data' | 'attachment';
  width?: number;
  height?: number;
  coded_width?: number;
  coded_height?: number;
  sample_aspect_ratio?: string;
  pix_fmt?: string;
  color_space?: string;
  profile?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  start_time?: string;
  bit_rate?: string;
  nb_frames?: string;
  channels?: number;
  channel_layout?: string;
  sample_rate?: string;
  bits_per_raw_sample?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
  side_data_list?: { side_data_type?: string; rotation?: number | string; displaymatrix?: string }[];
}

export interface FfprobeFormat {
  filename?: string;
  format_name?: string;
  format_long_name?: string;
  duration?: string;
  size?: string;
  start_time?: string;
  bit_rate?: string;
  nb_streams?: number;
  tags?: Record<string, string>;
}

export interface FfprobeOutput { streams?: FfprobeStream[]; format?: FfprobeFormat }

/** VideoStreamInfo as produced by probeMedia: the optional probe-detail fields are always present. */
export interface ProbedVideoStreamInfo extends VideoStreamInfo {
  /** Display rotation in degrees (0, 90, 180, 270), from the display matrix side data or the `rotate` tag. */
  rotation: number;
  /** Coded (storage) size; `width`/`height` are the DISPLAY size (swapped for 90/270 rotation). */
  codedWidth: number;
  codedHeight: number;
  /** Stream start relative to the container start (seconds, >= 0). The export pads a late-starting video stream. */
  startTime: number;
  /** Sample aspect ratio, reduced; 1:1 when the stream has none (ffprobe "0:1" / "N/A") or an invalid one. */
  sar: Rational;
}

/** Parse ffprobe's `sample_aspect_ratio` ("32:27"); unknown, zero or malformed -> 1:1. */
export function parseSar(s: string | undefined): Rational {
  const m = /^\s*(\d+)\s*[:/]\s*(\d+)\s*$/.exec(s ?? '');
  if (!m) return { num: 1, den: 1 };
  const n = parseInt(m[1], 10), d = parseInt(m[2], 10);
  if (!(n > 0 && d > 0)) return { num: 1, den: 1 };
  const g = gcd(n, d);
  return { num: n / g, den: d / g };
}

/** Display rotation of a stream in degrees, normalized to 0/90/180/270 (clockwise, as players apply it). */
export function streamRotation(s: FfprobeStream): number {
  let deg: number | undefined;
  for (const sd of s.side_data_list ?? []) {
    const r = typeof sd.rotation === 'string' ? Number(sd.rotation) : sd.rotation;
    if (typeof r === 'number' && Number.isFinite(r)) { deg = r; break; }
  }
  if (deg === undefined) {
    const tag = Number(s.tags?.rotate);
    if (Number.isFinite(tag)) deg = tag;
  }
  if (deg === undefined) return 0;
  // ffprobe's display-matrix rotation is counter-clockwise (e.g. -90 for a phone held upright); the
  // `rotate` tag is clockwise. Only the axis swap matters downstream, so normalize to a quarter turn.
  const q = ((Math.round(deg / 90) % 4) + 4) % 4;
  return q * 90;
}

// ------------------------------------------------------------------

/** Still-image extensions with the dot (shared/media.ts STILL_IMAGE_EXTS, shared with the renderer's classifiers). */
export const IMAGE_EXT: ReadonlySet<string> = new Set(STILL_IMAGE_EXTS.map((e) => `.${e}`));
/** Codecs that only ever carry stills; av1/hevc count only without duration (AVIF / HEIC items in a mov container). */
const IMAGE_CODECS: ReadonlySet<string> = new Set(STILL_IMAGE_CODECS);
const SUBTITLE_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa', '.sub', '.sbv']);

function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { const t = a % b; a = b; b = t; }
  return a || 1;
}

/** Parse "24000/1001" or "25" into a reduced Rational. Invalid/zero → {0,1}. */
export function parseRational(s: string | undefined): Rational {
  if (!s) return { num: 0, den: 1 };
  const m = /^\s*(\d+)\s*(?:\/\s*(\d+))?\s*$/.exec(s);
  if (!m) {
    const f = parseFloat(s);
    if (!Number.isFinite(f) || f <= 0) return { num: 0, den: 1 };
    return { num: Math.round(f * 1000), den: 1000 };
  }
  let num = parseInt(m[1], 10);
  let den = m[2] ? parseInt(m[2], 10) : 1;
  if (!num || !den) return { num: 0, den: 1 };
  const g = gcd(num, den);
  num /= g; den /= g;
  return { num, den };
}

function ratValue(r: Rational): number { return r.den ? r.num / r.den : 0; }

function num(s: string | number | undefined): number | undefined {
  if (s === undefined || s === null || s === 'N/A') return undefined;
  const n = typeof s === 'number' ? s : parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

export function layoutForChannels(channels: number): string {
  switch (channels) {
    case 1: return 'mono';
    case 2: return 'stereo';
    case 3: return '2.1';
    case 4: return 'quad';
    case 5: return '5.0';
    case 6: return '5.1';
    case 7: return '6.1';
    case 8: return '7.1';
    default: return `${channels} channels`;
  }
}

/** Start of a stream relative to the container start_time (seconds, >= 0; 0 when unknown). */
export function streamStartOffset(s: FfprobeStream, format: FfprobeFormat): number {
  const st = num(s.start_time);
  if (st === undefined) return 0;
  const fst = num(format.start_time) ?? 0;
  const d = st - fst;
  return d > 1e-6 ? Math.round(d * 1e6) / 1e6 : 0;
}

/** Pick a single container name from ffprobe's comma list, preferring the file extension. */
export function normalizeContainer(formatName: string | undefined, filePath: string): string {
  const tokens = (formatName ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) return 'unknown';
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  const alias: Record<string, string> = { mkv: 'matroska', mka: 'matroska', m4v: 'm4v', m4a: 'm4a', mov: 'mov', mp4: 'mp4', webm: 'webm', ogv: 'ogg', oga: 'ogg', ogg: 'ogg', mp3: 'mp3', wav: 'wav', flac: 'flac' };
  const want = alias[ext] ?? ext;
  if (want && tokens.includes(want)) return want;
  if (tokens.includes('mp4') && ext === 'mp4') return 'mp4';
  return tokens[0];
}

function isImageContainer(container: string, formatName: string | undefined): boolean {
  const f = (formatName ?? '').toLowerCase();
  return /_pipe$/.test(container) || /_pipe\b/.test(f) || container === 'image2' || f.startsWith('image2');
}

/**
 * Whether a probed file with a video stream is a still image: an image demuxer (image2 / *_pipe), or a single picture
 * in another container (AVIF / HEIC items demux as `mov`, a one-frame GIF as `gif`) from an image file: no audio, and
 * one frame or no duration. An animated GIF / AVIF (several frames) stays a video.
 */
function isStillSource(container: string, formatName: string | undefined, filePath: string, v: FfprobeStream | undefined,
  duration: number, audioCount: number): boolean {
  if (isImageContainer(container, formatName)) return true;
  if (audioCount > 0) return false;
  const ext = path.extname(filePath).toLowerCase();
  const frames = num(v?.nb_frames);
  const single = frames !== undefined ? frames <= 1 : !(duration > 0);
  return single && (IMAGE_EXT.has(ext) || (!(duration > 0) && IMAGE_CODECS.has(v?.codec_name ?? '')));
}

// ------------------------------------------------------------------
// Playability
// ------------------------------------------------------------------
const PLAYABLE_CONTAINERS = new Set(['mp4', 'mov', 'm4v', 'm4a', 'webm', 'matroska', 'mp3', 'wav', 'flac', 'ogg']);
const PLAYABLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le']);

export function evaluatePlayability(p: { container: string; video?: VideoStreamInfo; audio: AudioStreamInfo[] }): { ok: boolean; reason?: string } {
  if (!PLAYABLE_CONTAINERS.has(p.container)) {
    return { ok: false, reason: `container ${p.container} not supported by Chromium` };
  }
  if (p.video) {
    const codec = p.video.codec;
    const theoraOk = codec === 'theora' && p.container === 'ogg';
    if (!PLAYABLE_VIDEO.has(codec) && !theoraOk) {
      return { ok: false, reason: `video codec ${codec} not supported by Chromium` };
    }
    const pix = p.video.pixFmt ?? '';
    if (codec === 'h264') {
      if (/444/.test(pix)) return { ok: false, reason: 'h264 4:4:4 (yuv444p) not supported by Chromium' };
      if (/422/.test(pix)) return { ok: false, reason: 'h264 4:2:2 not supported by Chromium' };
      if (/(10|12|14|16)(le|be)?$/.test(pix)) return { ok: false, reason: `h264 ${pix} (high bit depth) not supported by Chromium` };
    }
  }
  for (const a of p.audio) {
    if (!PLAYABLE_AUDIO.has(a.codec)) {
      return { ok: false, reason: `audio codec ${a.codec} not supported by Chromium` };
    }
  }
  return { ok: true };
}

// ------------------------------------------------------------------
// probeMedia
// ------------------------------------------------------------------

/** Convert raw ffprobe output to a MediaProbe. Exported for tests / offline use. */
export function probeFromFfprobe(raw: FfprobeOutput, filePath: string, fileSize?: number): MediaProbe {
  const streams = raw.streams ?? [];
  const format = raw.format ?? {};
  const container = normalizeContainer(format.format_name, filePath);

  // video: first video stream that is not an attached picture
  let video: VideoStreamInfo | undefined;
  for (const s of streams) {
    if (s.codec_type !== 'video') continue;
    if (s.disposition?.attached_pic) continue;
    const fps = parseRational(s.r_frame_rate);
    const avgFps0 = parseRational(s.avg_frame_rate);
    const avgFps = avgFps0.num ? avgFps0 : fps;
    const fv = ratValue(fps), av = ratValue(avgFps);
    const isVfr = fv > 0 && av > 0 && Math.abs(fv - av) / fv > 0.005;
    const codedWidth = s.width ?? s.coded_width ?? 0;
    const codedHeight = s.height ?? s.coded_height ?? 0;
    const rotation = streamRotation(s);
    const swap = rotation === 90 || rotation === 270;
    const v: ProbedVideoStreamInfo = {
      index: s.index,
      codec: s.codec_name ?? 'unknown',
      // Display size: Chromium and ffmpeg (autorotate) present a 90/270-rotated stream with swapped axes.
      width: swap ? codedHeight : codedWidth,
      height: swap ? codedWidth : codedHeight,
      fps,
      avgFps,
      pixFmt: s.pix_fmt,
      isVfr,
      colorSpace: s.color_space,
      rotation,
      codedWidth,
      codedHeight,
      startTime: streamStartOffset(s, format),
      sar: parseSar(s.sample_aspect_ratio),
    };
    video = v;
    break;
  }

  const audio: AudioStreamInfo[] = [];
  const subtitles: SubtitleStreamInfo[] = [];
  for (const s of streams) {
    if (s.codec_type === 'audio') {
      const channels = s.channels ?? 0;
      audio.push({
        index: s.index,
        codec: s.codec_name ?? 'unknown',
        channels,
        layout: s.channel_layout || layoutForChannels(channels),
        // No layout from ffprobe: the one above is a guess, so channels are numbered, not named (shared/audioChannels.ts).
        ...(s.channel_layout ? {} : { layoutGuessed: true }),
        sampleRate: num(s.sample_rate) ?? 0,
        language: s.tags?.language && s.tags.language !== 'und' ? s.tags.language : undefined,
        title: s.tags?.title,
      });
    } else if (s.codec_type === 'subtitle') {
      subtitles.push({
        index: s.index,
        codec: s.codec_name ?? 'unknown',
        language: s.tags?.language && s.tags.language !== 'und' ? s.tags.language : undefined,
        title: s.tags?.title,
      });
    }
  }

  // duration: format → longest stream
  let duration = num(format.duration) ?? 0;
  if (!(duration > 0)) {
    for (const s of streams) {
      const d = num(s.duration);
      if (d !== undefined && d > duration) duration = d;
    }
  }
  if (!(duration > 0)) {
    // matroska sometimes exposes DURATION tag only
    for (const s of streams) {
      const t = s.tags?.DURATION ?? s.tags?.duration;
      if (t) {
        const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(t);
        if (m) duration = Math.max(duration, Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
      }
    }
  }

  const isImage = !!video && isStillSource(container, format.format_name, filePath, streams.find((s) => s.index === video!.index), duration, audio.length);
  if (isImage) duration = 0;

  const size = fileSize ?? num(format.size) ?? 0;
  const startTime = Math.max(0, num(format.start_time) ?? 0);
  const bitrate = num(format.bit_rate);

  const play = evaluatePlayability({ container, video, audio });
  const probe: MediaProbe = {
    container,
    duration,
    size,
    video,
    audio,
    subtitles,
    startTime,
    bitrate,
    browserPlayable: isImage ? false : play.ok,
  };
  if (isImage) probe.playabilityReason = 'still image';
  else if (!play.ok) probe.playabilityReason = play.reason;
  return probe;
}

/** Probe a media file. Rejects with a readable error for unreadable/unsupported files. */
export async function probeMedia(filePath: string): Promise<MediaProbe> {
  assertAbsoluteMediaPath(filePath);
  const st = await fsp.stat(filePath).catch((e: NodeJS.ErrnoException) => {
    throw new Error(e.code === 'ENOENT' ? `file not found: ${filePath}` : `cannot stat ${filePath}: ${e.message}`);
  });
  const raw = await runFfprobeJson<FfprobeOutput>(['-show_format', '-show_streams', ffmpegFileArg(filePath)], { timeoutMs: 60_000 });
  if (!raw.format && !(raw.streams && raw.streams.length)) throw new Error(`ffprobe found no streams in ${filePath}`);
  const probe = probeFromFfprobe(raw, filePath, st.size);
  const v = probe.video as ProbedVideoStreamInfo | undefined;
  if (probe.playabilityReason === 'still image' && v && !v.rotation) {
    // EXIF orientation (JPEG) is a property of the decoded frame, not of the stream: ffprobe's stream size is the
    // stored one. FFmpeg (export, proxy, thumbnails) and Chromium (<img>) both turn the picture upright, so the probe
    // reports the upright size too (the Source monitor's zoom, the export's crop maths).
    const frames = await runFfprobeJson<{ frames?: { side_data_list?: FfprobeStream['side_data_list'] }[] }>(
      ['-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_entries', 'frame=width,height:frame_side_data=side_data_type,rotation', ffmpegFileArg(filePath)],
      { timeoutMs: 60_000 },
    ).catch(() => undefined);
    applyStillOrientation(probe, frames?.frames?.[0]?.side_data_list);
  }
  return probe;
}

/**
 * Record the first decoded frame's display rotation (EXIF orientation of a JPEG, as FFmpeg exports it) on a still's
 * probe: `rotation`, and the display size with the axes swapped for a quarter turn. Exported for tests.
 */
export function applyStillOrientation(probe: MediaProbe, sideData: FfprobeStream['side_data_list'] | undefined): void {
  const v = probe.video as ProbedVideoStreamInfo | undefined;
  if (!v || !sideData?.length) return;
  const rotation = streamRotation({ index: v.index, side_data_list: sideData });
  if (!rotation) return;
  v.rotation = rotation;
  if (rotation === 90 || rotation === 270) {
    const w = v.codedWidth || v.width, h = v.codedHeight || v.height;
    v.width = h;
    v.height = w;
  }
}

/**
 * Classify a probed file as video / audio / image / subtitle / unknown. A still is what probeFromFfprobe marked
 * `still image`, and anything from an image demuxer is one; a probe without that mark (recorded by an older version, or
 * built by hand) is also a still when it has a picture without duration or audio from an image file or image codec.
 * Mirrors kindFromProbe in src/state/store.ts.
 */
export function classifyKind(probe: MediaProbe, filePath: string): MediaKind {
  const ext = path.extname(filePath).toLowerCase();
  if (probe.video) {
    if (probe.playabilityReason === 'still image' || isImageContainer(probe.container, probe.container)) return 'image';
    if (!(probe.duration > 0) && probe.audio.length === 0 && (IMAGE_EXT.has(ext) || IMAGE_CODECS.has(probe.video.codec))) return 'image';
    return 'video';
  }
  if (probe.audio.length > 0) return 'audio';
  if (probe.subtitles.length > 0 || SUBTITLE_EXT.has(ext)) return 'subtitle';
  return 'unknown';
}
