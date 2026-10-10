/**
 * #138: HEVC previews without a proxy where this machine's Chromium decodes it (checked at runtime), and still gets a
 * proxy where it doesn't. The stored probe (browserPlayable) stays the same on every machine.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { evaluatePlayability } from '../../shared/media';
import { createMediaItem } from '../../shared/project';
import { markDirectDecodeFailed, setDecodeSupportForTests } from '../../src/playback/codecSupport';
import { mediaNeedsProxyForPreview, previewPlayable, previewReason, resolvePlaybackPath } from '../../src/playback/mediaSource';
import type { MediaItem, MediaProbe } from '../../shared/model';

const FPS = { num: 24, den: 1 };
function probeOf(o: { container?: string; codec?: string; pix?: string; audio?: string } = {}): MediaProbe {
  const codec = o.codec ?? 'hevc';
  const p: MediaProbe = {
    container: o.container ?? 'mp4', duration: 10, size: 1, startTime: 0, browserPlayable: false, subtitles: [],
    video: { index: 0, codec, width: 3840, height: 2160, fps: FPS, avgFps: FPS, isVfr: false, pixFmt: o.pix ?? 'yuv420p' },
    audio: [{ index: 1, codec: o.audio ?? 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }],
  };
  const play = evaluatePlayability(p); // what the probe stores: no machine-specific support
  p.browserPlayable = play.ok;
  if (!play.ok) p.playabilityReason = play.reason;
  return p;
}
const mediaOf = (probe: MediaProbe, name = 'clip.mp4'): MediaItem => ({ ...createMediaItem(`/m/${name}`, name), kind: 'video', probe });
const MAC = { hevcMain: true, hevcMain10: true };
const NONE = { hevcMain: false, hevcMain10: false };

afterEach(() => setDecodeSupportForTests(null));

describe('evaluatePlayability with machine decode support', () => {
  it('the probe (no support given) still says HEVC needs a proxy, on every machine', () => {
    expect(evaluatePlayability(probeOf())).toEqual({ ok: false, reason: 'video codec hevc not supported by Chromium' });
  });

  it('HEVC Main / Main 10 in MP4 / MOV / M4V previews where the machine decodes it', () => {
    for (const container of ['mp4', 'mov', 'm4v']) expect(evaluatePlayability(probeOf({ container }), MAC).ok, container).toBe(true);
    expect(evaluatePlayability(probeOf({ pix: 'yuv420p10le' }), MAC).ok).toBe(true);
    expect(evaluatePlayability(probeOf({ pix: 'yuv420p10le' }), { hevcMain: true, hevcMain10: false }).ok).toBe(false);
  });

  it('not for other containers, 4:2:2 / 4:4:4 / 12-bit, undecodable audio, or a machine without support', () => {
    expect(evaluatePlayability(probeOf({ container: 'matroska' }), MAC).ok).toBe(false);
    expect(evaluatePlayability(probeOf({ pix: 'yuv422p10le' }), MAC).ok).toBe(false);
    expect(evaluatePlayability(probeOf({ pix: 'yuv444p' }), MAC).ok).toBe(false);
    expect(evaluatePlayability(probeOf({ pix: 'yuv420p12le' }), MAC).ok).toBe(false);
    expect(evaluatePlayability(probeOf({ audio: 'ac3' }), MAC)).toEqual({ ok: false, reason: 'audio codec ac3 not supported by Chromium' });
    expect(evaluatePlayability(probeOf(), NONE).ok).toBe(false);
  });
});

describe('preview decision in the renderer', () => {
  it('a machine that decodes HEVC previews the original: no proxy needed, no "needs proxy" reason', () => {
    setDecodeSupportForTests(MAC);
    const m = mediaOf(probeOf());
    expect(m.probe!.browserPlayable).toBe(false); // the stored probe is unchanged
    expect(previewPlayable(m)).toBe(true);
    expect(mediaNeedsProxyForPreview(m)).toBe(false);
    expect(previewReason(m)).toBeUndefined();
    expect(resolvePlaybackPath(m, true)).toMatchObject({ path: '/m/clip.mp4', usingProxy: false });
  });

  it('a machine without HEVC support still needs a proxy (Linux; Windows without HEVC)', () => {
    setDecodeSupportForTests(NONE);
    const m = mediaOf(probeOf());
    expect(mediaNeedsProxyForPreview(m)).toBe(true);
    expect(previewReason(m)).toBe('video codec hevc not supported by Chromium');
    expect(resolvePlaybackPath(m, true).path).toBeNull();
  });

  it('a file that failed to load directly falls back to its proxy, or asks for one', () => {
    setDecodeSupportForTests(MAC);
    const m = mediaOf(probeOf(), 'broken.mp4');
    markDirectDecodeFailed(m.path);
    expect(previewPlayable(m)).toBe(false);
    expect(mediaNeedsProxyForPreview(m)).toBe(true);
    expect(previewReason(m)).toBe('this machine could not decode the original');
    const withProxy = { ...m, proxy: { status: 'ready' as const, path: '/cache/p.mp4' } };
    expect(resolvePlaybackPath(withProxy, false)).toMatchObject({ path: '/cache/p.mp4', usingProxy: true });
    // Other HEVC files on the same machine still preview directly.
    expect(previewPlayable(mediaOf(probeOf(), 'fine.mp4'))).toBe(true);
  });

  it('H.264 is unaffected either way', () => {
    setDecodeSupportForTests(NONE);
    expect(previewPlayable(mediaOf(probeOf({ codec: 'h264' })))).toBe(true);
  });
});
