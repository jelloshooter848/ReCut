/**
 * Still images end to end on real FFmpeg output (Roadmap §2 B): each format the preview cannot draw gets a PNG proxy,
 * and the export shows the same picture as that proxy. Formats the local FFmpeg cannot write or read are skipped
 * (HEIC needs FFmpeg 7+ to demux; JPEG XL needs libjxl).
 *
 * Also: EXIF orientation agrees between the probe, the thumbnail and the export (Chromium applies it for the preview).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { MediaItem } from '@shared/model';
import { JobQueue } from '../../electron/jobs/jobQueue';
import { startProxyJob, type ProxyResult } from '../../electron/media/proxy';
import { getThumbnail } from '../../electron/media/thumbs';
import { buildRenderGraph } from '../../electron/export/renderGraph';
import { FFMPEG, SCRATCH, ff, ffprobeJson, makeMediaItem, makeSeq, vclip, exportSeq, request, countFrames, FPS_24 } from './helpers';
import { writeHeifFromMp4, writeJpegWithOrientation } from './stillfiles';

const DIR = path.join(SCRATCH, 'stills');
const W = 320, H = 240;
/** Quadrants: red top-left, lime top-right, blue bottom-left, white bottom-right. */
const QUADS: { name: string; x: number; y: number; rgb: [number, number, number] }[] = [
  { name: 'TL red', x: 80, y: 60, rgb: [255, 0, 0] },
  { name: 'TR lime', x: 240, y: 60, rgb: [0, 255, 0] },
  { name: 'BL blue', x: 80, y: 180, rgb: [0, 0, 255] },
  { name: 'BR white', x: 240, y: 180, rgb: [255, 255, 255] },
];
const PATTERN = `color=c=white:s=${W}x${H}:d=1,format=rgb24,`
  + `drawbox=x=0:y=0:w=160:h=120:c=red:t=fill,drawbox=x=160:y=0:w=160:h=120:c=lime:t=fill,drawbox=x=0:y=120:w=160:h=120:c=blue:t=fill`;

function run(args: string[]): boolean {
  try { execFileSync(FFMPEG, ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] }); return true; } catch { return false; }
}
function decodes(file: string): boolean { return fs.existsSync(file) && run(['-i', file, '-frames:v', '1', '-f', 'null', '-']); }

interface Fmt { ext: string; make: (out: string, ref: string) => boolean; lossy?: boolean }
const FORMATS: Fmt[] = [
  { ext: 'tiff', make: (o, r) => run(['-i', r, o]) },
  { ext: 'tga', make: (o, r) => run(['-i', r, o]) },
  { ext: 'jxl', make: (o, r) => run(['-i', r, '-c:v', 'libjxl', '-distance', '0', o]) },
  { ext: 'avif', make: (o, r) => run(['-i', r, '-frames:v', '1', o]), lossy: true },
  { ext: 'heic', lossy: true, make: (o, r) => {
    const mp4 = `${o}.hevc.mp4`;
    if (!run(['-i', r, '-frames:v', '1', '-c:v', 'libx265', '-x265-params', 'log-level=none', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', mp4])) return false;
    writeHeifFromMp4(mp4, o);
    return true;
  } },
  { ext: 'exr', make: (o, r) => run(['-i', r, '-c:v', 'exr', o]) },
  // ImageMagick's RLE PSD is rejected by FFmpeg 6.1's psd decoder ("Not enough data for rle scanline"): use raw data.
  { ext: 'psd', make: (o, r) => { try { execFileSync('convert', [r, '-compress', 'none', o], { stdio: 'ignore' }); return true; } catch { return false; } } },
  { ext: 'dpx', make: (o, r) => run(['-i', r, o]) },
];

async function rgbFrame(file: string, frame = 0, w = W, h = H): Promise<Buffer> {
  const { stdout } = await ff(['-i', file, '-vf', `select=eq(n\\,${frame}),scale=${w}:${h}:flags=neighbor`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 });
  return stdout;
}
function px(buf: Buffer, x: number, y: number, w = W): [number, number, number] { const i = (y * w + x) * 3; return [buf[i], buf[i + 1], buf[i + 2]]; }
function near(a: number[], b: number[], tol: number): boolean { return a.every((v, i) => Math.abs(v - b[i]) <= tol); }
function meanAbsDiff(a: Buffer, b: Buffer): number { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }

const queue = new JobQueue({ throttleMs: 10 });
async function stillProxy(m: MediaItem): Promise<ProxyResult> {
  const { job, outputPath } = await startProxyJob(queue, { mediaId: m.id, path: m.path, height: 540 });
  const final = await queue.waitFor(job.id);
  expect(final.status, `${m.name}: ${final.error ?? ''}`).toBe('done');
  const r = final.result as ProxyResult;
  expect(r.path).toBe(outputPath);
  return r;
}

const made: { fmt: Fmt; file: string; item: MediaItem; proxy: ProxyResult }[] = [];
const skipped: string[] = [];
let ref = '';

beforeAll(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  process.env.RECUT_CACHE_DIR = path.join(DIR, 'cache');
  ref = path.join(DIR, 'ref.png');
  expect(run(['-f', 'lavfi', '-i', PATTERN, '-frames:v', '1', ref])).toBe(true);
});

describe('still proxies per format', () => {
  it('every format the local FFmpeg handles becomes a still with an upright 320x240 PNG proxy that shows the picture', async () => {
    for (const fmt of FORMATS) {
      const file = path.join(DIR, `pattern.${fmt.ext}`);
      if (!fmt.make(file, ref)) { skipped.push(`${fmt.ext}: local FFmpeg / tools cannot write it`); continue; }
      if (!decodes(file)) { skipped.push(`${fmt.ext}: local FFmpeg cannot decode it`); continue; }
      const item = await makeMediaItem(file);
      expect(item.kind, fmt.ext).toBe('image');
      expect(item.probe!.playabilityReason, fmt.ext).toBe('still image');
      expect(item.probe!.browserPlayable, fmt.ext).toBe(false);
      expect(item.probe!.duration, fmt.ext).toBe(0);
      const proxy = await stillProxy(item);
      expect(path.basename(proxy.path), fmt.ext).toMatch(/^[0-9a-f]{40}_still\.png$/);
      expect([proxy.width, proxy.height], fmt.ext).toEqual([W, H]);
      const pj = await ffprobeJson(proxy.path);
      expect(pj.streams[0].codec_name).toBe('png');
      expect(pj.streams[0].pix_fmt).toBe('rgb24');
      const rgb = await rgbFrame(proxy.path);
      const tol = fmt.lossy ? 40 : 6;
      for (const q of QUADS) expect(near(px(rgb, q.x, q.y), q.rgb, tol), `${fmt.ext} ${q.name}: ${px(rgb, q.x, q.y)}`).toBe(true);
      made.push({ fmt, file, item, proxy });
    }
    console.log(`[still proxies] built: ${made.map((m) => m.fmt.ext).join(', ')}; skipped: ${skipped.join('; ') || 'none'}`);
    for (const must of ['tiff', 'tga', 'avif', 'exr', 'dpx']) expect(made.map((m) => m.fmt.ext)).toContain(must);
  }, 300_000);

  it('a second request is served from the cache; concurrent requests share one job', async () => {
    const m = made.find((x) => x.fmt.ext === 'tiff')!;
    const again = await stillProxy(m.item);
    expect(again).toMatchObject({ path: m.proxy.path, cached: true });
    const [a, b] = await Promise.all([
      startProxyJob(queue, { mediaId: 'x', path: m.file, height: 360 }),
      startProxyJob(queue, { mediaId: 'x', path: m.file, height: 720 }),
    ]);
    expect(b.job.id).toBe(a.job.id); // the height does not matter for a still: one output path
    expect(a.outputPath).toBe(m.proxy.path);
    await queue.waitFor(a.job.id);
    expect(fs.readdirSync(path.dirname(m.proxy.path)).filter((f) => f.includes('.part'))).toEqual([]);
  });

  it('a still with alpha gets an RGBA proxy; a 5000 px still is capped at 3840 on its long side', async () => {
    const alpha = path.join(DIR, 'alpha.tga');
    expect(run(['-f', 'lavfi', '-i', `color=c=red@0.5:s=64x48,format=rgba`, '-frames:v', '1', alpha])).toBe(true);
    const a = await stillProxy(await makeMediaItem(alpha));
    expect((await ffprobeJson(a.path)).streams[0].pix_fmt).toBe('rgba');
    const big = path.join(DIR, 'big.tiff');
    expect(run(['-f', 'lavfi', '-i', 'color=c=gray:s=5000x1000', '-frames:v', '1', '-pix_fmt', 'rgb24', big])).toBe(true);
    const b = await stillProxy(await makeMediaItem(big));
    expect([b.width, b.height]).toEqual([3840, 768]);
  }, 120_000);

  it('a non-square-pixel still is un-squeezed to its display shape', async () => {
    const anamorphic = path.join(DIR, 'anamorphic.tiff');
    expect(run(['-f', 'lavfi', '-i', 'color=c=gray:s=200x100,setsar=2/1', '-frames:v', '1', '-pix_fmt', 'rgb24', anamorphic])).toBe(true);
    const sar = ((await ffprobeJson(anamorphic)).streams[0] as { sample_aspect_ratio?: string }).sample_aspect_ratio;
    if (sar !== '2:1') { console.log(`[anamorphic] skipped: the TIFF writer stored SAR ${sar}`); return; }
    const p = await stillProxy(await makeMediaItem(anamorphic));
    console.log(`[anamorphic] source 200x100 SAR ${sar} -> proxy ${p.width}x${p.height}`);
    expect([p.width, p.height]).toEqual([400, 100]);
  });
});

describe('still export matches the preview proxy', () => {
  it('a sequence of every built format exports; each clip equals its PNG proxy', async () => {
    const seq = makeSeq(FPS_24, W, H);
    const N = 6;
    made.forEach((m, k) => vclip(seq, m.item, k * N, N, 0));
    const g = buildRenderGraph(request(seq, made.map((m) => m.item)));
    console.log(`[still export] inputs: ${g.args.filter((a, i) => g.args[i - 1] === '-i' || a === '-loop').length}`);
    const { outputPath } = await exportSeq(seq, made.map((m) => m.item));
    expect(await countFrames(outputPath)).toBe(made.length * N);
    const rows: string[] = [];
    for (const [k, m] of made.entries()) {
      const out = await rgbFrame(outputPath, k * N + N / 2);
      const prev = await rgbFrame(m.proxy.path);
      const diff = meanAbsDiff(out, prev);
      rows.push(`${m.fmt.ext}: mean |export - proxy| = ${diff.toFixed(2)}`);
      expect(diff, m.fmt.ext).toBeLessThan(6);
      for (const q of QUADS) expect(near(px(out, q.x, q.y), px(prev, q.x, q.y), 12), `${m.fmt.ext} ${q.name}: export ${px(out, q.x, q.y)} proxy ${px(prev, q.x, q.y)}`).toBe(true);
    }
    console.log(`[still export]\n  ${rows.join('\n  ')}`);
  }, 300_000);

  it('a one-frame GIF (gif demuxer, no -loop option) exports as a still', async () => {
    const gif = path.join(DIR, 'one.gif');
    expect(run(['-i', ref, '-frames:v', '1', gif])).toBe(true);
    const item = await makeMediaItem(gif);
    expect(item.kind).toBe('image');
    const seq = makeSeq(FPS_24, W, H);
    vclip(seq, item, 0, 12, 0);
    const { outputPath } = await exportSeq(seq, [item]);
    expect(await countFrames(outputPath)).toBe(12);
    const out = await rgbFrame(outputPath, 11);
    for (const q of QUADS) expect(near(px(out, q.x, q.y), q.rgb, 40), `gif ${q.name}: ${px(out, q.x, q.y)}`).toBe(true);
  });

  it('an animated GIF is a video: it gets an mp4 proxy and exports its frames', async () => {
    const gif = path.join(DIR, 'anim.gif');
    expect(run(['-f', 'lavfi', '-i', 'color=c=black:s=64x48:r=10:d=2,drawtext=text=%{n}:fontcolor=white:x=2:y=2', gif])
      || run(['-f', 'lavfi', '-i', 'testsrc2=s=64x48:r=10:d=2', gif])).toBe(true);
    const item = await makeMediaItem(gif);
    expect(item.kind).toBe('video');
    expect(item.probe!.duration).toBeGreaterThan(1.5);
    const { job, outputPath: proxyOut } = await startProxyJob(queue, { mediaId: item.id, path: gif, height: 144 });
    expect(proxyOut).toMatch(/_144p_all\.mp4$/); // the video proxy (every audio stream), not the still PNG
    expect((await queue.waitFor(job.id)).status).toBe('done');
    const seq = makeSeq(FPS_24, W, H);
    vclip(seq, item, 0, 24, 0.5);
    const { outputPath } = await exportSeq(seq, [item]);
    expect(await countFrames(outputPath)).toBe(24);
  });
});

describe('EXIF orientation: probe, thumbnail, export and proxy agree', () => {
  it('a JPEG with Orientation=6 (rotate 90 CW) is upright everywhere', async () => {
    const jpg = path.join(DIR, 'ref.jpg');
    expect(run(['-i', ref, '-q:v', '2', jpg])).toBe(true);
    const rot = path.join(DIR, 'rot6.jpg');
    writeJpegWithOrientation(jpg, rot, 6);
    const item = await makeMediaItem(rot);
    expect(item.kind).toBe('image');
    // Upright size: the probe now reads the frame's display matrix (FFmpeg's EXIF orientation).
    expect([item.probe!.video!.width, item.probe!.video!.height]).toEqual([H, W]);
    // Rotated 90 CW: blue top-left, red top-right, white bottom-left, lime bottom-right.
    const upright: [string, number, number, [number, number, number]][] = [
      ['TL blue', 0.25, 0.25, [0, 0, 255]], ['TR red', 0.75, 0.25, [255, 0, 0]], ['BL white', 0.25, 0.75, [255, 255, 255]], ['BR lime', 0.75, 0.75, [0, 255, 0]],
    ];
    // Thumbnail (FFmpeg decode, as the Project panel / filmstrip show it).
    const thumb = await getThumbnail({ path: rot, time: 0, width: 120 });
    const tj = await ffprobeJson(thumb);
    expect([tj.streams[0].width, tj.streams[0].height]).toEqual([120, 160]);
    const trgb = await rgbFrame(thumb, 0, 120, 160);
    for (const [name, fx, fy, c] of upright) expect(near(px(trgb, Math.floor(120 * fx), Math.floor(160 * fy), 120), c, 60), `thumb ${name}`).toBe(true);
    // A still proxy of the same file (what a TIFF/TGA would get) is upright too.
    const p = await stillProxy(item);
    expect([p.width, p.height]).toEqual([H, W]);
    // Export: a portrait picture pillarboxed in the 320x240 frame (180x240 at x = 70).
    const seq = makeSeq(FPS_24, W, H);
    vclip(seq, item, 0, 6, 0);
    const { outputPath } = await exportSeq(seq, [item]);
    const out = await rgbFrame(outputPath, 3);
    expect(near(px(out, 20, 120), [0, 0, 0], 24)).toBe(true); // pillarbox
    for (const [name, fx, fy, c] of upright) expect(near(px(out, 70 + Math.floor(180 * fx), Math.floor(240 * fy)), c, 60), `export ${name}: ${px(out, 70 + Math.floor(180 * fx), Math.floor(240 * fy))}`).toBe(true);
  }, 120_000);

  it('a rotated AVIF (irot): the preview proxy and the export come from the same FFmpeg decode', async () => {
    const mp4 = path.join(DIR, 'rot.av1.mp4');
    if (!run(['-i', ref, '-frames:v', '1', '-c:v', 'libaom-av1', '-still-picture', '1', '-pix_fmt', 'yuv420p', mp4])) { console.log('[avif irot] skipped: no libaom-av1'); return; }
    const avif = path.join(DIR, 'rot.avif');
    writeHeifFromMp4(mp4, avif, 1); // 90 degrees counter-clockwise: Chromium draws it 240x320
    if (!decodes(avif)) { console.log('[avif irot] skipped: the local FFmpeg cannot read it'); return; }
    const item = await makeMediaItem(avif);
    expect(item.kind).toBe('image');
    const p = await stillProxy(item);
    const seq = makeSeq(FPS_24, W, H);
    vclip(seq, item, 0, 6, 0);
    const { outputPath } = await exportSeq(seq, [item]);
    const out = await rgbFrame(outputPath, 3);
    const portrait = p.height! > p.width!;
    // FFmpeg 6.1 ignores irot (landscape, fills the frame); a build that applies it gives a pillarboxed portrait.
    console.log(`[avif irot] FFmpeg decodes ${p.width}x${p.height} (${portrait ? 'applies' : 'ignores'} irot); export left edge ${px(out, 20, 120)}`);
    expect(near(px(out, 20, 120), [0, 0, 0], 24)).toBe(portrait);
    const prev = await rgbFrame(p.path, 0, portrait ? H : W, portrait ? W : H);
    // The proxy's top-left quadrant colour is where the export shows it (fitted into the frame the same way).
    const k = portrait ? H / W : 1, x0 = portrait ? (W - H * H / W) / 2 : 0;
    const exp = px(out, Math.floor(x0 + (portrait ? H : W) * k / 4), Math.floor(H / 4));
    expect(near(exp, px(prev, Math.floor((portrait ? H : W) / 4), Math.floor((portrait ? W : H) / 4), portrait ? H : W), 40), `export ${exp}`).toBe(true);
  });

  it('a HEIC with irot (90 CCW) decodes upright when the local FFmpeg reads HEIF (else skipped)', async () => {
    const mp4 = path.join(DIR, 'rot.hevc.mp4');
    if (!run(['-i', ref, '-frames:v', '1', '-c:v', 'libx265', '-x265-params', 'log-level=none', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', mp4])) { console.log('[heic irot] skipped: no libx265'); return; }
    const heic = path.join(DIR, 'rot.heic');
    writeHeifFromMp4(mp4, heic, 1);
    if (!decodes(heic)) { console.log('[heic irot] skipped: the local FFmpeg cannot demux HEIF (needs 7.0+)'); return; }
    const item = await makeMediaItem(heic);
    expect(item.kind).toBe('image');
    const p = await stillProxy(item);
    console.log(`[heic irot] probe ${item.probe!.video!.width}x${item.probe!.video!.height}, proxy ${p.width}x${p.height}`);
    expect([p.width, p.height]).toEqual([H, W]);
  });
});
