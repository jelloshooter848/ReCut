import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import {
  OcrCancelledError, createOcrPool, defaultOcrPoolSize, ocrCoreDir, ocrWorkerPath, probeOcrCore, unpackedPath,
  type OcrPool,
} from '../../electron/ocr/engine';

// electron/ocr/engine.ts + worker.ts against the real Tesseract WebAssembly core and the pinned tessdata_fast English
// model (tests/fixtures/ocr). The worker is bundled with esbuild into a temp folder with the two packaged core
// variants next to it, the same layout scripts/build-electron.mjs produces in dist/electron/ocr, and with no
// node_modules in reach, so the bundle must be self-contained.

const repo = fileURLToPath(new URL('../..', import.meta.url));
const fixtures = path.join(repo, 'tests', 'fixtures', 'ocr');
const ENG_SHA256 = '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2';
const ENG_BYTES = 4_113_088;
const CORE_FILES = ['tesseract-core-relaxedsimd-lstm.js', 'tesseract-core-relaxedsimd-lstm.wasm', 'tesseract-core-lstm.js', 'tesseract-core-lstm.wasm', 'LICENSE'];

let tmp = '';
let workerPath = '';
let imgDir = '';

/** A TrueType font drawtext can load on this machine ('' = let fontconfig choose). */
function fontFile(): string {
  const candidates = process.platform === 'win32'
    ? ['C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/segoeui.ttf', 'C:/Windows/Fonts/tahoma.ttf']
    : ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
      '/usr/share/fonts/TTF/DejaVuSans.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf'];
  return candidates.find((f) => fs.existsSync(f)) ?? '';
}

/** drawtext escaping for a value inside single quotes in a filtergraph. */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\\\\\').replace(/'/g, "'\\\\\\''").replace(/:/g, '\\:').replace(/%/g, '\\%');
}

/**
 * Render subtitle-like text with FFmpeg the way bitmap subtitles look (white text with a dark outline on black),
 * then invert to black on white, the polarity Tesseract expects, as an 8-bit binary PGM (P5).
 */
function renderPgm(name: string, lines: string[], opts: { width?: number; fontSize?: number } = {}): Uint8Array {
  const fontSize = opts.fontSize ?? 40;
  const lineH = Math.round(fontSize * 1.5);
  const width = opts.width ?? 1280;
  const height = lineH * lines.length + 40;
  const font = fontFile();
  const fontOpt = font ? `fontfile='${font.replace(/:/g, '\\:')}':` : '';
  const draws = lines.map((t, i) => `drawtext=${fontOpt}text='${esc(t)}':fontsize=${fontSize}:fontcolor=white:borderw=2:bordercolor=0x202020:x=24:y=${20 + i * lineH}`);
  const out = path.join(imgDir, `${name}.pgm`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}`,
    '-frames:v', '1', '-vf', [...draws, 'negate', 'format=gray'].join(','), '-c:v', 'pgm', out]);
  const buf = fs.readFileSync(out);
  expect(buf.subarray(0, 2).toString('latin1')).toBe('P5');
  return new Uint8Array(buf);
}

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

/** Character accuracy, 1 − edit distance / expected length. */
function accuracy(expected: string, got: string): number {
  const e = norm(expected);
  return 1 - levenshtein(e, norm(got)) / e.length;
}

const SENTENCES = [
  ["I don't think we should go back there tonight."],
  ['Where were you on the night of March 3rd?', 'Answer me, Thomas!'],
  ['- Twelve minutes, maybe less.', '- Then we run.'],
  ['The quick brown fox jumps over the lazy dog.'],
  ['"Nobody leaves this room," she said.'],
  ['We have 48 hours to find it.'],
];

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-ocr-'));
  const ocrDir = path.join(tmp, 'ocr');
  imgDir = path.join(tmp, 'img');
  fs.mkdirSync(path.join(ocrDir, 'core'), { recursive: true });
  fs.mkdirSync(imgDir);
  workerPath = path.join(ocrDir, 'worker.js');
  await build({
    entryPoints: [path.join(repo, 'electron/ocr/worker.ts')], outfile: workerPath,
    bundle: true, platform: 'node', target: 'node20', format: 'cjs', logLevel: 'silent',
  });
  const core = path.join(repo, 'node_modules', 'tesseract.js-core');
  for (const f of CORE_FILES) fs.copyFileSync(path.join(core, f), path.join(ocrDir, 'core', f));
}, 60_000);

afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

describe('OCR fixtures', () => {
  it('eng.traineddata is the pinned tessdata_fast file (commit 87416418…), with its Apache-2.0 licence', () => {
    const buf = fs.readFileSync(path.join(fixtures, 'eng.traineddata'));
    expect(buf.byteLength).toBe(ENG_BYTES);
    expect(crypto.createHash('sha256').update(buf).digest('hex')).toBe(ENG_SHA256);
    expect(fs.readFileSync(path.join(fixtures, 'LICENSE'), 'utf8')).toMatch(/Apache License\s+Version 2\.0/);
  });
});

describe('OCR engine paths', () => {
  it('maps app.asar to app.asar.unpacked, and leaves other paths alone', () => {
    const asar = path.join('C:', 'ReCut', 'resources', 'app.asar', 'dist', 'electron');
    expect(ocrWorkerPath(asar)).toBe(path.join('C:', 'ReCut', 'resources', 'app.asar.unpacked', 'dist', 'electron', 'ocr', 'worker.js'));
    expect(ocrCoreDir(asar)).toBe(path.join('C:', 'ReCut', 'resources', 'app.asar.unpacked', 'dist', 'electron', 'ocr', 'core'));
    expect(unpackedPath('/opt/ReCut/resources/app.asar/dist/electron/ocr/worker.js')).toBe('/opt/ReCut/resources/app.asar.unpacked/dist/electron/ocr/worker.js');
    expect(unpackedPath('C:\\ReCut\\resources\\app.asar\\dist\\electron')).toBe('C:\\ReCut\\resources\\app.asar.unpacked\\dist\\electron');
    expect(unpackedPath('/home/me/ReCut/dist/electron/ocr/worker.js')).toBe('/home/me/ReCut/dist/electron/ocr/worker.js');
    expect(unpackedPath('/x/app.asar.unpacked/dist')).toBe('/x/app.asar.unpacked/dist');
    expect(unpackedPath('/x/my.app.asarfile/dist')).toBe('/x/my.app.asarfile/dist');
  });

  it('pool size is min(3, cores − 1), at least 1', () => {
    expect([1, 2, 3, 4, 16].map((n) => defaultOcrPoolSize(n))).toEqual([1, 1, 2, 3, 3]);
  });
});

describe('probeOcrCore', () => {
  it('loads the core and reports the variant (relaxed SIMD where the runtime supports it)', async () => {
    const { core } = await probeOcrCore({ workerPath });
    expect(['relaxedsimd-lstm', 'lstm']).toContain(core);
    // Node 20+ / Electron 33 (V8 ≥ 11.4) ship relaxed SIMD.
    expect(core).toBe('relaxedsimd-lstm');
  }, 30_000);

  it('can be forced to the plain LSTM core', async () => {
    expect(await probeOcrCore({ workerPath, core: 'lstm' })).toEqual({ core: 'lstm' });
  }, 30_000);

  it('falls back to the plain core when the relaxed-SIMD core is missing', async () => {
    const dir = path.join(tmp, 'core-lstm-only');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['tesseract-core-lstm.js', 'tesseract-core-lstm.wasm']) fs.copyFileSync(path.join(tmp, 'ocr', 'core', f), path.join(dir, f));
    expect(await probeOcrCore({ workerPath, coreDir: dir })).toEqual({ core: 'lstm' });
  }, 30_000);

  it('rejects (does not hang) when there is no core, or no worker', async () => {
    const empty = fs.mkdtempSync(path.join(tmp, 'nocore-'));
    await expect(probeOcrCore({ workerPath, coreDir: empty, timeoutMs: 15_000 })).rejects.toThrow(/OCR core/);
    await expect(probeOcrCore({ workerPath: path.join(tmp, 'nope.js') })).rejects.toThrow(/OCR worker missing/);
  }, 30_000);
});

describe('OCR pool', () => {
  const dataDir = fixtures;

  it('reads rendered subtitle text with ≥ 95 % character accuracy (relaxed SIMD and plain cores)', async () => {
    const images = SENTENCES.map((lines, i) => ({ lines, img: renderPgm(`s${i}`, lines) }));
    for (const core of ['relaxedsimd-lstm', 'lstm'] as const) {
      const pool = await createOcrPool({ dataDir, language: 'eng', size: 1, workerPath, core });
      try {
        expect(pool.core).toBe(core);
        let expected = '';
        let got = '';
        for (const { lines, img } of images) {
          const r = await pool.recognize(img);
          const acc = accuracy(lines.join('\n'), r.text);
          expect(acc, `${core}: ${JSON.stringify(r.text)}`).toBeGreaterThanOrEqual(0.9); // each line, a little slack
          expect(r.confidence).toBeGreaterThan(50);
          expected += lines.join('\n') + '\n';
          got += r.text + '\n';
        }
        expect(accuracy(expected, got), `${core}:\n${got}`).toBeGreaterThanOrEqual(0.95);
      } finally {
        await pool.terminate();
      }
    }
  }, 120_000);

  it('runs 3 workers in parallel, and terminate stops them all', async () => {
    const pool = await createOcrPool({ dataDir, language: 'eng', size: 3, workerPath });
    expect(pool.size).toBe(3);
    expect(pool.liveWorkers).toBe(3);
    const jobs = [...SENTENCES, ...SENTENCES].map((lines, i) => ({ lines, img: renderPgm(`p${i}`, lines) }));
    const results = await Promise.all(jobs.map((j) => pool.recognize(j.img)));
    results.forEach((r, i) => expect(accuracy(jobs[i].lines.join('\n'), r.text), r.text).toBeGreaterThanOrEqual(0.9));
    // The caller's buffer is not detached by the transfer to the worker.
    expect(jobs[0].img.byteLength).toBeGreaterThan(0);
    await pool.terminate();
    expect(pool.liveWorkers).toBe(0);
    await expect(pool.recognize(jobs[0].img)).rejects.toBeInstanceOf(OcrCancelledError);
    await pool.terminate(); // idempotent
  }, 120_000);

  it('terminate during recognize rejects pending and queued work promptly (no hang)', async () => {
    const page = Array.from({ length: 14 }, (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog again and again.`);
    const big = renderPgm('big', page, { width: 1920, fontSize: 44 });
    const pool = await createOcrPool({ dataDir, language: 'eng', size: 1, workerPath });
    const running = pool.recognize(big);
    const queued = pool.recognize(big);
    const settled = Promise.allSettled([running, queued]);
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    await pool.terminate();
    const [a, b] = await settled;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(a.status === 'rejected' && a.reason).toBeInstanceOf(OcrCancelledError);
    expect(b.status === 'rejected' && b.reason).toBeInstanceOf(OcrCancelledError);
    expect(pool.liveWorkers).toBe(0);
  }, 60_000);

  it('an AbortSignal cancels the pool, during start-up or work', async () => {
    const ac = new AbortController();
    const starting = createOcrPool({ dataDir, language: 'eng', size: 2, workerPath, signal: ac.signal });
    ac.abort();
    await expect(starting).rejects.toBeInstanceOf(OcrCancelledError);

    const ac2 = new AbortController();
    const pool = await createOcrPool({ dataDir, language: 'eng', size: 1, workerPath, signal: ac2.signal });
    const p = pool.recognize(renderPgm('abort', SENTENCES[0]));
    const check = expect(p).rejects.toBeInstanceOf(OcrCancelledError);
    ac2.abort();
    await check;
    expect(pool.liveWorkers).toBe(0);

    await expect(createOcrPool({ dataDir, language: 'eng', workerPath, signal: ac2.signal })).rejects.toBeInstanceOf(OcrCancelledError);
  }, 60_000);

  it('refuses a missing language, a bad language code, a relative folder; rejects corrupt data and stops its workers', async () => {
    await expect(createOcrPool({ dataDir, language: 'fra', workerPath })).rejects.toThrow(/not installed: fra/);
    for (const language of ['../eng', 'eng/x', '', 'eng+', 'e n g']) {
      await expect(createOcrPool({ dataDir, language, workerPath }), language).rejects.toThrow(/Invalid OCR language/);
    }
    await expect(createOcrPool({ dataDir: 'tests/fixtures/ocr', language: 'eng', workerPath })).rejects.toThrow(/absolute/);

    const bad = fs.mkdtempSync(path.join(tmp, 'bad-'));
    fs.writeFileSync(path.join(bad, 'zzz.traineddata'), crypto.randomBytes(64 * 1024));
    const t0 = Date.now();
    await expect(createOcrPool({ dataDir: bad, language: 'zzz', size: 2, workerPath })).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(20_000);
  }, 60_000);

  it('rejects an empty image; a blank image gives empty text', async () => {
    const pool = await createOcrPool({ dataDir, language: 'eng', size: 1, workerPath });
    try {
      await expect(pool.recognize(new Uint8Array(0))).rejects.toThrow(/empty/);
      await expect(pool.recognize(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
      const blank = renderPgm('blank', ['']);
      const r = await pool.recognize(blank);
      expect(r.text.trim()).toBe('');
      // The worker survives a bad image and keeps working.
      const ok = await pool.recognize(renderPgm('after', SENTENCES[3]));
      expect(accuracy(SENTENCES[3][0], ok.text)).toBeGreaterThanOrEqual(0.95);
    } finally {
      await pool.terminate();
    }
  }, 60_000);
});

describe('OCR worker: no network', () => {
  it('a URL langPath is refused by the adapter, never fetched', async () => {
    const w = new Worker(workerPath);
    try {
      const call = (action: string, payload: unknown) => new Promise<{ status: string; data: unknown }>((resolve) => {
        const jobId = `j-${action}`;
        const onMsg = (m: { jobId?: string; status?: string; data?: unknown }) => {
          if (m.jobId === jobId && m.status !== 'progress') { w.off('message', onMsg); resolve({ status: m.status!, data: m.data }); }
        };
        w.on('message', onMsg);
        w.postMessage({ workerId: 'w', jobId, action, payload });
      });
      expect((await call('load', { options: { lstmOnly: true, corePath: '', logging: false } })).status).toBe('resolve');
      const r = await call('loadLanguage', { langs: 'eng', options: { langPath: 'https://example.invalid/tessdata', cacheMethod: 'none', gzip: false, lstmOnly: true } });
      expect(r.status).toBe('reject');
      expect(String(r.data)).toMatch(/network access is disabled/);
    } finally {
      await w.terminate();
    }
  }, 30_000);
});
