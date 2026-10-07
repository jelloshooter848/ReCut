/**
 * OCR contract (Roadmap §4, W0): the language manifest and tag mapping (shared/ocr.ts), the IPC argument
 * checks, the language listing, SubtitleTrack.streamIndex / ocrLastLanguage normalization, the bitmap refusal
 * message of text extraction, and the undoable putOcrSubtitleTrack store action.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OCR_LANGUAGES, OCR_SUBTITLE_CODECS, TESSDATA_BASE, guessOcrLanguage, isOcrCodec, isOcrLanguageCode, iso6392ForOcr, ocrLanguage, ocrLanguageUrl,
} from '../../shared/ocr';
import { createMediaItem, createProject, normalizeProjectWithReport } from '../../shared/project';
import type { SubtitleTrack } from '../../shared/model';
import { normalizePrefs } from '../../electron/project/io';
import { subtitleExtractRefusal } from '../../electron/media/subtitlesExtract';
import { assertOcrLanguageCode, parseOcrRequest } from '../../electron/ocr/validate';
import { listOcrLanguages, ocrDataDir, ocrLanguagePath } from '../../electron/ocr/dataDir';
import { mediaHandlers } from '../../electron/media/index';
import { useStore, resetStore } from '../../src/state/store';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-ocr-contract-'));
afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

describe('OCR language manifest', () => {
  it('is pinned to one tessdata_fast commit over https', () => {
    expect(TESSDATA_BASE).toMatch(/^https:\/\/raw\.githubusercontent\.com\/tesseract-ocr\/tessdata_fast\/[0-9a-f]{40}\/$/);
    expect(TESSDATA_BASE).toContain('87416418657359cb625c412a48b6e1d6d41c29bd');
  });

  it('has well-formed, unique entries', () => {
    expect(OCR_LANGUAGES.length).toBeGreaterThanOrEqual(35);
    const codes = OCR_LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(OCR_LANGUAGES.map((l) => l.sha256)).size).toBe(codes.length);
    for (const l of OCR_LANGUAGES) {
      expect(l.code).toMatch(/^[a-z_]{3,12}$/);
      expect(l.file).toBe(`${l.code}.traineddata`);
      expect(l.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isSafeInteger(l.bytes) && l.bytes > 0).toBe(true);
      expect(l.bytes).toBeLessThan(64 * 1024 * 1024);
      expect(l.name.trim()).not.toBe('');
      expect(ocrLanguageUrl(l)).toBe(`${TESSDATA_BASE}${l.file}`);
      expect(ocrLanguageUrl(l).startsWith('https://')).toBe(true);
    }
  });

  it('includes the common subtitle languages', () => {
    for (const code of ['eng', 'fra', 'deu', 'spa', 'ita', 'por', 'nld', 'swe', 'nor', 'dan', 'fin', 'pol', 'ces', 'slk', 'hun', 'ron', 'ell',
      'rus', 'ukr', 'bul', 'srp', 'hrv', 'slv', 'tur', 'ara', 'heb', 'fas', 'hin', 'tha', 'vie', 'ind', 'msa', 'jpn', 'kor', 'chi_sim', 'chi_tra']) {
      expect(isOcrLanguageCode(code), code).toBe(true);
    }
    expect(ocrLanguage('eng')?.bytes).toBe(4113088);
    expect(isOcrLanguageCode('xyz')).toBe(false);
    expect(isOcrLanguageCode('constructor')).toBe(false);
  });
});

describe('OCR codecs', () => {
  it('lists the bitmap codecs ReCut reads with OCR', () => {
    expect([...OCR_SUBTITLE_CODECS]).toEqual(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);
    expect(isOcrCodec('hdmv_pgs_subtitle')).toBe(true);
    expect(isOcrCodec('dvb_teletext')).toBe(false);
    expect(isOcrCodec('subrip')).toBe(false);
    expect(isOcrCodec(undefined)).toBe(false);
  });
});

describe('guessOcrLanguage', () => {
  const table: [string | undefined, string | null][] = [
    // ISO 639-2/B
    ['fre', 'fra'], ['ger', 'deu'], ['dut', 'nld'], ['cze', 'ces'], ['gre', 'ell'], ['rum', 'ron'], ['slo', 'slk'], ['per', 'fas'],
    ['ice', 'isl'], ['mac', 'mkd'], ['may', 'msa'], ['alb', 'sqi'], ['arm', 'hye'], ['baq', 'eus'], ['geo', 'kat'], ['wel', 'cym'],
    ['chi', 'chi_sim'], ['zho', 'chi_sim'],
    // ISO 639-2/T (= tessdata)
    ['eng', 'eng'], ['fra', 'fra'], ['deu', 'deu'], ['spa', 'spa'], ['jpn', 'jpn'], ['kor', 'kor'], ['nor', 'nor'], ['nob', 'nor'],
    // ISO 639-1 and BCP 47
    ['en', 'eng'], ['fr', 'fra'], ['de', 'deu'], ['pt-BR', 'por'], ['es_419', 'spa'], ['zh', 'chi_sim'], ['zh-Hant', 'chi_tra'],
    ['zh-TW', 'chi_tra'], ['chi-hk', 'chi_tra'], ['sr', 'srp'], ['sr-Latn', 'srp_latn'], ['no', 'nor'], ['nb', 'nor'], ['he', 'heb'],
    ['iw', 'heb'], ['ja', 'jpn'], ['ko', 'kor'], ['ENG', 'eng'], [' fre ', 'fra'],
    // tessdata codes as-is
    ['chi_tra', 'chi_tra'], ['srp_latn', 'srp_latn'],
    // undetermined / unknown / not in the manifest
    ['und', null], ['unknown', null], ['mis', null], ['mul', null], ['zxx', null], ['', null], [undefined, null], ['xx', null],
    ['qaa', null], ['tlh', null],
  ];
  it.each(table)('%s → %s', (tag, code) => {
    expect(guessOcrLanguage(tag)).toBe(code);
  });

  it('only ever returns manifest codes', () => {
    for (const tag of ['en', 'sw', 'ml', 'kn', 'bur', 'tib', 'la', 'eo', 'yue', 'fil', 'tl']) {
      const g = guessOcrLanguage(tag);
      if (g !== null) expect(isOcrLanguageCode(g), `${tag} → ${g}`).toBe(true);
    }
  });
});

describe('iso6392ForOcr', () => {
  it('maps tessdata codes to ISO 639-2/B track tags', () => {
    expect(iso6392ForOcr('fra')).toBe('fre');
    expect(iso6392ForOcr('deu')).toBe('ger');
    expect(iso6392ForOcr('chi_sim')).toBe('chi');
    expect(iso6392ForOcr('chi_tra')).toBe('chi');
    expect(iso6392ForOcr('srp_latn')).toBe('srp');
    expect(iso6392ForOcr('eng')).toBe('eng');
    expect(iso6392ForOcr('jpn')).toBe('jpn');
  });

  it('round-trips through guessOcrLanguage for every manifest language but script variants', () => {
    for (const l of OCR_LANGUAGES) {
      if (l.code === 'chi_tra' || l.code === 'srp_latn') continue;
      expect(guessOcrLanguage(iso6392ForOcr(l.code)), l.code).toBe(l.code);
    }
  });
});

describe('OCR IPC argument checks', () => {
  const abs = path.resolve(tmpRoot, 'movie.mkv');
  it('accepts a well-formed request and keeps only the known fields', () => {
    expect(parseOcrRequest({ mediaId: 'm1', path: abs, streamIndex: 3, language: 'eng', codec: 'hdmv_pgs_subtitle', extra: 1 }))
      .toEqual({ mediaId: 'm1', path: abs, streamIndex: 3, language: 'eng', codec: 'hdmv_pgs_subtitle' });
    expect(parseOcrRequest({ mediaId: 'm1', path: abs, streamIndex: 0, language: 'chi_sim' })).toEqual({ mediaId: 'm1', path: abs, streamIndex: 0, language: 'chi_sim' });
  });

  it.each([
    ['not an object', null],
    ['no media id', { path: abs, streamIndex: 1, language: 'eng' }],
    ['relative path', { mediaId: 'm', path: 'movie.mkv', streamIndex: 1, language: 'eng' }],
    ['NUL in path', { mediaId: 'm', path: `${abs}\0x`, streamIndex: 1, language: 'eng' }],
    ['negative stream', { mediaId: 'm', path: abs, streamIndex: -1, language: 'eng' }],
    ['fractional stream', { mediaId: 'm', path: abs, streamIndex: 1.5, language: 'eng' }],
    ['string stream', { mediaId: 'm', path: abs, streamIndex: '1', language: 'eng' }],
    ['unknown language', { mediaId: 'm', path: abs, streamIndex: 1, language: '../eng' }],
    ['codec not a string', { mediaId: 'm', path: abs, streamIndex: 1, language: 'eng', codec: 5 }],
  ])('refuses %s', (_what, req) => {
    expect(() => parseOcrRequest(req)).toThrow();
  });

  it('language codes must be in the manifest', () => {
    expect(assertOcrLanguageCode('fra')).toBe('fra');
    for (const bad of ['', 'xyz', '../../etc/passwd', 'ENG', 5, null, '__proto__']) expect(() => assertOcrLanguageCode(bad)).toThrow();
  });
});

describe('installed OCR languages', () => {
  it('a language is installed when its file has the manifest size', async () => {
    const userData = path.join(tmpRoot, 'ud1');
    const dir = ocrDataDir(userData);
    expect(dir).toBe(path.join(userData, 'ocr', 'tessdata'));
    fs.mkdirSync(dir, { recursive: true });
    const fra = ocrLanguage('fra')!;
    const deu = ocrLanguage('deu')!;
    // Sparse files of the exact / a wrong size (contents are only hashed before use).
    fs.closeSync(fs.openSync(ocrLanguagePath(dir, 'fra'), 'w')); fs.truncateSync(ocrLanguagePath(dir, 'fra'), fra.bytes);
    fs.closeSync(fs.openSync(ocrLanguagePath(dir, 'deu'), 'w')); fs.truncateSync(ocrLanguagePath(dir, 'deu'), deu.bytes - 1);
    fs.mkdirSync(ocrLanguagePath(dir, 'spa')); // a folder is never an installed language
    const list = await listOcrLanguages(dir, (code) => (code === 'ita' ? 'job-1' : undefined));
    expect(list.map((l) => l.code)).toEqual(OCR_LANGUAGES.map((l) => l.code));
    const by = new Map(list.map((l) => [l.code, l]));
    expect(by.get('fra')).toEqual({ code: 'fra', name: fra.name, bytes: fra.bytes, installed: true });
    expect(by.get('deu')?.installed).toBe(false);
    expect(by.get('spa')?.installed).toBe(false);
    expect(by.get('ita')).toMatchObject({ installed: false, jobId: 'job-1' });
    expect(() => ocrLanguagePath(dir, '../x')).toThrow();
  });

  it('mediaHandlers.ocrLanguages reads <userData>/ocr/tessdata; the other OCR handlers are not implemented yet', async () => {
    const userData = path.join(tmpRoot, 'ud2');
    const dir = ocrDataDir(userData);
    fs.mkdirSync(dir, { recursive: true });
    fs.closeSync(fs.openSync(path.join(dir, 'eng.traineddata'), 'w')); fs.truncateSync(path.join(dir, 'eng.traineddata'), ocrLanguage('eng')!.bytes);
    mediaHandlers.init?.({ userData, cacheDir: path.join(tmpRoot, 'cache'), ffmpegPath: null, ffprobePath: null, broadcast: () => undefined });
    const list = await mediaHandlers.ocrLanguages();
    expect(list.filter((l) => l.installed).map((l) => l.code)).toEqual(['eng']);
    await expect(mediaHandlers.ocrInstallLanguage('eng')).rejects.toThrow(/not implemented yet/);
    await expect(mediaHandlers.startOcr({ mediaId: 'm', path: path.join(tmpRoot, 'a.mkv'), streamIndex: 2, language: 'eng' })).rejects.toThrow(/not implemented yet/);
    expect(await mediaHandlers.ocrRemoveLanguage('eng')).toMatchObject({ ok: false, error: expect.stringMatching(/not implemented yet/) });
    expect(await mediaHandlers.ocrInstallLanguageFromFile('eng', path.join(tmpRoot, 'x'))).toMatchObject({ ok: false });
  });
});

describe('subtitle text extraction refusal', () => {
  it('points bitmap streams ReCut can OCR to Read with OCR…', () => {
    for (const codec of OCR_SUBTITLE_CODECS) {
      expect(subtitleExtractRefusal(codec, 4)).toBe(`subtitle stream 4 is a bitmap subtitle stream (${codec}); use Read with OCR… to turn it into text.`);
    }
  });
  it('keeps teletext and ARIB captions as not supported', () => {
    for (const codec of ['dvb_teletext', 'arib_caption']) {
      const msg = subtitleExtractRefusal(codec, 2)!;
      expect(msg).toMatch(/does not support/);
      expect(msg).not.toMatch(/Read with OCR/);
    }
    expect(subtitleExtractRefusal('weird', 1)).toMatch(/not a supported text format/);
    expect(subtitleExtractRefusal('subrip', 1)).toBeNull();
    expect(subtitleExtractRefusal('ass', 1)).toBeNull();
  });
});

describe('normalization', () => {
  it('a subtitle track keeps streamIndex only when it is a non-negative integer', () => {
    const p = createProject('ocr') as unknown as Record<string, unknown>;
    const track = (id: string, streamIndex: unknown) => ({ id, name: id, language: 'eng', mediaId: null, cues: [], origin: 'ocr', streamIndex });
    p.subtitleTracks = {
      a: track('a', 3), b: track('b', 0), c: track('c', -1), d: track('d', 1.5), e: track('e', '2'), f: track('f', Number.MAX_SAFE_INTEGER + 1),
      g: { id: 'g', name: 'g', language: 'eng', mediaId: null, cues: [], origin: 'srt' },
    };
    const { project, repairs } = normalizeProjectWithReport(JSON.parse(JSON.stringify(p)));
    const t = project.subtitleTracks;
    expect(t.a.streamIndex).toBe(3);
    expect(t.b.streamIndex).toBe(0);
    for (const id of ['c', 'd', 'e', 'f', 'g']) expect('streamIndex' in t[id], id).toBe(false);
    expect(t.a.origin).toBe('ocr');
    expect(repairs.length).toBeGreaterThan(0);
  });

  it('prefs keep ocrLastLanguage only when it looks like a tessdata code', () => {
    expect(normalizePrefs({ ocrLastLanguage: 'chi_sim' }).ocrLastLanguage).toBe('chi_sim');
    expect(normalizePrefs({ ocrLastLanguage: 'eng' }).ocrLastLanguage).toBe('eng');
    for (const bad of ['EN', 'en', '../eng', 'eng.traineddata', 'a'.repeat(13), 5, null, '']) {
      expect('ocrLastLanguage' in normalizePrefs({ ocrLastLanguage: bad }), String(bad)).toBe(false);
    }
    expect('ocrLastLanguage' in normalizePrefs({})).toBe(false);
  });
});

describe('putOcrSubtitleTrack', () => {
  const S = () => useStore.getState();
  let mediaId: string;
  const ocrTrack = (id: string, streamIndex: number, text: string, language = 'eng'): SubtitleTrack => ({
    id, name: `English (OCR #${streamIndex})`, language, mediaId, streamIndex, origin: 'ocr',
    cues: [{ id: `${id}-c1`, start: 1, end: 2, text }],
  });

  beforeEach(() => {
    resetStore();
    const m = createMediaItem('/media/film.mkv', 'film.mkv');
    mediaId = m.id;
    S().addMedia([m]);
    S().clearHistory();
  });

  it('adds a track, then replaces it (same id) on a re-run of the same stream; one undo step each', () => {
    const first = S().putOcrSubtitleTrack(ocrTrack('t1', 3, 'Hello'));
    expect(first).toBe('t1');
    expect(S().project.media[mediaId].subtitleTrackIds).toEqual(['t1']);
    expect(S().project.subtitleTracks.t1.origin).toBe('ocr');
    expect(S().history.pastLabels.at(-1)).toBe('OCR subtitles');
    expect(S().history.past).toHaveLength(1);

    const second = S().putOcrSubtitleTrack({ ...ocrTrack('t2', 3, 'Hello there', 'fre'), name: 'French (OCR #3)' });
    expect(second).toBe('t1');
    const tracks = S().project.subtitleTracks;
    expect(Object.keys(tracks)).toEqual(['t1']);
    expect(tracks.t1).toMatchObject({ name: 'French (OCR #3)', language: 'fre', streamIndex: 3 });
    expect(tracks.t1.cues.map((c) => c.text)).toEqual(['Hello there']);
    expect(S().project.media[mediaId].subtitleTrackIds).toEqual(['t1']);

    S().undo();
    expect(S().project.subtitleTracks.t1.cues.map((c) => c.text)).toEqual(['Hello']);
    expect(S().project.subtitleTracks.t1.language).toBe('eng');
    S().undo();
    expect(S().project.subtitleTracks.t1).toBeUndefined();
    expect(S().project.media[mediaId].subtitleTrackIds).toEqual([]);
    S().redo();
    expect(S().project.subtitleTracks.t1.cues[0].text).toBe('Hello');
  });

  it('another stream, or a non-OCR track of the same stream, gets its own track', () => {
    S().addMediaSubtitleTrack({ ...ocrTrack('srt1', 3, 'text'), origin: 'srt' });
    S().putOcrSubtitleTrack(ocrTrack('t1', 3, 'A'));
    S().putOcrSubtitleTrack(ocrTrack('t2', 4, 'B'));
    expect(Object.keys(S().project.subtitleTracks).sort()).toEqual(['srt1', 't1', 't2']);
    expect(S().project.media[mediaId].subtitleTrackIds).toEqual(['srt1', 't1', 't2']);
  });
});
