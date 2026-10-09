#!/usr/bin/env node
/**
 * CI check: would ReCut's download policy accept the real redirect chain of every pinned download?
 *
 * For each Whisper model in shared/whisper.ts (and a few OCR language files from shared/ocr.ts) it requests the first
 * byte only (`Range: bytes=0-0`, no full download) from the pinned URL and
 *   1. traces the redirect chain hop by hop, printing each hop's status and host and whether the app's policy
 *      (isAllowedRedirect in electron/net/download.ts) allows it, and
 *   2. opens the file with the app's own redirect loop (openFollowingRedirects in electron/net/download.ts, the code
 *      every model download runs) under the app's policy (WHISPER_DOWNLOAD_POLICY / OCR_DOWNLOAD_POLICY), and checks
 *      that the final answer is the pinned file's size.
 * The TypeScript sources are bundled with esbuild (a devDependency) into a temp file first, so this runs the real code.
 *
 * Exit code 1 when the policy refuses a hop, or the final answer is wrong (HTTP 4xx, another size). A network error
 * or HTTP 5xx / 429 is retried once after a pause; a policy refusal is never retried and never ignored.
 *
 *   node scripts/check-model-redirects.mjs [--only tiny,small] [--no-ocr]
 *
 * Behind an HTTP proxy, run it with NODE_USE_ENV_PROXY=1 (Node >= 22.21) so fetch uses HTTPS_PROXY.
 * Signed query strings are never printed.
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const onlyArg = args.includes('--only') ? args[args.indexOf('--only') + 1] ?? '' : '';
const only = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim()).filter(Boolean)) : null;
const withOcr = !args.includes('--no-ocr');
/** OCR language files checked (same downloader, raw.githubusercontent.com). */
const OCR_SAMPLE = ['eng', 'chi_sim'];
const MAX_TRACE_HOPS = 8;
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_PAUSE_MS = 10_000;

/** Bundle the app's policy code (TypeScript) into a temp ES module and import it. */
async function loadAppCode() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-redirect-check-'));
  const outfile = path.join(tmp, 'policy.mjs');
  try {
    await build({
      stdin: {
        contents: [
          "export { openFollowingRedirects, isAllowedRedirect, isAllowedStartUrl } from './electron/net/download';",
          "export { WHISPER_DOWNLOAD_POLICY } from './electron/whisper/models';",
          "export { OCR_DOWNLOAD_POLICY } from './electron/ocr/download';",
          "export { WHISPER_MODELS, whisperModelUrl } from './shared/whisper';",
          "export { OCR_LANGUAGES, ocrLanguageUrl } from './shared/ocr';",
        ].join('\n'),
        resolveDir: root,
        sourcefile: 'check-model-redirects-entry.ts',
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      outfile,
      alias: { '@shared': path.join(root, 'shared') },
      logLevel: 'warning',
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** URL without its query string (signed storage URLs carry credentials-like signatures). */
function safeUrl(u) {
  try { const x = new URL(u); return `${x.origin}${x.pathname.length > 90 ? `${x.pathname.slice(0, 87)}...` : x.pathname}`; } catch { return String(u).slice(0, 120); }
}
function hostOf(u) {
  try { const x = new URL(u); return x.port ? `${x.hostname}:${x.port}` : x.hostname; } catch { return '?'; }
}

const fetchFirstByte = (url, init = {}) => fetch(url, {
  ...init,
  headers: { ...(init.headers ?? {}), range: 'bytes=0-0' },
  signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
});

class Transient extends Error {}

/** Follow the chain by hand (whatever the policy says) and annotate each hop with the policy's verdict. */
async function trace(app, startUrl, policy) {
  const origin = new URL(startUrl).origin;
  const hops = [];
  let url = startUrl;
  for (let i = 0; i < MAX_TRACE_HOPS; i++) {
    const allowed = i === 0 ? app.isAllowedStartUrl(url, policy) : app.isAllowedRedirect(url, origin, policy);
    let res;
    try {
      res = await fetchFirstByte(url, { redirect: 'manual' });
    } catch (e) {
      throw new Transient(`network error at ${hostOf(url)}: ${[e?.message, e?.cause?.code, e?.cause?.message].filter(Boolean).join(': ') || String(e)}`);
    }
    await res.body?.cancel().catch(() => undefined);
    const loc = res.headers.get('location');
    hops.push({ host: hostOf(url), url, status: res.status, allowed, contentRange: res.headers.get('content-range'), contentLength: res.headers.get('content-length') });
    if (res.status >= 300 && res.status < 400 && loc) { url = new URL(loc, url).toString(); continue; }
    break;
  }
  return hops;
}

/** Open the file with the app's own redirect loop and policy; returns the final response facts. */
async function openWithApp(app, startUrl, policy) {
  const hops = [];
  let opened;
  try {
    opened = await app.openFollowingRedirects({
      url: startUrl, policy, fetch: (u, init) => fetch(u, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
      headers: { range: 'bytes=0-0' }, onHop: (h) => hops.push(h),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/^network error/.test(msg)) throw new Transient(msg);
    return { ok: false, policyRefused: /refusing|too many redirects/.test(msg), error: msg, hops };
  }
  const { res, url } = opened;
  await res.body?.cancel().catch(() => undefined);
  return { ok: true, status: res.status, url, contentRange: res.headers.get('content-range'), contentLength: res.headers.get('content-length'), hops };
}

/** Total size from a 206 Content-Range, or the length of a 200. */
function totalSize(r) {
  const m = r.contentRange ? /\/(\d+)$/.exec(r.contentRange.trim()) : null;
  if (r.status === 206 && m) return Number(m[1]);
  if (r.status === 200 && r.contentLength) return Number(r.contentLength);
  return null;
}

/** Check one pinned file; returns { failed, line } for the summary. Retries a transient failure once. */
async function checkOne(app, kind, name, url, policy, bytes) {
  for (let attempt = 1; ; attempt++) {
    try {
      console.log(`\n${kind} ${name}: ${safeUrl(url)}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      const hops = await trace(app, url, policy);
      hops.forEach((h, i) => console.log(`  hop ${i + 1}  HTTP ${h.status}  ${h.host.padEnd(34)} ${h.allowed ? 'allowed' : 'REFUSED by the app policy'}  ${safeUrl(h.url)}`));
      const last = hops.at(-1);
      if (last && last.status >= 500 || last?.status === 429) throw new Transient(`HTTP ${last.status} from ${last.host}`);
      const r = await openWithApp(app, url, policy);
      const chain = hops.map((h) => h.host).join(' -> ');
      if (!r.ok) {
        console.log(`  app: FAILED: ${r.error}`);
        if (r.policyRefused) console.log(`::error::${kind} ${name}: the app's download policy refuses the real redirect chain (${chain}): ${r.error}`);
        else console.log(`::error::${kind} ${name}: ${r.error}`);
        return { failed: true, line: `| ${kind} | ${name} | ${chain} | refused: ${r.error} |` };
      }
      if (r.status >= 500 || r.status === 429) throw new Transient(`HTTP ${r.status} from ${hostOf(r.url)}`);
      const size = totalSize(r);
      if ((r.status !== 206 && r.status !== 200) || size !== bytes) {
        const why = `final answer HTTP ${r.status} from ${hostOf(r.url)}, size ${size ?? 'unknown'} (expected ${bytes})`;
        console.log(`  app: FAILED: ${why}`);
        console.log(`::error::${kind} ${name}: ${why}`);
        return { failed: true, line: `| ${kind} | ${name} | ${chain} | ${why} |` };
      }
      console.log(`  app: ok, HTTP ${r.status} from ${hostOf(r.url)} after ${r.hops.length} response(s), size ${size}`);
      return { failed: false, line: `| ${kind} | ${name} | ${chain} | ok (HTTP ${r.status}) |` };
    } catch (e) {
      if (!(e instanceof Transient)) throw e;
      if (attempt >= 2) {
        console.log(`::error::${kind} ${name}: ${e.message} (after a retry)`);
        return { failed: true, line: `| ${kind} | ${name} | - | ${e.message} |` };
      }
      console.log(`  transient failure (${e.message}); retrying in ${RETRY_PAUSE_MS / 1000} s`);
      await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
    }
  }
}

const app = await loadAppCode();
const results = [];
for (const m of app.WHISPER_MODELS) {
  if (only && !only.has(m.id)) continue;
  results.push(await checkOne(app, 'Whisper model', m.id, app.whisperModelUrl(m), app.WHISPER_DOWNLOAD_POLICY, m.bytes));
}
if (withOcr) {
  for (const code of OCR_SAMPLE) {
    const lang = app.OCR_LANGUAGES.find((l) => l.code === code);
    if (!lang) { console.log(`::warning::OCR language ${code} is not in shared/ocr.ts`); continue; }
    results.push(await checkOne(app, 'OCR language', code, app.ocrLanguageUrl(lang), app.OCR_DOWNLOAD_POLICY, lang.bytes));
  }
}

const failed = results.filter((r) => r.failed).length;
const where = `${os.platform()} ${os.arch()}`;
console.log(`\n${failed ? `${failed} of ${results.length} downloads FAILED` : `All ${results.length} downloads pass`} the app's download policy (${where}).`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [`### Download redirect check (${where})`, '', '| Kind | File | Hosts (in order) | Result |', '| --- | --- | --- | --- |', ...results.map((r) => r.line), ''].join('\n');
  try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`); } catch { /* summary is optional */ }
}
process.exit(failed ? 1 : 0);
