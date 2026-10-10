/**
 * bugs/closed/2026-10-08-job-mirror-marks-saved-project-dirty.md @ 59eafc6
 *
 * Background job results mirrored into the project (proxy / channel-proxy / scene-detect status and results) are
 * written to the .recut but are not edits: every one of them can be made again from the content-keyed cache. They
 * must not mark the project dirty (no "Save changes?" on quit, no title-bar marker, no autosave and so no recovery
 * prompt after a clean save + quit), and they are still written by the next save / autosave. Edits (and the probe
 * that completes an import or relink) keep marking it dirty.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore, resetStore } from '../../src/state/store';
import { autosaveProject, saveProject, setAutosaveRequester } from '../../src/state/mediaActions';
import { routeJobs, resetJobsRouter } from '../../src/app/jobsRouter';
import { getBeforeQuitHandler } from '../../src/app/bootstrap';
import { initProjectLifecycle } from '../../src/app/project';
import { useShellStore } from '../../src/app/shellStore';
import { createMediaItem } from '../../shared/project';
import type { JobInfo, MediaItem, MediaProbe } from '../../shared/model';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const g = globalThis as Any;
const S = () => useStore.getState();
const FPS = { num: 24, den: 1 };

function fakeProbe(duration = 100): MediaProbe {
  return {
    container: 'mp4', duration, size: 1000, startTime: 0, browserPlayable: false,
    video: { index: 0, codec: 'hevc', width: 1920, height: 1080, fps: FPS, avgFps: FPS, isVfr: false },
    audio: [{ index: 1, codec: 'ac3', channels: 2, layout: 'stereo', sampleRate: 48000 }],
    subtitles: [],
  };
}

interface Write { kind: 'save' | 'autosave'; path: string | null; json: string; resolve: () => void }
let writes: Write[];
/** When false, writes resolve as soon as they are made; else the test resolves them. */
let holdWrites: boolean;

function fakeApi(extra: Record<string, unknown> = {}) {
  const make = (kind: Write['kind']) => (path: string | null, json: string) => new Promise((r) => {
    const w: Write = { kind, path, json, resolve: () => r({ ok: true, path: path ?? '/autosave' }) };
    writes.push(w);
    if (!holdWrites) w.resolve();
  });
  g.recut = { saveProjectJson: make('save'), autosaveProjectJson: make('autosave'), ...extra };
  return g.recut;
}

async function untilWrites(n: number): Promise<void> {
  for (let i = 0; i < 200 && writes.length < n; i++) await new Promise((r) => setTimeout(r, 0));
}
const mediaIn = (json: string, id: string) => JSON.parse(json).media[id] as MediaItem;

let media: MediaItem;

function job(p: Partial<JobInfo>): JobInfo {
  return { id: 'job-1', kind: 'proxy', title: 'Proxy', status: 'queued', progress: 0, createdAt: 1, mediaId: media.id, ...p } as JobInfo;
}

/** A project with one imported, probed media item, saved to /p/edit.recut (clean). */
async function savedProject(): Promise<void> {
  S().renameProject('Cut');
  S().addMedia([media]);
  S().setMediaProbe(media.id, fakeProbe());
  const res = await saveProject('/p/edit.recut');
  expect(res.ok).toBe(true);
  expect(S().dirty).toBe(false);
}

beforeEach(() => {
  resetStore();
  resetJobsRouter();
  g.window = globalThis;
  writes = [];
  holdWrites = false;
  media = { ...createMediaItem('/media/movie.mp4', 'movie.mp4'), kind: 'video' };
});
afterEach(() => {
  vi.useRealTimers();
  delete g.recut;
  delete g.window;
});

describe('job mirrors do not mark a saved project dirty', () => {
  it('each job mirror setter leaves a clean project clean, with no undo step and redo kept', async () => {
    fakeApi();
    await savedProject();
    S().renameProject('Other');
    S().undo(); // a redo step to keep
    await saveProject();
    expect(S().dirty).toBe(false);
    const past = S().history.past.length;
    const mirrors: [string, () => void][] = [
      ['setProxy queued', () => S().setProxy(media.id, { status: 'queued', progress: 0 })],
      ['setProxy running', () => S().setProxy(media.id, { status: 'running', progress: 0.2 })],
      ['setProxy ready', () => S().setProxy(media.id, { status: 'ready', path: '/cache/p.mp4', progress: 1 })],
      ['invalidateProxy', () => S().invalidateProxy(media.id)],
      ['setProxy failed', () => S().setProxy(media.id, { status: 'failed', error: 'x' })],
      ['setChannelProxies', () => S().setChannelProxies(media.id, { '1:L': { status: 'ready', path: '/cache/c.m4a' } })],
      ['setChannelProxies remove', () => S().setChannelProxies(media.id, { '1:L': null })],
      ['setSceneDetectStatus', () => S().setSceneDetectStatus(media.id, 'running')],
      ['setDetectedScenes', () => S().setDetectedScenes(media.id, [10, 20], 100)],
      ['setOffline', () => S().setOffline(media.id, true)],
    ];
    for (const [name, run] of mirrors) {
      const before = S().project;
      run();
      expect(S().project, name).not.toBe(before); // it did change the project
      expect(S().dirty, name).toBe(false);
    }
    expect(S().history.past.length).toBe(past);
    expect(S().canRedo()).toBe(true);
    expect(S().project.media[media.id].detectedScenes).toHaveLength(3);
  });

  it('a proxy job finishing (jobsRouter) after a clean save leaves the project clean', async () => {
    fakeApi();
    await savedProject();
    routeJobs([job({ status: 'queued' })]);
    routeJobs([job({ status: 'running', progress: 0.5 })]);
    routeJobs([job({ status: 'done', progress: 1, result: { path: '/cache/movie_540.mp4', width: 960, height: 540, audioStreams: [1] } })]);
    expect(S().project.media[media.id].proxy).toMatchObject({ status: 'ready', path: '/cache/movie_540.mp4' });
    expect(S().dirty).toBe(false);
  });

  it('a scene-detect job finishing after a clean save leaves the project clean', async () => {
    fakeApi();
    await savedProject();
    routeJobs([job({ kind: 'sceneDetect', status: 'running' })]);
    routeJobs([job({ kind: 'sceneDetect', status: 'done', result: { boundaries: [12, 40], duration: 100 } })]);
    expect(S().project.media[media.id].detectedScenes).toHaveLength(3);
    expect(S().dirty).toBe(false);
  });

  it('quit right after a clean save + a proxy job finishing quits without the Save changes? prompt', async () => {
    const message = vi.fn(async () => 2);
    const quit = vi.fn(async () => undefined);
    const quitCancel = vi.fn(async () => undefined);
    fakeApi({ quitAck: vi.fn(async () => undefined), quit, quitCancel, message });
    const dispose = initProjectLifecycle();
    try {
      await savedProject();
      routeJobs([job({ status: 'done', progress: 1, result: { path: '/cache/movie_540.mp4', width: 960, height: 540 } })]);
      expect(useShellStore.getState().dirty).toBe(false); // no title-bar marker
      await getBeforeQuitHandler()();
      expect(message).not.toHaveBeenCalled();
      expect(quit).toHaveBeenCalledWith(true);
      expect(quitCancel).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('nothing is autosaved for a mirror after a clean save (no recovery prompt after quit)', async () => {
    fakeApi();
    await savedProject();
    S().setProxy(media.id, { status: 'ready', path: '/cache/p.mp4' });
    await autosaveProject();
    expect(writes.filter((w) => w.kind === 'autosave')).toHaveLength(0);
  });

  it('a mirror landing while a save of an edited project is in flight: the project is clean after the save, no follow-up autosave', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const requested: number[] = [];
    const restore = setAutosaveRequester(() => { requested.push(1); });
    try {
      fakeApi();
      await savedProject();
      holdWrites = true;
      S().renameProject('Edited');
      const save = saveProject();
      await vi.waitFor(() => expect(writes).toHaveLength(2));
      S().setProxy(media.id, { status: 'ready', path: '/cache/p.mp4' }); // lands mid-save
      writes[1].resolve();
      expect((await save).ok).toBe(true);
      expect(S().dirty).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requested).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

describe('job mirrors are still written', () => {
  it('the next save writes a mirror that arrived after the last one', async () => {
    fakeApi();
    await savedProject();
    S().setProxy(media.id, { status: 'ready', path: '/cache/p.mp4', width: 960, height: 540 });
    S().setDetectedScenes(media.id, [10], 100);
    await saveProject();
    const m = mediaIn(writes[writes.length - 1].json, media.id);
    expect(m.proxy).toMatchObject({ status: 'ready', path: '/cache/p.mp4' });
    expect(m.detectedScenes).toHaveLength(2);
  });

  it('a later edit makes the project dirty, and its autosave (crash recovery) holds the edit and the mirror', async () => {
    fakeApi();
    await savedProject();
    S().setProxy(media.id, { status: 'ready', path: '/cache/p.mp4' });
    expect(S().dirty).toBe(false);
    S().renameProject('Edited after the proxy');
    expect(S().dirty).toBe(true);
    await autosaveProject();
    const auto = writes.filter((w) => w.kind === 'autosave');
    expect(auto).toHaveLength(1);
    expect(JSON.parse(auto[0].json).name).toBe('Edited after the proxy');
    expect(mediaIn(auto[0].json, media.id).proxy).toMatchObject({ status: 'ready', path: '/cache/p.mp4' });
  });

  it('a mirror does not hide an edit: an edited project stays dirty through mirrors, and undo still marks it dirty', async () => {
    fakeApi();
    await savedProject();
    S().renameProject('Edited');
    S().setProxy(media.id, { status: 'ready', path: '/cache/p.mp4' });
    expect(S().dirty).toBe(true);
    await saveProject();
    expect(S().dirty).toBe(false);
    S().undo();
    expect(S().dirty).toBe(true);
    expect(S().project.name).toBe('Cut');
    // The mirror is not undoable: undo keeps the current proxy.
    expect(S().project.media[media.id].proxy).toMatchObject({ status: 'ready', path: '/cache/p.mp4' });
  });
});

describe('writes that are edits still mark the project dirty', () => {
  it('the probe that completes an import or a relink, and the relink itself', async () => {
    fakeApi();
    await savedProject();
    S().relinkMedia(media.id, '/media/moved.mp4', { size: 5 });
    expect(S().dirty).toBe(true);
    await saveProject();
    expect(S().dirty).toBe(false);
    // A probe result is not re-derived when the project is opened: it must reach the file.
    S().setMediaProbe(media.id, fakeProbe(90));
    expect(S().dirty).toBe(true);
  });
});
