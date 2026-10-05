/**
 * Pure helpers for the Export dialog: defaults, presets, estimates, validation, range math and the
 * client-side pre-flight checklist. No DOM, no zustand — unit-tested in tests/unit/exportSettings.test.ts.
 */
import type { ExportPreset, ExportSettings, ID, MediaItem, Rational, Sequence } from '@shared/model';
import { EXPORT_PRESETS } from '@shared/model';
import { FPS_PRESETS, fpsEquals, fpsLabel, fpsValue, framesToSeconds, isValidFps } from '@shared/time';
import { allTracks, sequenceDuration } from '@shared/timeline';

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

/** Ensure an .mp4 extension (mirrors electron/export/renderGraph.ts exportOutputPath). */
export function withMp4(name: string): string {
  const n = name.trim();
  if (/\.mp4$/i.test(n)) return n;
  return n.replace(/\.(mov|mkv|m4v|avi)$/i, '') + '.mp4';
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

/** Full output path for the settings (outputDir/fileName.mp4). */
export function outputPathFor(settings: Pick<ExportSettings, 'outputDir' | 'fileName'>): string {
  return joinPath(settings.outputDir, withMp4(settings.fileName || 'export'));
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

/** Applies a preset's partial settings on top of `settings`. Returns a new object. */
export function applyPreset(settings: ExportSettings, preset: ExportPreset): ExportSettings {
  const next: ExportSettings = { ...settings, ...preset.settings, useProxies: false };
  if (preset.settings.audioChannels === 6 && !preset.settings.audioCodec) next.audioCodec = 'ac3';
  return clampSampleRateForCodec(next);
}

/** Sample rates the AC-3 encoder accepts (FFmpeg `ac3`: 48, 44.1 and 32 kHz). */
export const AC3_SAMPLE_RATES = [32000, 44100, 48000];

/** True when `sampleRate` can be encoded with `codec`. */
export function sampleRateSupported(codec: ExportSettings['audioCodec'], sampleRate: number): boolean {
  return codec !== 'ac3' || AC3_SAMPLE_RATES.includes(sampleRate);
}

/**
 * Settings with a sample rate the audio codec supports: AC-3 above 48 kHz becomes 48 kHz (other unsupported
 * AC-3 rates the next supported one). Returns `settings` itself when nothing changes.
 */
export function clampSampleRateForCodec(settings: ExportSettings): ExportSettings {
  const sr = settings.sampleRate;
  if (!(sr > 0) || sampleRateSupported(settings.audioCodec, sr)) return settings;
  const to = sr > 48000 ? 48000 : AC3_SAMPLE_RATES.find((r) => r >= sr) ?? 48000;
  return { ...settings, sampleRate: to };
}

/** All selectable presets for a sequence: built-ins followed by Match Sequence. */
export function presetsFor(seq: Sequence): ExportPreset[] {
  return [...EXPORT_PRESETS, matchSequencePreset(seq)];
}

function settingEquals(key: keyof ExportSettings, a: ExportSettings[keyof ExportSettings], b: ExportSettings[keyof ExportSettings]): boolean {
  if (key === 'fps') return fpsEquals(a as Rational, b as Rational);
  return a === b;
}

/** True when every key in the preset equals the settings' value. */
export function matchesPreset(settings: ExportSettings, preset: ExportPreset): boolean {
  for (const k of Object.keys(preset.settings) as (keyof ExportSettings)[]) {
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
 * model (flagged approximate) — real sizes vary a lot with content.
 */
export function estimateFileSize(settings: ExportSettings, durationSec: number): SizeEstimate {
  const d = Math.max(0, durationSec);
  const audioKbps = settings.audioBitrateKbps > 0 ? settings.audioBitrateKbps : (settings.audioChannels === 6 ? 640 : 192);
  if (settings.qualityMode === 'bitrate') {
    const kbps = Math.max(0, settings.videoBitrateKbps) + audioKbps;
    return { bytes: Math.round(kbps * 1000 / 8 * d), approximate: false };
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
  const issues: ValidationIssue[] = [];
  const name = (settings.fileName ?? '').trim();
  if (!name) issues.push({ field: 'fileName', message: 'Enter a file name.' });
  else if (/[\\/]/.test(name)) issues.push({ field: 'fileName', message: 'The file name cannot contain path separators.' });
  else if (/[:*?"<>|\u0000-\u001f]/.test(name)) issues.push({ field: 'fileName', message: 'The file name contains characters that are not allowed.' });
  if (!(settings.outputDir ?? '').trim()) issues.push({ field: 'outputDir', message: 'Choose an output folder.' });
  else if (!isAbsoluteFolder(settings.outputDir)) {
    issues.push({ field: 'outputDir', message: 'The output folder must be an absolute (full) path, such as /home/me/Videos or C:\\Videos.' });
  }
  for (const field of ['width', 'height'] as const) {
    const v = settings[field];
    const label = field === 'width' ? 'Width' : 'Height';
    if (!Number.isInteger(v) || v < MIN_DIMENSION) issues.push({ field, message: `${label} must be at least ${MIN_DIMENSION}.` });
    else if (v > MAX_DIMENSION) issues.push({ field, message: `${label} must be at most ${MAX_DIMENSION}.` });
    else if (v % 2 !== 0) issues.push({ field, message: `${label} must be an even number.` });
  }
  if (settings.qualityMode === 'bitrate' && !(settings.videoBitrateKbps > 0)) issues.push({ field: 'videoBitrateKbps', message: 'Video bitrate must be greater than 0.' });
  if (settings.qualityMode === 'crf' && !(settings.crf >= 0 && settings.crf <= 51)) issues.push({ field: 'crf', message: 'CRF must be between 0 and 51.' });
  if (!(settings.audioBitrateKbps > 0)) issues.push({ field: 'audioBitrateKbps', message: 'Audio bitrate must be greater than 0.' });
  if (!(settings.sampleRate > 0)) issues.push({ field: 'sampleRate', message: 'Sample rate must be greater than 0.' });
  else if (!sampleRateSupported(settings.audioCodec, settings.sampleRate)) {
    issues.push({ field: 'sampleRate', message: 'AC-3 audio supports 32, 44.1 and 48 kHz only: choose 48 kHz or less, or AAC.' });
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
export interface ChecklistItem { level: ChecklistLevel; text: string }

/** Client-side pre-flight checks. An 'error' item blocks the export. */
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
  // A different (valid) export frame rate is converted at the output (see fpsConversionNote); nothing to check.
  if (!isValidFps(settings.fps)) items.push({ level: 'warning', text: `The export frame rate is not valid; the sequence frame rate (${fpsLabel(seq.fps)} fps) is used.` });
  if (settings.audioChannels === 6 && maxSourceChannels(seq, media) < 6) items.push({ level: 'warning', text: 'No source has 6 audio channels; 5.1 output will be upmixed from stereo.' });
  if ((settings.burnSubtitles || settings.exportSubtitleSidecar) && !sequenceHasSubtitles(seq)) items.push({ level: 'warning', text: 'The sequence has no subtitle tracks; nothing will be burned in or written.' });
  const readyProxies = ids.map((id) => media[id]).filter((m): m is MediaItem => !!m && m.proxy.status === 'ready');
  if (projectUsesProxies && readyProxies.length) items.push({ level: 'info', text: 'Export always uses original media, not proxies.' });
  return items;
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
  if (saved.sequenceId !== seq.id) { s.fileName = defaults.fileName; }
  if (!s.outputDir) s.outputDir = defaults.outputDir;
  if (!isValidFps(s.fps)) s.fps = seq.fps;
  return clampSampleRateForCodec(s);
}

function evenDown(n: number): number {
  const v = Math.max(2, Math.round(n || 0));
  return v % 2 ? v - 1 : v;
}
