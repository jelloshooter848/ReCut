/**
 * Pure helpers for the tester kit (scripts/tester-kit.mjs): subtitle normalising and windowing, the deliberately messy
 * SRT in trouble/, shot picking for the trailer project, and the MANIFEST / size formatting. No Node, no DOM: bundled
 * by esbuild into the kit script and unit-tested in tests/unit/tester-kit.test.ts.
 */
import { parseSubtitles, serializeSrt } from '../../shared/subtitles';

export interface Cue { start: number; end: number; text: string }

// ------------------------------------------------------------------ subtitles

/**
 * Subtitle file bytes -> clean text: UTF-8 when the bytes are valid UTF-8, else Windows-1252; every byte-order mark
 * removed (some official files have one after a leading blank line), LF line ends, leading blank lines dropped, and a
 * cue text glued to its timing line ("00:01:50,500Dit wapen...") moved to its own line.
 */
export function normalizeSubtitleBytes(bytes: Uint8Array): string {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = new TextDecoder('windows-1252').decode(bytes); }
  text = text.replace(/﻿/g, '').replace(/\r\n?/g, '\n').replace(/^\s*\n/, '');
  text = text.replace(/^(\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}(?!\d)[ \t]*-->[ \t]*\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}(?!\d))[ \t]*(\S.*)$/gm, '$1\n$2');
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** Cues of an SRT text with ReCut's own parser (shared/subtitles.ts), sorted by start; parser warnings returned too. */
export function readCues(text: string): { cues: Cue[]; warnings: string[] } {
  const r = parseSubtitles(text);
  return { cues: r.cues.map((c) => ({ start: c.start, end: c.end, text: c.text })), warnings: r.warnings };
}

/** SRT text for `cues` (ReCut's own writer), with CRLF line ends so Notepad on old Windows shows it properly. */
export function writeSrt(cues: Cue[], crlf = true): string {
  const s = serializeSrt(cues);
  return crlf ? s.replace(/\n/g, '\r\n') : s;
}

/** The cues fully inside [start, start + len), moved to start at 0. */
export function windowCues(cues: Cue[], start: number, len: number, margin = 0.25): Cue[] {
  return cues.filter((c) => c.start >= start + margin && c.end <= start + len - margin)
    .map((c) => ({ ...c, start: round3(c.start - start), end: round3(c.end - start) }));
}

/**
 * The `len`-second window (start on a `step` grid, within [from, to]) holding the most subtitle text. Ties keep the
 * earliest window, so the choice is deterministic.
 */
export function bestWindow(cues: Cue[], total: number, len: number, opts: { step?: number; from?: number; to?: number } = {}): number {
  const step = opts.step ?? 5;
  const from = Math.max(0, opts.from ?? 0);
  const to = Math.min(total, opts.to ?? total);
  if (to - from <= len) return Math.max(0, Math.min(from, total - len));
  let best = from, bestScore = -1;
  for (let s = from; s + len <= to + 1e-9; s += step) {
    const score = windowCues(cues, s, len, 1).reduce((n, c) => n + c.text.length, 0);
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return best;
}

/** Intervals of [from, to] with no cue (padded by `pad` seconds), at least `minLen` long. */
export function quietSpans(cues: Cue[], from: number, to: number, minLen: number, pad = 0.5): [number, number][] {
  const out: [number, number][] = [];
  let t = from;
  for (const c of [...cues].sort((a, b) => a.start - b.start)) {
    const s = c.start - pad;
    if (s - t >= minLen) out.push([t, Math.min(s, to)]);
    t = Math.max(t, c.end + pad);
    if (t >= to) break;
  }
  if (to - t >= minLen) out.push([t, to]);
  return out.filter(([a, b]) => b - a >= minLen);
}

// ------------------------------------------------------------------ trouble/Messy subtitles.srt

/**
 * The deliberately awkward SRT for trouble/: a byte-order mark, CRLF line ends, blocks out of order (by number and by
 * time), overlapping cues, a missing index, dot milliseconds, an end before its start, an empty cue, HTML italics, a
 * two-line cue and a cue past the end of its 30-second video. `expected` is what a tolerant reader keeps.
 */
export function messySrt(): { text: string; expected: { cues: number; warnings: number; lastEnd: number } } {
  const blocks = [
    '3\n00:00:09,000 --> 00:00:12,500\nThird by number, but it comes first in the file.',
    '1\n00:00:01,000 --> 00:00:04,000\nThe first line.',
    '2\n00:00:03,000 --> 00:00:07,000\n<i>This one overlaps the first line by a second.</i>',
    '00:00:06,500 --> 00:00:08,000\nNo index number on this block.',
    '4\n00:00:13.000 --> 00:00:15.250\nDot milliseconds instead of a comma.',
    '5\n00:00:18,000 --> 00:00:16,000\nThis cue ends before it starts.',
    '6\n00:00:19,000 --> 00:00:21,000\n',
    '7\n00:00:20,000 --> 00:00:26,000\nA long cue that hides\nunder the next one.',
    '8\n00:00:22,000 --> 00:00:24,000\nAn overlap inside an overlap.',
    '9\n00:00:28,000 --> 00:00:34,000\nThis line runs past the end of the video.',
  ];
  const text = `﻿${blocks.join('\n\n')}\n`.replace(/\n/g, '\r\n');
  // Kept: every block but the empty one (6); the end-before-start block is kept with a warning, as ReCut does.
  return { text, expected: { cues: 9, warnings: 2, lastEnd: 34 } };
}

// ------------------------------------------------------------------ shots for the trailer

export interface FrameStat { t: number; scene: number; yavg: number }

/**
 * Shots of a film from per-frame scene scores and mean luma: cuts where the scene score passes `threshold`, shots of
 * at least `minLen` seconds inside [from, to], `n` of them spread evenly, each trimmed to at most `maxLen` seconds
 * around its middle and kept only when it is neither dark nor washed out (mean luma within [`minLuma`, `maxLuma`]).
 */
export function pickShots(stats: FrameStat[], opts: { from: number; to: number; n: number; minLen?: number; maxLen?: number; threshold?: number; minLuma?: number; maxLuma?: number }): [number, number][] {
  const minLen = opts.minLen ?? 2.5, maxLen = opts.maxLen ?? 3.5, threshold = opts.threshold ?? 0.35, minLuma = opts.minLuma ?? 40, maxLuma = opts.maxLuma ?? 255;
  const frames = stats.filter((s) => s.t >= opts.from && s.t <= opts.to).sort((a, b) => a.t - b.t);
  if (!frames.length) return [];
  const cuts = [opts.from, ...frames.filter((f) => f.scene >= threshold).map((f) => f.t), opts.to];
  const shots: { a: number; b: number; luma: number }[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const s = cuts[i] + 0.25, e = cuts[i + 1] - 0.25;
    if (e - s < minLen) continue;
    const mid = (s + e) / 2, half = Math.min(maxLen, e - s) / 2;
    const a = round3(mid - half), b = round3(mid + half);
    const inside = frames.filter((f) => f.t >= a && f.t <= b);
    const luma = inside.length ? inside.reduce((n, f) => n + f.yavg, 0) / inside.length : 0;
    if (luma >= minLuma && luma <= maxLuma) shots.push({ a, b, luma });
  }
  if (shots.length <= opts.n) return shots.map((s) => [s.a, s.b]);
  const out: [number, number][] = [];
  for (let i = 0; i < opts.n; i++) {
    const s = shots[Math.floor(((i + 0.5) * shots.length) / opts.n)];
    out.push([s.a, s.b]);
  }
  return out;
}

/** Parse `ffmpeg ... signalstats ... metadata=print` output into per-frame stats (pts_time, scene score, YAVG). */
export function parseFrameStats(text: string): FrameStat[] {
  const out: FrameStat[] = [];
  let cur: FrameStat | null = null;
  for (const line of text.split('\n')) {
    const f = /pts_time:([0-9.]+)/.exec(line);
    if (f) { if (cur) out.push(cur); cur = { t: Number(f[1]), scene: 0, yavg: 0 }; continue; }
    if (!cur) continue;
    const m = /lavfi\.(scene_score|signalstats\.YAVG)=([0-9.]+)/.exec(line);
    if (m) { if (m[1] === 'scene_score') cur.scene = Number(m[2]); else cur.yavg = Number(m[2]); }
  }
  if (cur) out.push(cur);
  return out;
}

// ------------------------------------------------------------------ manifest and sizes

export const MB = 1024 * 1024;

/** "12.3 MB" / "456 KB" / "789 B" (binary units, one decimal from MB up). */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** "1:02:03" / "4:05" / "0:07.5" for a duration in seconds; "" when unknown. */
export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '';
  if (sec < 1) return `0:00${sec.toFixed(3).slice(1)}`;
  if (sec < 10) return `0:0${sec.toFixed(1)}`.replace(/^0:0(\d\d)/, '0:$1');
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`;
}

export interface ManifestRow { path: string; size: number; duration?: number | null; codec: string; purpose: string }

/** MANIFEST.txt: a header, one block per folder, and the total. */
export function formatManifest(rows: ManifestRow[], header: string[]): string {
  const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  // The kit folder's own files first, then one block per folder; names sorted inside each.
  const sorted = [...rows].sort((a, b) => dirOf(a.path).localeCompare(dirOf(b.path), 'en') || a.path.localeCompare(b.path, 'en'));
  const lines = [...header, ''];
  let folder: string | null = null;
  for (const r of sorted) {
    const i = r.path.lastIndexOf('/');
    const dir = i < 0 ? '' : r.path.slice(0, i);
    if (dir !== folder) { folder = dir; lines.push('', dir ? `${dir}/` : '(kit folder)'); }
    const name = i < 0 ? r.path : r.path.slice(i + 1);
    const facts = [formatSize(r.size), formatDuration(r.duration ?? null), r.codec].filter(Boolean).join(' | ');
    lines.push(`  ${name}`, `      ${facts}`, `      ${r.purpose}`);
  }
  const total = rows.reduce((n, r) => n + r.size, 0);
  lines.push('', `${rows.length} files, ${formatSize(total)} in total (before zipping).`);
  return `${lines.join('\n')}\n`;
}

/** Fill `{{NAME}}` placeholders; an unknown or unused name is an error, so a template typo fails the build. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  const used = new Set<string>();
  const out = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, name: string) => {
    if (!(name in values)) throw new Error(`template placeholder {{${name}}} has no value`);
    used.add(name);
    return values[name];
  });
  const unused = Object.keys(values).filter((k) => !used.has(k));
  if (unused.length) throw new Error(`template values not used: ${unused.join(', ')}`);
  return out;
}

/** Text file for the kit: CRLF line ends (Notepad on any Windows), no trailing spaces, one final newline. */
export function kitText(text: string): string {
  return `${text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n+$/, '')}\n`.replace(/\n/g, '\r\n');
}

function round3(n: number): number { return Math.round(n * 1000) / 1000; }

// ------------------------------------------------------------------ search words for TRY-THIS.md

const STOP = new Set(('that this with have from your what they there were when will would could should about into just like then them than '
  + 'been here come know dont didnt cant wont youre thats well yeah okay right want going gonna said tell these those where which while '
  + 'their again because some something nothing really still only over very much more even also make made take look need back down away '
  + 'other every after before through never ever always maybe sure think thing things doing done does lets let').split(' '));

/** Lower-case words of at least `min` letters in the cues (bracketed sound notes left out). */
export function cueWords(cues: Cue[], min = 4): string[] {
  return cues.flatMap((c) => c.text.toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/[’']/g, '').split(/[^a-z]+/))
    .filter((w) => w.length >= min);
}

/**
 * A word worth searching for: the most frequent non-stopword (ties: the longer, then alphabetical) of `a` that is
 * also in every list of `alsoIn`, preferring the `preferred` ones. Null when there is none.
 */
export function searchWord(a: Cue[], alsoIn: Cue[][] = [], preferred: string[] = []): string | null {
  const count = new Map<string, number>();
  for (const w of cueWords(a)) if (!STOP.has(w)) count.set(w, (count.get(w) ?? 0) + 1);
  const others = alsoIn.map((c) => new Set(cueWords(c)));
  const ok = (w: string) => count.has(w) && others.every((s) => s.has(w));
  for (const p of preferred) if (ok(p)) return p;
  const ranked = [...count.keys()].filter(ok).sort((x, y) => count.get(y)! - count.get(x)! || y.length - x.length || x.localeCompare(y));
  return ranked[0] ?? null;
}
