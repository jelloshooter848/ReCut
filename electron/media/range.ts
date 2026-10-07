/**
 * Pure helpers for the recut-media:// protocol handler.
 * No Electron imports here so unit tests can exercise them directly.
 */
import path from 'node:path';

export interface ByteRange { start: number; end: number }

/**
 * Parse an HTTP `Range` header against a resource of `size` bytes.
 *
 * - `null`/`undefined`/empty header → the full range `{0, size-1}`.
 * - `bytes=a-b`   → inclusive range, `b` clamped to `size-1`.
 * - `bytes=a-`    → from `a` to the end.
 * - `bytes=-n`    → the last `n` bytes (whole file when n >= size).
 * - Multiple ranges: only the first one is honoured.
 * - Malformed or unsatisfiable (start >= size, start > end, `-0`) → `null`.
 */
export function parseRange(header: string | null | undefined, size: number): ByteRange | null {
  if (!Number.isFinite(size) || size < 0) return null;
  if (header == null || header.trim() === '') return { start: 0, end: size - 1 };
  const m = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (!m) return null;
  const first = m[1].split(',')[0].trim();
  const parts = /^(\d*)\s*-\s*(\d*)$/.exec(first);
  if (!parts) return null;
  const [, a, b] = parts;
  if (a === '' && b === '') return null;
  if (a === '') {
    // suffix range: last N bytes
    const n = Number(b);
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    if (size === 0) return null;
    const start = Math.max(0, size - n);
    return { start, end: size - 1 };
  }
  const start = Number(a);
  if (!Number.isSafeInteger(start) || start < 0) return null;
  if (start >= size) return null;
  let end = b === '' ? size - 1 : Number(b);
  if (!Number.isSafeInteger(end) || end < start) return null;
  if (end > size - 1) end = size - 1;
  return { start, end };
}

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mts': 'video/mp2t',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.ac3': 'audio/ac3',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.png': 'image/png',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.ass': 'text/plain; charset=utf-8',
  '.ssa': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

export function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** Extract the filesystem path from a `recut-media://local/<encoded>` URL. Returns null when the URL is not ours. */
export function mediaUrlPath(url: string, scheme: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== `${scheme}:`) return null;
  if (u.hostname !== 'local') return null;
  const raw = u.pathname.startsWith('/') ? u.pathname.slice(1) : u.pathname;
  if (!raw) return null;
  try { return decodeURIComponent(raw); } catch { return null; }
}
