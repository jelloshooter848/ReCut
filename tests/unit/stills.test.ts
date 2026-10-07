/**
 * Still images (Roadmap §2 B): one still classification in main and renderer, the PNG still proxy, preview
 * resolution through that proxy, and the proxy-eligibility gates that now allow stills.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { MediaItem, MediaProbe } from '../../shared/model';
import { applyStillOrientation, classifyKind, probeFromFfprobe, IMAGE_EXT, type FfprobeOutput, type FfprobeStream } from '../../electron/media/probe';
import { buildStillProxyArgs, isStillProbe, pixFmtHasAlpha, stillProxyOutputPath, STILL_PROXY_MAX_SIDE } from '../../electron/media/proxy';
import { kindFromProbe, STILL_IMAGE_EXTS } from '../../src/state/store';
import {
  DISPLAYABLE_IMAGE_EXTS, isDisplayableImage, isStillImage, mediaNeedsProxyForPreview, previewPlaybackLabel, resolvePlaybackPath,
} from '../../src/playback/mediaSource';
import { proxyEligible, needsProxy } from '../../src/panels/jobs/ProxiesTab';
import { mediaNeedsProxy } from '../../src/panels/timeline/clipBadges';
import { classifyMissing } from '../../src/panels/program/missing';
import { describeDecodeProblem } from '../../src/panels/source/SourcePanel';

// ------------------------------------------------------------------ ffprobe fixtures (as ffprobe 6.1 reports them)

function vstream(codec: string, over: Partial<FfprobeStream> = {}): FfprobeStream {
  return { index: 0, codec_type: 'video', codec_name: codec, width: 320, height: 240, pix_fmt: 'rgb24', r_frame_rate: '25/1', avg_frame_rate: '25/1', ...over };
}
const astream: FfprobeStream = { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' };
function ff(formatName: string, streams: FfprobeStream[], duration?: string): FfprobeOutput {
  return { streams, format: { format_name: formatName, ...(duration ? { duration } : {}) } };
}

interface Case { file: string; raw: FfprobeOutput; kind: 'image' | 'video' }
const CASES: Case[] = [
  { file: '/m/a.png', raw: ff('png_pipe', [vstream('png')]), kind: 'image' },
  { file: '/m/a.jpg', raw: ff('image2', [vstream('mjpeg', { duration: '0.040000' })], '0.040000'), kind: 'image' },
  { file: '/m/a.tiff', raw: ff('tiff_pipe', [vstream('tiff', { pix_fmt: 'yuv420p' })]), kind: 'image' },
  { file: '/m/a.tga', raw: ff('image2', [vstream('targa', { duration: '0.040000' })], '0.040000'), kind: 'image' },
  { file: '/m/a.exr', raw: ff('exr_pipe', [vstream('exr', { pix_fmt: 'gbrpf32le' })]), kind: 'image' },
  { file: '/m/a.psd', raw: ff('psd_pipe', [vstream('psd')]), kind: 'image' },
  { file: '/m/a.jxl', raw: ff('jpegxl_pipe', [vstream('jpegxl')]), kind: 'image' },
  { file: '/m/a.dpx', raw: ff('dpx_pipe', [vstream('dpx')]), kind: 'image' },
  // AVIF / HEIC items demux as mov: no duration, one frame. Before, AVIF counted as a browser-playable mov video.
  { file: '/m/a.avif', raw: ff('mov,mp4,m4a,3gp,3g2,mj2', [vstream('av1', { pix_fmt: 'yuv420p', nb_frames: '1', r_frame_rate: '1/1' })]), kind: 'image' },
  { file: '/m/a.heic', raw: ff('mov,mp4,m4a,3gp,3g2,mj2', [vstream('hevc', { pix_fmt: 'yuv420p', nb_frames: '1' })]), kind: 'image' },
  { file: '/m/IMG_1.HEIF', raw: ff('mov,mp4,m4a,3gp,3g2,mj2', [vstream('hevc', { pix_fmt: 'yuv420p' })]), kind: 'image' },
  // A one-frame GIF is a still; an animated one is a video (it plays through an mp4 proxy).
  { file: '/m/one.gif', raw: ff('gif', [vstream('gif', { nb_frames: '1', duration: '0.040000', pix_fmt: 'bgra' })], '0.040000'), kind: 'image' },
  { file: '/m/anim.gif', raw: ff('gif', [vstream('gif', { nb_frames: '20', duration: '2.000000', pix_fmt: 'bgra' })], '2.000000'), kind: 'video' },
  // Real videos stay videos, even with an image codec or an animated AVIF.
  { file: '/m/a.mp4', raw: ff('mov,mp4,m4a,3gp,3g2,mj2', [vstream('av1', { nb_frames: '240', duration: '10' })], '10.0'), kind: 'video' },
  { file: '/m/a.avi', raw: ff('avi', [vstream('mjpeg', { duration: '5' }), astream], '5.0'), kind: 'video' },
  { file: '/m/anim.avif', raw: ff('mov,mp4,m4a,3gp,3g2,mj2', [vstream('av1', { nb_frames: '48', duration: '2' })], '2.0'), kind: 'video' },
  { file: '/m/movie.mkv', raw: ff('matroska,webm', [vstream('h264', { pix_fmt: 'yuv420p' }), astream], '60.0'), kind: 'video' },
];

describe('still classification (main and renderer agree)', () => {
  for (const c of CASES) {
    it(`${path.basename(c.file)} -> ${c.kind}`, () => {
      const p = probeFromFfprobe(c.raw, c.file, 1000);
      expect(classifyKind(p, c.file)).toBe(c.kind);
      expect(kindFromProbe(p, c.file)).toBe(c.kind);
      if (c.kind === 'image') {
        expect(p.playabilityReason).toBe('still image');
        expect(p.browserPlayable).toBe(false);
        expect(p.duration).toBe(0);
        expect(isStillProbe(p)).toBe(true);
      } else {
        expect(p.playabilityReason).not.toBe('still image');
        expect(p.duration).toBeGreaterThan(0);
        expect(isStillProbe(p)).toBe(false);
      }
    });
  }

  it('AVIF is not a browser-playable video any more (it was: mov + av1)', () => {
    const p = probeFromFfprobe(CASES.find((c) => c.file === '/m/a.avif')!.raw, '/m/a.avif', 1);
    expect(p.browserPlayable).toBe(false);
  });

  it('probes saved by older versions (no still mark) still classify the same way in both', () => {
    const old: MediaProbe = {
      container: 'mov', duration: 0, size: 1, audio: [], subtitles: [], startTime: 0, browserPlayable: true,
      video: { index: 0, codec: 'av1', width: 64, height: 64, fps: { num: 1, den: 1 }, avgFps: { num: 1, den: 1 }, isVfr: false },
    };
    for (const f of ['/m/x.avif', '/m/x.tga', '/m/x.bin']) {
      expect(kindFromProbe(old, f)).toBe(classifyKind(old, f));
      expect(kindFromProbe(old, f)).toBe('image');
    }
    const pipe: MediaProbe = { ...old, container: 'png_pipe', duration: 0.04, browserPlayable: false, video: { ...old.video!, codec: 'png' } };
    expect(kindFromProbe(pipe, '/m/b.png')).toBe('image');
    expect(classifyKind(pipe, '/m/b.png')).toBe('image');
    const withDuration = { ...old, duration: 3 };
    expect(kindFromProbe(withDuration, '/m/x.avif')).toBe('video');
    expect(classifyKind(withDuration, '/m/x.avif')).toBe('video');
  });

  it('a still whose first frame carries a display matrix (EXIF Orientation 6) reports its upright size', () => {
    const p = probeFromFfprobe(CASES.find((c) => c.file === '/m/a.jpg')!.raw, '/m/a.jpg', 1);
    applyStillOrientation(p, [{ side_data_type: '3x3 displaymatrix', rotation: -90 }]);
    expect(p.video).toMatchObject({ width: 240, height: 320, rotation: 270, codedWidth: 320, codedHeight: 240 }); // streamRotation's quarter turn (only the axis swap matters)
    const q = probeFromFfprobe(CASES.find((c) => c.file === '/m/a.jpg')!.raw, '/m/a.jpg', 1);
    applyStillOrientation(q, [{ side_data_type: '3x3 displaymatrix', rotation: 180 }]);
    expect(q.video).toMatchObject({ width: 320, height: 240, rotation: 180 });
    applyStillOrientation(q, undefined);
    expect(q.video).toMatchObject({ width: 320, height: 240 });
  });

  it('the main and renderer still-extension lists are the same, and everything drawn directly is a still', () => {
    expect([...IMAGE_EXT].map((e) => e.slice(1)).sort()).toEqual([...STILL_IMAGE_EXTS].sort());
    for (const e of ['tga', 'exr', 'psd', 'heif', 'heic', 'jxl', 'avif', 'tif', 'tiff']) expect(STILL_IMAGE_EXTS).toContain(e);
    for (const e of DISPLAYABLE_IMAGE_EXTS) expect(STILL_IMAGE_EXTS).toContain(e);
  });
});

// ------------------------------------------------------------------ still proxy

describe('still proxy (PNG)', () => {
  it('writes proxies/<key>_still.png', () => {
    const p = stillProxyOutputPath('abc123');
    expect(path.basename(p)).toBe('abc123_still.png');
    expect(path.basename(path.dirname(p))).toBe('proxies');
  });

  it('one frame, PNG, RGB or RGBA, SAR un-squeezed, long side capped at 3840, to the .part file', () => {
    const rgb = buildStillProxyArgs('/media/a.tiff', { alpha: false, outPart: '/c/k_still.png.part-7' });
    expect(rgb.slice(0, 2)).toEqual(['-i', 'file:/media/a.tiff']);
    const at = (flag: string) => rgb[rgb.indexOf(flag) + 1];
    expect(at('-frames:v')).toBe('1');
    expect(at('-map')).toBe('0:v:0');
    expect(at('-c:v')).toBe('png');
    expect(at('-pix_fmt')).toBe('rgb24');
    expect(at('-f')).toBe('image2');
    expect(at('-update')).toBe('1');
    expect(rgb[rgb.length - 1]).toBe('file:/c/k_still.png.part-7');
    const vf = at('-vf');
    expect(vf).toMatch(/round\(iw\*sar\)/); // widen for SAR > 1
    expect(vf).toMatch(/round\(ih\/sar\)/); // heighten for SAR < 1
    expect(vf).toMatch(/setsar=1/);
    expect(vf).toContain(`min(iw,${STILL_PROXY_MAX_SIDE})`);
    expect(vf).toContain('force_original_aspect_ratio=decrease');
    expect(STILL_PROXY_MAX_SIDE).toBe(3840);
    const rgba = buildStillProxyArgs('/media/a.tga', { alpha: true, outPart: '/c/x.part' });
    expect(rgba[rgba.indexOf('-pix_fmt') + 1]).toBe('rgba');
    expect(buildStillProxyArgs('/a.png', { alpha: false, outPart: '/x', maxSide: 100 }).join(' ')).toContain('min(iw,100)');
  });

  it('alpha detection from the probed pixel format', () => {
    for (const f of ['rgba', 'bgra', 'argb', 'ya8', 'ya16be', 'yuva420p', 'gbrap', 'gbrapf32le', 'rgba64be', 'pal8']) expect(pixFmtHasAlpha(f), f).toBe(true);
    for (const f of ['rgb24', 'bgr24', 'gray', 'yuv420p', 'gbrpf32le', 'rgb48le', 'yuvj420p', undefined]) expect(pixFmtHasAlpha(f), String(f)).toBe(false);
  });

  it('a picture without duration and audio is proxied as a still even without the still mark', () => {
    const p: MediaProbe = {
      container: 'mov', duration: 0, size: 1, audio: [], subtitles: [], startTime: 0, browserPlayable: true,
      video: { index: 0, codec: 'hevc', width: 64, height: 64, fps: { num: 1, den: 1 }, avgFps: { num: 1, den: 1 }, isVfr: false },
    };
    expect(isStillProbe(p)).toBe(true);
    expect(isStillProbe({ ...p, video: undefined })).toBe(false);
  });
});

// ------------------------------------------------------------------ preview resolution + eligibility

function still(ext: string, over: Partial<MediaItem> = {}): MediaItem {
  return {
    id: `S-${ext}`, name: `s.${ext}`, path: `/media/s.${ext}`, kind: 'image', category: 'Other', identity: {}, binId: null,
    probe: {
      container: `${ext}_pipe`, duration: 0, size: 1, audio: [], subtitles: [], startTime: 0, browserPlayable: false, playabilityReason: 'still image',
      video: { index: 0, codec: ext, width: 640, height: 360, fps: { num: 25, den: 1 }, avgFps: { num: 25, den: 1 }, isVfr: false },
    },
    offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0,
    ...over,
  };
}

describe('still preview resolution', () => {
  it('TIFF / TGA / EXR / PSD / JXL / HEIC / AVIF need a proxy; PNG / JPEG / WebP / GIF / BMP are drawn directly', () => {
    for (const ext of ['tiff', 'tif', 'tga', 'exr', 'psd', 'jxl', 'heic', 'heif', 'dpx', 'avif']) {
      const m = still(ext);
      expect(isStillImage(m), ext).toBe(true);
      expect(isDisplayableImage(m), ext).toBe(false);
      expect(mediaNeedsProxyForPreview(m), ext).toBe(true);
      expect(resolvePlaybackPath(m, true).path, ext).toBeNull();
      expect(previewPlaybackLabel(m).direct).toBe(false);
    }
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']) {
      const m = still(ext);
      expect(isDisplayableImage(m), ext).toBe(true);
      expect(mediaNeedsProxyForPreview(m), ext).toBe(false);
      expect(resolvePlaybackPath(m, false)).toEqual({ path: m.path, usingProxy: false, timeOffset: 0, isImage: true });
    }
  });

  it('the reason follows the proxy state', () => {
    expect(resolvePlaybackPath(still('tga', { proxy: { status: 'running', progress: 0 } }), true).reason).toBe('TGA image needs a preview proxy; proxy in progress');
    expect(resolvePlaybackPath(still('tga', { proxy: { status: 'failed', error: 'boom' } }), false).reason).toBe('TGA image needs a preview proxy; proxy failed: boom');
    expect(resolvePlaybackPath(still('tga', { offline: true }), true).reason).toBe('media offline');
  });

  it('the PNG proxy is drawn as an image, proxies on or off', () => {
    const m = still('exr', { proxy: { status: 'ready', path: '/cache/proxies/k_still.png' } });
    expect(resolvePlaybackPath(m, false)).toEqual({ path: '/cache/proxies/k_still.png', usingProxy: true, timeOffset: 0, isImage: true });
    expect(resolvePlaybackPath(m, true)).toEqual({ path: '/cache/proxies/k_still.png', usingProxy: true, timeOffset: 0, isImage: true });
  });

  it('an AVIF saved as a playable mov video (older probe) is a still that needs its PNG proxy', () => {
    const m = still('avif', { kind: 'video', probe: { ...still('avif').probe!, container: 'mov', browserPlayable: true, playabilityReason: undefined } });
    expect(isStillImage(m)).toBe(true);
    expect(mediaNeedsProxyForPreview(m)).toBe(true);
    expect(resolvePlaybackPath(m, true)).toMatchObject({ path: null, reason: 'AVIF image needs a preview proxy; generate a proxy to preview' });
    expect(resolvePlaybackPath({ ...m, proxy: { status: 'ready', path: '/c/k_still.png' } }, false)).toMatchObject({ path: '/c/k_still.png', isImage: true });
  });

  it('the Source monitor names the format', () => {
    expect(describeDecodeProblem(still('tga'))).toBe('TGA image needs a preview proxy');
  });
});

describe('proxy eligibility allows stills that need one', () => {
  it('Proxies tab, timeline badge, Program chip', () => {
    const tiff = still('tiff');
    const png = still('png');
    expect(proxyEligible(tiff)).toBe(true);
    expect(needsProxy(tiff)).toBe(true);
    expect(proxyEligible(png)).toBe(false);
    expect(proxyEligible(still('tiff', { offline: true }))).toBe(false);
    expect(proxyEligible(still('tiff', { probe: undefined }))).toBe(false);
    expect(mediaNeedsProxy(tiff)).toBe(true);
    expect(mediaNeedsProxy(still('tiff', { proxy: { status: 'ready', path: '/p.png' } }))).toBe(false);
    expect(mediaNeedsProxy(png)).toBe(false);
    const split = classifyMissing([{ clipId: 'c', mediaId: tiff.id, reason: 'x' }], { [tiff.id]: tiff });
    expect(split).toMatchObject({ needsProxy: 1, other: 0, proxyMediaIds: [tiff.id] });
  });
});
