/**
 * Shared fixtures for the attack-qa vitest suites (store-level, no DOM / IPC).
 */
import { useStore, resetStore } from '../../src/state/store';
import { emptyHistory } from '../../src/state/history';
import { createMediaItem, createSequence } from '../../shared/project';
import { allTracks } from '../../shared/timeline';
import type { MediaItem, MediaProbe, Project, Sequence, SubtitleTrack } from '../../shared/model';

export const FPS = { num: 24, den: 1 };

export function fakeProbe(duration = 100, opts: { video?: boolean; audio?: boolean } = {}): MediaProbe {
  return {
    container: 'mp4', duration, size: 1000, startTime: 0, browserPlayable: true,
    video: opts.video === false ? undefined : { index: 0, codec: 'h264', width: 1920, height: 1080, fps: FPS, avgFps: FPS, isVfr: false },
    audio: opts.audio === false ? [] : [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
    subtitles: [],
  };
}

export function fakeMedia(name = 'movie.mp4', duration = 100, opts: { video?: boolean; audio?: boolean } = {}): MediaItem {
  const m = createMediaItem(`/media/${name}`, name);
  return { ...m, kind: opts.video === false ? 'audio' : 'video', probe: fakeProbe(duration, opts) };
}

export const S = () => useStore.getState();

export interface Fixture { media: MediaItem; seqId: string; seq: () => Sequence }

/** Fresh store with one 100 s media item and one 24 fps sequence (history cleared, unlimited). */
export function fresh(opts: { duration?: number; historyLimit?: number; carrySubtitles?: boolean } = {}): Fixture {
  resetStore();
  const media = fakeMedia('movie.mp4', opts.duration ?? 100);
  S().addMedia([media]);
  const s = createSequence('Attack 24', FPS);
  S().addSequence(s);
  if (opts.carrySubtitles !== undefined) S().setSettings({ carrySubtitles: opts.carrySubtitles });
  S().clearHistory();
  useStore.setState({ history: emptyHistory(opts.historyLimit ?? 10_000), dirty: false });
  return { media, seqId: s.id, seq: () => S().project.sequences[s.id] };
}

export function clipsOf(seq: Sequence) { return allTracks(seq).flatMap((t) => t.clips); }

/** Insert [inS,outS) seconds of media at frame `at`. Returns created clip ids. */
export function insert(f: Fixture, inS: number, outS: number, at: number, mode: 'insert' | 'overwrite' = 'overwrite', extra: Record<string, unknown> = {}) {
  return S().insertFromSource(f.seqId, { mediaId: f.media.id, in: inS, out: outS, atFrame: at, mode, ...extra });
}

export function mediaSubs(mediaId: string, cues: { start: number; end: number; text: string }[]): SubtitleTrack {
  return { id: `sub-${mediaId}`, name: 'en', language: 'en', mediaId, origin: 'srt', cues: cues.map((c, i) => ({ id: `cue${i}`, ...c })) };
}

/** Project JSON without per-sequence view state and timestamps (which are explicitly non-undoable). */
export function comparable(p: Project): unknown {
  const clone = JSON.parse(JSON.stringify(p)) as Project;
  delete (clone as Partial<Project>).modifiedAt;
  for (const s of Object.values(clone.sequences)) { (s as Partial<Sequence>).view = undefined; (s as Partial<Sequence>).modifiedAt = undefined; }
  return clone;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(arr: T[]): T => arr[Math.floor(next() * arr.length)],
    bool: () => next() < 0.5,
  };
}
