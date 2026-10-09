/**
 * Transcript providers: pluggable sources of subtitle cues for a media file.
 *
 * Extension point
 * ---------------
 * A provider turns a media path into `SubtitleCue[]` (seconds). To add one (e.g. a cloud ASR service or a
 * bundled whisper.cpp binary), implement `TranscriptProvider` and add it to `PROVIDERS` below. The Transcript
 * panel lists every provider under "Transcribe…", calls `available()` to enable/disable the entry and runs
 * `transcribe()` with a progress callback, then attaches the returned cues to the media as a SubtitleTrack
 * whose `origin` is the provider id. Long-running providers should report progress in [0, 1] and honour
 * `opts.signal` for cancellation. A provider whose work runs as a main-process job (Local Whisper:
 * `JobKind: 'transcribe'`) implements `openDialog()` instead: the panel opens its dialog, and the jobs router attaches
 * the cues when the job finishes.
 */
import type { SubtitleCue } from '../../shared/model';
import { parseSubtitles } from '../../shared/subtitles';
import { openTranscribeDialog } from '@/whisper/whisperUi';

export interface TranscribeOptions {
  /** BCP-47 / ISO-639 language hint, 'auto' to detect. */
  language?: string;
  /** For file-based providers: an explicit subtitle file instead of a sidecar lookup. */
  subtitlePath?: string;
  signal?: AbortSignal;
}

export type ProgressFn = (progress: number, message?: string) => void;

export interface TranscriptProvider {
  id: string;
  name: string;
  /** Short description shown next to the provider in menus. */
  description?: string;
  available(): Promise<boolean>;
  /** Reason shown when `available()` is false. */
  unavailableReason?(): Promise<string>;
  transcribe(mediaPath: string, opts: TranscribeOptions, onProgress?: ProgressFn): Promise<SubtitleCue[]>;
  /**
   * For providers that run as a main-process job: open the provider's dialog for these media instead of calling
   * `transcribe()` (the result arrives through the jobs router).
   */
  openDialog?(mediaIds: string[]): void;
}

function api() { return typeof window !== 'undefined' ? window.recut ?? null : null; }

function stripExt(p: string): string {
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const dot = p.lastIndexOf('.');
  return dot > slash ? p.slice(0, dot) : p;
}

/** Candidate sidecar subtitle paths for a media file (`Movie.srt`, `Movie.en.srt`, `Movie.vtt`, …). */
export function sidecarCandidates(mediaPath: string, language?: string): string[] {
  const base = stripExt(mediaPath);
  const langs = language && language !== 'auto' ? [language, 'en', 'eng'] : ['en', 'eng'];
  const out: string[] = [];
  for (const ext of ['srt', 'vtt']) {
    out.push(`${base}.${ext}`);
    for (const l of langs) out.push(`${base}.${l}.${ext}`);
  }
  return out;
}

/**
 * Reads an SRT/WebVTT file through the IPC bridge. With `opts.subtitlePath` it imports that file; otherwise it
 * looks for a sidecar subtitle next to the media.
 */
export class SubtitleFileProvider implements TranscriptProvider {
  id = 'subtitle-file';
  name = 'Subtitle file (SRT / WebVTT)';
  description = 'Import a sidecar .srt/.vtt next to the media';

  async available(): Promise<boolean> { return !!api(); }

  async findSidecar(mediaPath: string, language?: string): Promise<string | null> {
    const a = api();
    if (!a) return null;
    for (const p of sidecarCandidates(mediaPath, language)) {
      try { const s = await a.stat(p); if (s.exists && !s.isDirectory) return p; } catch { /* try next */ }
    }
    return null;
  }

  async transcribe(mediaPath: string, opts: TranscribeOptions = {}, onProgress?: ProgressFn): Promise<SubtitleCue[]> {
    const a = api();
    if (!a) throw new Error('IPC unavailable');
    onProgress?.(0, 'Locating subtitle file');
    const path = opts.subtitlePath ?? (await this.findSidecar(mediaPath, opts.language));
    if (!path) throw new Error('No sidecar subtitle file found next to the media');
    if (opts.signal?.aborted) throw new Error('Canceled');
    onProgress?.(0.3, `Reading ${path}`);
    const text = await a.readText(path);
    const parsed = parseSubtitles(text);
    if (parsed.cues.length === 0) throw new Error(parsed.warnings[0] ?? 'No cues found');
    onProgress?.(1, `${parsed.cues.length} cues`);
    return parsed.cues;
  }
}

/**
 * On-device speech recognition with the whisper.cpp engine built into the app (Roadmap §5). Available when the engine
 * runs (`whisperEngine()` reports a version); a model is chosen, and installed if needed, in the Transcribe dialog.
 * Transcription is a main-process job ('transcribe'), so the panel calls `openDialog()`; the jobs router attaches each
 * result as a SubtitleTrack with `origin: 'whisper'` (src/app/jobsRouter.ts).
 */
export class LocalWhisperProvider implements TranscriptProvider {
  id = 'whisper-local';
  name = 'Local Whisper';
  description = 'On-device speech recognition (whisper.cpp)';

  private engineError: string | null = null;

  async available(): Promise<boolean> {
    const a = api();
    if (!a?.whisperEngine) { this.engineError = 'needs the desktop app'; return false; }
    try {
      const info = await a.whisperEngine();
      this.engineError = info.version ? null : (info.path ? 'engine does not start' : 'engine not included in this build');
      return !!info.version;
    } catch (e) {
      this.engineError = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async unavailableReason(): Promise<string> { return this.engineError ?? 'not available'; }

  async transcribe(): Promise<SubtitleCue[]> {
    throw new Error('Local Whisper runs as a background job: use the Transcribe dialog');
  }

  openDialog(mediaIds: string[]): void {
    openTranscribeDialog(mediaIds);
  }
}

const PROVIDERS: TranscriptProvider[] = [new SubtitleFileProvider(), new LocalWhisperProvider()];

export function getProviders(): TranscriptProvider[] { return PROVIDERS; }
export function getProvider(id: string): TranscriptProvider | undefined { return PROVIDERS.find((p) => p.id === id); }
