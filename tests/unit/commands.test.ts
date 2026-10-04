import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

// The command layer touches `window` (toasts, layout store). Provide a bare window without the Electron bridge.
vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g.window) g.window = globalThis;
  (g.window as Record<string, unknown>).recut = undefined;
});

import { useStore, resetStore } from '../../src/state/store';
import { activeSequence } from '../../src/state/selectors';
import { createMediaItem, createSequence } from '../../shared/project';
import { allTracks, clipEnd, sequenceDuration } from '../../shared/timeline';
import type { JobInfo, MediaItem, MediaProbe, Sequence } from '../../shared/model';
import { registerTransport, setActiveTransport, type Transport } from '../../src/app/transport';
import { runCommand, getCommand } from '../../src/keyboard/shortcuts';
import { COMMAND_IDS } from '../../src/keyboard/commandIds';
import {
  registerEditingCommands, getClipboard, setClipboard, setTimelineViewportWidth, zoomToFitValue, EXTRA_COMMAND_IDS, ZOOM_MAX, topmostClipAt,
} from '../../src/app/commands';
import { routeJobs, resetJobsRouter } from '../../src/app/jobsRouter';
import { registerShellCommands } from '../../src/keyboard/commands';

const FPS = { num: 24, den: 1 };

function fakeProbe(duration = 100): MediaProbe {
  return {
    container: 'matroska', duration, size: 1000, startTime: 0, browserPlayable: true,
    video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: FPS, avgFps: FPS, isVfr: false },
    audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
    subtitles: [],
  };
}
function fakeMedia(name = 'movie.mkv', duration = 100): MediaItem {
  return { ...createMediaItem(`/media/${name}`, name), kind: 'video', probe: fakeProbe(duration) };
}

const S = () => useStore.getState();
const seq = (): Sequence => activeSequence(S())!;
const clips = () => allTracks(seq()).flatMap((t) => t.clips);
const videoClips = () => seq().videoTracks.flatMap((t) => t.clips);

interface FakeTransport extends Transport { calls: string[]; rate: number; frame: number }
function fakeTransport(id: 'program' | 'source' = 'program'): FakeTransport {
  const t: FakeTransport = {
    id, calls: [], rate: 0, frame: 0,
    toggle: () => { t.calls.push('toggle'); },
    play: () => { t.calls.push('play'); },
    pause: () => { t.calls.push('pause'); },
    stop: () => { t.calls.push('stop'); },
    setRate: (r) => { t.calls.push(`setRate:${r}`); t.rate = r; },
    getRate: () => t.rate,
    stepFrames: (n) => { t.calls.push(`step:${n}`); t.frame += n; },
    seekFrame: (f) => { t.calls.push(`seek:${f}`); t.frame = f; },
    currentFrame: () => t.frame,
    durationFrames: () => 1000,
    goToStart: () => { t.calls.push('goToStart'); },
    goToEnd: () => { t.calls.push('goToEnd'); },
    markIn: () => { t.calls.push('markIn'); },
    markOut: () => { t.calls.push('markOut'); },
    clearInOut: () => { t.calls.push('clearInOut'); },
    goToIn: () => { t.calls.push('goToIn'); },
    goToOut: () => { t.calls.push('goToOut'); },
    isPlaying: () => false,
  };
  return t;
}

let media: MediaItem;
let seqId: string;

/** Insert [0,4s) of the fake media at `atFrame` → one video + one linked audio clip of 96 frames. */
function insert(atFrame = 0, inS = 0, outS = 4): string[] {
  return S().insertFromSource(seqId, { mediaId: media.id, in: inS, out: outS, atFrame, mode: 'overwrite' });
}

beforeAll(() => { registerShellCommands(); registerEditingCommands(); });

beforeEach(() => {
  resetStore();
  setActiveTransport(null);
  setClipboard(null);
  media = fakeMedia();
  S().addMedia([media]);
  const s = createSequence('Test 24', FPS);
  S().addSequence(s);
  seqId = s.id;
  S().clearHistory();
});

describe('registration', () => {
  it('replaces every shell stub with a real implementation', () => {
    for (const id of Object.values(COMMAND_IDS)) {
      const c = getCommand(id);
      expect(c, id).toBeDefined();
      // Shell-owned commands (workspaces, panel focus…) stay as registered by the shell; everything else must not be a placeholder.
      if (!/^(view\.focusPanel|workspace\.|view\.maximizePanel|view\.fullscreenProgram|view\.toggleFullscreen|help\.shortcuts)/.test(id)) {
        expect(c!.placeholder, id).not.toBe(true);
      }
    }
    for (const id of Object.values(EXTRA_COMMAND_IDS)) expect(getCommand(id), id).toBeDefined();
  });
});

describe('transport routing', () => {
  it('routes playPause / shuttle / marks to the active transport', () => {
    const t = fakeTransport('program');
    const off = registerTransport(t);
    try {
      expect(runCommand(COMMAND_IDS.playPause)).toBe(true);
      expect(t.calls).toContain('toggle');
      runCommand(COMMAND_IDS.shuttleForward);
      expect(t.rate).toBe(1);
      runCommand(COMMAND_IDS.shuttleForward);
      expect(t.rate).toBe(2);
      runCommand(COMMAND_IDS.shuttleBack);
      expect(t.rate).toBe(-1);
      runCommand(COMMAND_IDS.shuttleStop);
      expect(t.rate).toBe(0);
      runCommand(COMMAND_IDS.markIn); runCommand(COMMAND_IDS.markOut); runCommand(COMMAND_IDS.clearInOut);
      expect(t.calls.slice(-3)).toEqual(['markIn', 'markOut', 'clearInOut']);
      runCommand(COMMAND_IDS.stepForward5); runCommand(COMMAND_IDS.stepBack);
      expect(t.frame).toBe(4);
      runCommand(COMMAND_IDS.goToStart); runCommand(COMMAND_IDS.goToEnd); runCommand(COMMAND_IDS.goToIn); runCommand(COMMAND_IDS.goToOut);
      expect(t.calls.slice(-4)).toEqual(['goToStart', 'goToEnd', 'goToIn', 'goToOut']);
    } finally { off(); }
  });

  it('falls back to the store when no transport is registered', () => {
    insert(0);
    S().setView(seqId, { playhead: 10 });
    runCommand(COMMAND_IDS.playPause);
    expect(S().playback.playing).toBe(true);
    runCommand(COMMAND_IDS.playPause);
    expect(S().playback.playing).toBe(false);
    runCommand(COMMAND_IDS.markIn);
    expect(seq().view.inPoint).toBe(10);
    runCommand(COMMAND_IDS.stepForward5);
    expect(seq().view.playhead).toBe(15);
    runCommand(COMMAND_IDS.markOut);
    expect(seq().view.outPoint).toBe(15);
    runCommand(COMMAND_IDS.clearInOut);
    expect(seq().view.inPoint).toBeNull();
    runCommand(COMMAND_IDS.goToEnd);
    expect(seq().view.playhead).toBe(96);
    runCommand(COMMAND_IDS.goToStart);
    expect(seq().view.playhead).toBe(0);
  });

  it('prev/next edit jump between edit points in the program context', () => {
    insert(0);
    S().setView(seqId, { playhead: 48 });
    runCommand(COMMAND_IDS.nextEdit);
    expect(seq().view.playhead).toBe(96);
    runCommand(COMMAND_IDS.prevEdit);
    expect(seq().view.playhead).toBe(0);
  });

  it('prev/next edit jump between detected scenes in the source context', () => {
    const t = fakeTransport('source');
    const off = registerTransport(t);
    try {
      S().setDetectedScenes(media.id, [10, 20], 100);
      S().setSourceClip(media.id, 12);
      runCommand(COMMAND_IDS.nextEdit);
      expect(t.calls.at(-1)).toBe(`seek:${20 * 24}`);
      S().setSourceTime(12);
      runCommand(COMMAND_IDS.prevEdit);
      expect(t.calls.at(-1)).toBe(`seek:${10 * 24}`);
    } finally { off(); }
  });
});

describe('editing commands', () => {
  it('addEdit razors the clip under the playhead and undo/redo restore it', () => {
    insert(0);
    expect(clips().length).toBe(2);
    S().setView(seqId, { playhead: 48 });
    expect(runCommand(COMMAND_IDS.addEdit)).toBe(true);
    expect(clips().length).toBe(4);
    expect(videoClips().map((c) => c.start).sort((a, b) => a - b)).toEqual([0, 48]);
    expect(runCommand(COMMAND_IDS.undo)).toBe(true);
    expect(clips().length).toBe(2);
    expect(runCommand(COMMAND_IDS.redo)).toBe(true);
    expect(clips().length).toBe(4);
  });

  it('addEditAllTracks cuts on every unlocked track', () => {
    insert(0);
    S().setTrackFlags(seqId, seq().audioTracks[0].id, { locked: true });
    S().setView(seqId, { playhead: 24 });
    runCommand(EXTRA_COMMAND_IDS.addEditAllTracks);
    expect(videoClips().length).toBe(2);
    expect(seq().audioTracks[0].clips.length).toBe(1);
  });

  it('undo is unavailable when the history is empty', () => {
    expect(runCommand(COMMAND_IDS.undo)).toBe(false);
  });

  it('delete removes the selection; a selected marker is removed when no clips are selected', () => {
    const ids = insert(0);
    S().select(ids);
    runCommand(COMMAND_IDS.deleteSelection);
    expect(clips().length).toBe(0);
    runCommand(COMMAND_IDS.undo);
    expect(clips().length).toBe(2);
    const mk = S().addMarker(seqId, { time: 5 })!;
    S().select([], 'clear');
    S().selectMarker(mk);
    runCommand(COMMAND_IDS.deleteSelection);
    expect(seq().markers.length).toBe(0);
    expect(clips().length).toBe(2);
  });

  it('rippleDelete closes the gap', () => {
    const first = insert(0);
    insert(96);
    expect(clips().length).toBe(4);
    S().select(first);
    runCommand(COMMAND_IDS.rippleDelete);
    expect(clips().length).toBe(2);
    for (const c of clips()) expect(c.start).toBe(0);
  });

  it('lift leaves a gap, extract ripples', () => {
    insert(0);
    S().setView(seqId, { inPoint: 24, outPoint: 48 });
    expect(runCommand(COMMAND_IDS.lift)).toBe(true);
    const v = seq().videoTracks[0].clips;
    expect(v.map((c) => [c.start, clipEnd(c)])).toEqual([[0, 24], [48, 96]]);
    runCommand(COMMAND_IDS.undo);
    expect(runCommand(COMMAND_IDS.extract)).toBe(true);
    const v2 = seq().videoTracks[0].clips;
    expect(v2.map((c) => [c.start, clipEnd(c)])).toEqual([[0, 24], [24, 72]]);
  });

  it('lift/extract are unavailable without an in/out range', () => {
    insert(0);
    expect(runCommand(COMMAND_IDS.lift)).toBe(false);
    expect(runCommand(COMMAND_IDS.extract)).toBe(false);
  });

  it('copy / paste places the clipboard at the playhead on the same tracks', () => {
    const ids = insert(0);
    S().select(ids);
    expect(runCommand(COMMAND_IDS.copy)).toBe(true);
    const cb = getClipboard();
    expect(cb?.entries.length).toBe(2);
    expect(cb?.origin).toBe(0);
    S().setView(seqId, { playhead: 200 });
    runCommand(COMMAND_IDS.paste);
    expect(clips().length).toBe(4);
    const pasted = clips().filter((c) => c.start === 200);
    expect(pasted.length).toBe(2);
    expect(new Set(pasted.map((c) => c.id)).size).toBe(2);
    expect(pasted.every((c) => !ids.includes(c.id))).toBe(true);
    // linked pair keeps a (fresh) shared link id
    expect(pasted[0].linkId).toBe(pasted[1].linkId);
    expect(pasted[0].linkId).not.toBe(clips().find((c) => c.id === ids[0])!.linkId);
    expect(S().ui.selectedClipIds.sort()).toEqual(pasted.map((c) => c.id).sort());
    expect(seq().videoTracks[0].clips.length).toBe(2);
  });

  it('cut copies then deletes', () => {
    const ids = insert(0);
    S().select(ids);
    runCommand(COMMAND_IDS.cut);
    expect(clips().length).toBe(0);
    expect(getClipboard()?.entries.length).toBe(2);
  });

  it('nudge moves the selection by 1 / 5 frames', () => {
    const ids = insert(0);
    S().select(ids);
    runCommand(COMMAND_IDS.nudgeRight);
    expect(clips().every((c) => c.start === 1)).toBe(true);
    runCommand(EXTRA_COMMAND_IDS.nudgeRight5);
    expect(clips().every((c) => c.start === 6)).toBe(true);
    runCommand(COMMAND_IDS.nudgeLeft);
    expect(clips().every((c) => c.start === 5)).toBe(true);
    runCommand(EXTRA_COMMAND_IDS.nudgeLeft5);
    expect(clips().every((c) => c.start === 0)).toBe(true);
  });

  it('selectAll / deselectAll', () => {
    insert(0); insert(96);
    runCommand(COMMAND_IDS.selectAll);
    expect(S().ui.selectedClipIds.length).toBe(4);
    runCommand(COMMAND_IDS.deselectAll);
    expect(S().ui.selectedClipIds.length).toBe(0);
  });

  it('markClip sets in/out to the clip under the playhead', () => {
    insert(24);
    S().setView(seqId, { playhead: 50 });
    runCommand(EXTRA_COMMAND_IDS.markClip);
    expect(seq().view.inPoint).toBe(24);
    expect(seq().view.outPoint).toBe(120);
  });

  it('addMarker adds at the playhead, selects it, and re-selects an existing one', () => {
    S().setView(seqId, { playhead: 30 });
    runCommand(COMMAND_IDS.addMarker);
    expect(seq().markers.length).toBe(1);
    expect(seq().markers[0].time).toBe(30);
    expect(S().ui.selectedMarkerId).toBe(seq().markers[0].id);
    S().selectMarker(null);
    runCommand(COMMAND_IDS.addMarker);
    expect(seq().markers.length).toBe(1);
    expect(S().ui.selectedMarkerId).toBe(seq().markers[0].id);
  });

  it('matchFrame opens the source at the clip source time', () => {
    insert(0, 10, 14);
    S().setView(seqId, { playhead: 24 });
    runCommand(COMMAND_IDS.matchFrame);
    expect(S().ui.sourceClip?.mediaId).toBe(media.id);
    expect(S().ui.sourceClip?.time).toBeCloseTo(11, 5);
  });

  it('ripple trim previous/next trims the clip under the playhead to the playhead', () => {
    insert(0); insert(96);
    S().setView(seqId, { playhead: 24 });
    runCommand(COMMAND_IDS.rippleTrimPrev);
    const v = seq().videoTracks[0].clips;
    expect(v[0].start).toBe(0);
    expect(v[0].duration).toBe(72);
    expect(v[1].start).toBe(72);
    S().setView(seqId, { playhead: 48 });
    runCommand(COMMAND_IDS.rippleTrimNext);
    const v2 = seq().videoTracks[0].clips;
    expect(clipEnd(v2[0])).toBe(48);
    expect(v2[1].start).toBe(48);
  });

  it('toggleClipEnabled and link/unlink toggle', () => {
    const ids = insert(0);
    S().select(ids);
    runCommand(COMMAND_IDS.toggleClipEnabled);
    expect(clips().every((c) => c.enabled === false)).toBe(true);
    runCommand(COMMAND_IDS.linkUnlink);
    expect(clips().every((c) => c.linkId === null)).toBe(true);
    runCommand(COMMAND_IDS.linkUnlink);
    expect(clips()[0].linkId).not.toBeNull();
    expect(clips()[0].linkId).toBe(clips()[1].linkId);
  });

  it('tools and snapping', () => {
    runCommand(COMMAND_IDS.toolRazor);
    expect(S().ui.tool).toBe('razor');
    runCommand(EXTRA_COMMAND_IDS.toolHand);
    expect(S().ui.tool).toBe('hand');
    const before = S().project.settings.snapping;
    runCommand(EXTRA_COMMAND_IDS.toggleSnapping);
    expect(S().project.settings.snapping).toBe(!before);
  });

  it('insert / overwrite from the source monitor place clips at the playhead and advance it', () => {
    S().setSourceClip(media.id, 0);
    S().setSourceIn(2); S().setSourceOut(4);
    S().setView(seqId, { playhead: 10 });
    runCommand(COMMAND_IDS.overwrite);
    expect(videoClips().length).toBe(1);
    expect(videoClips()[0].start).toBe(10);
    expect(videoClips()[0].duration).toBe(48);
    expect(seq().view.playhead).toBe(58);
  });

  it('topmostClipAt prefers higher video tracks', () => {
    insert(0);
    const v2 = seq().videoTracks[1];
    S().placeClipsAction(seqId, [{ trackId: v2.id, clip: { ...videoClips()[0], id: 'top', start: 10, duration: 20 } }], 'overwrite');
    expect(topmostClipAt(seq(), 15)?.clip.id).toBe('top');
    expect(topmostClipAt(seq(), 50)?.track.id).toBe(seq().videoTracks[0].id);
  });
});

describe('view commands', () => {
  it('zoomToFit math', () => {
    expect(zoomToFitValue(240, 1200)).toBe(5);
    expect(zoomToFitValue(0, 1200)).toBe(ZOOM_MAX);
    insert(0);
    setTimelineViewportWidth(960);
    S().setView(seqId, { zoom: 3, scroll: 40 });
    runCommand(COMMAND_IDS.zoomToFit);
    expect(seq().view.zoom).toBe(960 / sequenceDuration(seq()));
    expect(seq().view.scroll).toBe(0);
  });

  it('zoomIn / zoomOut scale by 1.5 keeping the playhead at the same x', () => {
    insert(0);
    setTimelineViewportWidth(1200);
    S().setView(seqId, { zoom: 4, scroll: 10, playhead: 40 });
    runCommand(COMMAND_IDS.zoomIn);
    expect(seq().view.zoom).toBe(6);
    // (40 - 10) * 4 = 120px before; 120 / 6 = 20 frames → scroll 20
    expect(seq().view.scroll).toBe(20);
    runCommand(COMMAND_IDS.zoomOut);
    expect(seq().view.zoom).toBeCloseTo(4, 10);
    expect(seq().view.scroll).toBeCloseTo(10, 10);
  });
});

describe('jobs router', () => {
  beforeEach(() => resetJobsRouter());
  const job = (patch: Partial<JobInfo>): JobInfo => ({ id: 'j1', kind: 'proxy', title: 'Proxy', status: 'running', progress: 0, mediaId: media.id, ...patch });

  it('applies a finished proxy once and mirrors jobs', () => {
    routeJobs([job({ status: 'running', progress: 0.1 })]);
    expect(S().project.media[media.id].proxy.status).toBe('running');
    expect(S().jobs.length).toBe(1);
    const done = job({ status: 'done', progress: 1, result: { path: '/cache/p.mp4', width: 960, height: 540, cached: false } });
    routeJobs([done]);
    expect(S().project.media[media.id].proxy).toMatchObject({ status: 'ready', path: '/cache/p.mp4', width: 960, height: 540 });
    const histLen = S().history.past.length;
    routeJobs([done]);
    expect(S().history.past.length).toBe(histLen);
  });

  it('routes scene detection results and failures', () => {
    routeJobs([job({ id: 'j2', kind: 'sceneDetect', status: 'done', progress: 1, result: { boundaries: [10, 20], duration: 100 } })]);
    const m = S().project.media[media.id];
    expect(m.detectedScenes.length).toBe(3);
    expect(m.sceneDetectStatus).toBe('done');
    routeJobs([job({ id: 'j3', kind: 'sceneDetect', status: 'failed', error: 'boom' })]);
    expect(S().project.media[media.id].sceneDetectStatus).toBe('failed');
  });
});
