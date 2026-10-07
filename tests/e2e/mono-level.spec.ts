/**
 * Mono sources preview at the level they export at (bugs/closed/2026-10-07-mono-preview-level.md).
 *
 * A stereo export puts a mono stream on both channels at -3.01 dB (FFmpeg's equal-power upmix, electron/export/
 * renderGraph.ts `aformat=...:channel_layouts=stereo`). The Program monitor's speakers hear the master bus up-mixed by
 * the Web Audio destination (mono -> L and R at unity), so a mono stream played directly must be attenuated by 1/sqrt(2)
 * in the preview graph to match. A proxy is stereo-encoded by FFmpeg (`-ac 2`, the same -3.01 dB), so it needs none.
 *
 * Measured here: per-channel RMS of the Program monitor's master bus, up-mixed to stereo exactly as the destination
 * does (a gain node with 2 channels, explicit, speakers, then a ChannelSplitter), for the same 1 kHz tone (peak 0.25, -15.05 dBFS RMS) as
 *  - a stereo WAV (L = R = the tone): reference, exports at -15.05 dBFS per channel;
 *  - a mono WAV, played directly: exports at -18.06 dBFS per channel;
 *  - the mono stream of a two-stream MP4 (stereo #1, mono #2), played directly;
 *  - a mono AC-3 MKV (not browser-playable), played through its proxy.
 * Every mono path must sound 3 dB below the stereo reference on both channels, as in the export.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchApp, importMedia, type LaunchedApp } from './helpers';

test.describe.configure({ mode: 'serial' });

let ctx: LaunchedApp;
let page: Page;
let dir: string;

const evalStore = <T,>(p: Page, fn: string, arg?: unknown): Promise<T> =>
  p.evaluate(({ src, arg }) => {
    const w = window as unknown as { __recut: { store: { getState(): unknown } } };
    // eslint-disable-next-line no-new-func
    return new Function('st', 'arg', `return (${src})(st, arg)`)(w.__recut.store.getState(), arg);
  }, { src: fn, arg }) as Promise<T>;

const TONE = 'sine=f=1000:r=48000:d=12,volume=2'; // sine's amplitude is 1/8: peak 0.25
// The same tone at unity on both channels (`-ac 2` would up-mix it at -3 dB).
const TONE2 = `${TONE},pan=stereo|c0=c0|c1=c0`;
const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

function makeMedia(): Record<'stereo' | 'mono' | 'multi' | 'proxied', string> {
  fs.mkdirSync(dir, { recursive: true });
  const f = (n: string) => path.join(dir, n);
  ff(['-f', 'lavfi', '-i', TONE2, '-c:a', 'pcm_s16le', f('stereo.wav')]);
  ff(['-f', 'lavfi', '-i', TONE, '-ac', '1', '-c:a', 'pcm_s16le', f('mono.wav')]);
  ff(['-f', 'lavfi', '-i', 'testsrc=s=160x120:r=24:d=12', '-f', 'lavfi', '-i', TONE2, '-f', 'lavfi', '-i', TONE,
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-t', '12', f('multi.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc=s=160x120:r=24:d=12', '-f', 'lavfi', '-i', TONE,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-b:a', '192k', '-ac', '1', '-t', '12', f('proxied.mkv')]);
  return { stereo: f('stereo.wav'), mono: f('mono.wav'), multi: f('multi.mp4'), proxied: f('proxied.mkv') };
}

/** Per-channel RMS (dBFS) of the master bus up-mixed to stereo like the destination, averaged over ~1 s of playback. */
async function masterLevels(p: Page): Promise<[number, number]> {
  return p.evaluate(async () => {
    const w = window as unknown as Record<string, any>;
    let tap: { an: AnalyserNode[] } | undefined = w.__monoTap;
    if (!tap) {
      const master: AudioNode = w.__master;
      if (!master) throw new Error('program master bus not captured');
      const ac = master.context;
      // A ChannelSplitter's input is fixed to 'discrete' (mono would land on channel 0 only): up-mix in a gain first.
      const up = ac.createGain();
      up.channelCount = 2; up.channelCountMode = 'explicit'; up.channelInterpretation = 'speakers';
      const split = ac.createChannelSplitter(2);
      const an = [ac.createAnalyser(), ac.createAnalyser()];
      for (const a of an) { a.fftSize = 8192; a.smoothingTimeConstant = 0; }
      master.connect(up); up.connect(split); split.connect(an[0], 0); split.connect(an[1], 1);
      tap = { an }; w.__monoTap = tap;
    }
    if (tap.an[0].context.state !== 'running') await (tap.an[0].context as AudioContext).resume();
    const buf = new Float32Array(8192);
    const sums = [0, 0]; let n = 0;
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 170));
      tap.an.forEach((a, c) => { a.getFloatTimeDomainData(buf); let t = 0; for (const v of buf) t += v * v; sums[c] += t / buf.length; });
      n++;
    }
    return sums.map((s) => 10 * Math.log10(s / n)) as [number, number];
  });
}

/** Replace the sequence content with `mediaId` (seconds 1-9, clip stream `stream`), play it and measure. */
async function previewLevels(mediaId: string, stream?: number): Promise<[number, number]> {
  await evalStore(page, `(st, a) => {
    const seqId = st.project.activeSequenceId;
    const seq = st.project.sequences[seqId];
    const old = [...seq.videoTracks, ...seq.audioTracks].flatMap((t) => t.clips.map((c) => c.id));
    if (old.length) { st.select(old); st.deleteSelected(seqId); }
    const ids = st.insertFromSource(seqId, { mediaId: a.mediaId, in: 1, out: 9, atFrame: 0, mode: 'insert' });
    if (a.stream !== undefined) {
      const s = window.__recut.store.getState().project.sequences[seqId];
      st.setClipAudioStream(seqId, s.audioTracks.flatMap((t) => t.clips).filter((c) => ids.includes(c.id)).map((c) => c.id), a.stream);
    }
  }`, { mediaId, stream });
  if (stream !== undefined) {
    expect(await evalStore<number[]>(page, '(st) => st.project.sequences[st.project.activeSequenceId].audioTracks.flatMap((t) => t.clips).map((c) => c.audioStream)')).toEqual([stream]);
  }
  await page.click('[data-testid="program-go-start"]');
  await page.click('[data-testid="program-play"]');
  await page.waitForTimeout(900);
  const lv = await masterLevels(page);
  await page.click('[data-testid="program-play"]'); // pause
  return lv;
}

const levels: Record<string, [number, number]> = {};

test.beforeAll(async () => {
  ctx = await launchApp();
  page = ctx.page;
  dir = path.join(ctx.tmp, 'media');
  // Capture the Program monitor's master bus: each audio element's gain connects to it (SequencePlayer.audioNodesFor).
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>;
    const orig = AudioNode.prototype.connect as (...a: any[]) => any;
    (AudioNode.prototype as any).connect = function (this: AudioNode, dest: any, ...rest: any[]) {
      if (this instanceof GainNode && dest instanceof GainNode) w.__master = dest;
      return orig.call(this, dest, ...rest);
    };
  });
});

test.afterAll(async () => { await ctx?.app.close(); });

test('a mono source previews 3 dB below the same tone in stereo, on both channels, as it exports', async () => {
  const files = makeMedia();
  const [stereo, mono, multi, proxied] = await importMedia(page, [files.stereo, files.mono, files.multi, files.proxied]);
  await evalStore(page, '(st) => st.updateSequenceSettings(st.project.activeSequenceId, { fps: { num: 24, den: 1 } })');
  const probe = await evalStore<{ playable: boolean; audio: { index: number; channels: number }[] }[]>(page,
    '(st, ids) => ids.map((id) => ({ playable: st.project.media[id].probe.browserPlayable, audio: st.project.media[id].probe.audio.map((a) => ({ index: a.index, channels: a.channels })) }))',
    [stereo, mono, multi, proxied]);
  expect(probe.map((p) => p.playable)).toEqual([true, true, true, false]);
  expect(probe[2].audio).toEqual([{ index: 1, channels: 2 }, { index: 2, channels: 1 }]);

  levels.stereo = await previewLevels(stereo);
  levels.mono = await previewLevels(mono);
  levels.multiStereo = await previewLevels(multi, 1);
  levels.multiMono = await previewLevels(multi, 2);
  await page.waitForFunction((id) => {
    const w = window as unknown as { __recut: { store: { getState(): { project: { media: Record<string, { proxy: { status: string } }> } } } } };
    const s = w.__recut.store.getState().project.media[id].proxy.status;
    return s === 'ready' || s === 'failed';
  }, proxied, { timeout: 120_000 });
  expect(await evalStore<string>(page, '(st, id) => st.project.media[id].proxy.status', proxied)).toBe('ready');
  levels.proxiedMono = await previewLevels(proxied);
  for (const [k, [l, r]] of Object.entries(levels)) console.log(`[mono-level] ${k}: L ${l.toFixed(2)} dBFS, R ${r.toFixed(2)} dBFS`);

  const ref = levels.stereo;
  // The stereo reference plays at the file level (-15.05 dBFS RMS per channel), as it exports.
  for (const c of [0, 1]) expect(Math.abs(ref[c] - -15.05)).toBeLessThan(0.5);
  for (const c of [0, 1]) expect(Math.abs(levels.multiStereo[c] - ref[c])).toBeLessThan(0.5);
  for (const k of ['mono', 'multiMono', 'proxiedMono']) {
    for (const c of [0, 1]) expect(levels[k][c] - ref[c], `${k} channel ${c}`).toBeGreaterThan(-3.5);
    for (const c of [0, 1]) expect(levels[k][c] - ref[c], `${k} channel ${c}`).toBeLessThan(-2.5);
  }
});
