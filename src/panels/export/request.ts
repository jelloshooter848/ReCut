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
import { flattenSequence, nestedSequencesFor } from '@shared/nest';
import { clipTranscriptTrack, onScreenTranscript, transcriptIndex } from '@shared/transcripts';
import { allTracks } from '@shared/timeline';

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

/** Id of the subtitle track an export adds for the on-screen transcript (#127). */
export const TRANSCRIPT_EXPORT_TRACK_ID = 'transcript';

/**
 * The on-screen transcript of `seq` (#126: what the Subtitles row and the Program monitor show), as a sequence subtitle
 * track named "Transcript" with free cues in frames, or null when the sequence has no transcript. Nested sequences
 * are flattened first, as the Program monitor does, so transcripts inside them count.
 */
export function transcriptExportTrack(project: ExportProjectSources, seq: Sequence): SequenceSubtitleTrack | null {
  const flat = flattenSequence(seq, project.sequences ?? {}, project.media);
  const cues = onScreenTranscript(flat, transcriptIndex(flat, project.media, project.subtitleTracks));
  if (!cues.length) return null;
  const firstClip = allTracks(flat).flatMap((t) => t.clips).find((c) => c.id === cues[0].clipId);
  const source = firstClip?.mediaId ? clipTranscriptTrack(firstClip, project.media[firstClip.mediaId], project.subtitleTracks) : null;
  return {
    id: TRANSCRIPT_EXPORT_TRACK_ID, name: 'Transcript', language: source?.language ?? 'und', enabled: true,
    cues: cues.map((c) => ({ id: c.id, start: c.start, duration: c.end - c.start, offset: 0, text: c.text })),
  };
}

/** `seq` with the transcript track added when `settings.includeTranscripts` is on and there is a transcript (#127). */
export function withTranscriptTrack(project: ExportProjectSources, seq: Sequence, settings: Pick<ExportSettings, 'includeTranscripts'>): Sequence {
  if (!settings.includeTranscripts || seq.subtitleTracks.some((t) => t.id === TRANSCRIPT_EXPORT_TRACK_ID)) return seq;
  const track = transcriptExportTrack(project, seq);
  return track ? { ...seq, subtitleTracks: [...seq.subtitleTracks, track] } : seq;
}

/** Word timing (sequence frames) of the transcript track's cues, by cue id: burn-in highlighting needs it (#134). */
function transcriptWords(project: ExportProjectSources, seq: Sequence): Map<string, { start: number; end: number; text: string }[]> {
  const flat = flattenSequence(seq, project.sequences ?? {}, project.media);
  const out = new Map<string, { start: number; end: number; text: string }[]>();
  for (const c of onScreenTranscript(flat, transcriptIndex(flat, project.media, project.subtitleTracks))) if (c.words?.length) out.set(c.id, c.words);
  return out;
}

export function buildExportRequest(project: ExportProjectSources, source: Sequence, settings: ExportSettings): ExportRequest {
  const seq = withTranscriptTrack(project, source, settings);
  const words = settings.includeTranscripts && settings.highlightWords ? transcriptWords(project, source) : new Map();
  const toSeconds = (w: { start: number; end: number; text: string }) => ({ start: framesToSeconds(w.start, seq.fps), end: framesToSeconds(w.end, seq.fps), text: w.text });
  const subtitles = sequenceHasSubtitles(seq)
    ? resolveSubtitleCues(seq).map((c) => {
      const w = (c.trackId === TRANSCRIPT_EXPORT_TRACK_ID ? words.get(c.id) : undefined) ?? (settings.highlightWords ? c.words : undefined);
      return { start: framesToSeconds(c.start, seq.fps), end: framesToSeconds(c.end, seq.fps), text: c.text, ...(w?.length ? { words: w.map(toSeconds) } : {}) };
    })
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
