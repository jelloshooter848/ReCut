/**
 * Timeline edge cases driven through store actions (what the UI calls). Failing test = reproduced bug.
 */
import { describe, it, expect } from 'vitest';
import { useStore } from '../../src/state/store';
import { normalizeProject } from '../../shared/project';
import { allTracks, clipEnd, findClip, resolveSubtitleCues, sequenceDuration, maxDurationFrom } from '../../shared/timeline';
import { S, fresh, insert, clipsOf, mediaSubs, comparable } from './helpers';

const v = (f: ReturnType<typeof fresh>, i = 0) => f.seq().videoTracks[i];
const a = (f: ReturnType<typeof fresh>, i = 0) => f.seq().audioTracks[i];
const lay = (t: { clips: { start: number; duration: number }[] }) => t.clips.map((c) => [c.start, c.start + c.duration]);

describe('razor', () => {
  it('razor exactly at a clip start / end is a no-op (no history entry, nothing created)', () => {
    const f = fresh();
    insert(f, 0, 5, 0); // 0..120
    const before = comparable(S().project);
    const h = S().history.past.length;
    expect(S().razor(f.seqId, 0)).toEqual([]);
    expect(S().razor(f.seqId, 120)).toEqual([]);
    expect(S().history.past.length).toBe(h);
    expect(comparable(S().project)).toEqual(before);
  });

  it('razor keeps linked tails linked to each other, not to the heads', () => {
    const f = fresh();
    insert(f, 0, 5, 0);
    const [vh, ah] = clipsOf(f.seq());
    const tails = S().razor(f.seqId, 60);
    expect(tails.length).toBe(2);
    const t0 = findClip(f.seq(), tails[0])!.clip, t1 = findClip(f.seq(), tails[1])!.clip;
    expect(t0.linkId).toBe(t1.linkId);
    expect(t0.linkId).not.toBe(findClip(f.seq(), vh.id)!.clip.linkId);
    expect(findClip(f.seq(), vh.id)!.clip.linkId).toBe(findClip(f.seq(), ah.id)!.clip.linkId);
  });
});

describe('ripple delete / locked tracks', () => {
  it('ripple delete of the last clip just removes it', () => {
    const f = fresh();
    insert(f, 0, 5, 0); insert(f, 0, 5, 120); insert(f, 0, 5, 240);
    const last = v(f).clips[2];
    S().select([last.id, a(f).clips[2].id]); // UI selects the linked pair
    S().rippleDeleteSelected(f.seqId);
    expect(lay(v(f))).toEqual([[0, 120], [120, 240]]);
    expect(lay(a(f))).toEqual([[0, 120], [120, 240]]);
  });

  it('ripple delete with a locked track leaves that track in place and still closes the gap elsewhere', () => {
    const f = fresh();
    insert(f, 0, 5, 0); insert(f, 0, 5, 120); insert(f, 0, 5, 240);
    S().setTrackFlags(f.seqId, a(f).id, { locked: true });
    const first = v(f).clips[0];
    S().select([first.id, a(f).clips[0].id]); // linked pair selected; the audio half sits on the locked track
    S().rippleDeleteSelected(f.seqId);
    expect(lay(v(f))).toEqual([[0, 120], [120, 240]]);
    expect(lay(a(f))).toEqual([[0, 120], [120, 240], [240, 360]]);
  });

  it('a clip on a locked track cannot be deleted / ripple-deleted / moved', () => {
    const f = fresh();
    insert(f, 0, 5, 0);
    S().setTrackFlags(f.seqId, v(f).id, { locked: true });
    const vc = v(f).clips[0];
    S().select([vc.id]);
    S().deleteSelected(f.seqId);
    expect(v(f).clips.length).toBe(1);
    S().rippleDeleteSelected(f.seqId);
    expect(v(f).clips.length).toBe(1);
    expect(S().moveClips(f.seqId, [{ clipId: vc.id, toTrackId: v(f, 1).id, toStart: 50 }], 'overwrite')).toBe(false);
    expect(v(f).clips[0].start).toBe(0);
  });

  it('moving a clip onto a locked destination track is refused without side effects', () => {
    const f = fresh();
    insert(f, 0, 5, 0);
    S().setTrackFlags(f.seqId, v(f, 1).id, { locked: true });
    const before = comparable(S().project);
    expect(S().moveClips(f.seqId, [{ clipId: v(f).clips[0].id, toTrackId: v(f, 1).id, toStart: 0 }], 'overwrite')).toBe(false);
    expect(comparable(S().project)).toEqual(before);
  });

  it('insert into an explicitly locked target track returns [] (caller toasts) and does not throw', () => {
    const f = fresh();
    S().setTrackFlags(f.seqId, v(f).id, { locked: true });
    expect(() => insert(f, 0, 5, 0, 'insert', { videoTrackId: v(f).id })).not.toThrow();
    expect(insert(f, 0, 5, 0, 'insert', { videoTrackId: v(f).id })).toEqual([]);
    expect(clipsOf(f.seq()).length).toBe(0);
  });
});

describe('moving beyond frame 0', () => {
  it('moveClips with a multi-clip selection pushed past frame 0 must keep relative spacing (no clip overwrites another)', () => {
    const f = fresh();
    insert(f, 0, 5, 0); insert(f, 0, 5, 120); // two clips per track: 0..120, 120..240
    const [c0, c1] = v(f).clips;
    // Simulate a drag of both by -150 (UI clamps, but the store API is also used by paste/automation).
    S().moveClips(f.seqId, [
      { clipId: c0.id, toTrackId: v(f).id, toStart: -150 },
      { clipId: c1.id, toTrackId: v(f).id, toStart: -30 },
    ], 'overwrite');
    expect(v(f).clips.length, 'one of the clips was overwritten because both were clamped to 0').toBe(2);
  });

  it('nudge clamps the whole selection so the earliest clip lands on 0 and nothing is lost', () => {
    const f = fresh();
    insert(f, 0, 5, 10); insert(f, 0, 5, 130);
    S().select(v(f).clips.map((c) => c.id));
    S().nudgeSelected(-100, f.seqId);
    expect(lay(v(f))).toEqual([[0, 120], [120, 240]]);
  });

  it('nudge with nothing selected is a no-op without a history entry', () => {
    const f = fresh();
    insert(f, 0, 5, 0);
    const h = S().history.past.length;
    S().select([], 'clear');
    S().nudgeSelected(5, f.seqId);
    expect(S().history.past.length).toBe(h);
  });
});

describe('trim / slip / speed limits', () => {
  it('trim past media end clamps to the media duration', () => {
    const f = fresh({ duration: 10 }); // 240 frames of media
    insert(f, 0, 4, 0); // 96 frames
    const c = v(f).clips[0];
    S().trimClipEdge(f.seqId, c.id, 'end', 5000, false);
    expect(v(f).clips[0].duration).toBe(240);
    S().trimClipEdge(f.seqId, c.id, 'start', -500, false);
    expect(v(f).clips[0].start).toBe(0);
  });

  it('a 4000-frame clip can be trimmed down to exactly 1 frame but never 0', () => {
    const f = fresh({ duration: 1000 });
    insert(f, 0, 4000 / 24, 0);
    const c = v(f).clips[0];
    expect(c.duration).toBe(4000);
    S().trimClipEdge(f.seqId, c.id, 'end', 1, false);
    expect(v(f).clips[0].duration).toBe(1);
    S().trimClipEdge(f.seqId, c.id, 'end', 0, false);
    expect(v(f).clips[0].duration).toBe(1);
    S().trimClipEdge(f.seqId, c.id, 'start', 5000, false);
    expect(v(f).clips[0].duration).toBe(1);
  });

  it('slip clamps at both media bounds', () => {
    const f = fresh({ duration: 10 });
    insert(f, 2, 6, 0); // sourceIn 2s, 96 frames
    const c = v(f).clips[0];
    S().slip(f.seqId, c.id, -1000);
    expect(v(f).clips[0].sourceIn).toBe(0);
    S().slip(f.seqId, c.id, 1000);
    expect(v(f).clips[0].sourceIn).toBeCloseTo(6, 6); // 10 s - 4 s
  });

  it('slipping a clip that is longer than its media (e.g. after relink to a shorter file) must not move it the wrong way', () => {
    const f = fresh({ duration: 10 });
    insert(f, 5, 10, 0); // sourceIn 5, 120 frames
    const c = v(f).clips[0];
    // relink to a 7-second file: clip now extends 3 s past media end
    S().setMediaProbe(f.media.id, { ...f.media.probe!, duration: 7 });
    S().slip(f.seqId, c.id, +10); // user slips 10 frames to the right (later material)
    expect(v(f).clips[0].sourceIn, 'slip(+10) moved sourceIn backwards').toBeGreaterThanOrEqual(5);
  });

  it('speed 0 / negative / NaN / Infinity are rejected; 10000% works without NaN', () => {
    const f = fresh();
    insert(f, 0, 5, 0);
    const c = v(f).clips[0];
    const h = S().history.past.length;
    for (const sp of [0, -1, NaN, Infinity, -Infinity]) S().setClipSpeed(f.seqId, c.id, sp);
    expect(S().history.past.length).toBe(h);
    expect(v(f).clips[0].speed).toBe(1);
    S().setClipSpeed(f.seqId, c.id, 100);
    expect(v(f).clips[0].speed).toBe(100);
    expect(v(f).clips[0].duration).toBe(1);
    S().setClipSpeed(f.seqId, c.id, 0.01, { ripple: true });
    expect(v(f).clips[0].duration).toBe(10000); // 1 frame @100x → 100 source frames → 10000 frames @0.01x
    expect(Number.isFinite(sequenceDuration(f.seq()))).toBe(true);
  });

  it('a negative speed loaded from a project file is repaired by normalizeProject', () => {
    const f = fresh();
    insert(f, 0, 5, 0);
    const json = JSON.parse(JSON.stringify(S().project));
    json.sequences[f.seqId].videoTracks[0].clips[0].speed = -1;
    json.sequences[f.seqId].audioTracks[0].clips[0].speed = NaN;
    const p = normalizeProject(json);
    const cv = p.sequences[f.seqId].videoTracks[0].clips[0];
    expect(cv.speed, 'negative speed survives load; trim/slip math then yields 0 handles').toBeGreaterThan(0);
    expect(maxDurationFrom(cv.sourceIn, cv.speed, 100, p.sequences[f.seqId].fps)).toBeGreaterThan(0);
  });
});

describe('transitions', () => {
  it('a transition longer than its clips is clamped to the shorter clip', () => {
    const f = fresh();
    insert(f, 0, 1, 0); insert(f, 0, 5, 24); // 24-frame clip then 120-frame clip
    const tr = S().addTransitionAtCut(f.seqId, v(f).id, 24, 'crossDissolve', 500)!;
    expect(tr.duration).toBe(24);
  });

  it('transitions on both ends of a short clip must not overlap (in + out <= clip duration)', () => {
    const f = fresh();
    insert(f, 0, 5, 0); insert(f, 0, 0.5, 120); insert(f, 0, 5, 132); // 12-frame middle clip
    S().addTransitionAtCut(f.seqId, v(f).id, 120, 'crossDissolve', 12);
    S().addTransitionAtCut(f.seqId, v(f).id, 132, 'crossDissolve', 12);
    const trs = v(f).transitions;
    expect(trs.length).toBe(2);
    expect(trs[0].duration + trs[1].duration, 'overlapping transitions accepted by the model (export silently drops one)').toBeLessThanOrEqual(12);
  });

  it('deleting a clip removes the transitions attached to it and prunes the selection', () => {
    const f = fresh();
    insert(f, 0, 5, 0); insert(f, 0, 5, 120);
    const tr = S().addTransitionAtCut(f.seqId, v(f).id, 120, 'crossDissolve', 24)!;
    S().selectTransition(tr.id);
    S().select([v(f).clips[1].id]);
    S().deleteSelected(f.seqId);
    expect(v(f).transitions.length).toBe(0);
    expect(S().ui.selectedClipIds).toEqual([]);
    expect(S().ui.selectedTransitionId).toBeNull();
  });

  it('a transition whose clips vanished in the project file does not survive normalizeProject', () => {
    const f = fresh();
    insert(f, 0, 5, 0); insert(f, 0, 5, 120);
    S().addTransitionAtCut(f.seqId, v(f).id, 120, 'crossDissolve', 24);
    const json = JSON.parse(JSON.stringify(S().project));
    json.sequences[f.seqId].videoTracks[0].clips.splice(1, 1); // clip removed, transition stays
    const p = normalizeProject(json);
    expect(p.sequences[f.seqId].videoTracks[0].transitions.length, 'dangling transition loaded').toBe(0);
  });
});

describe('link / unlink / enable', () => {
  it('link on a mixed selection (already-linked pair + loose clip) joins all three; unlink splits', () => {
    const f = fresh();
    insert(f, 0, 5, 0); insert(f, 0, 5, 120);
    const [p0, p1] = v(f).clips; const [a0] = a(f).clips;
    S().select([p0.id, p1.id, a0.id]);
    S().linkSelected(f.seqId);
    const ids = new Set([p0, p1, a0].map((c) => findClip(f.seq(), c.id)!.clip.linkId));
    expect(ids.size).toBe(1);
    S().select([p1.id]);
    S().unlinkSelected(f.seqId);
    expect(findClip(f.seq(), p1.id)!.clip.linkId).toBeNull();
    expect(findClip(f.seq(), p0.id)!.clip.linkId).toBe(findClip(f.seq(), a0.id)!.clip.linkId);
  });

  it('toggle enabled on a selection flips each clip', () => {
    const f = fresh();
    insert(f, 0, 5, 0);
    S().select(clipsOf(f.seq()).map((c) => c.id));
    S().toggleClipEnabledSelected(f.seqId);
    expect(clipsOf(f.seq()).every((c) => !c.enabled)).toBe(true);
  });
});

describe('lift / extract / markers / story blocks', () => {
  it('extract with in == out and lift with in > out (swapped by setView) behave', () => {
    const f = fresh();
    insert(f, 0, 5, 0);
    S().setView(f.seqId, { inPoint: 50, outPoint: 50 });
    const h = S().history.past.length;
    S().extractInOut(f.seqId);
    expect(S().history.past.length).toBe(h);
    S().setView(f.seqId, { inPoint: 80, outPoint: 20 });
    expect(f.seq().view.inPoint).toBe(20);
    S().liftInOut(f.seqId);
    expect(lay(v(f))).toEqual([[0, 20], [80, 120]]);
  });

  it('markers beyond the sequence end are allowed; negative times are clamped (add and update)', () => {
    const f = fresh();
    const id = S().addMarker(f.seqId, { time: 99999, name: 'far' })!;
    expect(f.seq().markers[0].time).toBe(99999);
    const id2 = S().addMarker(f.seqId, { time: -5, name: 'neg' })!;
    expect(f.seq().markers.find((m) => m.id === id2)!.time).toBe(0);
    S().updateMarker(f.seqId, id, { time: -40 });
    expect(f.seq().markers.find((m) => m.id === id)!.time, 'updateMarker accepts a negative time').toBeGreaterThanOrEqual(0);
  });

  it('story blocks shift with ripple delete and a block fully inside the removed range disappears', () => {
    const f = fresh();
    insert(f, 0, 5, 0); insert(f, 0, 5, 120); insert(f, 0, 5, 240);
    S().addStoryBlock(f.seqId, { start: 240, end: 360, name: 'after' });
    S().addStoryBlock(f.seqId, { start: 130, end: 200, name: 'inside' });
    S().addStoryBlock(f.seqId, { start: 60, end: 180, name: 'straddle' });
    S().select([v(f).clips[1].id]);
    S().rippleDeleteSelected(f.seqId); // removes [120,240)
    const by = (n: string) => f.seq().storyBlocks.find((b) => b.name === n);
    expect([by('after')!.start, by('after')!.end]).toEqual([120, 240]);
    expect([by('straddle')!.start, by('straddle')!.end]).toEqual([60, 120]);
    expect(by('inside'), 'block fully inside the deleted range survives as a 1-frame zombie').toBeUndefined();
  });
});

describe('subtitle cues follow edits', () => {
  function withCues() {
    const f = fresh();
    S().addMediaSubtitleTrack(mediaSubs(f.media.id, [
      { start: 1, end: 2, text: 'A' },      // frames 24..48 of a clip starting at source 0
      { start: 1.5, end: 2.5, text: 'A2' }, // overlaps A
      { start: 3, end: 4, text: 'B' },
    ]));
    insert(f, 0, 5, 0); // 0..120
    return f;
  }
  const texts = (f: ReturnType<typeof fresh>) => resolveSubtitleCues(f.seq()).map((c) => `${c.text}@${c.start}-${c.end}`);

  it('carrySubtitles copies overlapping cues (overlaps kept) anchored to the clip', () => {
    const f = withCues();
    expect(texts(f)).toEqual(['A@24-48', 'A2@36-60', 'B@72-96']);
  });

  it('razor keeps cue positions; a cue spanning the cut must not lose its second half', () => {
    const f = withCues();
    S().razor(f.seqId, 40); // inside cue A (24..48) and A2 (36..60)
    const t = texts(f);
    expect(t).toContain('B@72-96');
    expect(t.some((x) => x.startsWith('A@24-48')), 'cue A truncated at the razor point').toBe(true);
    expect(t.some((x) => x.startsWith('A2@36-60')), 'cue A2 truncated at the razor point').toBe(true);
  });

  it('cues follow a moved clip, a ripple delete and a speed change', () => {
    const f = withCues();
    S().razor(f.seqId, 60);
    const tail = v(f).clips[1];
    S().moveClips(f.seqId, [{ clipId: tail.id, toTrackId: v(f).id, toStart: 200 }], 'overwrite');
    expect(texts(f)).toContain('B@212-236');
    S().select([v(f).clips[0].id]);
    S().rippleDeleteSelected(f.seqId); // head (0..60) removed → everything from 60 shifts by -60 (tail at 200 → 140)
    expect(texts(f)).toContain('B@152-176');
    const t2 = v(f).clips[0];
    S().setClipSpeed(f.seqId, t2.id, 2, { ripple: true });
    // clip 140..170 now covers source 2.5..5 at 2x; cue B (3..4) → 140 + (0.5/2)*24 = 146 .. 140 + (1.5/2)*24 = 158
    expect(texts(f)).toContain('B@146-158');
  });

  it('splitCue at its own start / end is a no-op, in the middle splits text and timing', () => {
    const f = withCues();
    const b = resolveSubtitleCues(f.seq()).find((c) => c.text === 'B')!;
    const h = S().history.past.length;
    expect(S().splitCue(f.seqId, b.id, b.start)).toBeNull();
    expect(S().splitCue(f.seqId, b.id, b.end)).toBeNull();
    expect(S().history.past.length).toBe(h);
    expect(S().splitCue(f.seqId, b.id, 84)).not.toBeNull();
    const parts = resolveSubtitleCues(f.seq()).filter((c) => c.text === 'B');
    expect(parts.map((p) => [p.start, p.end])).toEqual([[72, 84], [84, 96]]);
  });

  it('lift / overwrite that removes a clip must not leave orphan cues behind in the sequence', () => {
    const f = withCues();
    S().setView(f.seqId, { inPoint: 0, outPoint: 120 });
    S().liftInOut(f.seqId);
    expect(clipsOf(f.seq()).length).toBe(0);
    const stored = f.seq().subtitleTracks.flatMap((t) => t.cues);
    expect(stored.length, 'orphan cues kept after lift').toBe(0);
  });

  it('removeTrack drops the clips on it and their cues', () => {
    const f = withCues();
    S().removeTrack(f.seqId, v(f).id);
    const stored = f.seq().subtitleTracks.flatMap((t) => t.cues);
    expect(stored.length, 'orphan cues after removing a track').toBe(0);
    expect(useStore.getState().ui.selectedClipIds).toEqual([]);
  });
});
