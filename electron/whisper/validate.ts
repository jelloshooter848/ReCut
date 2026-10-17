/**
 * Argument checks for the Whisper IPC channels (electron/ipc.ts): the renderer is not trusted, so every value is
 * checked before it reaches the transcription layer. No Electron import, so it stays unit-testable.
 */
import { isWhisperLanguageCode, type TranscribeRequest } from '@shared/whisper';
import { assertAbsolutePath } from '../ocr/validate';
import { assertWhisperModelId } from './models';

export { assertWhisperModelId };

/** A well-formed TranscribeRequest (a fresh object with only the known fields); throws otherwise. */
export function parseTranscribeRequest(v: unknown): TranscribeRequest {
  if (!v || typeof v !== 'object') throw new Error('Expected a transcription request');
  const r = v as Record<string, unknown>;
  if (typeof r.mediaId !== 'string' || r.mediaId === '') throw new Error('Expected mediaId to be a non-empty string');
  const path = assertAbsolutePath(r.path);
  if (!Number.isSafeInteger(r.streamIndex) || (r.streamIndex as number) < 0) throw new Error('Expected streamIndex to be a non-negative integer');
  const model = assertWhisperModelId(r.model);
  if (!isWhisperLanguageCode(r.language)) throw new Error(`unknown language: ${JSON.stringify(typeof r.language === 'string' ? r.language.slice(0, 20) : r.language)}`);
  if (r.translate !== undefined && typeof r.translate !== 'boolean') throw new Error('Expected translate to be a boolean');
  if (r.verbatim !== undefined && typeof r.verbatim !== 'boolean') throw new Error('Expected verbatim to be a boolean');
  return { mediaId: r.mediaId, path, streamIndex: r.streamIndex as number, model, language: r.language, translate: r.translate === true, verbatim: r.verbatim === true };
}
