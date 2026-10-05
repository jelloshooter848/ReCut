/**
 * Follow-up fixes (store):
 *  1. insertFromSource never rounds a clip one frame past its media end (whole-clip / scene inserts).
 *  2. nudgeSelected / mergeCues handle huge selections (no Math.min/max spread stack overflow).
 *  6. Subtitles carried from a media subtitle file record that file in the sequence track's sourcePaths.
 *  8. Modal dialogs close when a different project is loaded (or a new one is created).
 *  9. Relinking to a shorter file trims (or removes) clips that would run past the new media end.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, resetStore } from '../../src/state/store';
import { activeSequence } from '../../src/state/selectors';
import { createMediaItem, createProject, createSequence } from '../../shared/project';
import { allTracks, clipSourceOut, makeClip } from '../../shared/timeline';
import type { MediaItem, MediaProbe, Sequence, SequenceSubtitleCue, SubtitleTrack } from '../../shared/model';

const FPS = { num: 24, den: 1 };

function fakeProbe(duration: number): MediaProbe {
  return {
    container: 'matroska', duration, size: 1000, startTime: 0, browserPlayable: true,
    video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: FPS, avgFps: FPS, isVfr: false },
    audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
    subtitles: [],
  };
}

function fakeMedia(name: string, duration: number): MediaItem {
  const m = createMediaItem(`/media/${name}`, name);
  return { ...m, kind: 'video', probe: fakeProbe(duration) };
}

const S = () => useStore.getState();
const seq = (): Sequence => activeSequence(S())!;
const clips = () => allTracks(seq()).flatMap((t) => t.clips);

let seqId: string;
beforeEach(() => {
  resetStore();
  const s = createSequence('Test 24', FPS);
  S().addSequence(s);
  seqId = s.id;
  S().clearHistory();
});

describe('1: insertFromSource caps rounding at the media end', () => {
  it('a whole-clip insert of a 10.03 s file is 240 frames (240.72 would round to 241, past the end)', () => {
    const m = fakeMedia('a.mkv', 10.03);
    S().addMedia([m]);
    const ids = S().insertFromSource(seqId, { mediaId: m.id, in: 0, out: 10.03, atFrame: 0, mode: 'overwrite' });
    expect(ids).toHaveLength(2);
    for (const c of clips()) {
      expect(c.duration).toBe(240);
      expect(clipSourceOut(c, FPS)).toBeLessThanOrEqual(10.03 + 1e-9);
    }
  });

  it('caps at the speed-adjusted fit (speed 2: 120.84 frames -> 120, not 121)', () => {
    const m = fakeMedia('b.mkv', 10.07);
    S().addMedia([m]);
    S().insertFromSource(seqId, { mediaId: m.id, in: 0, out: 10.07, atFrame: 0, mode: 'overwrite', extra: { speed: 2 } });
    for (const c of clips()) {
      expect(c.duration).toBe(120);
      expect(clipSourceOut(c, FPS)).toBeLessThanOrEqual(10.07 + 1e-9);
    }
  });

  it('a range that fits exactly is unchanged; an in-point at the very end still makes a 1-frame clip', () => {
    const m = fakeMedia('c.mkv', 10);
    S().addMedia([m]);
    S().insertFromSource(seqId, { mediaId: m.id, in: 0, out: 10, atFrame: 0, mode: 'overwrite' });
    expect(clips().map((c) => c.duration)).toEqual([240, 240]);
    S().insertFromSource(seqId, { mediaId: m.id, in: 10, out: 10, atFrame: 1000, mode: 'overwrite' });
    expect(clips().filter((c) => c.start === 1000).map((c) => c.duration)).toEqual([1, 1]);
  });
});

describe('2: huge selections do not overflow the stack', () => {
  const N = 200_000;

  it('nudgeSelected with 200k selected clips', () => {
    const p = createProject('big');
    const s = p.sequences[p.activeSequenceId!];
    const m = fakeMedia('big.mkv', 1e6);
    p.media[m.id] = m;
    for (let i = 0; i < N; i++) s.videoTracks[0].clips.push(makeClip({ mediaId: m.id, name: 'c', sourceIn: 0, duration: 1, kind: 'video' }, i));
    S().loadProjectData(p, null);
    S().select(s.videoTracks[0].clips.map((c) => c.id), 'set');
    // Leftmost clip at frame 0: a nudge left is clamped to 0 (no-op) after finding the minimum start.
    expect(() => S().nudgeSelected(-1, s.id)).not.toThrow();
    expect(S().history.past).toHaveLength(0);
  });

  it('mergeCues with 200k cues', () => {
    const p = createProject('cues');
    const s = p.sequences[p.activeSequenceId!];
    const cues: SequenceSubtitleCue[] = [];
    for (let i = 0; i < N; i++) cues.push({ id: `q${i}`, start: i * 2, duration: 1, offset: 0, text: 't' });
    s.subtitleTracks.push({ id: 'st', name: 'en', language: 'en', enabled: true, cues });
    S().loadProjectData(p, null);
    expect(() => S().mergeCues(s.id, cues.map((c) => c.id))).not.toThrow();
    const merged = activeSequence(S())!.subtitleTracks[0].cues;
    expect(merged).toHaveLength(1);
    expect(merged[0].start).toBe(0);
    expect(merged[0].duration).toBe((N - 1) * 2 + 1);
  });
});

describe('6: carried subtitles keep their source file protected', () => {
  it('the sequence track records the media subtitle file in sourcePaths (survives removing the media track)', () => {
    const m = fakeMedia('ep.mkv', 100);
    S().addMedia([m]);
    const track: SubtitleTrack = {
      id: 'sub1', name: 'ep.en.srt', language: 'en', mediaId: m.id, origin: 'srt', path: '/media/ep.en.srt',
      cues: [{ id: 'c1', start: 2, end: 4, text: 'Hello' }, { id: 'c2', start: 20, end: 22, text: 'Later' }],
    };
    S().addMediaSubtitleTrack(track);
    S().insertFromSource(seqId, { mediaId: m.id, in: 0, out: 10, atFrame: 0, mode: 'overwrite' });
    expect(seq().subtitleTracks).toHaveLength(1);
    expect(seq().subtitleTracks[0].sourcePaths).toEqual(['/media/ep.en.srt']);
    // a second insert from the same track reuses the sequence track without duplicating the path
    S().insertFromSource(seqId, { mediaId: m.id, in: 15, out: 25, atFrame: 500, mode: 'overwrite' });
    expect(seq().subtitleTracks).toHaveLength(1);
    expect(seq().subtitleTracks[0].sourcePaths).toEqual(['/media/ep.en.srt']);
    S().removeMediaSubtitleTrack('sub1');
    expect(seq().subtitleTracks[0].sourcePaths).toEqual(['/media/ep.en.srt']);
  });

  it('embedded tracks (no file) add no sourcePaths', () => {
    const m = fakeMedia('emb.mkv', 100);
    S().addMedia([m]);
    S().addMediaSubtitleTrack({ id: 'sub2', name: 'en (embedded)', language: 'en', mediaId: m.id, origin: 'srt', cues: [{ id: 'c1', start: 2, end: 4, text: 'Hi' }] });
    S().insertFromSource(seqId, { mediaId: m.id, in: 0, out: 10, atFrame: 0, mode: 'overwrite' });
    expect(seq().subtitleTracks[0].sourcePaths).toBeUndefined();
  });
});

describe('8: dialogs close when another project is loaded', () => {
  it('loadProjectData closes every modal dialog', () => {
    for (const d of ['export', 'relink', 'shortcuts', 'newSequence', 'preferences'] as const) S().openDialog(d);
    S().loadProjectData(createProject('Other'), '/tmp/other.recut');
    expect(Object.values(S().ui.dialogs).every((v) => v === false)).toBe(true);
  });

  it('newProject closes them too', () => {
    S().openDialog('export');
    S().newProject('Fresh');
    expect(S().ui.dialogs.export).toBe(false);
  });
});

describe('9: relink to a shorter file fits clips to the new media', () => {
  const pastEnd = (mediaId: string, dur: number) => clips().filter((c) => c.mediaId === mediaId && clipSourceOut(c, FPS) > dur + 1e-6);

  it('trims clips past the new end, removes clips that start past it, toasts, and is one undo step', () => {
    const m = fakeMedia('long.mkv', 60);
    S().addMedia([m]);
    S().insertFromSource(seqId, { mediaId: m.id, in: 2, out: 12, atFrame: 500, mode: 'overwrite' });
    S().insertFromSource(seqId, { mediaId: m.id, in: 0, out: 1, atFrame: 0, mode: 'overwrite' });
    S().insertFromSource(seqId, { mediaId: m.id, in: 20, out: 30, atFrame: 2000, mode: 'overwrite' });
    expect(clips()).toHaveLength(6);
    const undoBefore = S().history.past.length;

    S().relinkMedia(m.id, '/media/short.mkv');
    S().setMediaProbe(m.id, fakeProbe(3));

    expect(pastEnd(m.id, 3)).toEqual([]);
    const at500 = clips().filter((c) => c.start === 500);
    expect(at500.map((c) => c.duration)).toEqual([24, 24]); // 2 s .. 3 s at 24 fps
    expect(clips().filter((c) => c.start === 0).map((c) => c.duration)).toEqual([24, 24]); // untouched
    expect(clips().filter((c) => c.start === 2000)).toEqual([]); // starts at 20 s of a 3 s file
    expect(S().ui.toasts.some((t) => t.kind === 'warning' && /past the end/.test(t.text))).toBe(true);
    expect(S().history.past.length).toBe(undoBefore + 1);

    S().undo();
    expect(pastEnd(m.id, 3)).toHaveLength(4);
    expect(S().project.media[m.id].path).toBe('/media/short.mkv'); // relink itself is not undone
  });

  it('a probe that is not part of a relink never trims', () => {
    const m = fakeMedia('x.mkv', 60);
    S().addMedia([m]);
    S().insertFromSource(seqId, { mediaId: m.id, in: 2, out: 12, atFrame: 0, mode: 'overwrite' });
    S().setMediaProbe(m.id, fakeProbe(3));
    expect(pastEnd(m.id, 3)).toHaveLength(2);
  });

  it('a relink to a long-enough file changes nothing (no undo step, no toast)', () => {
    const m = fakeMedia('y.mkv', 60);
    S().addMedia([m]);
    S().insertFromSource(seqId, { mediaId: m.id, in: 2, out: 12, atFrame: 0, mode: 'overwrite' });
    const before = S().history.past.length;
    S().relinkMedia(m.id, '/media/y2.mkv');
    S().setMediaProbe(m.id, fakeProbe(59));
    expect(S().history.past.length).toBe(before);
    expect(S().ui.toasts).toEqual([]);
  });
});
