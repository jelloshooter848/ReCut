import { describe, it, expect } from 'vitest';
import {
  MIN_ZOOM, MAX_ZOOM, clampZoom, frameToX, xToFrame, xToFrameInt, zoomToFit, zoomAround, zoomByFactor, zoomToSlider, sliderToZoom,
  tickCandidates, rulerSpacing, rulerTicks, snapFrame, snapDelta, snapThresholdFrames, layoutTracks, rowAtY, pageFlipScroll,
  scrollContentFrames, visibleRange, clipOverlaps, formatDelta, linearToDb, dbToLinear, clipVisiblePx, SUBTITLE_LANE_PX, TRACK_DIVIDER_PX,
  ZOOM_FLOOR, minZoomFor,
} from '../../src/panels/timeline/viewMath';
import { clipSyncAnchor, formatSyncOffset, linkedSyncOffsets, mediaNeedsProxy } from '../../src/panels/timeline/clipBadges';
import { expandTimecodeDigits, parseTimecodeEntry } from '../../src/components/ui/TimecodeField';
import { classifyMissing } from '../../src/panels/program/missing';
import { dbToPos, peakToDb, METER_FLOOR_DB } from '../../src/panels/program/AudioMeter';
import { describeDecodeProblem } from '../../src/panels/source/SourcePanel';
import { createMediaItem } from '../../shared/project';
import type { Clip, MediaItem, Track } from '../../shared/model';

const FPS24 = { num: 24, den: 1 };
const NTSC = { num: 24000, den: 1001 };
const FPS25 = { num: 25, den: 1 };
const FPS30 = { num: 30000, den: 1001 };

describe('coordinates', () => {
  it('frameToX / xToFrame round-trip', () => {
    expect(frameToX(100, 4, 20)).toBe(320);
    expect(xToFrame(320, 4, 20)).toBe(100);
    expect(xToFrame(10, 4, 0)).toBe(2.5);
    expect(xToFrameInt(10, 4, 0)).toBe(3);
    expect(xToFrameInt(-50, 4, 0)).toBe(0);
    // sub-pixel zooms
    expect(xToFrame(100, 0.1, 0)).toBe(1000);
    expect(frameToX(1000, 0.1, 0)).toBeCloseTo(100);
  });

  it('clampZoom keeps zoom within bounds', () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(1e9)).toBe(MAX_ZOOM);
    expect(clampZoom(3)).toBe(3);
    expect(clampZoom(NaN)).toBe(1);
  });

  it('zoomToFit fits the whole duration with padding', () => {
    const z = zoomToFit(1000, 1040);
    expect(1000 * z).toBeLessThanOrEqual(1040);
    expect(1000 * z).toBeGreaterThan(900);
    expect(zoomToFit(0, 500)).toBe(MAX_ZOOM);
    expect(zoomToFit(10_000_000, 500)).toBe(ZOOM_FLOOR);
  });

  it('zoomAround keeps the frame under the pointer stationary', () => {
    const zoom = 2, scroll = 400, anchorX = 300; // frame 550 under pointer
    const r = zoomAround(zoom, scroll, anchorX, 4);
    expect(r.zoom).toBe(4);
    expect(xToFrame(anchorX, r.zoom, r.scroll)).toBeCloseTo(550);
    const r2 = zoomByFactor(zoom, scroll, anchorX, 0.5);
    expect(r2.zoom).toBe(1);
    expect(r2.scroll).toBe(250);
    expect(xToFrame(anchorX, r2.zoom, r2.scroll)).toBeCloseTo(550);
    // zooming out near the start clamps scroll at 0 instead of exposing negative frames
    expect(zoomAround(2, 100, 300, 1).scroll).toBe(0);
  });

  it('zoomAround never scrolls before frame 0 and respects clamps', () => {
    const r = zoomAround(1, 0, 500, 0.001);
    expect(r.zoom).toBe(MIN_ZOOM);
    expect(r.scroll).toBe(0);
  });

  it('slider mapping is monotonic and invertible', () => {
    expect(zoomToSlider(MIN_ZOOM)).toBeCloseTo(0);
    expect(zoomToSlider(MAX_ZOOM)).toBeCloseTo(1);
    for (const z of [0.02, 0.5, 1, 4, 20]) expect(sliderToZoom(zoomToSlider(z))).toBeCloseTo(z, 6);
    expect(sliderToZoom(0.3)).toBeLessThan(sliderToZoom(0.6));
  });
});

describe('ruler', () => {
  it('tickCandidates lists frame divisors then seconds', () => {
    const c = tickCandidates(FPS24);
    expect(c.slice(0, 7)).toEqual([1, 2, 3, 4, 6, 8, 12]);
    expect(c).toContain(24);
    expect(c).toContain(240);
    expect(tickCandidates(FPS25).slice(0, 2)).toEqual([1, 5]);
    expect(tickCandidates(NTSC)[7]).toBe(24);
  });

  it('rulerSpacing: zoomed in shows frame ticks, zoomed out shows seconds/minutes', () => {
    const z10 = rulerSpacing(FPS24, 10);     // 10 px per frame
    expect(z10.major).toBe(8);                 // 8 frames = 80px
    expect(z10.minor).toBe(1);
    const z1 = rulerSpacing(FPS24, 1);        // 1 px per frame
    expect(z1.major).toBe(120);                // 5 s
    expect(z1.minor).toBe(24);                 // 1 s minor ticks at 24px
    const far = rulerSpacing(FPS24, 0.01);    // 100 frames per px
    expect(far.major % 24).toBe(0);
    expect(far.major * 0.01).toBeGreaterThanOrEqual(80);
    const tiny = rulerSpacing(FPS24, 0.0001 as number, 80);
    expect(tiny.major * 0.0001).toBeGreaterThanOrEqual(80);
    expect(tiny.major % (3600 * 24)).toBe(0);        // whole hours
    expect(tiny.major % tiny.minor).toBe(0);
    expect(tiny.minor * 0.0001).toBeGreaterThanOrEqual(5);
    // one-second majors still get frame subdivisions; multi-second majors use whole seconds
    expect(rulerSpacing(FPS24, 4)).toEqual({ major: 24, minor: 2 });
    expect(rulerSpacing(FPS24, 2)).toEqual({ major: 48, minor: 24 });
  });

  it('rulerSpacing minor divides major', () => {
    for (const fps of [FPS24, NTSC, FPS25, FPS30]) {
      for (const zoom of [0.01, 0.05, 0.2, 1, 3, 8, 25, 50]) {
        const s = rulerSpacing(fps, zoom);
        expect(s.major * zoom).toBeGreaterThanOrEqual(80);
        if (s.minor) { expect(s.major % s.minor).toBe(0); expect(s.minor * zoom).toBeGreaterThanOrEqual(5); }
      }
    }
  });

  it('rulerTicks covers the viewport with labelled majors', () => {
    const ticks = rulerTicks(FPS24, 4, 0, 800);
    const majors = ticks.filter((t) => t.major);
    expect(majors[0]).toMatchObject({ frame: 0, x: 0, label: '00:00:00:00' });
    expect(majors[1]).toMatchObject({ frame: 24, x: 96, label: '00:00:01:00' });
    expect(ticks.every((t) => t.x >= 0 && t.x <= 800 + 4 * 24)).toBe(true);
    expect(ticks.some((t) => !t.major)).toBe(true);
    // scrolled: first tick is aligned to the grid, not to scroll
    const scrolled = rulerTicks(FPS24, 4, 10, 800);
    expect(scrolled[0].frame % 1).toBe(0);
    expect(scrolled.find((t) => t.major)!.frame).toBe(24);
    expect(rulerTicks(FPS24, 4, 0, 0)).toEqual([]);
  });
});

describe('snapping', () => {
  it('snapFrame picks nearest candidate within threshold', () => {
    expect(snapFrame(103, [0, 100, 110], 5)).toEqual({ frame: 100, snapped: true, target: 100 });
    expect(snapFrame(106, [0, 100, 110], 5)).toEqual({ frame: 110, snapped: true, target: 110 });
    expect(snapFrame(50, [0, 100], 5)).toEqual({ frame: 50, snapped: false, target: null });
    expect(snapFrame(100, [], 5).snapped).toBe(false);
  });

  it('snapDelta applies the smallest correction across all positions', () => {
    // clip spanning 10..40; candidate 42 near the end (delta +2) and 7 near the start (delta -3)
    expect(snapDelta([10, 40], [7, 42], 4)).toEqual({ delta: 2, target: 42 });
    expect(snapDelta([10, 40], [100], 4)).toEqual({ delta: 0, target: null });
  });

  it('snapThresholdFrames scales with zoom', () => {
    expect(snapThresholdFrames(8)).toBe(1);
    expect(snapThresholdFrames(0.5)).toBe(16);
  });
});

describe('track layout', () => {
  const V = [{ id: 'v1', height: 64, kind: 'video' as const }, { id: 'v2', height: 64, kind: 'video' as const }, { id: 'v3', height: 40, kind: 'video' as const }];
  const A = [{ id: 'a1', height: 48, kind: 'audio' as const }, { id: 'a2', height: 48, kind: 'audio' as const }];

  it('stacks video top-down V3..V1, divider, then A1..An', () => {
    const l = layoutTracks(V, A);
    expect(l.rows.map((r) => r.id)).toEqual(['v3', 'v2', 'v1', 'a1', 'a2']);
    expect(l.rows[0]).toMatchObject({ top: 0, height: 40, index: 2 });
    expect(l.rows[2]).toMatchObject({ id: 'v1', top: 104, height: 64, index: 0 });
    expect(l.dividerTop).toBe(168);
    expect(l.rows[3]).toMatchObject({ id: 'a1', top: 168 + TRACK_DIVIDER_PX, index: 0 });
    expect(l.total).toBe(168 + TRACK_DIVIDER_PX + 96);
    expect(l.subtitleLane).toBe(0);
  });

  it('reserves a subtitle lane and honours live height overrides + clamps', () => {
    const l = layoutTracks(V, A, { subtitleLane: true, heights: { v3: 500, a1: 2 } });
    expect(l.subtitleLane).toBe(SUBTITLE_LANE_PX);
    expect(l.rows[0].top).toBe(SUBTITLE_LANE_PX);
    expect(l.rows[0].height).toBe(240);
    expect(l.rows.find((r) => r.id === 'a1')!.height).toBe(24);
  });

  it('rowAtY finds the row under a y offset', () => {
    const l = layoutTracks(V, A);
    expect(rowAtY(l, 0)!.id).toBe('v3');
    expect(rowAtY(l, 39)!.id).toBe('v3');
    expect(rowAtY(l, 40)!.id).toBe('v2');
    expect(rowAtY(l, 170)).toBeNull(); // divider
    expect(rowAtY(l, 175)!.id).toBe('a1');
    expect(rowAtY(l, 10_000)).toBeNull();
  });
});

describe('scrolling helpers', () => {
  it('pageFlipScroll flips a page when the playhead leaves the view', () => {
    expect(pageFlipScroll(50, 0, 100)).toBeNull();
    expect(pageFlipScroll(100, 0, 100)).toBe(100);
    expect(pageFlipScroll(250, 100, 100)).toBe(250);
    expect(pageFlipScroll(20, 100, 100)).toBe(20);
    expect(pageFlipScroll(20, 100, 0)).toBeNull();
  });

  it('scrollContentFrames always exposes the view plus slack', () => {
    expect(scrollContentFrames(1000, 0, 200)).toBe(1100);
    expect(scrollContentFrames(0, 0, 200)).toBe(200);
    expect(scrollContentFrames(100, 900, 200)).toBe(1100);
  });

  it('visibleRange / clipOverlaps', () => {
    const r = visibleRange(2, 100, 1000, 200);
    expect(r.from).toBe(0);
    expect(r.to).toBe(700);
    expect(visibleRange(2, 500, 1000, 200).from).toBe(400);
    expect(clipOverlaps(0, 10, 10, 20)).toBe(false);
    expect(clipOverlaps(0, 11, 10, 20)).toBe(true);
    expect(clipOverlaps(20, 5, 10, 20)).toBe(false);
  });

  it('clipVisiblePx quantises to chunks and returns null when off-screen', () => {
    expect(clipVisiblePx(0, 1000, 300, 800, 256)).toEqual({ visFrom: 256, visTo: 1000 });
    expect(clipVisiblePx(0, 3000, 300, 800, 256)).toEqual({ visFrom: 256, visTo: 1024 });
    expect(clipVisiblePx(500, 100, 300, 800, 256)).toEqual({ visFrom: 0, visTo: 100 });
    expect(clipVisiblePx(1000, 100, 0, 800, 256)).toBeNull();
    expect(clipVisiblePx(-500, 100, 0, 800, 256)).toBeNull();
  });
});

describe('formatting', () => {
  it('formatDelta', () => {
    expect(formatDelta(12, FPS24)).toBe('+12 (+00:00:00:12)');
    expect(formatDelta(-30, FPS24)).toBe('-30 (-00:00:01:06)');
    expect(formatDelta(0, FPS24)).toBe('0 (00:00:00:00)');
  });
  it('dB conversion', () => {
    expect(linearToDb(1)).toBe(0);
    expect(linearToDb(0)).toBe(-Infinity);
    expect(dbToLinear(-6)).toBeCloseTo(0.501, 2);
    expect(dbToLinear(linearToDb(0.25))).toBeCloseTo(0.25);
  });
});

describe('dynamic minimum zoom (E-06)', () => {
  it('zoom-to-fit always fits a 2+ hour sequence', () => {
    for (const [frames, width] of [[173_580, 1500], [24 * 3600 * 3, 900], [30 * 3600 * 2.5, 1200]] as const) {
      const z = zoomToFit(frames, width);
      expect(frames * z).toBeLessThanOrEqual(width);
      expect(frames * z).toBeGreaterThan(width * 0.9);
      expect(z).toBeLessThan(MIN_ZOOM);
    }
  });
  it('minZoomFor lowers the bound only for long sequences, floored at ZOOM_FLOOR', () => {
    expect(minZoomFor(2400, 1200)).toBe(MIN_ZOOM);
    expect(minZoomFor(173_580, 1500)).toBeLessThan(zoomToFit(173_580, 1500));
    expect(minZoomFor(1e9, 500)).toBe(ZOOM_FLOOR);
    expect(clampZoom(0.001, minZoomFor(173_580, 1500))).toBeCloseTo(Math.max(0.001, minZoomFor(173_580, 1500)), 10);
    // zooming out around a pointer honours the dynamic bound
    const min = minZoomFor(173_580, 1500);
    expect(zoomAround(0.01, 0, 0, 0.0001, min).zoom).toBeCloseTo(min, 12);
    expect(sliderToZoom(0, min)).toBeCloseTo(min, 12);
    expect(zoomToSlider(min, min)).toBeCloseTo(0, 10);
  });
});

function clip(p: Partial<Clip> & Pick<Clip, 'id' | 'kind' | 'start'>): Clip {
  return {
    mediaId: 'm1', name: p.id, duration: 48, sourceIn: 0, speed: 1, linkId: 'L1', enabled: true,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 } as Clip['transform'], audio: { volume: 1, muted: false, fadeIn: 0, fadeOut: 0 } as Clip['audio'],
    tags: [], characters: [], plotlines: [], locations: [], notes: '', ...p,
  };
}
const track = (kind: 'video' | 'audio', clips: Clip[]): Track => ({ id: `${kind}-t`, name: kind, kind, clips, transitions: [] } as unknown as Track);

describe('out-of-sync badge (E-05)', () => {
  it('in-sync linked partners have no offset', () => {
    const v = clip({ id: 'v', kind: 'video', start: 100, sourceIn: 2 });
    const a = clip({ id: 'a', kind: 'audio', start: 100, sourceIn: 2 });
    expect(linkedSyncOffsets([track('video', [v]), track('audio', [a])], FPS24).size).toBe(0);
    // a trim that moves start and sourceIn together keeps sync
    const vt = clip({ id: 'v', kind: 'video', start: 124, sourceIn: 3 });
    expect(linkedSyncOffsets([track('video', [vt]), track('audio', [a])], FPS24).size).toBe(0);
  });
  it('moved / slipped partners get +N on one side and −N on the other', () => {
    const v = clip({ id: 'v', kind: 'video', start: 400, sourceIn: 2 });
    const a = clip({ id: 'a', kind: 'audio', start: 100, sourceIn: 2 });
    const m = linkedSyncOffsets([track('video', [v]), track('audio', [a])], FPS24);
    expect(m.get('v')).toBe(300);
    expect(m.get('a')).toBe(-300);
    expect(formatSyncOffset(300)).toBe('+300');
    expect(formatSyncOffset(-12)).toBe('\u221212');
    const slipped = clip({ id: 'a', kind: 'audio', start: 400, sourceIn: 2.5 });
    expect(linkedSyncOffsets([track('video', [v]), track('audio', [slipped])], FPS24).get('v')).toBe(12);
  });
  it('ignores unlinked clips and partners from other media', () => {
    const v = clip({ id: 'v', kind: 'video', start: 0, linkId: null });
    const a = clip({ id: 'a', kind: 'audio', start: 50, linkId: null });
    const other = clip({ id: 'o', kind: 'audio', start: 90, mediaId: 'm2' });
    const v2 = clip({ id: 'v2', kind: 'video', start: 0 });
    expect(linkedSyncOffsets([track('video', [v, v2]), track('audio', [a, other])], FPS24).size).toBe(0);
    expect(clipSyncAnchor({ start: 48, sourceIn: 1, speed: 2 }, FPS24)).toBe(36);
  });
});

function media(p: Partial<MediaItem> = {}, playable = true, reason?: string): MediaItem {
  return {
    ...createMediaItem('/m/a.mp4', 'a.mp4'), kind: 'video',
    probe: { container: 'mov,mp4', duration: 10, size: 1, startTime: 0, browserPlayable: playable, playabilityReason: reason, audio: [{ index: 1, codec: 'ac3', channels: 6, layout: '5.1', sampleRate: 48000 }], subtitles: [],
      video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: FPS24, avgFps: FPS24, isVfr: false } } as MediaItem['probe'],
    ...p,
  };
}

describe('needs-proxy / missing-media classification (E-03, E-07, UX-06)', () => {
  it('mediaNeedsProxy: undecodable, present, no ready proxy', () => {
    expect(mediaNeedsProxy(media({}, false))).toBe(true);
    expect(mediaNeedsProxy(media({}, true))).toBe(false);
    expect(mediaNeedsProxy(media({ offline: true }, false))).toBe(false);
    expect(mediaNeedsProxy(media({ proxy: { status: 'ready', path: '/p.mp4' } }, false))).toBe(false);
    expect(mediaNeedsProxy(undefined)).toBe(false);
  });
  it('classifyMissing splits offline from needs-proxy and lists media to generate once', () => {
    const off = { ...media({ offline: true }), id: 'off' };
    const np = { ...media({}, false), id: 'np' };
    const busy = { ...media({ proxy: { status: 'running' } }, false), id: 'busy' };
    const ok = { ...media(), id: 'ok' };
    const split = classifyMissing([
      { clipId: 'c1', mediaId: 'off', reason: '' }, { clipId: 'c2', mediaId: 'np', reason: '' }, { clipId: 'c3', mediaId: 'np', reason: '' },
      { clipId: 'c4', mediaId: 'busy', reason: '' }, { clipId: 'c5', mediaId: 'ok', reason: 'decode error' }, { clipId: 'c6', mediaId: 'gone', reason: '' },
    ], { off, np, busy, ok });
    expect(split).toEqual({ offline: 2, needsProxy: 3, other: 1, proxyMediaIds: ['np'], proxyBusy: true });
  });
  it('Source error card names the real reason (E-08)', () => {
    expect(describeDecodeProblem(media({}, false, 'audio codec ac3 not supported by Chromium'))).toBe("AC-3 audio can't be decoded for preview");
    expect(describeDecodeProblem(media({}, false, 'video codec hevc not supported by Chromium'))).toBe("HEVC video can't be decoded for preview");
    expect(describeDecodeProblem(media({}, false, 'h264 4:2:2 not supported by Chromium'))).toBe("h264 4:2:2 can't be decoded for preview");
    expect(describeDecodeProblem(media({}, false))).toBe('Cannot decode h264');
  });
});

describe('timecode entry (E-21)', () => {
  it('bare digits fill FF, SS, MM, HH from the right', () => {
    expect(expandTimecodeDigits('1512')).toBe('15:12');
    expect(expandTimecodeDigits('500')).toBe('5:00');
    expect(expandTimecodeDigits('11500')).toBe('1:15:00');
    expect(expandTimecodeDigits('1000000')).toBe('1:00:00:00');
    expect(expandTimecodeDigits('+24')).toBe('+24');
    expect(parseTimecodeEntry('1512', FPS24)).toBe(15 * 24 + 12);
    expect(parseTimecodeEntry('500', FPS24)).toBe(120);
    expect(parseTimecodeEntry('12', FPS24)).toBe(12);
    expect(parseTimecodeEntry('+24', FPS24, 48)).toBe(72);
    expect(parseTimecodeEntry('-12', FPS24, 48)).toBe(36);
    expect(parseTimecodeEntry('00:00:02:00', FPS24)).toBe(48);
    expect(parseTimecodeEntry('1.10', FPS24)).toBe(34);
  });
});

describe('audio meter scale (E-10)', () => {
  it('maps peaks to dBFS and the bar position', () => {
    expect(peakToDb(1)).toBe(0);
    expect(peakToDb(0.5)).toBeCloseTo(-6.02, 2);
    expect(peakToDb(0)).toBe(METER_FLOOR_DB);
    expect(dbToPos(0)).toBe(1);
    expect(dbToPos(METER_FLOOR_DB)).toBe(0);
    expect(dbToPos(-30)).toBeCloseTo(0.5, 10);
  });
});
