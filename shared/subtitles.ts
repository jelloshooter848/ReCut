import type { SubtitleCue } from './model';
import { uid } from './ids';

export interface ParseResult { cues: SubtitleCue[]; warnings: string[]; format: 'srt' | 'vtt' | 'unknown' }

function parseTime(s: string): number | null {
  // 00:01:02,345  |  00:01:02.345  |  01:02.345
  const m = s.trim().match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const mi = parseInt(m[2], 10); const se = parseInt(m[3], 10);
  const ms = parseInt(m[4].padEnd(3, '0'), 10);
  return h * 3600 + mi * 60 + se + ms / 1000;
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim();
}

/** Parse SRT or WebVTT. Tolerant of BOMs, CRLF, missing indices, overlapping cues and malformed blocks. */
export function parseSubtitles(content: string): ParseResult {
  const warnings: string[] = [];
  let text = content.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  let format: ParseResult['format'] = 'unknown';
  if (/^WEBVTT/.test(text.trimStart())) {
    format = 'vtt';
    // drop header + any NOTE / STYLE / REGION blocks
    const blocks = text.split(/\n\n+/);
    blocks.shift();
    text = blocks.filter((b) => !/^(NOTE|STYLE|REGION)\b/.test(b.trim())).join('\n\n');
  } else if (/\d{1,3}:\d{2}:\d{2},\d{1,3}\s*-->/.test(text)) format = 'srt';

  const cues: SubtitleCue[] = [];
  const blocks = text.split(/\n\n+/);
  let n = 0;
  for (const raw of blocks) {
    const lines = raw.split('\n').map((l) => l.trimEnd()).filter((l, i, arr) => !(i === 0 && l.trim() === ''));
    if (lines.length === 0) continue;
    n++;
    let idx = 0;
    // SRT numeric index, or a WebVTT cue identifier (any text), precedes the timing line.
    if (lines.length > 1 && !lines[0].includes('-->') && lines[1].includes('-->')) idx = 1;
    const timing = lines[idx];
    if (!timing || !timing.includes('-->')) { warnings.push(`Block ${n}: missing timing line`); continue; }
    const [a, bRaw] = timing.split('-->');
    const b = (bRaw ?? '').trim().split(/\s+/)[0];
    const start = parseTime(a); const end = parseTime(b);
    if (start === null || end === null) { warnings.push(`Block ${n}: unparseable timing "${timing.trim()}"`); continue; }
    if (end <= start) { warnings.push(`Block ${n}: end before start`); }
    const body = stripTags(lines.slice(idx + 1).join('\n'));
    if (!body) { warnings.push(`Block ${n}: empty text`); continue; }
    cues.push({ id: uid('cue'), start, end: Math.max(end, start + 0.001), text: body });
  }
  cues.sort((x, y) => x.start - y.start);
  if (cues.length === 0 && format === 'unknown') warnings.unshift('No subtitle cues recognised; expected SRT or WebVTT.');
  else if (cues.length === 0 && warnings.length === 0) warnings.push('The file contains no subtitle cues.');
  return { cues, warnings, format };
}

function fmtSrt(t: number): string {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000); const m = Math.floor((ms % 3600000) / 60000); const s = Math.floor((ms % 60000) / 1000); const r = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

/** SRT/VTT blocks end at the first blank line, so cue text cannot contain one: collapse them (and trim). */
function cueBody(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n[ \t]*(?:\n[ \t]*)+/g, '\n').trim();
}

export function serializeSrt(cues: { start: number; end: number; text: string }[]): string {
  return cues.map((c, i) => `${i + 1}\n${fmtSrt(c.start)} --> ${fmtSrt(c.end)}\n${cueBody(c.text)}\n`).join('\n');
}

export function serializeVtt(cues: { start: number; end: number; text: string }[]): string {
  return 'WEBVTT\n\n' + cues.map((c) => `${fmtSrt(c.start).replace(',', '.')} --> ${fmtSrt(c.end).replace(',', '.')}\n${cueBody(c.text)}\n`).join('\n');
}

/** Simple case-insensitive search with surrounding context. */
export interface CueMatch { cue: SubtitleCue; index: number; before: string; after: string }
export function searchCues(cues: SubtitleCue[], query: string, maxResults = 500): CueMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const out: CueMatch[] = [];
  for (let i = 0; i < cues.length; i++) {
    const t = cues[i].text.toLowerCase();
    if (terms.every((term) => t.includes(term))) {
      out.push({ cue: cues[i], index: i, before: cues[i - 1]?.text ?? '', after: cues[i + 1]?.text ?? '' });
      if (out.length >= maxResults) break;
    }
  }
  return out;
}
