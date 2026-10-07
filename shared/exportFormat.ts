/**
 * Export file formats (ROADMAP §6): containers, video / audio encoders and their FFmpeg arguments, file extensions,
 * size estimates and the per-track audio file plan. Pure (no DOM, no Node): the render graph
 * (electron/export/renderGraph.ts) builds its encoder arguments from here and the Export dialog
 * (src/panels/export/settings.ts) its labels, file names and estimates, so the two cannot disagree.
 *
 * Every format field of ExportSettings is optional: settings saved before 0.8.0 have none and resolve to MP4 with
 * their own H.264 / H.265 and AAC / AC-3 choice. A later container (MKV, §7) adds an entry to CONTAINERS and its
 * encoder choice to resolveExportFormat; nothing else here assumes a fixed list.
 */
import type {
  AudioBitDepth, DnxhrProfile, ExportContainer, ExportSettings, ID, IntermediateCodec, ProResProfile, Sequence, Track,
} from './model';
import { activeTracks } from './exportPlan';
import { clipEnd } from './timeline';

// ---------------------------------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------------------------------

export interface ContainerInfo {
  id: ExportContainer;
  /** Dialog label. */
  label: string;
  /** File extension, with the dot. */
  ext: string;
  /** FFmpeg muxer (`-f`). */
  muxer: string;
  /** True when the file has no picture. */
  audioOnly: boolean;
  /** True when the muxer stores chapters (the sequence's Chapter markers). */
  chapters: boolean;
  /** Extra muxer arguments. */
  muxArgs: string[];
}

export const CONTAINERS: Record<ExportContainer, ContainerInfo> = {
  // +faststart: the index at the front, for players and uploads (as before 0.8.0).
  mp4: { id: 'mp4', label: 'MP4 (H.264 / H.265)', ext: '.mp4', muxer: 'mp4', audioOnly: false, chapters: true, muxArgs: ['-movflags', '+faststart'] },
  // No +faststart: it rewrites the whole file at the end, which takes minutes for a 100 GB intermediate.
  mov: { id: 'mov', label: 'MOV (ProRes / DNxHR)', ext: '.mov', muxer: 'mov', audioOnly: false, chapters: true, muxArgs: [] },
  // RF64 only when the file passes 4 GB (a plain WAV header cannot say more).
  wav: { id: 'wav', label: 'WAV (audio only)', ext: '.wav', muxer: 'wav', audioOnly: true, chapters: false, muxArgs: ['-rf64', 'auto'] },
  flac: { id: 'flac', label: 'FLAC (audio only)', ext: '.flac', muxer: 'flac', audioOnly: true, chapters: true, muxArgs: [] },
};

export const CONTAINER_IDS = Object.keys(CONTAINERS) as ExportContainer[];

/** The settings' container; anything missing or unknown is MP4 (settings saved before 0.8.0). */
export function exportContainer(s: Pick<ExportSettings, 'container'>): ExportContainer {
  const c = s.container;
  return typeof c === 'string' && Object.hasOwn(CONTAINERS, c) ? c : 'mp4';
}

export function isAudioOnly(s: Pick<ExportSettings, 'container'>): boolean {
  return CONTAINERS[exportContainer(s)].audioOnly;
}

/** True when the export writes one audio file per audio track (audio-only formats only). */
export function isPerTrackAudio(s: Pick<ExportSettings, 'container' | 'audioPerTrack'>): boolean {
  return isAudioOnly(s) && s.audioPerTrack === true;
}

/** Media extensions an export file name may carry; replaced by the chosen format's extension. */
const KNOWN_EXT = /\.(mp4|mov|mkv|m4v|avi|wav|flac)$/i;

/** `name` with the container's extension (a known media extension is replaced; `.MP4` stays as typed). */
export function withExportExtension(name: string, container: ExportContainer): string {
  const n = name.trim();
  const ext = CONTAINERS[container].ext;
  if (n.toLowerCase().endsWith(ext)) return n;
  return n.replace(KNOWN_EXT, '') + ext;
}

// ---------------------------------------------------------------------------------------------------
// Video encoders
// ---------------------------------------------------------------------------------------------------

export interface ProfileInfo<T extends string> {
  id: T;
  label: string;
  /** `-profile:v` value. */
  ffProfile: string;
  /** Output pixel format. */
  pixFmt: string;
  /** Approximate data rate at 1920×1080, 29.97 fps (Mbit/s), for size estimates. */
  mbps1080: number;
}

/** prores_ks profiles (Apple ProRes white paper rates). 4444 is written without alpha: the graph has none at its end. */
export const PRORES_PROFILES: ProfileInfo<ProResProfile>[] = [
  { id: 'proxy', label: 'ProRes 422 Proxy', ffProfile: '0', pixFmt: 'yuv422p10le', mbps1080: 45 },
  { id: 'lt', label: 'ProRes 422 LT', ffProfile: '1', pixFmt: 'yuv422p10le', mbps1080: 102 },
  { id: 'standard', label: 'ProRes 422', ffProfile: '2', pixFmt: 'yuv422p10le', mbps1080: 147 },
  { id: 'hq', label: 'ProRes 422 HQ', ffProfile: '3', pixFmt: 'yuv422p10le', mbps1080: 220 },
  { id: '4444', label: 'ProRes 4444', ffProfile: '4', pixFmt: 'yuv444p10le', mbps1080: 330 },
];

/** dnxhd DNxHR profiles (Avid rates). DNxHD (fixed-size legacy profiles) is not offered. */
export const DNXHR_PROFILES: ProfileInfo<DnxhrProfile>[] = [
  { id: 'lb', label: 'DNxHR LB', ffProfile: 'dnxhr_lb', pixFmt: 'yuv422p', mbps1080: 45 },
  { id: 'sq', label: 'DNxHR SQ', ffProfile: 'dnxhr_sq', pixFmt: 'yuv422p', mbps1080: 145 },
  { id: 'hq', label: 'DNxHR HQ', ffProfile: 'dnxhr_hq', pixFmt: 'yuv422p', mbps1080: 220 },
  { id: 'hqx', label: 'DNxHR HQX (10-bit)', ffProfile: 'dnxhr_hqx', pixFmt: 'yuv422p10le', mbps1080: 220 },
  { id: '444', label: 'DNxHR 444 (10-bit)', ffProfile: 'dnxhr_444', pixFmt: 'yuv444p10le', mbps1080: 440 },
];

/** The dnxhd encoder refuses smaller frames ("input must be at least 256x120"). */
export const DNXHR_MIN_WIDTH = 256;
export const DNXHR_MIN_HEIGHT = 120;

export const INTERMEDIATE_CODECS: { id: IntermediateCodec; label: string }[] = [
  { id: 'prores', label: 'Apple ProRes (prores_ks)' },
  { id: 'dnxhr', label: 'Avid DNxHR (dnxhd)' },
];

export function intermediateCodec(s: Pick<ExportSettings, 'intermediateCodec'>): IntermediateCodec {
  return s.intermediateCodec === 'dnxhr' ? 'dnxhr' : 'prores';
}

export function proresProfile(s: Pick<ExportSettings, 'proresProfile'>): ProfileInfo<ProResProfile> {
  return PRORES_PROFILES.find((p) => p.id === s.proresProfile) ?? PRORES_PROFILES[3];
}

export function dnxhrProfile(s: Pick<ExportSettings, 'dnxhrProfile'>): ProfileInfo<DnxhrProfile> {
  return DNXHR_PROFILES.find((p) => p.id === s.dnxhrProfile) ?? DNXHR_PROFILES[2];
}

export interface VideoEncoder {
  /** FFmpeg encoder name. */
  codec: 'libx264' | 'libx265' | 'prores_ks' | 'dnxhd';
  /** Short label for the dialog summary, e.g. "H.264", "ProRes 422 HQ". */
  label: string;
  /** Output pixel format (`-pix_fmt`, and the graph's last `format=`). */
  pixFmt: string;
  /** True for intra-only codecs (every frame a key frame: chunks join without GOP settings). */
  intraOnly: boolean;
  /** Encoder args from `-c:v` up to (not including) `-pix_fmt`. */
  args: string[];
}

/** The video encoder of the settings; null for an audio-only format. */
export function videoEncoder(s: ExportSettings): VideoEncoder | null {
  const c = exportContainer(s);
  if (CONTAINERS[c].audioOnly) return null;
  if (c === 'mov') {
    if (intermediateCodec(s) === 'dnxhr') {
      const p = dnxhrProfile(s);
      return { codec: 'dnxhd', label: p.label, pixFmt: p.pixFmt, intraOnly: true, args: ['-c:v', 'dnxhd', '-profile:v', p.ffProfile] };
    }
    const p = proresProfile(s);
    // -vendor apl0: tag the stream as Apple's, which some finishing tools check before trusting it.
    return { codec: 'prores_ks', label: p.label, pixFmt: p.pixFmt, intraOnly: true, args: ['-c:v', 'prores_ks', '-profile:v', p.ffProfile, '-vendor', 'apl0'] };
  }
  const codec = s.videoCodec === 'libx265' ? 'libx265' : 'libx264';
  const args = ['-c:v', codec, '-preset', s.preset || 'medium'];
  if (s.qualityMode === 'bitrate' && s.videoBitrateKbps > 0) {
    const kb = Math.round(s.videoBitrateKbps);
    args.push('-b:v', `${kb}k`, '-maxrate', `${kb}k`, '-bufsize', `${kb * 2}k`);
  } else {
    args.push('-crf', String(Math.round(Number.isFinite(s.crf) ? s.crf : 18)));
  }
  if (codec === 'libx265') args.push('-tag:v', 'hvc1');
  return { codec, label: codec === 'libx265' ? 'H.265' : 'H.264', pixFmt: 'yuv420p', intraOnly: false, args };
}

// ---------------------------------------------------------------------------------------------------
// Audio encoders
// ---------------------------------------------------------------------------------------------------

export function audioBitDepth(s: Pick<ExportSettings, 'audioBitDepth'>): AudioBitDepth {
  return s.audioBitDepth === 16 ? 16 : 24;
}

export interface AudioEncoder {
  codec: 'aac' | 'ac3' | 'pcm_s16le' | 'pcm_s24le' | 'flac';
  /** Dialog label, e.g. "AAC 320 kbps", "PCM 24-bit". */
  label: string;
  /** True for a lossy codec with a bitrate setting. */
  lossy: boolean;
  /** Encoder args without `-ar` / `-ac`. */
  args: string[];
}

/** The audio encoder of the settings. MP4 keeps AAC / AC-3; MOV and WAV are PCM; FLAC is FLAC. */
export function audioEncoder(s: ExportSettings): AudioEncoder {
  const c = exportContainer(s);
  const bits = audioBitDepth(s);
  if (c === 'mov' || c === 'wav') {
    const codec = bits === 16 ? 'pcm_s16le' : 'pcm_s24le';
    return { codec, label: `PCM ${bits}-bit`, lossy: false, args: ['-c:a', codec] };
  }
  if (c === 'flac') {
    // FLAC takes s16 or s32 samples; s32 with 24 bits per raw sample is 24-bit FLAC.
    return { codec: 'flac', label: `FLAC ${bits}-bit`, lossy: false, args: bits === 16 ? ['-c:a', 'flac', '-sample_fmt', 's16'] : ['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24'] };
  }
  const codec = s.audioCodec === 'ac3' ? 'ac3' : 'aac';
  const channels = s.audioChannels === 6 ? 6 : 2;
  const kbps = Math.round(s.audioBitrateKbps || (channels === 6 ? 640 : 192));
  return { codec, label: `${codec === 'ac3' ? 'AC-3' : 'AAC'} ${kbps} kbps`, lossy: true, args: ['-c:a', codec, '-b:a', `${kbps}k`] };
}

/** True when the audio encoder is AC-3 (32 / 44.1 / 48 kHz only). */
export function usesAc3(s: Pick<ExportSettings, 'container' | 'audioCodec'>): boolean {
  return exportContainer(s) === 'mp4' && s.audioCodec === 'ac3';
}

// ---------------------------------------------------------------------------------------------------
// Size estimate (format part)
// ---------------------------------------------------------------------------------------------------

/**
 * Approximate video data rate (bit/s) of an intra codec at the given frame size and rate: the profile's 1080p29.97
 * rate scaled by pixels per second. Null for MP4 / audio-only (the dialog estimates those itself).
 */
export function intermediateVideoBitsPerSecond(s: ExportSettings, fpsValue: number): number | null {
  if (exportContainer(s) !== 'mov') return null;
  const p = intermediateCodec(s) === 'dnxhr' ? dnxhrProfile(s) : proresProfile(s);
  const scale = (Math.max(2, s.width) * Math.max(2, s.height) * Math.max(1, fpsValue)) / (1920 * 1080 * (30000 / 1001));
  return p.mbps1080 * 1e6 * scale;
}

/** Uncompressed PCM rate (bit/s) of one audio file. */
export function pcmBitsPerSecond(s: ExportSettings): number {
  const ch = s.audioChannels === 6 ? 6 : 2;
  return Math.max(1, s.sampleRate) * ch * audioBitDepth(s);
}

// ---------------------------------------------------------------------------------------------------
// Per-track audio files
// ---------------------------------------------------------------------------------------------------

export interface PerTrackFile {
  track: Track;
  /** 1-based position among the sequence's audio tracks ("A1" is 1). */
  number: number;
  /** "A1", "A2", ... */
  label: string;
  /** File name: `<base> - A1 <track name>.wav` (`<base> - A1.wav` when the track keeps its default name). */
  fileName: string;
}

export interface PerTrackSkip {
  track: Track;
  number: number;
  label: string;
  reason: 'muted' | 'notSoloed' | 'empty';
}

export interface PerTrackPlan { files: PerTrackFile[]; skipped: PerTrackSkip[] }

/** Characters not allowed in a file name on common file systems (mirrors sanitizeExportFileName). */
function cleanNamePart(s: string): string {
  return String(s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * File name of one per-track file: `<base> - A<n> <track name><ext>`, the base being `fileName` without its
 * extension. A track still named after its position ("A2" on the second track) is not repeated.
 */
export function perTrackFileName(fileName: string, number: number, trackName: string, container: ExportContainer): string {
  const base = withExportExtension(fileName || 'export', container).slice(0, -CONTAINERS[container].ext.length) || 'export';
  const label = `A${number}`;
  const name = cleanNamePart(trackName);
  const suffix = !name || name.toLowerCase() === label.toLowerCase() ? label : `${label} ${name}`;
  return `${base} - ${suffix}${CONTAINERS[container].ext}`;
}

/**
 * The files a per-track export of `[startF, endF)` writes: one per audio track the mixed export renders (not muted;
 * soloed when any track is soloed: shared/exportPlan.ts activeTracks) that has an enabled clip in the range. The
 * other tracks are listed in `skipped` with the reason. Every file covers the whole range, so the files line up
 * sample for sample.
 */
export function perTrackAudioPlan(seq: Sequence, settings: Pick<ExportSettings, 'fileName' | 'container'>, startF: number, endF: number): PerTrackPlan {
  const container = exportContainer(settings);
  const active = new Set<ID>(activeTracks(seq.audioTracks).map((t) => t.id));
  const anySolo = seq.audioTracks.some((t) => !t.muted && t.solo);
  const plan: PerTrackPlan = { files: [], skipped: [] };
  seq.audioTracks.forEach((track, i) => {
    const number = i + 1, label = `A${number}`;
    if (!active.has(track.id)) {
      plan.skipped.push({ track, number, label, reason: track.muted ? 'muted' : anySolo ? 'notSoloed' : 'muted' });
      return;
    }
    if (!track.clips.some((c) => c.enabled && c.start < endF && clipEnd(c) > startF)) {
      plan.skipped.push({ track, number, label, reason: 'empty' });
      return;
    }
    plan.files.push({ track, number, label, fileName: perTrackFileName(settings.fileName, number, track.name, container) });
  });
  return plan;
}

export const PER_TRACK_SKIP_REASON: Record<PerTrackSkip['reason'], string> = {
  muted: 'muted',
  notSoloed: 'not soloed',
  empty: 'no clips in the range',
};
