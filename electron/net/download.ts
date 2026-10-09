/**
 * Verified download of one pinned file (OCR language data, Whisper models): `downloadVerified` streams the file into
 * `<dest>.part`, resumes an interrupted `.part` with an HTTP Range request, refuses anything larger than the
 * expected size, checks the SHA-256 of the whole file and only then renames it into place.
 *
 * - Every caller passes a `DownloadPolicy`: the https origins a download may start from, and where a redirect may
 *   lead over https on the default port: exact hosts (`redirectHosts`) and whole domains (`redirectDomains`, the name
 *   or any subdomain of it, e.g. Hugging Face's storage and CDN hosts under hf.co). Everything else is refused,
 *   including plain http. A loopback http(s) origin (127.0.0.1, localhost, [::1]) is accepted only when the caller
 *   passes `allowLoopback` (the test overrides RECUT_OCR_LANG_URL / RECUT_WHISPER_MODEL_URL, read by the media
 *   layer, never here).
 * - Redirects are followed by hand (`redirect: 'manual'`, at most 5): within the same origin, or to an allowed host.
 *   The SHA-256 check is the real guarantee: a file from anywhere else is never installed.
 * - Cancel (the signal aborts) and a checksum mismatch delete the `.part`; a network error keeps it so the next
 *   attempt resumes. A transfer that receives nothing for `stallTimeoutMs` (60 s; connecting or mid-file) is
 *   aborted as a network error, so a stalled download fails instead of hanging.
 * - Errors name the host or HTTP status in plain words; they end up in the job error and the toast.
 *
 * Pure Node, no Electron: the HTTP client is passed in (`net.fetch` in the app, global fetch in tests).
 * electron/ocr/download.ts wraps it with the OCR policy.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import type { MediaFetch } from '../ipc';
import { RENAME_RETRY } from '../project/io';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_REDIRECTS = 5;

/** Where a download may come from. */
export interface DownloadPolicy {
  /** https origins (`https://host`) a download may start from. */
  origins: readonly string[];
  /** Exact host names (no wildcards) a redirect may lead to over https, besides the starting origin. */
  redirectHosts?: readonly string[];
  /**
   * Domains a redirect may lead to over https: the name itself or any subdomain of it, matched at a label boundary
   * (`hf.co` allows `hf.co` and `us.aws.cdn.hf.co`, never `evilhf.co` or `hf.co.evil.com`).
   */
  redirectDomains?: readonly string[];
  /** Who serves the files, for error text ("Hugging Face"); default "The server". */
  provider?: string;
}

/** Default stall timeout: a download that receives nothing for this long fails as a network error. */
export const DOWNLOAD_STALL_MS = 60_000;

export interface DownloadVerifiedOptions {
  url: string;
  /** Exact expected size in bytes. */
  bytes: number;
  /** Expected lower-case hex SHA-256. */
  sha256: string;
  /** Final path; the download is written to `<dest>.part` first. The folder must exist. */
  dest: string;
  fetch: MediaFetch;
  /** Allowed origins and redirect hosts. */
  policy: DownloadPolicy;
  signal?: AbortSignal;
  /** Fraction received, 0..1. */
  onProgress?: (fraction: number, receivedBytes: number) => void;
  /** Also accept a loopback http(s) origin (tests / RECUT_OCR_LANG_URL / RECUT_WHISPER_MODEL_URL). */
  allowLoopback?: boolean;
  /** Fail when nothing arrives (response or body bytes) for this long; default DOWNLOAD_STALL_MS. Tests shorten it. */
  stallTimeoutMs?: number;
}

/** Error thrown when the download was canceled (`signal` aborted). */
export class DownloadCanceledError extends Error {
  constructor() { super('download canceled'); this.name = 'DownloadCanceledError'; }
}

/** Error thrown when the policy refuses a URL (a start URL or a redirect): never retried, never resumed. */
export class DownloadRefusedError extends Error {
  constructor(message: string) { super(message); this.name = 'DownloadRefusedError'; }
}

/**
 * True when `host` is `domain` or a subdomain of it, compared at a label boundary: `cdn.hf.co` is in `hf.co`;
 * `evilhf.co`, `hf.co.evil.com` and a host with an empty label or a trailing dot are not. Hosts as `URL.hostname`
 * gives them (lower case, IDNs in punycode).
 */
export function isHostInDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  if (!h || !d || h.split('.').some((l) => l === '') || d.split('.').some((l) => l === '')) return false;
  return h === d || h.endsWith(`.${d}`);
}

export function isLoopbackUrl(u: URL): boolean {
  return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname) && !u.username && !u.password;
}

/** True when `url` may start a download under `policy`: one of its https origins, or (with `allowLoopback`) a loopback origin. */
export function isAllowedStartUrl(url: string, policy: DownloadPolicy, allowLoopback = false): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:' && policy.origins.includes(u.origin)) return true;
  return allowLoopback && isLoopbackUrl(u);
}

/**
 * True when a redirect from `fromOrigin` (the origin the download started at) to `url` may be followed: the same
 * origin, or https on the default port, without credentials, to a host in `policy.redirectHosts` or in one of
 * `policy.redirectDomains`. With `allowLoopback`, a loopback http(s) URL whose host is listed is accepted too (tests
 * of the allow-list).
 */
export function isAllowedRedirect(url: string, fromOrigin: string, policy: DownloadPolicy, allowLoopback = false): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.username || u.password) return false;
  if (u.origin === fromOrigin && (u.protocol === 'https:' || (allowLoopback && isLoopbackUrl(u)))) return true;
  const listed = (policy.redirectHosts ?? []).includes(u.hostname)
    || (policy.redirectDomains ?? []).some((d) => isHostInDomain(u.hostname, d));
  if (!listed) return false;
  if (u.protocol === 'https:' && u.port === '') return true;
  return allowLoopback && isLoopbackUrl(u);
}

/**
 * Normalized base URL from a loopback test override (RECUT_OCR_LANG_URL, RECUT_WHISPER_MODEL_URL), ending in '/', or
 * null when it is unset or not a loopback http(s) URL (a value pointing anywhere else is ignored, so the override can
 * never send downloads to another host).
 */
export function parseLoopbackBaseUrl(value: string | undefined | null): string | null {
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

/** A response opened by `openFollowingRedirects`, and the URL it came from (after any redirects). */
export interface Opened { res: Response; url: string }

/** One response on the way to the file: its URL, status and (for a redirect) where it points. */
export interface DownloadHop { url: string; status: number; location?: string }

export interface OpenOptions {
  url: string;
  policy: DownloadPolicy;
  fetch: MediaFetch;
  signal?: AbortSignal;
  allowLoopback?: boolean;
  /** Request headers (e.g. a Range). */
  headers?: Record<string, string>;
  /** Called with every response, redirects included, before the policy decides on it (diagnostics, CI check). */
  onHop?: (hop: DownloadHop) => void;
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return 'another host'; }
}

function hostOf(url: string): string {
  try { return new URL(url).host || 'the server'; } catch { return 'the server'; }
}

/** "Hugging Face redirected the download to x.example.com, which ReCut doesn't allow (refusing redirect to …)". */
function refusedRedirect(to: string, policy: DownloadPolicy): DownloadRefusedError {
  const who = policy.provider ?? 'The server';
  let what = 'an address it could not read';
  let origin = 'another host';
  try {
    const u = new URL(to);
    origin = u.origin;
    what = u.protocol === 'https:' ? u.host : u.protocol === 'http:' ? `${u.host} over plain http` : `a ${u.protocol} address`;
    if (u.username || u.password) what += ' with a user name or password';
  } catch { /* keep the defaults */ }
  return new DownloadRefusedError(`${who} redirected the download to ${what}, which ReCut doesn't allow (refusing redirect to ${origin})`);
}

/**
 * Request `o.url` with manual redirects, following one only when the policy allows it (isAllowedRedirect), at most
 * MAX_REDIRECTS times. Resolves with the first non-redirect response. Throws DownloadRefusedError for a URL the
 * policy refuses ("… redirected the download to <host>, which ReCut doesn't allow"), "network error: …" naming the
 * host when a request fails, and DownloadCanceledError when `signal` aborts.
 * scripts/check-model-redirects.mjs runs this against the real servers in CI.
 */
export async function openFollowingRedirects(o: OpenOptions): Promise<Opened> {
  let url = o.url;
  const headers = o.headers ?? {};
  const origin = new URL(o.url).origin;
  const who = o.policy.provider ?? 'The server';
  for (let hop = 0; ; hop++) {
    if (hop === 0 && !isAllowedStartUrl(url, o.policy, o.allowLoopback)) throw new DownloadRefusedError(`refusing to download from ${originOf(url)}`);
    let res: Response;
    try {
      res = await o.fetch(url, { headers, redirect: 'manual', signal: o.signal, cache: 'no-store' } as RequestInit);
    } catch (e) {
      if (o.signal?.aborted) throw new DownloadCanceledError();
      throw new Error(`network error: could not reach ${hostOf(url)} (${e instanceof Error ? e.message : String(e)})`);
    }
    const location = res.headers.get('location') ?? undefined;
    o.onHop?.({ url, status: res.status, ...(location ? { location } : {}) });
    // A client that followed a redirect anyway: the final URL must still be one we would have followed.
    if (res.url && res.url !== url && !isAllowedRedirect(res.url, origin, o.policy, o.allowLoopback)) {
      await res.body?.cancel().catch(() => undefined);
      throw refusedRedirect(res.url, o.policy);
    }
    if (res.type === 'opaqueredirect') throw new DownloadRefusedError(`${who} redirected the download to an unknown location (refusing a redirect to an unknown location)`);
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      await res.body?.cancel().catch(() => undefined);
      if (!location) throw new Error(`download failed: HTTP ${res.status} from ${hostOf(url)} without a location`);
      let next: URL;
      try { next = new URL(location, url); } catch { throw refusedRedirect(location, o.policy); }
      if (!isAllowedRedirect(next.toString(), origin, o.policy, o.allowLoopback)) throw refusedRedirect(next.toString(), o.policy);
      if (hop >= MAX_REDIRECTS) throw new DownloadRefusedError(`${who} redirected the download more than ${MAX_REDIRECTS} times (too many redirects)`);
      url = next.toString();
      continue;
    }
    return { res, url };
  }
}

function formatMs(ms: number): string {
  return ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

/**
 * Stall watchdog for one download attempt: `arm()` on every sign of life (a response, a chunk). When it is not armed
 * again within `ms`, it aborts `signal` (passed to the HTTP client), runs `onFire` (cancels the body reader) and fails
 * any `race`d promise. The caller's own signal aborts `signal` too (cancel).
 */
class StallWatch {
  private readonly ctl = new AbortController();
  private readonly ms: number;
  private readonly user: AbortSignal | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private rejectRace: ((e: Error) => void) | null = null;
  fired = false;
  onFire: (() => void) | null = null;
  private readonly forward = () => this.ctl.abort();

  constructor(ms: number, user?: AbortSignal) {
    this.ms = ms;
    this.user = user;
    if (user?.aborted) this.ctl.abort();
    else user?.addEventListener('abort', this.forward, { once: true });
    this.arm();
  }

  get signal(): AbortSignal { return this.ctl.signal; }

  error(): Error { return new Error(`network error: the download stalled (no data for ${formatMs(this.ms)})`); }

  arm(): void {
    if (this.stopped || this.fired) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), this.ms);
  }

  private fire(): void {
    if (this.stopped) return;
    this.fired = true;
    this.ctl.abort();
    try { this.onFire?.(); } catch { /* ignore */ }
    this.rejectRace?.(this.error());
  }

  /** `p`, or a stall error if the watchdog fires first (a client that ignores the abort cannot hang the download). */
  race<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.rejectRace = reject;
      p.then(resolve, reject).finally(() => { this.rejectRace = null; });
    });
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.user?.removeEventListener('abort', this.forward);
  }
}

/**
 * Download `url` to `dest`, verified against `bytes` and `sha256`. Resolves once `dest` holds the verified file.
 * Throws `DownloadCanceledError` on cancel (the `.part` is removed), "checksum mismatch" when the file differs
 * from the manifest (the `.part` is removed), "network error: …" when the transfer breaks or stalls for
 * `stallTimeoutMs` (the `.part` is kept for a resume), and DownloadRefusedError when the policy refuses a redirect.
 */
export async function downloadVerified(o: DownloadVerifiedOptions): Promise<void> {
  if (!isAllowedStartUrl(o.url, o.policy, o.allowLoopback)) {
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

  const stallMs = o.stallTimeoutMs ?? DOWNLOAD_STALL_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    let have = await fileSize(part);
    if (have < 0 || have >= o.bytes) { await removeQuietly(part); have = 0; } // not a file, or nothing left to resume
    const headers: Record<string, string> = {};
    if (have > 0) headers.range = `bytes=${have}-`;

    // From the request until the last byte: a response or a chunk re-arms the watchdog; silence for stallMs aborts.
    const stall = new StallWatch(stallMs, o.signal);
    try {
      const { res, url } = await stall.race(openFollowingRedirects({
        url: o.url, policy: o.policy, fetch: o.fetch, signal: stall.signal, allowLoopback: o.allowLoopback, headers,
        onHop: () => stall.arm(),
      }));
      if (res.status === 416 && have > 0) {
        // The server cannot serve the rest of what we have: start over.
        await res.body?.cancel().catch(() => undefined);
        await removeQuietly(part);
        continue;
      }
      if (res.status !== 200 && res.status !== 206) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`download failed: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} from ${hostOf(url)}`);
      }
      let start = 0;
      if (res.status === 206) {
        const s = contentRangeStart(res.headers.get('content-range'));
        if (s !== have) {
          await res.body?.cancel().catch(() => undefined);
          await removeQuietly(part);
          if (attempt === 0) continue;
          throw new Error(`download failed: ${hostOf(url)} sent an unexpected range`);
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
      if (!res.body) throw new Error(`download failed: empty response from ${hostOf(url)}`);

      await receive(o, res.body, part, start, stall);
      stall.stop();
      if (stall.fired) throw stall.error();
    } catch (e) {
      stall.stop();
      // The caller's cancel wins; then a stall (whatever error the abort caused: the .part is kept for a resume).
      if (o.signal?.aborted) { await removeQuietly(part); throw new DownloadCanceledError(); }
      if (stall.fired) throw stall.error();
      if (e instanceof DownloadCanceledError) await removeQuietly(part);
      throw e;
    } finally {
      stall.stop();
    }
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
async function receive(o: DownloadVerifiedOptions, body: ReadableStream<Uint8Array>, part: string, start: number, stall: StallWatch): Promise<void> {
  const fh = await fsp.open(part, start > 0 ? 'a' : 'w');
  const reader = body.getReader();
  stall.onFire = () => { reader.cancel().catch(() => undefined); };
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
      stall.arm();
      await fh.write(buf);
      received += buf.byteLength;
      o.onProgress?.(received / o.bytes, received);
    }
  } finally {
    stall.onFire = null;
    o.signal?.removeEventListener('abort', onAbort);
    await fh.close().catch(() => undefined);
  }
  if (failure) {
    if (removePart) await removeQuietly(part);
    throw failure;
  }
}
