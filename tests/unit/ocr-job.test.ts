/**
 * The OCR job end to end (electron/ocr/ocrJob.ts): generated PGS and VobSub streams (tests/helpers/bitmapSubs.ts),
 * the real Tesseract WebAssembly core (worker bundled with esbuild, as in ocr-engine.test.ts) and the pinned English
 * model (tests/fixtures/ocr/eng.traineddata) copied into a temp data folder.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OcrRequest, OcrResult } from '../../shared/ocr';
import { JobQueue } from '../../electron/jobs/jobQueue';
import { setCacheDir } from '../../electron/media/cache';
import type { OcrPool } from '../../electron/ocr/engine';
import {
  buildCues, ocrJobTitle, startOcrJob, _resetOcrJobState, type OcrJobContext,
} from '../../electron/ocr/ocrJob';
import { bitmapFixtureUnavailable, makeBitmapSubsFixture, type BitmapSubCodec, type BitmapSubsFixture, type FixtureEvent } from '../helpers/bitmapSubs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const CORE_FILES = ['tesseract-core-relaxedsimd-lstm.js', 'tesseract-core-relaxedsimd-lstm.wasm', 'tesseract-core-lstm.js', 'tesseract-core-lstm.wasm', 'LICENSE'];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-ocr-job-'));
const dataDir = path.join(tmp, 'tessdata');
const workDir = path.join(tmp, 'work');
const cacheDir = path.join(tmp, 'cache');
let workerPath = '';

const LINES = [
  'Where were you last night?',
  'I told you, I was at the station.',
  "That's not what your brother said.",
  'My brother says a lot of things.',
  'We have forty-eight hours to find it.',
  'Then we should get moving.',
  'Nobody leaves this room\nuntil I get an answer.',
  'Is that a threat?',
  'It is a promise.',
  'Keep your voice down, they can hear us.',
  'How long have you known?',
  'Since the night of the fire.',
  'You lied to me for three years.',
  'I did it to protect you.',
  'Get in the car. Now!',
];

/** 15 lines, one every 1.5 s; #15 repeats #0 (same picture), #16-17 are the same text back to back (merged). */
function makeEvents(): FixtureEvent[] {
  const ev: FixtureEvent[] = LINES.map((text, i) => ({ start: 1 + i * 1.5, end: 1 + i * 1.5 + 1.2, text }));
  const t = 1 + LINES.length * 1.5;
  ev.push({ start: t, end: t + 1, text: LINES[0] });
  ev.push({ start: t + 1.5, end: t + 2.5, text: 'Run!' });
  ev.push({ start: t + 2.5, end: t + 3.5, text: 'Run!' });
  return ev;
}
const EVENTS = makeEvents();
/** What the job should produce: the back-to-back "Run!" pair is one cue. */
const EXPECTED = [...EVENTS.slice(0, -2), { start: EVENTS[EVENTS.length - 2].start, end: EVENTS[EVENTS.length - 1].end, text: 'Run!' }];

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const norm = (s: string) => s.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
function accuracy(expected: string, got: string): number {
  const e = norm(expected);
  return 1 - levenshtein(e, norm(got)) / e.length;
}

function ctx(extra: Partial<OcrJobContext> = {}): OcrJobContext {
  return { dataDir, workerPath, poolSize: 2, tempDir: workDir, ...extra };
}

function req(fx: BitmapSubsFixture, extra: Partial<OcrRequest> = {}): OcrRequest {
  return { mediaId: 'm1', path: fx.path, streamIndex: fx.streamIndex, language: 'eng', codec: fx.codec, ...extra };
}

async function runJob(queue: JobQueue, r: OcrRequest, c = ctx()) {
  const job = startOcrJob(queue, r, c);
  const t0 = performance.now();
  const final = await queue.waitFor(job.id);
  return { job, final, ms: performance.now() - t0, result: final.result as OcrResult | undefined };
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

beforeAll(async () => {
  const ocrDir = path.join(tmp, 'ocr');
  fs.mkdirSync(path.join(ocrDir, 'core'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  setCacheDir(cacheDir);
  workerPath = path.join(ocrDir, 'worker.js');
  await build({
    entryPoints: [path.join(repo, 'electron/ocr/worker.ts')], outfile: workerPath,
    bundle: true, platform: 'node', target: 'node20', format: 'cjs', logLevel: 'silent',
  });
  const core = path.join(repo, 'node_modules', 'tesseract.js-core');
  for (const f of CORE_FILES) fs.copyFileSync(path.join(core, f), path.join(ocrDir, 'core', f));
  fs.copyFileSync(path.join(repo, 'tests/fixtures/ocr/eng.traineddata'), path.join(dataDir, 'eng.traineddata'));
}, 60_000);

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(path.join(cacheDir, 'ocr'), { recursive: true, force: true }));

describe('buildCues', () => {
  it('skips empty text and merges identical text that touches, but not across a gap', () => {
    const cues = buildCues([
      { start: 1, end: 2, text: 'A' },
      { start: 2, end: 3, text: '' },
      { start: 3, end: 4, text: 'B' },
      { start: 4.01, end: 5, text: 'B' },
      { start: 6, end: 7, text: 'B' },
    ]);
    expect(cues.map(({ start, end, text }) => ({ start, end, text }))).toEqual([
      { start: 1, end: 2, text: 'A' }, { start: 3, end: 5, text: 'B' }, { start: 6, end: 7, text: 'B' },
    ]);
    expect(new Set(cues.map((c) => c.id)).size).toBe(3);
  });

  it('titles the job with file, stream and language', () => {
    expect(ocrJobTitle({ mediaId: 'm', path: '/x/Film Night.mkv', streamIndex: 3, language: 'fra' })).toBe('Read subtitles with OCR: Film Night.mkv #3 (French)');
  });
});

const CASES: { codec: BitmapSubCodec; minAccuracy: number; size?: { width: number; height: number } }[] = [
  { codec: 'hdmv_pgs_subtitle', minAccuracy: 0.95 },
  { codec: 'dvd_subtitle', minAccuracy: 0.9, size: { width: 720, height: 480 } },
  { codec: 'dvb_subtitle', minAccuracy: 0.9, size: { width: 720, height: 576 } },
  { codec: 'xsub', minAccuracy: 0.9, size: { width: 720, height: 480 } },
];

describe.each(CASES)('OCR job: $codec', ({ codec, minAccuracy, size }) => {
  const why = bitmapFixtureUnavailable(codec);
  const run = why ? it.skip : it;
  let fx: BitmapSubsFixture;

  beforeAll(async () => {
    if (why) return;
    fx = await makeBitmapSubsFixture(path.join(tmp, codec), { codec, events: EVENTS, ...size });
  }, 120_000);

  run('reads every line with the expected text and timing, then answers from the cache', async () => {
    _resetOcrJobState();
    const queue = new JobQueue();
    const first = await runJob(queue, req(fx));
    expect(first.final.error).toBeUndefined();
    expect(first.final.status).toBe('done');
    const res = first.result!;
    expect(res.cached).toBe(false);
    expect(res.codec).toBe(codec);
    expect(res.events).toBe(EXPECTED.length); // the extractor merges the back-to-back identical pictures
    expect(res.cues.length).toBe(EXPECTED.length);
    const got = res.cues.map((c) => c.text).join('\n');
    const acc = accuracy(EXPECTED.map((e) => e.text).join('\n'), got);
    console.log(`[ocr-job] ${codec}: ${res.cues.length} cues, accuracy ${(acc * 100).toFixed(2)} %, ${first.ms.toFixed(0)} ms`);
    if (acc < 1) console.log(got);
    expect(acc).toBeGreaterThanOrEqual(minAccuracy);
    res.cues.forEach((c, i) => {
      expect(Math.abs(c.start - (EXPECTED[i].start + fx.timeOffset)), `start ${i}`).toBeLessThanOrEqual(0.04);
      expect(Math.abs(c.end - (EXPECTED[i].end + fx.timeOffset)), `end ${i}`).toBeLessThanOrEqual(0.04);
    });
    // The repeated picture got the same text as its first showing.
    expect(res.cues[LINES.length].text).toBe(res.cues[0].text);

    const cached = fs.readdirSync(cacheDir + '/ocr');
    expect(cached.filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(cached[0]).toMatch(/_s\d+_eng-7d4322bd_v1-(relaxedsimd-lstm|lstm)\.json$/);
    expect(cached.some((f) => f.endsWith('.part'))).toBe(false);

    const second = await runJob(queue, req(fx));
    expect(second.final.status).toBe('done');
    expect(second.result!.cached).toBe(true);
    expect(second.result!.cues.map((c) => [c.start, c.end, c.text])).toEqual(res.cues.map((c) => [c.start, c.end, c.text]));
    expect(second.result!.cues[0].id).not.toBe(res.cues[0].id);
    expect(second.ms).toBeLessThan(1500);
    // Even with no remembered core (a new session), the cache is found.
    _resetOcrJobState();
    expect((await runJob(queue, req(fx))).result!.cached).toBe(true);
  }, 240_000);
});

describe('OCR job: failures, cancel, dedupe', () => {
  const why = bitmapFixtureUnavailable('hdmv_pgs_subtitle');
  const run = why ? it.skip : it;
  let fx: BitmapSubsFixture;

  beforeAll(async () => {
    if (why) return;
    // Many events so a cancel lands mid-run.
    const events: FixtureEvent[] = Array.from({ length: 60 }, (_, i) => ({ start: 1 + i, end: 1.8 + i, text: `${LINES[i % LINES.length].split('\n')[0]} (${i})` }));
    fx = await makeBitmapSubsFixture(path.join(tmp, 'many'), { codec: 'hdmv_pgs_subtitle', events, name: 'many' });
  }, 120_000);

  run('a missing language is a clear error', async () => {
    const queue = new JobQueue();
    const { final } = await runJob(queue, req(fx, { language: 'fra' }));
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/French OCR data is not installed/);
  });

  run('a damaged language file is refused before OCR starts', async () => {
    const bad = path.join(tmp, 'bad-tessdata');
    fs.mkdirSync(bad, { recursive: true });
    const buf = fs.readFileSync(path.join(dataDir, 'eng.traineddata'));
    buf[buf.length - 10] ^= 0xff;
    fs.writeFileSync(path.join(bad, 'eng.traineddata'), buf);
    let pools = 0;
    const { final } = await runJob(new JobQueue(), req(fx), ctx({ dataDir: bad, onPool: () => { pools++; } }));
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/English OCR data is damaged/);
    expect(pools).toBe(0);
  });

  run('a stream that is not a bitmap subtitle stream is refused', async () => {
    const { final } = await runJob(new JobQueue(), req(fx, { streamIndex: 0 }));
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/no subtitle stream #0/);
  });

  run('the same request while running joins the running job; cancel stops FFmpeg and the workers', async () => {
    const queue = new JobQueue();
    let pool: OcrPool | null = null;
    const c = ctx({ onPool: (p) => { pool = p; } });
    const job = startOcrJob(queue, req(fx), c);
    expect(startOcrJob(queue, req(fx), c).id).toBe(job.id);
    expect(startOcrJob(queue, req(fx, { mediaId: 'other' }), c).id).toBe(job.id); // keyed on path|stream|language
    // A different stream is a different job (queued behind it on the background lane).
    const other = startOcrJob(queue, req(fx, { streamIndex: fx.streamIndex + 5 }), c);
    expect(other.id).not.toBe(job.id);

    // Wait until OCR is under way, then cancel.
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000) {
      const j = queue.get(job.id)!;
      if (j.status !== 'running' && j.status !== 'queued') break;
      if (j.progress > 0.3 && pool) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(queue.get(job.id)!.status).toBe('running');
    expect(queue.get(job.id)!.message).toMatch(/^\d+\/\d+ events$/);
    queue.cancel(job.id);
    const final = await queue.waitFor(job.id);
    expect(final.status).toBe('canceled');
    expect(pool!.liveWorkers).toBe(0);
    expect(processesMentioning(fx.path)).toEqual([]);
    expect(fs.readdirSync(workDir).filter((n) => n.startsWith('recut-ocr-'))).toEqual([]);
    expect(fs.existsSync(path.join(cacheDir, 'ocr')) ? fs.readdirSync(path.join(cacheDir, 'ocr')) : []).toEqual([]);
    // After the cancel, a new request starts a new job.
    expect(startOcrJob(queue, req(fx), c).id).not.toBe(job.id);
    queue.cancelAll();
    await new Promise((r) => setTimeout(r, 50));
    for (const j of queue.list()) await queue.waitFor(j.id);
  }, 120_000);
});
