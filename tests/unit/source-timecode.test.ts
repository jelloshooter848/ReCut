/**
 * Embedded source start timecode (MediaProbe.startTimecode): read from ffprobe output (format tag, video stream tag,
 * tmcd data stream; drop-frame and non-drop; absent or malformed), from real camera-style files written by FFmpeg
 * (MOV / MP4 with a tmcd track, MXF), kept or dropped by the project loader, and used by the source timecode display.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MediaProbe, Rational } from '@shared/model';
import { createMediaItem, createProject, normalizeProject } from '@shared/project';
import {
  formatSourceFrameTimecode, formatSourceTimecode, framesToSeconds, parseStartTimecode, timecodeDayFrames, timecodeOriginAt,
} from '@shared/time';
import { probeFromFfprobe, probeMedia, probeStartTimecode, type FfprobeOutput, type FfprobeStream } from '../../electron/media/probe';
import { originalTimecode, mediaSourceTimecode } from '../../src/state/selectors';
import { sourceTimecode as transcriptSourceTimecode } from '../../src/panels/transcript/shared';
import { rangeLabel } from '../../src/panels/scenes/sceneUtils';
import { makeClip } from '@shared/timeline';

const F25: Rational = { num: 25, den: 1 };
const F2997: Rational = { num: 30000, den: 1001 };
const F5994: Rational = { num: 60000, den: 1001 };
const F23: Rational = { num: 24000, den: 1001 };

// ------------------------------------------------------------------------------------------------ ffprobe JSON shapes

/** ffprobe -show_format -show_streams of FFmpeg 6.1's `-timecode` MOV (trimmed): the video stream and the tmcd track. */
function movJson(tc: string, rate = '30000/1001', opts: { videoTag?: boolean; formatTag?: string } = {}): FfprobeOutput {
  const video: FfprobeStream = {
    index: 0, codec_name: 'h264', codec_type: 'video', codec_tag_string: 'avc1', width: 320, height: 240, r_frame_rate: rate, avg_frame_rate: rate,
    start_time: '0.000000', duration: '1.001000', nb_frames: '30',
    tags: { handler_name: 'VideoHandler', vendor_id: 'FFMP', ...(opts.videoTag === false ? {} : { timecode: tc }) },
  };
  const tmcd: FfprobeStream = {
    index: 1, codec_type: 'data', codec_tag_string: 'tmcd', r_frame_rate: '0/0', avg_frame_rate: rate, start_time: '0.000000', duration: '1.001000',
    tags: { language: 'eng', handler_name: 'TimeCodeHandler', timecode: tc },
  };
  return {
    streams: [video, tmcd],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1.001000', start_time: '0.000000', size: '10000', tags: { major_brand: 'qt  ', ...(opts.formatTag ? { timecode: opts.formatTag } : {}) } },
  };
}

/** An FFmpeg MXF (OP1a): the timecode is a format tag only. */
function mxfJson(tc: string): FfprobeOutput {
  return {
    streams: [{ index: 0, codec_name: 'mpeg2video', codec_type: 'video', width: 320, height: 240, r_frame_rate: '25/1', avg_frame_rate: '25/1', start_time: '0.000000', duration: '1.000000', tags: { file_package_umid: '0x06' } }],
    format: { format_name: 'mxf', duration: '1.000000', start_time: '0.000000', size: '10000', tags: { company_name: 'FFmpeg', timecode: tc } },
  };
}

describe('probe: embedded start timecode', () => {
  it('reads a drop-frame tmcd MOV at 29.97 (01:00:00;00 = frame 107892)', () => {
    const p = probeFromFfprobe(movJson('01:00:00;00'), '/m/a.mov');
    expect(p.startTimecode).toEqual({ text: '01:00:00;00', rate: F2997, dropFrame: true, frames: 107892 });
  });

  it('reads a non-drop label at 29.97 as non-drop (01:00:00:00 = frame 108000)', () => {
    const p = probeFromFfprobe(movJson('01:00:00:00'), '/m/a.mp4');
    expect(p.startTimecode).toEqual({ text: '01:00:00:00', rate: F2997, dropFrame: false, frames: 108000 });
  });

  it('reads a format tag (MXF) at the video rate', () => {
    expect(probeFromFfprobe(mxfJson('10:00:00:00'), '/m/a.mxf').startTimecode).toEqual({ text: '10:00:00:00', rate: F25, dropFrame: false, frames: 900000 });
  });

  it('priority: format tag, then the video stream tag, then a tmcd data stream', () => {
    const all = movJson('02:00:00:00', '25/1', { formatTag: '01:00:00:00' });
    all.streams![1].tags!.timecode = '03:00:00:00';
    expect(probeFromFfprobe(all, '/m/a.mov').startTimecode?.text).toBe('01:00:00:00');
    const noFormat = movJson('02:00:00:00', '25/1');
    noFormat.streams![1].tags!.timecode = '03:00:00:00';
    expect(probeFromFfprobe(noFormat, '/m/a.mov').startTimecode?.text).toBe('02:00:00:00');
    const tmcdOnly = movJson('03:00:00:00', '25/1', { videoTag: false });
    expect(probeFromFfprobe(tmcdOnly, '/m/a.mov').startTimecode).toEqual({ text: '03:00:00:00', rate: F25, dropFrame: false, frames: 270000 });
  });

  it('a data stream that is not tmcd is not a timecode source', () => {
    const j = movJson('01:00:00:00', '25/1', { videoTag: false });
    j.streams![1].codec_tag_string = 'gpmd';
    expect(probeFromFfprobe(j, '/m/a.mp4').startTimecode).toBeUndefined();
    // codec_name 'tmcd' (other demuxers) counts.
    j.streams![1].codec_tag_string = undefined; j.streams![1].codec_name = 'tmcd';
    expect(probeFromFfprobe(j, '/m/a.mp4').startTimecode?.text).toBe('01:00:00:00');
  });

  it('59.94 drop-frame, and a drop-frame separator at a rate without drop-frame is read as non-drop', () => {
    expect(probeFromFfprobe(movJson('00:10:00;00', '60000/1001'), '/m/a.mov').startTimecode).toEqual({ text: '00:10:00;00', rate: F5994, dropFrame: true, frames: 35964 });
    expect(probeFromFfprobe(movJson('01:00:00;00', '25/1'), '/m/a.mov').startTimecode).toEqual({ text: '01:00:00:00', rate: F25, dropFrame: false, frames: 90000 });
    // '.' is a drop-frame separator too.
    expect(probeFromFfprobe(movJson('01:00:00.00'), '/m/a.mov').startTimecode?.dropFrame).toBe(true);
  });

  it('absent: no tag anywhere, an empty tag, or no streams', () => {
    const j = movJson('', '25/1');
    expect(probeFromFfprobe(j, '/m/a.mov').startTimecode).toBeUndefined();
    delete j.streams![0].tags!.timecode; delete j.streams![1].tags!.timecode;
    const p = probeFromFfprobe(j, '/m/a.mov');
    expect(p.startTimecode).toBeUndefined();
    expect('startTimecode' in p).toBe(false);
    expect(probeFromFfprobe({ format: { format_name: 'mp3', duration: '3', tags: {} }, streams: [] }, '/m/a.mp3').startTimecode).toBeUndefined();
  });

  it('a malformed label or an unusable rate is ignored, not guessed at', () => {
    for (const bad of ['1:00:00', '25:00:00:00', '01:60:00:00', '01:00:60:00', '01:00:00:25', '01:00:00:25x', 'abc', '-01:00:00:00']) {
      expect(probeFromFfprobe(movJson(bad, '25/1'), '/m/a.mov').startTimecode, bad).toBeUndefined();
    }
    // Frames past the nominal rate at 29.97, and drop-frame labels the count skips (00:01:00;00 / 01:01:00;01).
    for (const bad of ['01:00:00:30', '00:01:00;00', '01:01:00;01']) expect(probeFromFfprobe(movJson(bad), '/m/a.mov').startTimecode, bad).toBeUndefined();
    // No video rate and no tmcd rate: nothing to count at.
    const j = movJson('01:00:00:00', '0/0');
    expect(probeFromFfprobe(j, '/m/a.mov').startTimecode).toBeUndefined();
  });

  it('an audio-only file with a tmcd track counts at the tmcd rate; stills have none', () => {
    const j: FfprobeOutput = {
      streams: [
        { index: 0, codec_name: 'pcm_s24le', codec_type: 'audio', channels: 2, sample_rate: '48000', duration: '10' },
        { index: 1, codec_type: 'data', codec_tag_string: 'tmcd', avg_frame_rate: '25/1', r_frame_rate: '0/0', tags: { timecode: '12:00:00:00' } },
      ],
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '10', tags: {} },
    };
    expect(probeFromFfprobe(j, '/m/sound.mov').startTimecode).toEqual({ text: '12:00:00:00', rate: F25, dropFrame: false, frames: 1080000 });
    const still: FfprobeOutput = {
      streams: [{ index: 0, codec_name: 'mjpeg', codec_type: 'video', width: 10, height: 10, r_frame_rate: '25/1', nb_frames: '1' }],
      format: { format_name: 'image2', tags: { timecode: '01:00:00:00' } },
    };
    expect(probeFromFfprobe(still, '/m/a.jpg').startTimecode).toBeUndefined();
  });

  it('probeStartTimecode with no video: the first tmcd stream with a rate', () => {
    expect(probeStartTimecode([], { tags: { timecode: '01:00:00:00' } }, undefined)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ real files

const exec = promisify(execFile);
const FFMPEG = process.env.RECUT_FFMPEG || 'ffmpeg';

describe('probe: camera-style files written by FFmpeg', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-tc-'));
  const f = (n: string) => path.join(tmp, n);
  const make = (out: string, rate: string, tc: string | null, codec = 'mpeg4') =>
    exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', `testsrc=size=64x64:rate=${rate}`, '-t', '0.4',
      ...(tc ? ['-timecode', tc] : []), '-c:v', codec, f(out)]);
  beforeAll(async () => {
    await Promise.all([
      make('ndf25.mov', '25', '01:00:00:00'),
      make('df2997.mov', '30000/1001', '01:00:00;00'),
      make('ndf2997.mp4', '30000/1001', '01:00:00:00'),
      make('cam.mxf', '25', '10:00:00:00', 'mpeg2video'),
      make('plain.mov', '25', null),
    ]);
  }, 60_000);
  afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('MOV / MP4 tmcd (DF and NDF), MXF, and a file without timecode', async () => {
    expect((await probeMedia(f('ndf25.mov'))).startTimecode).toEqual({ text: '01:00:00:00', rate: F25, dropFrame: false, frames: 90000 });
    expect((await probeMedia(f('df2997.mov'))).startTimecode).toEqual({ text: '01:00:00;00', rate: F2997, dropFrame: true, frames: 107892 });
    expect((await probeMedia(f('ndf2997.mp4'))).startTimecode).toEqual({ text: '01:00:00:00', rate: F2997, dropFrame: false, frames: 108000 });
    expect((await probeMedia(f('cam.mxf'))).startTimecode).toEqual({ text: '10:00:00:00', rate: F25, dropFrame: false, frames: 900000 });
    expect((await probeMedia(f('plain.mov'))).startTimecode).toBeUndefined();
  }, 30_000);
});

// ------------------------------------------------------------------------------------------------ time helpers

describe('parseStartTimecode / formatSourceTimecode', () => {
  it('parses and normalizes labels', () => {
    expect(parseStartTimecode('1:02:03:04', F25)).toEqual({ text: '01:02:03:04', rate: F25, dropFrame: false, frames: ((3600 + 120 + 3) * 25) + 4 });
    expect(parseStartTimecode('23:59:59;29', F2997)?.frames).toBe(timecodeDayFrames(F2997, true) - 1);
    expect(parseStartTimecode('01:00:00:00', { num: 0, den: 1 })).toBeNull();
  });

  it('without an origin it is the app-wide display (unchanged)', () => {
    expect(formatSourceTimecode(61.48, F25)).toBe('00:01:01:12');
    expect(formatSourceTimecode(framesToSeconds(1800, F2997), F2997)).toBe('00:01:00;02');
    expect(formatSourceTimecode(framesToSeconds(1800, F2997), F2997, null)).toBe('00:01:00;02');
    expect(formatSourceFrameTimecode(1800, F2997)).toBe('00:01:00;02');
  });

  it('with an origin it counts from the start timecode in the file\'s own mode', () => {
    const ndf25 = parseStartTimecode('01:00:00:00', F25)!;
    expect(formatSourceTimecode(0, F25, ndf25)).toBe('01:00:00:00');
    expect(formatSourceTimecode(61.48, F25, ndf25)).toBe('01:01:01:12');
    const df = parseStartTimecode('01:00:00;00', F2997)!;
    expect(formatSourceTimecode(framesToSeconds(1800, F2997), F2997, df)).toBe('01:01:00;02');
    // A non-drop 29.97 camera file stays non-drop (the app-wide rule would show drop-frame).
    const ndf = parseStartTimecode('01:00:00:00', F2997)!;
    expect(formatSourceTimecode(framesToSeconds(1800, F2997), F2997, ndf)).toBe('01:01:00:00');
    expect(formatSourceFrameTimecode(1800, F2997, ndf)).toBe('01:01:00:00');
  });

  it('wraps at 24 hours', () => {
    const late = parseStartTimecode('23:59:59:00', F25)!;
    expect(formatSourceTimecode(2, F25, late)).toBe('00:00:01:00');
    const lateDf = parseStartTimecode('23:59:59;00', F2997)!;
    expect(formatSourceFrameTimecode(30, F2997, lateDf)).toBe('00:00:00;00');
  });

  it('at another rate than the timecode\'s, the same instant under the app-wide rule', () => {
    const ndf25 = parseStartTimecode('01:00:00:00', F25)!;
    expect(timecodeOriginAt(ndf25, F23)).toEqual({ frames: Math.round(3600 * 24000 / 1001), dropFrame: false });
    // 3600 s at 29.97 = frame 107892 = 01:00:00;00 drop-frame.
    expect(formatSourceTimecode(0, F2997, ndf25)).toBe('01:00:00;00');
  });
});

// ------------------------------------------------------------------------------------------------ displays

function camMedia(tc: string | null, fps: Rational = F25) {
  const m = createMediaItem('/cam/A001.mov', 'A001.mov');
  const probe: MediaProbe = {
    container: 'mov', duration: 600, size: 1, audio: [], subtitles: [], startTime: 0, browserPlayable: true,
    video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps, avgFps: fps, isVfr: false },
  };
  if (tc) probe.startTimecode = parseStartTimecode(tc, fps)!;
  m.probe = probe;
  return m;
}

describe('source timecode displays', () => {
  it('original source timecode (Inspector, Program SRC) adds the start timecode', () => {
    const clip = makeClip({ mediaId: 'x', name: 'c', kind: 'video', duration: 50, sourceIn: 10 }, 100);
    expect(originalTimecode(clip, 110, F25, camMedia('01:00:00:00')).sourceTimecode).toBe('01:00:10:10');
    expect(originalTimecode(clip, 110, F25, camMedia(null)).sourceTimecode).toBe('00:00:10:10');
    // A 29.97 non-drop camera clip in a 25 fps sequence: media rate, file's own mode.
    expect(originalTimecode(clip, 100, F25, camMedia('01:00:00:00', F2997)).sourceTimecode).toBe('01:00:10:00');
  });

  it('source ranges, transcript lines and scene ranges', () => {
    const m = camMedia('10:00:00:00');
    expect(mediaSourceTimecode(1, m, F23)).toBe('10:00:01:00');
    expect(mediaSourceTimecode(1, undefined, F25)).toBe('00:00:01:00');
    expect(transcriptSourceTimecode(2, m)).toBe('10:00:02:00');
    expect(rangeLabel({ in: 0, out: 4 } as never, F25, m.probe!.startTimecode)).toBe('10:00:00:00 → 10:00:04:00');
  });
});

// ------------------------------------------------------------------------------------------------ project file

describe('project file: startTimecode is optional', () => {
  const load = (tc: unknown) => {
    const p = createProject('P');
    const m = camMedia(null);
    (m.probe as unknown as Record<string, unknown>).startTimecode = tc;
    p.media[m.id] = m;
    return Object.values(normalizeProject(JSON.parse(JSON.stringify(p))).media)[0].probe!;
  };

  it('keeps a valid one, and a probe without one loads as before', () => {
    const tc = parseStartTimecode('01:00:00;00', F2997)!;
    expect(load(tc).startTimecode).toEqual(tc);
    expect('startTimecode' in load(undefined)).toBe(false);
  });

  it('drops one whose label, rate, mode or frame count do not agree', () => {
    const ok = parseStartTimecode('01:00:00;00', F2997)!;
    for (const bad of [
      'x', null, { ...ok, frames: 1 }, { ...ok, dropFrame: false }, { ...ok, text: '01:00:00:00' }, { ...ok, rate: { num: 0, den: 1 } },
      { ...ok, text: 'nope' }, { ...ok, rate: F25 },
    ]) expect(load(bad).startTimecode, JSON.stringify(bad)).toBeUndefined();
  });
});
