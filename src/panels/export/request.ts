/**
 * Builds the ExportRequest the Export dialog sends to the main process. Pure (no DOM, no zustand) so
 * the exact renderer data path is unit-testable (tests/unit/export-safety.test.ts).
 */
import type { ExportSettings, Project, Sequence } from '@shared/model';
import type { ExportRequest } from '@shared/ipc';
import { framesToSeconds } from '@shared/time';
import { resolveSubtitleCues } from '@shared/timeline';
import { sequenceHasSubtitles } from './settings';

/** The parts of the project an export request is built from. */
export type ExportProjectSources = Pick<Project, 'media' | 'subtitleTracks'>;

/**
 * Every file the project reads from: all media paths and proxy paths (on this sequence or only in a bin)
 * and imported subtitle track files. The exporter refuses an output (or its temp / sidecar) that is one
 * of these, so an export can never overwrite a project source asset.
 */
export function projectSourcePaths(project: ExportProjectSources): string[] {
  const out = new Set<string>();
  for (const m of Object.values(project.media)) {
    if (m.path) out.add(m.path);
    if (m.proxy?.path) out.add(m.proxy.path);
  }
  for (const t of Object.values(project.subtitleTracks ?? {})) if (t.path) out.add(t.path);
  return [...out];
}

export function buildExportRequest(project: ExportProjectSources, seq: Sequence, settings: ExportSettings): ExportRequest {
  const subtitles = sequenceHasSubtitles(seq)
    ? resolveSubtitleCues(seq).map((c) => ({ start: framesToSeconds(c.start, seq.fps), end: framesToSeconds(c.end, seq.fps), text: c.text }))
    : undefined;
  return {
    sequence: seq, media: project.media, settings: { ...settings, useProxies: false }, subtitles,
    protectedPaths: projectSourcePaths(project),
  };
}
