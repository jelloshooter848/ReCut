/**
 * #120: a media (or sequence) dropped on V2 put its linked audio on the patched A1 and overwrote the audio there.
 * A drop now puts the other kind on the track with the same index (V2 -> A2, A2 -> V2), adding tracks as needed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, resetStore } from '../../src/state/store';
import { activeSequence } from '../../src/state/selectors';
import { createMediaItem, createSequence } from '../../shared/project';
import { clipEnd, findClip } from '../../shared/timeline';
import { dropTracks } from '../../src/panels/timeline/viewMath';
import type { MediaItem, MediaProbe, Sequence } from '../../shared/model';

const FPS = { num: 24, den: 1 };

function fakeMedia(name: string, duration = 100): MediaItem {
  const probe: MediaProbe = {
    container: 'mp4', duration, size: 1000, startTime: 0, browserPlayable: true,
    video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: FPS, avgFps: FPS, isVfr: false },
    audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
    subtitles: [],
  };
  return { ...createMediaItem(`/media/${name}`, name), kind: 'video', probe };
}

const S = () => useStore.getState();
const seq = (): Sequence => activeSequence(S())!;
let first: MediaItem;
let second: MediaItem;
let seqId: string;

beforeEach(() => {
  resetStore();
  first = fakeMedia('first.mp4');
  second = fakeMedia('second.mp4');
  S().addMedia([first, second]);
  const s = createSequence('Drop', FPS);
  S().addSequence(s);
  seqId = s.id;
  // Clip 1: video on V1, audio on A1, frames 0-240 (the default patching).
  S().insertFromSource(seqId, { mediaId: first.id, in: 0, out: 10, atFrame: 0, mode: 'overwrite' });
  S().clearHistory();
});

describe('dropTracks', () => {
  it('targets the drop row for its kind and the same index for the other kind', () => {
    expect(dropTracks({ id: 'v2', kind: 'video', index: 1 })).toEqual({ videoTrackId: 'v2', audioTrackIndex: 1 });
    expect(dropTracks({ id: 'a3', kind: 'audio', index: 2 })).toEqual({ audioTrackId: 'a3', videoTrackIndex: 2 });
    expect(dropTracks(null)).toEqual({});
  });
});

describe('a drop on V2 (#120)', () => {
  it('puts the linked audio on A2 and leaves clip 1 on A1 untouched', () => {
    const a1Before = seq().audioTracks[0].clips.map((c) => [c.id, c.start, clipEnd(c)]);
    const ids = S().insertFromSource(seqId, {
      mediaId: second.id, in: 0, out: 5, atFrame: 120, mode: 'overwrite', ...dropTracks({ id: seq().videoTracks[1].id, kind: 'video', index: 1 }),
    });
    expect(ids).toHaveLength(2);
    expect(ids.map((id) => findClip(seq(), id)!.track.name).sort()).toEqual(['A2', 'V2']);
    expect(seq().audioTracks[0].clips.map((c) => [c.id, c.start, clipEnd(c)])).toEqual(a1Before);
    const [v, a] = ids.map((id) => findClip(seq(), id)!.clip);
    expect(v.linkId).not.toBeNull();
    expect(a.linkId).toBe(v.linkId);
  });

  it('adds the matching audio track when the sequence has fewer, in the same undo step', () => {
    while (seq().audioTracks.length > 1) S().removeTrack(seqId, seq().audioTracks[seq().audioTracks.length - 1].id);
    S().clearHistory();
    const ids = S().insertFromSource(seqId, {
      mediaId: second.id, in: 0, out: 5, atFrame: 120, mode: 'overwrite', ...dropTracks({ id: seq().videoTracks[2].id, kind: 'video', index: 2 }),
    });
    expect(ids.map((id) => findClip(seq(), id)!.track.name).sort()).toEqual(['A3', 'V3']);
    expect(seq().audioTracks.map((t) => t.name)).toEqual(['A1', 'A2', 'A3']);
    expect(S().history.past).toHaveLength(1);
    S().undo();
    expect(seq().audioTracks.map((t) => t.name)).toEqual(['A1']);
  });

  it('a locked matching track gets a new track instead', () => {
    S().setTrackFlags(seqId, seq().audioTracks[1].id, { locked: true });
    const n = seq().audioTracks.length;
    const ids = S().insertFromSource(seqId, {
      mediaId: second.id, in: 0, out: 5, atFrame: 120, mode: 'overwrite', ...dropTracks({ id: seq().videoTracks[1].id, kind: 'video', index: 1 }),
    });
    const audio = ids.map((id) => findClip(seq(), id)!).find((f) => f.track.kind === 'audio')!;
    expect(seq().audioTracks).toHaveLength(n + 1);
    expect(audio.track.id).toBe(seq().audioTracks[n].id);
    expect(seq().audioTracks[1].clips).toHaveLength(0);
  });

  it('a drop on A2 puts the video on V2', () => {
    const ids = S().insertFromSource(seqId, {
      mediaId: second.id, in: 0, out: 5, atFrame: 120, mode: 'overwrite', ...dropTracks({ id: seq().audioTracks[1].id, kind: 'audio', index: 1 }),
    });
    expect(ids.map((id) => findClip(seq(), id)!.track.name).sort()).toEqual(['A2', 'V2']);
    expect(seq().videoTracks[0].clips).toHaveLength(1);
  });

  it('edits without a drop still follow source patching (V1 / A1)', () => {
    const ids = S().insertFromSource(seqId, { mediaId: second.id, in: 0, out: 5, atFrame: 300, mode: 'overwrite' });
    expect(ids.map((id) => findClip(seq(), id)!.track.name).sort()).toEqual(['A1', 'V1']);
  });

  it('a sequence dropped on V2 nests its audio on A2', () => {
    const child = createSequence('Child', FPS);
    S().addSequence(child);
    S().insertFromSource(child.id, { mediaId: second.id, in: 0, out: 5, atFrame: 0, mode: 'overwrite' });
    S().setActiveSequence(seqId);
    const a1Before = seq().audioTracks[0].clips.map((c) => c.id);
    const ids = S().nestSequence(seqId, child.id, 120, { mode: 'overwrite', ...dropTracks({ id: seq().videoTracks[1].id, kind: 'video', index: 1 }) });
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(['V2', 'A2']).toContain(findClip(seq(), id)!.track.name);
    expect(seq().audioTracks[0].clips.map((c) => c.id)).toEqual(a1Before);
  });
});
