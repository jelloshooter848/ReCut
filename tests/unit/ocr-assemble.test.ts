/**
 * Pure parts of electron/ocr/bitmapEvents.ts: ffprobe frames → timing windows → events.
 */
import { describe, expect, it } from 'vitest';
import {
  analyzeYa8Frame, assembleEvents, buildTimingWindows, chooseCanvas, EventAssembler, parseProbeFrames, parseShowinfoFrame,
  roundToTimeBase, selectExpression, selectRanges, sub2videoGraph, xsubHeaderScanner, ya8InkBox, MAX_UNKNOWN_DURATION, type PixelFrame, type ProbeSubtitleFrame,
  type TimingWindow,
} from '../../electron/ocr/bitmapEvents';

const U32 = 4294967295;
const s = (sec: number) => Math.round(sec * 1e6);

/** PGS-style probe frames: an image at `on`, a clear at `off` (null = no clear). */
function pgs(...spans: [number, number | null][]): ProbeSubtitleFrame[] {
  const out: ProbeSubtitleFrame[] = [];
  for (const [on, off] of spans) {
    out.push({ ptsUs: s(on), startDisplay: 0, endDisplay: U32, numRects: 1 });
    if (off !== null) out.push({ ptsUs: s(off), startDisplay: 0, endDisplay: U32, numRects: 0 });
  }
  return out;
}

const img = (t: number, hash: string): PixelFrame<string> => ({ ptsUs: s(t), blank: false, hash, payload: hash });
const blank = (t: number): PixelFrame<string> => ({ ptsUs: s(t), blank: true, hash: '' });

const times = (evs: { start: number; end: number }[]) => evs.map((e) => [+e.start.toFixed(6), +e.end.toFixed(6)]);

describe('parseProbeFrames', () => {
  it('reads ffprobe subtitle frames (numbers or strings), skipping frames without a pts', () => {
    const f = parseProbeFrames([
      { media_type: 'subtitle', pts: 1000000, pts_time: '1.000000', start_display_time: 0, end_display_time: 4294967295, num_rects: 1 },
      { media_type: 'subtitle', pts: 'N/A', pts_time: '2.5', start_display_time: '0', end_display_time: '1490', num_rects: '0' },
      { media_type: 'subtitle', pts: 'N/A', pts_time: 'N/A', num_rects: 1 },
      { media_type: 'video', pts: 5 },
    ]);
    expect(f).toEqual([
      { ptsUs: 1000000, startDisplay: 0, endDisplay: U32, numRects: 1 },
      { ptsUs: 2500000, startDisplay: 0, endDisplay: 1490, numRects: 0 },
    ]);
    expect(parseProbeFrames(undefined)).toEqual([]);
  });
});

describe('buildTimingWindows', () => {
  it('start = pts + start_display; end 0 and UINT32_MAX are unknown; offset is subtracted', () => {
    const w = buildTimingWindows([
      { ptsUs: s(2.4), startDisplay: 0, endDisplay: U32, numRects: 1 },
      { ptsUs: s(5), startDisplay: 0, endDisplay: 0, numRects: 1 },
      { ptsUs: s(7), startDisplay: 250, endDisplay: 1500, numRects: 1 },
    ], { offset: 1.4 });
    expect(w.map((x) => [+x.start.toFixed(6), x.end === null ? null : +x.end.toFixed(6)])).toEqual([[1, null], [3.6, null], [5.85, 7.1]]);
    expect(w[2].decodeUs).toBe(s(7.25));
  });

  it('end_display <= start_display is unknown', () => {
    const [w] = buildTimingWindows([{ ptsUs: s(1), startDisplay: 500, endDisplay: 500, numRects: 1 }]);
    expect(w.end).toBeNull();
  });

  it('matchUs allows for FFmpeg 6 rounding sub2video times to the stream time base', () => {
    const tb = { num: 1, den: 25 };
    expect(roundToTimeBase(s(4.28), tb)).toBe(s(4.28));
    expect(roundToTimeBase(s(4.299), tb)).toBe(s(4.28));
    expect(roundToTimeBase(s(4.30), tb)).toBe(s(4.32)); // halves away from zero, as av_rescale_q
    const [w] = buildTimingWindows([{ ptsUs: s(4.299), startDisplay: 0, endDisplay: U32, numRects: 1 }], { timeBase: tb });
    expect(w.matchUs).toBe(s(4.28));
    const [w2] = buildTimingWindows([{ ptsUs: s(4.261), startDisplay: 0, endDisplay: U32, numRects: 1 }], { timeBase: tb });
    expect(w2.matchUs).toBe(s(4.261)); // rounded up: the exact time is earlier
  });

  it('xsub: packet header times win when there is one per frame; else start_display_time is absolute', () => {
    const frames: ProbeSubtitleFrame[] = [
      { ptsUs: 0, startDisplay: 1000, endDisplay: 2500, numRects: 1 },
      { ptsUs: 40000, startDisplay: 3000, endDisplay: 4200, numRects: 1 },
    ];
    const hdr = buildTimingWindows(frames, { codec: 'xsub', xsubTimes: [{ start: 1.001, end: 2.5 }, { start: 3.002, end: 4.2 }] });
    expect(times(hdr.map((w) => ({ start: w.start, end: w.end ?? 0 })))).toEqual([[1.001, 2.5], [3.002, 4.2]]);
    expect(hdr[1].decodeUs).toBe(s(3.04)); // matching still uses where sub2video puts it
    const noHdr = buildTimingWindows(frames, { codec: 'xsub', xsubTimes: [{ start: 9, end: 10 }] });
    expect(times(noHdr.map((w) => ({ start: w.start, end: w.end ?? 0 })))).toEqual([[1, 2.5], [3, 4.2]]);
  });

  it('sorts by decode time, stably', () => {
    const w = buildTimingWindows([
      { ptsUs: s(3), startDisplay: 0, endDisplay: U32, numRects: 1 },
      { ptsUs: s(1), startDisplay: 0, endDisplay: U32, numRects: 1 },
      { ptsUs: s(1), startDisplay: 0, endDisplay: U32, numRects: 0 },
    ]);
    expect(w.map((x) => [x.start, x.numRects])).toEqual([[1, 1], [1, 0], [3, 1]]);
  });
});

describe('assembleEvents', () => {
  it('PGS: UINT32_MAX ends, clear display sets end the events', () => {
    const w = buildTimingWindows(pgs([1, 2.5], [3, 4.2]));
    const ev = assembleEvents(w, [blank(1), img(1, 'A'), img(2.499, 'A'), blank(2.5), img(3, 'B'), img(4.199, 'B'), blank(4.2)], 10);
    expect(times(ev)).toEqual([[1, 2.5], [3, 4.2]]);
    expect(ev.map((e) => [e.imageId, e.isNewImage, e.payload])).toEqual([[0, true, 'A'], [1, true, 'B']]);
  });

  it('PGS: no clear before the next image → ends at the next start; last one capped by duration / 10 s', () => {
    const w = buildTimingWindows(pgs([1, null], [3, null]));
    expect(times(assembleEvents(w, [img(1, 'A'), img(3, 'B')], 5))).toEqual([[1, 3], [3, 5]]);
    expect(times(assembleEvents(w, [img(1, 'A'), img(3, 'B')], 0))).toEqual([[1, 3], [3, 3 + MAX_UNKNOWN_DURATION]]);
    expect(times(assembleEvents(w, [img(1, 'A'), img(3, 'B')], 100))).toEqual([[1, 3], [3, 3 + MAX_UNKNOWN_DURATION]]);
  });

  it('DVD: explicit ends with no clear frames', () => {
    const w = buildTimingWindows([
      { ptsUs: s(1), startDisplay: 0, endDisplay: 1490, numRects: 1 },
      { ptsUs: s(3), startDisplay: 0, endDisplay: 1194, numRects: 1 },
      { ptsUs: s(4.2), startDisplay: 0, endDisplay: 20000, numRects: 1 }, // longer than the 10 s cap: explicit wins
    ]);
    const ev = assembleEvents(w, [img(1, 'A'), blank(2.49), img(3, 'B'), blank(4.194), img(4.2, 'C')], 60);
    expect(times(ev)).toEqual([[1, 2.49], [3, 4.194], [4.2, 24.2]]);
    // ... and the next start still wins over a later explicit end
    const w2 = buildTimingWindows([
      { ptsUs: s(1), startDisplay: 0, endDisplay: 5000, numRects: 1 },
      { ptsUs: s(3), startDisplay: 0, endDisplay: 1000, numRects: 1 },
    ]);
    expect(times(assembleEvents(w2, [img(1, 'A'), img(3, 'B')], 60))).toEqual([[1, 3], [3, 4]]);
  });

  it('start offsets: start_display_time shifts both the window and the event', () => {
    const w = buildTimingWindows([
      { ptsUs: s(1), startDisplay: 500, endDisplay: 2000, numRects: 1 },
      { ptsUs: s(4), startDisplay: 100, endDisplay: 1100, numRects: 1 },
    ], { offset: 0.5 });
    // sub2video frames sit at pts + start_display (file time); events are on the media timeline (minus offset)
    const ev = assembleEvents(w, [blank(1), img(1.5, 'A'), blank(3), img(4.1, 'B')], 60);
    expect(times(ev)).toEqual([[1, 2.5], [3.6, 4.6]]);
  });

  it('duplicates: back-to-back events with the same image merge; a gap keeps them apart but shares the imageId', () => {
    const w = buildTimingWindows(pgs([1, null], [2, 3], [3.5, 4]));
    const ev = assembleEvents(w, [img(1, 'A'), img(2, 'A'), blank(3), img(3.5, 'A')], 60);
    expect(times(ev)).toEqual([[1, 3], [3.5, 4]]);
    expect(ev.map((e) => [e.imageId, e.isNewImage])).toEqual([[0, true], [0, false]]);
  });

  it('DVD-style grid: a gap of a few ms is still back to back', () => {
    const w = buildTimingWindows([
      { ptsUs: s(6.04), startDisplay: 0, endDisplay: 1456, numRects: 1 },
      { ptsUs: s(7.5), startDisplay: 0, endDisplay: 1490, numRects: 1 },
    ]);
    expect(times(assembleEvents(w, [img(6.04, 'A'), blank(7.496), img(7.5, 'A')], 60))).toEqual([[6.04, 8.99]]);
  });

  it('missing images: a window with only blank frames (or none) gives no event', () => {
    const w = buildTimingWindows(pgs([1, 2], [3, 4], [5, 6]));
    const ev = assembleEvents(w, [blank(1), blank(2), img(3, 'B'), blank(4)], 60);
    expect(times(ev)).toEqual([[3, 4]]);
    expect(ev[0].imageId).toBe(0);
  });

  it('the image is the first non-blank frame of the window, skipping a repeat of the previous picture', () => {
    const w = buildTimingWindows(pgs([1, null], [2, 3]));
    // a stale 'A' frame lands at the start of window 2 (FFmpeg 8 repeats the old picture 1 µs before; rounding may
    // pull it in), then the real 'B'
    const ev = assembleEvents(w, [img(1, 'A'), img(2, 'A'), img(2, 'B'), img(2.5, 'C')], 60);
    expect(ev.map((e) => e.payload)).toEqual(['A', 'B']);
    // frames before the first window are ignored
    expect(assembleEvents(w, [img(0.5, 'Z'), img(1, 'A')], 60).map((e) => e.payload)).toEqual(['A']);
  });

  it('drops events shorter than 40 ms (after merging)', () => {
    const w = buildTimingWindows(pgs([1, 1.02], [2, null], [2.03, 3]));
    const ev = assembleEvents(w, [img(1, 'A'), blank(1.02), img(2, 'B'), img(2.03, 'B')], 60);
    // 1.00-1.02 dropped; 2.00-2.03 and 2.03-3.00 share an image and merge into one long event
    expect(times(ev)).toEqual([[2, 3]]);
    const w2 = buildTimingWindows(pgs([1, 1.039], [2, 2.04]));
    expect(times(assembleEvents(w2, [img(1, 'A'), img(2, 'B')], 60))).toEqual([[2, 2.04]]);
  });

  it('frames past the end (the UINT32_MAX flush) and windows with no frames are harmless', () => {
    const w = buildTimingWindows(pgs([1, 2], [3, null]));
    const ev = assembleEvents(w, [img(1, 'A'), blank(2), img(3, 'B'), blank(4294967.295)], 8);
    expect(times(ev)).toEqual([[1, 2], [3, 8]]);
  });

  it('two subtitles at the same time: the first gets zero length and is dropped', () => {
    const w: TimingWindow[] = buildTimingWindows([
      { ptsUs: s(1), startDisplay: 0, endDisplay: U32, numRects: 1 },
      { ptsUs: s(1), startDisplay: 0, endDisplay: U32, numRects: 1 },
    ]);
    expect(times(assembleEvents(w, [img(1, 'A'), img(1, 'B')], 3))).toEqual([[1, 3]]);
  });

  it('streaming assembler emits as soon as an event is final and refuses frames after finish', () => {
    const got: number[] = [];
    const a = new EventAssembler<string>(buildTimingWindows(pgs([1, 2], [3, 4])), 10, (e) => got.push(e.start));
    a.push(img(1, 'A'));
    a.push(blank(2));
    expect(got).toEqual([]); // held: the next one might merge into it
    a.push(img(3, 'B'));
    expect(got).toEqual([1]);
    a.finish();
    expect(got).toEqual([1, 3]);
    expect(a.uniqueImages).toBe(2);
    expect(() => a.push(img(5, 'C'))).toThrow();
  });
});

describe('frame analysis', () => {
  function frame(w: number, h: number, ink: [number, number][]): Uint8Array {
    const d = new Uint8Array(w * h * 2);
    for (const [x, y] of ink) { d[(y * w + x) * 2] = 200; d[(y * w + x) * 2 + 1] = 255; }
    return d;
  }

  it('finds the ink box (fast and slow paths agree) and ignores faint alpha', () => {
    const d = frame(64, 40, [[10, 5], [50, 30], [20, 7]]);
    d[(1 * 64 + 1) * 2 + 1] = 7; // below ALPHA_INK
    expect(ya8InkBox(d, 64, 40)).toEqual({ x0: 10, y0: 5, x1: 50, y1: 30 });
    expect(ya8InkBox(d, 64, 40, 9)).toEqual({ x0: 10, y0: 5, x1: 50, y1: 30 });
    expect(ya8InkBox(new Uint8Array(64 * 40 * 2), 64, 40)).toBeNull();
    // odd width: no 4-byte fast path
    expect(ya8InkBox(frame(33, 3, [[32, 2]]), 33, 3)).toEqual({ x0: 32, y0: 2, x1: 32, y1: 2 });
  });

  it('crops with padding clipped to the frame, hashes the content and position', () => {
    const a = analyzeYa8Frame(frame(100, 60, [[40, 30], [44, 31]]), 100, 60, 12);
    expect(a.blank).toBe(false);
    expect(a.image).toMatchObject({ x: 28, y: 18, width: 29, height: 26 });
    const edge = analyzeYa8Frame(frame(100, 60, [[2, 58]]), 100, 60, 12);
    expect(edge.image).toMatchObject({ x: 0, y: 46, width: 15, height: 14 });
    const same = analyzeYa8Frame(frame(100, 60, [[40, 30], [44, 31]]), 100, 60, 12);
    expect(same.hash).toBe(a.hash);
    const moved = analyzeYa8Frame(frame(100, 60, [[41, 30], [45, 31]]), 100, 60, 12);
    expect(moved.hash).not.toBe(a.hash);
    expect(analyzeYa8Frame(new Uint8Array(100 * 60 * 2), 100, 60)).toEqual({ blank: true, hash: '', image: null });
  });
});

describe('helpers', () => {
  it('parses showinfo pts lines (µs after settb=AVTB)', () => {
    expect(parseShowinfoFrame('[Parsed_showinfo_3 @ 0x1] n:  12 pts:4199999 pts_time:4.199999 duration:1 fmt:ya8')).toEqual({ n: 12, ptsUs: 4199999 });
    expect(parseShowinfoFrame('[Parsed_showinfo_3 @ 0x1] n:   0 pts:      0 pts_time:0')).toEqual({ n: 0, ptsUs: 0 });
    expect(parseShowinfoFrame('[Parsed_showinfo_3 @ 0x1]   color_range:pc')).toBeNull();
  });

  it('scans XSUB headers across chunk boundaries without double counting', () => {
    const sc = xsubHeaderScanner();
    const data = Buffer.from('xx[00:00:01.000-00:00:02.500]\u0001\u0002junk[01:02:03.040-01:02:04.000]tail', 'latin1');
    for (let i = 0; i < data.length; i += 5) sc.push(data.subarray(i, i + 5));
    expect(sc.times).toEqual([{ start: 1, end: 2.5 }, { start: 3723.04, end: 3724 }]);
  });

  it('chooses a canvas: stream size, else video size; DVB at least 720x576; even sizes', () => {
    expect(chooseCanvas('hdmv_pgs_subtitle', { width: 1920, height: 1080 }, { width: 1280, height: 720 })).toEqual({ width: 1920, height: 1080 });
    expect(chooseCanvas('xsub', {}, { width: 639, height: 359 })).toEqual({ width: 640, height: 360 });
    expect(chooseCanvas('dvb_subtitle', null, { width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 });
    expect(chooseCanvas('dvb_subtitle', null, null)).toEqual({ width: 720, height: 576 });
    expect(chooseCanvas('hdmv_pgs_subtitle', null, null)).toEqual({ width: 1920, height: 1080 });
  });

  it('builds the sub2video graph', () => {
    expect(sub2videoGraph(3)).toBe('[0:3]format=ya8,settb=AVTB,showinfo[o]');
    expect(sub2videoGraph(0, [[1, 2]])).toBe("[0:0]select='between(t,1.000000,2.000000)',format=ya8,settb=AVTB,showinfo[o]");
  });

  it('selects the start of each picture window, not clears or late repeats', () => {
    const w = buildTimingWindows(pgs([1, 2.5], [3, null], [3.1, 4], [10, null]));
    const r = selectRanges(w).map(([a, b]) => [+a.toFixed(4), +b.toFixed(4)]);
    // [1, 1.25); [3, 3.1) and [3.1, 3.35) join; the clear at 4 is skipped; the last window has no successor
    expect(r).toEqual([[0.9995, 1.2495], [2.9995, 3.3495], [9.9995, 10.2495]]);
    expect(selectRanges(buildTimingWindows(pgs([1, 2])).slice(1))).toEqual([]);
  });

  it('select expression is a balanced binary search over the ranges', () => {
    const ranges: [number, number][] = Array.from({ length: 1000 }, (_, i) => [i * 3, i * 3 + 0.25]);
    const expr = selectExpression(ranges);
    // evaluate the expression with a tiny interpreter for between/if/lt, and measure its nesting
    const evalAt = (t: number): number => Function('t', 'between', 'lt', 'iff',
      `return ${expr.replace(/\bif\(/g, 'iff(')};`)(t, (x: number, a: number, b: number) => +(x >= a && x <= b), (a: number, b: number) => +(a < b),
      (c: number, y: number, z: number) => (c ? y : z));
    expect([evalAt(0.1), evalAt(0.3), evalAt(1500.2), evalAt(2997.24), evalAt(2998), evalAt(-1)]).toEqual([1, 0, 1, 1, 0, 0]);
    let depth = 0, max = 0;
    for (const ch of expr) { if (ch === '(') max = Math.max(max, ++depth); else if (ch === ')') depth--; }
    expect(max).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(1000)) + 2);
    expect(selectExpression([])).toBe('0');
  });
});
