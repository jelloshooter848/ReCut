/**
 * #146: sequences group Scene library scenes in story order (project.sceneSequences; timelines stay in
 * project.sequences). Store actions, the loader, and placing a sequence on a timeline in one undo step.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { useStore, resetStore, serializeForSave } from '../../src/state/store';
import { createMediaItem, normalizeProject, normalizeProjectWithReport } from '../../shared/project';
import { allTracks } from '../../shared/timeline';
import type { MediaItem, SceneRecord } from '../../shared/model';
import { insertSequenceAtPlayhead, newTimelineFromSequence, nextSequenceName, sequenceDuration } from '../../src/panels/scenes/sceneUtils';

const S = () => useStore.getState();
const media: MediaItem = {
  ...createMediaItem('/m/movie.mkv', 'movie.mkv'), kind: 'video',
  probe: {
    container: 'matroska', duration: 600, size: 1, startTime: 0, browserPlayable: true, subtitles: [],
    video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: { num: 24, den: 1 }, avgFps: { num: 24, den: 1 }, isVfr: false },
    audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
  },
};
const scene = (id: string, a: number, b: number): SceneRecord => ({
  id, name: id, mediaId: media.id, in: a, out: b, characters: [], location: '', arc: '', tags: [], notes: '', rating: 0, color: '#fff', createdAt: 0,
});

// Toasts schedule their dismissal on window.
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

beforeEach(() => {
  resetStore();
  S().addMedia([media]);
  for (const sc of [scene('A', 10, 20), scene('B', 30, 35), scene('C', 50, 52)]) S().addScene(sc);
});

const clipSources = (seqId: string) => {
  const seq = S().project.sequences[seqId];
  return allTracks(seq).filter((t) => t.kind === 'video').flatMap((t) => t.clips).sort((a, b) => a.start - b.start).map((c) => c.sourceIn);
};

describe('store actions', () => {
  it('make, edit and delete a sequence; the scenes stay', () => {
    expect(nextSequenceName()).toBe('Sequence 01');
    const id = S().addSceneSequence('Act One', ['B', 'A', 'B', 'missing']);
    const q = () => S().project.sceneSequences[id];
    expect(q().sceneIds).toEqual(['B', 'A']); // existing scenes, each once, in the given order
    expect(sequenceDuration(q())).toBe(15);
    expect(nextSequenceName()).toBe('Sequence 01');
    S().updateSceneSequence(id, { name: '  Act 1 ', sceneIds: ['A', 'C', 'B'], color: '#ff0000' });
    expect(q()).toMatchObject({ name: 'Act 1', sceneIds: ['A', 'C', 'B'], color: '#ff0000' });
    S().undo();
    expect(q().name).toBe('Act One');
    S().redo();
    S().removeSceneSequence(id);
    expect(S().project.sceneSequences[id]).toBeUndefined();
    expect(Object.keys(S().project.scenes).sort()).toEqual(['A', 'B', 'C']);
  });

  it('a deleted scene leaves every sequence that held it, and comes back with undo', () => {
    const one = S().addSceneSequence('One', ['A', 'B']);
    const two = S().addSceneSequence('Two', ['B', 'C']);
    S().removeScene('B');
    expect(S().project.sceneSequences[one].sceneIds).toEqual(['A']);
    expect(S().project.sceneSequences[two].sceneIds).toEqual(['C']);
    S().undo();
    expect(S().project.sceneSequences[one].sceneIds).toEqual(['A', 'B']);
  });

  it('Insert at Playhead places the scenes back to back in sequence order, one undo step', () => {
    const tl = S().project.activeSequenceId!;
    const id = S().addSceneSequence('Act', ['C', 'A', 'B']);
    const past = S().history.past.length;
    insertSequenceAtPlayhead(S().project.sceneSequences[id], 'insert');
    expect(clipSources(tl)).toEqual([50, 10, 30]);
    expect(S().history.past.length).toBe(past + 1);
    S().undo();
    expect(clipSources(tl)).toEqual([]);
  });

  it('New Timeline from Sequence makes a timeline named after it holding the scenes from frame 0, one undo step', () => {
    const before = S().project.activeSequenceId!;
    const id = S().addSceneSequence('Finale', ['B', 'C']);
    const past = S().history.past.length;
    const tl = newTimelineFromSequence(S().project.sceneSequences[id])!;
    expect(S().project.activeSequenceId).toBe(tl);
    expect(S().project.sequences[tl].name).toBe('Finale');
    expect(clipSources(tl)).toEqual([30, 50]);
    const first = allTracks(S().project.sequences[tl]).flatMap((t) => t.clips).reduce((m, c) => Math.min(m, c.start), Infinity);
    expect(first).toBe(0);
    expect(S().history.past.length).toBe(past + 1);
    S().undo();
    expect(S().project.sequences[tl]).toBeUndefined();
    expect(S().project.activeSequenceId).toBe(before);
  });
});

describe('merge scenes (#152)', () => {
  it('scenes of one video merge into the first; sequences and clips follow; one undo step', () => {
    S().updateScene('A', { characters: ['Bourne'], notes: 'one', rating: 2 });
    S().updateScene('B', { characters: ['Marie'], notes: 'two', rating: 4, location: 'Zurich' });
    const q = S().addSceneSequence('Act', ['C', 'B', 'A']);
    const tl = S().project.activeSequenceId!;
    S().insertFromSource(tl, { mediaId: media.id, in: 30, out: 35, atFrame: 0, mode: 'overwrite', extra: { sceneRecordId: 'B' } });
    const past = S().history.past.length;
    expect(S().mergeScenes(['B', 'A'])).toBe('A');
    const a = S().project.scenes.A;
    expect(S().project.scenes.B).toBeUndefined();
    expect(a).toMatchObject({ in: 10, out: 35, characters: ['Bourne', 'Marie'], notes: 'one\n\ntwo', rating: 4, location: 'Zurich' });
    expect(S().project.sceneSequences[q].sceneIds).toEqual(['C', 'A']);
    const clips = allTracks(S().project.sequences[tl]).flatMap((t) => t.clips);
    expect(clips.length).toBeGreaterThan(0);
    expect(clips.every((c) => c.sceneRecordId === 'A')).toBe(true);
    expect(S().history.past.length).toBe(past + 1);
    S().undo();
    expect(S().project.scenes.B).toBeDefined();
    expect(S().project.sceneSequences[q].sceneIds).toEqual(['C', 'B', 'A']);
  });

  it('refuses fewer than two scenes or scenes from different videos', () => {
    const other: MediaItem = { ...media, id: 'other', path: '/m/other.mkv' };
    S().addMedia([other]);
    S().addScene({ ...scene('X', 0, 5), mediaId: 'other' });
    expect(S().mergeScenes(['A'])).toBeNull();
    expect(S().mergeScenes(['A', 'X'])).toBeNull();
    expect(Object.keys(S().project.scenes).sort()).toEqual(['A', 'B', 'C', 'X']);
  });
});

describe('project file', () => {
  it('saves and loads sequences; references to missing scenes are dropped with a repair note', () => {
    const id = S().addSceneSequence('Act', ['A', 'C']);
    const raw = JSON.parse(JSON.stringify(serializeForSave()));
    expect(raw.sceneSequences[id]).toMatchObject({ name: 'Act', sceneIds: ['A', 'C'] });
    expect(normalizeProjectWithReport(raw).repairs).toEqual([]);
    delete raw.scenes.C;
    raw.sceneSequences[id].sceneIds.push('A', 42);
    const { project, repairs } = normalizeProjectWithReport(raw);
    expect(project.sceneSequences[id].sceneIds).toEqual(['A']);
    expect(repairs).toContain('sequence reference to a missing scene removed');
  });

  it('a file from before sequences opens with none, and nothing to repair', () => {
    const dir = path.resolve(__dirname, '../fixtures/projects');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.recut'))) {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      expect(raw.sceneSequences, f).toBeUndefined();
      expect(normalizeProject(raw).sceneSequences, f).toEqual({});
    }
  });
});
