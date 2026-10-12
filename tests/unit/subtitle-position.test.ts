/**
 * #115: a timeline's subtitle position, shared by the Program and Source monitors and burn-in export.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-sub-pos-'));
process.env.RECUT_CACHE_DIR = path.join(dir, 'cache');

import type { ExportSettings, MediaItem, Rational } from '@shared/model';
import { assSubtitlePosition, subtitleAnchor } from '@shared/subtitlePosition';
import { createMediaItem, createSequence, normalizeProjectWithReport } from '@shared/project';
import { makeClip } from '@shared/timeline';
import { buildBurnInAss, burnInFilter } from '../../electron/export/renderGraph';
import { runExport } from '../../electron/export/exporter';
import { probeMedia } from '../../electron/media/probe';
import { getFfmpegPath } from '../../electron/media/ffmpeg';
import { useStore, resetStore, serializeForSave } from '../../src/state/store';

const exec = promisify(execFile);
const FFMPEG = getFfmpegPath() ?? 'ffmpeg';
const S = () => useStore.getState();

describe('position mapping', () => {
  it('lower half: the text block bottom; upper half: its top; absent or out of range: the default', () => {
    expect(subtitleAnchor(undefined)).toBeNull();
    expect(subtitleAnchor(1.2)).toBeNull();
    expect(subtitleAnchor(0.8)).toEqual({ edge: 'bottom', margin: expect.closeTo(0.2, 6) });
    expect(subtitleAnchor(0.1)).toEqual({ edge: 'top', margin: 0.1 });
    expect(assSubtitlePosition(0.1)).toEqual({ alignment: 8, marginV: 29 }); // 0.1 x 288
    expect(assSubtitlePosition(0.75)).toEqual({ alignment: 2, marginV: 72 });
    expect(assSubtitlePosition(undefined)).toBeNull();
  });

  it('burn-in: SRT gets force_style, the karaoke ASS carries it in its style; default unchanged', () => {
    expect(burnInFilter("'/t/s.srt'", undefined, false)).toBe("subtitles=filename='/t/s.srt'");
    expect(burnInFilter("'/t/s.srt'", 0.1, false)).toBe("subtitles=filename='/t/s.srt':force_style='Alignment=6,MarginV=29'"); // legacy SSA numbering
    expect(burnInFilter("'/t/s.ass'", 0.1, true)).toBe("subtitles=filename='/t/s.ass'");
    const seq = createSequence('S', { num: 25, den: 1 }, 320, 180);
    const cue = { start: 0, end: 1, text: 'Hi there', words: [{ start: 0, end: 0.5, text: 'Hi' }, { start: 0.5, end: 1, text: 'there' }] };
    const style = (pos?: number) => buildBurnInAss({ sequence: { ...seq, subtitlePosition: pos }, media: {}, settings: {} as ExportSettings, subtitles: [cue] }, 0, 25)!
      .split('\n').find((l) => l.startsWith('Style: Default'))!;
    expect(style(undefined).endsWith(',2,10,10,10,1')).toBe(true);
    expect(style(0.1).endsWith(',8,10,10,29,1')).toBe(true);
  });
});

describe('the timeline setting', () => {
  beforeEach(() => resetStore());

  it('is set with one undo step, validated, and cleared back to the default', () => {
    const id = S().project.activeSequenceId!;
    S().updateSequenceSettings(id, { subtitlePosition: 0.07 });
    expect(S().project.sequences[id].subtitlePosition).toBe(0.07);
    S().updateSequenceSettings(id, { subtitlePosition: 3 }); // refused as a whole
    expect(S().project.sequences[id].subtitlePosition).toBe(0.07);
    S().undo();
    expect(S().project.sequences[id].subtitlePosition).toBeUndefined();
    S().redo();
    S().updateSequenceSettings(id, { subtitlePosition: undefined });
    expect(S().project.sequences[id].subtitlePosition).toBeUndefined();
  });

  it('is saved and loaded; an unusable value is dropped on load', () => {
    const id = S().project.activeSequenceId!;
    S().updateSequenceSettings(id, { subtitlePosition: 0.3 });
    const raw = JSON.parse(JSON.stringify(serializeForSave()));
    expect(normalizeProjectWithReport(raw).project.sequences[id].subtitlePosition).toBe(0.3);
    raw.sequences[id].subtitlePosition = 'top';
    const { project, repairs } = normalizeProjectWithReport(raw);
    expect(project.sequences[id].subtitlePosition).toBeUndefined();
    expect(repairs.length).toBeGreaterThan(0);
  });
});

describe('burn-in export puts the text where the setting says', () => {
  const F25: Rational = { num: 25, den: 1 };
  const W = 320, H = 180;
  const file = path.join(dir, 'black.mp4');
  beforeAll(async () => {
    await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=25:d=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
  }, 30_000);
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  /** How many bright (text) pixels the top and bottom fifths of the exported frame have. */
  async function bands(position: number | undefined): Promise<{ top: number; bottom: number }> {
    const m: MediaItem = { ...createMediaItem(file, 'black.mp4'), id: 'm', kind: 'video', probe: await probeMedia(file) };
    const s = { ...createSequence('S', F25, W, H), subtitlePosition: position };
    s.videoTracks[0].clips.push(makeClip({ mediaId: 'm', name: 'v', sourceIn: 0, duration: 25, kind: 'video', linkId: null }, 0));
    const settings: ExportSettings = {
      outputDir: dir, fileName: `pos-${position ?? 'default'}.mp4`, width: W, height: H, fps: F25, videoCodec: 'libx264', qualityMode: 'crf', crf: 10,
      videoBitrateKbps: 2000, preset: 'ultrafast', audioCodec: 'aac', audioBitrateKbps: 128, audioChannels: 2, sampleRate: 48000,
      rangeMode: 'entire', burnSubtitles: true, exportSubtitleSidecar: false, useProxies: false,
    };
    const res = await runExport({ sequence: s, media: { m }, settings, subtitles: [{ start: 0, end: 1, text: 'MMMMMMMMMMMM' }] }, undefined, undefined, { chunked: false });
    // The brightest pixel count in the top and bottom fifths of a frame where the cue is on screen.
    const { stdout } = await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', res.outputPath, '-vf', 'select=eq(n\\,5)', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer' });
    const b = stdout as unknown as Buffer;
    const lit = (y0: number, y1: number) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) if (b[y * W + x] > 128) n++; return n; };
    return { top: lit(0, H / 5), bottom: lit((4 * H) / 5, H) };
  }

  it('default: at the bottom; Top: at the top', async () => {
    const def = await bands(undefined);
    expect(def.bottom).toBeGreaterThan(50);
    expect(def.top).toBe(0);
    const top = await bands(0.07);
    expect(top.top).toBeGreaterThan(50);
    expect(top.bottom).toBe(0);
  }, 120_000);
});
