/**
 * Open state of the Whisper dialogs and the pure helpers the Transcribe dialog, the Transcription Models dialog, the
 * menus and the jobs router share.
 *  - `openTranscribeDialog(mediaIds)` shows the Transcribe dialog with those media checked.
 *  - `openWhisperModels(focusId?)` shows the Transcription Models dialog, optionally scrolled to one model.
 */
import { create } from 'zustand';
import type { AudioStreamInfo, ID, JobInfo, MediaItem } from '../../shared/model';
import { guessWhisperLanguage, type WhisperModelState } from '../../shared/whisper';

export interface WhisperUiState {
  /** Media the Transcribe dialog was opened for (checked when it opens), or null when it is closed. */
  transcribeFor: ID[] | null;
  /** The Transcription Models dialog is open. */
  modelsOpen: boolean;
  /** Model id to highlight when it opens. */
  focusModel: string | null;
}

export const useWhisperUi = create<WhisperUiState>()(() => ({ transcribeFor: null, modelsOpen: false, focusModel: null }));

export function openTranscribeDialog(mediaIds: readonly ID[]): void {
  useWhisperUi.setState({ transcribeFor: [...mediaIds] });
}

export function closeTranscribeDialog(): void {
  useWhisperUi.setState({ transcribeFor: null });
}

export function openWhisperModels(focusModel?: string): void {
  useWhisperUi.setState({ modelsOpen: true, focusModel: focusModel ?? null });
}

export function closeWhisperModels(): void {
  useWhisperUi.setState({ modelsOpen: false, focusModel: null });
}

// ------------------------------------------------------------------
// Pure helpers
// ------------------------------------------------------------------

/** Why a media item cannot be transcribed (shown next to it), or null when it can. */
export function transcribeUnavailableReason(media: MediaItem | undefined): string | null {
  if (!media) return 'not in the project';
  if (media.offline) return 'offline';
  if (!media.probe) return 'not probed yet';
  if (!media.probe.audio.length) return 'no audio';
  return null;
}

/** The audio stream transcribed by default: the media's preferred stream when it exists, else the first. */
export function defaultAudioStream(media: MediaItem | undefined): AudioStreamInfo | undefined {
  const audio = media?.probe?.audio ?? [];
  return audio.find((a) => a.index === media?.preferredAudioStream) ?? audio[0];
}

/** "#1 eng 5.1 (ac3) — Commentary": a menu label for an audio stream. */
export function audioStreamLabel(s: AudioStreamInfo): string {
  const lang = s.language && s.language !== 'und' ? ` ${s.language}` : '';
  return `#${s.index}${lang} ${s.layout || `${s.channels} ch`} (${s.codec})${s.title ? ` — ${s.title}` : ''}`;
}

/** Spoken language selected by default: the stream's language tag when Whisper knows it, else auto-detect. */
export function defaultSpokenLanguage(stream: AudioStreamInfo | undefined): string {
  return guessWhisperLanguage(stream?.language) ?? 'auto';
}

/**
 * Model selected when the dialog opens: the last one used (prefs.whisperLastModel) when still installed, else Small,
 * else the first installed one; null when none is installed.
 */
export function chooseWhisperModel(models: readonly WhisperModelState[] | null, last?: string | null): string | null {
  const installed = (models ?? []).filter((m) => m.installed).map((m) => m.id);
  if (last && installed.includes(last)) return last;
  if (installed.includes('small')) return 'small';
  return installed[0] ?? null;
}

/** Title prefix of a model download job ("Install Whisper model Small (488 MB)"). */
export const WHISPER_DOWNLOAD_PREFIX = 'Install Whisper model ';

export function isWhisperDownload(job: Pick<JobInfo, 'kind' | 'title'>): boolean {
  return job.kind === 'download' && job.title.startsWith(WHISPER_DOWNLOAD_PREFIX);
}

/** "Small" from a model download job title; the title otherwise. */
export function whisperDownloadName(job: Pick<JobInfo, 'title'>): string {
  return /^Install Whisper model (.+?) \([^()]*\)$/.exec(job.title)?.[1] ?? job.title;
}

/** Stream index from a transcription job title ("Transcribe film.mkv #1 (Whisper Small)"), or null. */
export function transcribeJobStream(job: Pick<JobInfo, 'title'>): number | null {
  const m = / #(\d+) \(Whisper [^()]*\)$/.exec(job.title);
  return m ? Number(m[1]) : null;
}

/** The queued / running transcription of `streamIndex` of `mediaId`, if any. */
export function activeTranscribeJob(jobs: readonly JobInfo[], mediaId: ID, streamIndex?: number): JobInfo | undefined {
  return jobs.find((j) => j.kind === 'transcribe' && (j.status === 'queued' || j.status === 'running') && j.mediaId === mediaId
    && (streamIndex === undefined || transcribeJobStream(j) === streamIndex));
}
