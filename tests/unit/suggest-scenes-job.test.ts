/**
 * #151: Suggest Scenes analysis runs as a main-process job (listed in Jobs, cancellable); the review opens when it
 * finishes, also after Run in Background.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-suggest-'));
process.env.RECUT_CACHE_DIR = path.join(tmp, 'cache');

import { getFfmpegPath } from '../../electron/media/ffmpeg';
import { JobQueue } from '../../electron/jobs/jobQueue';
import { startSuggestScenesJob } from '../../electron/media/suggestScenes';
import { histSimilarity } from '../../shared/sceneSuggest';
import type { SuggestScenesResult } from '../../shared/ipc';
import { createMediaItem } from '../../shared/project';
import { getToasts } from '../../src/components/ui/toastStore';
import { useStore, resetStore } from '../../src/state/store';
import { suggestJobFinished, useSuggestStore, validAnalysis } from '../../src/panels/project/suggestScenes';

(globalThis as unknown as { window?: unknown }).window ??= globalThis;
const FF = getFfmpegPath() ?? 'ffmpeg';
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('analysis job (main process)', () => {
  it('one histogram per shot from the frames inside it, one sound score per cut; progress reported', async () => {
    const file = path.join(tmp, 'places.mp4');
    const colors = ['0xC82020', '0xB42A26', '0x2028C8', '0x2A34B4', '0x28BE32'];
    execFileSync(FF, ['-v', 'error', '-y', ...colors.flatMap((c) => ['-f', 'lavfi', '-i', `color=c=${c}:s=320x180:r=24:d=2`]),
      '-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=10',
      '-filter_complex', `${colors.map((_, i) => `[${i}:v]`).join('')}concat=n=${colors.length}:v=1:a=0[v]`,
      '-map', '[v]', '-map', '5:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
    const q = new JobQueue({ throttleMs: 0 });
    const shots = [0, 2, 4, 6, 8].map((s) => ({ start: s, end: s + 2 }));
    const job = startSuggestScenesJob(q, { mediaId: 'm', name: 'places', shots, videoPath: file, audioPath: file, duration: 10 });
    expect(job.kind).toBe('suggestScenes');
    expect(job.title).toBe('Suggest scenes · places');
    expect(startSuggestScenesJob(q, { mediaId: 'm', shots, videoPath: file, duration: 10 }).id).toBe(job.id); // de-duped per media
    const done = await q.waitFor(job.id);
    expect(done.status, done.error).toBe('done');
    const r = done.result as SuggestScenesResult;
    expect(r.hists).toHaveLength(5);
    const sim = (a: number, b: number) => histSimilarity(r.hists[a]!, r.hists[b]!);
    expect(sim(0, 1)).toBeGreaterThan(0.7);  // two reds
    expect(sim(1, 2)).toBeLessThan(0.55);    // red / blue
    expect(sim(2, 3)).toBeGreaterThan(0.7);  // two blues
    expect(r.audioLinks).toHaveLength(4);
    for (const a of r.audioLinks) expect(a).toBeGreaterThan(0.8); // a steady tone carries across every cut
  }, 60_000);
});

describe('review after the job (renderer)', () => {
  const S = () => useStore.getState();
  beforeEach(() => {
    resetStore();
    useSuggestStore.setState({ results: {}, open: null, waiting: {} });
  });
  const addMedia = (name: string) => {
    const m = { ...createMediaItem(`/m/${name}`, name), kind: 'video' as const };
    S().addMedia([m]);
    S().setDetectedScenes(m.id, [2, 4], 6);
    return m.id;
  };
  const result: SuggestScenesResult = { hists: [null, null, null], audioLinks: [null, null] };

  it('Run in Background then done: the review opens', () => {
    const id = addMedia('a.mp4');
    useSuggestStore.setState({ waiting: { [id]: true }, open: null }); // dialog closed with Run in Background
    suggestJobFinished(id, 'done', result);
    expect(useSuggestStore.getState().open).toBe(id);
    expect(validAnalysis(S().project.media[id])).not.toBeNull();
  });

  it('another review already open: it waits (toast), and the result is kept for Suggest Scenes…', () => {
    const a = addMedia('a.mp4'), b = addMedia('b.mp4');
    useSuggestStore.setState({ waiting: { [b]: true }, open: a });
    suggestJobFinished(b, 'done', result);
    expect(useSuggestStore.getState().open).toBe(a);
    expect(getToasts().at(-1)?.text).toMatch(/ready/);
    expect(validAnalysis(S().project.media[b])).not.toBeNull();
  });

  it('a stale result (the shots changed) is not used; failed / canceled close the dialog', () => {
    const id = addMedia('a.mp4');
    suggestJobFinished(id, 'done', result);
    S().setDetectedScenes(id, [3], 6);
    expect(validAnalysis(S().project.media[id])).toBeNull();
    useSuggestStore.setState({ waiting: { [id]: true }, open: id });
    suggestJobFinished(id, 'canceled', null);
    expect(useSuggestStore.getState().open).toBeNull();
  });
});
