/**
 * Undo/redo torture: hundreds of random timeline ops, then undo all / redo all and compare.
 * A failing test here = reproduced bug (see docs/attack/qa.md).
 */
import { describe, it, expect } from 'vitest';
import { useStore } from '../../src/state/store';
import { emptyHistory } from '../../src/state/history';
import { createMediaItem, createProject, createSequence } from '../../shared/project';
import { allTracks, clipEnd, findClip, resolveSubtitleCues } from '../../shared/timeline';
import { S, fresh, insert, clipsOf, comparable, rng, mediaSubs, FPS, fakeProbe } from './helpers';

function randomOps(seed: number, n: number) {
  const f = fresh({ historyLimit: 10_000 });
  // media subtitle track so carry-subtitles paths are exercised too
  S().addMediaSubtitleTrack(mediaSubs(f.media.id, [{ start: 1, end: 2, text: 'one' }, { start: 2.5, end: 4, text: 'two' }, { start: 10, end: 12, text: 'ten' }]));
  // seed clips
  insert(f, 0, 5, 0); insert(f, 10, 20, 120); insert(f, 30, 32, 400);
  S().clearHistory();
  useStore.setState({ history: emptyHistory(10_000) });
  const r = rng(seed);
  const initial = comparable(S().project);
  const log: string[] = [];
  const seq = f.seq;
  const anyClip = () => { const cs = clipsOf(seq()); return cs.length ? r.pick(cs) : null; };
  const anyTrack = () => r.pick(allTracks(seq()));
  const ops: (() => void)[] = [
    () => { const a = r.int(0, 60); insert(f, a, a + r.int(1, 15), r.int(0, 1500), r.bool() ? 'insert' : 'overwrite'); log.push('insert'); },
    () => { S().razor(f.seqId, r.int(0, 1500)); log.push('razor'); },
    () => { const c = anyClip(); if (!c) return; const t = findClip(seq(), c.id)!.track; const dest = r.pick(allTracks(seq()).filter((x) => x.kind === t.kind)); S().moveClips(f.seqId, [{ clipId: c.id, toTrackId: dest.id, toStart: r.int(0, 1500) }], r.bool() ? 'insert' : 'overwrite'); log.push('move'); },
    () => { const c = anyClip(); if (!c) return; const edge = r.bool() ? 'start' : 'end'; S().trimClipEdge(f.seqId, c.id, edge, (edge === 'start' ? c.start : clipEnd(c)) + r.int(-40, 40), r.bool()); log.push('trim'); },
    () => { const c = anyClip(); if (!c) return; S().select([c.id]); S().rippleDeleteSelected(f.seqId); log.push('rippleDelete'); },
    () => { const c = anyClip(); if (!c) return; S().select([c.id]); S().deleteSelected(f.seqId); log.push('delete'); },
    () => { const c = anyClip(); if (!c) return; const t = findClip(seq(), c.id)!.track; S().addTransitionAtCut(f.seqId, t.id, r.bool() ? c.start : clipEnd(c), t.kind === 'audio' ? 'audioCrossfade' : r.pick(['crossDissolve', 'dipToBlack'] as const), r.int(1, 60)); log.push('transition'); },
    () => { const c = anyClip(); if (!c) return; S().setClipTags(f.seqId, c.id, { tags: [`t${r.int(0, 5)}`], characters: [`c${r.int(0, 3)}`], notes: 'n' }); log.push('tag'); },
    () => { if (r.bool() || !seq().markers.length) S().addMarker(f.seqId, { time: r.int(0, 2000), name: 'm' }); else S().removeMarker(f.seqId, r.pick(seq().markers).id); log.push('marker'); },
    () => { const c = anyClip(); if (!c) return; S().setClipSpeed(f.seqId, c.id, r.pick([0.5, 1, 1.5, 2, 4]), { ripple: r.bool() }); log.push('speed'); },
    () => { const c = anyClip(); if (!c) return; S().setClipEnabled(f.seqId, c.id, r.bool()); log.push('enable'); },
    () => { const cs = clipsOf(seq()); if (cs.length < 2) return; S().select([r.pick(cs).id, r.pick(cs).id]); if (r.bool()) S().linkSelected(f.seqId); else S().unlinkSelected(f.seqId); log.push('link'); },
    () => { if (r.bool()) S().addTrack(f.seqId, r.bool() ? 'video' : 'audio'); else S().removeTrack(f.seqId, anyTrack().id); log.push('track'); },
    () => { const c = anyClip(); if (!c) return; S().slip(f.seqId, c.id, r.int(-50, 50)); log.push('slip'); },
    () => { const c = anyClip(); if (!c) return; S().slide(f.seqId, c.id, r.int(-50, 50)); log.push('slide'); },
    () => { const c = anyClip(); if (!c) return; S().select([c.id]); S().nudgeSelected(r.int(-10, 10), f.seqId); log.push('nudge'); },
    () => { const a = r.int(0, 1000); S().setView(f.seqId, { inPoint: a, outPoint: a + r.int(1, 100) }); if (r.bool()) S().extractInOut(f.seqId); else S().liftInOut(f.seqId); S().setView(f.seqId, { inPoint: null, outPoint: null }); log.push('extract/lift'); },
    () => { const a = r.int(0, 1000); S().addStoryBlock(f.seqId, { start: a, end: a + r.int(1, 200), name: 'b' }); log.push('story'); },
    () => { S().setTrackFlags(f.seqId, anyTrack().id, { locked: r.next() < 0.2, muted: r.bool() }); log.push('trackflags'); },
    () => { const c = anyClip(); if (!c) return; const t = findClip(seq(), c.id)!.track; const i = t.clips.indexOf(c); const nx = t.clips[i + 1]; if (nx && nx.start === clipEnd(c)) S().rollEdit(f.seqId, c.id, nx.id, clipEnd(c) + r.int(-30, 30)); log.push('roll'); },
    () => { const cues = resolveSubtitleCues(seq()); if (!cues.length) return; const cu = r.pick(cues); if (r.bool()) S().splitCue(f.seqId, cu.id, Math.floor((cu.start + cu.end) / 2)); else S().updateCue(f.seqId, cu.id, { offset: r.int(-5, 5), text: 'x' }); log.push('cue'); },
    () => { S().takeSnapshot(f.seqId, 'snap'); log.push('snapshot'); },
  ];
  for (let i = 0; i < n; i++) r.pick(ops)();
  return { f, initial, log };
}

describe('undo/redo torture', () => {
  for (const seed of [1, 2, 3]) {
    it(`seed ${seed}: 500 random ops → undo all equals initial, redo all equals final`, () => {
      const { initial } = randomOps(seed, 500);
      const final = comparable(S().project);
      const steps = S().history.past.length;
      expect(steps).toBeGreaterThan(100);
      let undone = 0;
      while (S().undo()) undone++;
      expect(undone).toBe(steps);
      expect(comparable(S().project)).toEqual(initial);
      let redone = 0;
      while (S().redo()) redone++;
      expect(redone).toBe(steps);
      expect(comparable(S().project)).toEqual(final);
    });
  }

  it('no NaN / negative / zero-duration clip or overlapping clips survive 500 random ops', () => {
    for (const seed of [11, 12, 13]) {
      const { f } = randomOps(seed, 500);
      for (const t of allTracks(f.seq())) {
        let prevEnd = -1;
        for (const c of t.clips) {
          expect(Number.isFinite(c.start) && Number.isFinite(c.duration) && Number.isFinite(c.sourceIn), `seed ${seed} clip ${c.id} has non-finite fields`).toBe(true);
          expect(c.start, `seed ${seed} negative start`).toBeGreaterThanOrEqual(0);
          expect(c.duration, `seed ${seed} duration < 1`).toBeGreaterThanOrEqual(1);
          expect(c.sourceIn, `seed ${seed} negative sourceIn`).toBeGreaterThanOrEqual(0);
          expect(c.start, `seed ${seed} overlap on ${t.name} (${c.id} starts at ${c.start} before previous end ${prevEnd})`).toBeGreaterThanOrEqual(prevEnd);
          prevEnd = clipEnd(c);
        }
        for (const tr of t.transitions) {
          const a = tr.outClipId ? t.clips.find((c) => c.id === tr.outClipId) : null;
          const b = tr.inClipId ? t.clips.find((c) => c.id === tr.inClipId) : null;
          expect(tr.outClipId === null || !!a, `seed ${seed} dangling transition.outClipId`).toBe(true);
          expect(tr.inClipId === null || !!b, `seed ${seed} dangling transition.inClipId`).toBe(true);
          if (a && b) expect(clipEnd(a), `seed ${seed} transition on non-adjacent cut`).toBe(b.start);
        }
      }
    }
  });

  it('undo across a sequence switch restores the edited sequence but keeps the active one', () => {
    const f = fresh();
    const other = createSequence('Other', FPS);
    S().addSequence(other, { activate: false });
    S().clearHistory();
    insert(f, 0, 5, 0);
    expect(clipsOf(f.seq()).length).toBe(2);
    S().setActiveSequence(other.id);
    expect(S().undo()).toBe(true);
    expect(clipsOf(f.seq()).length).toBe(0);
    expect(S().project.activeSequenceId).toBe(other.id);
  });

  it('setActiveSequence, select and setView do not create history entries', () => {
    const f = fresh();
    const other = createSequence('Other', FPS);
    S().addSequence(other);
    S().clearHistory();
    S().setActiveSequence(f.seqId);
    S().setActiveSequence(other.id);
    S().select(['nope']);
    S().setView(f.seqId, { playhead: 100, inPoint: 1, outPoint: 50, zoom: 3 });
    expect(S().canUndo()).toBe(false);
  });

  it('undo/redo are refused while a transaction is open and work after it ends', () => {
    const f = fresh();
    insert(f, 0, 5, 0);
    S().beginTransaction();
    S().updateTransient((d) => { d.sequences[f.seqId].markers.push({ id: 'x', time: 1, duration: 0, name: 'm', note: '', color: '#fff', kind: 'marker' }); });
    expect(S().undo()).toBe(false);
    expect(S().redo()).toBe(false);
    S().endTransaction('drag');
    expect(S().history.past.length).toBe(2);
    expect(S().undo()).toBe(true);
    expect(f.seq().markers.length).toBe(0);
  });

  it('loading a project / new project clears history and redo stack', () => {
    const f = fresh();
    insert(f, 0, 5, 0);
    S().undo();
    expect(S().canRedo()).toBe(true);
    S().loadProjectData(createProject('Loaded'), '/tmp/x.recut');
    expect(S().canUndo()).toBe(false);
    expect(S().canRedo()).toBe(false);
    insert(f, 0, 5, 0); // seq no longer exists → no-op
    S().newProject();
    expect(S().canUndo()).toBe(false);
  });

  it('cancelTransaction restores the pre-drag project and keeps history intact', () => {
    const f = fresh();
    insert(f, 0, 5, 0);
    const before = S().project;
    S().beginTransaction();
    S().updateTransient((d) => { d.sequences[f.seqId].videoTracks[0].clips[0].start = 999; });
    S().cancelTransaction();
    expect(S().project).toBe(before);
    expect(S().history.past.length).toBe(1);
  });

  // ---- history pollution by background/system commits -------------------------------------------------

  it('a finishing proxy job (setProxy) must not wipe the redo stack of a user edit', () => {
    const f = fresh();
    insert(f, 0, 5, 0);
    S().undo();
    expect(S().canRedo()).toBe(true);
    // jobsRouter mirrors job results via store.setProxy (an undoable commit)
    S().setProxy(f.media.id, { status: 'ready', path: '/cache/p.mp4', progress: 1 });
    expect(S().canRedo(), 'redo stack was cleared by a background proxy status write').toBe(true);
  });

  it('importing 3 files should be one undo step, not 1 + one per probe', () => {
    fresh();
    const items = [1, 2, 3].map((i) => createMediaItem(`/m/${i}.mp4`, `${i}.mp4`));
    S().addMedia(items);
    for (const it of items) S().setMediaProbe(it.id, fakeProbe(10));
    // user presses undo once: expectation is that the import is gone
    S().undo();
    // fresh() already holds one fixture media item; the three imported ones must be gone.
    expect(items.filter((it) => S().project.media[it.id]).length, 'first undo only reverted a "Probe media" entry').toBe(0);
  });

  it('marking media offline on open (setOffline) must not dirty the project or create history', () => {
    const f = fresh();
    useStore.setState({ dirty: false });
    S().setOffline(f.media.id, true);
    expect(S().dirty, 'project became dirty just by detecting an offline file').toBe(false);
    expect(S().canUndo(), '"Media offline" is undoable (undo would mark a missing file online)').toBe(false);
  });

  it('history limit: after >limit ops the import can no longer be undone (documented behaviour, limit 200)', () => {
    const f = fresh({ historyLimit: 200 });
    for (let i = 0; i < 250; i++) S().addMarker(f.seqId, { time: i, name: 'm' });
    let n = 0; while (S().undo()) n++;
    expect(n).toBe(200);
  });
});
