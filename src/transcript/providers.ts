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
 * `opts.signal` for cancellation. A real local provider would go through a main-process job
 * (`JobKind: 'transcribe'`) rather than running in the renderer.
 */
import type { SubtitleCue } from '../../shared/model';
import { parseSubtitles } from '../../shared/subtitles';

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
 * Placeholder for on-device speech recognition. Not bundled: `available()` is always false and `transcribe`
 * throws. A real implementation would ask the main process (appInfo / a `transcribe` job) whether a `whisper`
 * binary + model are installed, extract audio with FFmpeg and stream progress back.
 */
export class LocalWhisperProvider implements TranscriptProvider {
  id = 'whisper-local';
  name = 'Local Whisper';
  description = 'On-device speech recognition';

  async available(): Promise<boolean> { return false; }
  async unavailableReason(): Promise<string> { return 'Local transcription not installed'; }
  async transcribe(): Promise<SubtitleCue[]> { throw new Error('Local transcription not installed'); }
}

const PROVIDERS: TranscriptProvider[] = [new SubtitleFileProvider(), new LocalWhisperProvider()];

export function getProviders(): TranscriptProvider[] { return PROVIDERS; }
export function getProvider(id: string): TranscriptProvider | undefined { return PROVIDERS.find((p) => p.id === id); }
