/**
 * Helpers behind the timeline render-performance work (Roadmap §1 Phase 1 A): range queries over start-sorted
 * lists, per-track sync-offset maps with stable identity, and the cached selection selectors.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, resetStore } from '../../src/state/store';
import { activeSequence, selectedAudioTargets, selectedClips, selectedClipTracks, selectedLinkedCount } from '../../src/state/selectors';
import { firstOverlapIndex, itemsInRange, clipOverlaps } from '../../src/panels/timeline/viewMath';
import { linkedSyncOffsets, syncOffsetsByTrack } from '../../src/panels/timeline/clipBadges';
import { createMediaItem, createSequence } from '../../shared/project';
import { allTracks, findClip, linkedClips } from '../../shared/timeline';
import type { MediaItem, MediaProbe, Sequence, Track } from '../../shared/model';

type Item = { start: number; duration: number };
const end = (c: Item) => c.start + c.duration;
const start = (c: Item) => c.start;

describe('firstOverlapIndex / itemsInRange', () => {
  const brute = (items: Item[], from: number, to: number) => items.filter((c) => clipOverlaps(c.start, c.duration, from, to));

  it('matches a linear scan on contiguous, gapped and overlapping lists', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let n = 0; n < 40; n++) {
      const items: Item[] = [];
      let t = 0;
      const len = Math.floor(rnd() * 60);
      for (let i = 0; i < len; i++) {
        const overlap = rnd() < 0.15 && items.length ? -Math.floor(rnd() * 30) : Math.floor(rnd() * 20);
        t = Math.max(0, t + overlap);
        const d = 1 + Math.floor(rnd() * (rnd() < 0.1 ? 400 : 40));
        items.push({ start: t, duration: d });
        t += d;
      }
      items.sort((a, b) => a.start - b.start);
      for (let q = 0; q < 30; q++) {
        const from = Math.floor(rnd() * (t + 50)) - 20;
        const to = from + Math.floor(rnd() * 200);
        expect(itemsInRange(items, from, to, start, end)).toEqual(brute(items, from, to));
      }
    }
  });

  it('returns the first index whose extent reaches past `from` (cached per array)', () => {
    const items = [{ start: 0, duration: 10 }, { start: 10, duration: 100 }, { start: 20, duration: 5 }, { start: 200, duration: 1 }];
    expect(firstOverlapIndex(items, -5, end)).toBe(0);
    expect(firstOverlapIndex(items, 10, end)).toBe(1);
    expect(firstOverlapIndex(items, 109, end)).toBe(1);
    expect(firstOverlapIndex(items, 110, end)).toBe(3);
    expect(firstOverlapIndex(items, 500, end)).toBe(4);
    expect(firstOverlapIndex([], 0, end)).toBe(0);
    // a fresh array (immutable update) is not served from the previous array's cache
    const next = [...items, { start: 300, duration: 10 }];
    expect(firstOverlapIndex(next, 250, end)).toBe(4);
  });
});

function track(id: string, kind: 'video' | 'audio', clips: Array<{ id: string; start: number; duration: number; sourceIn: number; linkId: string | null; mediaId?: string }>): Track {
  return {
    id, name: id, kind, muted: false, solo: false, locked: false, height: 48, volume: 1, patched: true, transitions: [],
    clips: clips.map((c) => ({ ...c, kind, mediaId: c.mediaId ?? 'm1', name: c.id, speed: 1, enabled: true } as unknown as Track['clips'][number])),
  };
}

describe('syncOffsetsByTrack', () => {
  const fps = { num: 24, den: 1 };
  it('splits offsets per track and keeps the identity of unchanged per-track maps', () => {
    const v = track('v1', 'video', [{ id: 'a', start: 0, duration: 24, sourceIn: 0, linkId: 'L1' }, { id: 'b', start: 24, duration: 24, sourceIn: 1, linkId: 'L2' }]);
    const a = track('a1', 'audio', [{ id: 'aa', start: 2, duration: 24, sourceIn: 0, linkId: 'L1' }, { id: 'bb', start: 24, duration: 24, sourceIn: 1, linkId: 'L2' }]);
    const all = linkedSyncOffsets([v, a], fps);
    const first = syncOffsetsByTrack([v, a], all, null);
    expect([...first.get('v1')!]).toEqual([['a', -2]]);
    expect([...first.get('a1')!]).toEqual([['aa', 2]]);
    // same offsets again (e.g. an edit elsewhere): the per-track maps are reused
    const again = syncOffsetsByTrack([v, a], linkedSyncOffsets([v, a], fps), first);
    expect(again.get('v1')).toBe(first.get('v1'));
    expect(again.get('a1')).toBe(first.get('a1'));
    // fix the sync: no maps at all
    const a2 = track('a1', 'audio', [{ id: 'aa', start: 0, duration: 24, sourceIn: 0, linkId: 'L1' }, { id: 'bb', start: 24, duration: 24, sourceIn: 1, linkId: 'L2' }]);
    expect(syncOffsetsByTrack([v, a2], linkedSyncOffsets([v, a2], fps), again).size).toBe(0);
  });
});

// ------------------------------------------------------------------ cached selection selectors
const FPS = { num: 24, den: 1 };
function fakeProbe(duration = 100): MediaProbe {
  return {
    container: 'matroska', duration, size: 1000, startTime: 0, browserPlayable: true,
    video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: FPS, avgFps: FPS, isVfr: false },
    audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
    subtitles: [],
  };
}
const S = () => useStore.getState();
const seq = (): Sequence => activeSequence(S())!;
let media: MediaItem;
let seqId: string;

beforeEach(() => {
  resetStore();
  media = { ...createMediaItem('/media/movie.mkv', 'movie.mkv'), kind: 'video', probe: fakeProbe() };
  S().addMedia([media]);
  const s = createSequence('Test 24', FPS);
  S().addSequence(s);
  seqId = s.id;
});

describe('cached selection selectors', () => {
  it('match an uncached scan and keep identity until the tracks or the selection change', () => {
    const [v1, a1] = S().insertFromSource(seqId, { mediaId: media.id, in: 0, out: 10, atFrame: 0, mode: 'insert' });
    const [v2] = S().insertFromSource(seqId, { mediaId: media.id, in: 20, out: 30, atFrame: 240, mode: 'insert' });
    expect(selectedClips(S())).toEqual([]);
    expect(selectedLinkedCount(S())).toBe(0);

    S().select([v2, v1]);
    const sel = selectedClips(S());
    // track / clip order, as before
    const want = allTracks(seq()).flatMap((t) => t.clips).filter((c) => c.id === v1 || c.id === v2);
    expect(sel).toEqual(want);
    expect(selectedClipTracks(S()).map((t) => t.id)).toEqual(sel.map((c) => findClip(seq(), c.id)!.track.id));
    // video clips pull in their linked audio, each once, in audio-track order
    expect(selectedAudioTargets(S()).map((c) => c.kind)).toEqual(['audio', 'audio']);
    expect(selectedAudioTargets(S()).some((c) => c.id === a1)).toBe(true);

    // a playhead move (view mutated in place) keeps every cached array
    S().setView(seqId, { playhead: 50 });
    expect(selectedClips(S())).toBe(sel);

    // an edit replaces the tracks: recomputed
    S().setClipEnabled(seqId, v1, false);
    const after = selectedClips(S());
    expect(after).not.toBe(sel);
    expect(after.find((c) => c.id === v1)!.enabled).toBe(false);

    S().select([v1]);
    const loc = findClip(seq(), v1)!;
    expect(selectedLinkedCount(S())).toBe(linkedClips(seq(), loc.clip).length);
    expect(selectedAudioTargets(S()).map((c) => c.id)).toEqual([a1]);
    S().select([a1]);
    expect(selectedAudioTargets(S()).map((c) => c.id)).toEqual([a1]);
  });
});
