/**
 * Verified download of one pinned file (OCR language data): `downloadVerified` streams the file into
 * `<dest>.part`, resumes an interrupted `.part` with an HTTP Range request, refuses anything larger than the
 * expected size, checks the SHA-256 of the whole file and only then renames it into place.
 *
 * - Only `https://raw.githubusercontent.com/` URLs are fetched; a loopback http(s) origin (127.0.0.1, localhost,
 *   [::1]) is accepted only when the caller passes `allowLoopback` (the test override RECUT_OCR_LANG_URL, read by
 *   the media layer, never here).
 * - Redirects are followed by hand (`redirect: 'manual'`) and only within the same origin.
 * - Cancel (the signal aborts) and a checksum mismatch delete the `.part`; a network error keeps it so the next
 *   attempt resumes.
 *
 * Pure Node, no Electron: the HTTP client is passed in (`net.fetch` in the app, global fetch in tests).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import type { MediaFetch } from '../ipc';
import { RENAME_RETRY } from '../project/io';

/** The only host language files are downloaded from (pinned tessdata_fast files). */
export const ALLOWED_DOWNLOAD_ORIGIN = 'https://raw.githubusercontent.com';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_REDIRECTS = 5;

export interface DownloadVerifiedOptions {
  url: string;
  /** Exact expected size in bytes. */
  bytes: number;
  /** Expected lower-case hex SHA-256. */
  sha256: string;
  /** Final path; the download is written to `<dest>.part` first. The folder must exist. */
  dest: string;
  fetch: MediaFetch;
  signal?: AbortSignal;
  /** Fraction received, 0..1. */
  onProgress?: (fraction: number, receivedBytes: number) => void;
  /** Also accept a loopback http(s) origin (tests / RECUT_OCR_LANG_URL). */
  allowLoopback?: boolean;
}

/** Error thrown when the download was canceled (`signal` aborted). */
export class DownloadCanceledError extends Error {
  constructor() { super('download canceled'); this.name = 'DownloadCanceledError'; }
}

function isLoopbackUrl(u: URL): boolean {
  return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname) && !u.username && !u.password;
}

/** True when `url` may be downloaded from: the pinned https host, or (with `allowLoopback`) a loopback origin. */
export function isAllowedDownloadUrl(url: string, allowLoopback = false): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.username || u.password) return false;
  if (u.origin === ALLOWED_DOWNLOAD_ORIGIN && u.protocol === 'https:') return true;
  return allowLoopback && isLoopbackUrl(u);
}

/**
 * Normalized base URL from the RECUT_OCR_LANG_URL test override (ending in '/'), or null when it is unset or not a
 * loopback http(s) URL (a value pointing anywhere else is ignored, so the override can never send downloads to
 * another host).
 */
export function parseLangUrlOverride(value: string | undefined | null): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let u: URL;
  try { u = new URL(value.trim()); } catch { return null; }
  if (!isLoopbackUrl(u) || u.search || u.hash) return null;
  const s = u.toString();
  return s.endsWith('/') ? s : `${s}/`;
}

/** Same rename rule as electron/project/io.ts (Windows: retry EPERM / EACCES / EBUSY briefly). */
export async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!RENAME_RETRY.enabled || !code || !['EPERM', 'EACCES', 'EBUSY'].includes(code) || attempt >= RENAME_RETRY.delaysMs.length) throw e;
      await new Promise((r) => setTimeout(r, RENAME_RETRY.delaysMs[attempt]));
    }
  }
}

async function removeQuietly(p: string): Promise<void> {
  try { await fsp.rm(p, { force: true }); } catch { /* ignore */ }
}

async function fileSize(p: string): Promise<number> {
  try {
    const st = await fsp.stat(p);
    return st.isFile() ? st.size : -1;
  } catch {
    return 0;
  }
}

/** SHA-256 (hex) of a file, streamed. */
export function sha256File(p: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(p, { signal });
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('error', reject);
    rs.on('end', () => resolve(hash.digest('hex')));
  });
}

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

/** Start offset of a `Content-Range: bytes <start>-<end>/<total>` header, or null. */
function contentRangeStart(h: string | null): number | null {
  const m = h ? /^bytes\s+(\d+)-\d+\/(?:\d+|\*)$/i.exec(h.trim()) : null;
  return m ? Number(m[1]) : null;
}

interface Opened { res: Response; url: string }

/** Fetch with manual, same-origin-only redirects. */
async function fetchFollowingSameOrigin(o: DownloadVerifiedOptions, headers: Record<string, string>): Promise<Opened> {
  let url = o.url;
  const origin = new URL(o.url).origin;
  for (let hop = 0; ; hop++) {
    if (!isAllowedDownloadUrl(url, o.allowLoopback)) throw new Error(`refusing to download from ${new URL(url).origin}`);
    let res: Response;
    try {
      res = await o.fetch(url, { headers, redirect: 'manual', signal: o.signal, cache: 'no-store' } as RequestInit);
    } catch (e) {
      if (o.signal?.aborted) throw new DownloadCanceledError();
      throw new Error(`network error: ${e instanceof Error ? e.message : String(e)}`);
    }
    // A client that followed a redirect anyway: the final URL must still be on the same origin.
    if (res.url && res.url !== url) {
      let finalOrigin = '';
      try { finalOrigin = new URL(res.url).origin; } catch { /* ignore */ }
      if (finalOrigin !== origin) { await res.body?.cancel().catch(() => undefined); throw new Error(`refusing redirect to ${finalOrigin || 'another host'}`); }
    }
    if (res.type === 'opaqueredirect') throw new Error('refusing a redirect to an unknown location');
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      await res.body?.cancel().catch(() => undefined);
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`HTTP ${res.status} without a location`);
      const next = new URL(loc, url);
      if (next.origin !== origin) throw new Error(`refusing redirect to ${next.origin}`);
      if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
      url = next.toString();
      continue;
    }
    return { res, url };
  }
}

/**
 * Download `url` to `dest`, verified against `bytes` and `sha256`. Resolves once `dest` holds the verified file.
 * Throws `DownloadCanceledError` on cancel (the `.part` is removed), "checksum mismatch" when the file differs
 * from the manifest (the `.part` is removed), and "network error: …" when the transfer breaks (the `.part` is kept
 * for a resume).
 */
export async function downloadVerified(o: DownloadVerifiedOptions): Promise<void> {
  if (!isAllowedDownloadUrl(o.url, o.allowLoopback)) {
    let origin = o.url;
    try { origin = new URL(o.url).origin; } catch { /* keep the raw text */ }
    throw new Error(`refusing to download from ${origin}`);
  }
  if (!Number.isSafeInteger(o.bytes) || o.bytes <= 0) throw new Error('invalid expected size');
  const part = `${o.dest}.part`;
  const throwIfCanceled = async () => {
    if (o.signal?.aborted) { await removeQuietly(part); throw new DownloadCanceledError(); }
  };
  await throwIfCanceled();

  for (let attempt = 0; attempt < 2; attempt++) {
    let have = await fileSize(part);
    if (have < 0 || have >= o.bytes) { await removeQuietly(part); have = 0; } // not a file, or nothing left to resume
    const headers: Record<string, string> = {};
    if (have > 0) headers.range = `bytes=${have}-`;

    let opened: Opened;
    try {
      opened = await fetchFollowingSameOrigin(o, headers);
    } catch (e) {
      if (e instanceof DownloadCanceledError) await removeQuietly(part);
      throw e;
    }
    const { res } = opened;
    if (res.status === 416 && have > 0) {
      // The server cannot serve the rest of what we have: start over.
      await res.body?.cancel().catch(() => undefined);
      await removeQuietly(part);
      continue;
    }
    if (res.status !== 200 && res.status !== 206) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`download failed: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
    }
    let start = 0;
    if (res.status === 206) {
      const s = contentRangeStart(res.headers.get('content-range'));
      if (s !== have) {
        await res.body?.cancel().catch(() => undefined);
        await removeQuietly(part);
        if (attempt === 0) continue;
        throw new Error('download failed: the server sent an unexpected range');
      }
      start = have;
    }
    // 200 → the server ignored the Range (or there was none): the body is the whole file, so restart the .part.
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > 0 && start + len > o.bytes) {
      await res.body?.cancel().catch(() => undefined);
      await removeQuietly(part);
      throw new Error(`download failed: the file is larger than expected (${mb(start + len)}, expected ${mb(o.bytes)})`);
    }
    if (!res.body) throw new Error('download failed: empty response');

    await receive(o, res.body, part, start);
    await throwIfCanceled();

    // Verify the whole file (resumed prefix included).
    const size = await fileSize(part);
    if (size !== o.bytes) throw new Error(`network error: the download ended early (${mb(size)} of ${mb(o.bytes)})`);
    const got = await sha256File(part);
    if (got !== o.sha256.toLowerCase()) {
      await removeQuietly(part);
      throw new Error('checksum mismatch: the downloaded file is not the expected one');
    }
    await throwIfCanceled();
    await renameRetrying(part, o.dest);
    return;
  }
  throw new Error('download failed: the server could not resume the download');
}

/** Stream `body` into `part` from offset `start` (truncating when 0). Oversize and cancel delete the `.part`. */
async function receive(o: DownloadVerifiedOptions, body: ReadableStream<Uint8Array>, part: string, start: number): Promise<void> {
  const fh = await fsp.open(part, start > 0 ? 'a' : 'w');
  const reader = body.getReader();
  let received = start;
  let failure: Error | null = null;
  let removePart = false;
  const onAbort = () => { reader.cancel().catch(() => undefined); };
  o.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    o.onProgress?.(received / o.bytes, received);
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (o.signal?.aborted) { failure = new DownloadCanceledError(); removePart = true; }
        else failure = new Error(`network error: ${e instanceof Error ? e.message : String(e)}`);
        break;
      }
      if (o.signal?.aborted) { failure = new DownloadCanceledError(); removePart = true; break; }
      if (chunk.done) break;
      const buf = chunk.value;
      if (received + buf.byteLength > o.bytes) {
        failure = new Error(`download failed: the file is larger than expected (${mb(o.bytes)})`);
        removePart = true;
        reader.cancel().catch(() => undefined);
        break;
      }
      await fh.write(buf);
      received += buf.byteLength;
      o.onProgress?.(received / o.bytes, received);
    }
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    await fh.close().catch(() => undefined);
  }
  if (failure) {
    if (removePart) await removeQuietly(part);
    throw failure;
  }
}
