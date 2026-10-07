/**
 * Where installed OCR language files live (`<userData>/ocr/tessdata/<code>.traineddata`) and which manifest
 * languages are installed. No Electron import, so it stays unit-testable.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { OCR_LANGUAGES, ocrLanguage, type OcrLanguageInfo, type OcrLanguageState } from '@shared/ocr';

/** The OCR language folder for a user-data folder. */
export function ocrDataDir(userData: string): string {
  return path.join(userData, 'ocr', 'tessdata');
}

/** Path of a manifest language's file in `dir`. Throws for a code that is not in the manifest. */
export function ocrLanguagePath(dir: string, code: string): string {
  const lang = ocrLanguage(code);
  if (!lang) throw new Error(`unknown OCR language: ${JSON.stringify(code)}`);
  return path.join(dir, lang.file);
}

/** True when `lang`'s file is in `dir` as a regular file of exactly the manifest size (the hash is checked before use). */
export async function isOcrLanguageInstalled(dir: string, lang: OcrLanguageInfo): Promise<boolean> {
  try {
    const st = await fsp.stat(path.join(dir, lang.file));
    return st.isFile() && st.size === lang.bytes;
  } catch {
    return false;
  }
}

/**
 * Every manifest language with its install state. `jobFor(code)` names the active 'download' job installing a
 * language, if any.
 */
export async function listOcrLanguages(dir: string, jobFor?: (code: string) => string | undefined): Promise<OcrLanguageState[]> {
  return Promise.all(OCR_LANGUAGES.map(async (l): Promise<OcrLanguageState> => {
    const state: OcrLanguageState = { code: l.code, name: l.name, bytes: l.bytes, installed: await isOcrLanguageInstalled(dir, l) };
    const jobId = jobFor?.(l.code);
    if (jobId) state.jobId = jobId;
    return state;
  }));
}
