/**
 * Sequence subtitle export / import (pure-ish helpers around the store; dialogs are separated so tests can call
 * the path-taking functions directly). Exposed on `window.__recut.subtitles` for automation.
 */
import type { ID, Project, Sequence } from '../../../shared/model';
import { framesToSeconds, secondsToFrames } from '../../../shared/time';
import { resolveSubtitleCues, type ResolvedCue } from '../../../shared/timeline';
import { parseSubtitles, serializeSrt, serializeVtt } from '../../../shared/subtitles';
import { uid } from '../../../shared/ids';
import { findSamePath, resolveAbsolutePath } from '../../../shared/pathKey';
import { useStore, recutApi } from '@/state';
import { fileNameOf } from '@/state/selectors';
import { projectSourcePaths } from '@/panels/export/request';

export type SubtitleFormat = 'srt' | 'vtt';

/** Resolve cues of every track regardless of its enabled flag (the panel edits disabled tracks too). */
export function resolveAllTracks(seq: Sequence): ResolvedCue[] {
  return resolveSubtitleCues({ ...seq, subtitleTracks: seq.subtitleTracks.map((t) => (t.enabled ? t : { ...t, enabled: true })) });
}

/** Cues (seconds, relative to sequence start) ready for serialization. `trackId` limits to one track; otherwise all enabled tracks. */
export function sequenceCuesInSeconds(seq: Sequence, trackId?: ID): { start: number; end: number; text: string }[] {
  const resolved = trackId ? resolveAllTracks(seq).filter((c) => c.trackId === trackId) : resolveSubtitleCues(seq);
  return resolved.map((c) => ({ start: framesToSeconds(c.start, seq.fps), end: framesToSeconds(c.end, seq.fps), text: c.text }));
}

export function serializeSequenceSubtitles(seq: Sequence, format: SubtitleFormat, trackId?: ID): { content: string; count: number } {
  const cues = sequenceCuesInSeconds(seq, trackId);
  return { content: format === 'vtt' ? serializeVtt(cues) : serializeSrt(cues), count: cues.length };
}

export type ExportResult = { ok: true; path: string; count: number } | { ok: false; error: string };

export type SubtitleExportOptions = { seqId?: ID; trackId?: ID; path: string; format?: SubtitleFormat };

/**
 * Why `path` must not be written by a subtitle export, or null when it may. Refuses relative paths (they
 * would resolve against the main process's working directory) and every project source file
 * (projectSourcePaths: media, proxies, imported subtitle files), compared like the video exporter does.
 * `platform` is the main process's `process.platform`; unknown compares case-insensitively.
 */
export function subtitleExportPathError(
  project: Pick<Project, 'media' | 'subtitleTracks'>, path: string, platform: string | undefined,
): string | null {
  if (resolveAbsolutePath(path, platform) === null) return `Subtitle export needs a full file path, not "${path}".`;
  const hit = findSamePath(path, projectSourcePaths(project), platform);
  if (hit !== undefined) {
    return `Refusing to export subtitles to "${path}": that file is a source file of the project (${hit}). Choose a different file name or folder.`;
  }
  return null;
}

/**
 * Serialize a sequence's subtitles and hand them to `io.writeText`, unless the target is a project source
 * file. Pure apart from `io` (no store, no IPC) so the safety check is unit-testable.
 */
export async function writeSequenceSubtitles(
  project: Pick<Project, 'media' | 'subtitleTracks' | 'sequences' | 'activeSequenceId'>,
  opts: SubtitleExportOptions,
  io: { writeText(path: string, content: string): Promise<void>; platform?: string },
): Promise<ExportResult> {
  const seqId = opts.seqId ?? project.activeSequenceId;
  const seq = seqId ? project.sequences[seqId] : undefined;
  if (!seq) return { ok: false, error: 'No sequence' };
  const refused = subtitleExportPathError(project, opts.path, io.platform);
  if (refused) return { ok: false, error: refused };
  const format: SubtitleFormat = opts.format ?? (/\.vtt$/i.test(opts.path) ? 'vtt' : 'srt');
  const { content, count } = serializeSequenceSubtitles(seq, format, opts.trackId);
  try {
    await io.writeText(opts.path, content);
    return { ok: true, path: opts.path, count };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

let mainPlatform: Promise<string | undefined> | undefined;

/** The main process's `process.platform` (asked once); undefined if it cannot be asked (then retried next time). */
function mainProcessPlatform(api: NonNullable<ReturnType<typeof recutApi>>): Promise<string | undefined> {
  mainPlatform ??= api.appInfo().then((i) => i.platform, () => { mainPlatform = undefined; return undefined; });
  return mainPlatform;
}

/** Write the sequence's subtitles to `path`. No dialogs. Never writes over a project source file. */
export async function exportSequenceSubtitles(opts: SubtitleExportOptions): Promise<ExportResult> {
  const api = recutApi();
  if (!api) return { ok: false, error: 'IPC unavailable' };
  // Paths compare like the main process will see them; an unknown platform compares case-insensitively.
  const platform = await mainProcessPlatform(api);
  return writeSequenceSubtitles(useStore.getState().project, opts, { writeText: (p, c) => api.writeText(p, c), platform });
}

/** Save dialog → exportSequenceSubtitles. */
export async function exportSubtitlesDialog(seqId: ID, format: SubtitleFormat, trackId?: ID): Promise<ExportResult | null> {
  const api = recutApi();
  if (!api) return { ok: false, error: 'IPC unavailable' };
  const seq = useStore.getState().project.sequences[seqId];
  if (!seq) return { ok: false, error: 'No sequence' };
  const track = trackId ? seq.subtitleTracks.find((t) => t.id === trackId) : undefined;
  const base = `${seq.name}${track && seq.subtitleTracks.length > 1 ? `.${track.language || track.name}` : ''}.${format}`.replace(/[\\/:*?"<>|]/g, '_');
  const path = await api.saveFile({ title: `Export ${format.toUpperCase()}`, defaultPath: base, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
  if (!path) return null;
  return exportSequenceSubtitles({ seqId, trackId, path, format });
}

export type ImportResult = { ok: true; count: number; warnings: string[] } | { ok: false; error: string; warnings: string[] };

/** Read an SRT/VTT and add its cues to a sequence track as manual cues at absolute positions (one undo step). */
export async function importSubtitlesToTrack(opts: { seqId: ID; trackId: ID; path: string; offsetFrames?: number }): Promise<ImportResult> {
  const api = recutApi();
  if (!api) return { ok: false, error: 'IPC unavailable', warnings: [] };
  let text: string;
  try { text = await api.readText(opts.path); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e), warnings: [] }; }
  const parsed = parseSubtitles(text);
  if (parsed.cues.length === 0) return { ok: false, error: parsed.warnings[0] ?? 'No cues found', warnings: parsed.warnings };
  const offset = opts.offsetFrames ?? 0;
  const ok = useStore.getState().commit(`Import ${fileNameOf(opts.path)}`, (d) => {
    const seq = d.sequences[opts.seqId];
    const track = seq?.subtitleTracks.find((t) => t.id === opts.trackId);
    if (!seq || !track) return;
    for (const c of parsed.cues) {
      const start = Math.max(0, secondsToFrames(c.start, seq.fps) + offset);
      const duration = Math.max(1, secondsToFrames(c.end, seq.fps) + offset - start);
      track.cues.push({ id: uid('scue'), start, duration, offset: 0, text: c.text });
    }
    track.cues.sort((a, b) => (a.clipId ? a.start : a.start + a.offset) - (b.clipId ? b.start : b.start + b.offset));
  });
  if (!ok) return { ok: false, error: 'Track not found', warnings: parsed.warnings };
  return { ok: true, count: parsed.cues.length, warnings: parsed.warnings };
}

/** Cues attached to clips that no longer exist in the sequence. */
export function orphanCues(seq: Sequence): { trackId: ID; cueId: ID }[] {
  const clipIds = new Set<ID>();
  for (const t of seq.videoTracks) for (const c of t.clips) clipIds.add(c.id);
  for (const t of seq.audioTracks) for (const c of t.clips) clipIds.add(c.id);
  const out: { trackId: ID; cueId: ID }[] = [];
  for (const t of seq.subtitleTracks) for (const c of t.cues) {
    if (c.clipId && (!clipIds.has(c.clipId) || c.srcStart === undefined || c.srcEnd === undefined)) out.push({ trackId: t.id, cueId: c.id });
  }
  return out;
}

export function removeOrphanCues(seqId: ID): number {
  const st = useStore.getState();
  const seq = st.project.sequences[seqId];
  if (!seq) return 0;
  const orphans = orphanCues(seq);
  if (orphans.length === 0) return 0;
  const ids = new Set(orphans.map((o) => o.cueId));
  st.commit(`Remove ${orphans.length} orphan subtitle${orphans.length === 1 ? '' : 's'}`, (d) => {
    const s = d.sequences[seqId];
    if (!s) return;
    for (const t of s.subtitleTracks) t.cues = t.cues.filter((c) => !ids.has(c.id));
  });
  return orphans.length;
}

// Automation hook (Playwright): window.__recut.subtitles.exportSequenceSubtitles({ path }) etc.
if (typeof window !== 'undefined') {
  const w = window as unknown as { __recut?: Record<string, unknown> };
  const api = { exportSequenceSubtitles, importSubtitlesToTrack, serializeSequenceSubtitles, removeOrphanCues, orphanCues };
  if (w.__recut) w.__recut.subtitles = api;
  (w as unknown as Record<string, unknown>).__recutSubtitles = api;
}
