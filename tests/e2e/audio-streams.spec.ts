/**
 * Per-clip audio streams (Roadmap §2 A): the preview plays the clip's selected audio stream, as the export does.
 *
 * Media (made here with ffmpeg): H.264 video #0, mov_text subtitles #1, AAC 440 Hz stereo #2, AAC 880 Hz mono #3,
 * browser-playable (direct play through HTMLMediaElement.audioTracks).
 *  1. Program monitor: an AnalyserNode on the master bus hears 440 Hz, then 880 Hz after the clip's stream is changed
 *     to #3 with the Clip Inspector picker.
 *  2. Source Monitor plays the media's preferred stream (#3 -> 880 Hz).
 *  3. The export of that clip carries 880 Hz.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { JobInfo } from '../../shared/model';
import { launchApp, importMedia, type LaunchedApp } from './helpers';

test.describe.configure({ mode: 'serial' });

let ctx: LaunchedApp;
let page: Page;
let mediaId: string;
let audioClipId: string;
let file: string;

const evalStore = <T,>(p: Page, fn: string, arg?: unknown): Promise<T> =>
  p.evaluate(({ src, arg }) => {
    const w = window as unknown as { __recut: { store: { getState(): unknown } } };
    // eslint-disable-next-line no-new-func
    return new Function('st', 'arg', `return (${src})(st, arg)`)(w.__recut.store.getState(), arg);
  }, { src: fn, arg }) as Promise<T>;

function makeMedia(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const srt = path.join(dir, 'streams.srt');
  fs.writeFileSync(srt, '1\n00:00:00,500 --> 00:00:11,000\nHello\n\n');
  const out = path.join(dir, 'streams.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=24:d=12', '-i', srt,
    '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=12', '-f', 'lavfi', '-i', 'sine=f=880:r=48000:d=12',
    '-map', '0:v', '-map', '1:s', '-map', '2:a', '-map', '3:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:s', 'mov_text', '-c:a', 'aac', '-ac:a:0', '2', '-ac:a:1', '1',
    '-t', '12', out]);
  return out;
}

/** Dominant frequency (Hz) of a file's first audio stream between t0 and t1, by zero crossings. */
function fileHz(f: string, t0: number, t1: number): number {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-af', `atrim=${t0}:${t1}`, '-f', 's16le', '-'], { maxBuffer: 1 << 26 });
  let zc = 0;
  for (let i = 2; i + 1 < pcm.length; i += 2) if ((pcm.readInt16LE(i) >= 0) !== (pcm.readInt16LE(i - 2) >= 0)) zc++;
  return zc / 2 / (t1 - t0);
}

/**
 * Peak frequencies heard on an AnalyserNode, sampled every 60 ms (silent samples skipped). `node`: 'master' (the
 * Program monitor's master bus, captured by the connect hook) or 'source' (the Source Monitor's <video>).
 */
async function peaks(p: Page, node: 'master' | 'source', samples = 12): Promise<number[]> {
  return p.evaluate(async ({ node, samples }) => {
    const w = window as unknown as Record<string, any>;
    let an: AnalyserNode | undefined = w[`__an_${node}`];
    if (!an) {
      let src: AudioNode;
      if (node === 'master') {
        src = w.__master;
        if (!src) throw new Error('program master bus not captured');
      } else {
        const v = document.querySelector('.source-panel video') as HTMLVideoElement;
        const ac = new AudioContext();
        src = ac.createMediaElementSource(v);
        src.connect(ac.destination);
        w.__sourceCtx = ac;
      }
      an = src.context.createAnalyser();
      an.fftSize = 8192;
      an.smoothingTimeConstant = 0;
      src.connect(an);
      w[`__an_${node}`] = an;
    }
    if (an.context.state !== 'running') await (an.context as AudioContext).resume();
    const buf = new Float32Array(an.frequencyBinCount);
    const out: number[] = [];
    for (let i = 0; i < samples; i++) {
      await new Promise((r) => setTimeout(r, 60));
      an.getFloatFrequencyData(buf);
      let bi = 1;
      for (let k = 2; k < buf.length; k++) if (buf[k] > buf[bi]) bi = k;
      if (buf[bi] > -70) out.push(Math.round(bi * an.context.sampleRate / an.fftSize));
    }
    return out;
  }, { node, samples });
}

const near = (hz: number[], target: number) => hz.filter((h) => Math.abs(h - target) < 30).length;

async function playProgramAndListen(): Promise<number[]> {
  await page.click('[data-testid="program-go-start"]');
  await page.click('[data-testid="program-play"]');
  await page.waitForTimeout(700);
  const hz = await peaks(page, 'master');
  await page.click('[data-testid="program-play"]'); // pause
  return hz;
}

test.beforeAll(async () => {
  ctx = await launchApp();
  page = ctx.page;
  // Capture the Program monitor's master bus: each audio element's gain connects to it (SequencePlayer.audioNodesFor).
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>;
    const orig = AudioNode.prototype.connect as (...a: any[]) => any;
    (AudioNode.prototype as any).connect = function (this: AudioNode, dest: any, ...rest: any[]) {
      if (this instanceof GainNode && dest instanceof GainNode) w.__master = dest;
      return orig.call(this, dest, ...rest);
    };
  });
  file = makeMedia(path.join(ctx.tmp, 'media'));
  [mediaId] = await importMedia(page, [file]);
});

test.afterAll(async () => { await ctx?.app.close(); });

test('the media probes as direct play with two audio streams (#2 440 Hz, #3 880 Hz)', async () => {
  const p = await evalStore<{ audio: number[]; playable: boolean; preferred?: number }>(page,
    '(st, id) => { const m = st.project.media[id]; return { audio: m.probe.audio.map((a) => a.index), playable: m.probe.browserPlayable, preferred: m.preferredAudioStream }; }', mediaId);
  expect(p).toEqual({ audio: [2, 3], playable: true, preferred: 2 });
});

test('Program preview plays the clip stream: 440 Hz, then 880 Hz after the Clip Inspector picker selects #3', async () => {
  const ids = await evalStore<string[]>(page, `(st, mediaId) => {
    const seqId = st.project.activeSequenceId;
    st.updateSequenceSettings(seqId, { fps: { num: 24, den: 1 } });
    return st.insertFromSource(seqId, { mediaId, in: 1, out: 9, atFrame: 0, mode: 'insert' });
  }`, mediaId);
  const kinds = await evalStore<Record<string, { kind: string; stream?: number }>>(page,
    '(st) => { const seq = st.project.sequences[st.project.activeSequenceId]; const out = {}; for (const t of [...seq.videoTracks, ...seq.audioTracks]) for (const c of t.clips) out[c.id] = { kind: c.kind, stream: c.audioStream }; return out; }');
  audioClipId = ids.find((id) => kinds[id].kind === 'audio')!;
  expect(kinds[audioClipId].stream).toBe(2);

  const before = await playProgramAndListen();
  console.log(`[program] stream #2: ${before.join(' ')}`);
  expect(near(before, 440)).toBeGreaterThanOrEqual(before.length / 2);
  expect(near(before, 880)).toBe(0);

  await evalStore(page, '(st, id) => st.select([id])', audioClipId);
  const insp = page.getByTestId('inspector');
  await expect(insp).toHaveAttribute('data-mode', 'clip');
  const picker = insp.getByTestId('clip-audio-stream');
  await picker.scrollIntoViewIfNeeded();
  await expect(picker).toHaveValue('2');
  await picker.selectOption('3');
  expect(await evalStore<number>(page, '(st, id) => { const seq = st.project.sequences[st.project.activeSequenceId]; return seq.audioTracks.flatMap((t) => t.clips).find((c) => c.id === id).audioStream; }', audioClipId)).toBe(3);

  const after = await playProgramAndListen();
  console.log(`[program] stream #3: ${after.join(' ')}`);
  expect(near(after, 880)).toBeGreaterThanOrEqual(after.length / 2);
  expect(near(after, 440)).toBe(0);

  // Undo puts the clip back on #2, and the preview follows.
  await evalStore(page, '(st) => st.undo()');
  const undone = await playProgramAndListen();
  console.log(`[program] undo -> #2: ${undone.join(' ')}`);
  expect(near(undone, 440)).toBeGreaterThanOrEqual(undone.length / 2);
  await evalStore(page, '(st) => st.redo()');
});

test('Source Monitor plays the media preferred stream', async () => {
  await page.evaluate((id) => {
    const w = window as unknown as { __recut: { actions: { setMediaAudioStream(id: string, s?: number): void }; store: { getState(): { setSourceClip(id: string, t: number): void } } } };
    w.__recut.actions.setMediaAudioStream(id, 3);
    w.__recut.store.getState().setSourceClip(id, 1);
  }, mediaId);
  await page.waitForFunction(() => { const v = document.querySelector('.source-panel video') as HTMLVideoElement | null; return !!v && v.readyState >= 2; });
  await page.locator('.source-panel button.play').click();
  await page.waitForTimeout(600);
  const hz = await peaks(page, 'source');
  await page.locator('.source-panel button.play').click();
  console.log(`[source] preferred #3: ${hz.join(' ')}`);
  expect(near(hz, 880)).toBeGreaterThanOrEqual(hz.length / 2);
  expect(near(hz, 440)).toBe(0);
});

test('the export of the clip on stream #3 carries 880 Hz', async () => {
  const outDir = path.join(ctx.tmp, 'export-out');
  fs.mkdirSync(outDir, { recursive: true });
  await evalStore(page, '(st) => st.openDialog("export")');
  const dialog = page.getByTestId('export-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('export-outdir').fill(outDir);
  await page.getByTestId('export-filename').fill('streams-out.mp4');
  await page.getByTestId('export-preset').selectOption('720p Preview');
  await page.getByTestId('export-start').click();
  await page.waitForFunction(() => {
    const w = window as unknown as { __recut: { jobsStore: { getState(): { jobs: JobInfo[] } } } };
    return w.__recut.jobsStore.getState().jobs.some((j) => j.kind === 'export' && (j.status === 'done' || j.status === 'failed' || j.status === 'canceled'));
  }, undefined, { timeout: 150_000 });
  const job = await page.evaluate(() => {
    const w = window as unknown as { __recut: { jobsStore: { getState(): { jobs: JobInfo[] } } } };
    return w.__recut.jobsStore.getState().jobs.find((j) => j.kind === 'export')!;
  });
  expect(job.status, job.error ?? '').toBe('done');
  const hz = fileHz(path.join(outDir, 'streams-out.mp4'), 0.5, 4);
  console.log(`[export] ${hz.toFixed(0)} Hz`);
  expect(Math.abs(hz - 880)).toBeLessThan(30);
});

test('a proxied file (AC-3 second stream) plays the clip stream from its all-stream proxy', async () => {
  await page.keyboard.press('Escape'); // close the export dialog
  const mkv = path.join(ctx.tmp, 'media', 'ac3.mkv');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=24:d=10', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=10', '-f', 'lavfi', '-i', 'sine=f=880:r=48000:d=10',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a:0', 'aac', '-c:a:1', 'ac3', '-ac', '2', '-t', '10', mkv]);
  const [id] = await importMedia(page, [mkv]);
  await page.waitForFunction((id) => {
    const w = window as unknown as { __recut: { store: { getState(): { project: { media: Record<string, { proxy: { status: string } }> } } } } };
    const p = w.__recut.store.getState().project.media[id].proxy;
    return p.status === 'ready' || p.status === 'failed';
  }, id, { timeout: 120_000 });
  const m = await evalStore<{ proxy: { status: string; path?: string }; playable: boolean; audio: number[] }>(page,
    '(st, id) => { const m = st.project.media[id]; return { proxy: m.proxy, playable: m.probe.browserPlayable, audio: m.probe.audio.map((a) => a.index) }; }', id);
  expect(m.playable).toBe(false);
  expect(m.audio).toEqual([1, 2]);
  expect(m.proxy.status).toBe('ready');
  expect(m.proxy.path).toMatch(/_all\.mp4$/);

  // Replace the sequence content with this file.
  const ids = await evalStore<string[]>(page, `(st, mediaId) => {
    const seqId = st.project.activeSequenceId;
    const seq = st.project.sequences[seqId];
    st.select([...seq.videoTracks, ...seq.audioTracks].flatMap((t) => t.clips.map((c) => c.id)));
    st.deleteSelected(seqId);
    return st.insertFromSource(seqId, { mediaId, in: 1, out: 8, atFrame: 0, mode: 'insert' });
  }`, id);
  const aId = await evalStore<string>(page, '(st, ids) => st.project.sequences[st.project.activeSequenceId].audioTracks.flatMap((t) => t.clips).find((c) => ids.includes(c.id)).id', ids);
  const first = await playProgramAndListen();
  console.log(`[proxy] stream #1: ${first.join(' ')}`);
  expect(near(first, 440)).toBeGreaterThanOrEqual(first.length / 2);

  await evalStore(page, '(st, id) => st.select([id])', aId);
  const picker = page.getByTestId('inspector').getByTestId('clip-audio-stream');
  await picker.scrollIntoViewIfNeeded();
  await picker.selectOption('2');
  const second = await playProgramAndListen();
  console.log(`[proxy] stream #2: ${second.join(' ')}`);
  expect(near(second, 880)).toBeGreaterThanOrEqual(second.length / 2);
  expect(near(second, 440)).toBe(0);
  // An all-stream proxy is never stale: no rebuild.
  expect(await evalStore<string>(page, '(st, id) => st.project.media[id].proxy.path', id)).toBe(m.proxy.path);
});
