/**
 * MKV packaging export (ROADMAP §7) without running FFmpeg: the container, the mix-definition planning
 * (audioOutputPlan, presets, working layout), the render graph's `[aout]` / `[aout1]` mixes and arguments (stream
 * codecs, languages, titles, default / forced flags, soft subtitle inputs, chapters), backward-compatible settings, the
 * dialog's pure edits (packaging.ts) and the Checks list. The real files are checked in export-mkv.test.ts.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { ExportSettings, MediaItem, Sequence } from '@shared/model';
import { createMediaItem, createSequence } from '@shared/project';
import { makeClip } from '@shared/timeline';
import type { ExportRequest } from '@shared/ipc';
import {
  AUDIO_OUTPUT_PRESETS, audioOutputPlan, audioOutputPreset, audioStreamArgs, CONTAINER_IDS, CONTAINERS, dispositionValue, exportLanguageCode,
  matchingAudioOutputPreset, resolveAudioOutputs, sanitizePackaging, subtitleOutputPlan, usesAc3, videoEncoder, withExportExtension, workingLayout,
} from '@shared/exportFormat';
import { buildRenderGraph, exportPartPath, exportOutputPath } from '../../electron/export/renderGraph';
import { buildExportCommand } from '../../electron/export/exporter';
import {
  audioSummary, defaultExportSettings, estimateFileSize, exportChecklist, initialExportSettings, packagingChecks, validateExportSettings,
} from '../../src/panels/export/settings';
import {
  addAudioOutput, applyAudioOutputPreset, displayedAudioOutputs, moveAudioOutput, removeAudioOutput, setAudioOutputSource, setSubtitleIncluded,
  updateAudioOutput, updateSubtitleOutput,
} from '../../src/panels/export/packaging';
import { buildExportRequest, softSubtitleTracks } from '../../src/panels/export/request';
import { patchExportSettings, sampleRateChoices } from '../../src/panels/export/ExportDialog';

const F24 = { num: 24, den: 1 };
const OUT = (name: string) => path.resolve('/out', name);
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

function media(id: string, channels = 2): MediaItem {
  const m = createMediaItem(`/media/${id}.mp4`, `${id}.mp4`);
  m.id = id;
  m.kind = 'video';
  m.probe = {
    container: 'mov,mp4', duration: 60, size: 1000, startTime: 0, browserPlayable: true,
    video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: F24, avgFps: F24, isVfr: false },
    audio: [{ index: 1, codec: 'aac', channels, layout: channels === 6 ? '5.1' : 'stereo', sampleRate: 48000 }],
    subtitles: [],
  };
  return m;
}

/** V1 0..96; A1 "Dialogue" 0..96; A2 "Music" 24..96; A3 "Commentary" 0..96; subtitle tracks "English" (en) and "Deutsch" (hidden). */
function sequence(): { seq: Sequence; media: Record<string, MediaItem> } {
  const seq = createSequence('Cut', F24, 1920, 1080);
  seq.videoTracks[0].clips.push(makeClip({ mediaId: 'a', name: 'v', sourceIn: 0, duration: 96, kind: 'video' }, 0));
  const [a1, a2, a3] = seq.audioTracks;
  a1.name = 'Dialogue';
  a1.clips.push(makeClip({ mediaId: 'a', name: 'a', sourceIn: 0, duration: 96, kind: 'audio', audioStream: 1 }, 0));
  a2.name = 'Music';
  a2.clips.push(makeClip({ mediaId: 'b', name: 'b', sourceIn: 0, duration: 72, kind: 'audio', audioStream: 1 }, 24));
  a3.name = 'Commentary';
  a3.clips.push(makeClip({ mediaId: 'c', name: 'c', sourceIn: 0, duration: 96, kind: 'audio', audioStream: 1 }, 0));
  seq.subtitleTracks.push(
    { id: 'st-en', name: 'English', language: 'en', enabled: true, cues: [{ id: 'q1', start: 24, duration: 24, offset: 0, text: 'Hi' }] },
    { id: 'st-de', name: 'Deutsch', language: 'ger', enabled: false, cues: [{ id: 'q2', start: 48, duration: 12, offset: 0, text: 'Hallo' }] },
  );
  return { seq, media: { a: media('a'), b: media('b'), c: media('c') } };
}

function settings(over: Partial<ExportSettings> = {}): ExportSettings {
  return { ...defaultExportSettings(sequence().seq, { lastExportDir: '/out' }), fileName: 'cut.mkv', container: 'mkv', ...over };
}

function req(over: Partial<ExportSettings> = {}, s = sequence()): ExportRequest {
  return buildExportRequest({ media: s.media, subtitleTracks: {} }, s.seq, settings(over));
}

/** Main 5.1 AC-3 of A1 + A2 (eng), Commentary stereo AAC of A3 (eng). */
function twoTracks(seq: Sequence): ExportSettings['audioOutputs'] {
  const [a1, a2, a3] = seq.audioTracks;
  return [
    { sources: [a1.id, a2.id], layout: '5.1', codec: 'ac3', bitrateKbps: 640, language: 'eng', title: 'Main' },
    { sources: [a3.id], layout: 'stereo', codec: 'aac', bitrateKbps: 192, language: 'eng', title: 'Commentary' },
  ];
}

// ---------------------------------------------------------------------------------------------------
// Container and planning
// ---------------------------------------------------------------------------------------------------

describe('MKV container', () => {
  it('is in the format list after MP4, with the matroska muxer, chapters and the .mkv extension', () => {
    expect(CONTAINER_IDS.slice(0, 2)).toEqual(['mp4', 'mkv']);
    expect(CONTAINERS.mkv).toMatchObject({ ext: '.mkv', muxer: 'matroska', audioOnly: false, chapters: true, muxArgs: [] });
    expect(withExportExtension('cut.mp4', 'mkv')).toBe('cut.mkv');
    expect(withExportExtension('cut.MKV', 'mkv')).toBe('cut.MKV');
    expect(withExportExtension('cut.mkv', 'mp4')).toBe('cut.mp4');
    expect(exportOutputPath(settings({ fileName: 'cut.mp4' }))).toBe(OUT('cut.mkv'));
    expect(exportPartPath(OUT('cut.mkv'), 'ab12')).toBe(OUT('cut.recut-part-ab12.mkv'));
  });

  it('H.264 / H.265 as in MP4, without the hvc1 tag Matroska refuses', () => {
    expect(videoEncoder(settings({ videoCodec: 'libx265' }))!.args).not.toContain('-tag:v');
    expect(videoEncoder(settings({ videoCodec: 'libx265', container: 'mp4' }))!.args).toContain('hvc1');
    expect(videoEncoder(settings())!.args).toEqual(['-c:v', 'libx264', '-preset', 'medium', '-crf', '18']);
  });
});

describe('mix definitions (audioOutputPlan)', () => {
  it('without audioOutputs: one main mix of every rendered track with the settings\' codec, as an MP4', () => {
    const { seq } = sequence();
    expect(resolveAudioOutputs(settings({ audioCodec: 'ac3', audioChannels: 6, audioBitrateKbps: 448 }))).toEqual([{ layout: '5.1', codec: 'ac3', bitrateKbps: 448 }]);
    seq.audioTracks[1].muted = true;
    const [p] = audioOutputPlan(seq, settings());
    expect([p.allTracks, p.mixed, p.language, p.title, p.isDefault, p.channels]).toEqual([true, [seq.audioTracks[0].id, seq.audioTracks[2].id], 'und', '', true, 2]);
    // Other formats never have output tracks.
    expect(resolveAudioOutputs(settings({ container: 'mp4', audioOutputs: twoTracks(seq) })).length).toBe(1);
  });

  it('sources, solo and mute: only rendered tracks are mixed; unknown ids are ignored', () => {
    const { seq } = sequence();
    const outs = twoTracks(seq)!;
    outs[0].sources!.push('nope');
    let plan = audioOutputPlan(seq, settings({ audioOutputs: outs }));
    expect(plan.map((p) => [p.mixed.length, p.layout, p.channels, p.encoder.args, p.name])).toEqual([
      [2, '5.1', 6, ['-c:a', 'ac3', '-b:a', '640k'], 'Track 1 "Main" (A1, A2)'],
      [1, 'stereo', 2, ['-c:a', 'aac', '-b:a', '192k'], 'Track 2 "Commentary" (A3)'],
    ]);
    seq.audioTracks[0].solo = true; // only A1 is rendered
    plan = audioOutputPlan(seq, settings({ audioOutputs: outs }));
    expect(plan.map((p) => p.mixed)).toEqual([[seq.audioTracks[0].id], []]);
    expect(workingLayout(plan)).toBe('5.1');
    expect(workingLayout([{ layout: 'stereo' }, { layout: 'mono' }])).toBe('stereo');
  });

  it('PCM and FLAC follow the bit depth; bitrates default per layout', () => {
    const p = audioOutputPlan({ audioTracks: [] }, settings({
      audioBitDepth: 16, audioOutputs: [{ layout: 'mono', codec: 'pcm' }, { layout: '5.1', codec: 'flac' }, { layout: '5.1', codec: 'aac' }, { layout: 'mono', codec: 'ac3' }],
    }));
    expect(p.map((x) => x.encoder.args)).toEqual([
      ['-c:a', 'pcm_s16le'], ['-c:a', 'flac', '-sample_fmt', 's16'], ['-c:a', 'aac', '-b:a', '384k'], ['-c:a', 'ac3', '-b:a', '128k'],
    ]);
  });

  it('language codes: ISO 639-2 as is, 639-1 and regional tags mapped (bibliographic), anything else und', () => {
    expect(['eng', 'en', 'fr', 'fre', 'de', 'pt-BR', 'zh-Hant', 'JPN', '', 'und', 'xx', undefined].map((t) => exportLanguageCode(t as string)))
      .toEqual(['eng', 'eng', 'fre', 'fre', 'ger', 'por', 'chi', 'jpn', 'und', 'und', 'und', 'und']);
  });

  it('stream-addressed args and dispositions', () => {
    expect(audioStreamArgs(['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24'], 1)).toEqual(['-c:a:1', 'flac', '-sample_fmt:a:1', 's32', '-bits_per_raw_sample:a:1', '24']);
    expect([dispositionValue(true), dispositionValue(false), dispositionValue(false, true), dispositionValue(true, true)]).toEqual(['default', '0', 'forced', 'default+forced']);
  });

  it('presets: main = no list; 5.1 + stereo downmix; main + commentary (the last audio track with clips)', () => {
    const { seq } = sequence();
    expect(AUDIO_OUTPUT_PRESETS.map((p) => p.id)).toEqual(['main', 'surroundStereo', 'commentary']);
    expect(audioOutputPreset('main', seq)).toBeUndefined();
    expect(audioOutputPreset('surroundStereo', seq)!.map((o) => [o.layout, o.codec, o.sources])).toEqual([['5.1', 'ac3', undefined], ['stereo', 'aac', undefined]]);
    const c = audioOutputPreset('commentary', seq)!;
    expect(c.map((o) => [o.title, o.sources])).toEqual([['Main', [seq.audioTracks[0].id, seq.audioTracks[1].id]], ['Commentary', [seq.audioTracks[2].id]]]);
    // A3 empty: the commentary is A2, the last track with clips.
    seq.audioTracks[2].clips = [];
    expect(audioOutputPreset('commentary', seq)![1].sources).toEqual([seq.audioTracks[1].id]);
    expect(matchingAudioOutputPreset(settings(), seq)).toBe('main');
    expect(matchingAudioOutputPreset(settings({ audioOutputs: audioOutputPreset('surroundStereo', seq) }), seq)).toBe('surroundStereo');
    expect(matchingAudioOutputPreset(settings({ audioOutputs: [{ layout: 'mono', codec: 'aac' }] }), seq)).toBeNull();
  });

  it('subtitle outputs: tracks that exist, once each, language and title from the track unless set', () => {
    const { seq } = sequence();
    const plan = subtitleOutputPlan(seq.subtitleTracks, settings({
      subtitleOutputs: [{ trackId: 'st-de', forced: true }, { trackId: 'gone' }, { trackId: 'st-en', default: true, language: 'spa', title: 'Spanish?' }, { trackId: 'st-de' }],
    }));
    expect(plan.map((p) => [p.index, p.track.id, p.language, p.title, p.isDefault, p.forced])).toEqual([
      [0, 'st-de', 'ger', 'Deutsch', false, true], [1, 'st-en', 'spa', 'Spanish?', true, false],
    ]);
    expect(subtitleOutputPlan(seq.subtitleTracks, settings({ container: 'mp4', subtitleOutputs: [{ trackId: 'st-en' }] }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Render graph
// ---------------------------------------------------------------------------------------------------

describe('render graph: MKV', () => {
  it('without output tracks: the MP4 audio chain, stream-addressed codec args, language und, default flags, matroska', () => {
    const mkv = buildRenderGraph(req());
    const mp4 = buildRenderGraph(req({ container: 'mp4', fileName: 'cut.mp4' }));
    expect(mkv.audioCodecArgs).toEqual(['-c:a:0', 'aac', '-b:a:0', '320k', '-ac:a:0', '2', '-ar', '48000']);
    expect(mkv.streamArgs).toEqual(['-disposition:v:0', 'default', '-metadata:s:a:0', 'language=und', '-disposition:a:0', 'default']);
    expect(mkv.args.slice(-5)).toEqual(['-t', '4', '-f', 'matroska', OUT('cut.mkv')]);
    expect(mkv.audioOutputs).toEqual([{ label: '[aout]', channels: 2, name: 'Track 1 (all tracks)' }]);
    // The same mix, made exactly the range's samples long.
    expect(mkv.filterGraph.replace(',apad=whole_len=192000,atrim=end_sample=192000[aout]', '[aout]')).toBe(mp4.filterGraph);
    // MP4 is unchanged: no stream tags, no dispositions.
    expect(mp4.audioCodecArgs).toEqual(['-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2']);
    expect(mp4.args.some((a) => a.startsWith('-disposition') || a.startsWith('-metadata:s'))).toBe(false);
    expect([mp4.streamArgs, mp4.softSubtitles, mp4.subtitleCodecArgs]).toEqual([[], [], []]);
  });

  it('two output tracks: each a mix of its sources at its layout, the tracks rendered once at the widest layout', () => {
    const s = sequence();
    const g = buildRenderGraph(req({ audioOutputs: twoTracks(s.seq) }, s));
    const chains = g.filterGraph.split(';\n');
    // Every clip chain is rendered at 5.1 (the widest output layout).
    expect(chains.filter((c) => /^\[\d+:1\]/.test(c)).every((c) => c.includes('channel_layouts=5.1'))).toBe(true);
    const out0 = chains.find((c) => c.endsWith('[aout]'))!;
    const out1 = chains.find((c) => c.endsWith('[aout1]'))!;
    expect(out0).toMatch(/^\[ta\d+\]\[ta\d+\]amix=inputs=2:normalize=0:duration=longest,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=5\.1,apad=whole_len=192000,atrim=end_sample=192000\[aout\]$/);
    expect(out1).toMatch(/^\[ta\d+\]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_len=192000,atrim=end_sample=192000\[aout1\]$/);
    expect(g.filterGraph).not.toContain('asplit');
    expect(g.args.filter((a, i) => g.args[i - 1] === '-map')).toEqual(['[vout]', '[aout]', '[aout1]']);
    expect(g.audioCodecArgs).toEqual(['-c:a:0', 'ac3', '-b:a:0', '640k', '-ac:a:0', '6', '-c:a:1', 'aac', '-b:a:1', '192k', '-ac:a:1', '2', '-ar', '48000']);
    expect(g.streamArgs).toEqual([
      '-disposition:v:0', 'default',
      '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=Main', '-disposition:a:0', 'default',
      '-metadata:s:a:1', 'language=eng', '-metadata:s:a:1', 'title=Commentary', '-disposition:a:1', '0',
    ]);
    expect(g.audioOutputs.map((o) => [o.label, o.channels])).toEqual([['[aout]', 6], ['[aout1]', 2]]);
    expect(g.channels).toBe(6);
  });

  it('a track in several outputs is rendered once and split; an output whose sources are muted is silence', () => {
    const s = sequence();
    s.seq.audioTracks[2].muted = true;
    const g = buildRenderGraph(req({ audioOutputs: [...audioOutputPreset('surroundStereo', s.seq)!, { sources: [s.seq.audioTracks[2].id], layout: 'mono', codec: 'aac' }] }, s));
    const chains = g.filterGraph.split(';\n');
    expect(chains.filter((c) => c.includes('asplit=2')).length).toBe(2); // A1 and A2, each into both mixes
    expect(chains.find((c) => c.endsWith('[aout2]'))).toMatch(/^anullsrc=r=48000:cl=mono:.*apad=whole_len=192000,atrim=end_sample=192000\[aout2\]$/);
    expect(chains.find((c) => c.endsWith('[aout1]'))).toContain('channel_layouts=stereo');
    expect(g.audioCodecArgs).toContain('-ac:a:2');
    expect(after(g.audioCodecArgs, '-ac:a:2')).toBe('1');
    // The muted commentary's clip has no input or chain.
    expect(g.inputArgs.filter((a) => a === '/media/c.mp4')).toEqual([]);
  });

  it('a range edge inside a transition keeps the widened render trims on every output', () => {
    const s = sequence();
    s.seq.view.inPoint = 12; s.seq.view.outPoint = 60;
    const g = buildRenderGraph(req({ audioOutputs: twoTracks(s.seq), rangeMode: 'inOut' }, s));
    expect(g.filterGraph).toContain('apad=whole_len=96000,atrim=end_sample=96000[aout]');
    expect(g.filterGraph).toContain('apad=whole_len=96000,atrim=end_sample=96000[aout1]');
  });

  it('soft subtitles: one SRT input each after the chapters file, mapped, SubRip, tags and flags; range-relative', () => {
    const s = sequence();
    s.seq.markers.push({ id: 'k', time: 30, duration: 0, name: 'Two', note: '', color: '', kind: 'chapter' });
    s.seq.view.inPoint = 12; s.seq.view.outPoint = 96;
    const r = req({ rangeMode: 'inOut', subtitleOutputs: [{ trackId: 'st-en', default: true }, { trackId: 'st-de', forced: true, title: '' }] }, s);
    expect(r.subtitleTracks!.map((t) => [t.id, t.cues.length])).toEqual([['st-en', 1], ['st-de', 1]]); // the hidden track too
    const g = buildRenderGraph(r, { chaptersFilePath: '/tmp/ch.txt', softSubtitleFilePaths: ['/tmp/s0.srt', '/tmp/s1.srt', '/tmp/s2.srt'] });
    const media = g.inputCount;
    expect(g.args.slice(g.args.indexOf('ffmetadata') - 1, g.args.indexOf('-filter_complex_script'))).toEqual([
      '-f', 'ffmetadata', '-i', '/tmp/ch.txt', '-f', 'srt', '-i', '/tmp/s0.srt', '-f', 'srt', '-i', '/tmp/s1.srt',
    ]);
    expect(g.args.filter((a, i) => g.args[i - 1] === '-map')).toEqual(['[vout]', '[aout]', `${media + 1}:s:0`, `${media + 2}:s:0`]);
    expect(after(g.args, '-map_chapters')).toBe(String(media));
    expect(g.subtitleCodecArgs).toEqual(['-c:s', 'subrip']);
    expect(g.streamArgs.slice(-10)).toEqual([
      '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=English', '-disposition:s:0', 'default',
      '-metadata:s:s:1', 'language=ger', '-disposition:s:1', 'forced', // empty title: none written
    ]);
    // SRT relative to the range start (frame 12 = 0.5 s): 24..48 -> 0.5..1.5 s.
    expect(g.softSubtitles[0].content).toContain('00:00:00,500 --> 00:00:01,500\nHi');
    expect(g.softSubtitles.map((x) => [x.trackId, x.language, x.title, x.isDefault, x.forced])).toEqual([['st-en', 'eng', 'English', true, false], ['st-de', 'ger', '', false, true]]);
    expect(g.chapters.map((c) => c.title)).toEqual(['', 'Two']);
  });

  it('soft subtitles: a track without cues in the range is left out with a warning; no paths, none written; never in a chunk graph', () => {
    const s = sequence();
    s.seq.view.inPoint = 60; s.seq.view.outPoint = 96; // after both cues
    const r = req({ rangeMode: 'inOut', subtitleOutputs: [{ trackId: 'st-en' }] }, s);
    const g = buildRenderGraph(r, { softSubtitleFilePaths: ['/tmp/s0.srt'] });
    expect(g.softSubtitles).toEqual([]);
    expect(g.warnings.some((w) => /"English" has no cues/.test(w))).toBe(true);
    expect(g.args).not.toContain('srt');
    const all = req({ subtitleOutputs: [{ trackId: 'st-en' }] });
    const noPaths = buildRenderGraph(all);
    expect([noPaths.softSubtitles, noPaths.subtitleCodecArgs]).toEqual([[], []]);
    expect(noPaths.warnings.some((w) => /no subtitle file paths/.test(w))).toBe(true);
    expect(buildRenderGraph(all, { range: { startF: 0, endF: 48 }, softSubtitleFilePaths: ['/x.srt'] }).softSubtitles).toEqual([]);
    expect(buildRenderGraph(all, { streams: 'audio', softSubtitleFilePaths: ['/x.srt'] }).softSubtitles).toEqual([]);
  });

  it('an audio-only chunk graph builds every output mix; the per-track WAV option keeps one [aout]', () => {
    const s = sequence();
    const g = buildRenderGraph(req({ audioOutputs: twoTracks(s.seq) }, s), { streams: 'audio', range: { startF: 0, endF: 48 }, audioSamples: 96000 });
    expect(g.audioOutputs.map((o) => o.label)).toEqual(['[aout]', '[aout1]']);
    expect(g.filterGraph).toContain('apad=whole_len=96000,atrim=end_sample=96000[aout1]');
    expect(g.streamArgs.slice(0, 2)).toEqual(['-metadata:s:a:0', 'language=eng']);
    const wav = buildRenderGraph(req({ container: 'wav', fileName: 'x.wav', audioOutputs: twoTracks(s.seq) }, s), { audioTrackId: s.seq.audioTracks[1].id });
    expect(wav.audioOutputs.map((o) => o.label)).toEqual(['[aout]']);
    expect(wav.audioCodecArgs).toEqual(['-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '2']);
  });

  it('AC-3 in any output track limits the sample rate (fail-safe for IPC callers)', () => {
    const s = sequence();
    const outs = twoTracks(s.seq);
    expect(usesAc3(settings({ audioOutputs: outs, audioCodec: 'aac' }))).toBe(true);
    expect(usesAc3(settings({ audioOutputs: [{ layout: 'stereo', codec: 'flac' }], audioCodec: 'ac3' }))).toBe(false);
    expect(usesAc3(settings({ audioCodec: 'ac3' }))).toBe(true); // MKV main mix
    const g = buildRenderGraph(req({ audioOutputs: outs, sampleRate: 96000 }, s));
    expect(g.sampleRate).toBe(48000);
    expect(g.warnings.some((w) => /AC-3 audio supports/.test(w))).toBe(true);
  });

  it('the command preview names the soft subtitle files', () => {
    const cmd = buildExportCommand(req({ subtitleOutputs: [{ trackId: 'st-en' }] }));
    expect(cmd.some((a) => /recut-export[\\/]subtitles-0\.srt$/.test(a))).toBe(true);
    expect(cmd).toContain('matroska');
  });
});

// ---------------------------------------------------------------------------------------------------
// Settings, dialog edits, Checks
// ---------------------------------------------------------------------------------------------------

describe('MKV export settings', () => {
  it('stored settings: malformed entries dropped, unknown tracks removed, absent stays absent', () => {
    const { seq } = sequence();
    const saved = {
      ...settings(),
      audioOutputs: [null, 'x', { layout: '7.1', codec: 'opus', sources: [seq.audioTracks[0].id, 'gone', 5], bitrateKbps: -3, title: 'T' }],
      subtitleOutputs: [{ trackId: 'gone' }, { trackId: 'st-en', default: 'yes', forced: true }],
    } as unknown as ExportSettings;
    const s = initialExportSettings(seq, { sequenceId: seq.id, settings: saved }, {});
    expect(s.audioOutputs).toEqual([{ layout: 'stereo', codec: 'aac', sources: [seq.audioTracks[0].id], title: 'T' }]);
    expect(s.subtitleOutputs).toEqual([{ trackId: 'st-en', forced: true }]);
    const plain = initialExportSettings(seq, { sequenceId: seq.id, settings: settings() }, {});
    expect('audioOutputs' in plain || 'subtitleOutputs' in plain).toBe(false);
    expect(sanitizePackaging({ ...settings(), audioOutputs: 'x' as never }, seq).audioOutputs).toBeUndefined();
    // Another sequence: its track ids do not match, so the chosen sources are emptied (the Checks list says so).
    const other = initialExportSettings(sequence().seq, { sequenceId: 'x', settings: { ...settings(), audioOutputs: twoTracks(seq) } }, {});
    expect(other.audioOutputs!.map((o) => o.sources)).toEqual([[], []]);
  });

  it('dialog edits: write the main mix out, add / remove / move, sources, presets', () => {
    const { seq } = sequence();
    let s = settings({ audioCodec: 'ac3', audioChannels: 6, audioBitrateKbps: 640 });
    expect(displayedAudioOutputs(s)).toEqual([{ layout: '5.1', codec: 'ac3', bitrateKbps: 640 }]);
    const apply = (p: Partial<ExportSettings>) => { s = patchExportSettings(s, p); };
    apply(addAudioOutput(s));
    expect(s.audioOutputs!.map((o) => [o.layout, o.codec, o.bitrateKbps])).toEqual([['5.1', 'ac3', 640], ['stereo', 'aac', 256]]);
    apply(updateAudioOutput(s, 1, { title: 'Commentary', language: 'eng' }));
    apply(setAudioOutputSource(s, seq, 1, seq.audioTracks[0].id, false));
    expect(s.audioOutputs![1].sources).toEqual([seq.audioTracks[1].id, seq.audioTracks[2].id]);
    apply(setAudioOutputSource(s, seq, 1, seq.audioTracks[1].id, false));
    expect(s.audioOutputs![1].sources).toEqual([seq.audioTracks[2].id]);
    apply(setAudioOutputSource(s, seq, 1, seq.audioTracks[0].id, true));
    expect(s.audioOutputs![1].sources).toEqual([seq.audioTracks[0].id, seq.audioTracks[2].id]);
    apply(setAudioOutputSource(s, seq, 1, 'all', true));
    expect(s.audioOutputs![1].sources).toBeUndefined();
    apply(setAudioOutputSource(s, seq, 1, 'all', false));
    expect(s.audioOutputs![1].sources).toEqual([]);
    apply(updateAudioOutput(s, 0, { codec: 'flac' }));
    expect(s.audioOutputs![0]).toEqual({ layout: '5.1', codec: 'flac' });
    apply(updateAudioOutput(s, 0, { codec: 'aac' }));
    expect(s.audioOutputs![0].bitrateKbps).toBe(384);
    apply(moveAudioOutput(s, 1, -1));
    expect(s.audioOutputs!.map((o) => o.title)).toEqual(['Commentary', undefined]);
    expect(moveAudioOutput(s, 0, -1)).toEqual({});
    apply(removeAudioOutput(s, 0));
    expect(s.audioOutputs!.length).toBe(1);
    expect(removeAudioOutput(s, 0)).toEqual({});
    apply(applyAudioOutputPreset('main', seq));
    expect(s.audioOutputs).toBeUndefined();
    expect(displayedAudioOutputs(s)).toEqual([{ layout: '5.1', codec: 'ac3', bitrateKbps: 640 }]);
  });

  it('dialog edits: subtitle tracks in sequence order, Default exclusive', () => {
    const { seq } = sequence();
    let s = settings();
    const apply = (p: Partial<ExportSettings>) => { s = patchExportSettings(s, p); };
    apply(setSubtitleIncluded(s, seq, 'st-de', true));
    apply(setSubtitleIncluded(s, seq, 'st-en', true));
    expect(s.subtitleOutputs!.map((o) => o.trackId)).toEqual(['st-en', 'st-de']);
    apply(updateSubtitleOutput(s, 'st-en', { default: true }));
    apply(updateSubtitleOutput(s, 'st-de', { default: true, forced: true }));
    expect(s.subtitleOutputs).toEqual([{ trackId: 'st-en' }, { trackId: 'st-de', default: true, forced: true }]);
    apply(updateSubtitleOutput(s, 'st-de', { forced: false }));
    expect(s.subtitleOutputs![1]).toEqual({ trackId: 'st-de', default: true });
    apply(setSubtitleIncluded(s, seq, 'st-en', false));
    apply(setSubtitleIncluded(s, seq, 'st-de', false));
    expect(s.subtitleOutputs).toBeUndefined();
    expect(softSubtitleTracks(seq, s)).toBeUndefined();
  });

  it('Checks: no sources, muted or empty sources, language codes, AC-3 limits, subtitle tracks', () => {
    const s = sequence();
    const { seq } = s;
    const [a1, , a3] = seq.audioTracks;
    a3.muted = true;
    const outs: ExportSettings['audioOutputs'] = [
      { sources: [], layout: 'stereo', codec: 'aac', title: 'Empty' },
      { sources: [a3.id], layout: 'stereo', codec: 'aac', title: 'Muted' },
      { sources: [a1.id], layout: '5.1', codec: 'ac3', bitrateKbps: 768, language: 'english' },
      { sources: [a1.id], layout: '5.1', codec: 'ac3', bitrateKbps: 32 },
    ];
    const items = packagingChecks(seq, settings({ audioOutputs: outs, subtitleOutputs: [{ trackId: 'gone' }, { trackId: 'st-en', default: true, language: 'en-gb' }, { trackId: 'st-de', default: true }] }), { startF: 0, endF: 96 });
    const text = items.map((i) => `${i.level}: ${i.text}`);
    expect(text).toEqual([
      'error: Audio Track 1 "Empty" (no tracks): choose at least one source track.',
      'warning: Audio Track 2 "Muted" (A3): its source tracks are muted or not soloed, so this track will be silent.',
      'error: Audio Track 3 (A1): the language "english" is not a three-letter ISO 639-2 code (eng, fre, ger, jpn, ...).',
      'error: Audio Track 3 (A1): AC-3 supports at most 640 kbps.',
      'error: Audio Track 4 (A1): AC-3 5.1 needs at least 64 kbps.',
      'warning: 1 chosen subtitle track no longer exists; it is left out.',
      'error: Subtitle track "English": the language "en-gb" is not a three-letter ISO 639-2 code.',
      'warning: More than one subtitle track is marked Default; players show only one of them.',
    ]);
    // No clips in the range; a subtitle track without cues in it.
    const late = packagingChecks(seq, settings({ audioOutputs: [{ sources: [seq.audioTracks[1].id], layout: 'stereo', codec: 'aac' }], subtitleOutputs: [{ trackId: 'st-en' }] }), { startF: 0, endF: 20 });
    expect(late.map((i) => i.text)).toEqual([
      'Audio Track 1 (A2): its source tracks have no clips in the export range, so this track will be silent.',
      'Subtitle track "English" has no cues in the export range and is left out.',
    ]);
    // MP4 ignores MKV settings; the main mix needs nothing.
    expect(packagingChecks(seq, settings({ container: 'mp4', audioOutputs: outs }), { startF: 0, endF: 96 })).toEqual([]);
    expect(packagingChecks(seq, settings(), { startF: 0, endF: 96 })).toEqual([]);
    // The full Checks list: 5.1 output without a 6-channel source.
    expect(exportChecklist(seq, s.media, settings({ audioOutputs: audioOutputPreset('surroundStereo', seq) })).map((i) => i.text))
      .toContain('No source has 6 audio channels; 5.1 output will be upmixed from stereo.');
  });

  it('validation, sample rates, summary and size estimate follow the output tracks', () => {
    const { seq } = sequence();
    const outs = twoTracks(seq);
    expect(validateExportSettings(settings({ audioOutputs: outs, sampleRate: 96000 })).issues.map((i) => i.field)).toEqual(['sampleRate']);
    expect(validateExportSettings(settings({ audioOutputs: [{ layout: 'stereo', codec: 'flac' }], sampleRate: 96000, audioCodec: 'ac3' })).ok).toBe(true);
    expect(validateExportSettings(settings({ qualityMode: 'crf', crf: 99 })).issues.map((i) => i.field)).toEqual(['crf']);
    expect(sampleRateChoices('aac', 48000, { container: 'mkv', audioOutputs: outs })).toEqual([32000, 44100, 48000]);
    expect(sampleRateChoices('aac', 48000, { container: 'mkv' })).toEqual([44100, 48000, 96000]);
    expect(patchExportSettings(settings({ sampleRate: 96000 }), { audioOutputs: outs }).sampleRate).toBe(48000);
    expect(audioSummary(settings({ audioOutputs: outs }))).toBe('2 tracks: AC-3 640 kbps 5.1, AAC 192 kbps stereo');
    expect(audioSummary(settings())).toBe('AAC 320 kbps');
    const one = estimateFileSize(settings({ qualityMode: 'bitrate', videoBitrateKbps: 1000 }), 8);
    const two = estimateFileSize(settings({ qualityMode: 'bitrate', videoBitrateKbps: 1000, audioOutputs: outs }), 8);
    expect(one.bytes).toBe((1000 + 320) * 1000 / 8 * 8);
    expect(two.bytes).toBe((1000 + 640 + 192) * 1000 / 8 * 8);
    expect(patchExportSettings(settings({ container: 'mp4', fileName: 'cut.mp4' }), { container: 'mkv' }).fileName).toBe('cut.mkv');
  });
});
