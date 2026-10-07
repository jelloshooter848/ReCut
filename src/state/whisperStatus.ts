/**
 * Whisper models and engine (from window.recut.whisperModels() / whisperEngine()): one row per manifest model with its
 * install state, and the bundled engine's version. Both are null until the first refresh, so unit tests and the
 * browser-only renderer never block on them. Refreshed when the Transcription Models dialog, the Transcribe dialog or
 * Preferences opens, after Remove / Install from file, and by the jobs router when a model download settles.
 */
import { create } from 'zustand';
import type { WhisperEngineInfo, WhisperModelState } from '../../shared/whisper';
import type { RecutApi } from '../../shared/ipc';

export interface WhisperStatusState {
  /** Every model with its state; null until loaded (or outside the desktop app). */
  models: WhisperModelState[] | null;
  /** The bundled engine; null until loaded. */
  engine: WhisperEngineInfo | null;
  /** Last refresh error, if any. */
  error: string | null;
  /** Re-read the model list (and the engine, once) from the main process. Concurrent calls share the latest result. */
  refresh(): Promise<void>;
}

const api = (): RecutApi | null => (typeof window !== 'undefined' && window.recut ? window.recut : null);
let seq = 0;

export const useWhisperStatus = create<WhisperStatusState>()((set, get) => ({
  models: null,
  engine: null,
  error: null,
  async refresh() {
    const a = api();
    if (!a?.whisperModels) return;
    const mine = ++seq;
    try {
      const [models, engine] = await Promise.all([
        a.whisperModels(),
        get().engine?.version ? Promise.resolve(get().engine) : a.whisperEngine?.() ?? Promise.resolve(null),
      ]);
      if (mine === seq) set({ models, engine: engine ?? null, error: null });
    } catch (e) {
      if (mine === seq) set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
}));

/** "488 MB" / "1.6 GB" (decimal units; the same rounding as the install job titles). */
export function formatModelSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/** Disk space used by installed models and partial downloads. */
export function modelsDiskUsage(models: readonly WhisperModelState[] | null): number {
  return (models ?? []).reduce((a, m) => a + (m.installed ? m.bytes : 0) + m.partialBytes, 0);
}

/** "Small, Base (635 MB)", or "None" when nothing is installed. */
export function installedModelsSummary(models: readonly WhisperModelState[] | null): string {
  const inst = (models ?? []).filter((m) => m.installed);
  if (!inst.length) return 'None';
  return `${inst.map((m) => m.name).join(', ')} (${formatModelSize(inst.reduce((a, m) => a + m.bytes, 0))})`;
}
