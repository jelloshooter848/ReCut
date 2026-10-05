/**
 * Follow-ups to frame-rate validation (shared/time.ts isValidFps is the single rule):
 *  1. export settings / render graph use the shared rule;
 *  2. sequence settings changes (store, conform prompt, sequence dialog) never store an invalid fps / size / audio format;
 *  3. media with an unknown probe frame rate ({num:0,den:1}) never produces NaN timecodes or a dead edit-point jump;
 *  4. typed timecode digits are never silently truncated.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// The command layer touches `window` (toasts, layout store). Provide a bare window without the Electron bridge.
vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g.window) g.window = globalThis;
  (g.window as Record<string, unknown>).recut = undefined;
});

import type { ExportSettings, MediaItem, MediaProbe, Rational, Sequence } from '../../shared/model';
import { createMediaItem, createSequence } from '../../shared/project';
import { makeClip } from '../../shared/timeline';
import { useStore, resetStore } from '../../src/state/store';
import { originalTimecode } from '../../src/state/selectors';
import { effectiveExportFps, exportChecklist, exportOutputFrames, initialExportSettings } from '../../src/panels/export/settings';
import { buildRenderGraph } from '../../electron/export/renderGraph';
import { conformTargetFor } from '../../src/panels/source/insert';
import { matchMediaSettings } from '../../src/app/dialogs/NewSequenceDialog';
import { mediaFps as transcriptMediaFps, sourceTimecode } from '../../src/panels/transcript/shared';
import { mediaFps as sceneMediaFps } from '../../src/panels/scenes/sceneUtils';
import { registerEditingCommands } from '../../src/app/commands';
import { registerShellCommands } from '../../src/keyboard/commands';
import { registerTransport, setActiveTransport, type Transport } from '../../src/app/transport';
import { runCommand } from '../../src/keyboard/shortcuts';
import { COMMAND_IDS } from '../../src/keyboard/commandIds';
import { expandTimecodeDigits, parseTimecodeEntry } from '../../src/components/ui/TimecodeField';

const R = (num: number, den = 1): Rational => ({ num, den });
const F23 = R(24000, 1001), F24 = R(24), F30 = R(30);
const UNKNOWN = R(0, 1);
/** Rates the old export validator (positive safe integers) accepted but the shared rule (1..1000 fps, terms <= 1e6) rejects. */
const OUT_OF_RANGE = [R(5000), R(1, 2), R(90000), R(2_000_000, 1001), R(24_000_000, 1_001_000)];

function probe(fps: Rational, over: Partial<MediaProbe> = {}): MediaProbe {
  return {
    container: 'matroska', duration: 100, size: 1000, startTime: 0, browserPlayable: true,
    video: { index: 0, codec: 'h264', width: 1280, height: 720, fps, avgFps: fps, isVfr: false },
    audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
    subtitles: [], ...over,
  };
}
function media(fps: Rational, name = 'm.mkv'): MediaItem {
  return { ...createMediaItem(`/media/${name}`, name), kind: 'video', probe: probe(fps) };
}

const S = () => useStore.getState();

// ------------------------------------------------------------------------------------------- 1
describe('export fps uses the shared isValidFps rule', () => {
  const settings = (fps: Rational): ExportSettings => ({
    outputDir: '/out', fileName: 'x.mp4', width: 64, height: 36, fps,
    videoCodec: 'libx264', qualityMode: 'crf', crf: 10, videoBitrateKbps: 2000, preset: 'ultrafast',
    audioCodec: 'aac', audioBitrateKbps: 128, audioChannels: 2, sampleRate: 48000,
    rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false,
  });

  it('dialog helpers fall back to the sequence rate for out-of-range rates, with a warning', () => {
    const s = createSequence('H', F23, 64, 36);
    for (const bad of OUT_OF_RANGE) {
      const k = `${bad.num}/${bad.den}`;
      expect(effectiveExportFps({ fps: bad }, s), k).toBe(s.fps);
      expect(exportOutputFrames(48, s, { fps: bad }), k).toBe(48);
      expect(initialExportSettings(s, { sequenceId: s.id, settings: settings(bad) }, {}).fps, k).toEqual(F23);
      expect(exportChecklist(s, {}, settings(bad)).some((i) => i.level === 'warning' && i.text.includes('not valid')), k).toBe(true);
    }
    expect(effectiveExportFps({ fps: F30 }, s)).toEqual(F30);
  });

  it('the render graph falls back to the sequence rate for out-of-range rates, with a warning', () => {
    const m = media(F23);
    const s = createSequence('H', F23, 64, 36);
    s.videoTracks[0].clips.push(makeClip({ mediaId: m.id, name: 'v', sourceIn: 0, duration: 30, kind: 'video' }, 0));
    for (const bad of OUT_OF_RANGE) {
      const g = buildRenderGraph({ sequence: s, media: { [m.id]: m }, settings: settings(bad) });
      expect(g.outputFps, `${bad.num}/${bad.den}`).toEqual(F23);
      expect(g.outputFrameCount).toBe(30);
      expect(g.warnings.some((w) => w.includes('not valid'))).toBe(true);
    }
  });
});

// ------------------------------------------------------------------------------------------- 2
describe('sequence settings never store invalid values', () => {
  let seqId: string;
  beforeEach(() => {
    resetStore();
    const s = createSequence('Seq', F24, 1920, 1080);
    S().addSequence(s);
    seqId = s.id;
    S().clearHistory();
  });
  const seq = (): Sequence => S().project.sequences[seqId];

  it('updateSequenceSettings rejects invalid fps / size / audio patches and leaves no undo step', () => {
    const bad: Record<string, unknown>[] = [
      { fps: UNKNOWN }, { fps: R(30, 0) }, { fps: R(-24) }, { fps: R(29.97) }, { fps: R(NaN) }, { fps: R(90000) }, { fps: null },
      { width: 0 }, { width: -2 }, { width: 1.5 }, { width: NaN }, { height: 0 }, { height: Infinity },
      { sampleRate: 0 }, { sampleRate: NaN }, { channels: 0 }, { channels: 2.5 },
      { name: 42 }, { versionLabel: 7 }, { binId: 3 },
      // one bad field rejects the whole patch (no half-applied conform)
      { fps: F30, width: 1280, height: 0 },
    ];
    const binId = seq().binId;
    for (const patch of bad) {
      S().updateSequenceSettings(seqId, patch as never);
      const s = seq();
      expect([s.fps, s.width, s.height, s.sampleRate, s.channels, s.name], JSON.stringify(patch)).toEqual([F24, 1920, 1080, 48000, 2, 'Seq']);
      expect(s.versionLabel).toBeUndefined();
      expect(s.binId).toBe(binId);
    }
    expect(S().history.past.length).toBe(0);
  });

  it('updateSequenceSettings still applies valid patches', () => {
    S().updateSequenceSettings(seqId, { fps: F23, width: 1280, height: 720, sampleRate: 44100, channels: 6, name: 'Renamed', versionLabel: 'v2' });
    expect(seq()).toMatchObject({ fps: F23, width: 1280, height: 720, sampleRate: 44100, channels: 6, name: 'Renamed', versionLabel: 'v2' });
    S().updateSequenceSettings(seqId, { versionLabel: undefined, binId: 'bin-sequences' });
    expect(seq().versionLabel).toBeUndefined();
    expect(seq().binId).toBe('bin-sequences');
    S().updateSequenceSettings(seqId, { binId: null });
    expect(seq().binId).toBeNull();
  });

  it('the conform prompt never targets a frame rate the shared rule rejects', () => {
    const s = createSequence('Empty', F24, 1920, 1080);
    for (const bad of [UNKNOWN, R(90000), R(1, 2), R(5000)]) expect(conformTargetFor(s, media(bad)), `${bad.num}/${bad.den}`).toBeNull();
    expect(conformTargetFor(s, media(F23))).toEqual({ fps: F23, width: 1280, height: 720 });
  });

  it('Match Media in the sequence dialog only takes a valid frame rate / audio format', () => {
    const form = { name: 'Sequence 01', fps: F24, width: 1920, height: 1080, sampleRate: 48000, channels: 2 };
    for (const bad of [UNKNOWN, R(90000), R(5000)]) {
      const p = probe(bad);
      expect(matchMediaSettings(p, form).fps, `${bad.num}/${bad.den}`).toEqual(F24);
    }
    // VFR: the average rate when valid, else the nominal rate when valid
    expect(matchMediaSettings(probe(F30, { video: { ...probe(F30).video!, isVfr: true, avgFps: F23 } }), form).fps).toEqual(F23);
    expect(matchMediaSettings(probe(F30, { video: { ...probe(F30).video!, isVfr: true, avgFps: UNKNOWN } }), form).fps).toEqual(F30);
    expect(matchMediaSettings(probe(F23), form)).toMatchObject({ fps: F23, width: 1280, height: 720, sampleRate: 48000, channels: 2 });
    const noAudioRate = probe(F23, { audio: [{ index: 1, codec: 'aac', channels: 6, layout: '5.1', sampleRate: 0 }] });
    expect(matchMediaSettings(noAudioRate, form)).toMatchObject({ sampleRate: 48000, channels: 6 });
    const noSize = probe(F23, { video: { ...probe(F23).video!, width: 0, height: 0 } });
    expect(matchMediaSettings(noSize, form)).toMatchObject({ width: 1920, height: 1080 });
  });
});

// ------------------------------------------------------------------------------------------- 3
describe('unknown probe frame rate ({num:0,den:1}) falls back instead of producing NaN', () => {
  it('transcript / scene source timecodes fall back to the given rate', () => {
    const m = media(UNKNOWN);
    expect(transcriptMediaFps(m, F24)).toEqual(F24);
    expect(transcriptMediaFps(m)).toEqual(F23);
    expect(sourceTimecode(61.5, m, F24)).toBe('00:01:01:12');
    expect(sceneMediaFps(m, F24)).toEqual(F24);
    expect(sceneMediaFps(m)).toEqual(F23);
    expect(sceneMediaFps(media(R(90000)), F24)).toEqual(F24);
    expect(transcriptMediaFps(media(F30), F24)).toEqual(F30);
    expect(sceneMediaFps(media(F30), F24)).toEqual(F30);
  });

  it('original timecode of a clip uses the sequence rate when the media rate is unknown', () => {
    const m = media(UNKNOWN);
    const clip = makeClip({ mediaId: m.id, name: 'v', sourceIn: 10, duration: 48, kind: 'video' }, 0);
    const tc = originalTimecode(clip, 12, F24, m);
    expect(tc.sourceTimecode).toBe('00:00:10:12');
  });

  describe('source edit-point jumps', () => {
    beforeAll(() => { registerShellCommands(); registerEditingCommands(); });
    it('jump to detected scenes using the sequence rate', () => {
      resetStore();
      setActiveTransport(null);
      const m = media(UNKNOWN);
      S().addMedia([m]);
      const s = createSequence('Seq', F24);
      S().addSequence(s);
      const calls: string[] = [];
      const t = { id: 'source', seekFrame: (f: number) => { calls.push(`seek:${f}`); }, currentFrame: () => 0, isPlaying: () => false } as unknown as Transport;
      const off = registerTransport(t);
      try {
        S().setDetectedScenes(m.id, [10, 20], 100);
        S().setSourceClip(m.id, 12);
        runCommand(COMMAND_IDS.nextEdit);
        expect(calls.at(-1)).toBe(`seek:${20 * 24}`);
      } finally { off(); }
    });
  });
});

// ------------------------------------------------------------------------------------------- 4
describe('typed timecode digits are never truncated', () => {
  it('more than eight digits is invalid instead of dropping the leading digits', () => {
    expect(parseTimecodeEntry('123456789', F24)).toBeNull();
    expect(parseTimecodeEntry('0000000012', F24)).toBeNull();
    expect(expandTimecodeDigits('123456789')).not.toBe('23:45:67:89');
    // eight digits still fill HH:MM:SS:FF
    expect(expandTimecodeDigits('01020304')).toBe('01:02:03:04');
    expect(parseTimecodeEntry('01020304', F24)).toBe(((1 * 3600) + (2 * 60) + 3) * 24 + 4);
  });
});
