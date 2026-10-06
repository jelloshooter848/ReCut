/**
 * An opened project is frozen in idle slices after loadProjectData (src/state/store.ts freezeInIdleSlices), so the
 * first edit after an open no longer pays for immer deep-freezing the whole project in one task.
 *
 *  - After the idle walk, every value immer would freeze is frozen; sequence views (LiveView) stay mutable.
 *  - Children are frozen before their parent: at every slice boundary a frozen object is frozen all the way down.
 *  - A produce after the walk only freezes what it created (immer skips the frozen project).
 *  - An edit that lands before the walk is done finishes it first and is correct (undo / redo / revision / dirty).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isDraftable } from 'immer';
import { useStore, resetStore, projectFreezePending, settleProjectFreeze, serializeForSave } from '../../src/state/store';
import { createMediaItem, createProject, LiveView } from '../../shared/project';
import { makeClip } from '../../shared/timeline';
import type { Project } from '../../shared/model';

const S = () => useStore.getState();
const macrotask = () => new Promise<void>((r) => setTimeout(r, 0));

/** A project from "disk": plain unfrozen data, `clipsPerTrack` clips on each of the 6 default tracks. */
function bigProject(clipsPerTrack: number): Project {
  const p = createProject('Opened');
  const m = { ...createMediaItem('/media/a.mkv', 'a.mkv'), kind: 'video' as const };
  p.media[m.id] = m;
  const seq = p.sequences[p.activeSequenceId!];
  for (const t of [...seq.videoTracks, ...seq.audioTracks]) {
    for (let i = 0; i < clipsPerTrack; i++) t.clips.push(makeClip({ mediaId: m.id, name: `c${i}`, sourceIn: i, duration: 10, kind: t.kind }, i * 10));
  }
  return p;
}

/** Walks every draftable value: counts, and checks that a frozen object has only frozen draftable children. */
function freezeState(root: unknown): { total: number; frozen: number; brokenInvariant: number; frozenViews: number } {
  const out = { total: 0, frozen: 0, brokenInvariant: 0, frozenViews: 0 };
  const stack: unknown[] = [root];
  const seen = new Set<unknown>();
  while (stack.length) {
    const o = stack.pop();
    if (o === null || typeof o !== 'object' || seen.has(o)) continue;
    seen.add(o);
    if (o instanceof LiveView) { if (Object.isFrozen(o)) out.frozenViews++; continue; }
    if (!isDraftable(o)) continue;
    out.total++;
    const frozen = Object.isFrozen(o);
    if (frozen) out.frozen++;
    for (const v of Object.values(o)) {
      if (v === null || typeof v !== 'object') continue;
      if (frozen && isDraftable(v) && !Object.isFrozen(v)) out.brokenInvariant++;
      stack.push(v);
    }
  }
  return out;
}

async function idleFreezeDone(): Promise<number> {
  let slices = 0;
  while (projectFreezePending()) { await macrotask(); slices++; if (slices > 10_000) throw new Error('idle freeze never finished'); }
  return slices;
}

beforeEach(() => { resetStore(); });
afterEach(() => { vi.restoreAllMocks(); settleProjectFreeze(); });

describe('opened project: idle freeze', () => {
  it('loadProjectData freezes the opened project in idle slices (not in the open task), views stay mutable', async () => {
    const p = bigProject(200);
    S().loadProjectData(p, '/tmp/a.recut');
    expect(S().project).toBe(p);
    expect(projectFreezePending()).toBe(true);
    expect(Object.isFrozen(p)).toBe(false); // nothing is frozen synchronously by the open
    await idleFreezeDone();
    const st = freezeState(S().project);
    expect(st.total).toBeGreaterThan(1000);
    expect(st.frozen).toBe(st.total);
    expect(st.frozenViews).toBe(0);
    // The playhead fast path still mutates the (unfrozen) LiveView in place.
    const seqId = p.activeSequenceId!;
    S().setView(seqId, { playhead: 123 });
    expect(S().project).toBe(p);
    expect(S().project.sequences[seqId].view.playhead).toBe(123);
  });

  it('freezes children before parents: at every slice boundary a frozen object is frozen all the way down', async () => {
    const p = bigProject(6000); // ~36k clips: many 8 ms slices
    S().loadProjectData(p, null);
    let partial = 0, checks = 0;
    while (projectFreezePending()) {
      await macrotask();
      const st = freezeState(p);
      checks++;
      expect(st.brokenInvariant).toBe(0);
      if (st.frozen > 0 && st.frozen < st.total) partial++;
    }
    expect(checks).toBeGreaterThan(1);
    expect(partial).toBeGreaterThan(0); // the walk was really sliced, and the checks saw it half done
    const st = freezeState(p);
    expect(st.frozen).toBe(st.total);
  });

  it('a commit after the idle freeze only freezes what it created (immer finds the project frozen)', async () => {
    const p = bigProject(2000);
    S().loadProjectData(p, null);
    await idleFreezeDone();
    const total = freezeState(p).total;
    const seq = p.sequences[p.activeSequenceId!];
    const clip = seq.videoTracks[0].clips[100];
    const spy = vi.spyOn(Object, 'freeze');
    S().setClipEnabled(seq.id, clip.id, false);
    const freezes = spy.mock.calls.length;
    spy.mockRestore();
    expect(S().project).not.toBe(p);
    // Without the idle freeze this commit froze every object of the project (> total); now only the new path.
    expect(total).toBeGreaterThan(50_000);
    expect(freezes).toBeLessThan(100);
    const st = freezeState(S().project);
    expect(st.frozen).toBe(st.total);
  });

  it('an edit before the idle freeze finishes: settles the freeze, edits correctly, undo / redo / revision / dirty / markSaved unchanged', async () => {
    const p = bigProject(2000);
    S().loadProjectData(p, '/tmp/a.recut');
    const rev0 = S().revision;
    expect(projectFreezePending()).toBe(true);
    const seq = p.sequences[p.activeSequenceId!];
    const clip = seq.videoTracks[0].clips[100];
    S().setClipEnabled(seq.id, clip.id, false);
    expect(projectFreezePending()).toBe(false);
    const after = S().project;
    expect(after.sequences[seq.id].videoTracks[0].clips[100].enabled).toBe(false);
    expect(p.sequences[seq.id].videoTracks[0].clips[100].enabled).toBe(true); // the opened project was not written
    for (const proj of [p, after]) { const st = freezeState(proj); expect(st.frozen).toBe(st.total); expect(st.brokenInvariant).toBe(0); }
    expect(S().revision).toBe(rev0 + 1);
    expect(S().dirty).toBe(true);
    expect(S().undo()).toBe(true);
    expect(S().project.sequences[seq.id].videoTracks[0].clips[100]).toBe(clip);
    expect(S().redo()).toBe(true);
    expect(S().project.sequences[seq.id].videoTracks[0].clips[100].enabled).toBe(false);
    expect(S().revision).toBe(rev0 + 3);
    S().markSaved('/tmp/a.recut', S().revision);
    expect(S().dirty).toBe(false);
    // Pending slices of the settled walk are no-ops.
    await macrotask(); await macrotask();
    expect(S().project.sequences[seq.id].videoTracks[0].clips[100].enabled).toBe(false);
  });

  it('every other produce from the project settles the walk first: quiet, transactions, setView zoom, serializeForSave', () => {
    const cases: [string, (p: Project) => void][] = [
      ['quiet', () => S().quiet((d) => { d.name = 'Renamed'; })],
      ['transaction', (p) => { S().beginTransaction(); S().updateTransient((d) => { d.sequences[p.activeSequenceId!].videoTracks[0].clips[0].start = 5; }); S().endTransaction('Drag'); }],
      ['setView zoom', (p) => S().setView(p.activeSequenceId!, { zoom: 2 })],
      ['serializeForSave', () => { serializeForSave(); }],
    ];
    for (const [label, run] of cases) {
      const p = bigProject(300);
      S().loadProjectData(p, null);
      expect(projectFreezePending(), label).toBe(true);
      run(p);
      expect(projectFreezePending(), label).toBe(false);
      const st = freezeState(p);
      expect(st.frozen, label).toBe(st.total);
      expect(st.frozenViews, label).toBe(0);
    }
  });

  it('newProject / another open replace a pending walk; an already frozen project starts none', async () => {
    const a = bigProject(300);
    S().loadProjectData(a, null);
    S().newProject();
    expect(projectFreezePending()).toBe(false);
    const b = bigProject(300);
    S().loadProjectData(b, null);
    const c = bigProject(300);
    S().loadProjectData(c, null);
    await idleFreezeDone();
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(b)).toBe(false); // the walk for b was dropped when c was opened
    S().loadProjectData(c, null);
    expect(projectFreezePending()).toBe(false);
  });
});
