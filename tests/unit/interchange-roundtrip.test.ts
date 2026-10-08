/**
 * Timeline interchange export (shared/interchange): the writers' output read back by small readers written here
 * (an XML tokenizer, the OTIO JSON, a CMX3600 line parser), so every clip's record and source range is checked to the
 * frame against what ReCut intended (the prepared, flattened timeline). Also XML well-formedness, escaping of
 * awkward names and file URLs.
 */
import { describe, it, expect } from 'vitest';
import type { ID, Project } from '../../shared/model';
import { exportTimeline } from '../../shared/interchange';
import { fileUrl, Issues, prepare, type PClip, type Prepared } from '../../shared/interchange/common';
import { Q } from '../../shared/interchange/rational';
import { parseTimecode } from '../../shared/time';
import { clip, dropFrame, media, mkProject, mkSeq, put, R23, R29, representative, sourceTimecode, tr } from '../fixtures/interchange/fixture';

// ------------------------------------------------------------------------------------------------ tiny XML reader

interface XEl { name: string; attrs: Record<string, string>; kids: XEl[]; parent?: XEl }

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
    e === 'amp' ? '&' : e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'apos' ? "'" : String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
}

/** Parses a document, throwing on anything not well-formed (tags, attributes, entities, text outside the root). */
function parseXml(src: string): XEl {
  let i = 0;
  const fail = (why: string): never => { throw new Error(`not well-formed at ${i}: ${why}`); };
  const stack: XEl[] = [];
  let root: XEl | undefined;
  const NAME = /[A-Za-z_][\w.-]*/y;
  const name = () => { NAME.lastIndex = i; const m = NAME.exec(src); if (!m) fail('name'); i += m![0].length; return m![0]; };
  const ws = () => { while (/\s/.test(src[i] ?? '')) i++; };
  while (i < src.length) {
    if (src.startsWith('<?', i)) { const e = src.indexOf('?>', i); if (e < 0) fail('PI'); i = e + 2; continue; }
    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i); if (e < 0) fail('comment'); i = e + 3; continue; }
    if (src.startsWith('<!DOCTYPE', i)) { if (root) fail('late doctype'); const e = src.indexOf('>', i); i = e + 1; continue; }
    if (src.startsWith('</', i)) {
      i += 2; const n = name(); ws();
      if (src[i] !== '>') fail('end tag'); i++;
      const top = stack.pop();
      if (!top || top.name !== n) fail(`mismatched </${n}>`);
      continue;
    }
    if (src[i] === '<') {
      i++;
      const el: XEl = { name: name(), attrs: {}, kids: [] };
      const parent = stack[stack.length - 1];
      if (parent) { el.parent = parent; parent.kids.push(el); } else { if (root) fail('second root'); root = el; }
      for (;;) {
        ws();
        if (src.startsWith('/>', i)) { i += 2; break; }
        if (src[i] === '>') { i++; stack.push(el); break; }
        const a = name(); ws();
        if (src[i] !== '=') fail('='); i++; ws();
        if (src[i] !== '"') fail('quote'); i++;
        const e = src.indexOf('"', i); if (e < 0) fail('attr end');
        const raw = src.slice(i, e); i = e + 1;
        if (/[<]/.test(raw) || /&(?!(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);)/.test(raw)) fail(`bad attribute value ${raw}`);
        if (a in el.attrs) fail(`duplicate attribute ${a}`);
        el.attrs[a] = decode(raw);
      }
      continue;
    }
    const e = src.indexOf('<', i);
    const text = src.slice(i, e < 0 ? src.length : e);
    if (text.trim()) fail(`text "${text.trim().slice(0, 20)}"`);
    i = e < 0 ? src.length : e;
  }
  if (stack.length || !root) fail('unclosed');
  return root!;
}

const q = (t: string): Q => {
  const m = /^(-?\d+)(?:\/(\d+))?s$/.exec(t);
  if (!m) throw new Error(`bad time ${t}`);
  return new Q(BigInt(m[1]), BigInt(m[2] ?? '1'));
};
const walk = (e: XEl, f: (x: XEl) => void) => { f(e); e.kids.forEach((k) => walk(k, f)); };

interface Read { lane: number; start: number; duration: number; srcIn: number; fileStart: number; speed: number; enabled: boolean; url: string; name: string }

/**
 * Asset-clips of an FCPXML with their record frames (sequence rate) and source frames (media rate). An asset-clip of
 * a file with picture and sound and no srcEnable is linked video and audio: it reads as both, the audio with lane NaN
 * (FCPXML does not say which audio track it was on; see withAudioLanes).
 */
function readFcpxml(doc: XEl, p: Prepared): Read[] {
  const assets = new Map<string, XEl>(), formats = new Map<string, XEl>();
  walk(doc, (e) => { if (e.name === 'asset') assets.set(e.attrs.id, e); if (e.name === 'format') formats.set(e.attrs.id, e); });
  const fd = Q.frameDuration(p.fps);
  const out: Read[] = [];
  // abs(e) = position of e's local time origin: absolute time of local time 0 is abs - start.
  const visit = (e: XEl, toAbs: (local: Q) => Q, lane: number) => {
    for (const k of e.kids) {
      if (k.name === 'spine') { visit(k, toAbs, Number(k.attrs.lane ?? 0)); continue; }
      if (k.name !== 'asset-clip' && k.name !== 'gap') continue;
      const absStart = toAbs(q(k.attrs.offset));
      const start = q(k.attrs.start ?? '0s');
      const kLane = k.attrs.lane !== undefined ? Number(k.attrs.lane) : lane;
      if (k.name === 'asset-clip') {
        const a = assets.get(k.attrs.ref)!;
        const f = a.attrs.format ? formats.get(a.attrs.format) : undefined;
        const mfd = f?.attrs.frameDuration ? q(f.attrs.frameDuration) : fd;
        const tm = k.kids.find((x) => x.name === 'timeMap');
        let speed = 1, media = start;
        if (tm) {
          // Local time -> media time, anchored at the asset's start (T0 -> T0; 0s without a start timecode), as Final
          // Cut Pro writes it.
          const [t0, t1] = tm.kids;
          const a0 = a.attrs.start ?? '0s';
          expect([t0.attrs.time, t0.attrs.value]).toEqual([a0, a0]);
          const sp = q(t1.attrs.value).sub(q(t0.attrs.value)).div(q(t1.attrs.time).sub(q(t0.attrs.time)));
          speed = sp.toNumber();
          media = q(t0.attrs.value).add(start.sub(q(t0.attrs.time)).mul(sp));
        }
        const fr = (x: Q, d: Q) => { const v = x.div(d); expect(v.d, `${k.attrs.name}: not on a frame`).toBe(1n); return Number(v.n); };
        const r: Read = {
          lane: kLane, start: fr(absStart, fd), duration: fr(q(k.attrs.duration), fd), srcIn: fr(media, mfd), fileStart: fr(q(a.attrs.start ?? '0s'), mfd), speed,
          enabled: k.attrs.enabled !== '0', url: a.kids.find((x) => x.name === 'media-rep')!.attrs.src, name: k.attrs.name,
        };
        out.push(r);
        if (!k.attrs.srcEnable && a.attrs.hasVideo === '1' && a.attrs.hasAudio === '1' && a.attrs.duration !== '0s') out.push({ ...r, lane: NaN });
      }
      visit(k, (local) => absStart.add(local.sub(start)), kLane);
    }
  };
  const spine = (() => { let s: XEl | undefined; walk(doc, (e) => { if (!s && e.name === 'spine') s = e; }); return s!; })();
  visit(spine, (local) => local, 0);
  return out;
}

const laneOf = (c: PClip) => (c.kind === 'video' ? c.track.index : -(c.track.index + 1));

/** Gives the audio half of each linked asset-clip (lane NaN) the lane of the intended audio clip it matches. */
function withAudioLanes<T extends { lane: number }>(got: T[], want: T[]): T[] {
  const free = want.filter((w) => w.lane < 0);
  return got.map((g) => {
    if (!Number.isNaN(g.lane)) return g;
    const i = free.findIndex((w) => JSON.stringify({ ...w, lane: 0, name: '' }) === JSON.stringify({ ...g, lane: 0, name: '' }));
    expect(i, `linked audio of ${JSON.stringify(g)} matches an intended audio clip`).toBeGreaterThanOrEqual(0);
    return { ...g, lane: free.splice(i, 1)[0].lane };
  });
}
const intended = (p: Prepared) => [...p.videoTracks, ...p.audioTracks].flatMap((t) => t.clips);
/** A clip's source in point as the files write it: frames from the file's embedded start timecode, if any. */
const fileIn = (c: PClip) => c.srcIn + (c.tc?.frames ?? 0);

function prep(project: Project, seqId: ID): Prepared { return prepare(project, seqId, new Issues()); }

const CASES: [string, () => { project: Project; seqId: ID }][] = [['representative 23.976', representative], ['29.97 drop-frame', dropFrame], ['camera start timecode', sourceTimecode]];

describe('the test XML reader', () => {
  it('rejects what is not well-formed', () => {
    for (const bad of ['<a><b></a>', '<a x="&"/>', '<a x="1" x="2"/>', '<a/><b/>', '<a>text</a>', '<a x="<"/>', '<a>']) expect(() => parseXml(bad), bad).toThrow();
    expect(parseXml('<?xml version="1.0"?>\n<!DOCTYPE a>\n<a q="&amp;&#233;"><b/></a>\n')).toMatchObject({ name: 'a', attrs: { q: '&é' }, kids: [{ name: 'b' }] });
  });
});

describe('FCPXML read back', () => {
  for (const [label, make] of CASES) {
    it(`${label}: well-formed, every clip's record and source range to the frame`, () => {
      const { project, seqId } = make();
      const p = prep(project, seqId);
      const doc = parseXml(exportTimeline(project, seqId, 'fcpxml').files[0].contents);
      expect(doc.name).toBe('fcpxml');
      expect(doc.attrs.version).toBe('1.9');
      const want = intended(p).map((c) => ({
        lane: laneOf(c), start: c.start, duration: c.duration, srcIn: fileIn(c), fileStart: c.tc?.frames ?? 0, speed: c.speed, enabled: c.enabled, url: fileUrl(c.media.path), name: c.name,
      })).sort((a, b) => b.lane - a.lane || a.start - b.start);
      // Names: a linked asset-clip carries its video clip's name.
      const named = (r: Read[]) => r.map((x) => ({ ...x, name: x.lane < 0 ? '' : x.name }));
      const got = withAudioLanes(readFcpxml(doc, p), want).sort((a, b) => b.lane - a.lane || a.start - b.start);
      expect(named(got)).toEqual(named(want));
      // Spine items tile the sequence (no gaps, no overlaps).
      const spine = doc.kids[1].kids[0].kids[0].kids[0].kids[0];
      let pos = new Q(0n);
      for (const k of spine.kids.filter((x) => x.name !== 'transition')) { expect(q(k.attrs.offset).cmp(pos)).toBe(0); pos = pos.add(q(k.attrs.duration)); }
      expect(pos.cmp(Q.frames(p.durationFrames, p.fps))).toBe(0);
    });
  }

  it('transitions sit centred on their cut', () => {
    const { project, seqId } = representative();
    const doc = parseXml(exportTimeline(project, seqId, 'fcpxml').files[0].contents);
    const trs: XEl[] = [];
    walk(doc, (e) => { if (e.name === 'transition') trs.push(e); });
    const fd = Q.frameDuration(R23);
    // V1: dissolve c2 -> c3 at frame 168 (24 frames). A1's crossfade a2 -> a3 (12 frames) is on the same cut between
    // the linked clips: it rides on the video dissolve (one transition, both filters, the video length).
    expect(trs).toHaveLength(1);
    const v = trs[0];
    expect(v.kids.map((k) => k.name)).toEqual(['filter-video', 'filter-audio']);
    expect(q(v.attrs.offset).cmp(Q.frames(156, R23))).toBe(0);
    expect(q(v.attrs.duration).cmp(fd.mul(Q.int(24)))).toBe(0);
  });

  it('linked video and audio are one asset-clip unless an audio crossfade has no video dissolve under it', () => {
    const m = media('m', '/m.mp4');
    const s = mkSeq('s', 'S', R23);
    // v1|v2 cut with an audio crossfade (a1 -> a2): kept apart. v3|v4 dissolve, audio cut: merged.
    put(s.videoTracks[0], clip('v1', 'm', 0, 24, 10, { linkId: 'L1' }), clip('v2', 'm', 24, 24, 100, { linkId: 'L2' }),
      clip('v3', 'm', 48, 24, 200, { linkId: 'L3' }), clip('v4', 'm', 72, 24, 300, { linkId: 'L4' }), clip('v5', 'm', 96, 24, 400));
    s.videoTracks[0].transitions.push(tr('tv', 'crossDissolve', 8, 'v3', 'v4'));
    put(s.audioTracks[0], clip('a1', 'm', 0, 24, 10, { linkId: 'L1' }), clip('a2', 'm', 24, 24, 100, { linkId: 'L2' }),
      clip('a3', 'm', 48, 24, 200, { linkId: 'L3' }), clip('a4', 'm', 72, 24, 300, { linkId: 'L4' }));
    s.audioTracks[0].transitions.push(tr('ta', 'audioCrossfade', 8, 'a1', 'a2'));
    // A muted linked audio clip (a6) is not merged with its enabled video (v6 on V2); unlinked music stays audio-only.
    put(s.videoTracks[1], clip('v6', 'm', 0, 12, 500, { linkId: 'L6' }));
    const a6 = clip('a6', 'm', 0, 12, 500, { linkId: 'L6' });
    a6.audio = { ...a6.audio, muted: true };
    put(s.audioTracks[1], a6);
    const project = mkProject('P', [m], [s]);
    const r = exportTimeline(project, 's', 'fcpxml');
    const doc = parseXml(r.files[0].contents);
    const clips: XEl[] = [];
    walk(doc, (e) => { if (e.name === 'asset-clip') clips.push(e); });
    const by = (n: string) => clips.filter((c) => c.attrs.name === n);
    for (const n of ['v3', 'v4']) expect(by(n).map((c) => c.attrs.srcEnable)).toEqual([undefined]);
    for (const n of ['a3', 'a4']) expect(by(n)).toEqual([]);
    for (const n of ['v1', 'v2', 'v5', 'v6']) expect(by(n).map((c) => c.attrs.srcEnable), n).toEqual(['video']);
    for (const n of ['a1', 'a2', 'a6']) expect(by(n).map((c) => c.attrs.srcEnable), n).toEqual(['audio']);
    // The unused half of a one-sided clip is muted / transparent for editors that ignore srcEnable (Resolve 21).
    expect(by('v1')[0].kids.filter((k) => k.name.startsWith('adjust')).map((k) => [k.name, k.attrs.amount])).toEqual([['adjust-volume', '-96dB']]);
    expect(by('a1')[0].kids.filter((k) => k.name.startsWith('adjust')).map((k) => [k.name, k.attrs.amount])).toEqual([['adjust-blend', '0']]);
    const story = by('a1')[0].parent!;
    expect(story.name).toBe('spine');
    expect(story.kids.filter((k) => k.name === 'transition').map((t) => t.kids.map((k) => k.name))).toEqual([['filter-audio']]);
    expect(r.issues.find((i) => i.message.includes('separate clips'))).toMatchObject({ count: 6 }); // v1 v2 a1 a2 v6 a6
    // Read back: every clip in place, linked pairs as one.
    const p = prep(project, 's');
    const want = intended(p).map((c) => ({ lane: laneOf(c), start: c.start, duration: c.duration, srcIn: fileIn(c), fileStart: c.tc?.frames ?? 0, speed: c.speed, enabled: c.enabled, url: fileUrl(c.media.path), name: '' }));
    const got = withAudioLanes(readFcpxml(doc, p), want).map((g) => ({ ...g, name: '' }));
    const key = (a: { lane: number; start: number }, b: { lane: number; start: number }) => b.lane - a.lane || a.start - b.start;
    expect(got.sort(key)).toEqual(want.sort(key));
  });

  it('a retimed clip: timeMap from the asset start, start is the in point over the speed', () => {
    const m = media('m', '/m.mp4');
    const s = mkSeq('s', 'S', R23);
    put(s.videoTracks[0], clip('v', 'm', 0, 72, 240 * 1001 / 24000, { speed: 2 }));
    const x = exportTimeline(mkProject('P', [m], [s]), 's', 'fcpxml').files[0].contents;
    // In point: source frame 240 (10.01 s), local 5.005 s; end 5.005 + 3.003 = 8.008 s -> media 16.016 s.
    expect(x).toContain('start="1001/200s" duration="3003/1000s" srcEnable="video">');
    expect(x).toMatch(/<timept time="0s" value="0s" interp="linear"\/>\s+<timept time="1001\/125s" value="2002\/125s" interp="linear"\/>/);
  });
});

describe('OTIO read back', () => {
  for (const [label, make] of CASES) {
    it(`${label}: every clip's record and source range to the frame`, () => {
      const { project, seqId } = make();
      const p = prep(project, seqId);
      const tl = JSON.parse(exportTimeline(project, seqId, 'otio').files[0].contents);
      expect(tl.OTIO_SCHEMA).toBe('Timeline.1');
      const rate = p.fps.num / p.fps.den;
      const tracks = [...p.videoTracks, ...p.audioTracks];
      expect(tl.tracks.children.map((t: { kind: string }) => t.kind)).toEqual(tracks.map((t) => (t.kind === 'video' ? 'Video' : 'Audio')));
      tl.tracks.children.forEach((t: { children: Record<string, any>[] }, ti: number) => {
        let pos = 0;
        const got: unknown[] = [];
        for (const it of t.children) {
          if (it.OTIO_SCHEMA === 'Transition.1') { expect(it.transition_type).toBe('SMPTE_Dissolve'); continue; }
          const d = it.source_range.duration;
          expect(d.rate).toBe(rate);
          if (it.OTIO_SCHEMA === 'Clip.1') {
            const s = it.source_range.start_time;
            got.push({ start: pos, duration: d.value, srcIn: s.value, srcRate: s.rate, fileStart: it.media_reference.available_range?.start_time.value ?? null, speed: it.effects[0]?.time_scalar ?? 1, enabled: it.enabled, url: it.media_reference.target_url });
          }
          pos += d.value;
        }
        expect(got).toEqual(tracks[ti].clips.map((c) => ({
          start: c.start, duration: c.duration, srcIn: fileIn(c), srcRate: c.srcRate.num / c.srcRate.den, fileStart: c.still ? null : c.tc?.frames ?? 0, speed: c.speed, enabled: c.enabled, url: fileUrl(c.media.path),
        })));
      });
      expect(tl.tracks.markers.map((m: any) => m.marked_range.start_time.value)).toEqual(p.markers.map((m) => m.time));
      // Notes: OTIO's `comment`, and where DaVinci Resolve's own OTIO keeps them.
      expect(tl.tracks.markers.map((m: any) => [m.comment, m.metadata.Resolve_OTIO?.Note ?? ''])).toEqual(p.markers.map((m) => [m.note ?? '', m.note ?? '']));
    });
  }
});

// ------------------------------------------------------------------------------------------------ EDL

interface EdlLine { ev: string; reel: string; chan: string; type: string; dur?: number; si: string; so: string; ri: string; ro: string; comments: string[] }
function parseEdl(text: string): { title: string; fcm: string; lines: EdlLine[] } {
  const rows = text.split('\n');
  const title = rows[0], fcm = rows[1];
  const lines: EdlLine[] = [];
  for (const r of rows.slice(2)) {
    if (!r.trim()) continue;
    const f = r.trim().split(/\s+/);
    if (/^\d{3,}$/.test(f[0])) {
      if (f.length === 9) lines.push({ ev: f[0], reel: f[1], chan: f[2], type: f[3], dur: Number(f[4]), si: f[5], so: f[6], ri: f[7], ro: f[8], comments: [] });
      else { expect(f.length, r).toBe(8); lines.push({ ev: f[0], reel: f[1], chan: f[2], type: f[3], si: f[4], so: f[5], ri: f[6], ro: f[7], comments: [] }); }
    } else {
      expect(lines.length, `comment before any event: ${r}`).toBeGreaterThan(0);
      lines[lines.length - 1].comments.push(r);
    }
  }
  return { title, fcm, lines };
}

describe('EDL read back', () => {
  for (const [label, make] of CASES) {
    it(`${label}: each clip's events show its own source frames at their record frames`, () => {
      const { project, seqId } = make();
      const p = prep(project, seqId);
      const r = exportTimeline(project, seqId, 'edl');
      for (const file of r.files) {
        const ti = Number(/_V(\d+)\.edl$/.exec(file.name)![1]) - 1;
        const { title, fcm, lines } = parseEdl(file.contents);
        expect(title).toBe(`TITLE: ${p.name} V${ti + 1}`);
        expect(fcm).toBe(p.fps.num === 30000 ? 'FCM: DROP FRAME' : 'FCM: NON-DROP FRAME');
        const clips = p.videoTracks[ti].clips.filter((c) => c.enabled);
        // A clip's main event: its AX line that is not the zero-length "from" line of a dissolve pair.
        const main = lines.filter((l, i) => l.reel === 'AX' && !(lines[i + 1]?.ev === l.ev && lines[i + 1].type === 'D'));
        expect(main.length).toBe(clips.length);
        main.forEach((l, k) => {
          const c = clips[k];
          const ri = parseTimecode(l.ri, p.fps)!, ro = parseTimecode(l.ro, p.fps)!;
          const si = parseTimecode(l.si, c.srcRate)!, so = parseTimecode(l.so, c.srcRate)!;
          const ratio = c.speed * (c.srcRate.num / c.srcRate.den) * (p.fps.den / p.fps.num);
          expect(ri).toBeGreaterThanOrEqual(c.start - 30);
          expect(ro).toBeLessThanOrEqual(c.end);
          expect(si).toBe(fileIn(c) + Math.round((ri - c.start) * ratio));
          expect(so).toBe(fileIn(c) + Math.round((ro - c.start) * ratio));
          // Source timecode in the file's own counting mode (a non-drop camera file stays non-drop at 29.97).
          if (c.tc) expect(l.si.includes(';')).toBe(c.tc.dropFrame);
          if (!p.videoTracks[ti].transitions.some((t) => t.in === c || t.out === c)) { expect(ri).toBe(c.start); expect(ro).toBe(c.end); }
          const all = lines.filter((x) => x.ev === l.ev).flatMap((x) => x.comments);
          expect(all).toContain(`* SOURCE FILE: ${c.media.path}`);
          if (c.speed !== 1) expect(all.some((x) => x.startsWith('M2   AX'))).toBe(true);
        });
      }
    });
  }

  it('writes the dissolve, the fade from black and the dip as CMX dissolves', () => {
    const { project, seqId } = representative();
    const v1 = exportTimeline(project, seqId, 'edl').files[0].contents;
    expect(v1).toContain('001  BL       V     C        00:00:00:00 00:00:00:00 00:00:00:00 00:00:00:00\n001  AX       B     D    012 ');
    expect(v1).toMatch(/003 {2}AX {7}B {5}C {8}(\S+) \1 00:00:06:12 00:00:06:12\n003 {2}AX {7}B {5}D {4}024 /);
    expect(v1).toContain('004  BL       V     D    006 00:00:00:00 00:00:00:06 00:00:09:18 00:00:10:00');
    expect(v1).toContain('005  BL       V     C        00:00:00:00 00:00:00:00 00:00:10:00 00:00:10:00\n005  AX       B     D    006 ');
    expect(v1).toContain('* LOC: 00:00:00:10 RED     Intro & <title>');
  });

  it('only writes the requested video tracks', () => {
    const { project, seqId } = representative();
    expect(exportTimeline(project, seqId, 'edl', { edlVideoTracks: [1, 9, 1] }).files.map((f) => f.name.slice(-7))).toEqual(['_V2.edl']);
  });
});

// ------------------------------------------------------------------------------------------------ escaping, URLs

describe('names and paths', () => {
  const NAME = 'Tom & Jerry <"Cut"> \'s Épisode ✂ \u0001end';
  const PATH = '/media/Vidéos/Tom & Jerry <"Cut"> #1 100%.mkv';
  const project = (() => {
    const m = media('m', PATH);
    const s = mkSeq('s', NAME, R23);
    put(s.videoTracks[0], clip('c', 'm', 0, 24, 0, { name: NAME }));
    s.markers.push({ id: 'k', time: 0, duration: 0, name: NAME, note: 'line 1\nline 2', color: '#ffffff', kind: 'marker' });
    return mkProject(NAME, [m], [s]);
  })();

  it('FCPXML escapes & < > " and keeps non-ASCII; control characters are dropped', () => {
    const doc = parseXml(exportTimeline(project, 's', 'fcpxml').files[0].contents);
    const clean = NAME.replace('\u0001', '');
    let clipEl: XEl | undefined, markerEl: XEl | undefined, rep: XEl | undefined;
    walk(doc, (e) => { if (e.name === 'asset-clip') clipEl = e; if (e.name === 'marker') markerEl = e; if (e.name === 'media-rep') rep = e; });
    expect(clipEl!.attrs.name).toBe(clean);
    expect(markerEl!.attrs.value).toBe(clean);
    expect(markerEl!.attrs.note).toBe('line 1\nline 2');
    expect(rep!.attrs.src).toBe('file:///media/Vid%C3%A9os/Tom%20%26%20Jerry%20%3C%22Cut%22%3E%20%231%20100%25.mkv');
    expect(decodeURIComponent(rep!.attrs.src.slice('file://'.length))).toBe(PATH);
  });

  it('OTIO and EDL keep the names and the plain path', () => {
    const tl = JSON.parse(exportTimeline(project, 's', 'otio').files[0].contents);
    expect(tl.name).toBe(NAME);
    expect(tl.tracks.children[0].children[0].name).toBe(NAME);
    expect(decodeURIComponent(tl.tracks.children[0].children[0].media_reference.target_url.slice(7))).toBe(PATH);
    const edl = exportTimeline(project, 's', 'edl');
    expect(edl.files[0].name).toBe('Tom & Jerry _\'Cut\'_ \'s Épisode ✂ _end_V1.edl'.replace(/'Cut'/, '_Cut_'));
    expect(edl.files[0].contents).toContain(`* SOURCE FILE: ${PATH}\n`);
    expect(edl.files[0].contents.split('\n')[0]).toBe(`TITLE: ${NAME.replace('\u0001', ' ')} V1`);
  });

  it('file URLs: POSIX, Windows drive and UNC paths', () => {
    expect(fileUrl('/a b/c#d.mp4')).toBe('file:///a%20b/c%23d.mp4');
    expect(fileUrl('C:\\Users\\Me\\Vidéo 1.mkv')).toBe('file:///C:/Users/Me/Vid%C3%A9o%201.mkv');
    expect(fileUrl('d:/clips/x.mov')).toBe('file:///D:/clips/x.mov');
    expect(fileUrl('\\\\server\\share\\f.mp4')).toBe('file://server/share/f.mp4');
  });
});

describe('mixed rates and speed', () => {
  it('a 29.97 clip in a 23.976 sequence keeps its own source frames; a 50% clip maps 2:1', () => {
    const m = media('m', '/m.mp4', {}, { fps: R29 });
    const s = mkSeq('s', 'S', R23);
    put(s.videoTracks[0], clip('a', 'm', 0, 48, 10), clip('b', 'm', 48, 48, 20, { speed: 0.5 }));
    s.videoTracks[0].transitions.push(tr('t', 'crossDissolve', 8, 'a', 'b'));
    const project = mkProject('P', [m], [s]);
    const p = prep(project, 's');
    const got = readFcpxml(parseXml(exportTimeline(project, 's', 'fcpxml').files[0].contents), p);
    expect(got.map((g) => [g.start, g.duration, g.srcIn, g.speed])).toEqual([[0, 48, Math.round(10 * 30000 / 1001), 1], [48, 48, Math.round(20 * 30000 / 1001), 0.5]]);
    const otio = JSON.parse(exportTimeline(project, 's', 'otio').files[0].contents);
    const b = otio.tracks.children[0].children[2];
    expect(otio.tracks.children[0].children[1]).toMatchObject({ OTIO_SCHEMA: 'Transition.1', in_offset: { value: 4 }, out_offset: { value: 4 } });
    expect(b.effects[0]).toMatchObject({ OTIO_SCHEMA: 'LinearTimeWarp.1', time_scalar: 0.5 });
    expect(b.source_range.start_time).toEqual({ OTIO_SCHEMA: 'RationalTime.1', rate: 30000 / 1001, value: 599 });
  });
});
