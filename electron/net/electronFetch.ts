/**
 * The HTTP client the verified downloader (net/download.ts) uses in the app: Electron's `net.request` (Chromium's
 * network stack, so the system proxy and certificate store apply) behind the `fetch` shape the downloader expects.
 *
 * Why not `net.fetch`: with `redirect: 'manual'` it rejects with "Redirect was cancelled" instead of returning the 3xx
 * response, so the downloader could not check where a redirect goes (Hugging Face sends every model file to its
 * storage host). Here a redirect is never followed: the request is aborted and a bodyless response with the 3xx status
 * and a `location` header is returned, exactly what `fetch(…, { redirect: 'manual' })` returns in Node. The downloader
 * then decides, by its policy, whether to request the new URL.
 *
 * The response body is a pull-based stream (the network is paused while the downloader writes to disk), so memory
 * stays bounded for a 1.6 GB model. No `electron` import: main.ts passes `net.request` in, and tests pass a fake.
 */
import type { MediaFetch } from '../ipc';

/** The parts of Electron's IncomingMessage used here. */
export interface NetIncomingMessage {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string | string[]>;
  on(event: 'data', fn: (chunk: Buffer) => void): unknown;
  on(event: 'end', fn: () => void): unknown;
  on(event: 'error', fn: (e: Error) => void): unknown;
  on(event: 'aborted', fn: () => void): unknown;
  pause(): unknown;
  resume(): unknown;
}

/** The parts of Electron's ClientRequest used here. */
export interface NetClientRequest {
  setHeader(name: string, value: string): void;
  on(event: 'response', fn: (res: NetIncomingMessage) => void): unknown;
  on(event: 'redirect', fn: (statusCode: number, method: string, redirectUrl: string, responseHeaders: Record<string, string[] | string>) => void): unknown;
  on(event: 'error', fn: (e: Error) => void): unknown;
  abort(): void;
  end(): void;
}

export type NetRequestFn = (opts: { url: string; method: string; redirect: 'manual'; cache?: 'no-store' }) => NetClientRequest;

function headersFrom(raw: Record<string, string | string[]>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    try { h.set(k, Array.isArray(v) ? v.join(', ') : String(v)); } catch { /* a header name fetch refuses */ }
  }
  return h;
}

function abortError(): Error {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

/** A `fetch` with manual redirects on top of Electron's `net.request` (see the file comment). GET only. */
export function manualRedirectFetch(request: NetRequestFn): MediaFetch {
  return (url: string, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
    const signal = init.signal ?? undefined;
    if (signal?.aborted) { reject(abortError()); return; }
    let req: NetClientRequest;
    try {
      req = request({ url, method: (init.method ?? 'GET').toUpperCase(), redirect: 'manual', cache: 'no-store' });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    let settled = false;
    let fail: (e: Error) => void = (e) => { if (!settled) { settled = true; reject(e); } };
    const onAbort = () => {
      try { req.abort(); } catch { /* ignore */ }
      fail(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => signal?.removeEventListener('abort', onAbort);
    const headers = new Headers(init.headers as ConstructorParameters<typeof Headers>[0]);
    headers.forEach((v, k) => req.setHeader(k, v));

    req.on('redirect', (statusCode, _method, redirectUrl, responseHeaders) => {
      try { req.abort(); } catch { /* ignore */ }
      if (settled) return;
      settled = true;
      done();
      const h = headersFrom(responseHeaders);
      h.set('location', redirectUrl);
      resolve(new Response(null, { status: statusCode, headers: h }));
    });
    req.on('response', (res) => {
      if (settled) return;
      settled = true;
      let streamCtl: ReadableStreamDefaultController<Uint8Array> | null = null;
      let ended = false;
      // From now on an abort ends the body stream with an error instead of rejecting the (resolved) promise.
      fail = (e) => { if (!ended) { ended = true; streamCtl?.error(e); } };
      const body = new ReadableStream<Uint8Array>({
        start(ctl) {
          streamCtl = ctl;
          res.on('data', (chunk: Buffer) => {
            if (ended) return;
            ctl.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            if ((ctl.desiredSize ?? 1) <= 0) res.pause();
          });
          res.on('end', () => { if (!ended) { ended = true; done(); ctl.close(); } });
          res.on('error', (e: Error) => { if (!ended) { ended = true; done(); ctl.error(e); } });
          res.on('aborted', () => { if (!ended) { ended = true; done(); ctl.error(new Error('the connection was closed before the download finished')); } });
        },
        pull() { res.resume(); },
        cancel() {
          ended = true;
          done();
          try { req.abort(); } catch { /* ignore */ }
        },
      }, { highWaterMark: 16 });
      const status = res.statusCode;
      resolve(new Response(status === 204 || status === 304 ? null : body, { status, statusText: res.statusMessage, headers: headersFrom(res.headers) }));
    });
    req.on('error', (e: Error) => { done(); fail(e); });
    req.end();
  });
}
