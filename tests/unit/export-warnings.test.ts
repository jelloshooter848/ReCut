/**
 * Pre-export warnings (ROADMAP §3): the Export dialog's checklist warns, before an export, about video at another
 * frame rate than the sequence, VFR media, out-of-sync linked clips, transitions the export drops or shortens for
 * lack of source handles, and clips past the end of their media. The transition handles come from
 * shared/exportPlan.ts, which the render graph also uses: the parity tests check the dialog's prediction against
 * the graph buildRenderGraph actually builds.
 */
import { describe, it, expect } from 'vitest';
import type { Clip, MediaItem, Rational, Sequence } from '@shared/model';
import { transitionHandles } from '@shared/exportPlan';
import { buildRenderGraph, sec } from '../../electron/export/renderGraph';
import {
  checklistBlocks, exportChecklist, exportRange, exportTimelineChecks, namesWithMore, sequenceExportWarnings, type ChecklistItem,
} from '../../src/panels/export/settings';
import { fixtureClip, fixtureMedia, fixtureProbe, fixtureSequence, fixtureSettings, randomExportRequest } from './export-plan-fixture';

const R = (num: number, den = 1): Rational => ({ num, den });
const F24 = R(24);

function setup(fps: Rational = F24) {
  const seq = fixtureSequence(fps);
  const media: Record<string, MediaItem> = {};
  const add = (m: MediaItem) => { media[m.id] = m; return m; };
  return { seq, media, add };
}

function checklist(seq: Sequence, media: Record<string, MediaItem>, over: Parameters<typeof fixtureSettings>[0] = {}): ChecklistItem[] {
  return exportChecklist(seq, media, fixtureSettings({ fps: seq.fps, ...over }));
}
const find = (items: ChecklistItem[], prefix: string) => items.find((i) => i.text.startsWith(prefix));
const FPS = 'Source frame rate differs';
const VFR = 'Variable frame rate';
const SYNC = 'Linked clips out of sync';
const DROPPED = 'Transitions dropped';
const SHORT = 'Transitions shortened';
const PAST = 'Clips run past the end';

describe('namesWithMore', () => {
  it('lists up to three names, then "and N more"', () => {
    expect(namesWithMore(['a'])).toBe('a');
    expect(namesWithMore(['a', 'b', 'c'])).toBe('a, b, c');
    expect(namesWithMore(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
    expect(namesWithMore(['a', 'b'], 1)).toBe('a and 1 more');
  });
});

describe('transitionHandles (shared with the render graph)', () => {
  const fd = 1 / 24;
  const vid = (duration: number) => fixtureMedia('m', 'video', fixtureProbe({ duration }));
  const still = fixtureMedia('s', 'image', fixtureProbe({ duration: 0, audio: false }));
  const seg = (srcStart: number, frames: number, speed = 1, isImage = false) => ({ srcStart, frames, speed, isImage });

  it('plenty of source: half the length on each side', () => {
    expect(transitionHandles(24, { ...seg(2, 48), media: vid(10) }, seg(2, 48), fd)).toMatchObject({ h: 12, hClips: 12, handleOut: 144, handleIn: 48 });
  });
  it('odd lengths: floor(D / 2) per side', () => {
    expect(transitionHandles(13, { ...seg(2, 48), media: vid(10) }, seg(2, 48), fd).h).toBe(6);
  });
  it('the incoming clip starting at source 0 has no handle', () => {
    expect(transitionHandles(24, { ...seg(2, 48), media: vid(10) }, seg(0, 48), fd)).toMatchObject({ h: 0, hSource: 0, handleIn: 0 });
  });
  it('a short handle on either side limits the transition', () => {
    expect(transitionHandles(24, { ...seg(2, 48), media: vid(10) }, seg(5 / 24, 48), fd)).toMatchObject({ h: 5, hSource: 5 });
    // Outgoing clip ends 3 frames before the end of its 3 s media.
    expect(transitionHandles(24, { ...seg(1, 45), media: vid(3) }, seg(2, 48), fd)).toMatchObject({ h: 3, handleOut: 3 });
    expect(transitionHandles(24, { ...seg(1, 48), media: vid(3) }, seg(2, 48), fd)).toMatchObject({ h: 0, handleOut: 0 });
  });
  it('speed scales the handles (source seconds per timeline frame)', () => {
    expect(transitionHandles(48, { ...seg(2, 48), media: vid(10) }, seg(1, 48, 2), fd).handleIn).toBe(12);
    expect(transitionHandles(48, { ...seg(2, 48), media: vid(10) }, seg(1, 48, 0.5), fd).handleIn).toBe(48);
  });
  it('the clips limit it too', () => {
    expect(transitionHandles(24, { ...seg(2, 4), media: vid(10) }, seg(2, 48), fd)).toMatchObject({ h: 4, hClips: 4 });
  });
  it('stills and media of unknown length have unlimited handles', () => {
    expect(transitionHandles(24, { ...seg(0, 48), media: still }, seg(0, 48, 1, true), fd)).toMatchObject({ h: 12, handleOut: Infinity, handleIn: Infinity });
    expect(transitionHandles(24, { ...seg(9, 48), media: fixtureMedia('u', 'video', undefined) }, seg(2, 48), fd).handleOut).toBe(Infinity);
  });
});

describe('frame rate and VFR warnings', () => {
  it('names video media at another frame rate than the sequence, with a target', () => {
    const { seq, media, add } = setup();
    const m25 = add(fixtureMedia('m25', 'video', fixtureProbe({ duration: 10, fps: R(25) })));
    const m24 = add(fixtureMedia('m24', 'video', fixtureProbe({ duration: 10, fps: F24 })));
    fixtureClip(seq.videoTracks[0], m24, 0, 24, 0);
    const c = fixtureClip(seq.videoTracks[0], m25, 24, 24, 0);
    const items = checklist(seq, media);
    const it = find(items, FPS)!;
    expect(it.text).toBe('Source frame rate differs from the sequence (24 fps): m25.mp4 (25 fps). Frames are repeated or dropped to fit, so motion may stutter.');
    expect(it.level).toBe('warning');
    expect(it.target).toEqual({ frame: 24, clipIds: [c.id] });
    expect(checklistBlocks(items)).toBe(false);
  });

  it('compares exact rational rates (23.976 = 24000/1001, not 24)', () => {
    const { seq, media, add } = setup(R(24000, 1001));
    fixtureClip(seq.videoTracks[0], add(fixtureMedia('ntsc', 'video', fixtureProbe({ duration: 10, fps: R(24000, 1001) }))), 0, 24, 0);
    expect(find(checklist(seq, media), FPS)).toBeUndefined();
    fixtureClip(seq.videoTracks[0], add(fixtureMedia('film', 'video', fixtureProbe({ duration: 10, fps: R(24) }))), 24, 24, 0);
    expect(find(checklist(seq, media), FPS)!.text).toContain('(23.976 fps): film.mp4 (24 fps)');
  });

  it('ignores stills, audio-only media, unprobed media, disabled clips, muted tracks and clips outside In/Out', () => {
    const { seq, media, add } = setup();
    const m30 = add(fixtureMedia('m30', 'video', fixtureProbe({ duration: 10, fps: R(30) })));
    fixtureClip(seq.videoTracks[0], add(fixtureMedia('still', 'image', fixtureProbe({ duration: 0, fps: R(25), audio: false }))), 0, 24, 0);
    fixtureClip(seq.audioTracks[0], add(fixtureMedia('song', 'audio', fixtureProbe({ duration: 10, video: false }))), 0, 24, 0);
    fixtureClip(seq.videoTracks[0], add(fixtureMedia('raw', 'video', undefined)), 24, 24, 0);
    fixtureClip(seq.videoTracks[0], m30, 48, 24, 0, 1, { enabled: false });
    fixtureClip(seq.videoTracks[1], m30, 72, 24, 0);
    seq.videoTracks[1].muted = true;
    fixtureClip(seq.videoTracks[0], m30, 200, 24, 0);
    seq.view.inPoint = 0; seq.view.outPoint = 150;
    expect(find(checklist(seq, media, { rangeMode: 'inOut' }), FPS)).toBeUndefined();
    // The whole sequence includes the clip at 200.
    expect(find(checklist(seq, media, { rangeMode: 'entire' }), FPS)!.text).toContain('m30.mp4 (30 fps)');
    // A soloed track is the only one rendered, muted or not.
    seq.videoTracks[1].muted = false; seq.videoTracks[1].solo = true;
    expect(find(checklist(seq, media, { rangeMode: 'inOut' }), FPS)!.target!.frame).toBe(72);
  });

  it('caps the list at three media (in timeline order) and selects every clip involved', () => {
    const { seq, media, add } = setup();
    const rates = [R(25), R(30), R(50), R(60), R(30000, 1001)];
    const ids: string[] = [];
    rates.forEach((fps, i) => {
      const m = add(fixtureMedia(`r${i}`, 'video', fixtureProbe({ duration: 10, fps })));
      ids.push(fixtureClip(seq.videoTracks[0], m, i * 24, 24, 0).id);
    });
    ids.push(fixtureClip(seq.videoTracks[0], media.r0, 5 * 24, 24, 2).id);
    const it = find(checklist(seq, media), FPS)!;
    expect(it.text).toBe('Source frame rate differs from the sequence (24 fps): r0.mp4 (25 fps), r1.mp4 (30 fps), r2.mp4 (50 fps) and 2 more. Frames are repeated or dropped to fit, so motion may stutter.');
    expect(it.target!.frame).toBe(0);
    expect([...it.target!.clipIds].sort()).toEqual([...ids].sort());
  });

  it('flags VFR media separately (not in the frame-rate list)', () => {
    const { seq, media, add } = setup();
    fixtureClip(seq.videoTracks[0], add(fixtureMedia('phone', 'video', fixtureProbe({ duration: 10, fps: R(30), vfr: true }))), 10, 24, 0);
    fixtureClip(seq.videoTracks[0], add(fixtureMedia('cfr', 'video', fixtureProbe({ duration: 10, fps: F24 }))), 40, 24, 0);
    const items = checklist(seq, media);
    expect(find(items, FPS)).toBeUndefined();
    const it = find(items, VFR)!;
    expect(it.text).toBe('Variable frame rate (VFR) media in the sequence: phone.mp4. Frames are repeated or dropped unevenly; convert it to a constant frame rate if motion or sync looks off.');
    expect(it.target!.frame).toBe(10);
  });

  it('no VFR warning for constant-rate media', () => {
    const { seq, media, add } = setup();
    fixtureClip(seq.videoTracks[0], add(fixtureMedia('cfr', 'video', fixtureProbe({ duration: 10 }))), 0, 24, 0);
    expect(checklist(seq, media)).toEqual([]);
  });
});

describe('out-of-sync linked clips', () => {
  function pair(slip: number) {
    const { seq, media, add } = setup();
    const m = add(fixtureMedia('mv', 'video', fixtureProbe({ duration: 10 })));
    const v = fixtureClip(seq.videoTracks[0], m, 24, 48, 1, 1, { linkId: 'L1' });
    v.name = 'Hero shot';
    const a = fixtureClip(seq.audioTracks[0], m, 24 + slip, 48, 1, 1, { linkId: 'L1' });
    a.name = 'Hero shot';
    return { seq, media, v, a };
  }

  it('names the clip with the offset the timeline badge shows', () => {
    const { seq, media, v, a } = pair(-3);
    const it = find(checklist(seq, media), SYNC)!;
    expect(it.text).toBe('Linked clips out of sync: "Hero shot" (+3 frames). Picture and sound will not line up.');
    expect(it.target!.frame).toBe(24);
    expect([...it.target!.clipIds].sort()).toEqual([a.id, v.id].sort());
  });

  it('nothing when in sync, unlinked, or when the partner does not render', () => {
    expect(find(checklist(pair(0).seq, pair(0).media), SYNC)).toBeUndefined();
    const muted = pair(5);
    muted.seq.audioTracks[0].muted = true;
    expect(find(checklist(muted.seq, muted.media), SYNC)).toBeUndefined();
    const unlinked = pair(5);
    unlinked.v.linkId = null; unlinked.a.linkId = null;
    expect(find(checklist(unlinked.seq, unlinked.media), SYNC)).toBeUndefined();
    const disabled = pair(5);
    disabled.a.enabled = false;
    expect(find(checklist(disabled.seq, disabled.media), SYNC)).toBeUndefined();
  });

  it('caps the list at three pairs', () => {
    const { seq, media, add } = setup();
    const m = add(fixtureMedia('mv', 'video', fixtureProbe({ duration: 100 })));
    for (let i = 0; i < 5; i++) {
      fixtureClip(seq.videoTracks[0], m, i * 100, 48, 1, 1, { linkId: `L${i}`, name: `shot ${i}` });
      fixtureClip(seq.audioTracks[0], m, i * 100 + i + 1, 48, 1, 1, { linkId: `L${i}`, name: `shot ${i}` });
    }
    expect(find(checklist(seq, media), SYNC)!.text).toBe('Linked clips out of sync: "shot 0" (−1 frame), "shot 1" (−2 frames), "shot 2" (−3 frames) and 2 more. Picture and sound will not line up.');
  });
});

describe('transition handle warnings', () => {
  /** Two adjacent 48-frame clips A | B at frame 48 with a `D`-frame cross dissolve; B starts at `bIn` s in its media. */
  function cut(D: number, bIn: number, opts: { aFrames?: number; bFrames?: number; linkedAudio?: boolean } = {}) {
    const { seq, media, add } = setup();
    const m = add(fixtureMedia('mv', 'video', fixtureProbe({ duration: 20 })));
    const aFrames = opts.aFrames ?? 48, bFrames = opts.bFrames ?? 48;
    const a = fixtureClip(seq.videoTracks[0], m, 48 - aFrames, aFrames, 2, 1, { name: 'A' });
    const b = fixtureClip(seq.videoTracks[0], m, 48, bFrames, bIn, 1, { name: 'B' });
    seq.videoTracks[0].transitions.push({ id: 'tv', type: 'crossDissolve', duration: D, outClipId: a.id, inClipId: b.id });
    if (opts.linkedAudio) {
      const aa = fixtureClip(seq.audioTracks[0], m, 48 - aFrames, aFrames, 2, 1, { name: 'A' });
      const ba = fixtureClip(seq.audioTracks[0], m, 48, bFrames, bIn, 1, { name: 'B' });
      seq.audioTracks[0].transitions.push({ id: 'ta', type: 'audioCrossfade', duration: D, outClipId: aa.id, inClipId: ba.id });
    }
    return { seq, media, a, b };
  }

  it('dropped: no source before the incoming clip (hard cut), with the transition as target', () => {
    const { seq, media, a, b } = cut(24, 0);
    const items = checklist(seq, media);
    const it = find(items, DROPPED)!;
    expect(it.text).toBe('Transitions dropped (hard cut): "A" → "B" (not enough source media past the cut).');
    expect(it.target).toEqual({ frame: 48, clipIds: [a.id, b.id], transitionId: 'tv' });
    expect(find(items, SHORT)).toBeUndefined();
    expect(checklistBlocks(items)).toBe(false);
  });

  it('shortened: by how much and why', () => {
    expect(find(checklist(cut(24, 5 / 24).seq, cut(24, 5 / 24).media), SHORT)!.text)
      .toBe('Transitions shortened: "A" → "B" (24 → 10 frames, not enough source media past the cut).');
    const short = cut(24, 2, { bFrames: 4 });
    expect(find(checklist(short.seq, short.media), SHORT)!.text)
      .toBe('Transitions shortened: "A" → "B" (24 → 8 frames, the clips are shorter than the transition).');
  });

  it('a 1-frame transition is dropped as too short; full and odd lengths are not reported', () => {
    expect(find(checklist(cut(1, 2).seq, cut(1, 2).media), DROPPED)!.text).toContain('(too short to render)');
    expect(checklist(cut(24, 2).seq, cut(24, 2).media)).toEqual([]);
    expect(checklist(cut(13, 2).seq, cut(13, 2).media)).toEqual([]);
  });

  it('a linked video / audio pair of transitions with the same clips is listed once', () => {
    const { seq, media } = cut(24, 5 / 24, { linkedAudio: true });
    expect(find(checklist(seq, media), SHORT)!.text).toBe('Transitions shortened: "A" → "B" (24 → 10 frames, not enough source media past the cut).');
  });

  it('overlapping transitions at both ends of a short clip: the outgoing one is dropped', () => {
    const { seq, media, add } = setup();
    const m = add(fixtureMedia('mv', 'video', fixtureProbe({ duration: 20 })));
    const a = fixtureClip(seq.videoTracks[0], m, 0, 48, 2, 1, { name: 'A' });
    const b = fixtureClip(seq.videoTracks[0], m, 48, 10, 4, 1, { name: 'B' });
    const c = fixtureClip(seq.videoTracks[0], m, 58, 48, 6, 1, { name: 'C' });
    seq.videoTracks[0].transitions.push(
      { id: 't1', type: 'crossDissolve', duration: 16, outClipId: a.id, inClipId: b.id },
      { id: 't2', type: 'crossDissolve', duration: 16, outClipId: b.id, inClipId: c.id },
    );
    const items = checklist(seq, media);
    expect(find(items, DROPPED)!.text).toBe('Transitions dropped (hard cut): "B" → "C" (overlaps the transition at the other end of the clip).');
    expect(find(items, SHORT)).toBeUndefined();
  });

  it('only transitions in (or cut by) the export range', () => {
    const { seq, media } = cut(24, 0);
    seq.view.inPoint = 60; seq.view.outPoint = 90;
    expect(find(checklist(seq, media, { rangeMode: 'inOut' }), DROPPED)).toBeUndefined();
    seq.view.inPoint = 50; // inside the transition's window: the export renders it, so it reports it
    expect(find(checklist(seq, media, { rangeMode: 'inOut' }), DROPPED)).toBeDefined();
  });

  it('lists several transitions in timeline order, capped at three', () => {
    const { seq, media, add } = setup();
    const m = add(fixtureMedia('mv', 'video', fixtureProbe({ duration: 100 })));
    const clips: Clip[] = [];
    for (let i = 0; i < 6; i++) clips.push(fixtureClip(seq.videoTracks[0], m, i * 24, 24, 0, 1, { name: `S${i}` }));
    for (let i = 4; i >= 0; i--) seq.videoTracks[0].transitions.push({ id: `t${i}`, type: 'crossDissolve', duration: 12, outClipId: clips[i].id, inClipId: clips[i + 1].id });
    const it = find(checklist(seq, media), DROPPED)!;
    expect(it.text).toBe('Transitions dropped (hard cut): "S0" → "S1" (not enough source media past the cut), "S1" → "S2" (not enough source media past the cut), "S2" → "S3" (not enough source media past the cut) and 2 more.');
    expect(it.target!.transitionId).toBe('t0');
  });
});

describe('clips past the end of their media', () => {
  it('names the clip and the overrun; a linked pair counts once', () => {
    const { seq, media, add } = setup();
    const m = add(fixtureMedia('short', 'video', fixtureProbe({ duration: 2 })));
    const v = fixtureClip(seq.videoTracks[0], m, 0, 60, 0, 1, { name: 'Long take', linkId: 'L' }); // 2.5 s from a 2 s file
    fixtureClip(seq.audioTracks[0], m, 0, 60, 0, 1, { name: 'Long take', linkId: 'L' });
    fixtureClip(seq.videoTracks[0], m, 60, 24, 0, 1, { name: 'Fits' });
    const it = find(checklist(seq, media), PAST)!;
    expect(it.text).toBe('Clips run past the end of their media: "Long take" (by 0.50 s). The last frame is held and the sound is silent there.');
    expect(it.target!.clipIds[0]).toBe(v.id);
    expect(it.target!.clipIds).toHaveLength(2);
  });

  it('nothing for clips within their media, stills and unprobed media', () => {
    const { seq, media, add } = setup();
    fixtureClip(seq.videoTracks[0], add(fixtureMedia('ok', 'video', fixtureProbe({ duration: 2 }))), 0, 48, 0);
    fixtureClip(seq.videoTracks[0], add(fixtureMedia('png', 'image', fixtureProbe({ duration: 0, audio: false }))), 48, 480, 0);
    fixtureClip(seq.videoTracks[0], add(fixtureMedia('raw', 'video', undefined)), 600, 480, 0);
    expect(find(checklist(seq, media), PAST)).toBeUndefined();
  });
});

describe('memoization and cost', () => {
  it('reuses the result while the sequence, media and range are the same', () => {
    const { seq, media, add } = setup();
    fixtureClip(seq.videoTracks[0], add(fixtureMedia('m25', 'video', fixtureProbe({ duration: 10, fps: R(25) }))), 0, 24, 0);
    const a = sequenceExportWarnings(seq, media, 0, 24);
    expect(sequenceExportWarnings(seq, media, 0, 24)).toBe(a);
    expect(sequenceExportWarnings(seq, media, 0, 12)).not.toBe(a);
    expect(sequenceExportWarnings({ ...seq }, media, 0, 12)).toHaveLength(1);
  });

  it('a 6,700-clip, 3 h sequence: checks in well under 100 ms (O(clips))', () => {
    const { seq, media, add } = setup();
    const ms = [0, 1, 2, 3, 4].map((i) => add(fixtureMedia(`ep${i}`, 'video', fixtureProbe({ duration: 2700, fps: i === 4 ? R(25) : F24, vfr: i === 3 }))));
    // 3 h at 24 fps = 259,200 frames: 3,350 clips per track on V1 and A1 (avg 77 frames), linked, with dissolves.
    let pos = 0;
    for (let i = 0; i < 3350; i++) {
      const m = ms[i % ms.length];
      const len = 40 + ((i * 37) % 75);
      const srcIn = (i * 13) % 2600;
      const v = fixtureClip(seq.videoTracks[0], m, pos, len, i % 9 === 0 ? 0 : srcIn, 1, { linkId: `L${i}` });
      fixtureClip(seq.audioTracks[0], m, pos + (i % 50 === 0 ? 2 : 0), len, i % 9 === 0 ? 0 : srcIn, 1, { linkId: `L${i}` });
      if (i > 0 && i % 4 === 0) seq.videoTracks[0].transitions.push({ id: `t${i}`, type: 'crossDissolve', duration: 12, outClipId: seq.videoTracks[0].clips[i - 1].id, inClipId: v.id });
      pos += len;
    }
    const settings = fixtureSettings();
    // Warm up (JIT), then time a cold computation (a new sequence object defeats the memo).
    exportChecklist({ ...seq }, media, settings);
    const runs: number[] = [];
    for (let k = 0; k < 5; k++) {
      const s = { ...seq };
      const t0 = performance.now();
      const items = exportChecklist(s, media, settings);
      runs.push(performance.now() - t0);
      expect(items.map((i) => i.text.split(':')[0]).sort()).toEqual(['Linked clips out of sync', 'Source frame rate differs from the sequence (24 fps)', 'Transitions dropped (hard cut)', 'Variable frame rate (VFR) media in the sequence']);
    }
    const median = runs.sort((a, b) => a - b)[2];
    console.log(`export checklist on ${seq.videoTracks[0].clips.length + seq.audioTracks[0].clips.length} clips / ${pos} frames: median ${median.toFixed(1)} ms (runs ${runs.map((r) => r.toFixed(1)).join(', ')})`);
    expect(median).toBeLessThan(100);
    // Memoized: settings-only changes (file name, quality) do not redo the timeline checks.
    exportChecklist(seq, media, settings);
    const memo = sequenceExportWarnings(seq, media, 0, pos);
    exportChecklist(seq, media, { ...settings, fileName: 'x.mp4', crf: 30 });
    expect(sequenceExportWarnings(seq, media, 0, pos)).toBe(memo);
  });
});

describe('parity with the render graph', () => {
  /** Transition durations (seconds strings) the filter graph renders: xfade (video) and acrossfade (audio). */
  function renderedTransitionDurations(graph: string): string[] {
    const out: string[] = [];
    for (const m of graph.matchAll(/xfade=transition=\w+:duration=([\d.]+)/g)) out.push(m[1]);
    for (const m of graph.matchAll(/acrossfade=d=([\d.]+)/g)) out.push(m[1]);
    return out.sort();
  }

  it('hand-picked cases: the predicted frames are the frames the graph renders', () => {
    const cases: { D: number; bIn: number; bFrames?: number; expect: number }[] = [
      { D: 24, bIn: 2, expect: 24 },          // full
      { D: 13, bIn: 2, expect: 12 },          // odd: one frame less, not reported
      { D: 24, bIn: 5 / 24, expect: 10 },     // short in-handle
      { D: 24, bIn: 0, expect: 0 },           // no in-handle: dropped
      { D: 24, bIn: 2, bFrames: 4, expect: 8 }, // short clip
      { D: 1, bIn: 2, expect: 0 },            // too short to render
    ];
    for (const c of cases) {
      const { seq, media, add } = setup();
      const m = add(fixtureMedia('mv', 'video', fixtureProbe({ duration: 20 })));
      const a = fixtureClip(seq.videoTracks[0], m, 0, 48, 2, 1, { name: 'A' });
      const b = fixtureClip(seq.videoTracks[0], m, 48, c.bFrames ?? 48, c.bIn, 1, { name: 'B' });
      seq.videoTracks[0].transitions.push({ id: 't', type: 'crossDissolve', duration: c.D, outClipId: a.id, inClipId: b.id });
      const checks = exportTimelineChecks(seq, media, 0, 48 + (c.bFrames ?? 48));
      expect(checks.transitions).toHaveLength(1);
      expect(checks.transitions[0].to).toBe(c.expect);
      const g = buildRenderGraph({ sequence: seq, media, settings: fixtureSettings() });
      expect(renderedTransitionDurations(g.filterGraph)).toEqual(c.expect ? [sec(c.expect / 24)] : []);
    }
  });

  it('random sequences: the checklist predicts every transition and media-end overrun the export renders', () => {
    let graphs = 0, issues = 0, pastEnd = 0;
    for (let seed = 1; seed <= 1500; seed++) {
      const req = randomExportRequest(seed);
      const { sequence: seq, media, settings } = req;
      let g;
      try { g = buildRenderGraph(req); } catch { continue; } // nothing to export in the range
      graphs++;
      const range = exportRange(seq, settings);
      expect([g.startF, g.endF], `seed ${seed}`).toEqual([range.startF, range.endF]);
      const checks = exportTimelineChecks(seq, media, range.startF, range.endF);
      const fd = seq.fps.den / seq.fps.num;
      // Transition lengths: what the dialog predicts is what the graph renders (dropped ones render nothing).
      const predicted = checks.transitions.filter((t) => t.to > 0).map((t) => sec(t.to * fd)).sort();
      expect(renderedTransitionDurations(g.filterGraph), `seed ${seed}`).toEqual(predicted);
      // The dialog reports exactly the transitions the graph warns about, with the same lengths.
      const graphShort = g.warnings.flatMap((w) => /shortened from (\d+) to (\d+) frames/.exec(w)?.slice(1, 3).join('>') ?? []);
      const graphDropped = g.warnings.filter((w) => /dropped: |not on an adjacent cut|both sides of .* overlap|edge of the export range/.test(w)).length;
      const reported = checks.transitions.filter((t) => t.reason !== null);
      // (The graph says nothing when a second transition on the same cut replaces the first; the dialog does.)
      const replaced = reported.filter((t) => t.reason === 'replaced').length;
      expect(reported.filter((t) => t.to === 0).length - replaced, `seed ${seed}`).toBe(graphDropped);
      // A transition shortened and then dropped (overlap, replaced) still has its "shortened" warning in the graph.
      const shortenedThenDropped = g.warnings.filter((w) => /both sides of .* overlap/.test(w)).length;
      const short = reported.filter((t) => t.to > 0).map((t) => `${t.from}>${t.to}`).sort();
      expect(graphShort.length - short.length, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      expect(graphShort.length - short.length, `seed ${seed}`).toBeLessThanOrEqual(shortenedThenDropped + replaced);
      for (const s of short) expect(graphShort, `seed ${seed}`).toContain(s);
      // Clips past the end of their media.
      const graphPast = g.warnings.filter((w) => /extends past the end of its media/.test(w)).map((w) => /^Clip "(.*)" on /.exec(w)![1]).sort();
      expect(checks.pastEnd.map((p) => p.clip.name).sort(), `seed ${seed}`).toEqual(graphPast);
      issues += reported.length; pastEnd += checks.pastEnd.length;
    }
    // The fixture exercises the cases (not a vacuous pass).
    expect(graphs).toBeGreaterThan(1400);
    expect(issues).toBeGreaterThan(1000);
    expect(pastEnd).toBeGreaterThan(500);
  });
});
