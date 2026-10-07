/**
 * Export file formats (ROADMAP §6): containers, video / audio encoders and their FFmpeg arguments, file extensions,
 * size estimates and the per-track audio file plan. Pure (no DOM, no Node): the render graph
 * (electron/export/renderGraph.ts) builds its encoder arguments from here and the Export dialog
 * (src/panels/export/settings.ts) its labels, file names and estimates, so the two cannot disagree.
 *
 * Every format field of ExportSettings is optional: settings saved before 0.8.0 have none and resolve to MP4 with
 * their own H.264 / H.265 and AAC / AC-3 choice. MKV (ROADMAP §7) adds output audio tracks (mix definitions:
 * `audioOutputPlan`) and soft subtitle streams (`subtitleOutputPlan`); without `audioOutputs` an MKV has the one main
 * mix of an MP4.
 */
import type {
  AudioBitDepth, DnxhrProfile, ExportAudioCodec, ExportAudioLayout, ExportAudioOutput, ExportContainer, ExportSettings, ExportSubtitleOutput, ID,
  IntermediateCodec, ProResProfile, Sequence, SequenceSubtitleTrack, Track,
} from './model';
import { activeTracks } from './exportPlan';
import { clipEnd } from './timeline';
import { guessOcrLanguage, iso6392ForOcr } from './ocr';

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
  // FFmpeg's Matroska muxer (no mkvmerge): H.264 / H.265, several audio tracks, soft subtitles, chapters.
  mkv: { id: 'mkv', label: 'MKV (H.264 / H.265, tracks, subtitles)', ext: '.mkv', muxer: 'matroska', audioOnly: false, chapters: true, muxArgs: [] },
};

/** Picker order. */
export const CONTAINER_IDS: ExportContainer[] = ['mp4', 'mkv', 'mov', 'wav', 'flac'];

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
  // hvc1: the tag Apple players need in MP4. Matroska has no codec tags (FFmpeg refuses one).
  if (codec === 'libx265' && c === 'mp4') args.push('-tag:v', 'hvc1');
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

/** True when an audio encoder of the export is AC-3 (32 / 44.1 / 48 kHz only): MP4 / MKV main mix, or an MKV output track. */
export function usesAc3(s: Pick<ExportSettings, 'container' | 'audioCodec'> & Partial<Pick<ExportSettings, 'audioOutputs'>>): boolean {
  const c = exportContainer(s);
  if (c === 'mkv' && hasAudioOutputs(s)) return s.audioOutputs!.some((o) => audioOutputCodec(o) === 'ac3');
  return (c === 'mp4' || c === 'mkv') && s.audioCodec === 'ac3';
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

// ---------------------------------------------------------------------------------------------------
// Output audio tracks and soft subtitles (MKV, ROADMAP §7)
// ---------------------------------------------------------------------------------------------------

/** True when the container carries several audio tracks and soft subtitle streams (MKV only, see docs/FORMATS.md). */
export function supportsPackaging(s: Pick<ExportSettings, 'container'>): boolean {
  return exportContainer(s) === 'mkv';
}

/** True when the settings define output audio tracks (a non-empty `audioOutputs` on MKV). */
export function hasAudioOutputs(s: Pick<ExportSettings, 'container'> & Partial<Pick<ExportSettings, 'audioOutputs'>>): boolean {
  return supportsPackaging(s) && Array.isArray(s.audioOutputs) && s.audioOutputs.length > 0;
}

export const AUDIO_LAYOUTS: { id: ExportAudioLayout; label: string; channels: 1 | 2 | 6 }[] = [
  { id: 'stereo', label: 'Stereo', channels: 2 },
  { id: '5.1', label: '5.1', channels: 6 },
  { id: 'mono', label: 'Mono', channels: 1 },
];

export const AUDIO_CODECS: { id: ExportAudioCodec; label: string }[] = [
  { id: 'aac', label: 'AAC' },
  { id: 'ac3', label: 'AC-3 (Dolby Digital)' },
  { id: 'flac', label: 'FLAC (lossless)' },
  { id: 'pcm', label: 'PCM (uncompressed)' },
];

/** AC-3 limits of FFmpeg's encoder: at most 640 kbit/s; 5.1 fails bit allocation below 64 kbit/s. */
export const AC3_MAX_KBPS = 640;
export const AC3_MIN_KBPS_51 = 64;

export function audioOutputLayout(o: Pick<ExportAudioOutput, 'layout'>): ExportAudioLayout {
  return o.layout === '5.1' || o.layout === 'mono' ? o.layout : 'stereo';
}

export function audioOutputChannels(o: Pick<ExportAudioOutput, 'layout'>): 1 | 2 | 6 {
  const l = audioOutputLayout(o);
  return l === '5.1' ? 6 : l === 'mono' ? 1 : 2;
}

export function audioOutputCodec(o: Pick<ExportAudioOutput, 'codec'>): ExportAudioCodec {
  return o.codec === 'ac3' || o.codec === 'flac' || o.codec === 'pcm' ? o.codec : 'aac';
}

/** Default lossy bitrate (kbit/s) for a layout: 5.1 640 (AC-3) or 384 (AAC), stereo 256, mono 128. */
export function defaultOutputBitrate(codec: ExportAudioCodec, layout: ExportAudioLayout): number {
  if (layout === '5.1') return codec === 'ac3' ? 640 : 384;
  if (layout === 'mono') return 128;
  return 256;
}

/** The lossy bitrate of an output track (kbit/s): its own, or the layout's default. */
export function audioOutputBitrate(o: ExportAudioOutput): number {
  const b = Math.round(Number(o.bitrateKbps));
  return Number.isFinite(b) && b > 0 ? b : defaultOutputBitrate(audioOutputCodec(o), audioOutputLayout(o));
}

/** ISO 639-2 code for a language tag: a 3-letter code as is, a 2-letter (639-1) or regional tag mapped, else 'und'. */
export function exportLanguageCode(tag: string | undefined | null): string {
  const t = typeof tag === 'string' ? tag.trim().toLowerCase() : '';
  if (/^[a-z]{3}$/.test(t)) return t;
  const ocr = guessOcrLanguage(t);
  return ocr ? iso6392ForOcr(ocr) : 'und';
}

/** True when `code` is usable as a stream language: empty (= und) or three letters (ISO 639-2). */
export function validLanguageCode(code: string | undefined): boolean {
  return code === undefined || code.trim() === '' || /^[a-z]{3}$/i.test(code.trim());
}

/** A stream title as a metadata value: control characters removed, spaces collapsed. */
export function cleanStreamTitle(title: string | undefined): string {
  return String(title ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The output audio tracks of the settings as mix definitions. MKV with `audioOutputs`: those, in order. Anything
 * else (and MKV without `audioOutputs`): one main mix of every rendered track with the settings' codec, bitrate and
 * channels, exactly the audio an MP4 export writes.
 */
export function resolveAudioOutputs(s: ExportSettings): ExportAudioOutput[] {
  if (hasAudioOutputs(s)) return s.audioOutputs!;
  const enc = audioEncoder(s);
  const codec: ExportAudioCodec = enc.codec === 'ac3' || enc.codec === 'aac' || enc.codec === 'flac' ? enc.codec : 'pcm';
  const main: ExportAudioOutput = { layout: s.audioChannels === 6 ? '5.1' : 'stereo', codec };
  if (enc.lossy) main.bitrateKbps = Math.round(s.audioBitrateKbps || 0) || undefined;
  return [main];
}

/** Encoder of one output track (args without stream specifiers, `-ar` or `-ac`). PCM and FLAC follow audioBitDepth. */
export function audioOutputEncoder(o: ExportAudioOutput, s: Pick<ExportSettings, 'audioBitDepth'>): AudioEncoder {
  const codec = audioOutputCodec(o);
  const bits = audioBitDepth(s);
  if (codec === 'pcm') {
    const c = bits === 16 ? 'pcm_s16le' : 'pcm_s24le';
    return { codec: c, label: `PCM ${bits}-bit`, lossy: false, args: ['-c:a', c] };
  }
  if (codec === 'flac') {
    return { codec: 'flac', label: `FLAC ${bits}-bit`, lossy: false, args: bits === 16 ? ['-c:a', 'flac', '-sample_fmt', 's16'] : ['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24'] };
  }
  const kbps = audioOutputBitrate(o);
  return { codec, label: `${codec === 'ac3' ? 'AC-3' : 'AAC'} ${kbps} kbps`, lossy: true, args: ['-c:a', codec, '-b:a', `${kbps}k`] };
}

/** `args` (option / value pairs) with every option addressed to output audio stream `i` (`-c:a` → `-c:a:1`, `-sample_fmt` → `-sample_fmt:a:1`). */
export function audioStreamArgs(args: string[], i: number): string[] {
  return args.map((a, k) => {
    if (k % 2 === 1) return a;
    return a.endsWith(':a') ? `${a}:${i}` : `${a}:a:${i}`;
  });
}

/** One output audio track, planned for a sequence: what the render graph mixes and how it is encoded and tagged. */
export interface AudioOutputPlan {
  /** 0-based position among the output audio tracks. */
  index: number;
  /** The definition (resolveAudioOutputs). */
  output: ExportAudioOutput;
  /** True for a mix of every rendered track (no `sources`). */
  allTracks: boolean;
  /** The sequence audio tracks named as sources that exist, in sequence order. */
  sources: Track[];
  /** Ids of the source tracks the export renders (not muted; soloed when any track is soloed): what is mixed. */
  mixed: ID[];
  layout: ExportAudioLayout;
  channels: 1 | 2 | 6;
  encoder: AudioEncoder;
  /** ISO 639-2 language ('und' when not set). */
  language: string;
  /** Stream title ('' = none). */
  title: string;
  /** The first output track is the default one. */
  isDefault: boolean;
  /** Short description for the dialog and messages: `Track 2 "Commentary" (A3)`. */
  name: string;
}

/** "A1", "A3" for the given track ids (1-based positions in the sequence), in sequence order. */
export function sourceTrackLabels(seq: Pick<Sequence, 'audioTracks'>, ids: readonly ID[]): string[] {
  return seq.audioTracks.map((t, i) => (ids.includes(t.id) ? `A${i + 1}` : null)).filter((x): x is string => x !== null);
}

/**
 * The output audio tracks of an export of `seq` with `settings` (resolveAudioOutputs), each with the sequence tracks it
 * mixes. A track the export does not render (muted, or not soloed while another track is) is never mixed, in any
 * output; source ids that are not tracks of the sequence are ignored.
 */
export function audioOutputPlan(seq: Pick<Sequence, 'audioTracks'>, settings: ExportSettings): AudioOutputPlan[] {
  const active = new Set<ID>(activeTracks(seq.audioTracks).map((t) => t.id));
  return resolveAudioOutputs(settings).map((output, index) => {
    const allTracks = !Array.isArray(output.sources);
    const sources = allTracks ? seq.audioTracks.slice() : seq.audioTracks.filter((t) => output.sources!.includes(t.id));
    const title = cleanStreamTitle(output.title);
    const srcLabel = allTracks ? 'all tracks' : sourceTrackLabels(seq, sources.map((t) => t.id)).join(', ') || 'no tracks';
    return {
      index, output, allTracks, sources,
      mixed: sources.filter((t) => active.has(t.id)).map((t) => t.id),
      layout: audioOutputLayout(output), channels: audioOutputChannels(output),
      encoder: audioOutputEncoder(output, settings),
      language: exportLanguageCode(output.language), title, isDefault: index === 0,
      name: `Track ${index + 1}${title ? ` "${title}"` : ''} (${srcLabel})`,
    };
  });
}

/** The widest layout among the outputs: the layout every sequence track is rendered at before the per-output mixes. */
export function workingLayout(plans: readonly Pick<AudioOutputPlan, 'layout'>[]): 'stereo' | '5.1' {
  return plans.some((p) => p.layout === '5.1') ? '5.1' : 'stereo';
}

export type AudioOutputPresetId = 'main' | 'surroundStereo' | 'commentary';

export const AUDIO_OUTPUT_PRESETS: { id: AudioOutputPresetId; label: string }[] = [
  { id: 'main', label: 'Main mix only' },
  { id: 'surroundStereo', label: '5.1 + stereo downmix' },
  { id: 'commentary', label: 'Main + commentary (last audio track)' },
];

/**
 * The output tracks of a preset for `seq`: 'main' is `undefined` (the one main mix, as before 0.9.0);
 * 'surroundStereo' an AC-3 5.1 mix and an AAC stereo downmix of every track; 'commentary' a main mix of every
 * audio track but the last one with clips, and that track alone as a stereo "Commentary".
 */
export function audioOutputPreset(id: AudioOutputPresetId, seq: Pick<Sequence, 'audioTracks'>): ExportAudioOutput[] | undefined {
  if (id === 'surroundStereo') {
    return [
      { layout: '5.1', codec: 'ac3', bitrateKbps: 640, title: 'Surround 5.1' },
      { layout: 'stereo', codec: 'aac', bitrateKbps: 256, title: 'Stereo' },
    ];
  }
  if (id === 'commentary') {
    const tracks = seq.audioTracks;
    const withClips = tracks.filter((t) => t.clips.some((c) => c.enabled));
    const last = withClips.length >= 2 ? withClips[withClips.length - 1] : tracks[tracks.length - 1];
    if (!last || tracks.length < 2) return [{ layout: 'stereo', codec: 'aac', bitrateKbps: 256, title: 'Main' }];
    return [
      { sources: tracks.filter((t) => t !== last).map((t) => t.id), layout: 'stereo', codec: 'aac', bitrateKbps: 256, title: 'Main' },
      { sources: [last.id], layout: 'stereo', codec: 'aac', bitrateKbps: 192, title: 'Commentary' },
    ];
  }
  return undefined;
}

function sameOutputs(a: readonly ExportAudioOutput[] | undefined, b: readonly ExportAudioOutput[] | undefined): boolean {
  const norm = (o: ExportAudioOutput) => JSON.stringify([
    Array.isArray(o.sources) ? [...o.sources].sort() : null, audioOutputLayout(o), audioOutputCodec(o), audioOutputBitrate(o),
    exportLanguageCode(o.language), cleanStreamTitle(o.title),
  ]);
  const x = a ?? [], y = b ?? [];
  return x.length === y.length && x.every((o, i) => norm(o) === norm(y[i]));
}

/** The preset the settings' output tracks equal (titles, codecs and sources included), or null (custom). */
export function matchingAudioOutputPreset(settings: ExportSettings, seq: Pick<Sequence, 'audioTracks'>): AudioOutputPresetId | null {
  if (!hasAudioOutputs(settings)) return 'main';
  for (const p of AUDIO_OUTPUT_PRESETS) {
    const outs = audioOutputPreset(p.id, seq);
    if (outs && sameOutputs(outs, settings.audioOutputs)) return p.id;
  }
  return null;
}

/** One planned soft subtitle stream. */
export interface SubtitleOutputPlan {
  /** 0-based position among the subtitle streams of the file. */
  index: number;
  output: ExportSubtitleOutput;
  track: Pick<SequenceSubtitleTrack, 'id' | 'name' | 'language'>;
  language: string;
  title: string;
  isDefault: boolean;
  forced: boolean;
}

/**
 * The soft subtitle streams of an MKV export: `subtitleOutputs` whose track exists in `tracks`, in order (an entry
 * for a missing track, or a second entry for one track, is left out). Language and title default to the track's.
 */
export function subtitleOutputPlan(
  tracks: readonly Pick<SequenceSubtitleTrack, 'id' | 'name' | 'language'>[], settings: Pick<ExportSettings, 'container' | 'subtitleOutputs'>,
): SubtitleOutputPlan[] {
  if (!supportsPackaging(settings) || !Array.isArray(settings.subtitleOutputs)) return [];
  const out: SubtitleOutputPlan[] = [];
  for (const o of settings.subtitleOutputs) {
    const track = o && typeof o === 'object' ? tracks.find((t) => t.id === o.trackId) : undefined;
    if (!track || out.some((p) => p.track.id === track.id)) continue;
    const own = typeof o.language === 'string' && o.language.trim() ? o.language : track.language;
    out.push({
      index: out.length, output: o, track,
      language: exportLanguageCode(own),
      title: cleanStreamTitle(typeof o.title === 'string' ? o.title : track.name),
      isDefault: o.default === true, forced: o.forced === true,
    });
  }
  return out;
}

/** `-disposition` value: `default`, `forced`, `default+forced` or `0`. */
export function dispositionValue(isDefault: boolean, forced = false): string {
  return [isDefault ? 'default' : '', forced ? 'forced' : ''].filter(Boolean).join('+') || '0';
}

/**
 * Settings loaded from storage, made safe: `audioOutputs` / `subtitleOutputs` entries that are not objects are
 * dropped, unknown codecs / layouts fall back, sources and subtitle tracks not in `seq` are removed (an output
 * whose sources are all gone keeps an empty list, which the Checks list reports).
 */
export function sanitizePackaging(s: ExportSettings, seq: Pick<Sequence, 'audioTracks' | 'subtitleTracks'>): ExportSettings {
  const next = { ...s };
  const ids = new Set(seq.audioTracks.map((t) => t.id));
  if (Array.isArray(s.audioOutputs)) {
    const outs = s.audioOutputs.filter((o) => o && typeof o === 'object').map((o) => {
      const r: ExportAudioOutput = { layout: audioOutputLayout(o), codec: audioOutputCodec(o) };
      if (Array.isArray(o.sources)) r.sources = o.sources.filter((id) => typeof id === 'string' && ids.has(id));
      if (typeof o.bitrateKbps === 'number' && Number.isFinite(o.bitrateKbps) && o.bitrateKbps > 0) r.bitrateKbps = Math.round(o.bitrateKbps);
      if (typeof o.language === 'string') r.language = o.language;
      if (typeof o.title === 'string') r.title = o.title;
      return r;
    });
    if (outs.length) next.audioOutputs = outs; else delete next.audioOutputs;
  } else delete next.audioOutputs;
  const subIds = new Set(seq.subtitleTracks.map((t) => t.id));
  if (Array.isArray(s.subtitleOutputs)) {
    next.subtitleOutputs = s.subtitleOutputs.filter((o) => o && typeof o === 'object' && subIds.has(o.trackId)).map((o) => {
      const r: ExportSubtitleOutput = { trackId: o.trackId };
      if (typeof o.language === 'string') r.language = o.language;
      if (typeof o.title === 'string') r.title = o.title;
      if (o.default === true) r.default = true;
      if (o.forced === true) r.forced = true;
      return r;
    });
  } else delete next.subtitleOutputs;
  return next;
}
