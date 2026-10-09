/**
 * Export warnings from FFmpeg's own output (bugs/closed/2026-10-09-export-silently-pads-truncated-sources.md).
 *
 * FFmpeg exits 0 when a source ends early (truncated download, damaged file), has a decode error partway through
 * or has corrupt packets, and the render graph pads every clip to its full length (tpad / apad), so the export
 * "succeeds" with a frozen or silent stretch. Two checks turn that into export warnings:
 *
 * 1. Stderr: every export FFmpeg run uses `-loglevel warning`; classifyFfmpegLine sorts each stderr line into a
 *    content problem (PROBLEM_RULES), a known harmless line (HARMLESS_RULES, checked first) or anything else
 *    (ignored). Problems are attributed to an input file by FFmpeg's input index (`[in#1/...]`, `[aist#1:1/...]`,
 *    `Error while decoding stream #1:1`), else by the demuxer / decoder name against the sources' probe.
 * 2. Source ends: for each source file and stream the export reads, where its data really ends (a demux-only
 *    ffprobe pass near the end, electron/export/sourceCheck.ts) against how far the export reads it. This catches
 *    a file that is shorter than the project's probe says, for which FFmpeg prints nothing at all.
 *
 * Everything here is pure (no I/O) so it can be unit-tested with real FFmpeg output.
 */
import type { ID, MediaItem } from '@shared/model';

// ---------------------------------------------------------------------------------------------------
// Line classifier
// ---------------------------------------------------------------------------------------------------

/**
 * Lines that are harmless even though some of them contain words the problem rules look for. Checked before
 * PROBLEM_RULES. Keep this list small and say why each entry is harmless.
 */
export const HARMLESS_RULES: { pattern: RegExp; why: string }[] = [
  { pattern: /deprecated pixel format used/i, why: 'swscale note about full-range YUVJ formats; the output is correct' },
  { pattern: /Guessed Channel Layout/i, why: 'the source has no layout tag; the export picks the layout (see the channel checks)' },
  { pattern: /number of reference frames .* exceeds max/i, why: 'H.264 note after a seek into a stream ("probably corrupt input"); decoding recovers at the key frame' },
  { pattern: /mmco: unref short failure/i, why: 'H.264 note after a seek; the frames before the key frame are dropped anyway' },
  { pattern: /Could not find ref with POC|Missing reference picture|reference picture missing during reorder/i, why: 'open-GOP leading pictures after a seek; they are dropped' },
  { pattern: /^\s*Last message repeated \d+ times?/i, why: 'repeat counter: counted on the previous line instead' },
];

/** Lines that mean the source content could not be read as asked. Each rule's `what` documents the case. */
export const PROBLEM_RULES: { pattern: RegExp; what: string }[] = [
  { pattern: /Invalid data found when processing input/i, what: 'damaged or unreadable data (demuxer or decoder)' },
  { pattern: /error while decoding|Decoding error|Error submitting packet to decoder|Error splitting the input into NAL units|Invalid NAL unit size/i, what: 'a decode error' },
  { pattern: /corrupt/i, what: '"Packet corrupt", "corrupt input packet", "corrupt decoded frame"' },
  { pattern: /partial file/i, what: 'MP4 / MOV whose index points past the end of the file (truncated)' },
  { pattern: /File ended prematurely/i, what: 'Matroska / WebM file cut short (truncated)' },
  { pattern: /moov atom not found/i, what: 'MP4 / MOV without its index (truncated while recording or downloading; FFmpeg fails)' },
  { pattern: /invalid as first byte of an EBML number|EBML header parsing failed/i, what: 'damaged Matroska / WebM data' },
  { pattern: /Truncating packet|Packet truncated|Header missing/i, what: 'a packet cut short or a damaged frame header' },
  { pattern: /Error during demuxing|I\/O error|Read error/i, what: 'the file could not be read (disk / network error)' },
];

/** One problem line, with what FFmpeg says about where it came from. */
export interface FfmpegProblem {
  /** The message without FFmpeg's `[context @ 0x…]` prefixes, trimmed. */
  text: string;
  /** Input index (`-i` order) when the line names one. */
  input: number | null;
  /** Demuxer / decoder names from the prefixes (`matroska,webm`, `h264`, `aac`), lowercased. */
  contexts: string[];
  /** How many times FFmpeg printed it (`Last message repeated N times` adds N). */
  count: number;
}

export type FfmpegLineClass =
  | { kind: 'problem'; problem: FfmpegProblem }
  | { kind: 'harmless'; repeat?: number }
  | { kind: 'other' };

const PREFIX = /^\s*\[([^\]]*)\]\s*/;

/** Parses one stderr line into its problem, if it is one. */
export function classifyFfmpegLine(line: string): FfmpegLineClass {
  const repeat = /^\s*Last message repeated (\d+) times?/i.exec(line);
  if (repeat) return { kind: 'harmless', repeat: Number(repeat[1]) };
  let rest = line;
  let input: number | null = null;
  const contexts: string[] = [];
  for (let m = PREFIX.exec(rest); m; m = PREFIX.exec(rest)) {
    const ctx = m[1].replace(/\s*@\s*0x[0-9a-f]+$/i, '').trim();
    // FFmpeg 6.1+: `in#1/matroska,webm`, `vist#0:0/h264`, `aist#1:1/aac`; FFmpeg 7.1+: `dec:h264`, `vist#0:0/h264`.
    const io = /^(?:in|[vasdt]ist)#(\d+)(?::\d+)?(?:\/(.*))?$/.exec(ctx);
    if (io) {
      input ??= Number(io[1]);
      if (io[2]) contexts.push(io[2].toLowerCase());
    } else if (/^(?:out#|[vasdt]ost#|mux|enc:)/.test(ctx)) {
      return { kind: 'other' }; // output side (encoder / muxer): not about a source
    } else {
      const name = ctx.replace(/^dec:/, '').toLowerCase();
      if (name && name !== 'null') contexts.push(name); // `[NULL @ …]`: a parser, no useful name
    }
    rest = rest.slice(m[0].length);
  }
  const text = rest.trim();
  if (!text) return { kind: 'other' };
  if (HARMLESS_RULES.some((r) => r.pattern.test(text))) return { kind: 'harmless' };
  if (!PROBLEM_RULES.some((r) => r.pattern.test(text))) return { kind: 'other' };
  // FFmpeg <= 6.0: "Error while decoding stream #1:0: …"; "Input stream #1:0" in some summaries.
  const named = /stream #(\d+):\d+/i.exec(text);
  if (input === null && named) input = Number(named[1]);
  return { kind: 'problem', problem: { text: text.replace(/\s*@\s*0x[0-9a-f]+/gi, '').slice(0, 300), input, contexts, count: 1 } };
}

/** Max problems kept per FFmpeg run; the rest only add to the last one's count. */
export const MAX_PROBLEMS_PER_RUN = 2000;

/**
 * Collects problem lines from one FFmpeg run's stderr, one line at a time (`push`), keeping at most
 * MAX_PROBLEMS_PER_RUN entries. `Last message repeated N times` after a problem adds N to its count.
 */
export class FfmpegProblemCollector {
  readonly problems: FfmpegProblem[] = [];
  private lastWasProblem = false;
  push(line: string): void {
    if (!line.trim()) return;
    const c = classifyFfmpegLine(line);
    if (c.kind === 'harmless' && c.repeat !== undefined) {
      if (this.lastWasProblem) this.problems[this.problems.length - 1].count += c.repeat;
      return;
    }
    this.lastWasProblem = c.kind === 'problem';
    if (c.kind !== 'problem') return;
    if (this.problems.length < MAX_PROBLEMS_PER_RUN) this.problems.push(c.problem);
    else this.problems[this.problems.length - 1].count += 1;
  }
}

export function ffmpegProblems(lines: string[]): FfmpegProblem[] {
  const c = new FfmpegProblemCollector();
  for (const l of lines) c.push(l);
  return c.problems;
}

/** The `-i` values of an FFmpeg command in input order, with the `file:` prefix (ffmpegFileArg) removed. */
export function ffmpegInputPaths(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < args.length; i++) if (args[i - 1] === '-i') out.push(args[i].replace(/^file:/, ''));
  return out;
}

/** The problems of one FFmpeg run, with that run's inputs (to resolve input indexes). */
export interface FfmpegRunProblems {
  inputs: string[];
  problems: FfmpegProblem[];
}

// ---------------------------------------------------------------------------------------------------
// Source end checks (pure parts; the ffprobe runs are in sourceCheck.ts)
// ---------------------------------------------------------------------------------------------------

/**
 * Data that ends at most this many seconds before the point the export reads to is fine: streams end a little
 * apart in normal files (an audio stream a few frames shorter than the video), and the graph reads a little
 * beyond what it shows (the half-frame lead and the frame after the last one).
 */
export const SOURCE_END_TOLERANCE_SEC = 0.5;

/** One stream of one source file the export reads, and how far. */
export interface SourceEndCheck {
  path: string;
  mediaId: ID;
  /** ffprobe `-select_streams` value: `v:0`, `a:0` or an absolute stream index. */
  stream: string;
  kind: 'video' | 'audio';
  /** Container-relative second the export needs data up to: min(furthest read, the probed duration). */
  needEnd: number;
  /** The probed container start time (ffprobe packet times are absolute). */
  startTime: number;
}

/**
 * The streams to check for an export's graphs (one per output file): every media input (`-copyts [-ss S] -t T -i path`) the
 * filter graph reads, grouped per file and stream with the furthest point read (S + T - 0.25, the graph's read
 * margin). Stills (`-loop`), inputs without `-t` (chapters, subtitles) and paths that are not a project media item
 * are skipped. A read past the probed duration is already a pre-export warning ("extends past the end of its
 * media"), so the point checked is capped at the probed duration.
 */
export function planSourceEndChecks(graphs: { inputArgs: string[]; filterGraph: string }[], media: Record<ID, MediaItem | undefined>): SourceEndCheck[] {
  const byPath = new Map<string, MediaItem>();
  for (const m of Object.values(media)) if (m && m.kind !== 'image' && m.probe) byPath.set(m.path, m);
  const checks = new Map<string, SourceEndCheck>();
  for (const graph of graphs) addGraphChecks(graph, byPath, checks);
  return [...checks.values()];
}

function addGraphChecks(graph: { inputArgs: string[]; filterGraph: string }, byPath: Map<string, MediaItem>, checks: Map<string, SourceEndCheck>): void {
  const inputs: { path: string; end: number }[] = [];
  let ss = 0, t: number | null = null, loop = false;
  const a = graph.inputArgs;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '-ss') ss = Number(a[++i]);
    else if (a[i] === '-t') t = Number(a[++i]);
    else if (a[i] === '-loop') { loop = true; i++; }
    else if (a[i] === '-i') {
      const p = a[++i].replace(/^file:/, '');
      inputs.push({ path: loop || t === null || !Number.isFinite(ss) || !Number.isFinite(t) ? '' : p, end: ss + (t ?? 0) - 0.25 });
      ss = 0; t = null; loop = false;
    }
  }
  for (const m of graph.filterGraph.matchAll(/\[(\d+):(v:0|a:0|\d+)\]/g)) {
    const inp = inputs[Number(m[1])];
    const item = inp?.path ? byPath.get(inp.path) : undefined;
    if (!item?.probe) continue;
    const sel = m[2];
    const kind: 'video' | 'audio' = sel === 'v:0' || (/^\d+$/.test(sel) && item.probe.video?.index === Number(sel)) ? 'video' : 'audio';
    const dur = Number.isFinite(item.probe.duration) && item.probe.duration > 0 ? item.probe.duration : Infinity;
    const needEnd = Math.min(inp.end, dur);
    if (!(needEnd > SOURCE_END_TOLERANCE_SEC)) continue;
    const key = `${inp.path}\u0000${sel}`;
    const prev = checks.get(key);
    if (!prev || needEnd > prev.needEnd) {
      checks.set(key, { path: inp.path, mediaId: item.id, stream: sel, kind, needEnd, startTime: Number.isFinite(item.probe.startTime) ? item.probe.startTime : 0 });
    }
  }
}

/** End (container-relative seconds) of the data in ffprobe packets (`pts_time` / `dts_time` + `duration_time`); null without packets. */
export function packetDataEnd(packets: { pts_time?: string; dts_time?: string; duration_time?: string }[], startTime: number): number | null {
  let end: number | null = null;
  for (const p of packets) {
    const t = Number(p.pts_time ?? p.dts_time);
    if (!Number.isFinite(t)) continue;
    const d = Number(p.duration_time);
    const e = t + (Number.isFinite(d) && d > 0 ? d : 0) - startTime;
    if (end === null || e > end) end = e;
  }
  return end;
}

/** A stream whose data ends before the point the export reads it to. */
export interface SourceEndResult {
  check: SourceEndCheck;
  /** Where the data ends (container-relative seconds); 0 when the stream has no readable data at all. */
  dataEnd: number;
}

// ---------------------------------------------------------------------------------------------------
// Warning texts
// ---------------------------------------------------------------------------------------------------

/** Max source warnings listed; the rest are counted in one more line. */
export const MAX_SOURCE_WARNINGS = 5;

function fmtTime(s: number): string {
  if (s < 60) return `${s.toFixed(2)} s`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const rs = r.toFixed(1).padStart(4, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rs}` : `${m}:${rs}`;
}

function namesList(names: string[]): string {
  const q = names.map((n) => `"${n}"`);
  return q.length <= 3 ? q.join(', ') : `${q.slice(0, 3).join(', ')} and ${q.length - 3} more`;
}

function messageWithCount(first: FfmpegProblem, total: number): string {
  const text = first.text.replace(/[.\s]+$/, '');
  return total > 1 ? `${text} (and ${total - 1} more message${total - 1 === 1 ? '' : 's'})` : text;
}

/**
 * Turns the problems of every FFmpeg run of an export and the source end results into export warnings: one per
 * source file (its first problem line and the number of others), at most MAX_SOURCE_WARNINGS plus a count.
 *
 * Attribution of a problem line: its input index when FFmpeg printed one; else the run's source files whose
 * container or codec matches the line's demuxer / decoder name (`[matroska,webm @ …]`, `[h264 @ …]`), or all the
 * run's source files; one candidate names it, several prefer one that ends early, else the warning lists them.
 * A run without source inputs (the join of a chunked export) reports "joining the rendered chunks"; a line naming a
 * non-source input of a single pass (the chapters or subtitle temp file) reports a plain "a problem".
 */
export function exportSourceWarnings(runs: FfmpegRunProblems[], ends: SourceEndResult[], media: Record<ID, MediaItem | undefined>): string[] {
  const byPath = new Map<string, MediaItem>();
  for (const m of Object.values(media)) if (m) byPath.set(m.path, m);
  const earlyPaths = new Set(ends.map((e) => e.check.path));
  /** Group key -> first problem, total count, candidate paths. */
  const groups = new Map<string, { first: FfmpegProblem; total: number; paths: string[] }>();
  const add = (key: string, p: FfmpegProblem, paths: string[]) => {
    const g = groups.get(key);
    if (g) g.total += p.count;
    else groups.set(key, { first: p, total: p.count, paths });
  };
  for (const run of runs) {
    const sources = [...new Set(run.inputs.filter((p) => byPath.has(p)))];
    for (const p of run.problems) {
      const direct = p.input !== null ? run.inputs[p.input] : undefined;
      if (direct !== undefined) {
        if (byPath.has(direct)) add(direct, p, [direct]);
        else add(sources.length ? 'misc' : 'join', p, []); // a chapters / subtitle temp input, or a chunk list
        continue;
      }
      if (!sources.length) { add('join', p, []); continue; }
      const matching = sources.filter((s) => {
        const pr = byPath.get(s)?.probe;
        if (!pr) return false;
        const names = [pr.container, pr.video?.codec, ...pr.audio.map((a) => a.codec)].filter(Boolean).map((n) => String(n).toLowerCase());
        return p.contexts.some((c) => names.includes(c));
      });
      let cands = matching.length ? matching : sources;
      if (cands.length > 1 && cands.some((c) => earlyPaths.has(c))) cands = [cands.find((c) => earlyPaths.has(c))!];
      add(cands.length === 1 ? cands[0] : `some:${cands.join('\u0000')}`, p, cands);
    }
  }

  const warnings: string[] = [];
  const nameOf = (p: string) => byPath.get(p)?.name ?? p.split(/[\\/]/).pop() ?? p;
  // Files that end early, merged with that file's FFmpeg messages.
  const endsByPath = new Map<string, SourceEndResult[]>();
  for (const e of ends) endsByPath.set(e.check.path, [...(endsByPath.get(e.check.path) ?? []), e]);
  for (const [p, es] of endsByPath) {
    const dataEnd = Math.min(...es.map((e) => e.dataEnd));
    const needEnd = Math.max(...es.map((e) => e.check.needEnd));
    const kinds = new Set(es.map((e) => e.check.kind));
    const effect = kinds.size === 2 ? 'frozen and silent' : kinds.has('video') ? 'frozen on its last frame' : 'silent';
    const g = groups.get(p);
    groups.delete(p);
    const stops = dataEnd > 0 ? `its data stops at about ${fmtTime(dataEnd)}` : 'it has no readable data';
    warnings.push(`Export finished, but "${nameOf(p)}" ends early: ${stops}, but the export reads it up to ${fmtTime(needEnd)}, `
      + `so that part of the output is ${effect}.${g ? ` FFmpeg reported: ${messageWithCount(g.first, g.total)}.` : ''} Check the file or relink it.`);
  }
  for (const [key, g] of groups) {
    const msg = messageWithCount(g.first, g.total);
    if (key === 'join') {
      warnings.push(`Export finished, but FFmpeg reported a problem joining the rendered chunks: ${msg}. Part of the output may be damaged; export again.`);
    } else if (key === 'misc') {
      warnings.push(`Export finished, but FFmpeg reported a problem: ${msg}. Part of the output may be damaged; export again.`);
    } else if (g.paths.length === 1) {
      warnings.push(`Export finished, but FFmpeg reported a problem reading "${nameOf(g.paths[0])}": ${msg}. Part of the output may be silent or frozen. Check the file or relink it.`);
    } else {
      warnings.push(`Export finished, but FFmpeg reported a problem reading one of these source files: ${namesList(g.paths.map(nameOf))}: ${msg}. `
        + 'Part of the output may be silent or frozen. Check the files or relink them.');
    }
  }
  if (warnings.length <= MAX_SOURCE_WARNINGS) return warnings;
  const more = warnings.length - MAX_SOURCE_WARNINGS;
  return [...warnings.slice(0, MAX_SOURCE_WARNINGS), `…and ${more} more problem${more === 1 ? '' : 's'} reported by FFmpeg. Check the export before using it.`];
}
