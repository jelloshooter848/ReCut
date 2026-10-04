import { describe, it, expect } from 'vitest';
import type { ExportSettings, MediaItem, Sequence } from '@shared/model';
import { EXPORT_PRESETS } from '@shared/model';
import { createMediaItem, createSequence } from '@shared/project';
import { makeClip } from '@shared/timeline';
import {
  CUSTOM, MATCH_SEQUENCE, applyPreset, checklistBlocks, crfLabel, defaultExportSettings, estimateEtaSeconds, estimateFileSize,
  exportChecklist, exportRange, formatBytes, fpsFromOptionValue, fpsOptionValue, initialExportSettings, joinPath, matchSequencePreset,
  matchesPreset, maxSourceChannels, outputPathFor, presetNameFor, presetsFor, sanitizeFileName, validateExportSettings, withMp4,
} from '../../src/panels/export/settings';

function seq24(name = 'My Edit: Part 1'): Sequence {
  const s = createSequence(name, { num: 24, den: 1 }, 1920, 1080);
  return s;
}

function media(id: string, channels = 2, extra: Partial<MediaItem> = {}): MediaItem {
  const m = createMediaItem(`/media/${id}.mp4`, `${id}.mp4`);
  m.id = id;
  m.kind = 'video';
  m.probe = {
    container: 'mov,mp4', duration: 30, size: 1000, startTime: 0, browserPlayable: true,
    video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: { num: 24, den: 1 }, avgFps: { num: 24, den: 1 }, isVfr: false },
    audio: [{ index: 1, codec: 'aac', channels, layout: channels === 6 ? '5.1' : 'stereo', sampleRate: 48000 }],
    subtitles: [],
  };
  return { ...m, ...extra };
}

function withClip(s: Sequence, mediaId: string, start = 0, duration = 48): Sequence {
  s.videoTracks[0].clips.push(makeClip({ mediaId, name: mediaId, sourceIn: 0, duration, kind: 'video' }, start));
  return s;
}

describe('defaultExportSettings', () => {
  it('derives name, size, fps and audio from the sequence', () => {
    const s = defaultExportSettings(seq24(), { projectPath: '/projects/fan/edit.recut' });
    expect(s.fileName).toBe('My Edit Part 1.mp4');
    expect(s.width).toBe(1920); expect(s.height).toBe(1080);
    expect(s.fps).toEqual({ num: 24, den: 1 });
    expect(s.audioChannels).toBe(2); expect(s.audioCodec).toBe('aac');
    expect(s.outputDir).toBe('/projects/fan');
    expect(s.useProxies).toBe(false);
    expect(s.rangeMode).toBe('entire');
  });
  it('prefers the last export dir and uses the fallback when nothing is known', () => {
    expect(defaultExportSettings(seq24(), { lastExportDir: '/out', projectPath: '/p/x.recut' }).outputDir).toBe('/out');
    expect(defaultExportSettings(seq24(), { fallbackDir: '/home/me' }).outputDir).toBe('/home/me');
    expect(defaultExportSettings(seq24(), {}).outputDir).toBe('');
  });
  it('rounds odd sequence sizes down to even and defaults 5.1 sequences to AC-3', () => {
    const s = seq24(); s.width = 1281; s.height = 721; s.channels = 6;
    const d = defaultExportSettings(s);
    expect(d.width).toBe(1280); expect(d.height).toBe(720);
    expect(d.audioChannels).toBe(6); expect(d.audioCodec).toBe('ac3'); expect(d.audioBitrateKbps).toBe(640);
  });
});

describe('sanitizeFileName / paths', () => {
  it('strips separators and illegal characters', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij');
    expect(sanitizeFileName('   ')).toBe('export');
    expect(sanitizeFileName('..hidden')).toBe('hidden');
    expect(sanitizeFileName('  spaced   name  ')).toBe('spaced name');
  });
  it('forces an .mp4 extension', () => {
    expect(withMp4('out')).toBe('out.mp4');
    expect(withMp4('out.MP4')).toBe('out.MP4');
    expect(withMp4('out.mov')).toBe('out.mp4');
  });
  it('joins paths with the right separator', () => {
    expect(joinPath('/a/b', 'c.mp4')).toBe('/a/b/c.mp4');
    expect(joinPath('/a/b/', 'c.mp4')).toBe('/a/b/c.mp4');
    expect(joinPath('C:\\out', 'c.mp4')).toBe('C:\\out\\c.mp4');
    expect(outputPathFor({ outputDir: '/x', fileName: 'y' })).toBe('/x/y.mp4');
  });
});

describe('presets', () => {
  it('applyPreset overlays the preset and keeps the rest', () => {
    const base = defaultExportSettings(seq24(), { lastExportDir: '/out' });
    const p = EXPORT_PRESETS.find((x) => x.name === '720p Preview')!;
    const s = applyPreset(base, p);
    expect(s.width).toBe(1280); expect(s.height).toBe(720); expect(s.crf).toBe(28); expect(s.preset).toBe('veryfast');
    expect(s.outputDir).toBe('/out'); expect(s.fileName).toBe(base.fileName); expect(s.useProxies).toBe(false);
    expect(base.width).toBe(1920); // not mutated
  });
  it('detects which preset the settings match and switches to Custom after an edit', () => {
    const base = defaultExportSettings(seq24());
    const presets = presetsFor(seq24());
    for (const p of EXPORT_PRESETS) expect(presetNameFor(applyPreset(base, p), presets)).toBe(p.name);
    const s = applyPreset(base, EXPORT_PRESETS[0]);
    expect(presetNameFor({ ...s, crf: 19 }, presets)).toBe(CUSTOM);
    expect(presetNameFor({ ...s, audioCodec: 'ac3' }, presets)).toBe(CUSTOM);
  });
  it('Match Sequence follows the sequence format and compares fps as rationals', () => {
    const s = seq24(); s.fps = { num: 24000, den: 1001 }; s.width = 1280; s.height = 720;
    const m = matchSequencePreset(s);
    expect(m.name).toBe(MATCH_SEQUENCE);
    const base = { ...defaultExportSettings(seq24()), fps: { num: 48000, den: 2002 } };
    const applied = applyPreset(base, m);
    expect(matchesPreset({ ...applied, fps: { num: 48000, den: 2002 } }, m)).toBe(true);
    expect(presetNameFor(applied, presetsFor(s), MATCH_SEQUENCE)).toBe(MATCH_SEQUENCE);
    expect(presetNameFor({ ...applied, width: 1920 }, presetsFor(s), MATCH_SEQUENCE)).toBe(CUSTOM);
    // never auto-detected without being the last choice
    expect(presetNameFor(applied, presetsFor(s))).toBe(CUSTOM);
  });
  it('5.1 presets switch the audio codec to AC-3 even when not stated', () => {
    const base = defaultExportSettings(seq24());
    const s = applyPreset(base, { name: 'x', settings: { audioChannels: 6 } });
    expect(s.audioCodec).toBe('ac3');
  });
});

describe('exportRange', () => {
  it('uses the whole sequence by default and the in/out range when set and valid', () => {
    const s = withClip(seq24(), 'a', 0, 96);
    expect(exportRange(s, { rangeMode: 'entire' })).toMatchObject({ startF: 0, endF: 96, frames: 96, seconds: 4, usesInOut: false });
    s.view.inPoint = 24; s.view.outPoint = 72;
    expect(exportRange(s, { rangeMode: 'inOut' })).toMatchObject({ startF: 24, endF: 72, frames: 48, seconds: 2, usesInOut: true });
    s.view.outPoint = 24;
    expect(exportRange(s, { rangeMode: 'inOut' })).toMatchObject({ frames: 96, usesInOut: false });
  });
});

describe('estimateFileSize', () => {
  const base = (): ExportSettings => defaultExportSettings(seq24());
  it('bitrate mode is exact: (video + audio) × duration', () => {
    const s = { ...base(), qualityMode: 'bitrate' as const, videoBitrateKbps: 8000, audioBitrateKbps: 192 };
    const e = estimateFileSize(s, 10);
    expect(e.approximate).toBe(false);
    expect(e.bytes).toBe(Math.round((8000 + 192) * 1000 / 8 * 10));
  });
  it('CRF mode is approximate, grows with resolution/duration and shrinks with higher CRF', () => {
    const s = base();
    const a = estimateFileSize({ ...s, crf: 18 }, 60);
    const b = estimateFileSize({ ...s, crf: 28 }, 60);
    const c = estimateFileSize({ ...s, crf: 18, width: 1280, height: 720 }, 60);
    const d = estimateFileSize({ ...s, crf: 18 }, 120);
    expect(a.approximate).toBe(true);
    expect(a.bytes).toBeGreaterThan(b.bytes);
    expect(a.bytes).toBeGreaterThan(c.bytes);
    expect(d.bytes).toBeCloseTo(a.bytes * 2, -3);
    expect(estimateFileSize(s, 0).bytes).toBe(0);
  });
  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(15 * 1024 * 1024)).toBe('15.0 MB');
    expect(formatBytes(2.5 * 1024 ** 3)).toBe('2.50 GB');
  });
  it('labels CRF ranges', () => {
    expect(crfLabel(14)).toBe('Best'); expect(crfLabel(18)).toBe('High'); expect(crfLabel(23)).toBe('Medium'); expect(crfLabel(30)).toBe('Small');
  });
  it('estimates ETA from progress rate', () => {
    expect(estimateEtaSeconds(0, 1000)).toBeNull();
    expect(estimateEtaSeconds(0.25, 10_000)).toBe(30);
  });
});

describe('validateExportSettings', () => {
  const ok = (): ExportSettings => defaultExportSettings(seq24(), { lastExportDir: '/out' });
  it('accepts sane defaults', () => { expect(validateExportSettings(ok()).ok).toBe(true); });
  it('rejects empty names, separators and missing folders', () => {
    expect(validateExportSettings({ ...ok(), fileName: '  ' }).issues.map((i) => i.field)).toContain('fileName');
    expect(validateExportSettings({ ...ok(), fileName: 'a/b.mp4' }).issues.map((i) => i.field)).toContain('fileName');
    expect(validateExportSettings({ ...ok(), fileName: 'a\\b.mp4' }).issues.map((i) => i.field)).toContain('fileName');
    expect(validateExportSettings({ ...ok(), outputDir: '' }).issues.map((i) => i.field)).toContain('outputDir');
  });
  it('requires even dimensions of at least 16', () => {
    expect(validateExportSettings({ ...ok(), width: 1281 }).issues[0].field).toBe('width');
    expect(validateExportSettings({ ...ok(), height: 14 }).issues[0].field).toBe('height');
    expect(validateExportSettings({ ...ok(), width: 16, height: 16 }).ok).toBe(true);
    expect(validateExportSettings({ ...ok(), width: 9000 }).ok).toBe(false);
  });
  it('checks bitrates', () => {
    expect(validateExportSettings({ ...ok(), qualityMode: 'bitrate', videoBitrateKbps: 0 }).ok).toBe(false);
    expect(validateExportSettings({ ...ok(), qualityMode: 'crf', videoBitrateKbps: 0 }).ok).toBe(true);
    expect(validateExportSettings({ ...ok(), audioBitrateKbps: 0 }).ok).toBe(false);
  });
});

describe('checklist / media inspection', () => {
  it('finds the max source channel count among used media only', () => {
    const s = withClip(seq24(), 'a');
    const lib = { a: media('a', 2), b: media('b', 6) };
    expect(maxSourceChannels(s, lib)).toBe(2);
    withClip(s, 'b', 48);
    expect(maxSourceChannels(s, lib)).toBe(6);
  });
  it('blocks on offline media and warns about unprobed media / fps mismatch / proxies', () => {
    const s = withClip(withClip(seq24(), 'a'), 'b', 48);
    const settings = defaultExportSettings(s, { lastExportDir: '/out' });
    const lib = { a: media('a', 2, { offline: true }), b: { ...media('b'), probe: undefined } };
    const items = exportChecklist(s, lib, settings);
    expect(checklistBlocks(items)).toBe(true);
    expect(items.find((i) => i.level === 'error')!.text).toContain('a.mp4');
    expect(items.some((i) => i.level === 'warning' && i.text.includes('b.mp4'))).toBe(true);
    const fine = exportChecklist(s, { a: media('a'), b: media('b') }, settings);
    expect(fine).toEqual([]);
    const fpsItems = exportChecklist(s, { a: media('a'), b: media('b') }, { ...settings, fps: { num: 30, den: 1 } });
    expect(fpsItems.some((i) => i.text.includes('retiming'))).toBe(true);
    const proxied = { a: { ...media('a'), proxy: { status: 'ready' as const, path: '/p.mp4' } }, b: media('b') };
    expect(exportChecklist(s, proxied, settings, true).some((i) => i.level === 'info')).toBe(true);
    expect(exportChecklist(s, proxied, settings, false).some((i) => i.level === 'info')).toBe(false);
  });
  it('blocks when the sequence is empty', () => {
    expect(checklistBlocks(exportChecklist(seq24(), {}, defaultExportSettings(seq24())))).toBe(true);
  });
});

describe('fps option mapping / initial settings', () => {
  it('round-trips preset and arbitrary frame rates', () => {
    expect(fpsOptionValue({ num: 24000, den: 1001 })).toBe('23.976');
    expect(fpsFromOptionValue('29.97', { num: 1, den: 1 })).toEqual({ num: 30000, den: 1001 });
    expect(fpsOptionValue({ num: 48, den: 1 })).toBe('48/1');
    expect(fpsFromOptionValue('48/1', { num: 1, den: 1 })).toEqual({ num: 48, den: 1 });
    expect(fpsFromOptionValue('garbage', { num: 25, den: 1 })).toEqual({ num: 25, den: 1 });
  });
  it('restores saved settings but regenerates the name for another sequence', () => {
    const s = seq24('Cut A');
    const saved = { ...defaultExportSettings(s), fileName: 'custom.mp4', crf: 22, outputDir: '/saved' };
    expect(initialExportSettings(s, { sequenceId: s.id, settings: saved }, {})).toMatchObject({ fileName: 'custom.mp4', crf: 22, outputDir: '/saved' });
    expect(initialExportSettings(s, { sequenceId: 'other', settings: saved }, {})).toMatchObject({ fileName: 'Cut A.mp4', crf: 22 });
    expect(initialExportSettings(s, { sequenceId: s.id, settings: { ...saved, outputDir: '' } }, { lastExportDir: '/last' }).outputDir).toBe('/last');
    expect(initialExportSettings(s, null, { lastExportDir: '/last' }).fileName).toBe('Cut A.mp4');
  });
});
