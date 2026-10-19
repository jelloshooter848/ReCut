/**
 * Edit one subtitle or transcript line from the timeline (#135): double-click (or right-click › Edit…) a cue in a T
 * lane, the Subtitles row's on-screen transcript, or a timeline subtitle track.
 *
 * A transcript line is the media's own cue, in source seconds: the edit shows wherever that part of the media is used
 * and keeps following its clip. Timing is typed in timeline timecode and converted through the clip, within its range.
 * A timeline subtitle cue is edited in place (attached cues stay attached; Unpin fixes one to the timeline).
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { Clip, ID, Sequence } from '@shared/model';
import { clipEnd, findClip, resolveSubtitleCues } from '@shared/timeline';
import { clipTranscriptTrack } from '@shared/transcripts';
import { Button, Dialog, TimecodeField } from '@/components/ui';
import { useStore } from '@/state';

export type CueRef =
  | { kind: 'transcript'; seqId: ID; clipId: ID; trackId: ID; cueId: ID }
  | { kind: 'subtitle'; seqId: ID; cueId: ID };

/** A T lane / on-screen transcript cue id is `<clip id>:<media cue id>` (shared/transcripts.ts TranscriptCue). */
export function transcriptCueRef(seq: Sequence, timelineCueId: string): CueRef | null {
  const k = timelineCueId.indexOf(':');
  if (k < 0) return null;
  const clipId = timelineCueId.slice(0, k), cueId = timelineCueId.slice(k + 1);
  const clip = findClip(seq, clipId)?.clip;
  const st = useStore.getState();
  const track = clip ? clipTranscriptTrack(clip, st.project.media[clip.mediaId], st.project.subtitleTracks) : null;
  return clip && track ? { kind: 'transcript', seqId: seq.id, clipId, trackId: track.id, cueId } : null;
}

/** Source second shown at timeline frame `f` of `clip`, and back. */
const toSec = (clip: Clip, seq: Sequence, f: number) => clip.sourceIn + ((f - clip.start) * seq.fps.den / seq.fps.num) * clip.speed;
const toFrame = (clip: Clip, seq: Sequence, s: number) => clip.start + Math.round(((s - clip.sourceIn) / clip.speed) * seq.fps.num / seq.fps.den);

interface Resolved { text: string; start: number; end: number; min: number; max: number; pinned: boolean; note: string | null }

function resolve(ref: CueRef): Resolved | null {
  const st = useStore.getState();
  const seq = st.project.sequences[ref.seqId];
  if (!seq) return null;
  if (ref.kind === 'transcript') {
    const clip = findClip(seq, ref.clipId)?.clip;
    const cue = st.project.subtitleTracks[ref.trackId]?.cues.find((c) => c.id === ref.cueId);
    if (!clip || !cue) return null;
    const media = st.project.media[clip.mediaId];
    return {
      text: cue.text, start: Math.max(clip.start, toFrame(clip, seq, cue.start)), end: Math.min(clipEnd(clip), toFrame(clip, seq, cue.end)),
      min: clip.start, max: clipEnd(clip), pinned: true,
      note: `Changes the transcript of ${media?.name ?? 'this media'}: every timeline that uses this part of it shows the edit.`,
    };
  }
  const r = resolveSubtitleCues(seq).find((c) => c.id === ref.cueId);
  const cue = seq.subtitleTracks.flatMap((t) => t.cues).find((c) => c.id === ref.cueId);
  if (!r || !cue) return null;
  const clip = cue.clipId ? findClip(seq, cue.clipId)?.clip : undefined;
  return { text: cue.text, start: r.start, end: r.end, min: clip ? clip.start : 0, max: clip ? clipEnd(clip) : Infinity, pinned: !!clip, note: null };
}

export function CueEditDialog({ cue, onClose }: { cue: CueRef; onClose: () => void }) {
  const project = useStore((s) => s.project);
  const playhead = useStore((s) => s.project.sequences[cue.seqId]?.view.playhead ?? 0);
  const r = useMemo(() => resolve(cue), [cue, project]); // eslint-disable-line react-hooks/exhaustive-deps
  const [text, setText] = useState(r?.text ?? '');
  const [start, setStart] = useState(r?.start ?? 0);
  const [end, setEnd] = useState(r?.end ?? 0);
  useEffect(() => { if (!r) onClose(); }, [r, onClose]);
  if (!r) return null;
  const seq = project.sequences[cue.seqId];
  const fps = seq.fps;
  const st = useStore.getState;

  const save = () => {
    const changedText = text !== r.text;
    const changedTime = start !== r.start || end !== r.end;
    if (!changedText && !changedTime) { onClose(); return; }
    if (cue.kind === 'transcript') {
      const clip = findClip(seq, cue.clipId)?.clip;
      if (!clip) return;
      st().editMediaCue(cue.trackId, cue.cueId, {
        ...(changedText ? { text } : {}), ...(changedTime ? { start: toSec(clip, seq, start), end: toSec(clip, seq, end) } : {}),
      });
    } else {
      st().batch('Edit subtitle', () => {
        if (changedText) st().updateCue(cue.seqId, cue.cueId, { text });
        if (changedTime) st().setCueTiming(cue.seqId, cue.cueId, start, end);
      });
    }
    onClose();
  };
  const remove = () => {
    if (cue.kind === 'transcript') st().removeMediaCue(cue.trackId, cue.cueId); else st().removeCue(cue.seqId, cue.cueId);
    onClose();
  };
  const canSplit = playhead > r.start && playhead < r.end;
  const split = () => {
    if (cue.kind === 'transcript') { const clip = findClip(seq, cue.clipId)?.clip; if (clip) st().splitMediaCue(cue.trackId, cue.cueId, toSec(clip, seq, playhead)); }
    else st().splitCue(cue.seqId, cue.cueId, playhead);
    onClose();
  };
  const next = nextCueId(cue);
  const merge = () => {
    if (!next) return;
    if (cue.kind === 'transcript') st().mergeMediaCues(cue.trackId, [cue.cueId, next]); else st().mergeCues(cue.seqId, [cue.cueId, next]);
    onClose();
  };

  return (
    <Dialog open title={cue.kind === 'transcript' ? 'Edit transcript line' : 'Edit subtitle'} onClose={onClose} width={520} onSubmit={save}
      footer={<>
        <Button variant="ghost" onClick={remove} data-testid="cue-edit-delete">Delete</Button>
        <Button variant="ghost" disabled={!canSplit} onClick={split} title="Split this line at the playhead" data-testid="cue-edit-split">Split at playhead</Button>
        <Button variant="ghost" disabled={!next} onClick={merge} title="Join with the next line" data-testid="cue-edit-merge">Merge with next</Button>
        {cue.kind === 'subtitle' && r.pinned ? (
          <Button variant="ghost" onClick={() => { st().unpinCue(cue.seqId, cue.cueId); onClose(); }} title="Keep this subtitle where it is on the timeline when its clip moves" data-testid="cue-edit-unpin">Unpin from clip</Button>
        ) : null}
        <span className="grow" />
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} data-testid="cue-edit-save">Save</Button>
      </>}>
      <div className="col gap-8" data-testid="cue-edit-dialog">
        <textarea className="input" rows={3} value={text} autoFocus data-testid="cue-edit-text" spellCheck
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } }} />
        <div className="row gap-8">
          <span className="text-sm text-dim">Start</span>
          <TimecodeField value={start} fps={fps} min={r.min} max={end - 1} onChange={setStart} title="Start (timeline)" />
          <span className="text-sm text-dim">End</span>
          <TimecodeField value={end} fps={fps} min={start + 1} max={r.max} onChange={setEnd} title="End (timeline)" />
        </div>
        {r.note ? <div className="text-dim text-xs" data-testid="cue-edit-note">{r.note}</div> : null}
        <div className="text-faint text-xs">Enter saves, Shift+Enter starts a new line.{r.pinned ? ' The line stays with its clip when the clip moves.' : ''}</div>
      </div>
    </Dialog>
  );
}

/** The next line of the same track (for Merge with next), or null. */
function nextCueId(cue: CueRef): ID | null {
  const st = useStore.getState();
  if (cue.kind === 'transcript') {
    const cues = [...(st.project.subtitleTracks[cue.trackId]?.cues ?? [])].sort((a, b) => a.start - b.start);
    const i = cues.findIndex((c) => c.id === cue.cueId);
    return i >= 0 && i + 1 < cues.length ? cues[i + 1].id : null;
  }
  const seq = st.project.sequences[cue.seqId];
  if (!seq) return null;
  const all = resolveSubtitleCues(seq);
  const me = all.find((c) => c.id === cue.cueId);
  if (!me) return null;
  const after = all.filter((c) => c.trackId === me.trackId && c.start >= me.start && c.id !== me.id).sort((a, b) => a.start - b.start);
  return after[0]?.id ?? null;
}
