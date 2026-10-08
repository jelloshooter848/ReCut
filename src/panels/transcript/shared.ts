/**
 * Store glue shared by the Transcript panel tabs: memoized index, timecode helpers and the source/insert actions.
 */
import { useMemo } from 'react';
import type { ID, MediaItem, Rational } from '../../../shared/model';
import { formatSourceTimecode, validFpsOr } from '../../../shared/time';
import { performSourceEdit } from '@/panels/source/insert';
import { useStore, importSubtitleFile, importEmbeddedSubtitles, recutApi } from '@/state';
import { toast, dismissToast } from '@/components/ui';
import { buildTranscriptIndex, type TranscriptIndex } from '@/transcript/index';
import { getProviders, SubtitleFileProvider, type TranscriptProvider } from '@/transcript/providers';
import { uid } from '../../../shared/ids';
import { fileNameOf } from '@/state/selectors';
import { ocrStream, openOcrDialog } from '@/ocr/ocrUi';

const DEFAULT_FPS: Rational = { num: 24000, den: 1001 };

/** Index memoized on the subtitle-track and media maps (new object whenever either changes). */
export function useTranscriptIndex(): TranscriptIndex {
  const subtitleTracks = useStore((s) => s.project.subtitleTracks);
  const media = useStore((s) => s.project.media);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => buildTranscriptIndex(useStore.getState().project), [subtitleTracks, media]);
}

/** Frame rate used to display a media item's source timecodes (`fallback` when the probed rate is unknown / unusable). */
export function mediaFps(media: MediaItem | undefined, fallback?: Rational): Rational {
  return validFpsOr(media?.probe?.video?.fps, validFpsOr(fallback, DEFAULT_FPS));
}

/** Source timecode of `seconds` into `media`, from its embedded start timecode when it has one. */
export function sourceTimecode(seconds: number, media: MediaItem | undefined, fallback?: Rational): string {
  return formatSourceTimecode(seconds, mediaFps(media, fallback), media?.probe?.startTimecode);
}

/** Load a media range in the Source monitor: cue the clip, mark in/out and focus the Source panel. */
export function loadInSource(mediaId: ID, inS: number, outS: number, opts: { focus?: boolean } = {}): void {
  const st = useStore.getState();
  if (!st.project.media[mediaId]) return;
  st.setSourceClip(mediaId, inS);
  st.setSourceIn(inS);
  st.setSourceOut(outS);
  if (opts.focus !== false) st.setActivePanel('source');
}

/**
 * Insert a source range into the active sequence at the playhead, through the shared Source edit path
 * (performSourceEdit: conform-to-clip prompt, three-point rules with the sequence In/Out, playhead to the end).
 * Returns the created clip ids ([] when nothing was inserted, or while a conform prompt is still open).
 */
export function insertAtPlayhead(mediaId: ID, inS: number, outS: number, originLabel = 'transcript'): ID[] {
  const st = useStore.getState();
  const seqId = st.project.activeSequenceId;
  if (!seqId || !st.project.sequences[seqId]) { toast.warn('No active sequence to insert into'); return []; }
  if (outS - inS <= 0) { toast.warn('Nothing to insert: empty range'); return []; }
  const res = performSourceEdit({ mode: 'insert', mediaId, srcIn: inS, srcOut: outS, extra: { originLabel } }, seqId);
  return res.clipIds;
}

/** Media the subtitle toolbar acts on: the Source clip, else the first selected media item. */
export function targetMediaId(): ID | null {
  const st = useStore.getState();
  return st.ui.sourceClip?.mediaId ?? st.ui.selectedMediaIds[0] ?? null;
}

function reportImport(res: { trackId: ID | null; warnings: string[] }, what: string): void {
  if (res.trackId) {
    const n = useStore.getState().project.subtitleTracks[res.trackId]?.cues.length ?? 0;
    toast.ok(`Imported ${n} cue${n === 1 ? '' : 's'} from ${what}`);
    if (res.warnings.length) toast.warn(`${res.warnings.length} warning${res.warnings.length === 1 ? '' : 's'}: ${res.warnings.slice(0, 2).join('; ')}${res.warnings.length > 2 ? '…' : ''}`);
  } else {
    toast.error(`Could not import ${what}: ${res.warnings[0] ?? 'no cues found'}`);
  }
}

/** File dialog → importSubtitleFile for the target media. */
export async function importSubtitlesDialog(mediaId: ID | null = targetMediaId()): Promise<void> {
  const api = recutApi();
  if (!api) { toast.error('File dialogs need the Electron bridge'); return; }
  if (!mediaId) { toast.warn('Load a clip in the Source monitor or select a media item first'); return; }
  const media = useStore.getState().project.media[mediaId];
  const paths = await api.openFiles({ title: `Import subtitles for ${media?.name ?? 'media'}`, multi: false, filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }, { name: 'All files', extensions: ['*'] }] });
  const path = paths?.[0];
  if (!path) return;
  try {
    const res = await importSubtitleFile(mediaId, path);
    reportImport(res, fileNameOf(path));
  } catch (e) {
    toast.error(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Extract an embedded text stream; a bitmap stream (PGS, VobSub, DVB, XSUB) opens the Read with OCR dialog instead. */
export async function importEmbedded(mediaId: ID, streamIndex: number): Promise<void> {
  if (ocrStream(useStore.getState().project.media[mediaId], streamIndex)) { openOcrDialog({ mediaId, streamIndex }); return; }
  try {
    const res = await importEmbeddedSubtitles(mediaId, streamIndex);
    reportImport(res, `embedded stream #${streamIndex}`);
  } catch (e) {
    toast.error(`Extraction failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Run a transcript provider for a media item and attach the result as a subtitle track. For the subtitle-file
 * provider the sidecar it reads is located first and recorded as the track's `path`, so exports never
 * overwrite it (projectSourcePaths).
 */
export async function transcribeWith(provider: TranscriptProvider, mediaId: ID): Promise<void> {
  const st = useStore.getState();
  const media = st.project.media[mediaId];
  if (!media) return;
  if (provider.openDialog) {
    // Runs as a main-process job (Local Whisper): the dialog starts it, the jobs router attaches the result. Every
    // selected media is offered, the target first.
    const ids = [mediaId, ...st.ui.selectedMediaIds.filter((id) => id !== mediaId)];
    provider.openDialog(ids);
    return;
  }
  const id = toast('info', `${provider.name}: transcribing ${media.name}…`, 0);
  try {
    const sourcePath = provider instanceof SubtitleFileProvider ? await provider.findSidecar(media.path) : null;
    const cues = await provider.transcribe(media.path, sourcePath ? { subtitlePath: sourcePath } : {}, () => { /* progress could drive a job row */ });
    st.addMediaSubtitleTrack({ id: uid('sub'), name: provider.name, language: 'und', mediaId, cues, origin: provider.id, ...(sourcePath ? { path: sourcePath } : {}) });
    toast.ok(`${provider.name}: ${cues.length} cues added to ${media.name}`);
  } catch (e) {
    toast.error(`${provider.name}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    dismissToast(id);
  }
}

export { getProviders };
