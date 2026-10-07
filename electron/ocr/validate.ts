/**
 * Argument checks for the OCR IPC channels (electron/ipc.ts): the renderer is not trusted, so every value is
 * checked before it reaches the OCR layer. No Electron import, so it stays unit-testable.
 */
import { isOcrLanguageCode, type OcrRequest } from '@shared/ocr';
import { assertAbsoluteMediaPath } from '../media/ffmpeg';

/** A manifest language code; throws otherwise. */
export function assertOcrLanguageCode(v: unknown): string {
  if (!isOcrLanguageCode(v)) throw new Error(`unknown OCR language: ${JSON.stringify(typeof v === 'string' ? v.slice(0, 40) : v)}`);
  return v;
}

/** An absolute path to a local file; throws otherwise. */
export function assertAbsolutePath(v: unknown, name = 'path'): string {
  if (typeof v !== 'string') throw new Error(`Expected ${name} to be a string`);
  assertAbsoluteMediaPath(v);
  return v;
}

/** A well-formed OcrRequest (a fresh object with only the known fields); throws otherwise. */
export function parseOcrRequest(v: unknown): OcrRequest {
  if (!v || typeof v !== 'object') throw new Error('Expected an OCR request');
  const r = v as Record<string, unknown>;
  if (typeof r.mediaId !== 'string' || r.mediaId === '') throw new Error('Expected mediaId to be a non-empty string');
  const path = assertAbsolutePath(r.path);
  if (!Number.isSafeInteger(r.streamIndex) || (r.streamIndex as number) < 0) throw new Error('Expected streamIndex to be a non-negative integer');
  const language = assertOcrLanguageCode(r.language);
  if (r.codec !== undefined && typeof r.codec !== 'string') throw new Error('Expected codec to be a string');
  const req: OcrRequest = { mediaId: r.mediaId, path, streamIndex: r.streamIndex as number, language };
  if (typeof r.codec === 'string') req.codec = r.codec;
  return req;
}
