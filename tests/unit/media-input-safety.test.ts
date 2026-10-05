/**
 * Media input paths are never interpreted as FFmpeg protocols (a project file is user-shareable, so a media
 * path like `concat:/a|/b`, `subfile,,…:/x`, `http://…` or `pipe:0` must not make ffmpeg read other files,
 * the network or stdin). Every media service refuses a non-absolute media path with a clear error and hands
 * ffmpeg / ffprobe `file:<absolute path>`; FFmpeg's file protocol takes the rest literally, so names with
 * spaces, '#', '?', '%', ':', '&', ';', '[]', quotes and unicode still work. Uses the real ffmpeg on PATH.
 * On Windows, names with characters the file system forbids ('<>:"|?*', a trailing dot or space) cannot exist,
 * so only those individual names are left out there (or the forbidden character dropped from a folder name).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recut-media-input-')));
process.env.RECUT_CACHE_DIR = path.join(tmp, 'cache');

import { assertAbsoluteMediaPath, ffmpegFileArg, getFfmpegPath } from '../../electron/media/ffmpeg';
import { probeMedia } from '../../electron/media/probe';
import { getFilmstrip, getThumbnail } from '../../electron/media/thumbs';
import { computeWaveform, getWaveform } from '../../electron/media/waveform';
import { buildProxyArgs, startProxyJob } from '../../electron/media/proxy';
import { startSceneDetectJob } from '../../electron/media/sceneDetect';
import { extractSubtitles } from '../../electron/media/subtitlesExtract';
import { cacheKeyForPath } from '../../electron/media/cache';
import { JobQueue } from '../../electron/jobs/jobQueue';

const FF = getFfmpegPath() ?? 'ffmpeg';
const A = path.join(tmp, 'a.ts');
const B = path.join(tmp, 'b.ts');
const SRT_A = path.join(tmp, 'a.srt');
const SRT_B = path.join(tmp, 'b.srt');

function ff(args: string[]): void {
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 });
}

/** Run `fn` with the process working directory at `dir` (relative media paths resolve there). */
async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(dir);
  try { return await fn(); } finally { process.chdir(prev); }
}

beforeAll(() => {
  for (const [out, freq] of [[A, 440], [B, 880]] as const) {
    ff(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=24', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=1`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-f', 'mpegts', out]);
  }
  fs.writeFileSync(SRT_A, '1\n00:00:00,500 --> 00:00:01,000\nSECRET ALPHA\n\n', 'utf8');
  fs.writeFileSync(SRT_B, '2\n00:00:02,000 --> 00:00:03,000\nSECRET BRAVO\n\n', 'utf8');
}, 120_000);

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

const ABSOLUTE = /must be an absolute path/;

describe('protocol-looking media paths are refused (never reach ffmpeg as a protocol)', () => {
  const hostile = () => [
    `concat:${A}|${B}`,
    `subfile,,start,0,end,100,,:${A}`,
    `tee:${A}`,
    'http://127.0.0.1:9/clip.mp4',
    'pipe:0',
    'fd:0',
    'clip.mp4',
    '',
  ];

  it('assertAbsoluteMediaPath / ffmpegFileArg: refuse non-absolute paths, file: URL for absolute ones', () => {
    for (const p of hostile()) {
      expect(() => assertAbsoluteMediaPath(p), p).toThrow(ABSOLUTE);
      expect(() => ffmpegFileArg(p), p).toThrow(ABSOLUTE);
    }
    expect(ffmpegFileArg(A)).toBe(`file:${A}`);
    // Windows forms (checked with win32 path rules on every platform).
    expect(ffmpegFileArg('C:\\Users\\me\\clip #1.mp4', 'win32')).toBe('file:C:\\Users\\me\\clip #1.mp4');
    expect(ffmpegFileArg('D:/media/clip.mp4', 'win32')).toBe('file:D:/media/clip.mp4');
    expect(ffmpegFileArg('\\\\server\\share\\clip.mp4', 'win32')).toBe('file:\\\\server\\share\\clip.mp4');
    expect(() => ffmpegFileArg('C:clip.mp4', 'win32')).toThrow(ABSOLUTE); // drive-relative
    expect(() => ffmpegFileArg('concat:C:\\a.mp4|C:\\b.mp4', 'win32')).toThrow(ABSOLUTE);
    expect(() => ffmpegFileArg('http://x/y.mp4', 'win32')).toThrow(ABSOLUTE);
  });

  it('extractSubtitles("concat:<a.srt>|<b.srt>") does not read the two files', async () => {
    const p = `concat:${SRT_A}|${SRT_B}`;
    let text: string | null = null;
    const err = await extractSubtitles(p, 0).then((t) => { text = t; return null; }, (e: Error) => e);
    expect(text).toBeNull(); // before the fix: "SECRET ALPHA ... SECRET BRAVO"
    expect(err?.message).toMatch(ABSOLUTE);
  });

  it('computeWaveform("concat:<a>|<b>") does not decode the two files', async () => {
    await expect(computeWaveform(`concat:${A}|${B}`)).rejects.toThrow(ABSOLUTE);
    await expect(getWaveform(`concat:${A}|${B}`, 'k')).rejects.toThrow(ABSOLUTE);
  });

  // A relative path whose literal file exists in the working directory: stat() succeeds, so only the
  // absolute-path rule (and the file: prefix) keeps ffmpeg from treating it as the concat protocol.
  const decoy = 'concat:a.ts|b.ts';
  beforeAll(() => { fs.writeFileSync(path.join(tmp, decoy), 'not media'); });

  it('probeMedia / cacheKeyForPath refuse it', async () => {
    await inDir(tmp, async () => {
      await expect(probeMedia(decoy)).rejects.toThrow(ABSOLUTE);
      await expect(cacheKeyForPath(decoy)).rejects.toThrow(ABSOLUTE);
      for (const p of hostile()) await expect(probeMedia(p), p).rejects.toThrow(ABSOLUTE);
    });
  });

  it('thumbnails / filmstrips refuse it and write nothing', async () => {
    await inDir(tmp, async () => {
      await expect(getThumbnail({ path: decoy, time: 0.5, width: 64, mediaId: 'm' })).rejects.toThrow(ABSOLUTE);
      await expect(getFilmstrip({ path: decoy, times: [0.1, 0.5], width: 64, mediaId: 'm' })).rejects.toThrow(ABSOLUTE);
    });
    const thumbs = path.join(tmp, 'cache', 'thumbs');
    const written = fs.existsSync(thumbs) ? fs.readdirSync(thumbs, { recursive: true }).filter((f) => String(f).endsWith('.jpg')) : [];
    expect(written).toEqual([]);
  });

  it('proxy and scene-detection jobs refuse it', async () => {
    const q = new JobQueue({ throttleMs: 10 });
    await inDir(tmp, async () => {
      await expect(startProxyJob(q, { mediaId: 'm', path: decoy, height: 120 })).rejects.toThrow(ABSOLUTE);
      const job = startSceneDetectJob(q, { mediaId: 'm', path: decoy, threshold: 0.4, duration: 0 });
      const final = await q.waitFor(job.id);
      expect(final.status).toBe('failed');
      expect(final.error).toMatch(ABSOLUTE);
    });
  });

  it('buildProxyArgs: input and output are file: URLs', () => {
    const out = path.join(tmp, 'cache', 'p.mp4.part-1');
    const args = buildProxyArgs({ mediaId: 'm', path: A, height: 120 }, { targetHeight: 120, hasVideo: true, hasAudio: true, outPart: out });
    expect(args[args.indexOf('-i') + 1]).toBe(`file:${A}`);
    expect(args[args.length - 1]).toBe(`file:${out}`);
    expect(() => buildProxyArgs({ mediaId: 'm', path: `concat:${A}|${B}`, height: 120 }, { targetHeight: 120, hasVideo: true, hasAudio: true, outPart: out }))
      .toThrow(ABSOLUTE);
  });
});

const WIN = process.platform === 'win32';
/** A file / folder name Windows refuses: a forbidden or control character, or a trailing dot or space. */
const WIN_ILLEGAL_NAME = /[<>:"|?*\x00-\x1f]|[. ]$/;
/** True when `name` can exist as a single file name on this platform. */
const legalHere = (name: string): boolean => !/[/\0]/.test(name) && !(WIN && WIN_ILLEGAL_NAME.test(name));
/** `name` with the characters this platform forbids removed (unchanged on Linux / macOS). */
const nameHere = (name: string): string => (WIN ? name.replace(/[<>:"|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '') : name);

describe('ordinary absolute paths with unusual characters still work', () => {
  const allNames = [
    'clip with spaces.ts', 'hash #1.ts', 'what?x=1.ts', '100% done.ts', 'pct%41%2F.ts', 'colon:name.ts', 'ünïcödé 日本語 🎬.ts',
    // Legal on every platform (Windows included); meaningful to shells, URL parsers or ffmpeg's option syntax.
    'amp & semi; comma,.ts', '[brackets] {braces}.ts', "it's ^caret =eq.ts", 'concat~a.ts!b.ts', 'dot. inside.ts',
  ];
  const names = allNames.filter(legalHere);
  const dirName = nameHere('odd dir #?%');

  it('the chosen names are legal here, and only Windows-impossible ones are left out', () => {
    for (const n of [...names, dirName]) expect(WIN && WIN_ILLEGAL_NAME.test(n), n).toBe(false);
    if (WIN) {
      expect(allNames.filter((n) => !legalHere(n))).toEqual(['what?x=1.ts', 'colon:name.ts']);
      expect(dirName).toBe('odd dir #%');
    } else {
      expect(names).toEqual(allNames);
      expect(dirName).toBe('odd dir #?%');
    }
  });

  it.each(names)('%s: probe, thumbnail, filmstrip, waveform', async (name) => {
    const dir = path.join(tmp, dirName);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.copyFileSync(A, p);
    const probe = await probeMedia(p);
    expect(probe.video?.width).toBe(160);
    expect(probe.duration).toBeGreaterThan(0.5);
    expect(probe.duration).toBeLessThan(1.5); // one file, not a concatenation
    const thumb = await getThumbnail({ path: p, time: 0.5, width: 64, mediaId: 'm' });
    expect(fs.statSync(thumb).size).toBeGreaterThan(200);
    const strip = await getFilmstrip({ path: p, times: [0.1, 0.4, 0.7], width: 64, mediaId: 'm' });
    for (const f of strip) expect(fs.statSync(f).size).toBeGreaterThan(200);
    const wave = await computeWaveform(p);
    expect(wave.peaks.length).toBeGreaterThan(0);
  }, 60_000);

  it('proxy, scene detection and subtitle extraction on a "#?%" (Windows: "#%&;") + unicode path', async () => {
    const dir = path.join(tmp, nameHere('jobs #?% ü'));
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, WIN ? 'clip 100%#&;.ts' : 'clip 100%?#.ts');
    expect(legalHere(path.basename(p)) && legalHere(path.basename(dir)), p).toBe(true);
    fs.copyFileSync(A, p);
    const q = new JobQueue({ throttleMs: 10 });
    const { job } = await startProxyJob(q, { mediaId: 'm', path: p, height: 120 });
    const final = await q.waitFor(job.id);
    expect(final.status, final.error).toBe('done');
    const sjob = startSceneDetectJob(q, { mediaId: 'm', path: p, threshold: 0.4, duration: 0 });
    const sfinal = await q.waitFor(sjob.id);
    expect(sfinal.status, sfinal.error).toBe('done');
    const srt = path.join(dir, WIN ? 'subs 50%#&;.srt' : 'subs 50%?#.srt');
    fs.copyFileSync(SRT_A, srt);
    const text = await extractSubtitles(srt, 0);
    expect(text).toContain('SECRET ALPHA');
    expect(text).not.toContain('SECRET BRAVO');
  }, 60_000);
});
