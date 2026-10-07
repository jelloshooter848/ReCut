/**
 * Export formats (ROADMAP §6) without running FFmpeg: the arguments buildRenderGraph writes for every format and
 * profile, the per-track audio graphs and file names, output / temp / sidecar names by extension, and the Export
 * dialog helpers (backward-compatible settings, presets, extension following the format, validation, size estimate,
 * Checks list). The real encodes are checked in export-intermediates.test.ts.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { ExportSettings, MediaItem, Sequence } from '@shared/model';
import { EXPORT_PRESETS } from '@shared/model';
import { createMediaItem, createSequence } from '@shared/project';
import { makeClip } from '@shared/timeline';
import type { ExportRequest } from '@shared/ipc';
import {
  DNXHR_PROFILES, PRORES_PROFILES, audioEncoder, exportContainer, perTrackAudioPlan, perTrackFileName, videoEncoder, withExportExtension,
} from '@shared/exportFormat';
import {
  buildExportGraphs, buildRenderGraph, exportOutputFiles, exportOutputPath, exportPartPath, exportSidecarPath, exportSidecarTempPath, exportUnsavedPath,
} from '../../electron/export/renderGraph';
import { buildExportCommand } from '../../electron/export/exporter';
import {
  CUSTOM, LARGE_EXPORT_BYTES, applyPreset, defaultExportSettings, estimateFileSize, exportChecklist, initialExportSettings, outputPathFor,
  perTrackOutputPaths, presetNameFor, presetsFor, validateExportSettings, withFormatExtension, type ChecklistItem,
} from '../../src/panels/export/settings';
import { patchExportSettings, sampleRateChoices } from '../../src/panels/export/ExportDialog';

const F24 = { num: 24, den: 1 };

function media(id: string, extra: Partial<MediaItem> = {}): MediaItem {
  const m = createMediaItem(`/media/${id}.mp4`, `${id}.mp4`);
  m.id = id;
  m.kind = 'video';
  m.probe = {
    container: 'mov,mp4', duration: 60, size: 1000, startTime: 0, browserPlayable: true,
    video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: F24, avgFps: F24, isVfr: false },
    audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
    subtitles: [],
  };
  return { ...m, ...extra };
}

/** V1 + A1 "Dialogue" 0..48 (media a), A2 "Music" 24..96 (media b), A3 empty. */
function sequence(): { seq: Sequence; media: Record<string, MediaItem> } {
  const seq = createSequence('Cut', F24, 1920, 1080);
  seq.videoTracks[0].clips.push(makeClip({ mediaId: 'a', name: 'v', sourceIn: 0, duration: 48, kind: 'video' }, 0));
  seq.audioTracks[0].name = 'Dialogue';
  seq.audioTracks[0].clips.push(makeClip({ mediaId: 'a', name: 'a', sourceIn: 0, duration: 48, kind: 'audio', audioStream: 1 }, 0));
  seq.audioTracks[1].name = 'Music';
  seq.audioTracks[1].clips.push(makeClip({ mediaId: 'b', name: 'b', sourceIn: 0, duration: 72, kind: 'audio', audioStream: 1 }, 24));
  return { seq, media: { a: media('a'), b: media('b') } };
}

function settings(over: Partial<ExportSettings> = {}): ExportSettings {
  return { ...defaultExportSettings(sequence().seq, { lastExportDir: '/out' }), fileName: 'cut.mp4', ...over };
}

function req(over: Partial<ExportSettings> = {}, s = sequence()): ExportRequest {
  return { sequence: s.seq, media: s.media, settings: settings(over) };
}

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
/** An output path as exportOutputPath resolves it (a drive letter and backslashes on Windows). */
const OUT = (name: string) => path.resolve('/out', name);

// ---------------------------------------------------------------------------------------------------
// FFmpeg arguments
// ---------------------------------------------------------------------------------------------------

describe('FFmpeg arguments per format', () => {
  it('MP4 (the default, and settings without a container) is unchanged: H.264 / AAC, yuv420p, +faststart', () => {
    for (const s of [settings(), settings({ container: undefined })]) {
      const g = buildRenderGraph(req(s));
      expect(g.videoCodecArgs).toEqual(['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '24/1', '-fps_mode', 'cfr']);
      expect(g.audioCodecArgs).toEqual(['-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2']);
      expect(g.args.slice(-7)).toEqual(['-movflags', '+faststart', '-t', '4', '-f', 'mp4', OUT('cut.mp4')]);
      expect(g.filterGraph).toMatch(/format=yuv420p\[vout\]/);
      expect([g.container, g.audioOnly]).toEqual(['mp4', false]);
    }
    const hevc = buildRenderGraph(req({ videoCodec: 'libx265', qualityMode: 'bitrate', videoBitrateKbps: 8000 }));
    expect(hevc.videoCodecArgs).toEqual(['-c:v', 'libx265', '-preset', 'medium', '-b:v', '8000k', '-maxrate', '8000k', '-bufsize', '16000k', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-r', '24/1', '-fps_mode', 'cfr']);
  });

  for (const p of PRORES_PROFILES) {
    it(`MOV ProRes ${p.label}: prores_ks -profile:v ${p.ffProfile}, ${p.pixFmt}, PCM, no faststart`, () => {
      const g = buildRenderGraph(req({ container: 'mov', intermediateCodec: 'prores', proresProfile: p.id, fileName: 'cut.mp4' }));
      expect(g.videoCodecArgs).toEqual(['-c:v', 'prores_ks', '-profile:v', p.ffProfile, '-vendor', 'apl0', '-pix_fmt', p.pixFmt, '-r', '24/1', '-fps_mode', 'cfr']);
      expect(g.filterGraph).toContain(`format=${p.pixFmt}[vout]`);
      expect(g.audioCodecArgs).toEqual(['-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '2']);
      expect(g.args).not.toContain('-movflags');
      expect(g.args.slice(-5)).toEqual(['-t', '4', '-f', 'mov', OUT('cut.mov')]);
      expect(g.args).toContain('-c:v');
      expect(g.args).not.toContain('-crf');
    });
  }
  it('ProRes 4444 has no alpha (yuv444p10le, not yuva444p10le)', () => {
    expect(PRORES_PROFILES.find((p) => p.id === '4444')!.pixFmt).toBe('yuv444p10le');
  });

  const dnxPix: Record<string, string> = { lb: 'yuv422p', sq: 'yuv422p', hq: 'yuv422p', hqx: 'yuv422p10le', '444': 'yuv444p10le' };
  for (const p of DNXHR_PROFILES) {
    it(`MOV DNxHR ${p.label}: dnxhd -profile:v ${p.ffProfile}, ${dnxPix[p.id]}`, () => {
      const g = buildRenderGraph(req({ container: 'mov', intermediateCodec: 'dnxhr', dnxhrProfile: p.id, audioBitDepth: 16 }));
      expect(g.videoCodecArgs).toEqual(['-c:v', 'dnxhd', '-profile:v', p.ffProfile, '-pix_fmt', dnxPix[p.id], '-r', '24/1', '-fps_mode', 'cfr']);
      expect(g.filterGraph).toContain(`format=${dnxPix[p.id]}[vout]`);
      expect(g.audioCodecArgs).toEqual(['-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2']);
    });
  }
  it('DNxHR refuses frames smaller than 256×120; ProRes takes them', () => {
    expect(() => buildRenderGraph(req({ container: 'mov', intermediateCodec: 'dnxhr', width: 254, height: 144 }))).toThrow(/at least 256×120/);
    expect(() => buildRenderGraph(req({ container: 'mov', intermediateCodec: 'dnxhr', width: 256, height: 118 }))).toThrow(/at least 256×120/);
    expect(() => buildRenderGraph(req({ container: 'mov', intermediateCodec: 'dnxhr', width: 256, height: 120 }))).not.toThrow();
    expect(() => buildRenderGraph(req({ container: 'mov', intermediateCodec: 'prores', width: 64, height: 36 }))).not.toThrow();
  });

  it('WAV: no video graph, PCM, the exact sample count of the range, RF64 when needed, no chapters', () => {
    const s = sequence();
    s.seq.markers.push({ id: 'm', time: 10, duration: 0, name: 'Ch', note: '', color: '', kind: 'chapter' });
    s.seq.view.inPoint = 6; s.seq.view.outPoint = 30;
    const g = buildRenderGraph(req({ container: 'wav', rangeMode: 'inOut', width: 15, height: 7, sampleRate: 96000 }, s), { chaptersFilePath: '/tmp/ch.txt' });
    expect(g.audioOnly).toBe(true);
    expect(g.filterGraph).not.toContain('[vout]');
    expect(g.filterGraph).not.toContain('color=');
    expect(g.inputArgs).not.toContain('-loop');
    expect(g.args).not.toContain('[vout]');
    expect(g.args).toContain('-vn');
    expect(g.videoCodecArgs).toEqual([]);
    expect(g.audioCodecArgs).toEqual(['-c:a', 'pcm_s24le', '-ar', '96000', '-ac', '2']);
    expect(g.filterGraph).toContain('apad=whole_len=96000,atrim=end_sample=96000[aout]'); // 24 frames at 24 fps = 1 s
    expect(g.args.slice(-7)).toEqual(['-rf64', 'auto', '-t', '1', '-f', 'wav', OUT('cut.wav')]);
    expect(g.chapters).toEqual([]);
    expect(g.args).not.toContain('ffmetadata');
  });

  it('FLAC: 24-bit as s32 with 24 bits per sample, 16-bit as s16; chapters kept', () => {
    const s = sequence();
    s.seq.markers.push({ id: 'm', time: 10, duration: 0, name: 'Ch', note: '', color: '', kind: 'chapter' });
    const g = buildRenderGraph(req({ container: 'flac' }, s), { chaptersFilePath: '/tmp/ch.txt' });
    expect(g.audioCodecArgs).toEqual(['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', '-ar', '48000', '-ac', '2']);
    expect(g.chapters.length).toBe(2);
    expect(g.args.slice(-3)).toEqual(['-f', 'flac', OUT('cut.flac')]);
    expect(buildRenderGraph(req({ container: 'flac', audioBitDepth: 16 })).audioCodecArgs.slice(0, 4)).toEqual(['-c:a', 'flac', '-sample_fmt', 's16']);
  });

  it('the AC-3 sample-rate limit only applies to MP4 (a WAV keeps 96 kHz with audioCodec ac3 left over)', () => {
    expect(buildRenderGraph(req({ container: 'wav', audioCodec: 'ac3', sampleRate: 96000 })).sampleRate).toBe(96000);
    expect(buildRenderGraph(req({ audioCodec: 'ac3', sampleRate: 96000 })).sampleRate).toBe(48000);
  });

  it('audio-only needs enabled audio, not video; burn-in is ignored with a warning', () => {
    const s = sequence();
    for (const t of s.seq.audioTracks) t.clips = [];
    expect(() => buildRenderGraph(req({ container: 'wav' }, s))).toThrow(/no enabled audio clips/);
    expect(() => buildRenderGraph(req({}, s))).not.toThrow();
    const r = { ...req({ container: 'wav', burnSubtitles: true }), subtitles: [{ start: 0, end: 1, text: 'x' }] };
    const g = buildRenderGraph(r, { subtitleFilePath: '/tmp/s.srt' });
    expect(g.subtitleContent).toBeUndefined();
    expect(g.filterGraph).not.toContain('subtitles=');
    expect(g.warnings.join(' ')).toMatch(/burn-in does not apply/);
  });

  it('encoder specs resolve unknown values to the defaults', () => {
    const odd = { ...settings(), container: 'avi', intermediateCodec: 'cineform', proresProfile: 'xq', audioBitDepth: 32 } as unknown as ExportSettings;
    expect(exportContainer(odd)).toBe('mp4');
    expect(videoEncoder({ ...odd, container: 'mov' })!.args).toEqual(['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0']);
    expect(audioEncoder({ ...odd, container: 'wav' }).codec).toBe('pcm_s24le');
    expect(videoEncoder(settings({ container: 'flac' }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------
// Output names
// ---------------------------------------------------------------------------------------------------

describe('output, temp and sidecar names follow the format', () => {
  it('exportOutputPath gives the format extension, replacing a known media extension', () => {
    expect(exportOutputPath(settings({ fileName: 'cut' }))).toBe(OUT('cut.mp4'));
    expect(exportOutputPath(settings({ fileName: 'cut.mp4', container: 'mov' }))).toBe(OUT('cut.mov'));
    expect(exportOutputPath(settings({ fileName: 'cut.MOV', container: 'mov' }))).toBe(OUT('cut.MOV'));
    expect(exportOutputPath(settings({ fileName: 'cut.mov', container: 'wav' }))).toBe(OUT('cut.wav'));
    expect(exportOutputPath(settings({ fileName: 'cut.wav', container: 'flac' }))).toBe(OUT('cut.flac'));
    expect(exportOutputPath(settings({ fileName: 'cut.flac' }))).toBe(OUT('cut.mp4'));
    expect(exportOutputPath(settings({ fileName: 'my.cut', container: 'wav' }))).toBe(OUT('my.cut.wav'));
    expect(withExportExtension(' a.mkv ', 'mov')).toBe('a.mov');
  });
  it('temps, the kept render and the sidecar keep the extension', () => {
    expect(exportPartPath('/o/cut.mov', 'ab')).toBe('/o/cut.recut-part-ab.mov');
    expect(exportPartPath('/o/cut.wav', 'ab')).toBe('/o/cut.recut-part-ab.wav');
    expect(exportPartPath('/o/cut.mp4', 'ab')).toBe('/o/cut.recut-part-ab.mp4');
    expect(exportUnsavedPath('/o/cut.flac', 't')).toBe('/o/cut.recut-unsaved-t.flac');
    expect(exportSidecarPath('/o/cut.wav')).toBe('/o/cut.srt');
    expect(exportSidecarTempPath('/o/cut.mov', 'z')).toBe('/o/cut.recut-part-z.srt');
  });
});

// ---------------------------------------------------------------------------------------------------
// Per-track audio
// ---------------------------------------------------------------------------------------------------

describe('one file per audio track', () => {
  it('names: <base> - A<n> <track name>, the default name not repeated, unsafe characters removed', () => {
    expect(perTrackFileName('Cut.wav', 1, 'Dialogue', 'wav')).toBe('Cut - A1 Dialogue.wav');
    expect(perTrackFileName('Cut', 2, 'A2', 'wav')).toBe('Cut - A2.wav');
    expect(perTrackFileName('Cut.mp4', 3, 'a3', 'flac')).toBe('Cut - A3.flac');
    expect(perTrackFileName('Cut.WAV', 4, 'FX: L/R*', 'wav')).toBe('Cut - A4 FX LR.wav');
    expect(perTrackFileName('', 1, '', 'wav')).toBe('export - A1.wav');
  });

  it('plans a file per rendered track with clips in the range; muted, not soloed and empty tracks are skipped', () => {
    const { seq } = sequence();
    let p = perTrackAudioPlan(seq, { fileName: 'cut.wav', container: 'wav' }, 0, 96);
    expect(p.files.map((f) => f.fileName)).toEqual(['cut - A1 Dialogue.wav', 'cut - A2 Music.wav']);
    expect(p.skipped.map((k) => [k.label, k.reason])).toEqual([['A3', 'empty']]);
    p = perTrackAudioPlan(seq, { fileName: 'cut.wav', container: 'wav' }, 60, 96); // A1 ends at 48
    expect(p.files.map((f) => f.label)).toEqual(['A2']);
    seq.audioTracks[1].solo = true;
    p = perTrackAudioPlan(seq, { fileName: 'cut.wav', container: 'wav' }, 0, 96);
    expect(p.files.map((f) => f.label)).toEqual(['A2']);
    expect(p.skipped.map((k) => [k.label, k.reason])).toEqual([['A1', 'notSoloed'], ['A3', 'notSoloed']]);
    seq.audioTracks[1].solo = false; seq.audioTracks[0].muted = true;
    p = perTrackAudioPlan(seq, { fileName: 'cut.wav', container: 'wav' }, 0, 96);
    expect(p.skipped.map((k) => [k.label, k.reason])).toEqual([['A1', 'muted'], ['A3', 'empty']]);
  });

  it('one graph per file, each mixing only its track over the full range, with identical timing', () => {
    const r = req({ container: 'wav', audioPerTrack: true, fileName: 'cut' });
    const outs = exportOutputFiles(r);
    expect(outs.perTrack).toBe(true);
    expect(outs.files.map((f) => f.label)).toEqual(['A1 Dialogue', 'A2 Music']);
    expect(outs.files.every((f) => f.req.settings.audioPerTrack === false && f.req.settings.exportSubtitleSidecar === false)).toBe(true);
    const { graphs } = buildExportGraphs(r);
    expect(graphs.map((g) => g.outputPath)).toEqual([OUT('cut - A1 Dialogue.wav'), OUT('cut - A2 Music.wav')]);
    // Each graph reads only its track's media and pads to the same sample count.
    expect(graphs[0].inputArgs.filter((a) => a.startsWith('/media/'))).toEqual(['/media/a.mp4']);
    expect(graphs[1].inputArgs.filter((a) => a.startsWith('/media/'))).toEqual(['/media/b.mp4']);
    for (const g of graphs) expect(g.filterGraph).toContain('apad=whole_len=192000,atrim=end_sample=192000[aout]');
    expect(graphs[0].warnings).toContain('No file for A3 (no clips in the range).');
    // The preview command is the first file's.
    expect(buildExportCommand(r).at(-1)).toBe(OUT('cut - A1 Dialogue.wav'));
  });

  it('per-track is for audio-only formats; MOV / MP4 ignore it', () => {
    expect(exportOutputFiles(req({ container: 'mov', audioPerTrack: true })).files.length).toBe(1);
  });

  it('refuses a track the export does not render, and an export with no track to write', () => {
    const r = req({ container: 'wav' });
    r.sequence.audioTracks[0].muted = true;
    expect(() => buildRenderGraph(r, { audioTrackId: r.sequence.audioTracks[0].id })).toThrow(/not rendered/);
    for (const t of r.sequence.audioTracks) t.muted = true;
    expect(() => exportOutputFiles({ ...r, settings: { ...r.settings, audioPerTrack: true } })).toThrow(/Nothing to export/);
  });

  it('the shared sidecar is <base>.srt and is checked against the sources', () => {
    const r = { ...req({ container: 'wav', audioPerTrack: true, fileName: 'cut', exportSubtitleSidecar: true }), subtitles: [{ start: 0, end: 1, text: 'x' }] };
    expect(exportOutputFiles(r).sidecarPath).toBe(OUT('cut.srt'));
    expect(() => buildExportGraphs({ ...r, protectedPaths: [OUT('cut.srt')] })).toThrow(/Refusing to export/);
    expect(() => buildExportGraphs({ ...r, protectedPaths: [OUT('cut - A2 Music.wav')] })).toThrow(/Refusing to export/);
  });
});

// ---------------------------------------------------------------------------------------------------
// Dialog helpers
// ---------------------------------------------------------------------------------------------------

describe('export settings: backward compatibility, presets, extension, validation', () => {
  it('settings saved before 0.8.0 (no format fields) load as MP4 with their codecs', () => {
    const { seq } = sequence();
    const old = {
      outputDir: '/old', fileName: 'Old.mp4', width: 1280, height: 720, fps: F24, videoCodec: 'libx265', qualityMode: 'crf', crf: 20,
      videoBitrateKbps: 9000, preset: 'slow', audioCodec: 'ac3', audioBitrateKbps: 448, audioChannels: 2, sampleRate: 48000,
      rangeMode: 'entire', burnSubtitles: true, exportSubtitleSidecar: false, useProxies: false,
    } as ExportSettings;
    const s = initialExportSettings(seq, { sequenceId: seq.id, settings: old }, {});
    expect(exportContainer(s)).toBe('mp4');
    expect([s.fileName, s.videoCodec, s.audioCodec, s.preset]).toEqual(['Old.mp4', 'libx265', 'ac3', 'slow']);
    expect(buildRenderGraph({ sequence: seq, media: sequence().media, settings: { ...old, outputDir: '/old' } }).args.at(-1)).toBe(path.resolve('/old', 'Old.mp4'));
    expect(presetNameFor(s, presetsFor(seq))).toBe(CUSTOM);
    // A saved MOV comes back as MOV, its name with .mov.
    const mov = initialExportSettings(seq, { sequenceId: 'other', settings: { ...old, container: 'mov' } }, {});
    expect([mov.container, mov.fileName]).toEqual(['mov', 'Cut.mov']);
    // An unknown container (a newer version's) falls back to MP4.
    expect(initialExportSettings(seq, { sequenceId: seq.id, settings: { ...old, container: 'mkv' as never } }, {}).container).toBe('mp4');
  });

  it('presets: MP4 presets switch back to MP4, the new presets select their format, detection is format-aware', () => {
    const { seq } = sequence();
    const presets = presetsFor(seq);
    const base = defaultExportSettings(seq);
    for (const p of EXPORT_PRESETS) expect(presetNameFor(applyPreset(base, p), presets)).toBe(p.name);
    const prores = applyPreset(base, EXPORT_PRESETS.find((p) => p.name === 'ProRes 422 HQ (MOV)')!);
    expect([prores.container, prores.fileName, prores.width]).toEqual(['mov', 'Cut.mov', 1920]);
    const back = applyPreset(prores, EXPORT_PRESETS[0]);
    expect([back.container, back.fileName]).toEqual(['mp4', 'Cut.mp4']);
    const stems = applyPreset(base, EXPORT_PRESETS.find((p) => p.name === 'WAV per audio track')!);
    expect([stems.container, stems.audioPerTrack, stems.fileName]).toEqual(['wav', true, 'Cut.wav']);
    expect(presetNameFor({ ...stems, audioPerTrack: false }, presets)).toBe('WAV 24-bit (audio only)');
    // Match Sequence keeps the format.
    expect(applyPreset(prores, presets.find((p) => p.name === 'Match Sequence')!).container).toBe('mov');
  });

  it('the file name follows the format; output paths use it', () => {
    const s = settings({ fileName: 'Cut.mp4' });
    expect(patchExportSettings(s, { container: 'mov' }).fileName).toBe('Cut.mov');
    expect(patchExportSettings(s, { container: 'flac' }).fileName).toBe('Cut.flac');
    expect(patchExportSettings({ ...s, container: 'wav', fileName: 'x.wav' }, { audioPerTrack: true }).fileName).toBe('x.wav');
    expect(outputPathFor({ outputDir: '/x', fileName: 'y', container: 'wav' })).toBe('/x/y.wav');
    expect(withFormatExtension('y.mp4', { container: 'mov' })).toBe('y.mov');
    const { seq } = sequence();
    expect(perTrackOutputPaths(seq, settings({ container: 'wav', audioPerTrack: true, fileName: 'y.wav' }))).toEqual(['/out/y - A1 Dialogue.wav', '/out/y - A2 Music.wav']);
    expect(perTrackOutputPaths(seq, settings({ container: 'wav' }))).toBeNull();
  });

  it('validation: no frame size / video quality checks for audio-only; DNxHR minimum size; AC-3 rate limit only for MP4', () => {
    expect(validateExportSettings(settings({ container: 'wav', width: 7, height: 0, crf: 99, audioBitrateKbps: 0 })).ok).toBe(true);
    expect(validateExportSettings(settings({ container: 'mov', crf: 99, audioBitrateKbps: 0 })).ok).toBe(true);
    const small = validateExportSettings(settings({ container: 'mov', intermediateCodec: 'dnxhr', width: 200, height: 112 }));
    expect(small.issues.map((i) => i.message)).toEqual(['DNxHR needs a frame of at least 256×120.']);
    expect(validateExportSettings(settings({ container: 'mov', intermediateCodec: 'prores', width: 200, height: 112 })).ok).toBe(true);
    expect(validateExportSettings(settings({ container: 'wav', audioCodec: 'ac3', sampleRate: 96000 })).ok).toBe(true);
    expect(validateExportSettings(settings({ audioCodec: 'ac3', sampleRate: 96000 })).ok).toBe(false);
    expect(patchExportSettings(settings({ container: 'wav', audioCodec: 'ac3' }), { sampleRate: 96000 }).sampleRate).toBe(96000);
    expect(sampleRateChoices('ac3', 96000, { container: 'wav' })).toEqual([44100, 48000, 96000]);
    expect(sampleRateChoices('ac3', 48000)).toEqual([32000, 44100, 48000]);
  });

  it('size estimate: ProRes / DNxHR data rates, exact PCM, FLAC smaller, per-track files add up', () => {
    const hq = estimateFileSize(settings({ container: 'mov', intermediateCodec: 'prores', proresProfile: 'hq', fps: { num: 30000, den: 1001 } }), 3600);
    // 220 Mbit/s + PCM 24-bit stereo 48 kHz (2.304 Mbit/s) for an hour.
    expect(hq.bytes / 1e9).toBeCloseTo((220e6 + 2.304e6) / 8 * 3600 / 1e9, 1);
    expect(hq.approximate).toBe(true);
    const wav = estimateFileSize(settings({ container: 'wav' }), 10);
    expect(wav).toEqual({ bytes: 48000 * 2 * 3 * 10, approximate: false });
    expect(estimateFileSize(settings({ container: 'wav' }), 10, 3).bytes).toBe(3 * wav.bytes);
    expect(estimateFileSize(settings({ container: 'flac' }), 10).bytes).toBeLessThan(wav.bytes);
    const p4444 = estimateFileSize(settings({ container: 'mov', proresProfile: '4444' }), 3600).bytes;
    expect(p4444).toBeGreaterThan(estimateFileSize(settings({ container: 'mov', proresProfile: 'lt' }), 3600).bytes);
  });
});

describe('Checks list for the formats', () => {
  const texts = (items: ChecklistItem[]) => items.map((i) => `${i.level}: ${i.text}`);

  it('warns about a very large intermediate', () => {
    const { seq, media } = sequence();
    // Stretch the sequence to 2 hours.
    seq.videoTracks[0].clips[0].duration = 2 * 3600 * 24;
    media.a.probe!.duration = 3 * 3600;
    const items = exportChecklist(seq, media, settings({ container: 'mov', proresProfile: '4444' }));
    const big = items.find((i) => i.text.startsWith('Large output'));
    expect(big?.level).toBe('warning');
    expect(big?.text).toMatch(/ProRes 4444, 2h 00m/);
    expect(exportChecklist(seq, media, settings()).some((i) => i.text.startsWith('Large output'))).toBe(false);
    expect(LARGE_EXPORT_BYTES).toBe(100e9);
    // A 2-hour stereo WAV is far below 4 GB; a 6-hour 96 kHz 5.1 one is RF64.
    expect(exportChecklist(seq, media, settings({ container: 'wav' })).some((i) => i.text.includes('RF64'))).toBe(false);
    seq.videoTracks[0].clips[0].duration = 6 * 3600 * 24;
    seq.audioTracks[0].clips[0].duration = 6 * 3600 * 24;
    media.a.probe!.duration = 7 * 3600;
    expect(exportChecklist(seq, media, settings({ container: 'wav', sampleRate: 96000, audioChannels: 6 })).some((i) => i.text.includes('RF64'))).toBe(true);
  });

  it('audio-only: burn-in does not apply; per-track file list and skipped tracks; nothing to export is an error', () => {
    const { seq, media } = sequence();
    seq.subtitleTracks.push({ id: 's', name: 'Subs', language: 'en', cues: [], enabled: true } as never);
    let items = texts(exportChecklist(seq, media, settings({ container: 'wav', burnSubtitles: true, audioPerTrack: true, fileName: 'cut' })));
    expect(items).toContain('info: Subtitle burn-in does not apply to an audio-only format (there is no picture). Use Sidecar to write an .srt next to the audio.');
    expect(items).toContain('info: 2 files, one per audio track, all 4s long: cut - A1 Dialogue.wav, cut - A2 Music.wav.');
    expect(items).toContain('info: No file for A3 (no clips in the range).');
    expect(texts(exportChecklist(seq, media, settings({ burnSubtitles: true }))).some((t) => t.includes('burn-in does not apply'))).toBe(false);
    for (const t of seq.audioTracks) t.muted = true;
    items = texts(exportChecklist(seq, media, settings({ container: 'wav' })));
    expect(items.filter((t) => t.startsWith('error'))).toEqual(['error: No enabled audio clips in the export range (on tracks that are not muted): there is no sound to export.']);
  });

  it('audio-only leaves out the picture-only timeline warnings (frame rate, VFR, sync) and keeps the others', () => {
    const { seq, media } = sequence();
    media.a.probe!.video!.fps = { num: 25, den: 1 };
    const video = exportChecklist(seq, media, settings());
    expect(video.some((i) => i.text.startsWith('Source frame rate differs'))).toBe(true);
    const audio = exportChecklist(seq, media, settings({ container: 'wav' }));
    expect(audio.some((i) => i.text.startsWith('Source frame rate differs'))).toBe(false);
  });
});
