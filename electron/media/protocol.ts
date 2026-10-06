/**
 * recut-media:// protocol: streams local files into the renderer with full HTTP Range support
 * so <video> can seek. URLs look like `recut-media://local/<encodeURIComponent(absolutePath)>`.
 *
 * The scheme must be registered as privileged in main.ts *before* app ready
 * (standard, secure, supportFetchAPI, stream, bypassCSP, corsEnabled).
 */
import { protocol } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import { MEDIA_SCHEME } from '../../shared/ipc';
import { contentTypeFor, mediaUrlPath, parseRange } from './range';
import { isThumbnailCacheFile } from './thumbs';

export { parseRange, contentTypeFor, mediaUrlPath } from './range';

/**
 * Thumbnail / filmstrip JPEGs in the cache are content-keyed (isThumbnailCacheFile), so the renderer may reuse its
 * copy without ever asking again. What actually stops the reloads of re-mounted timeline tiles is the renderer
 * holding its copies (src/playback/thumbnails.ts holdImage); measured alone, this header changed nothing. It is set so
 * that no cache policy ever revalidates a held copy. Everything else (source media, proxies, stills) can change
 * under the same path and stays `no-cache`.
 */
export function cacheControlFor(filePath: string): string {
  return isThumbnailCacheFile(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache';
}

function baseHeaders(filePath: string, st: fs.Stats): Record<string, string> {
  return {
    'Content-Type': contentTypeFor(filePath),
    'Accept-Ranges': 'bytes',
    'Last-Modified': st.mtime.toUTCString(),
    'Cache-Control': cacheControlFor(filePath),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  };
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });
}

/** Handle one request for a local file. Exported for direct testing with a Request. */
export async function handleMediaRequest(req: Request): Promise<Response> {
  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return text(405, 'Method Not Allowed');

  const filePath = mediaUrlPath(req.url, MEDIA_SCHEME);
  if (!filePath) return text(400, 'Bad media URL');

  let st: fs.Stats;
  try {
    st = await fsp.stat(filePath);
  } catch {
    return text(404, 'Not Found');
  }
  if (!st.isFile()) return text(404, 'Not Found');

  const size = st.size;
  const headers = baseHeaders(filePath, st);
  const rangeHeader = req.headers.get('range');

  if (rangeHeader) {
    const range = parseRange(rangeHeader, size);
    if (!range) {
      headers['Content-Range'] = `bytes */${size}`;
      return new Response(null, { status: 416, headers });
    }
    const length = range.end - range.start + 1;
    headers['Content-Length'] = String(length);
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    if (method === 'HEAD' || length === 0) return new Response(null, { status: 206, headers });
    return new Response(streamFile(filePath, range.start, range.end, req.signal), { status: 206, headers });
  }

  headers['Content-Length'] = String(size);
  if (method === 'HEAD' || size === 0) return new Response(null, { status: 200, headers });
  return new Response(streamFile(filePath, 0, size - 1, req.signal), { status: 200, headers });
}

function streamFile(filePath: string, start: number, end: number, signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  const rs = fs.createReadStream(filePath, { start, end, highWaterMark: 1024 * 1024 });
  if (signal) {
    const abort = () => rs.destroy();
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    rs.once('close', () => signal.removeEventListener('abort', abort));
  }
  // Node's web stream type vs. DOM lib type: structurally the same at runtime.
  return Readable.toWeb(rs) as unknown as ReadableStream<Uint8Array>;
}

let registered = false;

/** Install the protocol handler. Call once after `app.whenReady()`. */
export function registerMediaProtocol(): void {
  if (registered) return;
  registered = true;
  protocol.handle(MEDIA_SCHEME, (req) =>
    handleMediaRequest(req).catch((e) => {
      console.error(`[${MEDIA_SCHEME}] handler error for ${req.url}:`, e);
      return text(500, 'Internal error');
    }),
  );
}
