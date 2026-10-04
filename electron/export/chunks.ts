/**
 * Chunk planning for large exports (docs/attack/performance.md P-01).
 *
 * A single ffmpeg graph opens one input per clip segment, so ffmpeg memory grows with the clip count
 * (about 6.5 MB per input). Above a threshold the exporter renders the range in consecutive chunks of
 * bounded segment count and joins them losslessly (see exporter.ts and docs/export-pipeline.md).
 *
 * Pure: no I/O. Boundaries are integer sequence frames chosen so that a chunk renders exactly what the
 * single-pass graph renders over the same frames:
 * - never inside a transition window (two-sided: centered on the cut; fade in/out: over the clip edge),
 *   so no xfade / acrossfade / fade is split;
 * - never inside a clip's own audio fade-in / fade-out (the ramp would restart);
 * - never inside a clip that needs more source than its media has (the held last frame needs earlier frames);
 * - never inside an audio clip with speed != 1 (atempo state would restart);
 * - preferably at cuts no clip spans on any rendered track ("clean" cuts).
 */
import type { ExportRequest } from '@shared/ipc';
import type { Clip, MediaItem, Track } from '@shared/model';
import { clipEnd, sourceTimeAt } from '@shared/timeline';
import { activeTracks } from './renderGraph';

/** Chunk when the single-pass graph would have more inputs than this... */
export const CHUNK_INPUT_THRESHOLD = 150;
/** ...or more video clip segments than this. */
export const CHUNK_VIDEO_SEGMENT_THRESHOLD = 120;
/** Target maximum clip segments per chunk and per pass (video pass and audio pass separately). */
export const CHUNK_MAX_SEGMENTS = 100;

export interface ExportChunk {
  /** Absolute sequence frames `[startF, endF)`. */
  startF: number;
  endF: number;
  /** Clip segments the chunk's video / audio pass renders. */
  videoSegments: number;
  audioSegments: number;
}

interface Intervals { starts: number[]; ends: number[] }

/** Number of sorted values < x. */
function countLess(arr: number[], x: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
}
/** Number of sorted values <= x. */
function countLessEq(arr: number[], x: number): number { return countLess(arr, x + 0.5); }

/** Intervals overlapping [a, b): #(start < b) - #(end <= a) (all intervals have start < end). */
function overlapping(iv: Intervals, a: number, b: number): number {
  return countLess(iv.starts, b) - countLessEq(iv.ends, a);
}

function renderedClips(t: Track, startF: number, endF: number): Clip[] {
  return t.clips.filter((c) => c.enabled && c.start < endF && clipEnd(c) > startF);
}

function mediaDurationSec(m: MediaItem | undefined): number {
  if (!m || m.kind === 'image') return Infinity;
  const d = m.probe?.duration;
  if (m.probe?.video && !(d && d > 0) && m.probe.audio.length === 0) return Infinity; // still image
  return d && d > 0 ? d : Infinity;
}

export interface ChunkPlanInput {
  req: ExportRequest;
  /** Absolute export range. */
  startF: number;
  endF: number;
}

/** Clip segment counts (video, audio) a render of `[startF, endF)` would have. */
export function countSegments({ req, startF, endF }: ChunkPlanInput): { video: number; audio: number } {
  const seq = req.sequence;
  let video = 0, audio = 0;
  for (const t of activeTracks(seq.videoTracks)) video += renderedClips(t, startF, endF).length;
  for (const t of activeTracks(seq.audioTracks)) audio += renderedClips(t, startF, endF).length;
  return { video, audio };
}

/** True when the exporter should render in chunks. */
export function shouldChunk(input: ChunkPlanInput, inputCount: number): boolean {
  return inputCount > CHUNK_INPUT_THRESHOLD || countSegments(input).video > CHUNK_VIDEO_SEGMENT_THRESHOLD;
}

/**
 * Splits `[startF, endF)` into consecutive chunks with at most `maxSegments` clip segments per pass where
 * a valid boundary allows it (a stretch with no valid boundary stays one chunk).
 */
export function planExportChunks(input: ChunkPlanInput, maxSegments = CHUNK_MAX_SEGMENTS): ExportChunk[] {
  const { req, startF, endF } = input;
  const seq = req.sequence;
  const fps = seq.fps;
  const fd = fps.den / fps.num;
  const vTracks = activeTracks(seq.videoTracks);
  const aTracks = activeTracks(seq.audioTracks);

  const collect = (tracks: Track[]): Intervals => {
    const starts: number[] = [], ends: number[] = [];
    for (const t of tracks) for (const c of renderedClips(t, startF, endF)) {
      starts.push(Math.max(c.start, startF)); ends.push(Math.min(clipEnd(c), endF));
    }
    starts.sort((x, y) => x - y); ends.sort((x, y) => x - y);
    return { starts, ends };
  };
  const vIv = collect(vTracks), aIv = collect(aTracks);

  // Forbidden open windows (lo, hi) and spanning clips.
  const forbidden: [number, number][] = [];
  const spans: [number, number][] = [];
  const all = [...vTracks.map((t) => ({ t, audio: false })), ...aTracks.map((t) => ({ t, audio: true }))];
  for (const { t, audio } of all) {
    const byId = new Map(t.clips.map((c) => [c.id, c] as const));
    for (const tr of t.transitions) {
      const D = Math.max(0, Math.round(tr.duration));
      if (D <= 0) continue;
      const outC = tr.outClipId ? byId.get(tr.outClipId) : undefined;
      const inC = tr.inClipId ? byId.get(tr.inClipId) : undefined;
      if (outC && inC) {
        const cut = clipEnd(outC), h = Math.ceil(D / 2);
        forbidden.push([cut - h, cut + h]);
        forbidden.push([inC.start - h, inC.start + h]);
      } else if (inC) {
        forbidden.push([inC.start, inC.start + D]);
      } else if (outC) {
        forbidden.push([clipEnd(outC) - D, clipEnd(outC)]);
      }
    }
    for (const c of renderedClips(t, startF, endF)) {
      const s = c.start, e = clipEnd(c);
      spans.push([s, e]);
      if (audio) {
        if (c.audio.fadeIn > 0) forbidden.push([s, s + c.audio.fadeIn]);
        if (c.audio.fadeOut > 0) forbidden.push([e - c.audio.fadeOut, e]);
        if (Math.abs(c.speed - 1) > 1e-9) forbidden.push([s, e]);
      }
      const md = mediaDurationSec(req.media[c.mediaId]);
      if (Number.isFinite(md)) {
        const speed = c.speed > 0 && Number.isFinite(c.speed) ? c.speed : 1;
        if (sourceTimeAt({ ...c, speed }, e, fps) > md - fd * speed) forbidden.push([s, e]);
      }
    }
  }
  const inside = (b: number, list: [number, number][]) => list.some(([lo, hi]) => lo < b && b < hi);

  // Candidate boundaries: every clip edge inside the range that is not in a forbidden window.
  const edges = new Set<number>();
  for (const [s, e] of spans) { edges.add(s); edges.add(e); }
  forbidden.sort((x, y) => x[0] - y[0]);
  const cands = [...edges].filter((b) => b > startF && b < endF).sort((x, y) => x - y)
    .filter((b) => !inside(b, forbidden));
  const clean = new Set(cands.filter((b) => !inside(b, spans)));

  const counts = (a: number, b: number) => ({ video: overlapping(vIv, a, b), audio: overlapping(aIv, a, b) });
  const fits = (a: number, b: number) => { const c = counts(a, b); return c.video <= maxSegments && c.audio <= maxSegments; };

  const chunks: ExportChunk[] = [];
  let a = startF;
  let ci = 0;
  while (a < endF) {
    if (fits(a, endF)) { chunks.push({ startF: a, endF, ...seg(counts(a, endF)) }); break; }
    while (ci < cands.length && cands[ci] <= a) ci++;
    if (ci >= cands.length) { chunks.push({ startF: a, endF, ...seg(counts(a, endF)) }); break; }
    let best = -1, bestClean = -1;
    for (let j = ci; j < cands.length && fits(a, cands[j]); j++) {
      best = cands[j];
      if (clean.has(best)) bestClean = best;
    }
    let b: number;
    if (best < 0) b = cands[ci]; // no boundary keeps the chunk within budget: smallest possible chunk
    else if (bestClean >= 0) {
      const c = counts(a, bestClean);
      b = Math.max(c.video, c.audio) * 2 >= maxSegments ? bestClean : best;
    } else b = best;
    chunks.push({ startF: a, endF: b, ...seg(counts(a, b)) });
    a = b;
  }
  return chunks;
}

function seg(c: { video: number; audio: number }): { videoSegments: number; audioSegments: number } {
  return { videoSegments: c.video, audioSegments: c.audio };
}

/**
 * Cumulative sample index of absolute frame `f` relative to the export start:
 * round((f - startF) * sampleRate * den / num). Chunk i has S(end_i) - S(start_i) samples, so the chunks
 * concatenate to exactly S(endF) samples with no drift.
 */
export function sampleIndexAt(f: number, startF: number, sampleRate: number, fps: { num: number; den: number }): number {
  return Math.round(((f - startF) * sampleRate * fps.den) / fps.num);
}
