/**
 * CMX3600 EDL writer: one file per video track (`<sequence>_V1.edl`, ...). Pure.
 *
 * - Record timecode starts at 00:00:00:00 at the sequence rate; `FCM: DROP FRAME` (and `;` before the frames) at
 *   29.97 / 59.94, `NON-DROP FRAME` otherwise (23.976 counts at a nominal 24).
 * - Reels (edlReelNames): by default each media file has its own reel name, its file name without the extension
 *   (edlReels below), so that an editor tells the files apart by reel and source timecode as a conform expects, and
 *   DaVinci Resolve's "Assist using reel names from the source clip filename" gives the media the same reel name.
 *   Option `aux`: every event on reel `AX` (auxiliary source), identified only by its comments (DaVinci Resolve 21
 *   then puts an `M2` on the wrong side of a dissolve: both sides are "AX"). Either way each event carries
 *   `* FROM CLIP NAME:` (the file name) and `* SOURCE FILE:` (the full path). Source timecode is the source position
 *   at the media's own rate, counted from the file's embedded start timecode in its own mode (drop-frame or not) when
 *   it has one (MediaProbe.startTimecode), else from 00:00:00:00 (drop-frame at 29.97 / 59.94).
 * - Dissolves are `D` events centred on the cut; fades from / to black and Dip to Black are dissolves from / to the
 *   `BL` reel (a dip is a dissolve to black over the outgoing clip's last half and one from black over the incoming
 *   clip's first half, as ReCut renders it): a zero-length cut on the outgoing side, then the `D` line, both lines
 *   with the event's channels. Constant speed is an `M2` line naming the reel of the clip it times.
 * - Audio: an audio clip linked to a video clip with the same record range, source in and speed rides on the video
 *   event as channel A (A1), A2 (`B`, `A2/V`, `AA/V`), or channel 3 / 4 (`AUD` line). Other audio is not in the EDL.
 * - Markers are `* LOC:` lines on the event under them.
 */
import type { ID } from '../model';
import { baseName, clipProps, count, isAre, markerColorName, type Issues, type PClip, type Prepared, type PTrack, type PTransition } from './common';
import type { EdlReelNames, InterchangeFile } from './index';
import { fpsEquals, fpsValue, formatTimecode, usesDropFrameDisplay, wrapTimecodeFrames } from '../time';

/** Longest reel name written: Avid's File_32 and Premiere's 32-character EDLs; CMX3600's own limit is 8. */
export const REEL_MAX = 32;
/** Reel names other tools read as black / auxiliary sources, never given to a file. */
const RESERVED = new Set(['BL', 'BLK', 'BLACK', 'AX', 'AUX']);

/** A file's name without its extension, as a reel name: letters, digits, `_` and `-` (others become `_`). */
export function reelBase(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const s = stem.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]/g, '_');
  return s || 'REEL';
}

/**
 * Reel name of each media file under the video clips of `p` (all video tracks, so every `_Vn.edl` of one export
 * agrees): the file name without its extension (reelBase), cut to REEL_MAX characters; a name already taken (ignoring
 * case) or reserved gets `_2`, `_3`... Files are taken in path order, so the names do not depend on the edit. `renamed`
 * lists the files whose reel is not exactly their file name without the extension.
 */
export function edlReels(p: Prepared): { reels: Map<ID, string>; renamed: Set<ID> } {
  const files = new Map<ID, string>();
  for (const t of p.videoTracks) for (const c of t.clips) files.set(c.media.id, c.media.path);
  const order = [...files].sort(([ia, a], [ib, b]) => (a < b ? -1 : a > b ? 1 : ia < ib ? -1 : ia > ib ? 1 : 0));
  const taken = new Set(RESERVED);
  const reels = new Map<ID, string>(), renamed = new Set<ID>();
  for (const [id, path] of order) {
    const base = reelBase(path).slice(0, REEL_MAX);
    let reel = base;
    for (let n = 2; taken.has(reel.toUpperCase()); n++) reel = `${base.slice(0, REEL_MAX - String(n).length - 1)}_${n}`;
    taken.add(reel.toUpperCase());
    reels.set(id, reel);
    const name = baseName(path), dot = name.lastIndexOf('.');
    if (reel !== (dot > 0 ? name.slice(0, dot) : name)) renamed.add(id);
  }
  return { reels, renamed };
}

export function writeEdl(p: Prepared, issues: Issues, stem: string, selected?: number[], reelMode: EdlReelNames = 'file'): InterchangeFile[] {
  const fps = p.fps;
  const df = usesDropFrameDisplay(fps);
  const rec = (f: number) => formatTimecode(f, fps, { dropIndicator: df });
  const fdSeq = fps.den / fps.num;
  /** Source frame (at the clip's media rate) shown at record frame `f`. */
  const srcAt = (c: PClip, f: number) => c.srcIn + Math.round((f - c.start) * fdSeq * c.speed * c.srcRate.num / c.srcRate.den);
  /** Source timecode of clip `c` at record frame `f`: from the file's start timecode, wrapping at 24 h. */
  const srcTc = (c: PClip, f: number) => {
    const s = Math.max(0, srcAt(c, f)), r = c.srcRate;
    if (!c.tc) return formatTimecode(s, r, { dropIndicator: usesDropFrameDisplay(r) });
    return formatTimecode(wrapTimecodeFrames(c.tc.frames + s, r, c.tc.dropFrame), r, { dropIndicator: c.tc.dropFrame });
  };
  const named = reelMode !== 'aux' ? edlReels(p) : null;
  /** Reel of a clip's file (see the header). */
  const reel = (c: PClip) => named?.reels.get(c.media.id) ?? 'AX';
  if (named?.renamed.size) {
    issues.add('edl-reel', 'other', 'info', (n) => `The reel names of ${count(n, 'file')} differ from the file names (spaces, other characters, length or a shared name).`, null, named.renamed.size);
  }

  // Linked audio that can ride on its video event: same record range, source in (within half a frame), speed, media.
  const channelsOf = new Map<ID, Set<number>>();
  const audioIn = new Map<ID, PClip[]>();
  const videoByLink = new Map<ID, PClip[]>();
  for (const t of p.videoTracks) for (const v of t.clips) if (v.clip.linkId && v.enabled) {
    const l = videoByLink.get(v.clip.linkId) ?? [];
    l.push(v); videoByLink.set(v.clip.linkId, l);
  }
  for (const t of p.audioTracks) for (const a of t.clips) {
    const item = { id: a.id, outerId: a.outerId };
    if (!a.enabled) continue;
    const v = a.clip.linkId ? videoByLink.get(a.clip.linkId)?.find((x) => x.media.id === a.media.id && x.start === a.start && x.duration === a.duration
      && Math.abs(x.speed - a.speed) < 1e-9 && Math.abs(x.sourceIn - a.sourceIn) < fdSeq / 2) : undefined;
    if (!v) { issues.add('edl-audio', 'other', 'warning', (n) => `${count(n, 'audio clip')} not linked to a video clip with the same in and out points ${isAre(n)} not in the EDL.`, item); continue; }
    if (t.index >= 4) { issues.add('edl-a5', 'audio-channels', 'warning', (n) => `${count(n, 'audio clip')} on tracks after A4 ${isAre(n)} not in the EDL (it has four audio channels).`, item); continue; }
    const s = channelsOf.get(v.id) ?? new Set<number>();
    s.add(t.index + 1); channelsOf.set(v.id, s);
    const l = audioIn.get(v.id) ?? []; l.push(a); audioIn.set(v.id, l);
  }
  for (const t of p.audioTracks) for (const tr of t.transitions) {
    issues.add('edl-audio-tr', 'transition', 'warning', (n) => `${count(n, 'audio crossfade or fade', 'audio crossfades and fades')} ${isAre(n)} not in the EDL.`, { id: tr.id, outerId: (tr.out ?? tr.in)!.outerId });
  }

  const chanCode = (c: PClip): { code: string; aud?: string } => {
    const s = channelsOf.get(c.id);
    const a1 = !!s?.has(1), a2 = !!s?.has(2);
    const code = a1 && a2 ? 'AA/V' : a1 ? 'B' : a2 ? 'A2/V' : 'V';
    const rest = [3, 4].filter((n) => s?.has(n));
    return { code, aud: rest.length ? `AUD  ${rest.join('    ')}` : undefined };
  };

  const placed = new Set<ID>();
  const indexes = selected && selected.length ? selected.filter((i) => Number.isInteger(i) && i >= 0 && i < p.videoTracks.length) : p.videoTracks.map((_, i) => i);
  let files = [...new Set(indexes)].sort((a, b) => a - b).map((i) => ({ i, t: p.videoTracks[i] }));
  // By default, leave out tracks with nothing to list (but always write at least one file).
  if (!(selected && selected.length)) {
    const busy = files.filter(({ t }) => t.clips.some((c) => c.enabled));
    files = busy.length ? busy : files.slice(0, 1);
  }
  const out = files.map(({ i, t }) => ({ name: `${stem}_V${i + 1}.edl`, contents: writeTrack(t, i) }));
  if (!out.length) out.push({ name: `${stem}_V1.edl`, contents: header(`${p.name} V1`).join('\n') + '\n' });
  const unplaced = p.markers.filter((m) => !placed.has(m.id)).length;
  if (unplaced) issues.add('edl-markers', 'markers', 'warning', (n) => `${count(n, 'marker')} not over a video clip ${isAre(n)} not in the EDL.`, null, unplaced);
  return out;

  function header(title: string): string[] {
    // eslint-disable-next-line no-control-regex
    return [`TITLE: ${title.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 70)}`, `FCM: ${df ? 'DROP FRAME' : 'NON-DROP FRAME'}`, ''];
  }

  function writeTrack(t: PTrack, ti: number): string {
    const lines = header(`${p.name} V${ti + 1}`);
    const clips = t.clips.filter((c) => {
      if (c.enabled) return true;
      issues.add('edl-disabled', 'disabled', 'warning', (n) => `${count(n, 'disabled clip')} ${isAre(n)} left out of the EDL.`, { id: c.id, outerId: c.outerId });
      return false;
    });
    const inTr = new Map<ID, PTransition>(), outTr = new Map<ID, PTransition>();
    for (const tr of t.transitions) {
      if (tr.in) inTr.set(tr.in.id, tr);
      if (tr.out) outTr.set(tr.out.id, tr);
      if (tr.kind === 'dip' && tr.frames % 2) issues.add('edl-odd-dip', 'transition', 'info', (n) => `${count(n, 'Dip to Black')} with an odd length ${isAre(n)} split one frame unevenly.`, { id: tr.id, outerId: tr.out!.outerId });
    }
    let ev = 0;
    const evn = () => String(++ev).padStart(3, '0');
    const line = (n: string, reel: string, chan: string, type: string, dur: number | null, si: string, so: string, ri: number, ro: number) =>
      `${n}  ${reel.padEnd(8)} ${chan.padEnd(5)} ${type.padEnd(4)} ${dur === null ? '   ' : String(dur).padStart(3, '0')} ${si} ${so} ${rec(ri)} ${rec(ro)}`;
    const black = (f: number) => formatTimecode(f, fps, { dropIndicator: df });

    for (const c of clips) {
      const props = clipProps(c);
      const item = { id: c.id, outerId: c.outerId };
      const ch = chanCode(c);
      const inT = inTr.get(c.id), outT = outTr.get(c.id);
      let a = c.start, b = c.end;
      if (outT?.kind === 'dissolve') b = outT.at - outT.half;
      else if (outT?.kind === 'dip') b = outT.at - Math.floor(outT.frames / 2);
      else if (outT?.kind === 'fadeOut') b = c.end - outT.frames;
      const n = evn();
      const comments: string[] = [];
      if (inT?.kind === 'dissolve' && inT.out) {
        const P = inT.out;
        a = inT.at - inT.half;
        lines.push(line(n, reel(P), chanCode(P).code, 'C', null, srcTc(P, a), srcTc(P, a), a, a));
        lines.push(line(n, reel(c), ch.code, 'D', inT.frames, srcTc(c, a), srcTc(c, b), a, b));
        comments.push(`* FROM CLIP NAME: ${baseName(P.media.path)}`, `* TO CLIP NAME: ${baseName(c.media.path)}`);
      } else if (inT && (inT.kind === 'dip' || inT.kind === 'fadeIn')) {
        const d = inT.kind === 'dip' ? inT.frames - Math.floor(inT.frames / 2) : inT.frames;
        lines.push(line(n, 'BL', ch.code, 'C', null, black(0), black(0), a, a));
        lines.push(line(n, reel(c), ch.code, 'D', d, srcTc(c, a), srcTc(c, b), a, b));
        comments.push(`* TO CLIP NAME: ${baseName(c.media.path)}`);
      } else {
        lines.push(line(n, reel(c), ch.code, 'C', null, srcTc(c, a), srcTc(c, b), a, b));
        comments.push(`* FROM CLIP NAME: ${baseName(c.media.path)}`);
      }
      if (inT && ch.code !== 'V') issues.add('edl-av-tr', 'transition', 'info', (k) => `Audio on ${count(k, 'event')} with a dissolve or fade dissolves with the picture in the EDL.`, item);
      if (c.speed !== 1 && !c.still) {
        const sp = (c.speed * fpsValue(fps)).toFixed(1).padStart(5, '0');
        lines.push(`M2   ${reel(c).padEnd(8)} ${sp}                ${srcTc(c, a).replace(/;/g, ':')}`);
        issues.add('edl-speed', 'speed', 'info', (k) => `Speed changes on ${count(k)} are M2 motion effects; check their timing after import.`, item);
      }
      if (ch.aud) lines.push(ch.aud);
      lines.push(...comments, `* SOURCE FILE: ${c.media.path}`);
      for (const m of p.markers) {
        if (m.time < a || m.time >= b) continue;
        placed.add(m.id);
        lines.push(`* LOC: ${rec(m.time).replace(/;/g, ':')} ${markerColorName(m.color).padEnd(7)} ${(m.name || 'Marker').replace(/[\r\n]+/g, ' ')}`);
      }
      if (outT && (outT.kind === 'fadeOut' || outT.kind === 'dip')) {
        const d = outT.kind === 'dip' ? Math.floor(outT.frames / 2) : outT.frames;
        const m2 = evn();
        lines.push(line(m2, reel(c), ch.code, 'C', null, srcTc(c, b), srcTc(c, b), b, b));
        lines.push(line(m2, 'BL', ch.code, 'D', d, black(0), black(d), b, b + d));
        lines.push(`* FROM CLIP NAME: ${baseName(c.media.path)}`);
      }
      // What the EDL cannot carry.
      const lost = (key: string, kind: Parameters<Issues['add']>[1], what: string) =>
        issues.add(key, kind, 'warning', (k) => `${what} of ${count(k)}: not in the EDL.`, item);
      if (props.move) lost('edl-move', 'transform', 'Position and scale');
      if (props.rotation) lost('edl-rot', 'rotation', 'Rotation');
      if (props.crop) lost('edl-crop', 'crop', 'Crop');
      if (props.opacity && !c.env.length) lost('edl-opacity', 'opacity', 'Opacity');
      if (props.keyframes) lost('edl-keys', 'keyframes', 'Keyframes');
      if (c.env.length) issues.add('edl-ramps', 'nested', 'warning', (k) => `Fades at the edges of nested clips are not in the EDL (${count(k)}).`, item);
      if (c.still) issues.add('edl-still', 'stills', 'info', (k) => `${count(k, 'still image')} ${isAre(k)} listed as ${k === 1 ? 'a clip' : 'clips'} from 00:00:00:00; check ${k === 1 ? 'it' : 'them'} after relinking.`, item);
      else if (!fpsEquals(c.srcRate, fps)) issues.add('edl-rate', 'other', 'info', (k) => `${count(k)} with another frame rate than the sequence use${k === 1 ? 's' : ''} source timecode at ${k === 1 ? 'its' : 'their'} own rate.`, item);
      for (const au of audioIn.get(c.id) ?? []) {
        const ap = clipProps(au);
        const ai = { id: au.id, outerId: au.outerId };
        if (ap.level) issues.add('edl-level', 'level', 'warning', (k) => `Audio levels and fades of ${count(k)}: not in the EDL.`, ai);
        if (ap.keyframes) issues.add('edl-keys', 'keyframes', 'warning', (k) => `Keyframes of ${count(k)}: not in the EDL.`, ai);
        if (ap.channels) issues.add('edl-chan', 'audio-channels', 'warning', (k) => `Channel selection of ${count(k)}: not in the EDL.`, ai);
        if (ap.stream) issues.add('edl-stream', 'audio-stream', 'warning', (k) => `${count(k)} play${k === 1 ? 's' : ''} an audio stream other than the file's first; the EDL cannot say which.`, ai);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}
