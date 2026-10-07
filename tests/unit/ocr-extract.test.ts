/**
 * extractBitmapEvents on real bitmap subtitle streams generated at test time (tests/helpers/bitmapSubs.ts):
 * PGS (MKV), VobSub (MKV), DVB (MPEG-TS) and XSUB (AVI). Codecs this FFmpeg cannot encode are skipped by name.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BITMAP_FIXTURE_CODECS, bitmapFixtureUnavailable, encodePgsRle, makeBitmapSubsFixture, type BitmapSubCodec, type BitmapSubsFixture,
  type FixtureEvent,
} from '../helpers/bitmapSubs';
import { extractBitmapEvents, IMAGE_PAD, type BitmapEvent, type ExtractBitmapEventsOptions } from '../../electron/ocr/bitmapEvents';
import { FfmpegError } from '../../electron/media/ffmpeg';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-ocr-extract-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Allowed |error| of start and end times, seconds. DVD stores display times on a 1024/90000 s grid (~11.4 ms). */
const TOLERANCE = 0.04;

const EVENTS: FixtureEvent[] = [
  { start: 1.0, end: 2.5, text: 'Hello world' },
  { start: 3.0, end: 4.2, text: 'Second line\nwith two rows' },
  { start: 4.2, end: 5.0, text: 'Back to back' }, // starts as the previous one ends
  { start: 6.04, end: 7.5, text: "It's 100% done: yes!" },
  { start: 8.0, end: 8.3, text: 'Short' },
  { start: 9.0, end: 10.0, text: 'Hello world' }, // same picture as #0: same imageId
];

const SIZE: Record<BitmapSubCodec, { width: number; height: number } | undefined> = {
  hdmv_pgs_subtitle: undefined, // 1920x1080
  dvd_subtitle: { width: 720, height: 480 },
  dvb_subtitle: { width: 720, height: 576 },
  xsub: { width: 720, height: 480 },
};

async function collect(fx: BitmapSubsFixture, extra: Partial<ExtractBitmapEventsOptions> = {}) {
  const events: BitmapEvent[] = [];
  const result = await extractBitmapEvents({
    path: fx.path, streamIndex: fx.streamIndex, codec: fx.codec, duration: fx.duration, tempDir: tmp,
    onEvent: (e) => { events.push(e); }, ...extra,
  });
  return { events, result };
}

function tempLeftovers(): string[] {
  return fs.readdirSync(tmp).filter((n) => n.startsWith('recut-ocr-'));
}

/** Live processes whose command line mentions `needle` (Linux only; [] elsewhere). */
function processesMentioning(needle: string): string[] {
  if (process.platform !== 'linux' || !fs.existsSync('/proc')) return [];
  const out: string[] = [];
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      if (cmd.includes(needle) && !cmd.includes('vitest')) out.push(`${pid}: ${cmd}`);
    } catch { /* gone */ }
  }
  return out;
}

describe('PGS fixture writer', () => {
  it('run-length encodes lines per the PGS rules', () => {
    const rle = encodePgsRle({ width: 70, height: 2, indices: Uint8Array.from([
      ...[1], ...[2, 2], ...Array(3).fill(3), ...Array(64).fill(0),
      ...Array(70).fill(3),
    ]) });
    expect(Array.from(rle)).toEqual([
      1, 2, 2, 0, 0x80 | 3, 3, 0, 0x40, 64, 0, 0, // line 1: literal, literal x2, short run, long run of 0, EOL
      0, 0xc0, 70, 3, 0, 0, // line 2: long run of colour 3, EOL
    ]);
  });
});

describe.each(BITMAP_FIXTURE_CODECS)('extractBitmapEvents: %s', (codec) => {
  const why = bitmapFixtureUnavailable(codec);
  const run = why ? it.skip : it;
  const label = why ? ` (skipped: ${why})` : '';

  run(`finds every event with its timing and a text-sized image${label}`, async () => {
    const fx = await makeBitmapSubsFixture(path.join(tmp, codec), { codec, events: EVENTS, withAudio: true, ...SIZE[codec] });
    expect(fx.streamIndex).toBe(2);
    const { events, result } = await collect(fx);
    expect(result.isolated).toBe(true);
    expect(events.map((e) => e.index)).toEqual(EVENTS.map((_, i) => i));
    expect(events).toHaveLength(EVENTS.length);
    const scale = result.canvas.scale;
    expect(scale).toBe(fx.height < 720 ? 2 : 1);
    events.forEach((e, i) => {
      const want = EVENTS[i];
      expect(Math.abs(e.start - (want.start + fx.timeOffset)), `start of #${i}`).toBeLessThanOrEqual(TOLERANCE);
      expect(Math.abs(e.end - (want.end + fx.timeOffset)), `end of #${i}`).toBeLessThanOrEqual(TOLERANCE);
      // the image is the rendered text (plus IMAGE_PAD), at its place on the canvas
      const bmp = fx.bitmaps[i];
      expect(Math.abs(e.image.width - (bmp.width * scale + 2 * IMAGE_PAD)), `width of #${i}`).toBeLessThanOrEqual(3 * scale);
      expect(Math.abs(e.image.height - (bmp.height * scale + 2 * IMAGE_PAD)), `height of #${i}`).toBeLessThanOrEqual(3 * scale);
      expect(Math.abs(e.image.x - (bmp.x * scale - IMAGE_PAD)), `x of #${i}`).toBeLessThanOrEqual(2 * scale);
      expect(e.image.data.length).toBe(e.image.width * e.image.height * 2);
      let ink = 0;
      let bright = 0;
      for (let p = 0; p < e.image.data.length; p += 2) {
        if (e.image.data[p + 1] >= 128) { ink++; if (e.image.data[p] >= 200) bright++; }
      }
      expect(ink, `ink of #${i}`).toBeGreaterThan(0.1 * bmp.width * bmp.height * scale * scale);
      expect(bright, `white text of #${i}`).toBeGreaterThan(0.03 * bmp.width * bmp.height * scale * scale);
    });
    expect(events.map((e) => e.imageId)).toEqual([0, 1, 2, 3, 4, 0]);
    expect(events.map((e) => e.isNewImage)).toEqual([true, true, true, true, true, false]);
    expect(result.uniqueImages).toBe(5);
    expect(tempLeftovers()).toEqual([]);
  }, 60_000);

  run(`merges a subtitle split into back-to-back identical pictures${label}`, async () => {
    const fx = await makeBitmapSubsFixture(path.join(tmp, `${codec}-merge`), { codec, ...SIZE[codec], events: [
      { start: 1.0, end: 2.0, text: 'Same' }, { start: 2.0, end: 3.0, text: 'Same' }, { start: 3.0, end: 3.5, text: 'Other' },
    ] });
    const { events } = await collect(fx);
    expect(events.map((e) => [e.imageId, Math.round(e.start * 10) / 10, Math.round(e.end * 10) / 10])).toEqual([[0, 1, 3], [1, 3, 3.5]]);
  }, 60_000);
});

describe('extractBitmapEvents: cancel and errors', () => {
  const why = bitmapFixtureUnavailable('hdmv_pgs_subtitle');
  const run = why ? it.skip : it;
  const label = why ? ` (skipped: ${why})` : '';
  let fx: BitmapSubsFixture | null = null;
  async function longFixture(): Promise<BitmapSubsFixture> {
    if (!fx) {
      const events = Array.from({ length: 120 }, (_, i) => ({ start: 1 + i * 0.5, end: 1.4 + i * 0.5, text: `Line number ${i}` }));
      fx = await makeBitmapSubsFixture(path.join(tmp, 'long'), { codec: 'hdmv_pgs_subtitle', events, name: 'long' });
    }
    return fx;
  }

  run(`abort while rendering kills ffmpeg and removes the temp files${label}`, async () => {
    const f = await longFixture();
    const ac = new AbortController();
    let seen = 0;
    const p = collect(f, { signal: ac.signal, onEvent: () => { if (++seen === 3) ac.abort(); } });
    await expect(p).rejects.toSatisfy((e: unknown) => e instanceof FfmpegError && e.canceled);
    expect(seen).toBeLessThan(120);
    expect(tempLeftovers()).toEqual([]);
    expect(processesMentioning(tmp)).toEqual([]);
  }, 60_000);

  run(`abort between passes and before starting${label}`, async () => {
    const f = await longFixture();
    const ac = new AbortController();
    const p = collect(f, { signal: ac.signal, onPlan: () => ac.abort() });
    await expect(p).rejects.toSatisfy((e: unknown) => e instanceof FfmpegError && e.canceled);
    const ac2 = new AbortController();
    const phases: string[] = [];
    const p2 = collect(f, { signal: ac2.signal, onProgress: (ph) => { phases.push(ph); if (ph === 'isolate') ac2.abort(); } });
    await expect(p2).rejects.toSatisfy((e: unknown) => e instanceof FfmpegError && e.canceled);
    const done = new AbortController();
    done.abort();
    await expect(collect(f, { signal: done.signal })).rejects.toSatisfy((e: unknown) => e instanceof FfmpegError && e.canceled);
    expect(tempLeftovers()).toEqual([]);
    expect(processesMentioning(tmp)).toEqual([]);
  }, 60_000);

  run(`a slow consumer gets every event in order; a throwing one stops the run${label}`, async () => {
    const f = await longFixture();
    const starts: number[] = [];
    const { result } = await collect(f, { maxQueuedEvents: 2, onEvent: async (e) => { starts.push(e.start); if (e.index % 10 === 0) await new Promise((r) => setTimeout(r, 15)); } });
    expect(result.events).toBe(120);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    const boom = collect(f, { onEvent: (e) => { if (e.index === 5) throw new Error('consumer failed'); } });
    await expect(boom).rejects.toThrow('consumer failed');
    expect(tempLeftovers()).toEqual([]);
    expect(processesMentioning(tmp)).toEqual([]);
  }, 60_000);

  run(`rejects non-bitmap codecs, relative paths and non-subtitle streams${label}`, async () => {
    const f = await longFixture();
    await expect(collect(f, { codec: 'subrip' })).rejects.toThrow(/cannot be read with OCR/);
    await expect(collect(f, { codec: 'dvb_teletext' })).rejects.toThrow(/cannot be read with OCR/);
    await expect(collect(f, { path: 'relative.mkv' })).rejects.toThrow(/absolute/);
    await expect(collect(f, { streamIndex: 0 })).rejects.toThrow(/not a subtitle stream/);
    expect(tempLeftovers()).toEqual([]);
  }, 60_000);
});
