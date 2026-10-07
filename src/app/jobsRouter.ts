/**
 * Routes main-process job results into the project store:
 *  - proxy: queued/running/ready/failed → media.proxy (+ media element invalidation when ready)
 *  - sceneDetect: done → detected scenes; failed → status
 *  - export: toasts
 *  - download (OCR language installs): toasts + refresh of the OCR language list (src/state/ocrStatus.ts)
 *  - ocr: done → the OCR subtitle track of that media + stream (added, or the earlier one replaced); toasts
 *  - transcribe: done → the Whisper subtitle track of that media + audio stream + language (added, or replaced); toasts
 *  - download of a Whisper model: toasts + refresh of the model list (src/state/whisperStatus.ts)
 * This is the ONLY job→project mirror (jobsStore → store): each terminal result is applied once (by job id) and
 * every write is additionally guarded by the media's current state, so results survive a project reload without
 * double-applying. Jobs are also mirrored into store.jobs so panels may read either store consistently.
 *
 * Note: status writes are quiet (not undoable) but per-tick progress is still NOT written to the store (only
 * status transitions); live progress is read from jobsStore by the UI.
 */
import type { JobInfo } from '@shared/model';
import type { SceneDetectResult } from '@shared/ipc';
import { useStore } from '@/state/store';
import { useJobsStore } from './jobsStore';
import { invalidateMediaPath } from './media';
import { requeueStaleProxy } from '@/state/mediaActions';
import { toast } from '@/components/ui/toastStore';
import { useOcrStatus } from '@/state/ocrStatus';
import { OCR_TITLE_TAIL, ocrTrackName } from '@/ocr/ocrUi';
import { iso6392ForOcr, ocrLanguage, type OcrResult } from '@shared/ocr';
import { uid } from '@shared/ids';
import { useWhisperStatus } from '@/state/whisperStatus';
import { isWhisperDownload, whisperDownloadName } from '@/whisper/whisperUi';
import { whisperLanguage, whisperModel, whisperTrackName, type TranscribeResult } from '@shared/whisper';

interface ProxyResultLike { path: string; width?: number; height?: number; cached?: boolean; audioStreams?: number[] }
interface ExportResultLike { outputPath?: string; sidecarPath?: string; warnings?: string[] }

const handled = new Set<string>();
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const isTerminal = (j: JobInfo) => j.status === 'done' || j.status === 'failed' || j.status === 'canceled';

/** Claim a terminal job id; false when it was already applied. */
function claim(job: JobInfo): boolean {
  if (handled.has(job.id)) return false;
  handled.add(job.id);
  return true;
}

function routeProxy(job: JobInfo): void {
  const st = useStore.getState();
  const media = job.mediaId ? st.project.media[job.mediaId] : undefined;
  if (!media) return;
  switch (job.status) {
    case 'queued':
      if (media.proxy.status === 'none' || media.proxy.status === 'failed') st.setProxy(media.id, { status: 'queued', progress: 0 });
      break;
    case 'running':
      if (media.proxy.status !== 'running') st.setProxy(media.id, { status: 'running', progress: job.progress || 0 });
      break;
    case 'done': {
      if (!claim(job)) return;
      const r = (job.result ?? null) as ProxyResultLike | null;
      if (!r?.path) { if (media.proxy.status !== 'failed') st.setProxy(media.id, { status: 'failed', error: 'Proxy job finished without a result' }); return; }
      if (media.proxy.status === 'ready' && media.proxy.path === r.path) return; // already applied by another mirror
      // Drop stale elements BEFORE the store change: setProxy synchronously re-renders the paused Program frame, which
      // acquires a fresh element for the proxy path; invalidating afterwards disposed that element (BUG-6).
      invalidateMediaPath(media.path);
      invalidateMediaPath(r.path);
      // Record the streams the proxy carries: a fallback proxy lacks the ones FFmpeg could not decode or encode.
      st.setProxy(media.id, { status: 'ready', path: r.path, progress: 1, width: r.width, height: r.height, ...(Array.isArray(r.audioStreams) ? { audioStreams: [...r.audioStreams] } : {}) });
      // The media's audio stream changed while this proxy was being built: it carries the old track.
      if (requeueStaleProxy(media.id)) break;
      if (!r.cached) toast('ok', `Proxy ready: ${media.name}`);
      break;
    }
    case 'failed':
      if (!claim(job)) return;
      if (media.proxy.status === 'failed' && media.proxy.error === (job.error ?? 'Proxy failed')) return;
      st.setProxy(media.id, { status: 'failed', error: job.error ?? 'Proxy failed' });
      toast('error', `Proxy failed for ${media.name}: ${job.error ?? 'unknown error'}`);
      break;
    case 'canceled':
      if (!claim(job)) return;
      if (media.proxy.status === 'queued' || media.proxy.status === 'running') st.setProxy(media.id, { status: 'none' });
      break;
  }
}

function routeSceneDetect(job: JobInfo): void {
  const st = useStore.getState();
  const media = job.mediaId ? st.project.media[job.mediaId] : undefined;
  if (!media) return;
  switch (job.status) {
    case 'queued':
    case 'running':
      if (media.sceneDetectStatus !== 'running') st.setSceneDetectStatus(media.id, 'running');
      break;
    case 'done': {
      if (!claim(job)) return;
      const r = (job.result ?? null) as SceneDetectResult | null;
      if (!r || !Array.isArray(r.boundaries)) {
        if (media.sceneDetectStatus !== 'failed') { st.setSceneDetectStatus(media.id, 'failed'); toast('error', `Scene detection returned no result for ${media.name}`); }
        return;
      }
      if (media.sceneDetectStatus === 'done' && media.detectedScenes.length > 0) return; // already applied
      st.setDetectedScenes(media.id, r.boundaries, r.duration > 0 ? r.duration : media.probe?.duration ?? 0);
      toast('ok', `${r.boundaries.length} cut${r.boundaries.length === 1 ? '' : 's'} detected in ${media.name}`);
      break;
    }
    case 'failed':
      if (!claim(job)) return;
      if (media.sceneDetectStatus === 'failed') return;
      st.setSceneDetectStatus(media.id, 'failed');
      toast('error', `Scene detection failed for ${media.name}: ${job.error ?? 'unknown error'}`);
      break;
    case 'canceled':
      if (!claim(job)) return;
      if (media.sceneDetectStatus === 'running') st.setSceneDetectStatus(media.id, media.detectedScenes.length ? 'done' : 'none');
      break;
  }
}

function routeExport(job: JobInfo): void {
  if (!isTerminal(job) || !claim(job)) return;
  const r = (job.result ?? null) as ExportResultLike | null;
  if (job.status === 'done') {
    const out = r?.outputPath;
    toast('ok', out ? `Export finished: ${baseName(out)}` : 'Export finished', 8000);
    if (r?.warnings?.length) toast('warn', `Export warnings: ${r.warnings[0]}${r.warnings.length > 1 ? ` (+${r.warnings.length - 1})` : ''}`);
  } else if (job.status === 'failed') {
    toast('error', `Export failed: ${job.error ?? 'unknown error'}`);
  } else {
    toast('info', 'Export canceled');
  }
}

/** "English" from a download job titled "Install English OCR data (4.1 MB)"; the title itself otherwise. */
function downloadName(job: JobInfo): string {
  return /^Install (.+) OCR data\b/.exec(job.title)?.[1] ?? job.title;
}

function routeDownload(job: JobInfo): void {
  if (!isTerminal(job) || !claim(job)) return;
  if (isWhisperDownload(job)) {
    const model = whisperDownloadName(job);
    if (job.status === 'done') toast('ok', `${model} transcription model installed`);
    else if (job.status === 'failed') toast('error', `Could not install the ${model} transcription model: ${job.error ?? 'unknown error'}`);
    else toast('info', `${model} model download canceled`);
    void useWhisperStatus.getState().refresh();
    return;
  }
  const name = downloadName(job);
  if (job.status === 'done') toast('ok', `${name} OCR language installed`);
  else if (job.status === 'failed') toast('error', `Could not install ${name} OCR data: ${job.error ?? 'unknown error'}`);
  else toast('info', `${name} OCR download canceled`);
  void useOcrStatus.getState().refresh();
}

/** "#3 (English)" from an OCR job title ("Read subtitles with OCR: film.mkv #3 (English)"); the title otherwise. */
function ocrJobLabel(job: JobInfo): string {
  return OCR_TITLE_TAIL.exec(job.title)?.[0] ?? job.title;
}

function isOcrResult(r: unknown): r is OcrResult {
  if (!r || typeof r !== 'object') return false;
  const o = r as Partial<OcrResult>;
  return Array.isArray(o.cues) && typeof o.language === 'string' && Number.isInteger(o.streamIndex);
}

function routeOcr(job: JobInfo): void {
  if (!isTerminal(job) || !claim(job)) return;
  const st = useStore.getState();
  const media = job.mediaId ? st.project.media[job.mediaId] : undefined;
  if (job.status === 'failed') { toast('error', `OCR failed for ${media?.name ?? 'media'} ${ocrJobLabel(job)}: ${job.error ?? 'unknown error'}`); return; }
  if (job.status === 'canceled') { toast('info', `OCR canceled (${ocrJobLabel(job)})`); return; }
  const r = job.result;
  if (!isOcrResult(r)) { toast('error', `OCR returned no result (${ocrJobLabel(job)})`); return; }
  const name = ocrLanguage(r.language)?.name ?? r.language;
  const where = `#${r.streamIndex} (${name})`;
  if (!media) { toast('warn', `OCR of ${where} finished, but its media is no longer in the project`); return; }
  if (r.cues.length === 0) { toast('warn', `No subtitle text read from ${media.name} ${where}`); return; }
  const stream = media.probe?.subtitles.find((s) => s.index === r.streamIndex);
  st.putOcrSubtitleTrack({
    id: uid('sub'),
    name: ocrTrackName(r.language, r.streamIndex),
    language: stream?.language && stream.language !== 'und' ? stream.language : iso6392ForOcr(r.language),
    mediaId: media.id,
    cues: r.cues.map((c) => ({ ...c })),
    origin: 'ocr',
    streamIndex: r.streamIndex,
  });
  const n = r.cues.length;
  toast('ok', `${n} subtitle line${n === 1 ? '' : 's'} read from ${where}${r.cached ? ' (from cache)' : ''}`);
}

function isTranscribeResult(r: unknown): r is TranscribeResult {
  if (!r || typeof r !== 'object') return false;
  const o = r as Partial<TranscribeResult>;
  return Array.isArray(o.cues) && typeof o.language === 'string' && typeof o.model === 'string' && Number.isInteger(o.streamIndex);
}

function routeTranscribe(job: JobInfo): void {
  if (!isTerminal(job) || !claim(job)) return;
  const st = useStore.getState();
  const media = job.mediaId ? st.project.media[job.mediaId] : undefined;
  const label = media?.name ?? 'media';
  if (job.status === 'failed') { toast('error', `Transcription of ${label} failed: ${job.error ?? 'unknown error'}`); return; }
  if (job.status === 'canceled') { toast('info', `Transcription of ${label} canceled`); return; }
  const r = job.result;
  if (!isTranscribeResult(r)) { toast('error', `Transcription of ${label} returned no result`); return; }
  if (!media) { toast('warn', `Transcription finished, but its media is no longer in the project`); return; }
  if (r.cues.length === 0) { toast('warn', `No speech recognized in ${media.name}`); return; }
  const several = (media.probe?.audio.length ?? 0) > 1;
  const modelName = whisperModel(r.model)?.name ?? useWhisperStatus.getState().models?.find((x) => x.id === r.model)?.name ?? r.model;
  st.putWhisperSubtitleTrack({
    id: uid('sub'),
    name: whisperTrackName(r.language, modelName, r.translate, several ? r.streamIndex : undefined),
    language: whisperLanguage(r.language)?.iso6392 ?? 'und',
    mediaId: media.id,
    cues: r.cues.map((c) => ({ ...c })),
    origin: 'whisper',
    streamIndex: r.streamIndex,
  });
  const n = r.cues.length;
  toast('ok', `${n} line${n === 1 ? '' : 's'} transcribed from ${media.name} (Whisper ${modelName})${r.cached ? ' (from cache)' : ''}`);
}

/** Reveal an exported file in the OS file manager (for UI that renders export results). */
export function revealExport(path: string): void { void window.recut?.showItemInFolder?.(path).catch(() => { /* ignore */ }); }

/** Apply a job list to the store (exported for tests). */
export function routeJobs(jobs: JobInfo[]): void {
  useStore.getState().setJobs(jobs);
  for (const job of jobs) {
    try {
      if (job.kind === 'proxy') routeProxy(job);
      else if (job.kind === 'sceneDetect') routeSceneDetect(job);
      else if (job.kind === 'export') routeExport(job);
      else if (job.kind === 'download') routeDownload(job);
      else if (job.kind === 'ocr') routeOcr(job);
      else if (job.kind === 'transcribe') routeTranscribe(job);
    } catch (e) {
      console.error('[jobsRouter] failed to route job', job.id, e);
    }
  }
  // Forget ids that left the main-process list so a cleared queue cannot grow the set unbounded.
  if (handled.size > 1000) { const alive = new Set(jobs.map((j) => j.id)); for (const id of handled) if (!alive.has(id)) handled.delete(id); }
}

/** Mark terminal jobs as already handled (e.g. after loading a project whose media reflects them). */
export function markJobsHandled(jobs: JobInfo[]): void { for (const j of jobs) if (isTerminal(j)) handled.add(j.id); }

export function resetJobsRouter(): void { handled.clear(); }

let unsubscribe: (() => void) | null = null;

/** Subscribe to the jobs mirror. Idempotent; returns a dispose function. */
export function initJobsRouter(): () => void {
  if (unsubscribe) return unsubscribe;
  routeJobs(useJobsStore.getState().jobs);
  const off = useJobsStore.subscribe((s, prev) => { if (s.jobs !== prev.jobs) routeJobs(s.jobs); });
  unsubscribe = () => { off(); unsubscribe = null; };
  return unsubscribe;
}
