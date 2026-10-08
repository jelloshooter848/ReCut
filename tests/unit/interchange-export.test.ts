/**
 * Timeline interchange export (Roadmap §10, shared/interchange): goldens of the representative fixtures per format,
 * the expected-values sidecars scripts/interchange-check.py checks with OpenTimelineIO, the summary, and the issues
 * each lossy case reports.
 *
 * Goldens live in tests/fixtures/interchange/. A missing golden is written; to accept changed output on purpose run
 * `UPDATE_INTERCHANGE_GOLDENS=1 npx vitest run tests/unit/interchange-export.test.ts` and review the diff.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ID, Project } from '../../shared/model';
import { exportTimeline, INTERCHANGE_FORMATS, type InterchangeFormat, type InterchangeResult } from '../../shared/interchange';
import { fileUrl, Issues, prepare, safeFileStem } from '../../shared/interchange/common';
import { edlReels, REEL_MAX, reelBase } from '../../shared/interchange/edl';
import { clip, dropFrame, media, mkProject, mkSeq, put, R23, representative, sourceTimecode, tr } from '../fixtures/interchange/fixture';

const DIR = path.resolve(__dirname, '../fixtures/interchange');
const UPDATE = process.env.UPDATE_INTERCHANGE_GOLDENS === '1';
const FORMATS: InterchangeFormat[] = ['fcpxml', 'otio', 'edl'];
const FIXTURES: Record<string, () => { project: Project; seqId: ID }> = { representative, 'ntsc-df': dropFrame, 'source-tc': sourceTimecode };

function golden(name: string, contents: string): void {
  const file = path.join(DIR, name);
  if (UPDATE || !fs.existsSync(file)) fs.writeFileSync(file, contents);
  expect(contents, `golden ${name} (UPDATE_INTERCHANGE_GOLDENS=1 to accept)`).toBe(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
}

/** Golden file name: the sequence-name stem replaced by the fixture key. */
function goldenName(key: string, stem: string, fileName: string): string {
  return key + fileName.slice(stem.length);
}

/** What ReCut intends, from the prepared (flattened) timeline: independent of the writers. */
function expected(key: string, project: Project, seqId: ID, files: Record<InterchangeFormat, string[]>) {
  const p = prepare(project, seqId, new Issues());
  const lane = (kind: string, i: number) => (kind === 'video' ? i : -(i + 1));
  const clipOf = (c: ReturnType<typeof prepare>['videoTracks'][number]['clips'][number]) => ({
    name: c.name, start: c.start, duration: c.duration, srcIn: c.srcIn, srcRate: [c.srcRate.num, c.srcRate.den], speed: c.speed,
    path: c.media.path, url: fileUrl(c.media.path), enabled: c.enabled, still: c.still,
    // The file's embedded start timecode (frames at srcRate): source times in the exports are tcStart + srcIn.
    ...(c.tc ? { tcStart: c.tc.frames } : {}),
  });
  return {
    fixture: key, name: p.name, fps: [p.fps.num, p.fps.den], durationFrames: p.durationFrames, files,
    tracks: [...p.videoTracks, ...p.audioTracks].map((t) => ({
      kind: t.kind, index: t.index, lane: lane(t.kind, t.index), name: t.name,
      storyline: t.kind === 'audio' || t.index > 0 ? t.transitions.some((x) => x.kind === 'dissolve') : false,
      dissolves: t.transitions.filter((x) => x.kind === 'dissolve').length,
      clips: t.clips.map(clipOf),
    })),
    markers: p.markers.length,
  };
}

describe('interchange goldens', () => {
  for (const [key, make] of Object.entries(FIXTURES)) {
    it(`${key}: every format matches its golden, and the sidecar lists what ReCut intended`, () => {
      const { project, seqId } = make();
      const stem = safeFileStem(project.sequences[seqId].name);
      const names = {} as Record<InterchangeFormat, string[]>;
      for (const f of FORMATS) {
        const r = exportTimeline(project, seqId, f);
        expect(r.files.length).toBeGreaterThan(0);
        names[f] = [];
        for (const file of r.files) {
          expect(file.name.startsWith(stem)).toBe(true);
          expect(file.name.endsWith(`.${INTERCHANGE_FORMATS[f].extension}`)).toBe(true);
          const g = goldenName(key, stem, file.name);
          names[f].push(g);
          golden(g, file.contents);
        }
      }
      golden(`${key}.expected.json`, `${JSON.stringify(expected(key, project, seqId, names), null, 2)}\n`);
    });
  }

  it('is deterministic (same project, same bytes)', () => {
    for (const f of FORMATS) {
      const a = representative(), b = representative();
      expect(exportTimeline(a.project, a.seqId, f)).toEqual(exportTimeline(b.project, b.seqId, f));
    }
  });
});

describe('summary', () => {
  it('counts the flattened sequence: every clip (linked A/V as 2, disabled too), tracks, length, media', () => {
    const { project, seqId } = representative();
    const r = exportTimeline(project, seqId, 'otio');
    // V1 5 (one disabled) + V2 card + nested inner video + V3 offline = 8 video; A1 4 + music + nested inner audio = 6 audio.
    expect(r.summary).toEqual({ clips: 14, videoTracks: 4, audioTracks: 4, durationFrames: 324, media: 5 });
    for (const f of FORMATS) expect(exportTimeline(project, seqId, f).summary).toEqual(r.summary);
  });

  it('throws for an unknown sequence and writes a valid empty timeline for an empty one', () => {
    const s = mkSeq('empty', 'Empty', R23);
    const project = mkProject('P', [], [s]);
    expect(() => exportTimeline(project, 'nope', 'fcpxml')).toThrow(/unknown sequence/);
    for (const f of FORMATS) {
      const r = exportTimeline(project, 'empty', f);
      expect(r.summary).toEqual({ clips: 0, videoTracks: 3, audioTracks: 3, durationFrames: 0, media: 0 });
      expect(r.files.length).toBe(1);
      expect(r.issues).toEqual([]);
    }
    expect(exportTimeline(project, 'empty', 'edl').files[0].contents).toBe('TITLE: Empty V1\nFCM: NON-DROP FRAME\n\n');
    expect(JSON.parse(exportTimeline(project, 'empty', 'otio').files[0].contents).tracks.children).toHaveLength(6);
  });
});

// ------------------------------------------------------------------------------------------------ issues

function issue(r: InterchangeResult, kind: string, severity?: 'info' | 'warning') {
  return r.issues.filter((i) => i.kind === kind && (!severity || i.severity === severity));
}
function total(r: InterchangeResult, kind: string, severity?: 'info' | 'warning'): number {
  return issue(r, kind, severity).reduce((s, i) => s + i.count, 0);
}

describe('issues of the representative sequence', () => {
  const { project, seqId } = representative();
  const fcp = exportTimeline(project, seqId, 'fcpxml');
  const otio = exportTimeline(project, seqId, 'otio');
  const edl = exportTimeline(project, seqId, 'edl');

  it('every format: nested clips flattened (info), offline media (warning)', () => {
    for (const r of [fcp, otio, edl]) {
      expect(issue(r, 'nested', 'info')).toEqual([expect.objectContaining({ count: 2, message: '2 nested clips were flattened into their source clips.' })]);
      expect(issue(r, 'offline', 'warning')).toEqual([expect.objectContaining({ count: 1, clipIds: ['gone'] })]);
      for (const i of r.issues) {
        expect(i.count).toBeGreaterThan(0);
        expect(i.message).toMatch(/^[A-Z0-9].*\.$/);
        expect(i.message.length).toBeLessThan(140);
      }
    }
  });

  it('FCPXML: the dip and the fade become opacity fades (info), marker colours are lost (info), nothing else', () => {
    expect(issue(fcp, 'transition')).toEqual([
      expect.objectContaining({ severity: 'info', count: 1, message: '1 fade from or to black is exported as an opacity fade.' }),
      expect.objectContaining({ severity: 'info', count: 1, message: '1 Dip to Black transition is exported as opacity fades on the two clips.' }),
      expect.objectContaining({ severity: 'info', count: 1, message: '1 audio crossfade of linked clips takes the length of the video dissolve on the same cut.' }),
    ]);
    // Linked pairs are one asset-clip; the disabled clip and the offline one use only the picture of a file with sound.
    expect(issue(fcp, 'other').map((i) => [i.severity, i.count, [...i.clipIds!].sort()])).toEqual([['info', 2, ['c5', 'gone']]]);
    expect(total(fcp, 'markers', 'info')).toBe(3);
    expect(fcp.issues.filter((i) => i.severity === 'warning').map((i) => i.kind)).toEqual(['offline']);
  });

  it('OTIO: properties kept only as metadata are warnings, the dip is a cut', () => {
    for (const k of ['transform', 'rotation', 'crop', 'opacity', 'level']) expect(total(otio, k, 'warning'), k).toBe(1);
    expect(issue(otio, 'transition', 'warning')).toEqual([expect.objectContaining({ count: 1, message: 'OTIO has no Dip to Black: 1 dip is exported as a cut.' })]);
    expect(total(otio, 'markers', 'info')).toBe(1); // the chapter marker
  });

  it('EDL: disabled clip, unlinked music, audio crossfade and transform are dropped; speed and still noted', () => {
    expect(issue(edl, 'disabled', 'warning')).toEqual([expect.objectContaining({ count: 1, clipIds: ['c5'] })]);
    expect(issue(edl, 'other', 'warning')).toEqual([expect.objectContaining({ count: 1, clipIds: ['music'] })]);
    expect(total(edl, 'transition', 'warning')).toBe(1);
    for (const k of ['transform', 'rotation', 'crop', 'opacity']) expect(total(edl, k, 'warning'), k).toBe(1);
    expect(total(edl, 'speed', 'info')).toBe(1);
    expect(total(edl, 'stills', 'info')).toBe(1);
    // Movie One, Épisode #2 & "Pilot" and title card get reel names other than their file names; gone does not.
    expect(issue(edl, 'other', 'info')).toEqual([expect.objectContaining({ count: 3, message: 'The reel names of 3 files differ from the file names (spaces, other characters, length or a shared name).' })]);
    expect(edl.files.map((f) => f.name.slice(-7))).toEqual(['_V1.edl', '_V2.edl', '_V3.edl', '_V4.edl']);
  });
});

describe('issues of single lossy cases', () => {
  const base = (edit: (s: ReturnType<typeof mkSeq>) => void, extraMedia = [] as ReturnType<typeof media>[]) => {
    const m = media('m', '/m.mp4', {}, { audio: [2, 6] });
    const s = mkSeq('s', 'S', R23);
    edit(s);
    return mkProject('P', [m, ...extraMedia], [s]);
  };

  it('keyframes: exact linear keys pass in FCPXML, eased keys are approximated (info), OTIO / EDL warn', () => {
    const p = base((s) => {
      const lin = clip('lin', 'm', 0, 48, 0);
      lin.transform.keyframes = { x: [{ frame: 0, value: 0 }, { frame: 47, value: 100 }] };
      const ease = clip('ease', 'm', 48, 48, 10);
      ease.transform.keyframes = { opacity: [{ frame: 0, value: 0, interp: 'ease' }, { frame: 24, value: 1 }] };
      put(s.videoTracks[0], lin, ease);
    });
    const f = exportTimeline(p, 's', 'fcpxml');
    expect(issue(f, 'keyframes')).toEqual([expect.objectContaining({ severity: 'info', count: 1, clipIds: ['ease'] })]);
    expect(f.files[0].contents).toContain('<keyframe time="0s" value="0 0" interp="linear" curve="linear"/>');
    expect(f.files[0].contents).toContain('<keyframe time="47047/24000s" value="9.259259 0" interp="linear" curve="linear"/>'); // 100 px / 1080 * 100
    expect(f.files[0].contents).toContain('interp="ease"');
    expect(total(exportTimeline(p, 's', 'otio'), 'keyframes', 'warning')).toBe(2);
    expect(total(exportTimeline(p, 's', 'edl'), 'keyframes', 'warning')).toBe(2);
  });

  it('audio: channel selection, a second stream and level keyframes', () => {
    const p = base((s) => {
      const a = clip('ch', 'm', 0, 24, 0, { audioStream: 2 });
      a.audio = { ...a.audio, channelSelection: { mode: 'channel', channel: 'FC' } };
      const b = clip('lv', 'm', 24, 24, 0);
      b.audio = { ...b.audio, keyframes: { volume: [{ frame: 0, value: 0 }, { frame: 23, value: 1 }] } };
      put(s.audioTracks[0], a, b);
    });
    const f = exportTimeline(p, 's', 'fcpxml');
    expect(issue(f, 'audio-channels', 'warning')).toEqual([expect.objectContaining({ count: 1, clipIds: ['ch'] })]);
    expect(issue(f, 'audio-stream', 'warning')).toEqual([expect.objectContaining({ count: 1, clipIds: ['ch'] })]);
    expect(issue(f, 'level', 'info')).toEqual([expect.objectContaining({ count: 1, clipIds: ['lv'] })]);
    const o = exportTimeline(p, 's', 'otio');
    expect(total(o, 'audio-channels', 'warning') + total(o, 'audio-stream', 'warning')).toBe(2);
    const clipJson = JSON.parse(o.files[0].contents).tracks.children[3].children[0];
    expect(clipJson.metadata.recut.audio).toMatchObject({ channelSelection: { mode: 'channel', channel: 'FC' }, audioStream: 2 });
  });

  it('EDL: audio past A4 and audio not lined up with its video are left out', () => {
    const p = base((s) => {
      put(s.videoTracks[0], clip('v', 'm', 0, 24, 0, { linkId: 'L' }));
      while (s.audioTracks.length < 5) s.audioTracks.push({ ...s.audioTracks[0], id: `s-A${s.audioTracks.length + 1}`, name: `A${s.audioTracks.length + 1}`, clips: [], transitions: [] });
      put(s.audioTracks[0], clip('a1', 'm', 0, 24, 0, { linkId: 'L' }));
      put(s.audioTracks[1], clip('a2', 'm', 2, 22, 0, { linkId: 'L' }));
      put(s.audioTracks[3], clip('a4', 'm', 0, 24, 0, { linkId: 'L' }));
      put(s.audioTracks[4], clip('a5', 'm', 0, 24, 0, { linkId: 'L' }));
    });
    const r = exportTimeline(p, 's', 'edl');
    expect(issue(r, 'audio-channels', 'warning')).toEqual([expect.objectContaining({ count: 1, clipIds: ['a5'] })]);
    expect(issue(r, 'other', 'warning')).toEqual([expect.objectContaining({ count: 1, clipIds: ['a2'] })]);
    expect(r.files[0].contents).toContain('001  m        B     C        00:00:00:00 00:00:01:00 00:00:00:00 00:00:01:00\nAUD  4\n');
  });

  it('muted tracks and disabled clips are exported disabled (FCPXML / OTIO) and left out of the EDL', () => {
    const p = base((s) => {
      s.videoTracks[1].muted = true;
      put(s.videoTracks[0], clip('off', 'm', 0, 24, 0, { enabled: false }));
      put(s.videoTracks[1], clip('hidden', 'm', 0, 24, 0));
    });
    const f = exportTimeline(p, 's', 'fcpxml');
    expect(f.files[0].contents.match(/enabled="0"/g)).toHaveLength(2);
    expect(issue(f, 'disabled', 'info')).toEqual([expect.objectContaining({ count: 1, clipIds: ['hidden'] })]);
    const o = JSON.parse(exportTimeline(p, 's', 'otio').files[0].contents);
    expect(o.tracks.children[1].enabled).toBe(false);
    expect(o.tracks.children[0].children[0].enabled).toBe(false);
    expect(total(exportTimeline(p, 's', 'edl', { edlVideoTracks: [0, 1] }), 'disabled', 'warning')).toBe(2);
  });

  it('dissolves without source handles are cuts, as ReCut renders them', () => {
    const p = base((s) => {
      put(s.videoTracks[0], clip('x', 'm', 0, 24, 3600 - 24 * 1001 / 24000), clip('y', 'm', 24, 24, 0));
      s.videoTracks[0].transitions.push(tr('t', 'crossDissolve', 12, 'x', 'y'));
    });
    for (const f of FORMATS) {
      const r = exportTimeline(p, 's', f);
      expect(issue(r, 'transition', 'warning')).toEqual([expect.objectContaining({ count: 1 })]);
      expect(r.files[0].contents).not.toMatch(/Cross Dissolve|SMPTE_Dissolve| D {4}\d{3} /);
    }
  });

  it('subtitles are never exported (warning)', () => {
    const p = base((s) => {
      s.subtitleTracks.push({ id: 'st', name: 'English', language: 'en', enabled: true, cues: [{ id: 'q', start: 0, duration: 24, offset: 0, text: 'Hi' }] });
    });
    for (const f of FORMATS) expect(issue(exportTimeline(p, 's', f), 'subtitles', 'warning')).toEqual([expect.objectContaining({ count: 1 })]);
  });
});

describe('embedded source start timecode', () => {
  const R25 = { num: 25, den: 1 };
  /** A 25 fps camera file whose timecode starts at `tc`, cut into a sequence at `fps`. */
  const cam = (tc: string, fps = R25, speed = 1) => {
    const m = media('m', '/cam/C0001.MXF', {}, { fps: R25, dur: 60, tc });
    const s = mkSeq('s', 'S', fps);
    put(s.videoTracks[0], clip('c', 'm', 0, 50, 4, { speed }));
    return mkProject('P', [m], [s]);
  };

  it('FCPXML: the asset starts at the file timecode and clip starts are media time from there', () => {
    const x = exportTimeline(cam('10:00:00:00'), 's', 'fcpxml').files[0].contents;
    expect(x).toMatch(/<asset id="r\d+" name="C0001.MXF" start="36000s" duration="60s"/);
    expect(x).toMatch(/<asset-clip ref="r\d+" offset="0s" name="c" start="36004s" duration="2s" srcEnable="video" tcFormat="NDF">/);
  });

  it('FCPXML: a retimed clip maps local time to media time from the file timecode (T0 -> T0)', () => {
    const x = exportTimeline(cam('10:00:00:00', R25, 2), 's', 'fcpxml').files[0].contents;
    // In point 36004 s: local start 36000 + 4 / 2 = 36002 s; end 36004 s -> media 36000 + 4 * 2 = 36008 s.
    expect(x).toMatch(/<asset-clip ref="r\d+" offset="0s" name="c" start="36002s" duration="2s" srcEnable="video" tcFormat="NDF">/);
    expect(x).toMatch(/<timept time="36000s" value="36000s" interp="linear"\/>\s+<timept time="36004s" value="36008s" interp="linear"\/>/);
  });

  it('OTIO: available_range starts at the file timecode, source_range on the same base', () => {
    const o = JSON.parse(exportTimeline(cam('10:00:00:00'), 's', 'otio').files[0].contents);
    const c = o.tracks.children[0].children[0];
    expect(c.media_reference.available_range.start_time).toEqual({ OTIO_SCHEMA: 'RationalTime.1', rate: 25, value: 900000 });
    expect(c.media_reference.available_range.duration.value).toBe(1500);
    expect(c.source_range.start_time).toEqual({ OTIO_SCHEMA: 'RationalTime.1', rate: 25, value: 900100 });
  });

  it('EDL: source timecode from the file timecode, wrapping at 24 hours', () => {
    expect(exportTimeline(cam('10:00:00:00'), 's', 'edl').files[0].contents).toContain('001  C0001    V     C        10:00:04:00 10:00:06:00 00:00:00:00 00:00:02:00');
    expect(exportTimeline(cam('23:59:58:00'), 's', 'edl').files[0].contents).toContain('001  C0001    V     C        00:00:02:00 00:00:04:00 00:00:00:00 00:00:02:00');
  });

  it('a file at another rate than the sequence keeps its own timecode base', () => {
    const p = cam('01:00:00:00', R23);
    const o = JSON.parse(exportTimeline(p, 's', 'otio').files[0].contents);
    expect(o.tracks.children[0].children[0].source_range.start_time).toEqual({ OTIO_SCHEMA: 'RationalTime.1', rate: 25, value: 90100 });
    expect(exportTimeline(p, 's', 'edl').files[0].contents).toMatch(/^001 {2}C0001 {4}V {5}C {8}01:00:04:00 01:00:06:02 /m);
  });
});

describe('EDL reel names', () => {
  /** A sequence with one 1-second clip per path on V1, in the given order. */
  const seq = (paths: string[]) => {
    const M = paths.map((path, i) => media(`m${i}`, path));
    const s = mkSeq('s', 'S', R23);
    put(s.videoTracks[0], ...paths.map((_, i) => clip(`c${i}`, `m${i}`, i * 24, 24, 0)));
    return mkProject('P', M, [s]);
  };
  const reelsOf = (paths: string[]) => {
    const { reels } = edlReels(prepare(seq(paths), 's', new Issues()));
    return paths.map((_, i) => reels.get(`m${i}`));
  };

  it('a reel is the file name without its extension, sanitised to one word', () => {
    expect(reelBase('/media/A_Red.mp4')).toBe('A_Red');
    expect(reelBase('C:\\Clips\\B-roll 2.MOV')).toBe('B-roll_2');
    expect(reelBase('/x/Épisode #2 & "Pilot".mkv')).toBe('Episode__2____Pilot_');
    expect(reelBase('/x/clip.v2.mp4')).toBe('clip_v2');
    expect(reelBase('/x/.hidden')).toBe('_hidden');
    expect(reelBase('/x/名前.mp4')).toBe('__');
    expect(reelBase('/x/.mp4')).toBe('_mp4');
  });

  it('every file gets its own reel, in path order, whatever the edit order; reserved names are avoided', () => {
    const paths = ['/b/clip.mp4', '/a/clip.mov', '/a/CLIP.mkv', '/x/BL.mp4', '/x/ax.mov', '/x/E_NTSC_2997.mp4'];
    // Path order (code units): /a/CLIP.mkv, /a/clip.mov, /b/clip.mp4, /x/BL.mp4, /x/E_NTSC_2997.mp4, /x/ax.mov.
    const want = ['clip_3', 'clip_2', 'CLIP', 'BL_2', 'ax_2', 'E_NTSC_2997'];
    expect(reelsOf(paths)).toEqual(want);
    expect(reelsOf([...paths].reverse())).toEqual([...want].reverse());
    const long = `/x/${'L'.repeat(40)}.mp4`;
    const [a, b] = reelsOf([long, `${long.slice(0, -4)}x.mp4`]);
    expect(a).toBe('L'.repeat(REEL_MAX));
    expect(b).toBe(`${'L'.repeat(REEL_MAX - 2)}_2`);
  });

  it('writes the reels on every event line and M2, AX with the aux option; reports renamed files', () => {
    const p = seq(['/m/A_Red.mp4', '/m/b blue.mp4']);
    Object.assign(p.sequences.s.videoTracks[0].clips[1], { speed: 2, sourceIn: 10 });
    p.sequences.s.videoTracks[0].transitions.push(tr('t', 'crossDissolve', 12, 'c0', 'c1'));
    const r = exportTimeline(p, 's', 'edl');
    const x = r.files[0].contents;
    expect(x).toMatch(/^001 {2}A_Red {4}V {5}C {8}00:00:00:00 /m);
    expect(x).toMatch(/^002 {2}A_Red {4}V {5}C {8}(\S+) \1 00:00:00:18 00:00:00:18\n002 {2}b_blue {3}V {5}D {4}012 .*\nM2 {3}b_blue {3}048\.0 /m);
    expect(issue(r, 'other', 'info')).toEqual([expect.objectContaining({ count: 1 })]);
    const ax = exportTimeline(p, 's', 'edl', { edlReelNames: 'aux' });
    expect(ax.files[0].contents).not.toMatch(/A_Red {3}|b_blue/);
    expect(ax.files[0].contents).toMatch(/^002 {2}AX {7}V {5}D {4}012 .*\nM2 {3}AX {7}048\.0 /m);
    expect(issue(ax, 'other', 'info')).toEqual([]);
    // Comments are unchanged.
    expect(x).toContain('* FROM CLIP NAME: A_Red.mp4\n* TO CLIP NAME: b blue.mp4\n* SOURCE FILE: /m/b blue.mp4');
  });
});

describe('FCPXML audio crossfades of linked clips', () => {
  /** v1|v2 dissolve (24 frames) over a1|a2 crossfade (12 frames), linked pairs; v2 at 200%. */
  const proj = () => {
    const m = media('m', '/m.mp4');
    const s = mkSeq('s', 'S', R23);
    put(s.videoTracks[0], clip('v1', 'm', 0, 48, 10, { linkId: 'L1' }), clip('v2', 'm', 48, 48, 100, { linkId: 'L2', speed: 2 }));
    s.videoTracks[0].transitions.push(tr('tv', 'crossDissolve', 24, 'v1', 'v2'));
    put(s.audioTracks[0], clip('a1', 'm', 0, 48, 10, { linkId: 'L1' }), clip('a2', 'm', 48, 48, 100, { linkId: 'L2', speed: 2 }));
    s.audioTracks[0].transitions.push(tr('ta', 'audioCrossfade', 12, 'a1', 'a2'));
    return mkProject('P', [m], [s]);
  };

  it('default: Final Cut Pro\'s form, the Audio Crossfade in the video dissolve', () => {
    const r = exportTimeline(proj(), 's', 'fcpxml');
    expect(r.files[0].contents).toMatch(/<transition name="Cross Dissolve" offset="[^"]+" duration="1001\/1000s">\s+<filter-video [^>]+\/>\s+<filter-audio ref="r\d+" name="Audio Crossfade"\/>/);
    expect(r.files[0].contents).not.toMatch(/audioStart|audioDuration|fadeIn|fadeOut/);
  });

  it('split: overlapping audio (split edits) with linear fades over the crossfade, the transition picture only', () => {
    const r = exportTimeline(proj(), 's', 'fcpxml', { fcpxmlAudioCrossfades: 'split' });
    const x = r.files[0].contents;
    expect(x).not.toContain('filter-audio');
    expect(x).toMatch(/<transition name="Cross Dissolve" offset="[^"]+" duration="1001\/1000s">\s+<filter-video [^>]+\/>\s+<\/transition>/);
    // v1: in point 10 s, 48 frames; its audio runs 6 frames past its end and fades out over the 12-frame crossfade.
    expect(x).toMatch(/<asset-clip ref="r\d+" offset="0s" name="v1" start="1001\/100s" duration="1001\/500s" audioDuration="9009\/4000s">\s+<adjust-volume amount="0dB">\s+<param name="amount">\s+<fadeOut type="linear" duration="1001\/2000s"\/>/);
    // v2 (200%): its audio starts 6 frames (local time runs at the timeline's pace) before its in point and fades in.
    const v2 = /name="v2" start="([^"]+)" duration="1001\/500s" audioStart="([^"]+)" audioDuration="9009\/4000s">/.exec(x)!;
    const sec = (t: string) => { const [n, d] = t.replace(/s$/, '').split('/').map(Number); return n / (d || 1); };
    expect(sec(v2[1]) - sec(v2[2])).toBeCloseTo(6 * 1001 / 24000, 9);
    expect(x).toMatch(/<fadeIn type="linear" duration="1001\/2000s"\/>/);
    expect(issue(r, 'transition', 'info')).toEqual([expect.objectContaining({ count: 1, message: '1 audio crossfade of linked clips is written as overlapping audio with fades.' })]);
  });
});
