/**
 * Store benchmarks on the LARGE synthetic project (see bigProject.mjs): commit latency per edit kind on the
 * 2500-clip sequence, undo/redo, memory growth over 300 commits, history cap, serialize / parse / normalize,
 * and the per-frame work the UI derives from the store (planFrame, resolveSubtitleCues, sequenceDuration).
 *
 * Run: NODE_OPTIONS=--expose-gc npx vitest run -c tests/perf/vitest.config.ts tests/perf/store.perf.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { useStore, resetStore, serializeForSave } from '../../src/state/store';
import { normalizeProject, serializeProject } from '../../shared/project';
import { allTracks, clipEnd, findClip, resolveSubtitleCues, sequenceDuration } from '../../shared/timeline';
import { planFrame } from '../../src/playback/planner';
import type { MediaProbe } from '../../shared/model';
// @ts-expect-error plain JS module shared with the Electron harness
import { buildBigProject } from './bigProject.mjs';
import { bench, flush, heapMB, ms, now, record, round, rssMB, stats } from './_report';

const FPS = { num: 24, den: 1 };
const S = () => useStore.getState();

function fakeProbe(duration: number): MediaProbe {
  return {
    container: 'mov,mp4,m4a,3gp,3g2,mj2', duration, size: 1_600_000, startTime: 0, browserPlayable: true,
    video: { index: 0, codec: 'h264', width: 640, height: 360, fps: FPS, avgFps: FPS, isVfr: false, pixFmt: 'yuv420p' },
    audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
    subtitles: [],
  };
}

let big: ReturnType<typeof buildBigProject>;
let seqId: string;

describe('store @ 2500 clips', () => {
  beforeAll(() => {
    resetStore();
    const base = Array.from({ length: 7 }, (_, i) => ({ name: `Source ${i}.mp4`, path: `/media/source-${i}.mp4`, probe: fakeProbe(60) }));
    const t = now();
    big = buildBigProject(useStore, base, {});
    ms('build', 'buildBigProject total (store API, node)', now() - t);
    for (const [k, v] of Object.entries(big.timings)) {
      if (Array.isArray(v)) { const s = stats(v as number[]); ms('build', `${k} median`, s.median); ms('build', `${k} max`, s.max); }
      else ms('build', k, v as number);
    }
    for (const [k, v] of Object.entries(big.counts)) record({ section: 'build', metric: `count ${k}`, value: v as number, unit: '' });
    seqId = big.seqId;
    expect(big.counts.clips).toBe(2500);
    expect(big.counts.media).toBe(60);
    expect(big.counts.detectedScenes).toBeGreaterThanOrEqual(2900);
    expect(big.counts.cues).toBe(8000);
    expect(big.counts.sceneRecords).toBe(400);
    expect(big.counts.transitions).toBe(300);
    expect(big.counts.markers).toBe(200);
    expect(big.counts.sequences).toBe(12); // default + big + 10 alternates
  });
  afterAll(() => flush('store'));

  it('commit latency per edit kind', () => {
    const mediaId = big.mediaIds[3];
    const dur = sequenceDuration(S().project.sequences[seqId]);
    const ov = bench(20, (i) => { S().insertFromSource(seqId, { mediaId, in: 1, out: 4, atFrame: 50 + i * 130, mode: 'overwrite' }); });
    ms('commit', 'insertFromSource overwrite (median)', ov.median, 16); ms('commit', 'insertFromSource overwrite (p95)', ov.p95, 50);
    const ins = bench(10, (i) => { S().insertFromSource(seqId, { mediaId, in: 1, out: 3, atFrame: 10 + i * 500, mode: 'insert' }); });
    ms('commit', 'insertFromSource insert/ripple (median)', ins.median, 16); ms('commit', 'insertFromSource insert/ripple (p95)', ins.p95, 50);
    const rz = bench(20, (i) => { S().razor(seqId, 60 + i * 360); });
    ms('commit', 'razor all tracks (median)', rz.median, 16); ms('commit', 'razor all tracks (p95)', rz.p95, 50);
    const seq = S().project.sequences[seqId];
    const v1 = seq.videoTracks[0];
    const mv = bench(20, (i) => {
      const c = S().project.sequences[seqId].videoTracks[0].clips[40 + i * 5];
      S().moveClips(seqId, [{ clipId: c.id, toTrackId: v1.id, toStart: c.start + 7 }], 'overwrite');
    });
    ms('commit', 'moveClips 1 clip overwrite (median)', mv.median, 16); ms('commit', 'moveClips (p95)', mv.p95, 50);
    const mvi = bench(5, (i) => {
      const c = S().project.sequences[seqId].videoTracks[1].clips[100 + i * 5];
      S().moveClips(seqId, [{ clipId: c.id, toTrackId: seq.videoTracks[1].id, toStart: c.start + 3 }], 'insert');
    });
    ms('commit', 'moveClips 1 clip insert/ripple (median)', mvi.median, 16);
    const rd = bench(10, (i) => {
      const c = S().project.sequences[seqId].videoTracks[2].clips[200 + i];
      S().select([c.id], 'set');
      S().rippleDeleteSelected(seqId);
    });
    ms('commit', 'rippleDeleteSelected 1 clip (median)', rd.median, 16); ms('commit', 'rippleDeleteSelected (p95)', rd.p95, 50);
    const del = bench(10, (i) => {
      const c = S().project.sequences[seqId].videoTracks[3].clips[200 + i];
      S().select([c.id], 'set');
      S().deleteSelected(seqId);
    });
    ms('commit', 'deleteSelected 1 clip (median)', del.median, 16);
    const en = bench(50, (i) => { const c = S().project.sequences[seqId].videoTracks[0].clips[i]; S().setClipEnabled(seqId, c.id, i % 2 === 0); });
    ms('commit', 'setClipEnabled (tiny commit, median)', en.median, 8);
    const tr = bench(20, (i) => { const t = S().project.sequences[seqId].videoTracks[0]; const c = t.clips[10 + i]; S().addTransitionAtCut(seqId, t.id, clipEnd(c), 'crossDissolve', 12); });
    ms('commit', 'addTransitionAtCut (median)', tr.median, 8);
    const mk = bench(20, (i) => { S().addMarker(seqId, { time: 10 + i }); });
    ms('commit', 'addMarker (median)', mk.median, 8);
    const spd = bench(5, (i) => { const c = S().project.sequences[seqId].videoTracks[0].clips[300 + i]; S().setClipSpeed(seqId, c.id, 1.5, { ripple: true }); });
    ms('commit', 'setClipSpeed ripple (median)', spd.median, 16);
    expect(sequenceDuration(S().project.sequences[seqId])).toBeGreaterThan(dur * 0.9);
  });

  it('setView latency (playhead moves) with and without a selection', () => {
    S().select([], 'clear');
    const empty = bench(1000, (i) => { S().setView(seqId, { playhead: i * 7 }); });
    ms('view', 'setView playhead, no selection (mean of 1000)', empty.mean, 0.5);
    const ids = allTracks(S().project.sequences[seqId]).flatMap((t) => t.clips.map((c) => c.id));
    S().select(ids.slice(0, 100), 'set');
    const sel = bench(1000, (i) => { S().setView(seqId, { playhead: i * 7 }); });
    ms('view', 'setView playhead, 100 clips selected (mean)', sel.mean, 0.5, 'pruneUi walks every clip when anything is selected');
    S().select(ids, 'set');
    const all = bench(200, (i) => { S().setView(seqId, { playhead: i * 7 }); });
    ms('view', 'setView playhead, all 2500 selected (mean)', all.mean, 1);
    const scroll = bench(500, (i) => { S().setView(seqId, { scroll: i * 3 }); });
    ms('view', 'setView scroll (mean of 500)', scroll.mean, 0.5);
    S().select([], 'clear');
  });

  it('undo / redo latency', () => {
    const u = bench(30, () => { S().undo(); });
    ms('history', 'undo (median of 30)', u.median, 16); ms('history', 'undo (max)', u.max, 50);
    const r = bench(30, () => { S().redo(); });
    ms('history', 'redo (median of 30)', r.median, 16); ms('history', 'redo (max)', r.max, 50);
    const u2 = bench(1, () => { S().undo(); });
    ms('history', 'undo single (ms)', u2.median);
    expect(S().canRedo()).toBe(true);
  });

  it('memory growth across 300 commits and the history cap', () => {
    S().clearHistory();
    const h0 = heapMB(); const r0 = rssMB();
    record({ section: 'memory', metric: 'heap after clearHistory (MB)', value: h0, unit: 'MB' });
    record({ section: 'memory', metric: 'rss baseline (MB)', value: r0, unit: 'MB' });
    const marks: number[] = [];
    const t = now();
    for (let i = 0; i < 300; i++) {
      // Mixed, realistic small edits: razor / enable toggle / marker / move
      switch (i % 4) {
        case 0: S().razor(seqId, 100 + i * 37); break;
        case 1: { const c = S().project.sequences[seqId].videoTracks[1].clips[i % 200]; S().setClipEnabled(seqId, c.id, i % 8 === 1); break; }
        case 2: S().addMarker(seqId, { time: i * 3 }); break;
        default: { const c = S().project.sequences[seqId].videoTracks[0].clips[20 + (i % 150)]; S().moveClips(seqId, [{ clipId: c.id, toTrackId: S().project.sequences[seqId].videoTracks[0].id, toStart: c.start + 1 }], 'overwrite'); }
      }
      if ((i + 1) % 100 === 0) marks.push(heapMB());
    }
    ms('memory', '300 mixed commits total', now() - t);
    marks.forEach((m, i) => record({ section: 'memory', metric: `heap after ${(i + 1) * 100} commits (MB)`, value: m, unit: 'MB' }));
    record({ section: 'memory', metric: 'heap growth over 300 commits (MB)', value: round(marks[2] - h0), unit: 'MB', threshold: '<= 150 MB', pass: marks[2] - h0 <= 150 });
    record({ section: 'memory', metric: 'history.past.length after 300 commits', value: S().history.past.length, unit: '', threshold: '== limit 200', pass: S().history.past.length === 200 });
    record({ section: 'memory', metric: 'history.limit', value: S().history.limit, unit: '' });
    // Per-entry retained size: razor commits create a fresh tracks array for the touched track only (immer sharing)
    S().clearHistory();
    const h1 = heapMB();
    record({ section: 'memory', metric: 'heap after clearHistory again (MB)', value: h1, unit: 'MB' });
    record({ section: 'memory', metric: 'retained by 200 history entries (MB)', value: round(marks[2] - h1), unit: 'MB' });
    expect(S().history.past.length).toBe(0);
  });

  it('serialize / parse / normalize / clone the whole project', () => {
    const project = S().project;
    let json = '';
    const ser = bench(3, () => { json = serializeProject(project); });
    ms('io', 'serializeProject (pretty JSON, median of 3)', ser.median, 100);
    record({ section: 'io', metric: 'project JSON size (MB, pretty)', value: round(json.length / 1048576), unit: 'MB' });
    const compact = JSON.stringify(project);
    record({ section: 'io', metric: 'project JSON size (MB, compact)', value: round(compact.length / 1048576), unit: 'MB' });
    const perSeq = Object.values(project.sequences).map((s) => ({ name: s.name, bytes: JSON.stringify(s).length, snapshotBytes: JSON.stringify(s.snapshots).length }));
    const snapBytes = perSeq.reduce((a, s) => a + s.snapshotBytes, 0);
    record({ section: 'io', metric: 'bytes held by sequence snapshots (MB, compact)', value: round(snapBytes / 1048576), unit: 'MB', note: `${perSeq.length} sequences` });
    record({ section: 'io', metric: 'bytes of big sequence alone (MB, compact)', value: round(perSeq.find((p) => p.name.startsWith('Big'))!.bytes / 1048576), unit: 'MB' });
    let raw: unknown = null;
    const parse = bench(3, () => { raw = JSON.parse(json); });
    ms('io', 'JSON.parse (median of 3)', parse.median, 100);
    const norm = bench(3, () => { normalizeProject(raw); });
    ms('io', 'normalizeProject (median of 3)', norm.median, 100);
    const clone = bench(3, () => { structuredClone(project); });
    ms('io', 'structuredClone(project) ~ IPC cost one way (median of 3)', clone.median, 100);
    const sfs = bench(3, () => { serializeForSave(S()); });
    ms('io', 'serializeForSave (immer produce stamping modifiedAt)', sfs.median, 20);
    const loaded = normalizeProject(JSON.parse(json));
    const load = bench(3, () => { S().loadProjectData(loaded, '/tmp/x.recut'); });
    ms('io', 'loadProjectData (store set + pruneUi)', load.median, 20);
    expect(Object.keys(loaded.sequences).length).toBe(Object.keys(project.sequences).length);
  });

  it('per-frame derived work: planFrame / resolveSubtitleCues / sequenceDuration / findClip', () => {
    const seq = S().project.sequences[seqId];
    const media = S().project.media;
    const dur = sequenceDuration(seq);
    const pf = bench(240, (i) => { planFrame(seq, media, Math.floor((dur * i) / 240), true); });
    ms('frame', 'planFrame (median over 240 frames)', pf.median, 2, 'runs every rAF while playing');
    ms('frame', 'planFrame (max)', pf.max, 4);
    const sd = bench(100, () => { sequenceDuration(seq); });
    ms('frame', 'sequenceDuration (mean)', sd.mean, 0.2);
    const fc = bench(200, (i) => { findClip(seq, `clip_perf_${(i * 13) % 2500}`); });
    ms('frame', 'findClip by id (mean, linear scan)', fc.mean, 0.1);
    // Sequence subtitle tracks anchored to clips: 8000 cues across 30 tracks via carrySubtitles-like shape.
    S().commit('perf subtitle tracks', (d) => {
      const s = d.sequences[seqId];
      const clips = [...s.videoTracks].flatMap((t) => t.clips);
      for (let t = 0; t < 30; t++) {
        const cues = [] as typeof s.subtitleTracks[number]['cues'];
        for (let k = 0; k < 267 && t * 267 + k < 8000; k++) {
          const clip = clips[(t * 267 + k) % clips.length];
          cues.push({ id: `scue_${t}_${k}`, clipId: clip.id, srcStart: clip.sourceIn + 0.2, srcEnd: clip.sourceIn + 1.5, start: clip.start, duration: 30, offset: 0, text: `line ${t}/${k} the quick fox` });
        }
        s.subtitleTracks.push({ id: `sst_${t}`, name: `sub ${t}`, language: t % 2 ? 'en' : 'fr', enabled: true, cues });
      }
    });
    const seq2 = S().project.sequences[seqId];
    const rs = bench(10, () => { resolveSubtitleCues(seq2); });
    ms('frame', 'resolveSubtitleCues 8000 cues (median)', rs.median, 16, 'TimelinePanel recomputes on every track change');
    const pf2 = bench(100, (i) => { planFrame(seq2, media, Math.floor((dur * i) / 100), true); });
    ms('frame', 'planFrame with subtitle tracks (median)', pf2.median, 2);
    expect(resolveSubtitleCues(seq2).length).toBeGreaterThan(7000);
  });
});
