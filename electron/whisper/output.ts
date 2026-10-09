/**
 * Reading whisper-cli's output: the JSON result file (`-oj`), the segment lines it prints on stdout and the progress
 * lines it prints on stderr (`-pp`), and turning segments into subtitle cues. Pure (no Node, no Electron).
 *
 * whisper-cli's JSON writer escapes only `"` and `\`: a segment whose text holds a control character (a tab, a
 * newline) makes the file invalid JSON, and a segment can end in the middle of a multi-byte UTF-8 character.
 * `parseWhisperJson` repairs both before parsing.
 */
import type { SubtitleCue } from '@shared/model';
import { uid } from '@shared/ids';

/** One recognized segment, seconds from the start of the audio that was transcribed. */
export interface WhisperSegment { start: number; end: number; text: string }

export interface WhisperJsonResult {
  /** Language whisper reports in `result.language` (its code, e.g. "en"), or null. */
  language: string | null;
  segments: WhisperSegment[];
}

/** Escape raw control characters (U+0000–U+001F) that appear inside JSON strings; structure is left alone. */
export function escapeControlCharsInStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) { escaped = false; out += ch; continue; }
    if (ch === '\\') { escaped = true; out += ch; continue; }
    if (ch === '"') { inString = false; out += ch; continue; }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += ch;
  }
  return out;
}

/** "00:01:02,345" / "00:01:02.345" → seconds, or NaN. */
export function parseWhisperTimestamp(s: unknown): number {
  if (typeof s !== 'string') return NaN;
  const m = /^\s*(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*$/.exec(s);
  if (!m) return NaN;
  const ms = m[4] ? Number(m[4].padEnd(3, '0')) : 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000;
}

function timeOf(seg: Record<string, unknown>, key: 'from' | 'to'): number {
  const off = seg.offsets as Record<string, unknown> | undefined;
  const v = off && typeof off === 'object' ? off[key] : undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return v / 1000;
  const ts = seg.timestamps as Record<string, unknown> | undefined;
  return ts && typeof ts === 'object' ? parseWhisperTimestamp(ts[key]) : NaN;
}

/** Remove the U+FFFD that a decoder leaves for a multi-byte character cut at either end of a segment. */
function trimBrokenChars(s: string): string {
  return s.replace(/^�+|�+$/g, '');
}

/**
 * Parse whisper-cli's `-oj` file (bytes or text). Throws when it is not a whisper result at all; segments with
 * unusable times are skipped (see segmentsToCues for the rest of the clean-up).
 */
export function parseWhisperJson(data: Uint8Array | string): WhisperJsonResult {
  const text = typeof data === 'string' ? data : new TextDecoder('utf-8', { fatal: false }).decode(data);
  let raw: unknown;
  try {
    raw = JSON.parse(escapeControlCharsInStrings(text.replace(/^﻿/, '')));
  } catch (e) {
    throw new Error(`whisper-cli wrote an unreadable result (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { transcription?: unknown }).transcription)) {
    throw new Error('whisper-cli wrote a result without a transcription');
  }
  const r = raw as { transcription: unknown[]; result?: { language?: unknown } };
  const language = typeof r.result?.language === 'string' && r.result.language ? r.result.language : null;
  const segments: WhisperSegment[] = [];
  for (const s of r.transcription) {
    if (!s || typeof s !== 'object') continue;
    const seg = s as Record<string, unknown>;
    const start = timeOf(seg, 'from');
    const end = timeOf(seg, 'to');
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    segments.push({ start, end, text: typeof seg.text === 'string' ? trimBrokenChars(seg.text) : '' });
  }
  return { language, segments };
}

/** A stdout segment line "[00:00:01.000 --> 00:00:04.500]  Hello there." → segment, or null. */
export function parseSegmentLine(line: string): WhisperSegment | null {
  const m = /^\s*\[(\d+:\d{1,2}:\d{1,2}[.,]\d{1,3}) --> (\d+:\d{1,2}:\d{1,2}[.,]\d{1,3})\]\s?(.*)$/.exec(line);
  if (!m) return null;
  const start = parseWhisperTimestamp(m[1]);
  const end = parseWhisperTimestamp(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end, text: m[3].trim() };
}

/** "whisper_print_progress_callback: progress =  45%" → 0.45, or null. */
export function parseProgressLine(line: string): number | null {
  const m = /progress\s*=\s*(\d{1,3})\s*%/.exec(line);
  if (!m) return null;
  return Math.min(1, Number(m[1]) / 100);
}

/** Segment text that is not speech: empty, whisper's silence marker, or no letter or digit at all. */
export function isNonSpeech(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^\[\s*BLANK_AUDIO\s*\]$/i.test(t)) return true;
  return !/[\p{L}\p{N}]/u.test(t);
}

/**
 * Segments of one chunk → cues in source seconds. `offset` is the chunk's start in the source; `length` its length
 * (times past it are clamped). Times are clamped to the chunk, swapped when reversed and given a minimum length;
 * non-speech segments are dropped; text is trimmed with inner runs of whitespace collapsed (line breaks kept).
 * A segment that repeats the previous one's text and is zero-length or starts before that one ends is a Whisper
 * echo, not speech, and is dropped (#117: `[03:22.160 --> 03:22.160]` repeating the line before it).
 */
export function segmentsToCues(segments: readonly WhisperSegment[], offset = 0, length = Infinity): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const MIN = 0.05;
  let prev: { text: string; end: number } | null = null;
  for (const s of segments) {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end)) continue;
    const text = s.text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join('\n');
    if (isNonSpeech(text)) continue;
    const echo = prev !== null && text === prev.text && (s.end <= s.start || Math.min(s.start, s.end) < prev.end);
    prev = { text, end: Math.max(s.start, s.end) };
    if (echo) continue;
    let a = Math.min(s.start, s.end);
    let b = Math.max(s.start, s.end);
    a = Math.max(0, Math.min(a, length));
    b = Math.max(0, Math.min(b, length));
    if (b - a < MIN) {
      if (a + MIN <= length) b = a + MIN;
      else a = Math.max(0, b - MIN);
    }
    cues.push({ id: uid('cue'), start: round3(offset + a), end: round3(offset + b), text });
  }
  return cues;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
