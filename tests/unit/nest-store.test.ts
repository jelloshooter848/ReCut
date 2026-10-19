/**
 * Nested sequence commands (Roadmap §8): Make Compound Clip, Break Apart, Open in Timeline, nesting a sequence,
 * the cycle guards of paste / snapshot restore, trims and speed of nested clips, and undo (one step each).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, resetStore, getUndoLabels, mediaDurationLookup } from '../../src/state/store';
import { createMediaItem, createSequence } from '../../shared/project';
import { allTracks, clipEnd, findClip, resolveSubtitleCues } from '../../shared/timeline';
import { flattenSequence, isNestedClip } from '../../shared/nest';
import { planFrame } from '../../src/playback/planner';
import type { Clip, MediaItem, MediaProbe, Sequence } from '../../shared/model';

const FPS = { num: 24, den: 1 };
function fakeProbe(duration = 100): MediaProbe {
  return {
    container: 'matroska', duration, size: 1000, startTime: 0, browserPlayable: true,
    video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: FPS, avgFps: FPS, isVfr: false },
    audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }], subtitles: [],
  };
}
function fakeMedia(name: string): MediaItem {
  return { ...createMediaItem(`/media/${name}`, name), kind: 'video', probe: fakeProbe() };
}

const S = () => useStore.getState();
const P = () => S().project;
const seqOf = (id: string): Sequence => P().sequences[id];
const clipsOf = (s: Sequence) => allTracks(s).flatMap((t) => t.clips);

let A: MediaItem, B: MediaItem;
let seqId: string;
/** What the preview shows at `f` (media, source time), nested sequences flattened. */
const shown = (id: string, f: number) => planFrame(flattenSequence(seqOf(id), P().sequences, P().media), P().media, f, false)
  .layers.map((l) => `${l.mediaId}@${l.sourceTime.toFixed(4)}`);
const heard = (id: string, f: number) => planFrame(flattenSequence(seqOf(id), P().sequences, P().media), P().media, f, false)
  .audio.map((l) => `${l.mediaId}@${l.sourceTime.toFixed(4)}x${(l.gain * l.trackVolume).toFixed(4)}`).sort();

beforeEach(() => {
  resetStore();
  A = fakeMedia('a.mkv'); B = fakeMedia('b.mkv');
  S().addMedia([A, B]);
  const s = createSequence('Main', FPS);
  S().addSequence(s);
  seqId = s.id;
  // A [0,48) and B [48,96) linked V+A; a cue on B; V2 title-ish clip of A over [60,72).
  S().insertFromSource(seqId, { mediaId: A.id, in: 1, out: 3, atFrame: 0, mode: 'overwrite' });
  S().insertFromSource(seqId, { mediaId: B.id, in: 5, out: 7, atFrame: 48, mode: 'overwrite' });
  S().insertFromSource(seqId, { mediaId: A.id, in: 10, out: 10.5, atFrame: 60, mode: 'overwrite', includeAudio: false, videoTrackId: seqOf(seqId).videoTracks[1].id });
  S().clearHistory();
});

describe('Make Compound Clip', () => {
  it('replaces the selection with nested clips that show exactly the same thing, in one undo step', () => {
    const before = Array.from({ length: 100 }, (_, f) => [shown(seqId, f), heard(seqId, f)]);
    const sel = clipsOf(seqOf(seqId)).filter((c) => c.kind === 'video' && c.start >= 48).map((c) => c.id); // B (+ linked audio) and the V2 clip
    const innerId = S().makeCompoundClip(seqId, sel)!;
    expect(innerId).toBeTruthy();
    expect(getUndoLabels().undo).toBe('Make Compound Clip');
    const outer = seqOf(seqId), inner = seqOf(innerId);
    expect(inner.name).toBe('Nested Timeline 01');
    expect(P().sequenceOrder.indexOf(innerId)).toBe(P().sequenceOrder.indexOf(seqId) + 1);
    const nested = clipsOf(outer).filter(isNestedClip);
    expect(nested.map((c) => [c.kind, c.start, c.duration, c.sequenceId])).toEqual([['video', 48, 48, innerId], ['audio', 48, 48, innerId]]);
    expect(nested[0].linkId).toBeTruthy();
    expect(nested[0].linkId).toBe(nested[1].linkId);
    expect(S().ui.selectedClipIds.sort()).toEqual(nested.map((c) => c.id).sort());
    // The inner sequence holds B (+ audio) at 0 on V1 / A1 and the V2 clip at 12 on V2.
    expect(inner.videoTracks[0].clips.map((c) => [c.mediaId, c.start])).toEqual([[B.id, 0]]);
    expect(inner.videoTracks[1].clips.map((c) => [c.mediaId, c.start])).toEqual([[A.id, 12]]);
    expect(inner.audioTracks[0].clips.map((c) => [c.mediaId, c.start])).toEqual([[B.id, 0]]);
    for (let f = 0; f < 100; f++) {
      expect(shown(seqId, f), `video @${f}`).toEqual(before[f][0]);
      expect(heard(seqId, f), `audio @${f}`).toEqual(before[f][1]);
    }
    S().undo();
    expect(P().sequences[innerId]).toBeUndefined();
    expect(clipsOf(seqOf(seqId)).some(isNestedClip)).toBe(false);
    S().redo();
    expect(clipsOf(seqOf(seqId)).filter(isNestedClip)).toHaveLength(2);
  });

  it('keeps subtitle cues of the nested clips where they were', () => {
    const b = clipsOf(seqOf(seqId)).find((c) => c.mediaId === B.id && c.kind === 'video')!;
    S().addSequenceSubtitleTrack(seqId, { language: 'en' });
    const st = seqOf(seqId).subtitleTracks[0];
    useStore.getState().commit('cue', (d) => {
      d.sequences[seqId].subtitleTracks[0].cues.push({ id: 'cue1', clipId: b.id, srcStart: 5.5, srcEnd: 6, start: 60, duration: 12, offset: 0, text: 'hello' });
    });
    const before = resolveSubtitleCues(seqOf(seqId)).map((c) => [c.start, c.end, c.text]);
    S().makeCompoundClip(seqId, [b.id]);
    expect(resolveSubtitleCues(seqOf(seqId)).map((c) => [c.start, c.end, c.text])).toEqual(before);
    expect(seqOf(seqId).subtitleTracks[0].id).toBe(st.id);
  });

  it('refuses clips on a locked track', () => {
    const t = seqOf(seqId).videoTracks[0];
    S().setTrackFlags(seqId, t.id, { locked: true });
    const n = Object.keys(P().sequences).length;
    expect(S().makeCompoundClip(seqId, [t.clips[0].id])).toBeNull();
    expect(Object.keys(P().sequences)).toHaveLength(n);
  });
});

describe('editing a nested sequence', () => {
  it('propagates edits inside to every place it is nested; a shorter inner sequence leaves the rest black', () => {
    const all = clipsOf(seqOf(seqId)).filter((c) => c.start < 48).map((c) => c.id);
    const innerId = S().makeCompoundClip(seqId, all)!;
    // Nest it a second time in another sequence.
    const other = createSequence('Other', FPS);
    S().addSequence(other, { activate: false });
    expect(S().nestSequence(other.id, innerId, 10)).toHaveLength(2);
    expect(shown(other.id, 10)).toEqual([`${A.id}@1.0000`]);
    expect(getUndoLabels().undo).toBe('Nest timeline');
    // Trim the clip inside: both places follow.
    const innerA = seqOf(innerId).videoTracks[0].clips[0];
    S().trimClipEdge(innerId, innerA.id, 'end', 24, false);
    expect(shown(seqId, 30)).toEqual([]);
    expect(shown(other.id, 40)).toEqual([]);
    expect(shown(other.id, 30)).toEqual([`${A.id}@1.8333`]);
    // The nested clip keeps its in / out.
    expect(clipsOf(seqOf(seqId)).find(isNestedClip)!.duration).toBe(48);
  });

  it('opens the inner sequence at the matching frame', () => {
    const all = clipsOf(seqOf(seqId)).filter((c) => c.start >= 48 && c.kind === 'video').map((c) => c.id);
    const innerId = S().makeCompoundClip(seqId, all)!;
    const n = clipsOf(seqOf(seqId)).find((c) => isNestedClip(c) && c.kind === 'video')!;
    expect(S().openNestedSequence(seqId, n.id, 70)).toBe(true);
    expect(P().activeSequenceId).toBe(innerId);
    expect(seqOf(innerId).view.playhead).toBe(22);
  });

  it('limits trims to the inner sequence and keeps nested clips at 100 %', () => {
    const innerId = S().makeCompoundClip(seqId, [clipsOf(seqOf(seqId)).find((c) => c.mediaId === B.id)!.id])!;
    expect(mediaDurationLookup(P())(innerId)).toBeCloseTo(2, 9);
    const n = clipsOf(seqOf(seqId)).find(isNestedClip)!;
    S().trimClipEdge(seqId, n.id, 'end', 200, false);
    expect(clipEnd(findClip(seqOf(seqId), n.id)!.clip)).toBe(96);
    S().setClipSpeed(seqId, n.id, 2);
    expect(findClip(seqOf(seqId), n.id)!.clip.speed).toBe(1);
  });
});

describe('cycles', () => {
  it('refuses to nest a sequence in itself or in a sequence it contains', () => {
    const innerId = S().makeCompoundClip(seqId, [clipsOf(seqOf(seqId))[0].id])!;
    expect(S().nestSequence(innerId, seqId, 0)).toEqual([]);
    expect(S().nestSequence(seqId, seqId, 0)).toEqual([]);
    expect(S().ui.toasts.at(-1)?.text).toMatch(/already contains|itself/);
    // A paste of the nested clip into its own sequence is refused too.
    const n = clipsOf(seqOf(seqId)).find(isNestedClip)!;
    const copy: Clip = { ...n, id: 'pasted', start: 500 };
    expect(S().placeClipsAction(innerId, [{ trackId: seqOf(innerId).videoTracks[0].id, clip: copy }], 'overwrite')).toBe(false);
  });

  it('refuses to restore a snapshot that would make a cycle', () => {
    const other = createSequence('Other', FPS);
    S().addSequence(other, { activate: false });
    S().nestSequence(other.id, seqId, 0);
    const snap = S().takeSnapshot(other.id, 'with main')!;
    // Remove the nested clips from Other, then nest Other (now empty: 1 frame) in Main.
    useStore.getState().commit('clear', (d) => { for (const t of allTracks(d.sequences[other.id])) t.clips = []; });
    expect(S().nestSequence(seqId, other.id, 300)).toHaveLength(2);
    expect(clipsOf(seqOf(seqId)).some((c) => c.sequenceId === other.id)).toBe(true);
    S().restoreSnapshot(other.id, snap);
    expect(clipsOf(seqOf(other.id)).some(isNestedClip)).toBe(false);
    expect(S().ui.toasts.at(-1)?.text).toMatch(/Cannot restore the snapshot/);
  });
});

describe('Break Apart Compound Clip', () => {
  it('puts the inner clips back where they play, in one undo step', () => {
    const before = Array.from({ length: 100 }, (_, f) => [shown(seqId, f), heard(seqId, f)]);
    const sel = clipsOf(seqOf(seqId)).filter((c) => c.kind === 'video' && c.start >= 48).map((c) => c.id);
    S().makeCompoundClip(seqId, sel);
    const n = clipsOf(seqOf(seqId)).find((c) => isNestedClip(c) && c.kind === 'video')!;
    const ids = S().breakApartCompoundClip(seqId, n.id);
    expect(ids).toHaveLength(3);
    expect(getUndoLabels().undo).toBe('Break Apart Compound Clip');
    expect(clipsOf(seqOf(seqId)).some(isNestedClip)).toBe(false);
    for (let f = 0; f < 100; f++) {
      expect(shown(seqId, f), `video @${f}`).toEqual(before[f][0]);
      expect(heard(seqId, f), `audio @${f}`).toEqual(before[f][1]);
    }
  });
});
