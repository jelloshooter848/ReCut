/**
 * Opt-in CPU profile of single store commits on the 2500-clip sequence (attribution for P-xx findings).
 * Runs only with RECUT_PERF_PROFILE=1; prints self-time per function from an inspector CPU profile.
 */
import { it } from 'vitest';
import { Session } from 'node:inspector/promises';
import { useStore, resetStore } from '../../src/state/store';
import type { MediaProbe } from '../../shared/model';
// @ts-expect-error plain JS module shared with the Electron harness
import { buildBigProject } from './bigProject.mjs';

const FPS = { num: 24, den: 1 };
const probe = (duration: number): MediaProbe => ({ container: 'mp4', duration, size: 1, startTime: 0, browserPlayable: true, video: { index: 0, codec: 'h264', width: 640, height: 360, fps: FPS, avgFps: FPS, isVfr: false, pixFmt: 'yuv420p' }, audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }], subtitles: [] });

it.runIf(process.env.RECUT_PERF_PROFILE === '1')('profile commits', async () => {
  resetStore();
  const big = buildBigProject(useStore, Array.from({ length: 7 }, (_, i) => ({ name: `S${i}.mp4`, path: `/m/s${i}.mp4`, probe: probe(60) })), {});
  const S = () => useStore.getState(); const id = big.seqId;
  const ops: Record<string, (i: number) => void> = {
    moveClips: (i) => { const t = S().project.sequences[id].videoTracks[0]; const c = t.clips[40 + i * 5]; S().moveClips(id, [{ clipId: c.id, toTrackId: t.id, toStart: c.start + 7 }], 'overwrite'); },
    deleteSelected: (i) => { const c = S().project.sequences[id].videoTracks[1].clips[100 + i * 3]; S().select([c.id], 'set'); S().deleteSelected(); },
    insertOverwrite: (i) => { S().insertFromSource(id, { mediaId: big.mediaIds[3], in: 1, out: 4, atFrame: 50 + i * 130, mode: 'overwrite' }); },
    razor: (i) => { S().razor(id, 60 + i * 360); },
  };
  const session = new Session(); session.connect();
  await session.post('Profiler.enable'); await session.post('Profiler.setSamplingInterval', { interval: 100 });
  for (const [name, fn] of Object.entries(ops)) {
    for (let i = 0; i < 3; i++) fn(i);
    await session.post('Profiler.start');
    const t = performance.now(); for (let i = 3; i < 23; i++) fn(i); const el = (performance.now() - t) / 20;
    const { profile } = await session.post('Profiler.stop') as any;
    const self = new Map<string, number>(); const dt = profile.timeDeltas as number[]; const byId = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n]));
    profile.samples.forEach((sid: number, k: number) => { const n = byId.get(sid); const cf = n.callFrame; const key = `${cf.functionName || '(anon)'} ${String(cf.url).split('/').slice(-2).join('/')}:${cf.lineNumber + 1}`; self.set(key, (self.get(key) || 0) + (dt[k] || 0)); });
    const total = [...self.values()].reduce((a, b) => a + b, 0);
    console.log(`\n== ${name}: ${el.toFixed(1)} ms/commit; top self time`);
    for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`);
  }
});
