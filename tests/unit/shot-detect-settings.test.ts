/**
 * #142: Detect Shots in plain words (sensitivity presets, shortest shot) and re-detection that warns before replacing
 * shots that were edited.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { SHOT_SENSITIVITY, adaptiveThresholdFor, shotSensitivityOf } from '../../shared/shotDetect';
import { createMediaItem, createProject, normalizeProjectWithReport } from '../../shared/project';
import { useStore, resetStore } from '../../src/state/store';
import { startSceneDetect } from '../../src/state/mediaActions';
import type { MediaItem } from '../../shared/model';

const S = () => useStore.getState();

describe('sensitivity', () => {
  it('presets: Normal is the PySceneDetect default; Fewer asks for a stronger change, More for a weaker one', () => {
    expect(adaptiveThresholdFor(SHOT_SENSITIVITY.normal)).toBeCloseTo(3, 6);
    expect(adaptiveThresholdFor(SHOT_SENSITIVITY.fewer)).toBeGreaterThan(3);
    expect(adaptiveThresholdFor(SHOT_SENSITIVITY.more)).toBeLessThan(3);
    expect(shotSensitivityOf(0.35)).toBe('normal');
    expect(shotSensitivityOf(0.5)).toBe('fewer');
    expect(shotSensitivityOf(0.25)).toBe('more');
    expect(shotSensitivityOf(0.4)).toBe('custom');
  });

  it('shortest shot: 1 s by default (older projects too); an unusable value is reset', () => {
    const raw = JSON.parse(JSON.stringify(createProject('p')));
    delete raw.settings.minShotSeconds;
    expect(normalizeProjectWithReport(raw).project.settings.minShotSeconds).toBe(1);
    raw.settings.minShotSeconds = -3;
    const r = normalizeProjectWithReport(raw);
    expect(r.project.settings.minShotSeconds).toBe(1);
    expect(r.repairs.length).toBeGreaterThan(0);
  });
});

describe('edited shots', () => {
  let m: MediaItem;
  beforeEach(() => {
    resetStore();
    m = { ...createMediaItem('/m/a.mkv', 'a.mkv'), kind: 'video' };
    S().addMedia([m]);
    S().setDetectedScenes(m.id, [5, 10, 15], 20);
  });
  const media = () => S().project.media[m.id];
  const shot = (i: number) => media().detectedScenes[i].id;

  it('a fresh detection is not edited; rename, merge, split, tag and delete mark it; detecting again clears it', () => {
    expect(media().shotsEdited).toBeUndefined();
    for (const edit of [
      () => S().renameDetectedScene(m.id, shot(0), 'Opening'),
      () => S().mergeDetectedScenes(m.id, [shot(0), shot(1)]),
      () => S().splitDetectedScene(m.id, shot(0), 2),
      () => S().tagDetectedScene(m.id, shot(0), { tags: ['x'] }),
      () => S().deleteDetectedScene(m.id, shot(1)),
    ]) {
      S().setDetectedScenes(m.id, [5, 10, 15], 20);
      expect(media().shotsEdited).toBeUndefined();
      edit();
      expect(media().shotsEdited).toBe(true);
    }
    S().undo();
    S().setDetectedScenes(m.id, [5], 20);
    expect(media().shotsEdited).toBeUndefined();
  });

  it('detection gets the shortest shot of the project', async () => {
    const g = globalThis as unknown as { window?: unknown; recut?: unknown };
    let req: { minSceneSeconds?: number; threshold?: number } | null = null;
    g.window = globalThis;
    g.recut = { startSceneDetect: async (r: typeof req) => { req = r; return { id: 'j' }; } };
    try {
      S().setSettings({ minShotSeconds: 3, sceneThreshold: 0.5 });
      await startSceneDetect(m.id);
      expect(req).toMatchObject({ minSceneSeconds: 3, threshold: 0.5 });
    } finally { delete g.recut; delete g.window; }
  });
});
