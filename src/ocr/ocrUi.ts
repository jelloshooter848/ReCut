/**
 * Open state of the OCR dialogs (store.ui.dialogs flags are plain booleans, so dialogs that carry their own
 * options live here) and the pure helpers the OCR menus and dialog share.
 *  - `openOcrLanguages()` shows the OCR Languages dialog, optionally scrolled to one language.
 *  - `openOcrDialog({ mediaId, streamIndex })` shows the Read with OCR dialog for one bitmap subtitle stream.
 */
import { create } from 'zustand';
import type { ID, JobInfo, MediaItem, SubtitleStreamInfo } from '../../shared/model';
import { guessOcrLanguage, isOcrCodec, ocrLanguage, type OcrSubtitleCodec } from '../../shared/ocr';

export interface OcrDialogTarget { mediaId: ID; streamIndex: number }

export interface OcrUiState {
  /** The OCR Languages dialog is open. */
  languagesOpen: boolean;
  /** Language code to highlight when it opens. */
  focusCode: string | null;
  /** The stream the Read with OCR dialog is open for, or null when it is closed. */
  ocrTarget: OcrDialogTarget | null;
}

export const useOcrUi = create<OcrUiState>()(() => ({ languagesOpen: false, focusCode: null, ocrTarget: null }));

export function openOcrLanguages(focusCode?: string): void {
  useOcrUi.setState({ languagesOpen: true, focusCode: focusCode ?? null });
}

export function closeOcrLanguages(): void {
  useOcrUi.setState({ languagesOpen: false, focusCode: null });
}

export function openOcrDialog(target: OcrDialogTarget): void {
  useOcrUi.setState({ ocrTarget: { mediaId: target.mediaId, streamIndex: target.streamIndex } });
}

export function closeOcrDialog(): void {
  useOcrUi.setState({ ocrTarget: null });
}

// ------------------------------------------------------------------
// Pure helpers (menus, dialog, jobs router)
// ------------------------------------------------------------------

/** Short names of the bitmap formats, as menus show them. */
export const BITMAP_CODEC_LABELS: Record<OcrSubtitleCodec, string> = {
  hdmv_pgs_subtitle: 'PGS', dvd_subtitle: 'DVD', dvb_subtitle: 'DVB', xsub: 'XSUB',
};

/** Image-like subtitle codecs the app cannot read at all (not text, not OCR), with what to call them. */
export const UNSUPPORTED_SUBTITLE_CODECS: Record<string, string> = {
  dvb_teletext: 'teletext', arib_caption: 'ARIB captions',
};

/** "PGS" for a bitmap codec; the codec name otherwise. */
export function subtitleCodecLabel(codec: string): string {
  const c = codec.toLowerCase();
  return isOcrCodec(c) ? BITMAP_CODEC_LABELS[c] : codec;
}

export interface EmbeddedStreamEntry {
  label: string;
  disabled: boolean;
  /** The stream is a bitmap stream: choosing it opens the OCR dialog. */
  ocr: boolean;
}

/**
 * Menu entry for one embedded subtitle stream (Transcript Import › Embedded…, the project's Embedded Subtitles):
 *  - text streams: "#2 eng — Commentary (subrip)", extracted as text;
 *  - bitmap streams: "#3 eng (PGS) — Read with OCR…", opens the OCR dialog;
 *  - teletext / ARIB: disabled, "#4 ger (dvb_teletext) — teletext is not supported".
 */
export function embeddedStreamEntry(s: SubtitleStreamInfo): EmbeddedStreamEntry {
  const codec = (s.codec ?? '').toLowerCase();
  const lang = s.language ?? 'und';
  const title = s.title ? ` ${s.title}` : '';
  if (isOcrCodec(codec)) return { label: `#${s.index} ${lang}${title} (${BITMAP_CODEC_LABELS[codec]}) — Read with OCR…`, disabled: false, ocr: true };
  const unsupported = UNSUPPORTED_SUBTITLE_CODECS[codec];
  if (unsupported) return { label: `#${s.index} ${lang}${title} (${s.codec}) — ${unsupported} is not supported`, disabled: true, ocr: false };
  return { label: `#${s.index} ${lang}${s.title ? ` — ${s.title}` : ''} (${s.codec})`, disabled: false, ocr: false };
}

/** The media's bitmap subtitle streams the app can read with OCR. */
export function ocrStreams(media: MediaItem | undefined): SubtitleStreamInfo[] {
  return (media?.probe?.subtitles ?? []).filter((s) => isOcrCodec((s.codec ?? '').toLowerCase()));
}

/** The probed stream `streamIndex` of `media`, when it is a bitmap stream the app can OCR. */
export function ocrStream(media: MediaItem | undefined, streamIndex: number): SubtitleStreamInfo | undefined {
  return ocrStreams(media).find((s) => s.index === streamIndex);
}

/** Why the media cannot be read with OCR (menu label suffix), or null when it has a bitmap stream. */
export function ocrUnavailableReason(media: MediaItem | undefined): string | null {
  if (!media) return 'no media selected';
  if (media.offline) return 'media is offline';
  if (!media.probe) return 'media not probed yet';
  return ocrStreams(media).length ? null : 'no bitmap subtitle stream';
}

export interface OcrLanguageChoice {
  /** Language selected when the dialog opens (an installed one), or null when none is installed. */
  code: string | null;
  /** Language guessed from the stream's tag, installed or not. */
  guess: string | null;
  /** The guess is not installed: the dialog offers to install it. */
  offerInstall: boolean;
}

/**
 * Which language the OCR dialog selects: the one guessed from the stream's language tag when installed, else the
 * last one used (prefs.ocrLastLanguage) when installed, else the first installed one.
 */
export function chooseOcrLanguage(streamLanguage: string | undefined, installed: readonly string[], last?: string | null): OcrLanguageChoice {
  const guess = guessOcrLanguage(streamLanguage);
  const has = (c: string | null | undefined): c is string => !!c && installed.includes(c);
  const code = has(guess) ? guess : has(last) ? last : installed[0] ?? null;
  return { code, guess, offerInstall: !!guess && !has(guess) };
}

/** Track name: "English (OCR #3)". */
export function ocrTrackName(code: string, streamIndex: number): string {
  return `${ocrLanguage(code)?.name ?? code} (OCR #${streamIndex})`;
}

/** The end of an OCR job title: "#3 (English)", "#3 (Chinese (Simplified))". */
export const OCR_TITLE_TAIL = /#(\d+) \((?:[^()]|\([^()]*\))*\)$/;

/** Stream index from an OCR job title ("Read subtitles with OCR: film.mkv #3 (English)"), or null. */
export function ocrJobStream(job: Pick<JobInfo, 'title'>): number | null {
  const m = OCR_TITLE_TAIL.exec(job.title);
  return m ? Number(m[1]) : null;
}

/** The queued / running OCR job reading `streamIndex` of `mediaId`, if any. */
export function activeOcrJob(jobs: readonly JobInfo[], mediaId: ID, streamIndex: number): JobInfo | undefined {
  return jobs.find((j) => j.kind === 'ocr' && (j.status === 'queued' || j.status === 'running') && j.mediaId === mediaId && ocrJobStream(j) === streamIndex);
}
