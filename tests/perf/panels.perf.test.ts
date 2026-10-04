/**
 * Pure (DOM-free) parts of the panels, fed with the LARGE project: Project panel row model with every scene
 * expanded + search typing, Transcript index + search, Scene Library filter/sort/group, and the per-render
 * culling loop the Timeline runs over 2500 clips.
 *
 * Run: npx vitest run -c tests/perf/vitest.config.ts tests/perf/panels.perf.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { useStore, resetStore } from '../../src/state/store';
import type { MediaProbe } from '../../shared/model';
import { buildBinRows, buildSeriesRows, expandKey, searchTerms, mediaMatches, type BuildInput, type ExpandedMap } from '../../src/panels/project/tree';
import { seriesTree } from '../../src/state/selectors';
import { buildTranscriptIndex, searchTranscript } from '../../src/transcript/index';
import { clipOverlaps, clipVisiblePx, visibleRange, layoutTracks, zoomToFit } from '../../src/panels/timeline/viewMath';
import { sequenceDuration } from '../../shared/timeline';
// @ts-expect-error plain JS module shared with the Electron harness
import { buildBigProject } from './bigProject.mjs';
import { bench, flush, ms, record, round } from './_report';

const FPS = { num: 24, den: 1 };
const S = () => useStore.getState();
function fakeProbe(duration: number): MediaProbe {
  return {
    container: 'mov,mp4,m4a,3gp,3g2,mj2', duration, size: 1_600_000, startTime: 0, browserPlayable: true,
    video: { index: 0, codec: 'h264', width: 640, height: 360, fps: FPS, avgFps: FPS, isVfr: false },
    audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }], subtitles: [],
  };
}

let big: ReturnType<typeof buildBigProject>;

describe('panels @ large project', () => {
  beforeAll(() => {
    resetStore();
    const base = Array.from({ length: 7 }, (_, i) => ({ name: `Source ${i}.mp4`, path: `/media/source-${i}.mp4`, probe: fakeProbe(60) }));
    big = buildBigProject(useStore, base, {});
  });
  afterAll(() => flush('panels'));

  it('project panel: row model with 60 media + 3000 scenes expanded, and search keystrokes', () => {
    const p = S().project;
    const expanded: ExpandedMap = {};
    for (const id of Object.keys(p.media)) expanded[expandKey.scenes(id)] = true;
    const input: BuildInput = { media: p.media, bins: p.bins, sequences: p.sequences, sequenceOrder: p.sequenceOrder, expanded, query: '', sort: 'name', view: 'list', cols: 4 };
    let rows = buildBinRows(input);
    record({ section: 'project', metric: 'rows (bins mode, all scenes expanded)', value: rows.length, unit: 'rows' });
    const b = bench(20, () => { rows = buildBinRows(input); });
    ms('project', 'buildBinRows all expanded (median)', b.median, 16);
    const tree = seriesTree(S());
    const bs = bench(20, () => { buildSeriesRows(tree, input); });
    ms('project', 'buildSeriesRows all expanded (median)', bs.median, 16);
    const st = bench(20, () => { seriesTree(S()); });
    ms('project', 'seriesTree (median)', st.median, 5);
    const grid = bench(10, () => { buildBinRows({ ...input, view: 'grid' }); });
    ms('project', 'buildBinRows grid/chunkCards (median)', grid.median, 16);
    // Search typing: every keystroke rebuilds the rows with the new query (filtering also forces bins open).
    const q = 'series 3 e04';
    const per: number[] = [];
    for (let i = 1; i <= q.length; i++) { const t = performance.now(); buildBinRows({ ...input, query: q.slice(0, i) }); per.push(performance.now() - t); }
    ms('project', 'search keystroke -> rows rebuilt (max over query)', Math.max(...per), 16);
    ms('project', 'search keystroke -> rows rebuilt (mean)', per.reduce((a, c) => a + c, 0) / per.length, 8);
    const hay = bench(5, () => { const terms = searchTerms('dawn'); for (const m of Object.values(p.media)) mediaMatches(m, terms); });
    ms('project', 'mediaMatches x60 (haystack rebuilt per call)', hay.median, 2);
    expect(rows.length).toBeGreaterThan(3000);
  });

  it('transcript: index build + search "the" over 8000 cues', () => {
    const p = S().project;
    let idx = buildTranscriptIndex(p);
    const ib = bench(10, () => { idx = buildTranscriptIndex(p); });
    ms('transcript', 'buildTranscriptIndex (median)', ib.median, 50, 'rebuilt whenever project.media or subtitleTracks identity changes');
    record({ section: 'transcript', metric: 'indexed cues', value: idx.stats.cues, unit: '' });
    let res = searchTranscript(idx, 'the', { kind: 'project' }, { limit: 1000 });
    const sb = bench(20, () => { res = searchTranscript(idx, 'the', { kind: 'project' }, { limit: 1000 }); });
    ms('transcript', 'searchTranscript "the" project scope (median)', sb.median, 16);
    record({ section: 'transcript', metric: 'matches for "the" (total / returned)', value: `${res.total} / ${res.matches.length}`, unit: '' });
    const sw = bench(10, () => { searchTranscript(idx, 'the', { kind: 'project' }, { limit: 1000, wholeWord: true }); });
    ms('transcript', 'searchTranscript "the" whole-word (median)', sw.median, 16);
    const sr = bench(10, () => { searchTranscript(idx, 'th[ei]', { kind: 'project' }, { limit: 1000, regex: true }); });
    ms('transcript', 'searchTranscript regex th[ei] (median)', sr.median, 16);
    const seqScope = bench(5, () => { searchTranscript(idx, 'the', { kind: 'sequence', sequenceId: big.seqId }, { limit: 1000 }); });
    ms('transcript', 'searchTranscript "the" sequence scope (2500 clips; median)', seqScope.median, 50, 'timelineHitsFor scans every clip per match');
    // Debounced keystroke cost: t, th, the
    const per: number[] = [];
    for (const q of ['t', 'th', 'the', 'the ', 'the s', 'the sh']) { const t = performance.now(); searchTranscript(idx, q, { kind: 'project' }, { limit: 1000 }); per.push(performance.now() - t); }
    ms('transcript', 'keystroke search cost (max over "the sh")', Math.max(...per), 16);
    expect(res.total).toBeGreaterThan(100);
  });

  it('scene library: filter / sort / group 400 records', async () => {
    const p = S().project;
    const all = Object.values(p.scenes);
    let mod: typeof import('../../src/panels/scenes/sceneUtils') | null = null;
    try { mod = await import('../../src/panels/scenes/sceneUtils'); } catch (e) { record({ section: 'scenes', metric: 'sceneUtils import', value: `failed: ${(e as Error).message.slice(0, 80)}`, unit: '' }); }
    if (!mod) return;
    const { EMPTY_FILTERS, matchesFilters, compareScenes, groupScenes, collectFacets } = mod;
    const f = bench(20, () => { collectFacets(all); });
    ms('scenes', 'collectFacets (median)', f.median, 5);
    const per: number[] = [];
    for (const q of ['t', 'th', 'the', 'the ', 'the s']) {
      const t = performance.now();
      all.filter((s) => matchesFilters(s, { ...EMPTY_FILTERS, query: q }, p.media[s.mediaId])).sort((a, b) => compareScenes(a, b, 'name', 1, p.media));
      per.push(performance.now() - t);
    }
    ms('scenes', 'filter+sort per keystroke (max)', Math.max(...per), 16);
    ms('scenes', 'filter+sort per keystroke (mean)', per.reduce((a, c) => a + c, 0) / per.length, 8);
    const g = bench(20, () => { groupScenes(all, 'character', p.media); });
    ms('scenes', 'groupScenes by character (median)', g.median, 5);
    const srt = bench(20, () => { [...all].sort((a, b) => compareScenes(a, b, 'source', 1, p.media)); });
    ms('scenes', 'sort by source (localeCompare of labels; median)', srt.median, 16);
    expect(all.length).toBe(400);
  });

  it('timeline: per-render culling loop over 2500 clips at 3 zoom levels', () => {
    const seq = S().project.sequences[big.seqId];
    const width = 1400;
    const dur = sequenceDuration(seq);
    const selected = seq.videoTracks[0].clips.slice(0, 50).map((c) => c.id); // Array.includes per clip like TimelineBody
    const layout = layoutTracks(seq.videoTracks, seq.audioTracks, {});
    for (const [label, zoom] of [['zoom-to-fit', zoomToFit(dur, width)], ['1 px/frame', 1], ['frame level 20 px/frame', 20]] as const) {
      const scroll = Math.max(0, dur / 2 - width / zoom / 2);
      const range = visibleRange(zoom, scroll, width);
      const viewX0 = scroll * zoom - 200, viewX1 = scroll * zoom + width + 200;
      let visible = 0;
      const b = bench(50, () => {
        visible = 0;
        for (const row of layout.rows) {
          const track = [...seq.videoTracks, ...seq.audioTracks].find((t) => t.id === row.id)!;
          const clipsById = new Map(track.clips.map((c) => [c.id, c]));
          track.clips.forEach((clip) => {
            if (!clipOverlaps(clip.start, clip.duration, range.from, range.to)) return;
            const vis = clipVisiblePx(clip.start * zoom, clip.duration * zoom, viewX0, viewX1);
            if (!vis) return;
            selected.includes(clip.id);
            visible++;
          });
          void clipsById;
        }
      });
      ms('timeline', `render culling loop @ ${label} (median)`, b.median, 2, `${visible} clips visible, zoom=${round(zoom, 4)}`);
      record({ section: 'timeline', metric: `clips mounted @ ${label}`, value: visible, unit: 'clips' });
    }
  });
});
