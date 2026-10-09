/**
 * Transcripts on the timeline (#112, #125): a clip's Whisper transcript is read live from its media's Whisper track
 * for the clip's audio stream and source range, in sequence frames, instead of being copied into the sequence when
 * the clip is inserted. The Program monitor (and, later, the Subtitles row) shows the on-screen transcript: the top
 * visible video clip's, falling through to the next clip down when that clip has no transcript or is not heard.
 * Pure: no DOM, no Node.
 */
import type { Clip, ID, MediaItem, Project, Sequence, SubtitleTrack, Track } from './model';
import { clipEnd } from './timeline';

/** One cue of a clip's transcript on the timeline, in sequence frames (words too). */
export interface TranscriptCue {
  /** `<clip id>:<media cue id>`: unique per clip, stable across renders. */
  id: string;
  clipId: ID;
  start: number;
  end: number;
  text: string;
  words?: { start: number; end: number; text: string }[];
}

/** Transcripts of a sequence: per audio track (the T lanes) and per audio clip. */
export interface TranscriptIndex {
  /** Audio track id → its clips' transcript cues, sorted by start. Only tracks with at least one cue. */
  lanes: Map<ID, TranscriptCue[]>;
  /** Audio clip id → its transcript cues, sorted by start. Only clips with at least one cue. */
  byClip: Map<ID, TranscriptCue[]>;
}

/**
 * The Whisper track that holds `clip`'s transcript: the media's Whisper track for the clip's audio stream (the clip's
 * stream, else the media's preferred one, else its first), the latest one when there are several (other languages).
 */
export function clipTranscriptTrack(clip: Clip, media: MediaItem | undefined, tracks: Record<ID, SubtitleTrack>): SubtitleTrack | null {
  if (!media) return null;
  const stream = clip.audioStream ?? media.preferredAudioStream ?? media.probe?.audio[0]?.index;
  let found: SubtitleTrack | null = null;
  for (const id of media.subtitleTrackIds) {
    const t = tracks[id];
    if (t && t.origin === 'whisper' && t.cues.length > 0 && (t.streamIndex === undefined || t.streamIndex === stream)) found = t;
  }
  return found;
}

/** `clip`'s transcript cues in sequence frames: the track's cues over the clip's source range, clamped to the clip. */
export function clipTranscriptCues(clip: Clip, track: SubtitleTrack, fps: { num: number; den: number }): TranscriptCue[] {
  const end = clipEnd(clip);
  const srcOut = clip.sourceIn + (clip.duration * fps.den / fps.num) * clip.speed;
  const frameOf = (sec: number) => clip.start + Math.round((sec - clip.sourceIn) / clip.speed * fps.num / fps.den);
  const out: TranscriptCue[] = [];
  for (const c of track.cues) {
    if (!(c.end > clip.sourceIn && c.start < srcOut)) continue;
    const s = Math.max(clip.start, frameOf(c.start));
    const e = Math.min(end, frameOf(c.end));
    if (e <= s) continue;
    const words = c.words?.map((w) => ({ start: Math.max(s, frameOf(w.start)), end: Math.min(e, frameOf(w.end)), text: w.text }))
      .filter((w) => w.end > w.start);
    out.push({ id: `${clip.id}:${c.id}`, clipId: clip.id, start: s, end: e, text: c.text, ...(words?.length ? { words } : {}) });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Every audio clip's transcript in `seq`: the T lanes and a per-clip lookup. */
export function transcriptIndex(seq: Sequence, media: Record<ID, MediaItem>, tracks: Record<ID, SubtitleTrack>): TranscriptIndex {
  const lanes = new Map<ID, TranscriptCue[]>();
  const byClip = new Map<ID, TranscriptCue[]>();
  for (const t of seq.audioTracks) {
    const lane: TranscriptCue[] = [];
    for (const clip of t.clips) {
      if (!clip.mediaId) continue;
      const tt = clipTranscriptTrack(clip, media[clip.mediaId], tracks);
      if (!tt) continue;
      const cues = clipTranscriptCues(clip, tt, seq.fps);
      if (!cues.length) continue;
      byClip.set(clip.id, cues);
      lane.push(...cues);
    }
    if (lane.length) lanes.set(t.id, lane.sort((a, b) => a.start - b.start));
  }
  return { lanes, byClip };
}

/** Tracks that play: the soloed ones when any is soloed, otherwise every unmuted one (as the playback planner). */
function liveTracks(tracks: readonly Track[]): Set<Track> {
  const anySolo = tracks.some((t) => t.solo);
  return new Set(tracks.filter((t) => (anySolo ? t.solo : !t.muted)));
}

const covers = (c: Clip, frame: number) => c.enabled && c.start <= frame && frame < clipEnd(c);

/**
 * The audio clip whose transcript is on screen at `frame` (#112): the top visible video clip's linked audio clip, if
 * it is heard and has a transcript; otherwise the next video clip down (a B-roll cutaway without a transcript keeps
 * the dialogue's words). With no such video clip, the first heard audio-only clip with a transcript. Null when none.
 * The clip owns the screen for its whole length, so its pauses show nothing rather than another clip's words.
 */
export function onScreenTranscriptClip(seq: Sequence, index: TranscriptIndex, frame: number): ID | null {
  if (index.byClip.size === 0) return null;
  const visible = liveTracks(seq.videoTracks);
  const audible = liveTracks(seq.audioTracks);
  const heard = new Map<string, Clip>();     // linkId → heard audio clip covering the frame
  const audioOnly: Clip[] = [];
  for (const t of seq.audioTracks) {
    if (!audible.has(t)) continue;
    for (const c of t.clips) {
      if (!covers(c, frame) || c.audio.muted) continue;
      if (c.linkId) heard.set(c.linkId, c); else audioOnly.push(c);
    }
  }
  for (let i = seq.videoTracks.length - 1; i >= 0; i--) {
    const t = seq.videoTracks[i];
    if (!visible.has(t)) continue;
    const v = t.clips.find((c) => covers(c, frame));
    const a = v?.linkId ? heard.get(v.linkId) : undefined;
    if (a && index.byClip.has(a.id)) return a.id;
  }
  // Audio with no video on screen: a linked clip whose video is not covering this frame, or an unlinked one.
  const videoLinks = new Set<string>();
  for (const t of seq.videoTracks) for (const c of t.clips) if (c.linkId && covers(c, frame) && visible.has(t)) videoLinks.add(c.linkId);
  for (const c of [...heard.values(), ...audioOnly]) if (!(c.linkId && videoLinks.has(c.linkId)) && index.byClip.has(c.id)) return c.id;
  return null;
}

/** The on-screen transcript cues at `frame` (0 or 1, more only if one clip's cues overlap). */
export function onScreenTranscriptAt(seq: Sequence, index: TranscriptIndex, frame: number): TranscriptCue[] {
  const clipId = onScreenTranscriptClip(seq, index, frame);
  if (!clipId) return [];
  return (index.byClip.get(clipId) ?? []).filter((c) => c.start <= frame && frame < c.end);
}

/**
 * `project` without the Whisper cues that older ReCut builds copied into sequence subtitle tracks (#112): a
 * clip-attached cue is dropped when the clip's media has a Whisper cue with the same text starting at the same source
 * time; a sequence subtitle track left empty is dropped unless it lists source files. Imported or edited cues stay.
 * Returns `project` itself when nothing changes.
 */
export function withoutCopiedTranscripts(project: Project): Project {
  let changed = false;
  const sequences: Record<ID, Sequence> = {};
  for (const [id, seq] of Object.entries(project.sequences)) {
    const clips = new Map<ID, Clip>();
    for (const t of [...seq.videoTracks, ...seq.audioTracks]) for (const c of t.clips) clips.set(c.id, c);
    let seqChanged = false;
    const subtitleTracks = seq.subtitleTracks.flatMap((st) => {
      const cues = st.cues.filter((cue) => {
        const clip = cue.clipId ? clips.get(cue.clipId) : undefined;
        const media = clip?.mediaId ? project.media[clip.mediaId] : undefined;
        if (!media || cue.srcStart === undefined) return true;
        const copy = media.subtitleTrackIds.some((tid) => {
          const t = project.subtitleTracks[tid];
          return t?.origin === 'whisper' && t.cues.some((c) => c.text === cue.text && Math.abs(c.start - cue.srcStart!) < 0.001);
        });
        return !copy;
      });
      if (cues.length === st.cues.length) return [st];
      seqChanged = true;
      return cues.length || st.sourcePaths?.length ? [{ ...st, cues }] : [];
    });
    sequences[id] = seqChanged ? { ...seq, subtitleTracks } : seq;
    changed ||= seqChanged;
  }
  return changed ? { ...project, sequences } : project;
}
