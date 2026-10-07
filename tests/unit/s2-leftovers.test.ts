/**
 * Roadmap §2 integration leftovers:
 * - one still-image extension list (shared/media.ts) behind the main-process classifier, the renderer classifiers
 *   and the import dialog's Images filter / default bin;
 * - the Source Monitor reloads when the media's preferred audio stream changes (selectLoadKey);
 * - the Source Monitor's audio waveform shows the preferred stream (WaveformView).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import type { MediaItem } from '../../shared/model';
import { createMediaItem } from '../../shared/project';
import { STILL_IMAGE_CODECS, STILL_IMAGE_EXTS } from '../../shared/media';
import { IMAGE_EXT } from '../../electron/media/probe';
import { STILL_IMAGE_EXTS as STORE_STILL_EXTS } from '../../src/state/store';
import { IMAGE_EXTS, classifyPath, importIdentity } from '../../src/state/parseIdentity';
import { IMPORT_FILTERS, isMediaPath } from '../../src/panels/project/actions';
import { isStillImage } from '../../src/playback/mediaSource';
import type { StoreState } from '../../src/state';

const { peek, get } = vi.hoisted(() => ({
  peek: vi.fn((_path: string, _stream?: number) => undefined),
  get: vi.fn((_path: string, _id?: string, _stream?: number) => new Promise<null>(() => { /* never settles */ })),
}));
vi.mock('@/app/media', async (importOriginal) => ({ ...(await importOriginal<object>()), waves: { peek, get } }));

const FPS = { num: 24, den: 1 };

/** An audio file with three AAC streams (#0, #1, #2). */
function threeStreams(over: Partial<MediaItem> = {}): MediaItem {
  return {
    ...createMediaItem('/media/commentary.mka', 'commentary.mka'),
    id: 'A', kind: 'audio',
    probe: {
      container: 'matroska', duration: 60, size: 1, startTime: 0, browserPlayable: true, subtitles: [],
      audio: [0, 1, 2].map((index) => ({ index, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 })),
    },
    ...over,
  };
}

describe('one still-image extension list (shared/media.ts)', () => {
  it('the main-process IMAGE_EXT, the store classifier and the import list are the shared list', () => {
    expect([...IMAGE_EXT].map((e) => e.slice(1)).sort()).toEqual([...STILL_IMAGE_EXTS].sort());
    expect(STORE_STILL_EXTS).toBe(STILL_IMAGE_EXTS);
    expect([...IMAGE_EXTS].sort()).toEqual([...STILL_IMAGE_EXTS].sort());
    expect(new Set(STILL_IMAGE_EXTS).size).toBe(STILL_IMAGE_EXTS.length);
    expect(new Set(STILL_IMAGE_CODECS).size).toBe(STILL_IMAGE_CODECS.length);
  });

  it('every still format probe.ts supports is an image on import (Images filter, drag and drop, Graphics bin)', () => {
    const images = IMPORT_FILTERS.find((f) => f.name === 'Images');
    const all = IMPORT_FILTERS.find((f) => f.name === 'All media');
    for (const e of ['tga', 'exr', 'psd', 'heic', 'heif', 'avif', 'jxl', 'dpx', 'tif', 'tiff', 'png', 'jpg', 'qoi', 'jp2']) {
      expect(images?.extensions).toContain(e);
      expect(all?.extensions).toContain(e);
      expect(classifyPath(`/stills/frame.${e.toUpperCase()}`)).toBe('image');
      expect(isMediaPath(`/stills/frame.${e}`)).toBe(true);
      expect(importIdentity(`/stills/frame.${e}`).bin).toBe('graphics');
    }
  });

  it('the renderer still check uses the same list (an old probe of a HEIC without the still mark)', () => {
    const heic: MediaItem = {
      ...createMediaItem('/stills/photo.heic', 'photo.heic'), kind: 'video',
      probe: {
        container: 'mov', duration: 0, size: 1, startTime: 0, browserPlayable: true, subtitles: [], audio: [],
        video: { index: 0, codec: 'hevc', width: 4032, height: 3024, fps: FPS, avgFps: FPS, isVfr: false },
      },
    };
    expect(isStillImage(heic)).toBe(true);
    expect(isStillImage({ ...heic, path: '/clips/photo.mkv' })).toBe(false);
  });
});

describe('Source Monitor follows the preferred audio stream', () => {
  function state(m: MediaItem): StoreState {
    return {
      ui: { sourceClip: { mediaId: m.id, time: 0 } },
      project: { media: { [m.id]: m }, settings: { useProxies: true } },
    } as unknown as StoreState;
  }

  it('selectLoadKey changes with media.preferredAudioStream, so a loaded file reloads on the new track', async () => {
    const { selectLoadKey } = await import('../../src/panels/source/SourcePanel');
    const m = threeStreams();
    const k0 = selectLoadKey(state(m));
    const k1 = selectLoadKey(state({ ...m, preferredAudioStream: 1 }));
    const k2 = selectLoadKey(state({ ...m, preferredAudioStream: 2 }));
    expect(new Set([k0, k1, k2]).size).toBe(3);
    // Unrelated edits (name, notes) do not reload the player.
    expect(selectLoadKey(state({ ...m, preferredAudioStream: 2, name: 'x', notes: 'y' }))).toBe(k2);
  });

  describe('WaveformView', () => {
    beforeEach(() => { peek.mockClear(); get.mockClear(); });

    async function render(m: MediaItem): Promise<void> {
      const { WaveformView } = await import('../../src/panels/source/WaveformView');
      renderToString(React.createElement(WaveformView, { media: m, duration: 60, time: 0, inPoint: null, outPoint: null }));
    }

    it('reads the preferred stream waveform (absolute index), as the timeline clips do', async () => {
      await render(threeStreams({ preferredAudioStream: 2 }));
      expect(peek).toHaveBeenCalledWith('/media/commentary.mka', 2);
    });

    it('the first stream (and a missing one, which export plays as the first) uses the first-stream cache key', async () => {
      await render(threeStreams({ preferredAudioStream: 0 }));
      expect(peek).toHaveBeenLastCalledWith('/media/commentary.mka', undefined);
      await render(threeStreams({ preferredAudioStream: 7 }));
      expect(peek).toHaveBeenLastCalledWith('/media/commentary.mka', undefined);
      await render(threeStreams());
      expect(peek).toHaveBeenLastCalledWith('/media/commentary.mka', undefined);
    });
  });
});
