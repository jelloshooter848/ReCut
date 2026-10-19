/**
 * Whisper in the renderer: the dialog helpers (src/whisper/whisperUi.ts), the Local Whisper provider, the jobs router
 * (a finished 'transcribe' job becomes an origin 'whisper' track; a re-run replaces it in one undo step; model
 * downloads refresh the model list) and the status store's summaries.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioStreamInfo, JobInfo, MediaItem, MediaProbe } from '../../shared/model';
import type { TranscribeResult, WhisperModelState } from '../../shared/whisper';
import { createMediaItem } from '../../shared/project';
import { useStore, resetStore } from '../../src/state/store';
import { routeJobs, resetJobsRouter } from '../../src/app/jobsRouter';
import { getToasts } from '../../src/components/ui/toastStore';
import {
  activeTranscribeJob, audioStreamLabel, chooseWhisperModel, closeTranscribeDialog, defaultAudioStream, defaultSpokenLanguage,
  isWhisperDownload, openTranscribeDialog, transcribeJobStream, transcribeUnavailableReason, useWhisperUi, whisperDownloadName,
} from '../../src/whisper/whisperUi';
import { installedModelsSummary, modelsDiskUsage, useWhisperStatus } from '../../src/state/whisperStatus';
import { getProvider } from '../../src/transcript/providers';
import { transcribeWith } from '../../src/panels/transcript/shared';
import { mediaMenu } from '../../src/panels/project/menus';

const g = globalThis as unknown as { window?: unknown };
if (!g.window) g.window = globalThis;

const S = () => useStore.getState();
const lastToast = () => getToasts().at(-1);

const AUDIO: AudioStreamInfo[] = [
  { index: 1, codec: 'ac3', channels: 6, layout: '5.1(side)', sampleRate: 48000, language: 'fre' },
  { index: 2, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000, language: 'eng', title: 'Commentary' },
];

function mediaWith(audio: AudioStreamInfo[], name = 'film.mkv'): MediaItem {
  const m = createMediaItem(`/media/${name}`, name);
  m.kind = 'video';
  m.probe = { duration: 60, audio, subtitles: [] } as unknown as MediaProbe;
  return m;
}

function job(patch: Partial<JobInfo> & { result?: Partial<TranscribeResult> }, mediaId: string): JobInfo {
  const { result, ...rest } = patch;
  return {
    id: 't1', kind: 'transcribe', title: 'Transcribe film.mkv #1 (Whisper Small)', status: 'done', progress: 1, mediaId,
    ...(result ? { result: { mediaId, streamIndex: 1, model: 'small', language: 'fr', spokenLanguage: 'fr', translate: false, cues: [], duration: 60, cached: false, ...result } } : {}),
    ...rest,
  };
}
const cues = (...texts: string[]) => texts.map((text, i) => ({ id: `c${i}`, start: i * 2, end: i * 2 + 1, text }));
const models = (...installed: string[]): WhisperModelState[] => ['tiny', 'base', 'small', 'medium'].map((id) => ({
  id, name: id[0].toUpperCase() + id.slice(1), bytes: 100e6, englishOnly: false, note: '', installed: installed.includes(id), partialBytes: id === 'medium' ? 5e6 : 0,
}));

beforeEach(() => {
  resetStore();
  resetJobsRouter();
  closeTranscribeDialog();
  (window as unknown as { recut: unknown }).recut = undefined;
  useWhisperStatus.setState({ models: null, engine: null, error: null });
});

describe('dialog helpers', () => {
  it('picks the preferred audio stream and the spoken language from its tag', () => {
    const m = mediaWith(AUDIO);
    expect(defaultAudioStream(m)?.index).toBe(1);
    expect(defaultAudioStream({ ...m, preferredAudioStream: 2 })?.index).toBe(2);
    expect(defaultSpokenLanguage(AUDIO[0])).toBe('fr');
    expect(defaultSpokenLanguage({ ...AUDIO[0], language: 'und' })).toBe('auto');
    expect(defaultSpokenLanguage(undefined)).toBe('auto');
    expect(audioStreamLabel(AUDIO[1])).toBe('#2 eng stereo (aac) — Commentary');
  });

  it('says why media cannot be transcribed', () => {
    const m = mediaWith(AUDIO);
    expect(transcribeUnavailableReason(m)).toBeNull();
    expect(transcribeUnavailableReason({ ...m, offline: true })).toBe('offline');
    expect(transcribeUnavailableReason({ ...m, probe: undefined })).toBe('not probed yet');
    expect(transcribeUnavailableReason(mediaWith([]))).toBe('no audio');
    expect(transcribeUnavailableReason(undefined)).toBe('not in the project');
  });

  it('chooses the last model used while installed, else Small, else the first installed', () => {
    expect(chooseWhisperModel(models('base', 'small'), 'base')).toBe('base');
    expect(chooseWhisperModel(models('base', 'small'), 'medium')).toBe('small');
    expect(chooseWhisperModel(models('tiny', 'base'), null)).toBe('tiny');
    expect(chooseWhisperModel(models(), 'small')).toBeNull();
    expect(chooseWhisperModel(null)).toBeNull();
  });

  it('reads job titles', () => {
    expect(isWhisperDownload({ kind: 'download', title: 'Install Whisper model Small (488 MB)' })).toBe(true);
    expect(isWhisperDownload({ kind: 'download', title: 'Install English OCR data (4.1 MB)' })).toBe(false);
    expect(whisperDownloadName({ title: 'Install Whisper model Large v3 Turbo (1.6 GB)' })).toBe('Large v3 Turbo');
    expect(transcribeJobStream({ title: 'Transcribe a #1 (x).mkv #3 (Whisper Small, to English)' })).toBe(3);
    const jobs: JobInfo[] = [
      { id: 'a', kind: 'transcribe', title: 'Transcribe f.mkv #1 (Whisper Small)', status: 'done', progress: 1, mediaId: 'm' },
      { id: 'b', kind: 'transcribe', title: 'Transcribe f.mkv #2 (Whisper Small)', status: 'running', progress: 0.5, mediaId: 'm' },
    ];
    expect(activeTranscribeJob(jobs, 'm', 2)?.id).toBe('b');
    expect(activeTranscribeJob(jobs, 'm', 1)).toBeUndefined();
    expect(activeTranscribeJob(jobs, 'm')?.id).toBe('b');
  });

  it('summarizes installed models and disk usage (partial downloads included)', () => {
    expect(installedModelsSummary(models('base', 'small'))).toBe('Base, Small (200 MB)');
    expect(installedModelsSummary(models())).toBe('None');
    expect(modelsDiskUsage(models('base'))).toBe(105e6);
  });
});

describe('Local Whisper provider and menus', () => {
  it('is available when the engine runs, and opens the Transcribe dialog instead of transcribing in the renderer', async () => {
    const p = getProvider('whisper-local')!;
    expect(await p.available()).toBe(false);
    expect(await p.unavailableReason!()).toBe('needs the desktop app');
    const whisperEngine = vi.fn().mockResolvedValue({ path: '/x/whisper-cli', version: '1.9.5', modelsDir: '/u/whisper/models' });
    (window as unknown as { recut: unknown }).recut = { whisperEngine };
    expect(await p.available()).toBe(true);
    whisperEngine.mockResolvedValue({ path: null, version: null, modelsDir: '/u', error: 'missing' });
    expect(await p.available()).toBe(false);
    expect(await p.unavailableReason!()).toBe('engine not included in this build');

    const a = mediaWith(AUDIO, 'a.mkv');
    const b = mediaWith(AUDIO, 'b.mkv');
    S().addMedia([a, b]);
    S().selectMedia?.([a.id, b.id]);
    await transcribeWith(p, b.id);
    expect(useWhisperUi.getState().transcribeFor?.[0]).toBe(b.id);
    closeTranscribeDialog();
  });

  it('the project media menu offers Transcribe with Whisper… for the selection', () => {
    const a = mediaWith(AUDIO, 'a.mkv');
    const silent = mediaWith([], 'silent.mkv');
    S().addMedia([a, silent]);
    const env = { selectedMedia: [a.id], selectedShots: [], openPanelDialog: () => undefined, startRename: () => undefined, expandScenes: () => undefined, newBin: () => undefined };
    const item = mediaMenu(a, env).find((i) => i.label === 'Transcribe with Whisper…')!;
    expect(item.disabled).toBe(false);
    item.onSelect!();
    expect(useWhisperUi.getState().transcribeFor).toEqual([a.id]);
    expect(mediaMenu(silent, { ...env, selectedMedia: [silent.id] }).find((i) => i.label === 'Transcribe with Whisper…')!.disabled).toBe(true);
    openTranscribeDialog([]);
  });
});

describe('jobs router: transcribe jobs', () => {
  it('adds the Whisper track, then a re-run (bigger model) replaces it in one undo step', () => {
    const m = mediaWith(AUDIO);
    S().addMedia([m]);
    routeJobs([job({ status: 'running', progress: 0.4 }, m.id)]);
    expect(Object.keys(S().project.subtitleTracks)).toHaveLength(0);
    routeJobs([job({ result: { cues: cues('Bonjour', 'Merci') } }, m.id)]);
    const [t] = Object.values(S().project.subtitleTracks);
    expect(t).toMatchObject({ name: 'French (Whisper Small, #1)', language: 'fre', origin: 'whisper', streamIndex: 1, mediaId: m.id });
    expect(t.cues.map((c) => c.text)).toEqual(['Bonjour', 'Merci']);
    expect(S().project.media[m.id].subtitleTrackIds).toEqual([t.id]);
    expect(lastToast()?.text).toBe('2 lines transcribed from film.mkv (Whisper Small)');

    // The same job again (a project reload re-delivers the list) is not applied twice.
    routeJobs([job({ result: { cues: cues('Bonjour', 'Merci') } }, m.id)]);
    expect(Object.keys(S().project.subtitleTracks)).toHaveLength(1);

    routeJobs([job({ id: 't2', title: 'Transcribe film.mkv #1 (Whisper Medium)', result: { model: 'medium', cues: cues('Bonjour !'), cached: true } }, m.id)]);
    const tracks = Object.values(S().project.subtitleTracks);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].id).toBe(t.id);
    expect(tracks[0].name).toBe('French (Whisper Medium, #1)');
    expect(tracks[0].cues.map((c) => c.text)).toEqual(['Bonjour !']);
    expect(lastToast()?.text).toMatch(/\(from cache\)$/);
    S().undo();
    expect(Object.values(S().project.subtitleTracks)[0].cues.map((c) => c.text)).toEqual(['Bonjour', 'Merci']);
  });

  it('a translation and another audio stream are separate tracks', () => {
    const m = mediaWith(AUDIO);
    S().addMedia([m]);
    routeJobs([job({ id: 'a', result: { cues: cues('Bonjour') } }, m.id)]);
    routeJobs([job({ id: 'b', result: { cues: cues('Hello'), translate: true, language: 'en' } }, m.id)]);
    routeJobs([job({ id: 'c', result: { cues: cues('Commentary'), streamIndex: 2, language: 'en', spokenLanguage: 'en' } }, m.id)]);
    expect(Object.values(S().project.subtitleTracks).map((t) => t.name).sort()).toEqual([
      'English (Whisper Small, #2)', 'English (Whisper Small, translated, #1)', 'French (Whisper Small, #1)',
    ]);
  });

  it('reports no speech, a removed media, failures and cancels', () => {
    const m = mediaWith([AUDIO[0]]);
    S().addMedia([m]);
    routeJobs([job({ id: 'z', result: { cues: [] } }, m.id)]);
    expect(lastToast()?.text).toBe('No speech recognized in film.mkv');
    routeJobs([job({ id: 'g', result: { cues: cues('x') } }, 'missing')]);
    expect(lastToast()?.text).toMatch(/no longer in the project/);
    routeJobs([job({ id: 'f', status: 'failed', error: 'The Small Whisper model is damaged.' }, m.id)]);
    expect(lastToast()?.text).toBe('Transcription of film.mkv failed: The Small Whisper model is damaged.');
    routeJobs([job({ id: 'k', status: 'canceled' }, m.id)]);
    expect(lastToast()?.text).toBe('Transcription of film.mkv canceled');
    routeJobs([job({ id: 'one', result: { cues: cues('Salut') } }, m.id)]);
    expect(Object.values(S().project.subtitleTracks)[0].name).toBe('French (Whisper Small)');
  });

  it('a finished model download refreshes the model list; an OCR download does not', async () => {
    const whisperModels = vi.fn().mockResolvedValue(models('small'));
    const whisperEngine = vi.fn().mockResolvedValue({ path: '/x', version: '1.9.5', modelsDir: '/m' });
    (window as unknown as { recut: unknown }).recut = { whisperModels, whisperEngine };
    routeJobs([{ id: 'd1', kind: 'download', title: 'Install Whisper model Small (488 MB)', status: 'done', progress: 1 }]);
    expect(lastToast()?.text).toBe('Small transcription model installed');
    await vi.waitFor(() => expect(useWhisperStatus.getState().models?.find((x) => x.id === 'small')?.installed).toBe(true));
    routeJobs([{ id: 'd2', kind: 'download', title: 'Install Whisper model Medium (1.5 GB)', status: 'failed', progress: 0, error: 'checksum mismatch' }]);
    expect(lastToast()?.text).toBe('Could not install the Medium transcription model: checksum mismatch');
    expect(whisperModels).toHaveBeenCalledTimes(2);
  });
});

// ------------------------------------------------------------------ #110: model downloads from the Transcribe dialog
import {
  activeWhisperDownloads, downloadProgressLabel, finishModelsInBackground, openWhisperModels, resumeTranscribe,
} from '../../src/whisper/whisperUi';
import { dismissToast, runToastAction, toast } from '../../src/components/ui/toastStore';

describe('toasts with an action (#110)', () => {
  it('the action runs once and dismisses the toast; timeout 0 keeps it; plain toasts are unchanged', () => {
    for (const t of getToasts()) dismissToast(t.id);
    const run = vi.fn();
    vi.useFakeTimers();
    try {
      const id = toast('ok', 'Model installed', 0, { label: 'Transcribe…', run });
      const plain = toast('info', 'Plain');
      expect(getToasts().find((t) => t.id === plain)?.action).toBeUndefined();
      vi.advanceTimersByTime(60_000);
      expect(getToasts().map((t) => t.id)).toEqual([id]); // the plain one timed out, the sticky one stays
      runToastAction(id);
      runToastAction(id);
      expect(run).toHaveBeenCalledTimes(1);
      expect(getToasts()).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});

describe('Finish in background (#110)', () => {
  const dl = (status: JobInfo['status'], progress = 0.15): JobInfo => ({ id: `d${status}`, kind: 'download', title: 'Install Whisper model Large v3 Turbo (1.6 GB)', status, progress });
  beforeEach(() => useWhisperUi.setState({ transcribeFor: null, modelsOpen: false, focusModel: null, modelsFromTranscribe: false, draft: null, restore: null }));

  it('active downloads and their label', () => {
    const jobs = [dl('done'), dl('running'), { ...dl('running'), id: 'x', kind: 'export' as const }];
    expect(activeWhisperDownloads(jobs).map((j) => j.id)).toEqual(['drunning']);
    expect(downloadProgressLabel(dl('running'))).toBe('Large v3 Turbo 15%');
    expect(downloadProgressLabel(dl('queued'))).toBe('Large v3 Turbo (queued)');
  });

  it('opened from the Transcribe dialog it closes both and keeps the choices; resumeTranscribe brings them back', () => {
    openTranscribeDialog(['m1']);
    const draft = { openFor: ['m1'], checked: ['m1'], streams: { m1: 2 }, language: 'fr', languageTouched: true, translate: true, force: false };
    useWhisperUi.setState({ draft });
    openWhisperModels('small', { fromTranscribe: true });
    finishModelsInBackground();
    expect(useWhisperUi.getState()).toMatchObject({ modelsOpen: false, transcribeFor: null, draft });
    resumeTranscribe('large-v3-turbo');
    expect(useWhisperUi.getState()).toMatchObject({ transcribeFor: ['m1'], restore: { model: 'large-v3-turbo' } });
  });

  it('opened from elsewhere it closes only Transcription Models', () => {
    openTranscribeDialog(['m1']);
    openWhisperModels();
    finishModelsInBackground();
    expect(useWhisperUi.getState()).toMatchObject({ modelsOpen: false, transcribeFor: ['m1'] });
  });

  it('the "installed" toast offers Transcribe… only when a Transcribe dialog is waiting for it', () => {
    resetJobsRouter();
    for (const t of getToasts()) dismissToast(t.id);
    useWhisperUi.setState({ draft: { openFor: ['m1'], checked: ['m1'], streams: {}, language: 'auto', languageTouched: false, translate: false, force: false } });
    routeJobs([{ ...dl('done'), id: 'w1' }]);
    const t = getToasts().at(-1)!;
    expect(t.text).toBe('Large v3 Turbo transcription model installed');
    expect(t.action?.label).toBe('Transcribe…');
    expect(t.timeout).toBe(0);
    useWhisperUi.setState({ draft: null });
    routeJobs([{ ...dl('done'), id: 'w2' }]);
    expect(getToasts().at(-1)?.action).toBeUndefined();
  });
});
