/**
 * Hostile .recut files against the 0.8.0 features (nested sequences, keyframes, per-clip channel selection, stored
 * probes of many-track files). Every file is written to disk and opened through electron/project/io loadProjectFile,
 * as File > Open does. Contract: the loader refuses or repairs (and says so), never throws a TypeError, never hangs,
 * never loses a clip; what it returns renders (buildRenderGraph) and saves / reloads without further repairs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProject, createSequence, normalizeProjectWithReport } from '../../shared/project';
import { makeClip, allTracks } from '../../shared/timeline';
import { MAX_FLAT_CLIPS, MAX_FLAT_TRACKS, MAX_NEST_DEPTH, flattenedSize, nestDepthBelow, nestedSequencesFor, nestingRepairs, flattenSequence } from '../../shared/nest';
import { MAX_KEYFRAMES_PER_PROPERTY } from '../../shared/keyframes';
import { streamChannelIds, clipAudioStream } from '../../shared/audioChannels';
import { loadProjectFile, saveProjectFile } from '../../electron/project/io';
import { buildRenderGraph } from '../../electron/export/renderGraph';
import type { Clip, ExportSettings, Project, Sequence } from '../../shared/model';
import { fakeMedia } from './helpers';

let tmp: string;
beforeEach(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'recut-attack-080-')); });
afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });

const F24 = { num: 24, den: 1 };

/** Write `raw` (already JSON text, or an object) as a .recut and open it the way File > Open does. */
async function open(raw: unknown, name = 'hostile.recut') {
  const file = path.join(tmp, name);
  await fsp.writeFile(file, typeof raw === 'string' ? raw : JSON.stringify(raw));
  const res = await loadProjectFile(file);
  return { file, res };
}

function exportSettings(seq: Sequence): ExportSettings {
  return {
    outputDir: tmp, fileName: 'x', width: 320, height: 240, fps: seq.fps, videoCodec: 'libx264', qualityMode: 'crf', crf: 20,
    videoBitrateKbps: 0, preset: 'ultrafast', audioCodec: 'aac', audioBitrateKbps: 96, audioChannels: 2, sampleRate: 48000,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false,
  } as ExportSettings;
}

/** Build the export graph of every sequence of `p`; returns the filter text of each. */
function renderAll(p: Project): string[] {
  return p.sequenceOrder.map((id) => {
    const seq = p.sequences[id];
    const g = buildRenderGraph({ sequence: seq, sequences: nestedSequencesFor(seq, p.sequences), media: p.media, settings: exportSettings(seq) });
    expect(Number.isFinite(g.durationSec), `durationSec of ${id}`).toBe(true);
    return g.filterGraph;
  });
}

const clipCount = (p: Project) => Object.values(p.sequences).reduce((n, s) => n + allTracks(s).reduce((k, t) => k + t.clips.length, 0), 0);

/** Saving the loaded project and opening it again repairs nothing more. */
async function stable(p: Project) {
  const file = path.join(tmp, 'resaved.recut');
  const s = await saveProjectFile(file, p);
  expect(s.ok).toBe(true);
  const again = await loadProjectFile(file);
  expect(again.ok).toBe(true);
  if (again.ok) expect(again.repaired ?? []).toEqual([]);
}

function seqWithId(id: string, name = id): Sequence {
  const s = createSequence(name, F24, 320, 240);
  s.id = id;
  return s;
}
function nestedClip(id: string, child: string, start = 0, duration = 48): Clip {
  return { ...makeClip({ mediaId: child, name: `nest ${child}`, sourceIn: 0, duration, kind: 'video' }, start), id, sequenceId: child };
}
function projectOf(seqs: Sequence[]): Project {
  const p = createProject('hostile');
  const media = fakeMedia('movie.mp4', 100);
  p.media = { [media.id]: media };
  p.sequences = Object.fromEntries(seqs.map((s) => [s.id, s]));
  p.sequenceOrder = seqs.map((s) => s.id);
  p.activeSequenceId = seqs[0].id;
  for (const s of seqs) s.videoTracks[0].clips.push(makeClip({ mediaId: media.id, name: 'leaf', sourceIn: 0, duration: 48, kind: 'video' }, 200));
  return p;
}

describe('nested sequences: cycles and depth in a hostile file', () => {
  it('self-reference, a two-sequence cycle and a cycle that only exists inside snapshot data are cut; no clip is lost', async () => {
    const a = seqWithId('A'), b = seqWithId('B'), c = seqWithId('C');
    a.videoTracks[0].clips.push(nestedClip('self', 'A'));             // A in A
    b.videoTracks[0].clips.push(nestedClip('b>c', 'C'));
    c.videoTracks[0].clips.push(nestedClip('c>b', 'B'));              // B in C in B
    const p = projectOf([a, b, c]);
    // A snapshot of A whose data nests A itself.
    const snapData = JSON.parse(JSON.stringify(a)) as Sequence;
    snapData.videoTracks[0].clips = [nestedClip('snap-self', 'A')];
    a.snapshots = [{ id: 'snap1', name: 'v1', createdAt: 1, data: snapData } as unknown as Sequence['snapshots'][number]];
    const before = clipCount(p);
    const { res } = await open(p);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const q = res.project;
    expect(res.repaired?.join('\n')).toMatch(/nested sequence that contained itself/);
    expect(clipCount(q), 'clips lost while cutting cycles').toBe(before);
    expect(nestingRepairs(q.sequences, q.sequenceOrder)).toEqual([]);
    const self = q.sequences.A.videoTracks[0].clips.find((x) => x.id === 'self')!;
    expect(self.sequenceId).toBeUndefined();
    renderAll(q);
    await stable(q);
  });

  it(`a chain ${MAX_NEST_DEPTH * 5} sequences deep is cut to at most ${MAX_NEST_DEPTH} levels and renders`, async () => {
    const n = MAX_NEST_DEPTH * 5;
    const seqs = Array.from({ length: n }, (_, i) => seqWithId(`S${i}`));
    for (let i = 0; i + 1 < n; i++) seqs[i].videoTracks[0].clips.push(nestedClip(`n${i}`, `S${i + 1}`));
    const p = projectOf(seqs);
    const before = clipCount(p);
    const { res } = await open(p);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const q = res.project;
    expect(clipCount(q)).toBe(before);
    for (const id of q.sequenceOrder) expect(nestDepthBelow(q.sequences, id), id).toBeLessThanOrEqual(MAX_NEST_DEPTH);
    expect(res.repaired?.join('\n')).toMatch(/nested too deep/);
    renderAll(q);
    await stable(q);
  });

  it('a reference to a missing sequence or to an Object.prototype name opens and renders as nothing, with a warning', async () => {
    const a = seqWithId('A');
    a.videoTracks[0].clips.push(nestedClip('ghost', 'no-such-seq', 0, 24), nestedClip('proto', 'constructor', 24, 24), nestedClip('proto2', '__proto__', 48, 24));
    const p = projectOf([a]);
    const text = JSON.stringify(p);
    const { res } = await open(text);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const q = res.project;
    expect(clipCount(q)).toBe(clipCount(JSON.parse(text) as Project));
    const seq = q.sequences.A;
    const g = buildRenderGraph({ sequence: seq, sequences: nestedSequencesFor(seq, q.sequences), media: q.media, settings: exportSettings(seq) });
    expect(g.warnings.join('\n')).toMatch(/missing from the project|is missing|offline/i);
    await stable(q);
  });

  // bugs/closed/2026-10-08-nested-fan-out-flatten-blowup.md @ 59eafc6: 4 tracks x 8 levels flattened to 349,524 tracks in ~2 s,
  // 5 tracks threw "Maximum call stack size exceeded" in buildFlat. The loader now cuts the nested references past
  // the flattened size limit (MAX_FLAT_TRACKS / MAX_FLAT_CLIPS), as it cuts too-deep ones.
  for (const K of [4, 5]) {
    it(`fan-out within the depth limit (every level nests the next one on ${K} tracks, 8 levels) is cut to the size limit and stays bounded`, async () => {
      // Legal by the depth rule (8 levels), but every level multiplies the flattened tracks by K.
      const seqs = Array.from({ length: MAX_NEST_DEPTH + 1 }, (_, i) => {
        const s = seqWithId(`L${i}`);
        while (s.videoTracks.length < K) s.videoTracks.push({ ...s.videoTracks[0], id: `L${i}-v${s.videoTracks.length}`, clips: [], transitions: [] });
        return s;
      });
      for (let i = 0; i < MAX_NEST_DEPTH; i++) for (let k = 0; k < K; k++) seqs[i].videoTracks[k].clips.push(nestedClip(`L${i}-n${k}`, `L${i + 1}`));
      const p = projectOf(seqs);
      // The innermost level shows its media inside the nested window (0..48) on every track.
      const bottom = p.sequences[`L${MAX_NEST_DEPTH}`];
      for (const t of bottom.videoTracks) t.clips = [makeClip({ mediaId: Object.keys(p.media)[0], name: 'leaf', sourceIn: 0, duration: 48, kind: 'video' }, 0)];
      const before = clipCount(p);
      const { res } = await open(p);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const q = res.project;
      expect(res.repaired?.join('\n')).toMatch(/nested sequence that would expand to more than [\d,]+ tracks or [\d,]+ clips when flattened made offline/);
      expect(clipCount(q), 'clips lost while cutting').toBe(before);
      for (const id of q.sequenceOrder) {
        const size = flattenedSize(q.sequences, id);
        expect(size.tracks, id).toBeLessThanOrEqual(MAX_FLAT_TRACKS);
        expect(size.clips, id).toBeLessThanOrEqual(MAX_FLAT_CLIPS);
      }
      const t0 = performance.now();
      const flat = flattenSequence(q.sequences.L0, q.sequences, q.media);
      const ms = performance.now() - t0;
      const leaves = allTracks(flat).reduce((n, t) => n + t.clips.filter((c) => !c.sequenceId).length, 0);
      console.log(`[fan-out ${K}^${MAX_NEST_DEPTH}] repaired: ${res.repaired?.join('; ')}; flatten ${ms.toFixed(0)} ms, ${flat.videoTracks.length} video tracks, ${leaves} clips`);
      expect(ms, 'flattening a small hostile file must not stall the preview / export').toBeLessThan(1000);
      expect(flat.videoTracks.length + flat.audioTracks.length, 'flattened tracks').toBeLessThanOrEqual(MAX_FLAT_TRACKS);
      renderAll(q);
      await stable(q);
    });
  }
});

describe('keyframes: malformed and oversized lists', () => {
  it('100k keyframes, junk entries, unknown and prototype property names: capped, finite, sorted; the export expression is finite', async () => {
    const a = seqWithId('A');
    const p = projectOf([a]);
    const clip = a.videoTracks[0].clips[0];
    const many = Array.from({ length: 100_000 }, (_, i) => ({ frame: (i * 7919) % 100_003, value: (i % 100) / 100 }));
    const junk = [null, 5, 'x', [], { frame: '3', value: 1 }, { frame: 1e300, value: 0.5 }, { frame: -1e300, value: 0.5 }, { frame: 2, value: 1e308 }, { frame: 4, value: -1e308, interp: 'bounce' }];
    // Built as text so "__proto__" is an own key, as JSON.parse produces from a file.
    const raw = clip as unknown as Record<string, unknown>;
    delete raw.transform; delete raw.audio;
    let text = JSON.stringify(p);
    const kf = `{"opacity":${JSON.stringify([...junk, ...many])},"scale":${JSON.stringify(junk)},"x":"nope","evil":[{"frame":0,"value":1}],"__proto__":{"polluted":true},"constructor":[{"frame":0,"value":1}]}`;
    const audioKf = `{"volume":${JSON.stringify([{ frame: 0, value: 1e308 }, { frame: 10, value: -5 }, { frame: 20 }])},"gain":[{"frame":0,"value":-1e308}]}`;
    text = text.replace(`"id":"${clip.id}"`, `"id":"${clip.id}","transform":{"x":0,"y":0,"scale":1,"rotation":0,"opacity":1,"crop":{"left":0,"top":0,"right":0,"bottom":0},"keyframes":${kf}},"audio":{"gain":0,"volume":1,"fadeIn":0,"fadeOut":0,"muted":false,"keyframes":${audioKf}}`);
    const { res } = await open(text);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const q = res.project;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const c = q.sequences.A.videoTracks[0].clips.find((x) => x.id === clip.id)!;
    const keys = c.transform.keyframes ?? {};
    expect(Object.keys(keys).sort()).toEqual(['opacity', 'scale'].filter((k) => k in keys).sort());
    for (const list of Object.values(keys)) {
      expect(list!.length).toBeLessThanOrEqual(MAX_KEYFRAMES_PER_PROPERTY);
      for (let i = 0; i < list!.length; i++) {
        expect(Number.isFinite(list![i].frame) && Number.isFinite(list![i].value)).toBe(true);
        if (i) expect(list![i].frame).toBeGreaterThan(list![i - 1].frame);
      }
    }
    expect(res.repaired?.join('\n')).toMatch(/keyframes/);
    const [filter] = renderAll(q);
    expect(filter).not.toMatch(/NaN|Infinity|\de[+-]\d/);
    await stable(q);
  });
});

describe('channel selection and stored probes', () => {
  it('absurd per-clip selections and stream indices load as a valid selection or the normal mix, and the export builds', async () => {
    const a = seqWithId('A');
    const p = projectOf([a]);
    const m = Object.values(p.media)[0];
    m.probe!.audio = [{ index: 1, codec: 'ac3', channels: 6, layout: '5.1', sampleRate: 48000 }];
    const sels: unknown[] = [
      { mode: 'channel', channel: 'FC' }, { mode: 'channel', channel: 'c99' }, { mode: 'channel', channel: 'TBR' },
      { mode: 'channel', channel: '__proto__' }, { mode: 'channel', channel: 'c'.repeat(10_000) }, { mode: 'channel' },
      { mode: 'downmix', centreDb: 1e308, surroundDb: -1e308 }, { mode: 'downmix', centreDb: 'loud' }, { mode: 'eval' }, [], 'FC', null,
    ];
    const streams: unknown[] = [1, 999_999, -1, 1.5, '1', null, 2 ** 53, 1, 1, 1, 1, 1];
    sels.forEach((sel, i) => {
      const c = makeClip({ mediaId: m.id, name: `a${i}`, sourceIn: 0, duration: 12, kind: 'audio' }, i * 12);
      (c as unknown as Record<string, unknown>).audioStream = streams[i];
      (c.audio as unknown as Record<string, unknown>).channelSelection = sel;
      a.audioTracks[0].clips.push(c);
    });
    const { res } = await open(p);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const q = res.project;
    const clips = q.sequences.A.audioTracks[0].clips;
    expect(clips.length).toBe(sels.length);
    for (const c of clips) {
      const sel = c.audio.channelSelection;
      if (sel?.mode === 'channel') expect(sel.channel.length).toBeLessThanOrEqual(5);
      if (sel?.mode === 'downmix') expect(Number.isFinite(sel.centreDb) && Number.isFinite(sel.surroundDb)).toBe(true);
      if (c.audioStream !== undefined) expect(Number.isSafeInteger(c.audioStream) && c.audioStream >= 0).toBe(true);
    }
    const [filter] = renderAll(q);
    expect(filter).not.toMatch(/c99|NaN|Infinity/);
    await stable(q);
  });

  it('a stored probe with absurd audio streams (channel counts, indices, types) is repaired, not trusted', async () => {
    const a = seqWithId('A');
    const p = projectOf([a]);
    const m = Object.values(p.media)[0];
    m.offline = true; // the file is not there, so nothing re-probes it: the stored probe is all the app has
    m.probe!.audio = [
      { index: 1, codec: 'pcm', channels: 1e9, layout: '', sampleRate: 48000 },
      { index: 2, codec: 'pcm', channels: -3, layout: 'stereo', sampleRate: -1 },
      { index: 'x', codec: 7, channels: '6', layout: 42, sampleRate: 'fast' },
      null, 'stream',
    ] as unknown as NonNullable<typeof m.probe>['audio'];
    for (let i = 0; i < 3; i++) {
      a.audioTracks[0].clips.push(makeClip({ mediaId: m.id, name: `s${i}`, sourceIn: 0, duration: 12, kind: 'audio', audioStream: i + 1 }, i * 12));
    }
    const { res } = await open(p);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const q = res.project;
    const audio = q.media[m.id].probe!.audio;
    for (const s of audio) {
      expect(Number.isSafeInteger(s.index) && s.index >= 0, `index ${String(s.index)}`).toBe(true);
      expect(Number.isSafeInteger(s.channels) && s.channels >= 0, `channels ${String(s.channels)}`).toBe(true);
      expect(typeof s.codec === 'string' && typeof s.layout === 'string').toBe(true);
      expect(Number.isFinite(s.sampleRate) && s.sampleRate >= 0).toBe(true);
    }
    // What the Inspector's channel menu lists for each clip (ClipInspector: streamChannelIds) stays a sane size.
    for (const c of q.sequences.A.audioTracks[0].clips) {
      const t0 = performance.now();
      const ids = streamChannelIds(clipAudioStream(q.media[m.id], c));
      expect(ids.length, 'a stored channel id is c0..c99 at most').toBeLessThanOrEqual(100);
      expect(performance.now() - t0).toBeLessThan(100);
    }
    renderAll(q);
    await stable(q);
  });
});

describe('stored probes of many-track files', () => {
  it('a stored MKV probe listing 500 audio and 500 subtitle streams opens quickly and a clip on the last stream renders', async () => {
    const a = seqWithId('A');
    const p = projectOf([a]);
    const m = Object.values(p.media)[0];
    m.path = '/media/many.mkv'; m.name = 'many.mkv';
    m.probe!.container = 'matroska,webm';
    m.probe!.audio = Array.from({ length: 500 }, (_, i) => ({ index: 1 + i, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000, language: 'eng', title: `Track ${i}` }));
    m.probe!.subtitles = Array.from({ length: 500 }, (_, i) => ({ index: 501 + i, codec: 'subrip', language: 'eng' }));
    const c = makeClip({ mediaId: m.id, name: 'last', sourceIn: 0, duration: 24, kind: 'audio', audioStream: 500 }, 0);
    a.audioTracks[0].clips.push(c);
    const t0 = performance.now();
    const { res } = await open(p);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.repaired ?? []).toEqual([]);
    const [filter] = renderAll(res.project);
    expect(filter).toMatch(/\[\d+:500\]/);
  });
});

describe('normalize is idempotent on everything above', () => {
  it('normalizing a repaired hostile project again reports nothing', () => {
    const a = seqWithId('A'), b = seqWithId('B');
    a.videoTracks[0].clips.push(nestedClip('ab', 'B'));
    b.videoTracks[0].clips.push(nestedClip('ba', 'A'));
    const once = normalizeProjectWithReport(JSON.parse(JSON.stringify(projectOf([a, b]))));
    expect(once.repairs.length).toBeGreaterThan(0);
    expect(normalizeProjectWithReport(JSON.parse(JSON.stringify(once.project))).repairs).toEqual([]);
  });
});
