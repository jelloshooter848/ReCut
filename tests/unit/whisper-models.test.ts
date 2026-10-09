/**
 * Whisper models (Roadmap §5): the pinned manifest, the downloader's redirect allow-list (electron/net/download.ts, the
 * Hugging Face policy), and the model installer (electron/whisper/models.ts) against a loopback server: install with
 * progress, resume of a partial file, cancel, a corrupt file, remove, install from file, verify before use, the list
 * with disk usage, the test-model switch, and the IPC argument checks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WHISPER_ENGINE_VERSION, WHISPER_LANGUAGES, WHISPER_MODELS, WHISPER_MODELS_BASE, WHISPER_MODELS_REVISION, WHISPER_REDIRECT_DOMAINS,
  guessWhisperLanguage, isWhisperLanguageCode, whisperModel, whisperModelUrl, whisperTrackName,
} from '../../shared/whisper';
import { JobQueue } from '../../electron/jobs/jobQueue';
import {
  DOWNLOAD_STALL_MS, DownloadRefusedError, downloadVerified, isAllowedRedirect, isAllowedStartUrl, isHostInDomain, openFollowingRedirects,
  parseLoopbackBaseUrl,
} from '../../electron/net/download';
import { OCR_DOWNLOAD_POLICY } from '../../electron/ocr/download';
import {
  WHISPER_DOWNLOAD_POLICY, _resetVerifiedModels, activeModelInstallJob, allWhisperModels, assertWhisperModelId, findWhisperModel,
  formatModelSize, installModelFromFile, listWhisperModels, modelDownloadUrl, modelInstallTitle, parseTestModelSpec, removeModel,
  setTestWhisperModels, startModelInstallJob, verifyModel, whisperModelsDiskUsage, whisperModelsDir,
} from '../../electron/whisper/models';
import { parseTranscribeRequest } from '../../electron/whisper/validate';

const repo = fileURLToPath(new URL('../..', import.meta.url));

describe('model manifest', () => {
  it('pins every model to one repository commit with a size and SHA-256', () => {
    expect(WHISPER_MODELS_REVISION).toMatch(/^[0-9a-f]{40}$/);
    expect(WHISPER_MODELS_BASE).toBe(`https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODELS_REVISION}/`);
    const ids = WHISPER_MODELS.map((m) => m.id);
    expect(ids).toEqual(['tiny', 'base', 'base.en', 'small', 'small.en', 'medium', 'large-v3-turbo']);
    for (const m of WHISPER_MODELS) {
      expect(m.file).toBe(`ggml-${m.id}.bin`);
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isSafeInteger(m.bytes) && m.bytes > 50e6).toBe(true);
      expect(m.englishOnly).toBe(m.id.endsWith('.en'));
      expect(whisperModelUrl(m)).toBe(WHISPER_MODELS_BASE + m.file);
      expect(whisperModel(m.id)).toBe(m);
    }
    expect(new Set(WHISPER_MODELS.map((m) => m.sha256)).size).toBe(WHISPER_MODELS.length);
    // Sizes grow with the model.
    const size = (id: string) => whisperModel(id)!.bytes;
    expect(size('tiny') < size('base') && size('base') < size('small') && size('small') < size('medium') && size('medium') < size('large-v3-turbo')).toBe(true);
  });

  it('keeps the engine version in step with the pinned source', () => {
    const src = fs.readFileSync(path.join(repo, 'scripts', 'whisper-source.mjs'), 'utf8');
    expect(src).toContain(`export const WHISPER_TAG = 'v${WHISPER_ENGINE_VERSION}';`);
    expect(src).toMatch(/WHISPER_COMMIT = '[0-9a-f]{40}'/);
    expect(src).toMatch(/WHISPER_TREE_SHA256 = '[0-9a-f]{64}'/);
    expect(src).toMatch(/WHISPER_TARBALL_SHA256 = '[0-9a-f]{64}'/);
  });

  it('knows every whisper.cpp language once, with a 3-letter track tag', () => {
    expect(WHISPER_LANGUAGES).toHaveLength(100);
    expect(new Set(WHISPER_LANGUAGES.map((l) => l.code)).size).toBe(100);
    for (const l of WHISPER_LANGUAGES) expect(l.iso6392).toMatch(/^[a-z]{3}$/);
    expect(isWhisperLanguageCode('auto')).toBe(true);
    expect(isWhisperLanguageCode('fr')).toBe(true);
    expect(isWhisperLanguageCode('fre')).toBe(false);
    expect(isWhisperLanguageCode(1)).toBe(false);
  });

  it('guesses the spoken language from track tags', () => {
    expect(guessWhisperLanguage('eng')).toBe('en');
    expect(guessWhisperLanguage('fre')).toBe('fr');
    expect(guessWhisperLanguage('fra')).toBe('fr');
    expect(guessWhisperLanguage('fr-CA')).toBe('fr');
    expect(guessWhisperLanguage('ger')).toBe('de');
    expect(guessWhisperLanguage('zh-Hant')).toBe('zh');
    expect(guessWhisperLanguage('chi')).toBe('zh');
    expect(guessWhisperLanguage('jpn')).toBe('ja');
    expect(guessWhisperLanguage('nob')).toBe('no');
    for (const t of ['und', 'mul', 'zxx', '', undefined, null, 'xx']) expect(guessWhisperLanguage(t)).toBeNull();
  });

  it('names tracks', () => {
    expect(whisperTrackName('en', 'small', false)).toBe('English (Whisper Small)');
    expect(whisperTrackName('fr', 'large-v3-turbo', false, 2)).toBe('French (Whisper Large v3 Turbo, #2)');
    expect(whisperTrackName('fr', 'base', true)).toBe('English (Whisper Base, translated)');
    expect(whisperTrackName('xx', 'nope', false)).toBe('xx (Whisper nope)');
  });
});

describe('download policy', () => {
  const P = WHISPER_DOWNLOAD_POLICY;
  it('starts only from https://huggingface.co (or loopback when allowed)', () => {
    expect(isAllowedStartUrl(whisperModelUrl(WHISPER_MODELS[0]), P)).toBe(true);
    expect(isAllowedStartUrl('http://huggingface.co/x', P)).toBe(false);
    expect(isAllowedStartUrl('https://huggingface.co.evil.com/x', P)).toBe(false);
    expect(isAllowedStartUrl('https://user:pw@huggingface.co/x', P)).toBe(false);
    expect(isAllowedStartUrl('https://cas-bridge.xethub.hf.co/x', P)).toBe(false);
    expect(isAllowedStartUrl('http://127.0.0.1:9/x', P)).toBe(false);
    expect(isAllowedStartUrl('http://127.0.0.1:9/x', P, true)).toBe(true);
  });

  it('follows redirects within the origin, or over https on the default port to Hugging Face domains (issue #102)', () => {
    const from = 'https://huggingface.co';
    expect(WHISPER_REDIRECT_DOMAINS).toEqual(['huggingface.co', 'hf.co']);
    expect(P.redirectHosts ?? []).toEqual([]);
    expect(isAllowedRedirect('https://huggingface.co/api/resolve-cache/x', from, P)).toBe(true);
    // Hosts Hugging Face really redirects to (us.aws.cdn.hf.co seen from GitHub's US runners on 2026-10-09, issue #102),
    // the Xet bridge, the LFS CDNs and the bare domains.
    for (const ok of [
      'https://us.aws.cdn.hf.co/xet-bridge-us/641ab5d15d107c5c5f346372/518970a2?X-Amz-Signature=1',
      'https://cas-bridge.xethub.hf.co/xet-bridge-us/abc?X-Amz-Signature=1',
      'https://cdn-lfs.huggingface.co/repos/x', 'https://cdn-lfs-us-1.hf.co/repos/x', 'https://eu.gcp.cdn.hf.co/x',
      'https://hf.co/x', 'https://huggingface.co/x', 'https://HF.CO/x', 'https://us.aws.cdn.hf.co:443/x',
    ]) expect(isAllowedRedirect(ok, from, P), ok).toBe(true);
    for (const bad of [
      // look-alikes: the suffix must match at a label boundary
      'https://huggingface.co.evil.com/x', 'https://hf.co.evil.com/x', 'https://evilhf.co/x', 'https://xhuggingface.co/x',
      'https://evil-hf.co/x', 'https://hf.com/x', 'https://huggingface.com/x', 'https://us.aws.cdn.hf.co.evil.com/x',
      'https://hf.co./x', 'https://us.aws.cdn.hf.co./x',
      // plain http (no downgrade), another port, credentials
      'http://us.aws.cdn.hf.co/x', 'http://huggingface.co/x', 'http://cas-bridge.xethub.hf.co/x',
      'https://us.aws.cdn.hf.co:8443/x', 'https://cas-bridge.xethub.hf.co:8443/x', 'https://huggingface.co:444/x',
      'https://u:p@cas-bridge.xethub.hf.co/x', 'https://u@us.aws.cdn.hf.co/x',
      // other schemes, IPs, garbage
      'ftp://us.aws.cdn.hf.co/x', 'https://1.2.3.4/x', 'not a url',
    ]) expect(isAllowedRedirect(bad, from, P), bad).toBe(false);
    // OCR keeps its same-origin-only rule.
    expect(OCR_DOWNLOAD_POLICY.redirectDomains ?? []).toEqual([]);
    expect(isAllowedRedirect('https://cas-bridge.xethub.hf.co/x', 'https://raw.githubusercontent.com', OCR_DOWNLOAD_POLICY)).toBe(false);
    expect(isAllowedRedirect('https://objects.githubusercontent.com/x', 'https://raw.githubusercontent.com', OCR_DOWNLOAD_POLICY)).toBe(false);
    expect(isAllowedRedirect('https://raw.githubusercontent.com/y', 'https://raw.githubusercontent.com', OCR_DOWNLOAD_POLICY)).toBe(true);
  });

  it('matches a domain only at a label boundary', () => {
    expect(isHostInDomain('hf.co', 'hf.co')).toBe(true);
    expect(isHostInDomain('a.b.hf.co', 'hf.co')).toBe(true);
    expect(isHostInDomain('evilhf.co', 'hf.co')).toBe(false);
    expect(isHostInDomain('hf.co.evil.com', 'hf.co')).toBe(false);
    expect(isHostInDomain('a..hf.co', 'hf.co')).toBe(false);
    expect(isHostInDomain('hf.co.', 'hf.co')).toBe(false);
    expect(isHostInDomain('co', 'hf.co')).toBe(false);
    expect(isHostInDomain('', 'hf.co')).toBe(false);
    expect(isHostInDomain('hf.co', '')).toBe(false);
  });

  it('accepts only a loopback base URL override', () => {
    expect(parseLoopbackBaseUrl('http://127.0.0.1:5000/models')).toBe('http://127.0.0.1:5000/models/');
    expect(parseLoopbackBaseUrl('https://huggingface.co/')).toBeNull();
    expect(parseLoopbackBaseUrl('http://127.0.0.1:5000/?x=1')).toBeNull();
    expect(parseLoopbackBaseUrl(undefined)).toBeNull();
  });
});

// ------------------------------------------------------------------
// Installer against a loopback server
// ------------------------------------------------------------------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-whisper-models-'));
const SIZE = 512 * 1024;
const DATA = crypto.randomBytes(SIZE);
const SHA = crypto.createHash('sha256').update(DATA).digest('hex');
const TEST = { id: 'test-tiny', name: 'Test (tiny)', file: 'ggml-test-tiny.bin', bytes: SIZE, sha256: SHA, englishOnly: false, note: 'n' };

let server: http.Server;
let base = '';
let port = 0;
let seen: { path: string; range?: string }[] = [];
let corrupt = false;
let releaseSlow: (() => void) | null = null;
let slow = false;

function sendRange(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void {
  const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
  if (m) {
    const start = Number(m[1]);
    res.writeHead(206, { 'content-length': body.length - start, 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` });
    res.end(body.subarray(start));
    return;
  }
  res.writeHead(200, { 'content-length': body.length });
  if (slow) { res.write(body.subarray(0, body.length / 2)); releaseSlow = () => { if (!res.destroyed) res.end(body.subarray(body.length / 2)); }; return; }
  res.end(body);
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    seen.push({ path: url.pathname, range: req.headers.range });
    if (url.pathname === '/models/ggml-test-tiny.bin') {
      const b = Buffer.from(DATA);
      if (corrupt) b[100] ^= 0xff;
      return sendRange(req, res, b);
    }
    // A redirect to "another host" (localhost instead of 127.0.0.1), like Hugging Face's storage redirect.
    if (url.pathname === '/resolve/ggml-test-tiny.bin') { res.writeHead(302, { location: `http://localhost:${port}/models/ggml-test-tiny.bin` }); res.end(); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}/models/`;
});
afterAll(async () => {
  setTestWhisperModels([]);
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let dir = '';
let n = 0;
beforeEach(() => {
  seen = [];
  corrupt = false;
  slow = false;
  releaseSlow = null;
  setTestWhisperModels([TEST]);
  _resetVerifiedModels();
  dir = path.join(tmpRoot, `t${n++}`, 'whisper', 'models');
});
const fetchFn = (url: string, init?: RequestInit) => fetch(url, init);

describe('redirects to an allowed host', () => {
  it('follows a redirect to a listed host and refuses one to an unlisted host', async () => {
    fs.mkdirSync(dir, { recursive: true });
    const o = { url: `http://127.0.0.1:${port}/resolve/ggml-test-tiny.bin`, bytes: SIZE, sha256: SHA, dest: path.join(dir, 'a.bin'), fetch: fetchFn, allowLoopback: true };
    await expect(downloadVerified({ ...o, policy: { origins: [], redirectHosts: [] } })).rejects.toThrow(/refusing redirect to http:\/\/localhost/);
    await downloadVerified({ ...o, policy: { origins: [], redirectHosts: ['localhost'] } });
    expect(fs.readFileSync(o.dest).equals(DATA)).toBe(true);
  });
});

// ------------------------------------------------------------------
// Hugging Face's real redirect shape, with a fake DNS: every https://<host>/<path> request goes to the loopback server
// as /host/<host>/<path>, so the downloader sees (and its policy judges) the real https URLs, without allowLoopback.
// ------------------------------------------------------------------

describe('Hugging Face redirects through the production policy (issue #102)', () => {
  let hf: http.Server;
  let hfPort = 0;
  let hits: string[] = [];
  const REV_PATH = `/ggerganov/whisper.cpp/resolve/${WHISPER_MODELS_REVISION}`;
  beforeAll(async () => {
    hf = http.createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      hits.push(p);
      const redirect = (to: string) => { res.writeHead(302, { location: to }); res.end(); };
      // huggingface.co: the pinned resolve URL answers with a redirect to a regional CDN host, as it does today.
      if (p === `/host/huggingface.co${REV_PATH}/ggml-test-tiny.bin`) return redirect('https://us.aws.cdn.hf.co/xet-bridge-us/641ab5d1/518970a2?X-Amz-Signature=abc');
      if (p === '/host/us.aws.cdn.hf.co/xet-bridge-us/641ab5d1/518970a2') return sendRange(req, res, DATA);
      if (p === '/host/huggingface.co/to-evil') return redirect('https://huggingface.co.evil.com/x');
      if (p === '/host/huggingface.co/to-http') return redirect('http://us.aws.cdn.hf.co/xet-bridge-us/641ab5d1/518970a2');
      if (p === '/host/huggingface.co/to-port') return redirect('https://us.aws.cdn.hf.co:8443/xet-bridge-us/641ab5d1/518970a2');
      if (p === '/host/huggingface.co/gone') { res.writeHead(404, 'Not Found'); res.end(); return; }
      // A chain of n redirects across Hugging Face hosts: /chain/<n> on alternating hosts, /chain/0 is the file.
      const c = /^\/host\/([^/]+)\/chain\/(\d+)$/.exec(p);
      if (c) {
        const k = Number(c[2]);
        if (k === 0) return sendRange(req, res, DATA);
        return redirect(`https://${k % 2 ? 'cdn-lfs-us-1.hf.co' : 'huggingface.co'}/chain/${k - 1}`);
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => hf.listen(0, '127.0.0.1', () => r()));
    hfPort = (hf.address() as AddressInfo).port;
  });
  afterAll(async () => { await new Promise<void>((r) => hf.close(() => r())); });
  beforeEach(() => { hits = []; });

  /** fetch with a fake DNS: https://<host>[:port]/<path> -> the loopback server. The Response keeps no URL. */
  const fakeDns = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const r = await fetch(`http://127.0.0.1:${hfPort}/host/${u.host}${u.pathname}${u.search}`, init);
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
  };
  const opts = (url: string, name: string) => {
    fs.mkdirSync(dir, { recursive: true });
    return { url, bytes: SIZE, sha256: SHA, dest: path.join(dir, name), fetch: fakeDns, policy: WHISPER_DOWNLOAD_POLICY };
  };

  it('installs a model Hugging Face redirects to us.aws.cdn.hf.co (the old exact-host list refused it)', async () => {
    const q = new JobQueue({ throttleMs: 0 });
    // No baseUrl: the real pinned https URL, the production policy, no loopback allowance.
    const job = startModelInstallJob(q, 'test-tiny', { modelsDir: dir, fetch: fakeDns });
    const done = await q.waitFor(job.id);
    expect(done.status, done.error).toBe('done');
    expect(hits).toEqual([`/host/huggingface.co${REV_PATH}/ggml-test-tiny.bin`, '/host/us.aws.cdn.hf.co/xet-bridge-us/641ab5d1/518970a2']);
    expect(fs.readFileSync(path.join(dir, TEST.file)).equals(DATA)).toBe(true);
    // The old policy (one exact host) refuses the same chain.
    const old = { origins: ['https://huggingface.co'], redirectHosts: ['cas-bridge.xethub.hf.co'] };
    await expect(downloadVerified({ ...opts(whisperModelUrl(TEST as never), 'old.bin'), policy: old })).rejects.toThrow(/refusing redirect to https:\/\/us\.aws\.cdn\.hf\.co/);
  });

  it('refuses a look-alike, plain http or another port, in plain words naming the host, without fetching it', async () => {
    await expect(downloadVerified(opts('https://huggingface.co/to-evil', 'e.bin')))
      .rejects.toThrow("Hugging Face redirected the download to huggingface.co.evil.com, which ReCut doesn't allow (refusing redirect to https://huggingface.co.evil.com)");
    await expect(downloadVerified(opts('https://huggingface.co/to-http', 'h.bin'))).rejects.toThrow(/redirected the download to us\.aws\.cdn\.hf\.co over plain http, which ReCut doesn't allow/);
    await expect(downloadVerified(opts('https://huggingface.co/to-port', 'p.bin'))).rejects.toThrow(/redirected the download to us\.aws\.cdn\.hf\.co:8443, which ReCut doesn't allow/);
    await expect(downloadVerified(opts('https://huggingface.co/to-evil', 'e.bin'))).rejects.toBeInstanceOf(DownloadRefusedError);
    expect(hits.every((h) => h.startsWith('/host/huggingface.co/'))).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('the job error (shown in the toast) names the refused host', async () => {
    const q = new JobQueue({ throttleMs: 0 });
    const evilDns = (url: string, init?: RequestInit) => fakeDns(url.replace(`${REV_PATH}/ggml-test-tiny.bin`, '/to-evil'), init);
    const done = await q.waitFor(startModelInstallJob(q, 'test-tiny', { modelsDir: dir, fetch: evilDns }).id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/^Hugging Face redirected the download to huggingface\.co\.evil\.com, which ReCut doesn't allow/);
  });

  it('names the host with an HTTP error status', async () => {
    await expect(downloadVerified(opts('https://huggingface.co/gone', 'g.bin'))).rejects.toThrow('download failed: HTTP 404 Not Found from huggingface.co');
  });

  it('follows at most 5 redirects', async () => {
    const five = opts('https://huggingface.co/chain/5', 'five.bin');
    await downloadVerified(five);
    expect(fs.readFileSync(five.dest).equals(DATA)).toBe(true);
    hits = [];
    await expect(downloadVerified(opts('https://huggingface.co/chain/6', 'six.bin')))
      .rejects.toThrow(/Hugging Face redirected the download more than 5 times/);
    expect(hits).toHaveLength(6); // the 6th redirect is never followed
    const opened = await openFollowingRedirects({ url: 'https://huggingface.co/chain/2', policy: WHISPER_DOWNLOAD_POLICY, fetch: fakeDns, headers: { range: 'bytes=0-0' } });
    expect(opened.url).toBe('https://cdn-lfs-us-1.hf.co/chain/0');
    await opened.res.body?.cancel();
  });
});

// ------------------------------------------------------------------
// Stall timeout
// ------------------------------------------------------------------

describe('stall timeout', () => {
  let st: http.Server;
  let stPort = 0;
  const hanging = new Set<http.ServerResponse>();
  let stHits: { path: string; range?: string }[] = [];
  beforeAll(async () => {
    st = http.createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      stHits.push({ path: p, range: req.headers.range });
      if (p === '/connect') { hanging.add(res); return; } // never answers
      if (p === '/body') {
        if (req.headers.range) return sendRange(req, res, DATA); // the resume works
        res.writeHead(200, { 'content-length': SIZE });
        res.write(DATA.subarray(0, SIZE / 2)); // then nothing more
        hanging.add(res);
        return;
      }
      if (p === '/trickle') {
        // Slow but steady: 8 chunks 60 ms apart (480 ms in all), each well within a 250 ms stall timeout.
        res.writeHead(200, { 'content-length': SIZE });
        let i = 0;
        const step = SIZE / 8;
        const t = setInterval(() => {
          res.write(DATA.subarray(i * step, (i + 1) * step));
          if (++i === 8) { clearInterval(t); res.end(); }
        }, 60);
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => st.listen(0, '127.0.0.1', () => r()));
    stPort = (st.address() as AddressInfo).port;
  });
  afterAll(async () => {
    for (const r of hanging) r.destroy();
    st.closeAllConnections?.();
    await new Promise<void>((r) => st.close(() => r()));
  });
  beforeEach(() => { stHits = []; });
  const opts = (p: string, name: string, stallTimeoutMs = 250) => {
    fs.mkdirSync(dir, { recursive: true });
    return {
      url: `http://127.0.0.1:${stPort}${p}`, bytes: SIZE, sha256: SHA, dest: path.join(dir, name), fetch: fetchFn,
      policy: WHISPER_DOWNLOAD_POLICY, allowLoopback: true, stallTimeoutMs,
    };
  };

  it('defaults to 60 s', () => {
    expect(DOWNLOAD_STALL_MS).toBe(60_000);
  });

  it('fails a connection that never answers', async () => {
    const t0 = Date.now();
    await expect(downloadVerified(opts('/connect', 'c.bin'))).rejects.toThrow('network error: the download stalled (no data for 250 ms)');
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('fails a body that stops, keeps the .part, and the next attempt resumes it', async () => {
    const o = opts('/body', 'b.bin');
    await expect(downloadVerified(o)).rejects.toThrow('network error: the download stalled (no data for 250 ms)');
    expect(fs.existsSync(o.dest)).toBe(false);
    expect(fs.statSync(`${o.dest}.part`).size).toBe(SIZE / 2);
    await downloadVerified(o);
    expect(stHits.at(-1)).toEqual({ path: '/body', range: `bytes=${SIZE / 2}-` });
    expect(fs.readFileSync(o.dest).equals(DATA)).toBe(true);
  });

  it('does not fail a slow download that keeps receiving data', async () => {
    const o = opts('/trickle', 't.bin');
    await downloadVerified(o);
    expect(fs.readFileSync(o.dest).equals(DATA)).toBe(true);
  });

  it('cancel still wins over the watchdog and removes the .part', async () => {
    const ac = new AbortController();
    const o = { ...opts('/body', 'x.bin', 5000), signal: ac.signal };
    const p = downloadVerified(o);
    for (let i = 0; i < 100 && !fs.existsSync(`${o.dest}.part`); i++) await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await expect(p).rejects.toThrow('download canceled');
    expect(fs.existsSync(`${o.dest}.part`)).toBe(false);
  });
});

describe('model installer', () => {
  const ctx = () => ({ modelsDir: dir, fetch: fetchFn, baseUrl: base, jobs: new Map<string, string>() });

  it('installs with progress, lists it as installed with its disk usage, then removes it', async () => {
    const q = new JobQueue({ throttleMs: 0 });
    const c = ctx();
    const job = startModelInstallJob(q, 'test-tiny', c);
    expect(job.kind).toBe('download');
    expect(job.title).toBe('Install Whisper model Test (tiny) (1 MB)');
    expect(c.jobs.get('test-tiny')).toBe(job.id);
    expect(startModelInstallJob(q, 'test-tiny', c).id).toBe(job.id);
    const done = await q.waitFor(job.id);
    expect(done.status, done.error).toBe('done');
    expect(done.result).toEqual({ model: 'test-tiny', bytes: SIZE });
    const list = await listWhisperModels(dir);
    expect(list.map((m) => m.id)).toEqual([...WHISPER_MODELS.map((m) => m.id), 'test-tiny']);
    expect(list.find((m) => m.id === 'test-tiny')).toMatchObject({ installed: true, partialBytes: 0 });
    expect(list.filter((m) => m.installed)).toHaveLength(1);
    expect(await whisperModelsDiskUsage(dir)).toBe(SIZE);
    expect(await verifyModel(dir, 'test-tiny')).toEqual({ ok: true, path: path.join(dir, TEST.file) });
    expect(await removeModel(q, 'test-tiny', { modelsDir: dir })).toEqual({ ok: true });
    expect(fs.existsSync(path.join(dir, TEST.file))).toBe(false);
    expect(await whisperModelsDiskUsage(dir)).toBe(0);
  });

  it('resumes a partial download with a Range request', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${TEST.file}.part`), DATA.subarray(0, 100_000));
    expect((await listWhisperModels(dir)).find((m) => m.id === 'test-tiny')).toMatchObject({ installed: false, partialBytes: 100_000 });
    const q = new JobQueue({ throttleMs: 0 });
    const done = await q.waitFor(startModelInstallJob(q, 'test-tiny', ctx()).id);
    expect(done.status, done.error).toBe('done');
    expect(seen.at(-1)).toEqual({ path: '/models/ggml-test-tiny.bin', range: 'bytes=100000-' });
    expect(fs.readFileSync(path.join(dir, TEST.file)).equals(DATA)).toBe(true);
  });

  it('cancel removes the partial file; remove is refused while downloading', async () => {
    slow = true;
    const q = new JobQueue({ throttleMs: 0 });
    const job = startModelInstallJob(q, 'test-tiny', ctx());
    for (let i = 0; i < 100 && !releaseSlow; i++) await new Promise((r) => setTimeout(r, 20));
    expect(activeModelInstallJob(q, 'test-tiny')?.id).toBe(job.id);
    expect((await removeModel(q, 'test-tiny', { modelsDir: dir })).error).toMatch(/downloading/);
    q.cancel(job.id);
    expect((await q.waitFor(job.id)).status).toBe('canceled');
    releaseSlow?.();
    expect(fs.existsSync(path.join(dir, `${TEST.file}.part`))).toBe(false);
    expect(fs.existsSync(path.join(dir, TEST.file))).toBe(false);
  });

  it('a corrupt download installs nothing', async () => {
    corrupt = true;
    const q = new JobQueue({ throttleMs: 0 });
    const done = await q.waitFor(startModelInstallJob(q, 'test-tiny', ctx()).id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/checksum mismatch/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('refuses to download without an HTTP client, and from a real URL without the override only over https', () => {
    const q = new JobQueue({ throttleMs: 0 });
    expect(() => startModelInstallJob(q, 'test-tiny', { modelsDir: dir })).toThrow(/Install from file/);
    expect(modelDownloadUrl(whisperModel('small')!)).toBe(`${WHISPER_MODELS_BASE}ggml-small.bin`);
    expect(modelDownloadUrl(whisperModel('small')!, base)).toBe(`${base}ggml-small.bin`);
    expect(() => startModelInstallJob(q, 'nope', ctx())).toThrow(/unknown Whisper model/);
  });

  it('installs from a file only when it matches the manifest', async () => {
    const q = new JobQueue({ throttleMs: 0 });
    const src = path.join(tmpRoot, `src-${n}.bin`);
    fs.writeFileSync(src, DATA.subarray(0, 1000));
    expect((await installModelFromFile(q, 'test-tiny', src, { modelsDir: dir })).error).toMatch(/is not the Test \(tiny\) model/);
    const wrong = Buffer.from(DATA); wrong[5] ^= 1;
    fs.writeFileSync(src, wrong);
    expect((await installModelFromFile(q, 'test-tiny', src, { modelsDir: dir })).ok).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
    fs.writeFileSync(src, DATA);
    expect(await installModelFromFile(q, 'test-tiny', src, { modelsDir: dir })).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(dir, TEST.file)).equals(DATA)).toBe(true);
    expect((await installModelFromFile(q, 'test-tiny', path.join(tmpRoot, 'missing.bin'), { modelsDir: dir })).error).toMatch(/was not found/);
  });

  it('verifies before use: missing, wrong size, swapped content (hashed again after a change)', async () => {
    expect(await verifyModel(dir, 'test-tiny')).toMatchObject({ ok: false, reason: 'missing' });
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, TEST.file);
    fs.writeFileSync(f, DATA.subarray(0, 10));
    expect(await verifyModel(dir, 'test-tiny')).toMatchObject({ ok: false, reason: 'damaged' });
    fs.writeFileSync(f, DATA);
    expect((await verifyModel(dir, 'test-tiny')).ok).toBe(true);
    const swapped = Buffer.from(DATA); swapped[0] ^= 1;
    fs.writeFileSync(f, swapped);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(f, later, later);
    expect(await verifyModel(dir, 'test-tiny')).toMatchObject({ ok: false, reason: 'damaged' });
    expect(await verifyModel(dir, 'nope')).toMatchObject({ ok: false, reason: 'unknown' });
  });
});

describe('test models and argument checks', () => {
  it('only accepts a well-formed test model spec, and only test ids', () => {
    expect(parseTestModelSpec(`123:${SHA}`)).toMatchObject({ id: 'test-tiny', bytes: 123, sha256: SHA });
    expect(parseTestModelSpec('123:abc')).toBeNull();
    expect(parseTestModelSpec(undefined)).toBeNull();
    setTestWhisperModels([{ ...TEST, id: 'small' }, { ...TEST, file: '../evil.bin' }]);
    expect(allWhisperModels()).toBe(WHISPER_MODELS);
    setTestWhisperModels([]);
    expect(findWhisperModel('test-tiny')).toBeUndefined();
  });

  it('checks IPC arguments', () => {
    setTestWhisperModels([]);
    expect(assertWhisperModelId('small')).toBe('small');
    expect(() => assertWhisperModelId('test-tiny')).toThrow(/unknown Whisper model/);
    expect(() => assertWhisperModelId(5)).toThrow();
    const abs = path.resolve('/media/film.mkv');
    const good = { mediaId: 'm1', path: abs, streamIndex: 1, model: 'small', language: 'auto', translate: true, extra: 'dropped' };
    expect(parseTranscribeRequest(good)).toEqual({ mediaId: 'm1', path: abs, streamIndex: 1, model: 'small', language: 'auto', translate: true });
    expect(parseTranscribeRequest({ ...good, translate: undefined }).translate).toBe(false);
    for (const bad of [null, {}, { ...good, mediaId: '' }, { ...good, path: 'relative.mkv' }, { ...good, streamIndex: -1 }, { ...good, streamIndex: 1.5 },
      { ...good, model: 'huge' }, { ...good, language: 'xx' }, { ...good, translate: 'yes' }]) {
      expect(() => parseTranscribeRequest(bad)).toThrow();
    }
  });

  it('formats sizes and titles', () => {
    expect(formatModelSize(77691713)).toBe('78 MB');
    expect(formatModelSize(1624555275)).toBe('1.6 GB');
    expect(modelInstallTitle(whisperModel('small')!)).toBe('Install Whisper model Small (488 MB)');
    expect(whisperModelsDir(path.resolve('/u'))).toBe(path.join(path.resolve('/u'), 'whisper', 'models'));
  });
});
