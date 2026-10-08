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
import { clip, dropFrame, media, mkProject, mkSeq, put, R23, representative, tr } from '../fixtures/interchange/fixture';

const DIR = path.resolve(__dirname, '../fixtures/interchange');
const UPDATE = process.env.UPDATE_INTERCHANGE_GOLDENS === '1';
const FORMATS: InterchangeFormat[] = ['fcpxml', 'otio', 'edl'];
const FIXTURES: Record<string, () => { project: Project; seqId: ID }> = { representative, 'ntsc-df': dropFrame };

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
    ]);
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
    expect(r.files[0].contents).toContain('001  AX       B     C        00:00:00:00 00:00:01:00 00:00:00:00 00:00:01:00\nAUD  4\n');
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
