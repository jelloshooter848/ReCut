/**
 * OCR language installer (Roadmap §4, workstream A): downloadVerified against a local HTTP server (success,
 * corrupt, oversize, 404, cancel, resume, Range ignored, redirects, host allow-list) and the language operations
 * built on it (dedupe, remove during a download, install from file, verifyInstalled).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OCR_LANGUAGES, ocrLanguage } from '../../shared/ocr';
import { JobQueue } from '../../electron/jobs/jobQueue';
import {
  DownloadCanceledError, downloadVerified, isAllowedDownloadUrl, parseLangUrlOverride, sha256File,
} from '../../electron/ocr/download';
import {
  activeInstallJob, formatOcrSize, installFromFile, languageUrl, removeLanguage, startInstallJob, verifyInstalled,
} from '../../electron/ocr/languages';
import { listOcrLanguages } from '../../electron/ocr/dataDir';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-ocr-download-'));
afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

const SIZE = 256 * 1024;
const DATA = crypto.randomBytes(SIZE);
const SHA = crypto.createHash('sha256').update(DATA).digest('hex');
const ENG_FIXTURE = path.join(__dirname, '..', 'fixtures', 'ocr', 'eng.traineddata');

/** Requests seen by the server (path + Range header). */
let seen: { path: string; range?: string }[] = [];
/** Per-test switches. */
let dropOnce = true;
let releaseSlow: (() => void) | null = null;

function sendRange(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void {
  const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
  if (m) {
    const start = Number(m[1]);
    if (start >= body.length) { res.writeHead(416, { 'content-range': `bytes */${body.length}` }); res.end(); return; }
    res.writeHead(206, { 'content-length': body.length - start, 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` });
    res.end(body.subarray(start));
    return;
  }
  res.writeHead(200, { 'content-length': body.length });
  res.end(body);
}

let server: http.Server;
let base = '';
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    seen.push({ path: url.pathname, range: req.headers.range });
    switch (url.pathname) {
      case '/good.bin': return sendRange(req, res, DATA);
      case '/eng.traineddata': return sendRange(req, res, fs.readFileSync(ENG_FIXTURE));
      case '/corrupt.bin': { const b = Buffer.from(DATA); b[1000] ^= 0xff; return sendRange(req, res, b); }
      case '/big.bin': res.writeHead(200, { 'content-length': SIZE + 10 }); res.end(Buffer.concat([DATA, Buffer.alloc(10)])); return;
      case '/big-chunked.bin': {
        res.writeHead(200, { 'transfer-encoding': 'chunked' });
        res.write(DATA);
        res.end(Buffer.alloc(4096));
        return;
      }
      case '/norange.bin': res.writeHead(200, { 'content-length': SIZE }); res.end(DATA); return;
      case '/drop.bin': {
        if (dropOnce && !req.headers.range) {
          dropOnce = false;
          res.writeHead(200, { 'content-length': SIZE });
          res.write(DATA.subarray(0, SIZE / 2), () => setTimeout(() => res.socket?.destroy(), 20));
          return;
        }
        return sendRange(req, res, DATA);
      }
      case '/slow.bin': {
        res.writeHead(200, { 'content-length': SIZE });
        res.write(DATA.subarray(0, SIZE / 2));
        releaseSlow = () => { if (!res.destroyed) res.end(DATA.subarray(SIZE / 2)); };
        return;
      }
      case '/redirect-same': res.writeHead(302, { location: '/good.bin' }); res.end(); return;
      case '/redirect-foreign': res.writeHead(302, { location: `http://localhost:${port}/good.bin` }); res.end(); return;
      default: res.writeHead(404); res.end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}/`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

let dir = '';
let n = 0;
beforeEach(() => {
  seen = [];
  dropOnce = true;
  releaseSlow = null;
  dir = path.join(tmpRoot, `t${n++}`);
  fs.mkdirSync(dir, { recursive: true });
});

const fetchFn = (url: string, init?: RequestInit) => fetch(url, init);
const opts = (file: string, extra: Partial<Parameters<typeof downloadVerified>[0]> = {}) => ({
  url: base + file, bytes: SIZE, sha256: SHA, dest: path.join(dir, 'out.bin'), fetch: fetchFn, allowLoopback: true, ...extra,
});
const exists = (p: string) => fs.existsSync(p);

describe('downloadVerified', () => {
  it('downloads, verifies and renames into place, reporting progress', async () => {
    const progress: number[] = [];
    const o = opts('good.bin', { onProgress: (f) => progress.push(f) });
    await downloadVerified(o);
    expect(fs.readFileSync(o.dest).equals(DATA)).toBe(true);
    expect(exists(`${o.dest}.part`)).toBe(false);
    expect(progress.at(-1)).toBe(1);
    expect(progress.length).toBeGreaterThan(1);
  });

  it('a corrupt file fails with "checksum mismatch" and leaves no file', async () => {
    const o = opts('corrupt.bin');
    await expect(downloadVerified(o)).rejects.toThrow(/checksum mismatch/);
    expect(exists(o.dest)).toBe(false);
    expect(exists(`${o.dest}.part`)).toBe(false);
  });

  it('refuses a file larger than expected (Content-Length and streamed)', async () => {
    for (const f of ['big.bin', 'big-chunked.bin']) {
      const o = opts(f);
      await expect(downloadVerified(o)).rejects.toThrow(/larger than expected/);
      expect(exists(o.dest)).toBe(false);
      expect(exists(`${o.dest}.part`)).toBe(false);
    }
  });

  it('fails on HTTP 404 without creating a file', async () => {
    const o = opts('missing.bin');
    await expect(downloadVerified(o)).rejects.toThrow(/HTTP 404/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('cancel mid-way deletes the .part', async () => {
    const ac = new AbortController();
    const o = opts('slow.bin', { signal: ac.signal, onProgress: (f) => { if (f >= 0.5) ac.abort(); } });
    await expect(downloadVerified(o)).rejects.toBeInstanceOf(DownloadCanceledError);
    releaseSlow?.();
    expect(exists(o.dest)).toBe(false);
    expect(exists(`${o.dest}.part`)).toBe(false);
  });

  it('a network drop keeps the .part; the next attempt resumes with Range', async () => {
    const o = opts('drop.bin');
    await expect(downloadVerified(o)).rejects.toThrow(/network error/);
    expect(exists(o.dest)).toBe(false);
    const partSize = fs.statSync(`${o.dest}.part`).size;
    expect(partSize).toBeGreaterThan(0);
    expect(partSize).toBeLessThan(SIZE);
    seen = [];
    await downloadVerified(o);
    expect(seen.map((s) => s.range)).toEqual([`bytes=${partSize}-`]);
    expect(fs.readFileSync(o.dest).equals(DATA)).toBe(true);
    expect(exists(`${o.dest}.part`)).toBe(false);
  });

  it('restarts from zero when the server ignores Range (200)', async () => {
    const o = opts('norange.bin');
    fs.writeFileSync(`${o.dest}.part`, Buffer.from('garbage that must not be kept'));
    await downloadVerified(o);
    expect(seen[0].range).toBe('bytes=29-');
    expect(fs.readFileSync(o.dest).equals(DATA)).toBe(true);
  });

  it('starts over when the .part is already full size or larger', async () => {
    const o = opts('good.bin');
    fs.writeFileSync(`${o.dest}.part`, Buffer.alloc(SIZE + 5));
    await downloadVerified(o);
    expect(seen[0].range).toBeUndefined();
    expect(fs.readFileSync(o.dest).equals(DATA)).toBe(true);
  });

  it('follows a same-origin redirect and refuses one to another origin', async () => {
    const ok = opts('redirect-same');
    await downloadVerified(ok);
    expect(fs.readFileSync(ok.dest).equals(DATA)).toBe(true);
    const bad = opts('redirect-foreign', { dest: path.join(dir, 'foreign.bin') });
    await expect(downloadVerified(bad)).rejects.toThrow(/refusing redirect/);
    expect(exists(bad.dest)).toBe(false);
    expect(seen.filter((s) => s.path === '/good.bin')).toHaveLength(1); // the foreign target was never fetched
  });

  it('refuses hosts other than raw.githubusercontent.com (loopback only when allowed)', async () => {
    const spy = vi.fn(fetchFn);
    await expect(downloadVerified(opts('x', { url: 'https://example.com/eng.traineddata', fetch: spy }))).rejects.toThrow(/refusing to download/);
    await expect(downloadVerified(opts('good.bin', { fetch: spy, allowLoopback: false }))).rejects.toThrow(/refusing to download/);
    await expect(downloadVerified(opts('x', { url: 'http://raw.githubusercontent.com/a', fetch: spy }))).rejects.toThrow(/refusing to download/);
    expect(spy).not.toHaveBeenCalled();
    expect(isAllowedDownloadUrl('https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/x/eng.traineddata')).toBe(true);
    expect(isAllowedDownloadUrl('https://user:pw@raw.githubusercontent.com/x')).toBe(false);
    expect(isAllowedDownloadUrl('https://raw.githubusercontent.com.evil.com/x')).toBe(false);
    expect(isAllowedDownloadUrl('http://127.0.0.1:1/x', true)).toBe(true);
    expect(isAllowedDownloadUrl('http://10.0.0.1/x', true)).toBe(false);
  });

  it('a client that follows redirects itself is checked by its final URL', async () => {
    const following = async (url: string, init?: RequestInit) => {
      const r = await fetch(url.replace('redirect-foreign', 'good.bin'), { ...init, redirect: 'follow' });
      Object.defineProperty(r, 'url', { value: `http://localhost:${port}/good.bin` });
      return r;
    };
    await expect(downloadVerified(opts('redirect-foreign', { fetch: following }))).rejects.toThrow(/refusing redirect/);
  });
});

describe('RECUT_OCR_LANG_URL override', () => {
  it('accepts only loopback http(s) URLs and normalizes the trailing slash', () => {
    expect(parseLangUrlOverride('http://127.0.0.1:8080/lang')).toBe('http://127.0.0.1:8080/lang/');
    expect(parseLangUrlOverride('https://localhost:9/')).toBe('https://localhost:9/');
    expect(parseLangUrlOverride('http://[::1]:9/')).toBe('http://[::1]:9/');
    expect(parseLangUrlOverride('https://example.com/')).toBeNull();
    expect(parseLangUrlOverride('file:///tmp/')).toBeNull();
    expect(parseLangUrlOverride('http://127.0.0.1.evil.com/')).toBeNull();
    expect(parseLangUrlOverride('')).toBeNull();
    expect(parseLangUrlOverride(undefined)).toBeNull();
    expect(languageUrl(ocrLanguage('eng')!, 'http://127.0.0.1:1/x/')).toBe('http://127.0.0.1:1/x/eng.traineddata');
    expect(languageUrl(ocrLanguage('eng')!)).toMatch(/^https:\/\/raw\.githubusercontent\.com\/.*\/eng\.traineddata$/);
  });
});

describe('OCR language operations', () => {
  const eng = ocrLanguage('eng')!;

  it('the committed fixture is the pinned English file', async () => {
    expect(fs.statSync(ENG_FIXTURE).size).toBe(eng.bytes);
    expect(await sha256File(ENG_FIXTURE)).toBe(eng.sha256);
  });

  it('installs as a deduplicated download job and records it per language', async () => {
    const queue = new JobQueue({ throttleMs: 0 });
    const jobs = new Map<string, string>();
    const ctx = { dataDir: path.join(dir, 'tessdata'), fetch: fetchFn, baseUrl: base, jobs };
    const a = startInstallJob(queue, 'eng', ctx);
    const b = startInstallJob(queue, 'eng', ctx);
    expect(b.id).toBe(a.id);
    expect(a.kind).toBe('download');
    expect(a.title).toBe(`Install English OCR data (${formatOcrSize(eng.bytes)})`);
    expect(a.title).toBe('Install English OCR data (4.1 MB)');
    expect(jobs.get('eng')).toBe(a.id);
    expect(activeInstallJob(queue, 'eng')?.id).toBe(a.id);
    const states = await listOcrLanguages(ctx.dataDir, (c) => jobs.get(c));
    expect(states.find((s) => s.code === 'eng')?.jobId).toBe(a.id);
    const done = await queue.waitFor(a.id);
    expect(done.status).toBe('done');
    expect(done.result).toEqual({ code: 'eng', bytes: eng.bytes });
    await vi.waitFor(() => expect(jobs.has('eng')).toBe(false));
    expect(activeInstallJob(queue, 'eng')).toBeNull();
    expect(await verifyInstalled(ctx.dataDir, 'eng')).toMatchObject({ ok: true });
    // A new install after the first settled is a new job.
    const c = startInstallJob(queue, 'eng', ctx);
    expect(c.id).not.toBe(a.id);
    await queue.waitFor(c.id);
  });

  it('a download that fails verification fails the job and installs nothing', async () => {
    const queue = new JobQueue({ throttleMs: 0 });
    // Serve the English name from a folder that has the wrong bytes: point the base at a path that 404s.
    const ctx = { dataDir: path.join(dir, 'tessdata'), fetch: fetchFn, baseUrl: `${base}nowhere/` };
    const job = startInstallJob(queue, 'fra', ctx);
    const done = await queue.waitFor(job.id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/HTTP 404/);
    expect((await listOcrLanguages(ctx.dataDir)).some((l) => l.installed)).toBe(false);
  });

  it('refuses to start without an HTTP client and for unknown codes', () => {
    const queue = new JobQueue({ throttleMs: 0 });
    expect(() => startInstallJob(queue, 'eng', { dataDir: dir })).toThrow(/not available/);
    expect(() => startInstallJob(queue, 'xxx', { dataDir: dir, fetch: fetchFn })).toThrow(/unknown OCR language/);
  });

  it('cancel deletes the partial download; remove is refused while it downloads', async () => {
    const queue = new JobQueue({ throttleMs: 0 });
    const dataDir = path.join(dir, 'tessdata');
    // A fetch that never finishes the body until canceled.
    let started!: () => void;
    const startedP = new Promise<void>((r) => { started = r; });
    const hanging = async (_url: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new Uint8Array(1024)); started(); },
        pull() { return new Promise<void>(() => undefined); },
      });
      init?.signal?.addEventListener('abort', () => undefined);
      return new Response(body, { status: 200, headers: { 'content-length': String(eng.bytes) } });
    };
    const job = startInstallJob(queue, 'eng', { dataDir, fetch: hanging, baseUrl: base });
    await startedP;
    await vi.waitFor(() => expect(fs.existsSync(path.join(dataDir, 'eng.traineddata.part'))).toBe(true));
    expect(await removeLanguage(queue, 'eng', { dataDir })).toMatchObject({ ok: false, error: expect.stringMatching(/downloading/) });
    expect(await installFromFile(queue, 'eng', ENG_FIXTURE, { dataDir })).toMatchObject({ ok: false, error: expect.stringMatching(/downloading/) });
    queue.cancel(job.id);
    const done = await queue.waitFor(job.id);
    expect(done.status).toBe('canceled');
    expect(fs.existsSync(path.join(dataDir, 'eng.traineddata.part'))).toBe(false);
    expect(await removeLanguage(queue, 'eng', { dataDir })).toEqual({ ok: true });
  });

  it('remove deletes the file and any .part', async () => {
    const queue = new JobQueue({ throttleMs: 0 });
    const dataDir = path.join(dir, 'tessdata');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(ENG_FIXTURE, path.join(dataDir, 'eng.traineddata'));
    fs.writeFileSync(path.join(dataDir, 'eng.traineddata.part'), 'x');
    expect(await removeLanguage(queue, 'eng', { dataDir })).toEqual({ ok: true });
    expect(fs.readdirSync(dataDir)).toEqual([]);
    expect(await removeLanguage(queue, 'eng', { dataDir })).toEqual({ ok: true }); // idempotent
    expect(await removeLanguage(queue, '../x', { dataDir })).toMatchObject({ ok: false });
  });

  it('installs from a file only when size and SHA-256 match the manifest', async () => {
    const queue = new JobQueue({ throttleMs: 0 });
    const dataDir = path.join(dir, 'nested', 'tessdata');
    expect(await installFromFile(queue, 'eng', ENG_FIXTURE, { dataDir })).toEqual({ ok: true });
    expect(await verifyInstalled(dataDir, 'eng')).toEqual({ ok: true, path: path.join(dataDir, 'eng.traineddata') });
    // Right file, wrong language.
    expect(await installFromFile(queue, 'fra', ENG_FIXTURE, { dataDir })).toMatchObject({ ok: false, error: expect.stringMatching(/not the French language file/) });
    // Same size, different content.
    const forged = path.join(dir, 'forged.traineddata');
    const b = fs.readFileSync(ENG_FIXTURE); b[b.length - 1] ^= 1; fs.writeFileSync(forged, b);
    fs.rmSync(path.join(dataDir, 'eng.traineddata'));
    expect(await installFromFile(queue, 'eng', forged, { dataDir })).toMatchObject({ ok: false });
    expect(fs.readdirSync(dataDir)).toEqual([]); // no temp file left behind
    expect(await installFromFile(queue, 'eng', path.join(dir, 'missing'), { dataDir })).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) });
    expect(await installFromFile(queue, 'eng', dir, { dataDir })).toMatchObject({ ok: false, error: expect.stringMatching(/not a file/) });
  });

  it('verifyInstalled reports missing and damaged files', async () => {
    const dataDir = path.join(dir, 'tessdata');
    fs.mkdirSync(dataDir, { recursive: true });
    expect(await verifyInstalled(dataDir, 'eng')).toMatchObject({ ok: false, reason: 'missing' });
    fs.writeFileSync(path.join(dataDir, 'eng.traineddata'), 'short');
    expect(await verifyInstalled(dataDir, 'eng')).toMatchObject({ ok: false, reason: 'damaged' });
    // Right size, wrong bytes: listOcrLanguages calls it installed (size only), verifyInstalled does not.
    const b = fs.readFileSync(ENG_FIXTURE); b[0] ^= 1;
    fs.writeFileSync(path.join(dataDir, 'eng.traineddata'), b);
    expect((await listOcrLanguages(dataDir)).find((l) => l.code === 'eng')?.installed).toBe(true);
    expect(await verifyInstalled(dataDir, 'eng')).toMatchObject({ ok: false, reason: 'damaged', error: expect.stringMatching(/English OCR data is damaged/) });
    expect(await verifyInstalled(dataDir, 'zzz')).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('downloads the real English file from a local mirror end to end', async () => {
    const queue = new JobQueue({ throttleMs: 0 });
    const dataDir = path.join(dir, 'tessdata');
    const job = startInstallJob(queue, 'eng', { dataDir, fetch: fetchFn, baseUrl: base });
    expect((await queue.waitFor(job.id)).status).toBe('done');
    expect(await sha256File(path.join(dataDir, 'eng.traineddata'))).toBe(eng.sha256);
    expect(OCR_LANGUAGES.length).toBeGreaterThan(30);
  });
});
