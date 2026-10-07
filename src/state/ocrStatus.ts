/**
 * Installed OCR languages (from window.recut.ocrLanguages()): one row per manifest language with its install
 * state. `languages` is null until the first refresh, so unit tests and the browser-only renderer never block on
 * it. Refreshed when the OCR Languages dialog or Preferences opens, after Remove / Install from file, and by the
 * jobs router when a 'download' job settles.
 */
import { create } from 'zustand';
import type { OcrLanguageState } from '../../shared/ocr';
import type { RecutApi } from '../../shared/ipc';

export interface OcrStatusState {
  /** Every manifest language with its state; null until loaded (or outside the desktop app). */
  languages: OcrLanguageState[] | null;
  /** Last refresh error, if any. */
  error: string | null;
  /** Re-read the language list from the main process. Concurrent calls share the latest result. */
  refresh(): Promise<void>;
  /** The installed languages (empty while unknown). */
  installed(): OcrLanguageState[];
}

const api = (): RecutApi | null => (typeof window !== 'undefined' && window.recut ? window.recut : null);
let seq = 0;

export const useOcrStatus = create<OcrStatusState>()((set, get) => ({
  languages: null,
  error: null,
  async refresh() {
    const a = api();
    if (!a?.ocrLanguages) return;
    const mine = ++seq;
    try {
      const languages = await a.ocrLanguages();
      if (mine === seq) set({ languages, error: null });
    } catch (e) {
      if (mine === seq) set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
  installed() {
    return (get().languages ?? []).filter((l) => l.installed);
  },
}));

/** "4.1 MB" (decimal megabytes; the same rounding as the install job titles). */
export function formatOcrSize(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/** "English, French (5.2 MB)", or "None" when nothing is installed. */
export function installedSummary(languages: readonly OcrLanguageState[] | null): string {
  const inst = (languages ?? []).filter((l) => l.installed);
  if (!inst.length) return 'None';
  return `${inst.map((l) => l.name).join(', ')} (${formatOcrSize(inst.reduce((a, l) => a + l.bytes, 0))})`;
}
