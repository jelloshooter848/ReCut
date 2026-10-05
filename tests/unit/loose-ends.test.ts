/**
 * Loose ends:
 *  1. Copy / mark-clip over huge selections use loops, not Math.min/max(...spread) (stack overflow at ~125k).
 *  2. insertScenesAtPlayhead advances by the inserted clip's real length (inserts are capped at the media end),
 *     so back-to-back scenes leave no one-frame gap.
 *  6. The timeline view zoom bounds are the ones normalizeProject clamps a loaded zoom to.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// The command layer / scene actions touch `window` (toasts, layout store). Provide a bare window without the bridge.
vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g.window) g.window = globalThis;
  (g.window as Record<string, unknown>).recut = undefined;
});

import { useStore, resetStore } from '../../src/state/store';
import { activeSequence } from '../../src/state/selectors';
import { createMediaItem, createProject, createSequence, normalizeProject } from '../../shared/project';
import { makeClip } from '../../shared/timeline';
import type { MediaItem, MediaProbe, SceneRecord, Sequence } from '../../shared/model';
import { VIEW_ZOOM_MAX, VIEW_ZOOM_MIN } from '../../shared/limits';
import { copyClipsToClipboard, getClipboard, setClipboard } from '../../src/app/clipboard';
import { registerEditingCommands, EXTRA_COMMAND_IDS } from '../../src/app/commands';
import { registerShellCommands } from '../../src/keyboard/commands';
import { runCommand } from '../../src/keyboard/shortcuts';
import { insertScenesAtPlayhead } from '../../src/panels/scenes/sceneUtils';
import { MAX_ZOOM, ZOOM_FLOOR } from '../../src/panels/timeline/viewMath';

const FPS = { num: 24, den: 1 };

function fakeProbe(duration: number): MediaProbe {
  return {
    container: 'matroska', duration, size: 1000, startTime: 0, browserPlayable: true,
    video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: FPS, avgFps: FPS, isVfr: false },
    audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
    subtitles: [],
  };
}
function fakeMedia(name: string, duration: number): MediaItem {
  return { ...createMediaItem(`/media/${name}`, name), kind: 'video', probe: fakeProbe(duration) };
}

const S = () => useStore.getState();
const seq = (): Sequence => activeSequence(S())!;

beforeAll(() => { registerShellCommands(); registerEditingCommands(); });
beforeEach(() => { resetStore(); setClipboard(null); });

describe('1: huge selections do not overflow the stack', () => {
  const N = 200_000;

  /** A project whose active sequence holds N one-frame video clips starting at frame 5 (selected). */
  function loadHuge(): Sequence {
    const p = createProject('big');
    const s = p.sequences[p.activeSequenceId!];
    const m = fakeMedia('big.mkv', 1e6);
    p.media[m.id] = m;
    for (let i = 0; i < N; i++) s.videoTracks[0].clips.push(makeClip({ mediaId: m.id, name: 'c', sourceIn: 0, duration: 1, kind: 'video' }, 5 + i));
    S().loadProjectData(p, null);
    S().select(s.videoTracks[0].clips.map((c) => c.id), 'set');
    return seq();
  }

  it('copyClipsToClipboard with 200k clips', () => {
    const s = loadHuge();
    const ids = s.videoTracks[0].clips.map((c) => c.id);
    expect(copyClipsToClipboard(s, ids)).toBe(N);
    expect(getClipboard()!.origin).toBe(5);
  });

  it('markClip with 200k selected clips sets in/out to the selection span', () => {
    loadHuge();
    runCommand(EXTRA_COMMAND_IDS.markClip);
    expect(seq().view.inPoint).toBe(5);
    expect(seq().view.outPoint).toBe(5 + N);
  });
});

describe('2: insertScenesAtPlayhead leaves no gap after a capped insert', () => {
  it('a scene whose rounded length would pass the media end is followed directly by the next one', () => {
    const s = createSequence('Test 24', FPS);
    S().addSequence(s);
    // 10.03 s @24 = 240.72 frames: rounding says 241, the insert is capped at the 240 frames the media has.
    const m = fakeMedia('a.mkv', 10.03);
    S().addMedia([m]);
    const scene = (id: string, inS: number, outS: number): SceneRecord => ({
      id, name: id, mediaId: m.id, in: inS, out: outS, characters: [], location: '', arc: '', tags: [], notes: '',
      rating: 0, color: '', createdAt: 0,
    });
    insertScenesAtPlayhead([scene('whole', 0, 10.03), scene('next', 0, 1)], 'overwrite');
    const v = seq().videoTracks[0].clips.slice().sort((a, b) => a.start - b.start);
    expect(v.map((c) => [c.start, c.duration])).toEqual([[0, 240], [240, 24]]);
    expect(seq().view.playhead).toBe(264);
  });
});

describe('6: timeline zoom bounds match the project clamp', () => {
  it('ZOOM_FLOOR / MAX_ZOOM are VIEW_ZOOM_MIN / VIEW_ZOOM_MAX, so a loaded zoom is reachable', () => {
    expect(ZOOM_FLOOR).toBe(VIEW_ZOOM_MIN);
    expect(MAX_ZOOM).toBe(VIEW_ZOOM_MAX);
    const p = createProject('z');
    const raw = JSON.parse(JSON.stringify(p));
    raw.sequences[p.activeSequenceId!].view.zoom = 1e9;
    const project = normalizeProject(raw);
    expect(project.sequences[p.activeSequenceId!].view.zoom).toBe(MAX_ZOOM);
  });
});
