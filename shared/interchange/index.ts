/**
 * Timeline interchange export (Roadmap §10, release 0.9.0): writes one project sequence as an editable timeline
 * for another editor (DaVinci Resolve first) that relinks to the original media files. Export only; import is
 * planned after 1.0. Pure (no DOM, no Node), like the rest of shared/.
 *
 * Contract shared by the core (writers, shared/interchange/*) and the UI (File › Export Timeline…). The UI only
 * calls exportTimeline and INTERCHANGE_FORMATS; the core owns everything else in this folder.
 */
import type { ID, Project } from '../model';
import { allClips, count, isAre, Issues, prepare, safeFileStem } from './common';
import { writeFcpxml } from './fcpxml';
import { writeOtio } from './otio';
import { writeEdl } from './edl';

export type InterchangeFormat = 'fcpxml' | 'otio' | 'edl';

export interface InterchangeFormatInfo {
  label: string;          // e.g. "FCPXML (DaVinci Resolve, Final Cut Pro)"
  extension: string;      // without the dot: "fcpxml", "otio", "edl"
  description: string;    // one sentence for the dialog
}

export const INTERCHANGE_FORMATS: Readonly<Record<InterchangeFormat, InterchangeFormatInfo>> = {
  fcpxml: {
    label: 'FCPXML (DaVinci Resolve, Final Cut Pro)',
    extension: 'fcpxml',
    description: 'Every video and audio track, speed, levels, position, scale, opacity, dissolves and markers.',
  },
  otio: {
    label: 'OpenTimelineIO (DaVinci Resolve 18.5+, other OTIO tools)',
    extension: 'otio',
    description: 'The open interchange format: every track, speed, dissolves and markers.',
  },
  edl: {
    label: 'CMX3600 EDL (any editor)',
    extension: 'edl',
    description: 'Cuts and dissolves only, one file per video track, with up to four audio channels.',
  },
};

export interface InterchangeOptions {
  /** EDL: which video tracks to write (0-based indexes into the flattened sequence's videoTracks); default all. */
  edlVideoTracks?: number[];
}

/** One output file. `name` is a file name without directory (the UI picks the folder / base name). */
export interface InterchangeFile { name: string; contents: string }

/**
 * Something that does not transfer exactly. `kind` groups issues for the report; `count` is how many clips (or
 * items) it affects; `clipIds` are clips of the exported (outer) sequence where known.
 */
export type InterchangeIssueKind =
  | 'keyframes' | 'transform' | 'crop' | 'rotation' | 'opacity' | 'speed' | 'transition' | 'nested'
  | 'disabled' | 'offline' | 'audio-channels' | 'audio-stream' | 'level' | 'subtitles' | 'stills' | 'markers' | 'other';

export interface InterchangeIssue {
  kind: InterchangeIssueKind;
  /** 'info': transferred in another form (e.g. nested sequences flattened); 'warning': lost or approximated. */
  severity: 'info' | 'warning';
  message: string;   // plain sentence for the report, e.g. "Keyframes on 3 clips are not exported; the static value is."
  count: number;
  clipIds?: ID[];
}

export interface InterchangeResult {
  files: InterchangeFile[];
  issues: InterchangeIssue[];
  /**
   * Counts after flattening nested sequences: `clips` = every video and audio clip of the flattened sequence, enabled
   * and disabled (a linked A/V pair counts as 2); `videoTracks` / `audioTracks` = flattened tracks (a nested clip's
   * inner tracks become tracks of their own); `durationFrames` at the sequence rate; `media` = distinct media files.
   */
  summary: { clips: number; videoTracks: number; audioTracks: number; durationFrames: number; media: number };
}

/**
 * Export `sequenceId` of `project` in `format`. Never throws for a valid sequence id; an empty sequence yields a
 * valid empty timeline. Throws Error for an unknown sequence id.
 */
export function exportTimeline(
  project: Project,
  sequenceId: ID,
  format: InterchangeFormat,
  opts: InterchangeOptions = {},
): InterchangeResult {
  const issues = new Issues();
  const p = prepare(project, sequenceId, issues);
  const stem = safeFileStem(p.name);
  let files: InterchangeFile[];
  switch (format) {
    case 'fcpxml': files = [{ name: `${stem}.fcpxml`, contents: writeFcpxml(p, issues) }]; break;
    case 'otio': files = [{ name: `${stem}.otio`, contents: writeOtio(p, issues) }]; break;
    case 'edl': files = writeEdl(p, issues, stem, opts.edlVideoTracks); break;
    default: throw new Error(`exportTimeline: unknown format "${String(format)}"`);
  }
  if (p.subtitleTracks) {
    issues.add('subtitles', 'subtitles', 'warning', (n) => `${count(n, 'subtitle track')} ${isAre(n)} not exported; export subtitles from ReCut as SRT.`, null, p.subtitleTracks);
  }
  const clips = allClips(p);
  return {
    files,
    issues: issues.list(),
    summary: {
      clips: clips.length,
      videoTracks: p.videoTracks.length,
      audioTracks: p.audioTracks.length,
      durationFrames: p.durationFrames,
      media: p.mediaIds.size,
    },
  };
}
