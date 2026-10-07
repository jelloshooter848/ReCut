/**
 * Pure helpers for the Export dialog: defaults, presets, estimates, validation, range math and the
 * client-side pre-flight checklist. No DOM, no zustand — unit-tested in tests/unit/exportSettings.test.ts.
 */
import type { Clip, ExportPreset, ExportSettings, ID, MediaItem, Rational, Sequence, SequenceSubtitleTrack } from '@shared/model';
import { EXPORT_PRESETS } from '@shared/model';
import { FPS_PRESETS, fpsEquals, fpsLabel, fpsValue, framesToSeconds, isValidFps } from '@shared/time';
import { allTracks, clipEnd, resolveSubtitleCues, sequenceDuration } from '@shared/timeline';
import { activeTracks, planTrackSegments, widenRangeForTransitions, type ClipSeg, type PastEndIssue, type TransitionIssueReason, type TransitionOutcome } from '@shared/exportPlan';
import { formatSyncOffset, linkedSyncOffsets } from '@shared/linkSync';
import { hasKeyframes, keyframeRange, keyframesOf } from '@shared/keyframes';
import { channelSelectionLabel, channelSelectionProblem, clipAudioStream, resolveChannelSelection } from '@shared/audioChannels';
import {
  AC3_MAX_KBPS, AC3_MIN_KBPS_51, CONTAINERS, DNXHR_MIN_HEIGHT, DNXHR_MIN_WIDTH, PER_TRACK_SKIP_REASON, audioBitDepth, audioEncoder, audioOutputBitrate,
  audioOutputPlan, exportContainer, hasAudioOutputs, intermediateVideoBitsPerSecond, isAudioOnly, isPerTrackAudio, pcmBitsPerSecond, perTrackAudioPlan,
  sanitizePackaging, subtitleOutputPlan, supportsPackaging, usesAc3, validLanguageCode, videoEncoder, withExportExtension,
} from '@shared/exportFormat';

export const MATCH_SEQUENCE = 'Match Sequence';
export const CUSTOM = 'Custom';

export const ENCODER_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'] as const;
export const CRF_MIN = 14;
export const CRF_MAX = 32;
export const MIN_DIMENSION = 16;
export const MAX_DIMENSION = 8192;

export interface ExportDefaultsContext {
  /** Preferences-backed last export directory. */
  lastExportDir?: string;
  /** Path of the project file (its directory is the fallback output directory). */
  projectPath?: string | null;
  /** Final fallback directory (e.g. the user's home) when nothing else is known. */
  fallbackDir?: string;
}

// ---------------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------------

/** Make a safe file name: strips path separators and characters illegal on common file systems. */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return cleaned || 'export';
}

/** Ensure an .mp4 extension (mirrors electron/export/renderGraph.ts exportOutputPath for MP4). */
export function withMp4(name: string): string {
  return withExportExtension(name, 'mp4');
}

/** `name` with the extension of the settings' format (`.mp4` when none is chosen; see exportOutputPath). */
export function withFormatExtension(name: string, settings: Pick<ExportSettings, 'container'>): string {
  return withExportExtension(name, exportContainer(settings));
}

export function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : i === 0 ? p.slice(0, 1) : '';
}

export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + sep + name;
}

/** Full output path for the settings (outputDir/fileName.<format extension>, .mp4 by default). */
export function outputPathFor(settings: Pick<ExportSettings, 'outputDir' | 'fileName'> & Partial<Pick<ExportSettings, 'container'>>): string {
  return joinPath(settings.outputDir, withFormatExtension(settings.fileName || 'export', settings));
}

/**
 * The files a per-track audio export writes for the settings' range (shared/exportFormat.ts perTrackAudioPlan), as
 * full paths; null when the settings do not ask for one file per track.
 */
export function perTrackOutputPaths(seq: Sequence, settings: ExportSettings): string[] | null {
  if (!isPerTrackAudio(settings)) return null;
  const r = exportRange(seq, settings);
  return perTrackAudioPlan(seq, settings, r.startF, r.endF).files.map((f) => joinPath(settings.outputDir, f.fileName));
}

// ---------------------------------------------------------------------------------------------------
// Defaults / presets
// ---------------------------------------------------------------------------------------------------

export function defaultExportSettings(seq: Sequence, ctx: ExportDefaultsContext = {}): ExportSettings {
  const outputDir = ctx.lastExportDir?.trim() || (ctx.projectPath ? dirnameOf(ctx.projectPath) : '') || ctx.fallbackDir || '';
  const surround = seq.channels === 6;
  return {
    outputDir,
    fileName: `${sanitizeFileName(seq.name)}.mp4`,
    width: evenDown(seq.width),
    height: evenDown(seq.height),
    fps: seq.fps,
    videoCodec: 'libx264',
    qualityMode: 'crf',
    crf: 18,
    videoBitrateKbps: 12000,
    preset: 'medium',
    audioCodec: surround ? 'ac3' : 'aac',
    audioBitrateKbps: surround ? 640 : 320,
    audioChannels: surround ? 6 : 2,
    sampleRate: seq.sampleRate || 48000,
    rangeMode: 'entire',
    burnSubtitles: false,
    exportSubtitleSidecar: false,
    useProxies: false,
    container: 'mp4',
    intermediateCodec: 'prores',
    proresProfile: 'hq',
    dnxhrProfile: 'hq',
    audioBitDepth: 24,
    audioPerTrack: false,
  };
}

/** The "Match Sequence" pseudo-preset for a sequence. */
export function matchSequencePreset(seq: Sequence): ExportPreset {
  return {
    name: MATCH_SEQUENCE,
    settings: {
      width: evenDown(seq.width), height: evenDown(seq.height), fps: seq.fps,
      sampleRate: seq.sampleRate || 48000, audioChannels: seq.channels === 6 ? 6 : 2,
    },
  };
}

/**
 * The format a preset selects: its `container`, MP4 for the presets without one (all presets before 0.8.0), and
 * none for Match Sequence (it only describes the frame size, rate and audio layout).
 */
export function presetContainer(preset: ExportPreset): ExportSettings['container'] {
  if (preset.name === MATCH_SEQUENCE) return undefined;
  return exportContainer(preset.settings);
}

/** Applies a preset's partial settings on top of `settings` (and its format, see presetContainer). Returns a new object. */
export function applyPreset(settings: ExportSettings, preset: ExportPreset): ExportSettings {
  const container = presetContainer(preset) ?? exportContainer(settings);
  const next: ExportSettings = { ...settings, ...preset.settings, container, useProxies: false };
  if (container !== exportContainer(settings)) next.fileName = withExportExtension(settings.fileName, container);
  if (preset.settings.audioChannels === 6 && !preset.settings.audioCodec) next.audioCodec = 'ac3';
  return clampSampleRateForCodec(next);
}

/** Sample rates the AC-3 encoder accepts (FFmpeg `ac3`: 48, 44.1 and 32 kHz). */
export const AC3_SAMPLE_RATES = [32000, 44100, 48000];

/**
 * True when `sampleRate` can be encoded with `codec`. Only AC-3 is limited; with `settings` the rule follows the
 * export's AC-3 encoders (usesAc3: MP4 / MKV main mix, or an MKV output track), so PCM and FLAC formats take every rate
 * whatever `audioCodec` says.
 */
export function sampleRateSupported(
  codec: ExportSettings['audioCodec'], sampleRate: number, settings?: Pick<ExportSettings, 'container'> & Partial<Pick<ExportSettings, 'audioOutputs'>>,
): boolean {
  const ac3 = settings ? usesAc3({ ...settings, audioCodec: codec }) : codec === 'ac3';
  return !ac3 || AC3_SAMPLE_RATES.includes(sampleRate);
}

/**
 * Settings with a sample rate the audio codec supports: AC-3 above 48 kHz becomes 48 kHz (other unsupported
 * AC-3 rates the next supported one). Returns `settings` itself when nothing changes.
 */
export function clampSampleRateForCodec(settings: ExportSettings): ExportSettings {
  const sr = settings.sampleRate;
  if (!(sr > 0) || !usesAc3(settings) || AC3_SAMPLE_RATES.includes(sr)) return settings;
  const to = sr > 48000 ? 48000 : AC3_SAMPLE_RATES.find((r) => r >= sr) ?? 48000;
  return { ...settings, sampleRate: to };
}

/** All selectable presets for a sequence: built-ins followed by Match Sequence. */
export function presetsFor(seq: Sequence): ExportPreset[] {
  return [...EXPORT_PRESETS, matchSequencePreset(seq)];
}

function settingEquals(key: keyof ExportSettings, a: ExportSettings[keyof ExportSettings], b: ExportSettings[keyof ExportSettings]): boolean {
  if (key === 'fps') return fpsEquals(a as Rational, b as Rational);
  // Optional format fields: missing means the default (settings saved before 0.8.0).
  if (key === 'audioPerTrack') return (a === true) === (b === true);
  if (key === 'audioBitDepth') return (a === 16 ? 16 : 24) === (b === 16 ? 16 : 24);
  if (key === 'audioOutputs' || key === 'subtitleOutputs') return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  return a === b;
}

/** True when the settings have the preset's format (presetContainer) and every key in the preset equals the settings' value. */
export function matchesPreset(settings: ExportSettings, preset: ExportPreset): boolean {
  const c = presetContainer(preset);
  if (c !== undefined && c !== exportContainer(settings)) return false;
  for (const k of Object.keys(preset.settings) as (keyof ExportSettings)[]) {
    if (k === 'container') continue;
    if (!settingEquals(k, settings[k], preset.settings[k] as ExportSettings[keyof ExportSettings])) return false;
  }
  return true;
}

/**
 * Preset name to display: the preferred (last chosen) preset while the settings still match it, otherwise
 * the first built-in preset that matches, otherwise CUSTOM. "Match Sequence" only describes the format,
 * so it is never auto-detected unless it was the last choice.
 */
export function presetNameFor(settings: ExportSettings, presets: ExportPreset[], preferred?: string): string {
  if (preferred) {
    const pref = presets.find((p) => p.name === preferred);
    if (pref && matchesPreset(settings, pref)) return pref.name;
  }
  const m = presets.find((p) => p.name !== MATCH_SEQUENCE && matchesPreset(settings, p));
  return m ? m.name : CUSTOM;
}

// ---------------------------------------------------------------------------------------------------
// Range / estimates
// ---------------------------------------------------------------------------------------------------

export interface ExportRange { startF: number; endF: number; frames: number; seconds: number; usesInOut: boolean }

/** Export range in frames/seconds at the sequence fps. Falls back to the entire sequence like the render graph. */
export function exportRange(seq: Sequence, settings: Pick<ExportSettings, 'rangeMode'>): ExportRange {
  const total = sequenceDuration(seq);
  const i = seq.view.inPoint, o = seq.view.outPoint;
  if (settings.rangeMode === 'inOut' && i !== null && o !== null && o > i) {
    const startF = Math.max(0, Math.round(i)), endF = Math.round(o);
    return { startF, endF, frames: endF - startF, seconds: framesToSeconds(endF - startF, seq.fps), usesInOut: true };
  }
  return { startF: 0, endF: total, frames: total, seconds: framesToSeconds(total, seq.fps), usesInOut: false };
}

export function hasInOut(seq: Sequence): boolean {
  const i = seq.view.inPoint, o = seq.view.outPoint;
  return i !== null && o !== null && o > i;
}

/** Frame rate the export is encoded at: settings.fps when it passes the shared isValidFps, otherwise the sequence rate (like the render graph). */
export function effectiveExportFps(settings: Pick<ExportSettings, 'fps'>, seq: Sequence): Rational {
  return isValidFps(settings.fps) ? settings.fps : seq.fps;
}

/**
 * Output video frames for `seqFrames` sequence frames: round(seqFrames × outFps / seqFps) (halves up, at least 1),
 * the count electron/export/renderGraph.ts outputFrameIndex produces. Equals seqFrames at the sequence rate.
 */
export function exportOutputFrames(seqFrames: number, seq: Sequence, settings: Pick<ExportSettings, 'fps'>): number {
  const out = effectiveExportFps(settings, seq);
  if (seqFrames <= 0) return 0;
  if (fpsEquals(out, seq.fps)) return seqFrames;
  const n = BigInt(Math.round(seqFrames)) * BigInt(seq.fps.den) * BigInt(out.num);
  const d = BigInt(seq.fps.num) * BigInt(out.den);
  return Math.max(1, Number((2n * n + d) / (2n * d)));
}

export interface SizeEstimate { bytes: number; approximate: boolean }

/**
 * Estimated output size. Bitrate mode: (video + audio bitrate) × duration. CRF mode: a rough bits-per-pixel
 * model (flagged approximate) — real sizes vary a lot with content. MOV: the codec profile's published data rate
 * plus PCM; WAV: exact PCM; FLAC: about 60 % of PCM. `files`: the number of audio files (per-track export).
 */
export function estimateFileSize(settings: ExportSettings, durationSec: number, files = 1): SizeEstimate {
  const d = Math.max(0, durationSec);
  const container = exportContainer(settings);
  if (container !== 'mp4' && container !== 'mkv') {
    // PCM is exact; FLAC compresses film sound to roughly 60 %; ProRes / DNxHR follow their published data rates.
    // A per-track export is the size of one file per track (the dialog passes the file count in `files`).
    const pcm = pcmBitsPerSecond(settings) * (container === 'flac' ? 0.6 : 1) * Math.max(1, files);
    const fps = isValidFps(settings.fps) ? fpsValue(settings.fps) : 24;
    const video = intermediateVideoBitsPerSecond(settings, fps) ?? 0;
    return { bytes: Math.round((video + pcm) / 8 * d), approximate: container !== 'wav' };
  }
  const audioKbps = hasAudioOutputs(settings)
    ? audioOutputsKbps(settings)
    : settings.audioBitrateKbps > 0 ? settings.audioBitrateKbps : (settings.audioChannels === 6 ? 640 : 192);
  if (settings.qualityMode === 'bitrate') {
    const kbps = Math.max(0, settings.videoBitrateKbps) + audioKbps;
    // FLAC output tracks are estimated (about 60 % of PCM).
    return { bytes: Math.round(kbps * 1000 / 8 * d), approximate: hasAudioOutputs(settings) && settings.audioOutputs!.some((o) => o.codec === 'flac') };
  }
  // bits per pixel per frame at CRF 23 for x264 ≈ 0.07 on typical content; each CRF step ≈ ×0.89.
  const crf = Number.isFinite(settings.crf) ? settings.crf : 18;
  const base = settings.videoCodec === 'libx265' ? 0.045 : 0.07;
  const bpp = base * Math.pow(0.89, crf - 23);
  const fps = isValidFps(settings.fps) ? fpsValue(settings.fps) : 24;
  const videoBps = Math.max(2, settings.width) * Math.max(2, settings.height) * fps * bpp;
  const bytes = (videoBps + audioKbps * 1000) / 8 * d;
  return { bytes: Math.round(bytes), approximate: true };
}

/** Total audio rate (kbit/s) of an MKV's output tracks: AAC / AC-3 their bitrate, PCM exact, FLAC about 60 % of PCM. */
function audioOutputsKbps(settings: ExportSettings): number {
  const rate = Math.max(1, settings.sampleRate) * audioBitDepth(settings) / 1000;
  return settings.audioOutputs!.reduce((sum, o) => {
    const ch = o.layout === '5.1' ? 6 : o.layout === 'mono' ? 1 : 2;
    if (o.codec === 'pcm') return sum + rate * ch;
    if (o.codec === 'flac') return sum + rate * ch * 0.6;
    return sum + audioOutputBitrate(o);
  }, 0);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

/** Human ETA from progress (0..1) and elapsed milliseconds; null when it cannot be estimated yet. */
export function estimateEtaSeconds(progress: number, elapsedMs: number): number | null {
  if (!(progress > 0.005) || !(elapsedMs > 500)) return null;
  const total = elapsedMs / progress;
  return Math.max(0, (total - elapsedMs) / 1000);
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(r).padStart(2, '0')}s`;
  return `${r}s`;
}

export function crfLabel(crf: number): string {
  if (crf <= 17) return 'Best';
  if (crf <= 21) return 'High';
  if (crf <= 26) return 'Medium';
  return 'Small';
}

export function fpsOptionValue(fps: Rational): string {
  const p = FPS_PRESETS.find((x) => fpsEquals(x.fps, fps));
  return p ? p.label : `${fps.num}/${fps.den}`;
}

export function fpsFromOptionValue(value: string, fallback: Rational): Rational {
  const p = FPS_PRESETS.find((x) => x.label === value);
  if (p) return p.fps;
  const m = /^(\d+)\/(\d+)$/.exec(value);
  return m ? { num: Number(m[1]), den: Number(m[2]) } : fallback;
}

// ---------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------

export type ExportField = 'fileName' | 'outputDir' | 'width' | 'height' | 'videoBitrateKbps' | 'crf' | 'audioBitrateKbps' | 'sampleRate';
export interface ValidationIssue { field: ExportField; message: string }
export interface ValidationResult { ok: boolean; issues: ValidationIssue[] }

/**
 * Absolute folder path on POSIX (`/…`) or Windows (`C:\…`, `C:/…`, `\\server\share`). The main process requires
 * one (electron/export/renderGraph.ts exportOutputPath): a relative folder would let ffmpeg read a prefix such as
 * `tee:` or `concat:` as a protocol.
 */
function isAbsoluteFolder(dir: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\[^\\])/.test(dir);
}

export function validateExportSettings(settings: ExportSettings): ValidationResult {
  const container = exportContainer(settings);
  const audioOnly = CONTAINERS[container].audioOnly;
  // MP4 and MKV: H.264 / H.265 with a quality setting; their main mix is AAC / AC-3 unless MKV output tracks define the audio.
  const mp4 = container === 'mp4' || container === 'mkv';
  const lossyMain = mp4 && !hasAudioOutputs(settings);
  const issues: ValidationIssue[] = [];
  const name = (settings.fileName ?? '').trim();
  if (!name) issues.push({ field: 'fileName', message: 'Enter a file name.' });
  else if (/[\\/]/.test(name)) issues.push({ field: 'fileName', message: 'The file name cannot contain path separators.' });
  else if (/[:*?"<>|\u0000-\u001f]/.test(name)) issues.push({ field: 'fileName', message: 'The file name contains characters that are not allowed.' });
  if (!(settings.outputDir ?? '').trim()) issues.push({ field: 'outputDir', message: 'Choose an output folder.' });
  else if (!isAbsoluteFolder(settings.outputDir)) {
    issues.push({ field: 'outputDir', message: 'The output folder must be an absolute (full) path, such as /home/me/Videos or C:\\Videos.' });
  }
  // Audio-only formats have no frame size or video quality to check.
  for (const field of audioOnly ? [] : ['width', 'height'] as const) {
    const v = settings[field];
    const label = field === 'width' ? 'Width' : 'Height';
    if (!Number.isInteger(v) || v < MIN_DIMENSION) issues.push({ field, message: `${label} must be at least ${MIN_DIMENSION}.` });
    else if (v > MAX_DIMENSION) issues.push({ field, message: `${label} must be at most ${MAX_DIMENSION}.` });
    else if (v % 2 !== 0) issues.push({ field, message: `${label} must be an even number.` });
  }
  if (videoEncoder(settings)?.codec === 'dnxhd' && !issues.some((i) => i.field === 'width' || i.field === 'height')
    && (settings.width < DNXHR_MIN_WIDTH || settings.height < DNXHR_MIN_HEIGHT)) {
    issues.push({ field: settings.width < DNXHR_MIN_WIDTH ? 'width' : 'height', message: `DNxHR needs a frame of at least ${DNXHR_MIN_WIDTH}×${DNXHR_MIN_HEIGHT}.` });
  }
  if (mp4 && settings.qualityMode === 'bitrate' && !(settings.videoBitrateKbps > 0)) issues.push({ field: 'videoBitrateKbps', message: 'Video bitrate must be greater than 0.' });
  if (mp4 && settings.qualityMode === 'crf' && !(settings.crf >= 0 && settings.crf <= 51)) issues.push({ field: 'crf', message: 'CRF must be between 0 and 51.' });
  if (lossyMain && !(settings.audioBitrateKbps > 0)) issues.push({ field: 'audioBitrateKbps', message: 'Audio bitrate must be greater than 0.' });
  if (!(settings.sampleRate > 0)) issues.push({ field: 'sampleRate', message: 'Sample rate must be greater than 0.' });
  else if (!sampleRateSupported(settings.audioCodec, settings.sampleRate, settings)) {
    issues.push({ field: 'sampleRate', message: `AC-3 audio supports 32, 44.1 and 48 kHz only: choose 48 kHz or less, or ${hasAudioOutputs(settings) ? 'another codec for the AC-3 tracks' : 'AAC'}.` });
  }
  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------------------------------
// Sequence / media inspection
// ---------------------------------------------------------------------------------------------------

/** Ids of media referenced by enabled clips in the sequence (all tracks). */
export function sequenceMediaIds(seq: Sequence): ID[] {
  const out = new Set<ID>();
  for (const t of allTracks(seq)) for (const c of t.clips) out.add(c.mediaId);
  return [...out];
}

/** Highest audio channel count among media used in the sequence (0 when unknown). */
export function maxSourceChannels(seq: Sequence, media: Record<ID, MediaItem>): number {
  let max = 0;
  for (const id of sequenceMediaIds(seq)) {
    const m = media[id];
    if (!m?.probe) continue;
    for (const a of m.probe.audio) max = Math.max(max, a.channels || 0);
  }
  return max;
}

export function sequenceHasSubtitles(seq: Sequence): boolean {
  return seq.subtitleTracks.length > 0;
}

export type ChecklistLevel = 'error' | 'warning' | 'info';
/** Where a checklist item points on the timeline: the dialog's "Show" selects these and moves the playhead there. */
export interface ChecklistTarget { frame: number; clipIds: ID[]; transitionId?: ID }
/** `scope: 'video'`: only about the picture (left out of an audio-only export's list). */
export interface ChecklistItem { level: ChecklistLevel; text: string; target?: ChecklistTarget; scope?: 'video' }

/**
 * Client-side pre-flight checks. An 'error' item blocks the export; warnings and info do not. The timeline warnings
 * (sequenceExportWarnings) cover the export range the settings choose.
 */
export function exportChecklist(seq: Sequence, media: Record<ID, MediaItem>, settings: ExportSettings, projectUsesProxies = false): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const ids = sequenceMediaIds(seq);
  if (sequenceDuration(seq) <= 0) items.push({ level: 'error', text: 'The sequence is empty — nothing to export.' });
  const missing = ids.filter((id) => !media[id]);
  const offline = ids.map((id) => media[id]).filter((m): m is MediaItem => !!m && m.offline);
  const unprobed = ids.map((id) => media[id]).filter((m): m is MediaItem => !!m && !m.offline && !m.probe);
  const failedProbe = unprobed.filter((m) => m.probeError);
  if (missing.length) items.push({ level: 'error', text: `${missing.length} clip source${missing.length > 1 ? 's are' : ' is'} missing from the project.` });
  if (offline.length) items.push({ level: 'error', text: `Offline media used in the sequence: ${offline.map((m) => m.name).join(', ')}. Relink it before exporting.` });
  if (failedProbe.length) items.push({ level: 'warning', text: `Media could not be analyzed: ${failedProbe.map((m) => m.name).join(', ')}. Clips may render as black/silence.` });
  const pending = unprobed.filter((m) => !m.probeError);
  if (pending.length) items.push({ level: 'warning', text: `Media not analyzed yet: ${pending.map((m) => m.name).join(', ')}.` });
  if (settings.rangeMode === 'inOut' && !hasInOut(seq)) items.push({ level: 'warning', text: 'In/Out range is not set; the entire sequence will be exported.' });
  const audioOnly = isAudioOnly(settings);
  // A different (valid) export frame rate is converted at the output (see fpsConversionNote); nothing to check.
  if (!audioOnly && !isValidFps(settings.fps)) items.push({ level: 'warning', text: `The export frame rate is not valid; the sequence frame rate (${fpsLabel(seq.fps)} fps) is used.` });
  const surroundOut = hasAudioOutputs(settings) ? settings.audioOutputs!.some((o) => o.layout === '5.1') : settings.audioChannels === 6;
  if (surroundOut && maxSourceChannels(seq, media) < 6) items.push({ level: 'warning', text: 'No source has 6 audio channels; 5.1 output will be upmixed from stereo.' });
  const burnIn = settings.burnSubtitles && !audioOnly;
  if ((burnIn || settings.exportSubtitleSidecar) && !sequenceHasSubtitles(seq)) items.push({ level: 'warning', text: 'The sequence has no subtitle tracks; nothing will be burned in or written.' });
  if (audioOnly && settings.burnSubtitles && sequenceHasSubtitles(seq)) {
    items.push({ level: 'info', text: 'Subtitle burn-in does not apply to an audio-only format (there is no picture). Use Sidecar to write an .srt next to the audio.' });
  }
  const range = exportRange(seq, settings);
  const timeline = sequenceExportWarnings(seq, media, range.startF, range.endF);
  items.push(...(audioOnly ? timeline.filter((i) => i.scope !== 'video') : timeline));
  items.push(...formatChecks(seq, settings, range));
  items.push(...packagingChecks(seq, settings, range));
  const readyProxies = ids.map((id) => media[id]).filter((m): m is MediaItem => !!m && m.proxy.status === 'ready');
  if (projectUsesProxies && readyProxies.length) items.push({ level: 'info', text: 'Export always uses original media, not proxies.' });
  return items;
}

/** An intermediate export above this estimated size gets a "Large output" warning (a 2-hour 1080p ProRes 422 HQ is about 160 GB). */
export const LARGE_EXPORT_BYTES = 100e9;
/** A plain WAV header cannot describe more than 4 GiB: larger files are written as RF64. */
export const WAV_LIMIT_BYTES = 2 ** 32;

/**
 * Checks that depend on the chosen format: audio-only exports with nothing to write, the file list of a per-track
 * export (and the tracks that get no file), very large intermediates and WAV files that need RF64.
 */
export function formatChecks(seq: Sequence, settings: ExportSettings, range: ExportRange): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const container = exportContainer(settings);
  const audioOnly = CONTAINERS[container].audioOnly;
  let files = 1;
  if (audioOnly && range.frames > 0) {
    const hasAudio = activeTracks(seq.audioTracks).some((t) => t.clips.some((c) => c.enabled && c.start < range.endF && clipEnd(c) > range.startF));
    if (!hasAudio) {
      items.push({ level: 'error', text: 'No enabled audio clips in the export range (on tracks that are not muted): there is no sound to export.' });
      return items;
    }
    if (isPerTrackAudio(settings)) {
      const plan = perTrackAudioPlan(seq, settings, range.startF, range.endF);
      files = plan.files.length;
      items.push({ level: 'info', text: `${files} file${files === 1 ? '' : 's'}, one per audio track, all ${formatDuration(range.seconds)} long: ${namesWithMore(plan.files.map((f) => f.fileName))}.` });
      if (plan.skipped.length) {
        items.push({ level: 'info', text: `No file for ${namesWithMore(plan.skipped.map((k) => `${k.label}${k.track.name && k.track.name !== k.label ? ` ${k.track.name}` : ''} (${PER_TRACK_SKIP_REASON[k.reason]})`))}.` });
      }
    }
  }
  const size = estimateFileSize(settings, range.seconds, files);
  if (container === 'mov' && size.bytes > LARGE_EXPORT_BYTES) {
    items.push({
      level: 'warning',
      text: `Large output: about ${formatBytes(size.bytes)} (${videoEncoder(settings)?.label ?? 'MOV'}, ${formatDuration(range.seconds)}). Check that the output drive has that much free space; a lighter profile (ProRes 422 LT, DNxHR LB or SQ) is smaller.`,
    });
  }
  if (container === 'wav' && size.bytes / files >= WAV_LIMIT_BYTES) {
    items.push({ level: 'info', text: `The WAV will be larger than 4 GB (about ${formatBytes(size.bytes / files)}), so it is written as RF64, which some older programs cannot open. FLAC or a shorter range avoids it.` });
  }
  return items;
}

/**
 * Checks of an MKV's output audio tracks and soft subtitle streams (ROADMAP §7): an output track with no source track
 * (error) or whose sources are all muted / not soloed or have no clips in the range (silent: warning), AC-3 bitrates
 * FFmpeg's encoder refuses, language codes that are not ISO 639-2, subtitle tracks that are gone or have no cues in
 * the range (left out), and more than one default subtitle track.
 */
export function packagingChecks(seq: Sequence, settings: ExportSettings, range: Pick<ExportRange, 'startF' | 'endF'>): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  if (!supportsPackaging(settings)) return items;
  const hasClips = (t: { clips: Clip[] }) => t.clips.some((c) => c.enabled && c.start < range.endF && clipEnd(c) > range.startF);
  if (hasAudioOutputs(settings)) {
    for (const p of audioOutputPlan(seq, settings)) {
      if (!p.allTracks && p.sources.length === 0) {
        items.push({ level: 'error', text: `Audio ${p.name}: choose at least one source track.` });
        continue;
      }
      const mixed = seq.audioTracks.filter((t) => p.mixed.includes(t.id));
      if (mixed.length === 0) items.push({ level: 'warning', text: `Audio ${p.name}: its source tracks are muted or not soloed, so this track will be silent.` });
      else if (!mixed.some(hasClips)) items.push({ level: 'warning', text: `Audio ${p.name}: its source tracks have no clips in the export range, so this track will be silent.` });
      if (!validLanguageCode(p.output.language)) items.push({ level: 'error', text: `Audio ${p.name}: the language "${p.output.language}" is not a three-letter ISO 639-2 code (eng, fre, ger, jpn, ...).` });
      if (p.encoder.codec === 'ac3') {
        const kbps = audioOutputBitrate(p.output);
        if (kbps > AC3_MAX_KBPS) items.push({ level: 'error', text: `Audio ${p.name}: AC-3 supports at most ${AC3_MAX_KBPS} kbps.` });
        else if (p.layout === '5.1' && kbps < AC3_MIN_KBPS_51) items.push({ level: 'error', text: `Audio ${p.name}: AC-3 5.1 needs at least ${AC3_MIN_KBPS_51} kbps.` });
      }
    }
  }
  const chosen = Array.isArray(settings.subtitleOutputs) ? settings.subtitleOutputs : [];
  if (chosen.length) {
    const plan = subtitleOutputPlan(seq.subtitleTracks, settings);
    const missing = chosen.filter((o) => !seq.subtitleTracks.some((t) => t.id === o?.trackId)).length;
    if (missing) items.push({ level: 'warning', text: `${missing} chosen subtitle track${missing === 1 ? ' no longer exists' : 's no longer exist'}; ${missing === 1 ? 'it is' : 'they are'} left out.` });
    const cues = resolveSubtitleCues({ ...seq, subtitleTracks: plan.map((p) => ({ ...(p.track as SequenceSubtitleTrack), enabled: true })) });
    const empty = plan.filter((p) => !cues.some((c) => c.trackId === p.track.id && c.end > range.startF && c.start < range.endF && c.text.trim()));
    if (empty.length) items.push({ level: 'info', text: `Subtitle track${empty.length === 1 ? '' : 's'} ${namesWithMore(empty.map((p) => `"${p.track.name}"`))} ${empty.length === 1 ? 'has' : 'have'} no cues in the export range and ${empty.length === 1 ? 'is' : 'are'} left out.` });
    for (const p of plan) {
      if (!validLanguageCode(p.output.language)) items.push({ level: 'error', text: `Subtitle track "${p.track.name}": the language "${p.output.language}" is not a three-letter ISO 639-2 code.` });
    }
    if (plan.filter((p) => p.isDefault).length > 1) items.push({ level: 'warning', text: 'More than one subtitle track is marked Default; players show only one of them.' });
  }
  return items;
}

/** One-line description of the output's audio for the dialog summary ("AAC 320 kbps", "PCM 24-bit", "2 tracks: ..."). */
export function audioSummary(settings: ExportSettings): string {
  if (hasAudioOutputs(settings)) {
    const outs = settings.audioOutputs!;
    const one = (o: (typeof outs)[number]) => {
      const p = audioOutputPlan({ audioTracks: [] }, { ...settings, audioOutputs: [o] })[0];
      return `${p.encoder.label} ${p.layout === 'stereo' ? 'stereo' : p.layout}`;
    };
    return outs.length === 1 ? one(outs[0]) : `${outs.length} tracks: ${outs.map(one).join(', ')}`;
  }
  return audioEncoder(settings).label;
}

// ---------------------------------------------------------------------------------------------------
// Pre-export warnings about the timeline (frame rates, VFR, sync, transition handles, media ends)
// ---------------------------------------------------------------------------------------------------

/** Names listed in one checklist item before "and N more". */
export const CHECKLIST_NAME_CAP = 3;

/** "a, b, c and 2 more" (the first `cap` entries). */
export function namesWithMore(names: readonly string[], cap = CHECKLIST_NAME_CAP): string {
  const shown = names.slice(0, cap).join(', ');
  return names.length > cap ? `${shown} and ${names.length - cap} more` : shown;
}

const TRANSITION_REASON: Record<TransitionIssueReason, string> = {
  handles: 'not enough source media past the cut',
  clips: 'the clips are shorter than the transition',
  tooShort: 'too short to render',
  overlap: 'overlaps the transition at the other end of the clip',
  notAdjacent: 'the clips are not next to each other',
  rangeEdge: 'at the edge of the export range',
  replaced: 'another transition on the same cut replaces it',
};

interface MediaGroup { media: MediaItem; clips: Clip[]; first: number }

function groupByMedia(segs: readonly ClipSeg[]): MediaGroup[] {
  const by = new Map<ID, MediaGroup>();
  for (const s of segs) {
    const g = by.get(s.media.id);
    if (g) { g.clips.push(s.clip); g.first = Math.min(g.first, s.clip.start); } else by.set(s.media.id, { media: s.media, clips: [s.clip], first: s.clip.start });
  }
  return [...by.values()].sort((a, b) => a.first - b.first);
}

function mediaTarget(groups: readonly MediaGroup[]): ChecklistTarget {
  return { frame: groups[0].first, clipIds: groups.flatMap((g) => g.clips.map((c) => c.id)) };
}

/** Distinct texts in order, each with the first entry that produced it. */
function distinctBy<T>(xs: readonly T[], text: (x: T) => string): { text: string; x: T }[] {
  const seen = new Set<string>();
  const out: { text: string; x: T }[] = [];
  for (const x of xs) { const t = text(x); if (!seen.has(t)) { seen.add(t); out.push({ text: t, x }); } }
  return out;
}

function transitionItem(label: string, issues: TransitionOutcome[], describe: (i: TransitionOutcome) => string): ChecklistItem {
  issues.sort((a, b) => a.cut - b.cut);
  const list = distinctBy(issues, (i) => `"${i.outClip.name}" → "${i.inClip.name}" (${describe(i)})`);
  const first = list[0].x;
  return {
    level: 'warning', text: `${label}: ${namesWithMore(list.map((l) => l.text))}.`,
    target: { frame: first.cut, clipIds: [first.outClip.id, first.inClip.id], transitionId: first.transition.id },
  };
}

/**
 * The timeline warnings for exporting `[startF, endF)` of `seq`, from the plan the render graph uses
 * (shared/exportPlan.ts) over the range it renders:
 * - video clips whose source frame rate differs from the sequence's (constant-rate video media; stills, audio and
 *   VFR media are not compared);
 * - variable-frame-rate (VFR) video media;
 * - linked video / audio clips out of sync (both rendered);
 * - transitions the export drops or shortens (the render graph's handle calculation);
 * - clips that run past the end of their media.
 * Each names the media or clips (the first CHECKLIST_NAME_CAP, then "and N more") and carries a timeline target.
 * Clips on muted tracks, disabled clips, missing or offline media and clips outside the range are left out, as the
 * export leaves them out. O(clips); the last result is reused while the sequence, the media and the range are the
 * same objects / values (the dialog re-runs the checklist on every settings change).
 */
export function sequenceExportWarnings(seq: Sequence, media: Record<ID, MediaItem>, startF: number, endF: number): ChecklistItem[] {
  const m = warningsMemo;
  if (m && m.seq === seq && m.media === media && m.startF === startF && m.endF === endF) return m.items;
  const items = computeSequenceWarnings(seq, media, startF, endF);
  warningsMemo = { seq, media, startF, endF, items };
  return items;
}
let warningsMemo: { seq: Sequence; media: Record<ID, MediaItem>; startF: number; endF: number; items: ChecklistItem[] } | null = null;

/** What the timeline warnings are built from (see sequenceExportWarnings); exported for the parity tests. */
export interface ExportTimelineChecks {
  /** The range the render graph renders: the export range widened so no transition is cut (widenRangeForTransitions). */
  renderStartF: number;
  renderEndF: number;
  /** Clips rendered in the export range (active tracks; one entry per clip). */
  rendered: Clip[];
  /** Video segments in the export range whose (constant) source frame rate differs from the sequence's. */
  fpsMismatch: ClipSeg[];
  /** Video segments in the export range from variable-frame-rate media. */
  vfr: ClipSeg[];
  /** Transitions between two rendered clips and what the export does with them, and clips it renders past the end of
   * their media (render range). */
  transitions: TransitionOutcome[];
  pastEnd: PastEndIssue[];
}

/** The export plan (shared/exportPlan.ts) of every active track over the rendered range, reduced to the checks. */
export function exportTimelineChecks(seq: Sequence, media: Record<ID, MediaItem>, startF: number, endF: number): ExportTimelineChecks {
  const render = widenRangeForTransitions(seq, startF, endF);
  const out: ExportTimelineChecks = { renderStartF: render.startF, renderEndF: render.endF, rendered: [], fpsMismatch: [], vfr: [], transitions: [], pastEnd: [] };
  const scratch: string[] = [];
  for (const [tracks, need] of [[seq.videoTracks, 'video'], [seq.audioTracks, 'audio']] as const) {
    for (const t of activeTracks(tracks)) {
      let plan;
      try { plan = planTrackSegments(t, seq, media, render.startF, render.endF, need, scratch); } catch { continue; } // the export reports it
      finally { scratch.length = 0; }
      for (const s of plan.segs) {
        if (s.kind !== 'clip') continue;
        const a = render.startF + s.start;
        if (a >= endF || a + s.frames <= startF) continue; // only in the widened lead / tail
        out.rendered.push(s.clip);
        // Source frame rate / VFR: video media only (stills and audio have no frame rate to convert).
        const v = s.media.probe?.video;
        if (need !== 'video' || s.media.kind !== 'video' || s.isImage || !v) continue;
        if (v.isVfr) out.vfr.push(s);
        else if (isValidFps(v.fps) && !fpsEquals(v.fps, seq.fps)) out.fpsMismatch.push(s);
      }
      for (const i of plan.transitions) out.transitions.push(i);
      for (const p of plan.pastEnd) out.pastEnd.push(p);
    }
  }
  return out;
}

function computeSequenceWarnings(seq: Sequence, media: Record<ID, MediaItem>, startF: number, endF: number): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  if (!(endF > startF) || !isValidFps(seq.fps)) return items;
  const { rendered, fpsMismatch: fpsOff, vfr, transitions, pastEnd } = exportTimelineChecks(seq, media, startF, endF);
  if (fpsOff.length) {
    const groups = groupByMedia(fpsOff);
    const names = groups.map((g) => `${g.media.name} (${fpsLabel(g.media.probe!.video!.fps)} fps)`);
    items.push({
      level: 'warning', target: mediaTarget(groups), scope: 'video',
      text: `Source frame rate differs from the sequence (${fpsLabel(seq.fps)} fps): ${namesWithMore(names)}. Frames are repeated or dropped to fit, so motion may stutter.`,
    });
  }
  if (vfr.length) {
    const groups = groupByMedia(vfr);
    items.push({
      level: 'warning', target: mediaTarget(groups), scope: 'video',
      text: `Variable frame rate (VFR) media in the sequence: ${namesWithMore(groups.map((g) => g.media.name))}. Frames are repeated or dropped unevenly; convert it to a constant frame rate if motion or sync looks off.`,
    });
  }

  // Linked clips out of sync (both partners rendered).
  const offsets = linkedSyncOffsets([{ clips: rendered }], seq.fps);
  if (offsets.size) {
    const byLink = new Map<ID, { clip: Clip; off: number; ids: ID[] }>();
    for (const c of rendered) {
      const off = offsets.get(c.id);
      if (off === undefined) continue;
      const k = c.linkId ?? c.id;
      const e = byLink.get(k);
      if (!e) byLink.set(k, { clip: c, off, ids: [c.id] });
      else { e.ids.push(c.id); if (c.kind === 'video' && e.clip.kind !== 'video') { e.clip = c; e.off = off; } }
    }
    const list = [...byLink.values()].sort((a, b) => a.clip.start - b.clip.start);
    items.push({
      level: 'warning', target: { frame: list[0].clip.start, clipIds: list.flatMap((e) => e.ids) }, scope: 'video',
      text: `Linked clips out of sync: ${namesWithMore(list.map((e) => `"${e.clip.name}" (${formatSyncOffset(e.off)} frame${Math.abs(e.off) === 1 ? '' : 's'})`))}. Picture and sound will not line up.`,
    });
  }

  // Transitions the export drops or shortens.
  const dropped = transitions.filter((i) => i.reason !== null && i.to === 0);
  const shortened = transitions.filter((i) => i.reason !== null && i.to > 0);
  if (dropped.length) items.push(transitionItem('Transitions dropped (hard cut)', dropped, (i) => TRANSITION_REASON[i.reason!]));
  if (shortened.length) items.push(transitionItem('Transitions shortened', shortened, (i) => `${i.from} → ${i.to} frames, ${TRANSITION_REASON[i.reason!]}`));

  // Clips past the end of their media (a linked video / audio pair counts once).
  if (pastEnd.length) {
    const byClip = new Map<string, { clip: Clip; over: number; ids: ID[] }>();
    for (const p of pastEnd) {
      const k = `${p.clip.linkId ?? p.clip.id}\u0000${p.media.id}`;
      const over = p.srcEnd - p.mediaDur;
      const e = byClip.get(k);
      if (!e) byClip.set(k, { clip: p.clip, over, ids: [p.clip.id] });
      else { e.ids.push(p.clip.id); e.over = Math.max(e.over, over); }
    }
    const list = [...byClip.values()].sort((a, b) => a.clip.start - b.clip.start);
    items.push({
      level: 'warning', target: { frame: list[0].clip.start, clipIds: list.flatMap((e) => e.ids) },
      text: `Clips run past the end of their media: ${namesWithMore(list.map((e) => `"${e.clip.name}" (by ${e.over.toFixed(2)} s)`))}. The last frame is held and the sound is silent there.`,
    });
  }

  // Channel selections (Roadmap §9) the clip's stream cannot honour (another stream picked, a relinked file): the
  // export plays the stream's normal mix instead (renderGraph.ts clipChannelPan).
  const badChannels = rendered.filter((c) => {
    const sel = c.kind === 'audio' ? c.audio.channelSelection : undefined;
    const m = sel ? media[c.mediaId] : undefined;
    return !!m?.probe && !resolveChannelSelection(sel, clipAudioStream(m, c));
  }).sort((a, b) => a.start - b.start);
  if (badChannels.length) {
    items.push({
      level: 'warning', target: { frame: badChannels[0].start, clipIds: badChannels.map((c) => c.id) },
      text: `Channel selection not available in the clip's audio stream: ${namesWithMore(badChannels.map((c) => `"${c.name}" (${channelSelectionLabel(c.audio.channelSelection)}: ${channelSelectionProblem(c.audio.channelSelection, clipAudioStream(media[c.mediaId], c))})`))}. These clips export the stream's normal mix.`,
    });
  }

  // Keyframes (Roadmap §11). The export renders them frame by frame (slower). A keyframed scale is drawn from a copy
  // filtered to its largest size (when below 100 %) and resampled bilinearly per frame (renderGraph.ts motionFilters):
  // well below that size, fine detail can shimmer, as in the preview.
  const animated = rendered.filter((c) => hasKeyframes(c)).sort((a, b) => a.start - b.start);
  if (animated.length) {
    const shimmer = animated.filter((c) => c.kind === 'video' && keyframedScaleRatio(c) < KEYFRAME_SHIMMER_RATIO);
    if (shimmer.length) {
      items.push({
        level: 'warning', target: { frame: shimmer[0].start, clipIds: shimmer.map((c) => c.id) }, scope: 'video',
        text: `Keyframed scale shrinks to less than half of its largest size: ${namesWithMore(shimmer.map((c) => `"${c.name}"`))}. The export resamples the picture per frame without extra filtering there, so fine detail may shimmer at the small end; split the move into clips at different sizes if it shows.`,
      });
    }
    items.push({
      level: 'info', target: { frame: animated[0].start, clipIds: animated.map((c) => c.id) },
      text: `Keyframes on ${animated.length === 1 ? '1 clip' : `${animated.length} clips`}: ${namesWithMore(animated.map((c) => `"${c.name}"`))}. They are rendered frame by frame, so these parts export more slowly.`,
    });
  }
  return items;
}

/** A keyframed scale below this fraction of the size the export pre-filters to gets the "may shimmer" warning. */
export const KEYFRAME_SHIMMER_RATIO = 0.5;

/**
 * Smallest keyframed scale of a clip's visible frames relative to the size the export filters the picture to first
 * (its largest scale when below 100 %, else 100 %): 1 when the scale is not animated.
 */
export function keyframedScaleRatio(c: Clip): number {
  if (!keyframesOf(c, 'scale')) return 1;
  const { min, max } = keyframeRange(c, 'scale', 0, Math.max(0, c.duration - 1));
  const k = max > 0 && max < 0.999 ? max : 1;
  return min / k;
}

/** Explains output frame-rate conversion (sequence rate -> export rate). */
export function fpsConversionNote(seqFps: Rational, outFps: Rational): string {
  const verb = fpsValue(outFps) > fpsValue(seqFps) ? 'repeated' : 'dropped';
  return `Converted from ${fpsLabel(seqFps)} to ${fpsLabel(outFps)} fps: some frames are ${verb}. Duration and audio sync are unchanged.`;
}

export function checklistBlocks(items: ChecklistItem[]): boolean {
  return items.some((i) => i.level === 'error');
}

// ---------------------------------------------------------------------------------------------------
// Persistence (localStorage), guarded so this module stays importable under node.
// ---------------------------------------------------------------------------------------------------

const STORAGE_PREFIX = 'recut.export.v1.';
export interface SavedExportSettings { sequenceId: ID; settings: ExportSettings }

export function loadSavedExportSettings(projectId: ID): SavedExportSettings | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(STORAGE_PREFIX + projectId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedExportSettings;
    if (!parsed || typeof parsed !== 'object' || !parsed.settings) return null;
    return parsed;
  } catch { return null; }
}

export function saveExportSettings(projectId: ID, sequenceId: ID, settings: ExportSettings): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_PREFIX + projectId, JSON.stringify({ sequenceId, settings } satisfies SavedExportSettings));
  } catch { /* quota / private mode */ }
}

/**
 * Settings to show when the dialog opens: saved settings for the project (sanitized against the model),
 * with the file name regenerated when the saved record belongs to another sequence.
 */
export function initialExportSettings(seq: Sequence, saved: SavedExportSettings | null, ctx: ExportDefaultsContext): ExportSettings {
  const defaults = defaultExportSettings(seq, ctx);
  if (!saved) return defaults;
  const s = { ...defaults, ...saved.settings, useProxies: false as const };
  // Settings saved before 0.8.0 have no format fields: they keep the defaults (MP4). Unknown values fall back too.
  s.container = exportContainer(s);
  // MKV output tracks and subtitle streams (0.9.0): malformed entries dropped, tracks that are not in this sequence removed.
  const clean = sanitizePackaging(s, seq);
  if (clean.audioOutputs) s.audioOutputs = clean.audioOutputs; else delete s.audioOutputs;
  if (clean.subtitleOutputs) s.subtitleOutputs = clean.subtitleOutputs; else delete s.subtitleOutputs;
  if (saved.sequenceId !== seq.id) { s.fileName = defaults.fileName; }
  s.fileName = withExportExtension(s.fileName, s.container);
  if (!s.outputDir) s.outputDir = defaults.outputDir;
  if (!isValidFps(s.fps)) s.fps = seq.fps;
  return clampSampleRateForCodec(s);
}

function evenDown(n: number): number {
  const v = Math.max(2, Math.round(n || 0));
  return v % 2 ? v - 1 : v;
}
