/**
 * Everything that walks clips handles nested sequence clips (Roadmap §8): transcript "on timeline" hits, the Compare
 * diff, linked-clip sync, Collect Project, Match Frame and the Export dialog's checklist.
 */
import { describe, it, expect } from 'vitest';
import type { Clip, ID, MediaItem, Project, Sequence } from '../../shared/model';
import { createMediaItem, createProject, createSequence } from '../../shared/project';
import { makeClip } from '../../shared/timeline';
import { sourceUnder } from '../../shared/nest';
import { linkedSyncOffsets } from '../../shared/linkSync';
import { collectedMedia } from '../../shared/collect';
import { buildTranscriptIndex, searchTranscript } from '../../src/transcript/index';
import { diffSequences } from '../../src/panels/compare/diff';
import { exportChecklist } from '../../src/panels/export/settings';
import { buildRenderGraph } from '../../electron/export/renderGraph';
import { fixtureSettings } from './export-plan-fixture';

const FPS = { num: 24, den: 1 };
function media(id: string): MediaItem {
  const m = createMediaItem(`/media/${id}.mkv`, `${id}.mkv`);
  return {
    ...m, id, kind: 'video', probe: {
      container: 'matroska', duration: 100, size: 1, startTime: 0, browserPlayable: true, subtitles: [],
      video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: FPS, avgFps: FPS, isVfr: false },
      audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
    },
  };
}
function clip(m: string, start: number, len: number, src: number, kind: 'video' | 'audio' = 'video', over: Partial<Clip> = {}): Clip {
  return Object.assign(makeClip({ mediaId: m, name: m, sourceIn: src, duration: len, kind }, start), over);
}
function nested(seqId: string, start: number, len: number, src: number, kind: 'video' | 'audio' = 'video', over: Partial<Clip> = {}): Clip {
  return clip(seqId, start, len, src, kind, { sequenceId: seqId, name: 'Act', ...over });
}

/** Project: Inner = A [0,48) @10 s (+ audio); Outer = B [0,24) then Inner from inner frame 12 for 24 frames (V + A). */
function project(): { p: Project; outer: Sequence; inner: Sequence } {
  const p = createProject('n');
  p.media = { A: media('A'), B: media('B'), C: media('C') };
  const inner = createSequence('Inner', FPS); inner.id = 'inner';
  inner.videoTracks[0].clips.push(clip('A', 0, 48, 10, 'video', { linkId: 'IL' }));
  inner.audioTracks[0].clips.push(clip('A', 0, 48, 10, 'audio', { linkId: 'IL' }));
  const outer = createSequence('Outer', FPS); outer.id = 'outer';
  outer.videoTracks[0].clips.push(clip('B', 0, 24, 0), nested('inner', 24, 24, 0.5, 'video', { id: 'nv', linkId: 'L' }));
  outer.audioTracks[0].clips.push(clip('B', 0, 24, 0, 'audio'), nested('inner', 24, 24, 0.5, 'audio', { id: 'na', linkId: 'L' }));
  p.sequences = { inner, outer };
  p.sequenceOrder = ['outer', 'inner'];
  p.activeSequenceId = 'outer';
  return { p, outer, inner };
}

describe('nested clips in the walkers', () => {
  it('transcript search in a sequence finds lines spoken inside its nested clips, on the nested clip', () => {
    const { p } = project();
    p.subtitleTracks = { st: { id: 'st', name: 'A', language: 'en', mediaId: 'A', origin: 'srt', cues: [
      { id: 'c1', start: 11, end: 11.5, text: 'inside the act' },   // A 11 s = inner frame 24 = outer frame 36
      { id: 'c2', start: 50, end: 51, text: 'not used anywhere' },
    ] } };
    p.media.A.subtitleTrackIds = ['st'];
    const r = searchTranscript(buildTranscriptIndex(p), 'the act', { kind: 'sequence', sequenceId: 'outer' });
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].timeline).toEqual([expect.objectContaining({ clipId: 'nv', clipName: 'Act', frame: 36, endFrame: 48, trackId: p.sequences.outer.videoTracks[0].id })]);
    expect(searchTranscript(buildTranscriptIndex(p), 'anywhere', { kind: 'sequence', sequenceId: 'outer' }).matches).toHaveLength(0);
  });

  it('the Compare diff treats a nested clip as one clip of its sequence', () => {
    const { outer } = project();
    const b: Sequence = { ...outer, id: 'b', videoTracks: outer.videoTracks.map((t, i) => (i ? t : { ...t, clips: t.clips.map((c) => (c.id === 'nv' ? { ...c, start: 30 } : c)) })) };
    const d = diffSequences(outer, b);
    const nv = d.a.find((e) => e.clipId === 'nv')!;
    expect(nv.kind).toBe('moved');
    expect(nv.mediaId).toBe('inner');
  });

  it('linked nested clips get the out-of-sync badge like media clips', () => {
    const { outer } = project();
    expect(linkedSyncOffsets([...outer.videoTracks, ...outer.audioTracks], FPS).size).toBe(0);
    const slipped = outer.audioTracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === 'na' ? { ...c, sourceIn: 1 } : c)) }));
    expect(linkedSyncOffsets([...outer.videoTracks, ...slipped], FPS).get('na')).toBe(-12);
  });

  it('Collect Project counts media used only inside a nested sequence as used', () => {
    const { p } = project();
    expect(collectedMedia(p, { scope: 'sequences' }).map((m) => m.id).sort()).toEqual(['A', 'B']);
  });

  it('Match Frame goes through a nested clip to the media at the inner frame', () => {
    const { p, outer } = project();
    const nv = outer.videoTracks[0].clips[1];
    const u = sourceUnder(outer, nv, 30, p.sequences, p.media)!;
    expect(u.clip.mediaId).toBe('A');
    expect(u.time).toBeCloseTo(10 + (12 + 6) / 24, 9);
    expect(sourceUnder(outer, outer.videoTracks[0].clips[0], 5, p.sequences, p.media)!.time).toBeCloseTo(5 / 24, 9);
  });

  it('the Export checklist sees the media inside nested clips, and no "missing media" for the nested clips', () => {
    const { p, outer } = project();
    const items = exportChecklist(outer, p.media, fixtureSettings({ width: 1920, height: 1080, fps: FPS }), false, p.sequences);
    expect(items.filter((i) => i.level === 'error')).toEqual([]);
    const offline = { ...p.media, A: { ...p.media.A, offline: true } };
    const items2 = exportChecklist(outer, offline, fixtureSettings({ width: 1920, height: 1080, fps: FPS }), false, p.sequences);
    expect(items2.some((i) => i.level === 'error' && /Offline media.*A\.mkv/.test(i.text))).toBe(true);
    // A nested clip of a deleted sequence: a warning, not an error.
    const gone: Record<ID, Sequence> = { outer };
    const items3 = exportChecklist(outer, p.media, fixtureSettings({ width: 1920, height: 1080, fps: FPS }), false, gone);
    expect(items3.some((i) => i.level === 'warning' && /missing from the project; rendered as black/.test(i.text))).toBe(true);
    expect(items3.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('export: an MKV output track mixes the nested audio of its source tracks; chapters come from the outer sequence only', () => {
    const { p, outer, inner } = project();
    inner.markers.push({ id: 'mi', time: 6, name: 'Inner chapter', kind: 'chapter', color: '#fff' } as never);
    outer.markers.push({ id: 'mo', time: 0, name: 'Outer chapter', kind: 'chapter', color: '#fff' } as never);
    outer.audioTracks[1].clips.push(clip('C', 0, 48, 0, 'audio'));
    const [a1, a2] = outer.audioTracks;
    const g = buildRenderGraph({
      sequence: outer, sequences: { inner }, media: p.media,
      settings: fixtureSettings({ container: 'mkv', fileName: 'o.mkv', audioOutputs: [
        { sources: [a1.id], layout: 'stereo', codec: 'aac' }, { sources: [a2.id], layout: 'stereo', codec: 'aac' },
      ] }),
    });
    const chains = g.filterGraph.split(';');
    // Output 0 (A1): B's sound and the nested content of A1 (media A); output 1 (A2): C only.
    expect(chains.find((c) => c.endsWith('[aout]'))).toMatch(/amix=inputs=2/);
    expect(chains.find((c) => c.endsWith('[aout1]'))).not.toMatch(/amix/);
    expect(g.args.filter((a) => a.startsWith('/media/'))).toEqual(['/media/B.mkv', '/media/A.mkv', '/media/C.mkv']);
    expect(g.chaptersContent).toContain('title=Outer chapter');
    expect(g.chaptersContent).not.toContain('Inner chapter');
  });
});
