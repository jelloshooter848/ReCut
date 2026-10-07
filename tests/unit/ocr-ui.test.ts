/**
 * OCR in the renderer: the menu / dialog helpers (src/ocr/ocrUi.ts), the jobs router's 'ocr' route (an OCR job's
 * result becomes the media's OCR subtitle track) and the embedded-subtitle actions, which open the OCR dialog for
 * bitmap streams instead of trying text extraction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g.window) g.window = globalThis;
});

import type { JobInfo, MediaItem, MediaProbe, SubtitleStreamInfo } from '../../shared/model';
import type { OcrResult } from '../../shared/ocr';
import { createMediaItem } from '../../shared/project';
import { useStore, resetStore } from '../../src/state/store';
import { routeJobs, resetJobsRouter } from '../../src/app/jobsRouter';
import { getToasts } from '../../src/components/ui/toastStore';
import {
  activeOcrJob, chooseOcrLanguage, closeOcrDialog, embeddedStreamEntry, ocrJobStream, ocrStreams, ocrTrackName, ocrUnavailableReason,
  subtitleCodecLabel, useOcrUi,
} from '../../src/ocr/ocrUi';
import { importEmbedded as transcriptImportEmbedded } from '../../src/panels/transcript/shared';
import { importEmbedded as projectImportEmbedded } from '../../src/panels/project/actions';
import { mediaMenu } from '../../src/panels/project/menus';

const S = () => useStore.getState();
const lastToast = () => getToasts().at(-1);

const SUBS: SubtitleStreamInfo[] = [
  { index: 2, codec: 'subrip', language: 'eng', title: 'Commentary' },
  { index: 3, codec: 'hdmv_pgs_subtitle', language: 'fre' },
  { index: 4, codec: 'dvb_teletext', language: 'ger' },
  { index: 5, codec: 'dvd_subtitle' },
];

function mediaWith(subtitles: SubtitleStreamInfo[], name = 'film.mkv'): MediaItem {
  const m = createMediaItem(`/media/${name}`, name);
  m.kind = 'video';
  m.probe = { duration: 60, subtitles } as unknown as MediaProbe;
  return m;
}

function ocrJob(patch: Partial<JobInfo> & { result?: Partial<OcrResult> }, mediaId: string): JobInfo {
  const { result, ...rest } = patch;
  return {
    id: 'o1', kind: 'ocr', title: 'Read subtitles with OCR: film.mkv #3 (French)', status: 'done', progress: 1, mediaId,
    ...(result ? { result: { mediaId, streamIndex: 3, language: 'fra', codec: 'hdmv_pgs_subtitle', cues: [], events: 0, cached: false, ...result } } : {}),
    ...rest,
  };
}

const cues = (...texts: string[]) => texts.map((text, i) => ({ id: `c${i}`, start: i * 2, end: i * 2 + 1, text }));

beforeEach(() => {
  resetStore();
  resetJobsRouter();
  closeOcrDialog();
  (window as unknown as { recut: unknown }).recut = undefined;
});

describe('OCR menu helpers', () => {
  it('labels bitmap streams "Read with OCR…", disables teletext with the reason, keeps text streams', () => {
    expect(SUBS.map(embeddedStreamEntry)).toEqual([
      { label: '#2 eng — Commentary (subrip)', disabled: false, ocr: false },
      { label: '#3 fre (PGS) — Read with OCR…', disabled: false, ocr: true },
      { label: '#4 ger (dvb_teletext) — teletext is not supported', disabled: true, ocr: false },
      { label: '#5 und (DVD) — Read with OCR…', disabled: false, ocr: true },
    ]);
    expect(embeddedStreamEntry({ index: 7, codec: 'arib_caption' }).label).toBe('#7 und (arib_caption) — ARIB captions is not supported');
    expect(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub', 'ass'].map(subtitleCodecLabel)).toEqual(['PGS', 'DVD', 'DVB', 'XSUB', 'ass']);
  });

  it('finds bitmap streams and says why OCR is unavailable', () => {
    const m = mediaWith(SUBS);
    expect(ocrStreams(m).map((s) => s.index)).toEqual([3, 5]);
    expect(ocrUnavailableReason(m)).toBeNull();
    expect(ocrUnavailableReason(undefined)).toBe('no media selected');
    expect(ocrUnavailableReason(mediaWith([SUBS[0]]))).toBe('no bitmap subtitle stream');
    expect(ocrUnavailableReason({ ...m, offline: true })).toBe('media is offline');
    expect(ocrUnavailableReason({ ...m, probe: undefined })).toBe('media not probed yet');
  });

  it('chooses the guessed language when installed, else the last used, else the first installed', () => {
    expect(chooseOcrLanguage('fre', ['eng', 'fra'], 'eng')).toEqual({ code: 'fra', guess: 'fra', offerInstall: false });
    expect(chooseOcrLanguage('fre', ['eng', 'deu'], 'deu')).toEqual({ code: 'deu', guess: 'fra', offerInstall: true });
    expect(chooseOcrLanguage('fre', ['eng', 'deu'], 'spa')).toEqual({ code: 'eng', guess: 'fra', offerInstall: true });
    expect(chooseOcrLanguage(undefined, [], null)).toEqual({ code: null, guess: null, offerInstall: false });
    expect(chooseOcrLanguage('und', ['eng'], undefined)).toEqual({ code: 'eng', guess: null, offerInstall: false });
    expect(chooseOcrLanguage('en', [], undefined)).toEqual({ code: null, guess: 'eng', offerInstall: true });
  });

  it('names tracks and finds the running OCR job of a stream', () => {
    expect(ocrTrackName('eng', 3)).toBe('English (OCR #3)');
    expect(ocrTrackName('chi_sim', 12)).toBe('Chinese (Simplified) (OCR #12)');
    expect(ocrJobStream({ title: 'Read subtitles with OCR: a #1 (b).mkv #3 (Chinese (Simplified))' })).toBe(3);
    expect(ocrJobStream({ title: 'Read subtitles with OCR: film #1.mkv #3 (English)' })).toBe(3);
    const jobs: JobInfo[] = [
      { id: 'a', kind: 'ocr', title: 'Read subtitles with OCR: f.mkv #3 (English)', status: 'done', progress: 1, mediaId: 'm' },
      { id: 'b', kind: 'ocr', title: 'Read subtitles with OCR: f.mkv #4 (English)', status: 'running', progress: 0.5, mediaId: 'm' },
      { id: 'c', kind: 'ocr', title: 'Read subtitles with OCR: f.mkv #3 (French)', status: 'queued', progress: 0, mediaId: 'm' },
    ];
    expect(activeOcrJob(jobs, 'm', 3)?.id).toBe('c');
    expect(activeOcrJob(jobs, 'm', 4)?.id).toBe('b');
    expect(activeOcrJob(jobs, 'other', 4)).toBeUndefined();
    expect(activeOcrJob(jobs, 'm', 5)).toBeUndefined();
  });
});

describe('embedded subtitle actions', () => {
  it('a bitmap stream opens the OCR dialog (Transcript and Project menus); a text stream does not', async () => {
    const m = mediaWith(SUBS);
    S().addMedia([m]);
    await transcriptImportEmbedded(m.id, 3);
    expect(useOcrUi.getState().ocrTarget).toEqual({ mediaId: m.id, streamIndex: 3 });
    closeOcrDialog();
    await projectImportEmbedded(m.id, 5);
    expect(useOcrUi.getState().ocrTarget).toEqual({ mediaId: m.id, streamIndex: 5 });
    closeOcrDialog();
    await projectImportEmbedded(m.id, 2).catch(() => undefined);
    expect(useOcrUi.getState().ocrTarget).toBeNull();
  });

  it('the project media menu lists streams with the OCR labels', () => {
    const m = mediaWith(SUBS);
    S().addMedia([m]);
    const env = { selectedMedia: [m.id], openPanelDialog: () => undefined, startRename: () => undefined, expandScenes: () => undefined, newBin: () => undefined };
    const embedded = mediaMenu(m, env).find((i) => i.label === 'Embedded Subtitles')!;
    expect(embedded.submenu!.map((i) => [i.label, !!i.disabled])).toEqual([
      ['#2 eng — Commentary (subrip)', false], ['#3 fre (PGS) — Read with OCR…', false],
      ['#4 ger (dvb_teletext) — teletext is not supported', true], ['#5 und (DVD) — Read with OCR…', false],
    ]);
    embedded.submenu![1].onSelect!();
    expect(useOcrUi.getState().ocrTarget).toEqual({ mediaId: m.id, streamIndex: 3 });
  });
});

describe('jobs router: ocr jobs', () => {
  it('adds the OCR track (stream language tag kept), then a re-run replaces it; toasts say how many lines', () => {
    const m = mediaWith(SUBS);
    S().addMedia([m]);
    S().clearHistory();
    routeJobs([ocrJob({ status: 'running', progress: 0.5 }, m.id)]);
    expect(Object.keys(S().project.subtitleTracks)).toHaveLength(0);

    routeJobs([ocrJob({ result: { cues: cues('Bonjour', 'Merci') } }, m.id)]);
    const tracks = Object.values(S().project.subtitleTracks);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ name: 'French (OCR #3)', language: 'fre', origin: 'ocr', streamIndex: 3, mediaId: m.id });
    expect(tracks[0].cues.map((c) => c.text)).toEqual(['Bonjour', 'Merci']);
    expect(S().project.media[m.id].subtitleTrackIds).toEqual([tracks[0].id]);
    expect(lastToast()).toMatchObject({ kind: 'ok', text: '2 subtitle lines read from #3 (French)' });
    expect(S().history.pastLabels.at(-1)).toBe('OCR subtitles');

    // The same job again (jobs list re-emitted) is applied once.
    routeJobs([ocrJob({ result: { cues: cues('Bonjour', 'Merci') } }, m.id)]);
    expect(S().history.past).toHaveLength(1);

    routeJobs([ocrJob({ id: 'o2', result: { cues: cues('Salut'), cached: true } }, m.id)]);
    const after = Object.values(S().project.subtitleTracks);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(tracks[0].id);
    expect(after[0].cues.map((c) => c.text)).toEqual(['Salut']);
    expect(lastToast()).toMatchObject({ kind: 'ok', text: '1 subtitle line read from #3 (French) (from cache)' });
  });

  it('uses the ISO 639-2 tag of the OCR language when the stream has none', () => {
    const m = mediaWith(SUBS);
    S().addMedia([m]);
    routeJobs([ocrJob({ title: 'Read subtitles with OCR: film.mkv #5 (German)', result: { streamIndex: 5, language: 'deu', cues: cues('Hallo') } }, m.id)]);
    expect(Object.values(S().project.subtitleTracks)[0]).toMatchObject({ name: 'German (OCR #5)', language: 'ger', streamIndex: 5 });
  });

  it('no lines: a warning and no track; media removed: a warning; failed / canceled: toasts', () => {
    const m = mediaWith(SUBS);
    S().addMedia([m]);
    routeJobs([ocrJob({ id: 'z', result: { cues: [] } }, m.id)]);
    expect(Object.keys(S().project.subtitleTracks)).toHaveLength(0);
    expect(lastToast()).toMatchObject({ kind: 'warn', text: 'No subtitle text read from film.mkv #3 (French)' });

    routeJobs([ocrJob({ id: 'gone', result: { cues: cues('x') } }, 'missing-media')]);
    expect(Object.keys(S().project.subtitleTracks)).toHaveLength(0);
    expect(lastToast()).toMatchObject({ kind: 'warn', text: 'OCR of #3 (French) finished, but its media is no longer in the project' });

    routeJobs([ocrJob({ id: 'f', status: 'failed', error: 'French OCR data is damaged.' }, m.id)]);
    expect(lastToast()).toMatchObject({ kind: 'error', text: 'OCR failed for film.mkv #3 (French): French OCR data is damaged.' });
    routeJobs([ocrJob({ id: 'k', status: 'canceled' }, m.id)]);
    expect(lastToast()).toMatchObject({ kind: 'info', text: 'OCR canceled (#3 (French))' });
    expect(Object.keys(S().project.subtitleTracks)).toHaveLength(0);
  });
});
