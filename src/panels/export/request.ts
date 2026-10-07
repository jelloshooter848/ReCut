/**
 * Builds the ExportRequest the Export dialog sends to the main process. Pure (no DOM, no zustand) so
 * the exact renderer data path is unit-testable (tests/unit/export-safety.test.ts).
 */
import type { ExportSettings, Project, Sequence, SequenceSubtitleTrack } from '@shared/model';
import type { ExportRequest } from '@shared/ipc';
import { framesToSeconds } from '@shared/time';
import { resolveSubtitleCues } from '@shared/timeline';
import { sidecarCandidates } from '@/transcript/providers';
import { sequenceHasSubtitles } from './settings';
import { subtitleOutputPlan } from '@shared/exportFormat';
import { nestedSequencesFor } from '@shared/nest';

/**
 * The parts of the project an export request is built from. `sequences` (for files imported into the
 * subtitle tracks of other sequences / snapshots) is optional only so older callers still compile: pass it.
 */
export type ExportProjectSources = Pick<Project, 'media' | 'subtitleTracks'> & Partial<Pick<Project, 'sequences'>>;

/** Origin of media subtitle tracks made by the Transcript "Subtitle file" provider (SubtitleFileProvider.id). */
const SUBTITLE_FILE_ORIGIN = 'subtitle-file';

/** Files a sequence's subtitle tracks imported their cues from (string entries only: project data may be hostile). */
function sequenceSubtitleSources(tracks: readonly SequenceSubtitleTrack[] | undefined): string[] {
  const out: string[] = [];
  for (const t of Array.isArray(tracks) ? tracks : []) {
    if (Array.isArray(t?.sourcePaths)) for (const p of t.sourcePaths) if (typeof p === 'string' && p) out.push(p);
  }
  return out;
}

/**
 * Every file the project reads from: all media paths and proxy paths (on this sequence or only in a bin),
 * imported media subtitle track files, and the files imported into sequence subtitle tracks (in every
 * sequence and its snapshots). The exporter refuses an output (or its temp / sidecar) that is one of these,
 * so an export can never overwrite a project source asset.
 *
 * Media subtitle tracks made by the "Subtitle file" transcript provider before it recorded its file have no
 * `path`; the file was one of the sidecar names it looks for next to the track's media (of every media item
 * when the track's media is gone), so those names are protected instead.
 */
export function projectSourcePaths(project: ExportProjectSources): string[] {
  const out = new Set<string>();
  const media = Object.values(project.media);
  for (const m of media) {
    if (m.path) out.add(m.path);
    if (m.proxy?.path) out.add(m.proxy.path);
  }
  for (const t of Object.values(project.subtitleTracks ?? {})) {
    if (t.path) out.add(t.path);
    else if (t.origin === SUBTITLE_FILE_ORIGIN) {
      const own = t.mediaId ? project.media[t.mediaId] : undefined;
      for (const m of own ? [own] : media) if (m.path) for (const p of sidecarCandidates(m.path)) out.add(p);
    }
  }
  for (const seq of Object.values(project.sequences ?? {})) {
    for (const p of sequenceSubtitleSources(seq.subtitleTracks)) out.add(p);
    for (const snap of Array.isArray(seq.snapshots) ? seq.snapshots : []) {
      for (const p of sequenceSubtitleSources(snap?.data?.subtitleTracks)) out.add(p);
    }
  }
  return [...out];
}

/**
 * The subtitle tracks an MKV export muxes as soft subtitle streams (`settings.subtitleOutputs`), each with its cues
 * resolved to seconds like the sidecar's. A hidden (disabled) track is included when chosen. Undefined when none.
 */
export function softSubtitleTracks(seq: Sequence, settings: ExportSettings): ExportRequest['subtitleTracks'] {
  const plan = subtitleOutputPlan(seq.subtitleTracks, settings);
  if (plan.length === 0) return undefined;
  const chosen = new Set(plan.map((p) => p.track.id));
  const tracks = seq.subtitleTracks.filter((t) => chosen.has(t.id));
  const cues = resolveSubtitleCues({ ...seq, subtitleTracks: tracks.map((t) => ({ ...t, enabled: true })) });
  return tracks.map((t) => ({
    id: t.id, name: t.name, language: t.language,
    cues: cues.filter((c) => c.trackId === t.id).map((c) => ({ start: framesToSeconds(c.start, seq.fps), end: framesToSeconds(c.end, seq.fps), text: c.text })),
  }));
}

export function buildExportRequest(project: ExportProjectSources, seq: Sequence, settings: ExportSettings): ExportRequest {
  const subtitles = sequenceHasSubtitles(seq)
    ? resolveSubtitleCues(seq).map((c) => ({ start: framesToSeconds(c.start, seq.fps), end: framesToSeconds(c.end, seq.fps), text: c.text }))
    : undefined;
  const subtitleTracks = softSubtitleTracks(seq, settings);
  // Nested sequences (Roadmap §8) travel with the request: the export flattens them into this timeline.
  const nested = nestedSequencesFor(seq, project.sequences ?? {});
  return {
    sequence: seq, ...(Object.keys(nested).length ? { sequences: nested } : {}), media: project.media, settings: { ...settings, useProxies: false }, subtitles, ...(subtitleTracks ? { subtitleTracks } : {}),
    // `seq` may be an edited copy of the project's sequence: its own imported subtitle files count too.
    protectedPaths: [...new Set([...projectSourcePaths(project), ...sequenceSubtitleSources(seq.subtitleTracks)])],
  };
}
