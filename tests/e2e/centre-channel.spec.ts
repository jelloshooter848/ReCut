/**
 * Extract Centre Channel (Dialogue), Roadmap §9 quick utility.
 *
 * Media (made here with ffmpeg): H.264 video #0 + AC-3 5.1 #1 with one tone per channel (FL 400 Hz, FR 600, FC 1000,
 * LFE 60, BL 1400, BR 1800): Chromium cannot decode AC-3, so the preview needs a channel proxy. A second file has
 * stereo AAC only (no centre channel).
 *  1. Timeline clip context menu › Extract Centre Channel (Dialogue) on the video clip: a linked "(centre)" audio
 *     clip on the free track below, same range, channel FC; the Clip Inspector shows it; one undo step.
 *  2. Its preview audio (a channel proxy) is built, and the Program monitor plays it: with A1 muted the master bus
 *     hears 1000 Hz only.
 *  3. On the stereo file the menu item is disabled and says why; the Clip menu command refuses with a toast.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchApp, importMedia, type LaunchedApp } from './helpers';

test.describe.configure({ mode: 'serial' });

let ctx: LaunchedApp;
let page: Page;
let surroundId: string;
let stereoId: string;
let videoClipId: string;
let centreClipId: string;

const evalStore = <T,>(p: Page, fn: string, arg?: unknown): Promise<T> =>
  p.evaluate(({ src, arg }) => {
    const w = window as unknown as { __recut: { store: { getState(): unknown } } };
    // eslint-disable-next-line no-new-func
    return new Function('st', 'arg', `return (${src})(st, arg)`)(w.__recut.store.getState(), arg);
  }, { src: fn, arg }) as Promise<T>;

function makeMedia(dir: string): { surround: string; stereo: string } {
  fs.mkdirSync(dir, { recursive: true });
  const surround = path.join(dir, 'surround51.mkv');
  const tones = [400, 600, 1000, 60, 1400, 1800].flatMap((f) => ['-f', 'lavfi', '-i', `sine=frequency=${f}:sample_rate=48000:duration=12`]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=24:d=12', ...tones,
    '-filter_complex', '[1:a][2:a][3:a][4:a][5:a][6:a]join=inputs=6:channel_layout=5.1:map=0.0-FL|1.0-FR|2.0-FC|3.0-LFE|4.0-BL|5.0-BR[a]',
    '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-b:a', '448k', surround]);
  const stereo = path.join(dir, 'stereo.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=24:d=6', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-t', '6', stereo]);
  return { surround, stereo };
}

/** Peak frequencies heard on the Program monitor's master bus, sampled every 60 ms (silent samples skipped). */
async function masterPeaks(p: Page, samples = 12): Promise<number[]> {
  return p.evaluate(async (samples) => {
    const w = window as unknown as Record<string, any>;
    let an: AnalyserNode | undefined = w.__an_master;
    if (!an) {
      const src: AudioNode = w.__master;
      if (!src) throw new Error('program master bus not captured');
      an = src.context.createAnalyser();
      an.fftSize = 8192;
      an.smoothingTimeConstant = 0;
      src.connect(an);
      w.__an_master = an;
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
  }, samples);
}

const near = (hz: number[], target: number) => hz.filter((h) => Math.abs(h - target) < 30).length;

async function clipBox(id: string) {
  const loc = page.locator(`[data-clip-id="${id}"]`);
  await loc.scrollIntoViewIfNeeded().catch(() => undefined);
  const b = await loc.boundingBox();
  if (!b) throw new Error(`clip ${id} is not visible in the timeline`);
  return b;
}

async function rightClickClip(id: string): Promise<void> {
  const b = await clipBox(id);
  // Near the clip's left edge (a long clip runs past the visible timeline), clear of the trim handles.
  await page.mouse.click(b.x + Math.min(b.width / 2, 40), b.y + b.height / 2, { button: 'right' });
  await expect(page.locator('.menu-item').first()).toBeVisible();
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
  const files = makeMedia(path.join(ctx.tmp, 'media'));
  [surroundId, stereoId] = await importMedia(page, [files.surround, files.stereo]);
});

test.afterAll(async () => { await ctx?.app.close(); });

test('the surround file probes as AC-3 5.1 (not playable directly)', async () => {
  const p = await evalStore<{ audio: { index: number; codec: string; layout: string }[]; playable: boolean }>(page,
    '(st, id) => { const m = st.project.media[id]; return { audio: m.probe.audio.map((a) => ({ index: a.index, codec: a.codec, layout: a.layout })), playable: m.probe.browserPlayable }; }', surroundId);
  expect(p).toEqual({ audio: [{ index: 1, codec: 'ac3', layout: expect.stringMatching(/^5\.1/) }], playable: false }); // FFmpeg's AC-3 encoder writes 5.1(side)
});

test('timeline context menu › Extract Centre Channel adds a linked centre clip below, as one undo step', async () => {
  const ids = await evalStore<string[]>(page, `(st, mediaId) => {
    const seqId = st.project.activeSequenceId;
    st.updateSequenceSettings(seqId, { fps: { num: 24, den: 1 } });
    st.setView(seqId, { zoom: 2, scroll: 0, playhead: 0 });
    return st.insertFromSource(seqId, { mediaId, in: 1, out: 9, atFrame: 0, mode: 'insert' });
  }`, surroundId);
  const kinds = await evalStore<Record<string, string>>(page,
    '(st) => { const seq = st.project.sequences[st.project.activeSequenceId]; const out = {}; for (const t of [...seq.videoTracks, ...seq.audioTracks]) for (const c of t.clips) out[c.id] = c.kind; return out; }');
  videoClipId = ids.find((id) => kinds[id] === 'video')!;
  const audioClipId = ids.find((id) => kinds[id] === 'audio')!;

  await rightClickClip(videoClipId);
  const item = page.locator('.menu-item', { hasText: 'Extract Centre Channel (Dialogue)' });
  await expect(item).toBeVisible();
  await expect(item).not.toHaveAttribute('aria-disabled', 'true');
  await expect(item).toHaveAttribute('title', /still carries music and effects/);
  await item.click();
  await expect(page.locator('.toast', { hasText: 'Centre channel extracted to A2' })).toBeVisible();

  const r = await evalStore<{ tracks: { name: string; clips: any[] }[]; undo: string }>(page, `(st) => {
    const seq = st.project.sequences[st.project.activeSequenceId];
    return { tracks: seq.audioTracks.map((t) => ({ name: t.name, clips: t.clips })), undo: st.history.pastLabels[st.history.pastLabels.length - 1] };
  }`);
  expect(r.undo).toBe('Extract Centre Channel');
  const [a1, a2] = r.tracks;
  expect(a1.clips.map((c) => c.id)).toEqual([audioClipId]);
  expect(a2.clips).toHaveLength(1);
  const centre = a2.clips[0];
  centreClipId = centre.id;
  expect(centre).toMatchObject({
    name: `${a1.clips[0].name} (centre)`, kind: 'audio', mediaId: surroundId, start: 0, duration: a1.clips[0].duration,
    sourceIn: a1.clips[0].sourceIn, linkId: a1.clips[0].linkId, audioStream: 1, audio: { channelSelection: { mode: 'channel', channel: 'FC' } },
  });
  expect(await evalStore<string[]>(page, '(st) => st.ui.selectedClipIds')).toEqual([centreClipId]);

  // The Clip Inspector shows the selection (only for multichannel streams).
  const insp = page.getByTestId('inspector');
  await expect(insp).toHaveAttribute('data-mode', 'clip');
  const picker = insp.getByTestId('clip-audio-channels');
  await picker.scrollIntoViewIfNeeded();
  await expect(picker).toHaveValue('ch:FC');

  // One undo step removes it; redo brings it back.
  await evalStore(page, '(st) => st.undo()');
  expect(await evalStore<number>(page, '(st) => st.project.sequences[st.project.activeSequenceId].audioTracks[1].clips.length')).toBe(0);
  await evalStore(page, '(st) => st.redo()');
  expect(await evalStore<string>(page, '(st) => st.project.sequences[st.project.activeSequenceId].audioTracks[1].clips[0]?.id')).toBe(centreClipId);
});

test('its preview audio is built, and the Program monitor plays the centre channel only', async () => {
  await page.waitForFunction((id) => {
    const w = window as unknown as { __recut: { store: { getState(): { project: { media: Record<string, { channelProxies?: Record<string, { status: string }> }> } } } } };
    return w.__recut.store.getState().project.media[id].channelProxies?.['1.ch-FC']?.status === 'ready';
  }, surroundId, { timeout: 90_000 });
  await evalStore(page, '(st, id) => st.select([id])', centreClipId); // undo / redo cleared the selection
  const status = page.getByTestId('inspector').getByTestId('clip-channel-preview');
  await status.scrollIntoViewIfNeeded();
  await expect(status).toHaveText('ready');
  // Hear only the centre clip: mute A1 (the normal mix, from the media proxy or nothing).
  await evalStore(page, '(st) => { const seq = st.project.sequences[st.project.activeSequenceId]; st.setTrackFlags(seq.id, seq.audioTracks[0].id, { muted: true }); }');
  await page.click('[data-testid="program-go-start"]');
  await page.click('[data-testid="program-play"]');
  await page.waitForTimeout(700);
  const hz = await masterPeaks(page);
  await page.click('[data-testid="program-play"]'); // pause
  console.log(`[program] centre clip: ${hz.join(' ')}`);
  expect(hz.length).toBeGreaterThanOrEqual(6);
  expect(near(hz, 1000)).toBeGreaterThanOrEqual(hz.length - 1);
  for (const f of [400, 600, 1400, 1800]) expect(near(hz, f)).toBe(0);
});

test('on a stereo source the item is disabled with the reason; the Clip menu command refuses with a toast', async () => {
  const ids = await evalStore<string[]>(page, `(st, mediaId) => {
    const seqId = st.project.activeSequenceId;
    return st.insertFromSource(seqId, { mediaId, in: 0, out: 2, atFrame: 0, mode: 'overwrite' });
  }`, stereoId);
  const kinds = await evalStore<Record<string, string>>(page,
    '(st) => { const seq = st.project.sequences[st.project.activeSequenceId]; const out = {}; for (const t of [...seq.videoTracks, ...seq.audioTracks]) for (const c of t.clips) out[c.id] = c.kind; return out; }');
  const v = ids.find((id) => kinds[id] === 'video')!;
  await evalStore(page, '(st) => st.setView(st.project.activeSequenceId, { scroll: 0, zoom: 2 })');
  await rightClickClip(v);
  const item = page.locator('.menu-item', { hasText: 'Extract Centre Channel (Dialogue)' });
  await expect(item).toHaveAttribute('aria-disabled', 'true');
  await expect(item).toContainText('no centre channel');
  await expect(item).toHaveAttribute('title', /\(stereo\) has no centre channel/);
  await page.keyboard.press('Escape');

  const before = await evalStore<number>(page, '(st) => st.history.past.length');
  await evalStore(page, '(st, id) => st.select([id])', v);
  await page.evaluate(() => (window as unknown as { __recut: { runCommand(id: string): void } }).__recut.runCommand('clip.extractCentreChannel'));
  await expect(page.locator('.toast', { hasText: 'has no centre channel' })).toBeVisible();
  expect(await evalStore<number>(page, '(st) => st.history.past.length')).toBe(before);
});
