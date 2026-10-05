import type { Rational } from './model';

export const FPS_PRESETS: { label: string; fps: Rational }[] = [
  { label: '23.976', fps: { num: 24000, den: 1001 } },
  { label: '24', fps: { num: 24, den: 1 } },
  { label: '25', fps: { num: 25, den: 1 } },
  { label: '29.97', fps: { num: 30000, den: 1001 } },
  { label: '30', fps: { num: 30, den: 1 } },
  { label: '50', fps: { num: 50, den: 1 } },
  { label: '59.94', fps: { num: 60000, den: 1001 } },
  { label: '60', fps: { num: 60, den: 1 } },
];

export function fpsValue(fps: Rational): number { return fps.num / fps.den; }

/** Bounds for a usable frame rate (see isValidFps). */
export const MIN_FPS = 1;
export const MAX_FPS = 1000;
/** Largest numerator / denominator accepted (keeps frame * den / num products well inside 2^53). */
export const MAX_FPS_TERM = 1_000_000;

/**
 * The single frame-rate invariant: `num` and `den` are positive integers no larger than MAX_FPS_TERM and
 * the rate lies within [MIN_FPS, MAX_FPS]. Every frame <-> seconds conversion divides by one of the terms,
 * so anything else (0, negative, non-integer, NaN / Infinity, strings, null) must never reach the timeline.
 */
export function isValidFps(r: unknown): r is Rational {
  if (!r || typeof r !== 'object') return false;
  const { num, den } = r as { num?: unknown; den?: unknown };
  if (typeof num !== 'number' || typeof den !== 'number') return false;
  if (!Number.isInteger(num) || !Number.isInteger(den)) return false;
  if (num < 1 || den < 1 || num > MAX_FPS_TERM || den > MAX_FPS_TERM) return false;
  const v = num / den;
  return v >= MIN_FPS && v <= MAX_FPS;
}

/** `r` when it passes isValidFps, else `fallback` (e.g. a probe's "unknown" rate {num:0,den:1} → the sequence rate). */
export function validFpsOr(r: unknown, fallback: Rational): Rational {
  return isValidFps(r) ? r : fallback;
}

export function framesToSeconds(frames: number, fps: Rational): number {
  return (frames * fps.den) / fps.num;
}

export function secondsToFrames(seconds: number, fps: Rational): number {
  // Round to the nearest frame with a small epsilon to avoid 23.9999 -> 23. Sign-symmetric (halves round away
  // from zero for negatives too, so f(-x) === -f(x)) and never -0. Positive results are unchanged.
  const x = seconds * fps.num / fps.den;
  const n = Math.round(Math.abs(x) + 1e-6);
  return x < 0 && n !== 0 ? -n : n;
}

export function secondsToFramesFloor(seconds: number, fps: Rational): number {
  return Math.floor(seconds * fps.num / fps.den + 1e-6);
}

/** Center-of-frame time in seconds, used for seeking video elements so decoders land on the intended frame. */
export function frameCenterSeconds(frame: number, fps: Rational): number {
  return ((frame + 0.5) * fps.den) / fps.num;
}

export function fpsEquals(a: Rational, b: Rational): boolean {
  return a.num * b.den === b.num * a.den;
}

/**
 * A frame rate from a decimal value (e.g. 23.976), or null when the result would not pass isValidFps.
 * Integers stay n/1; a value within 0.005 of an NTSC rate n*1000/1001 (23.976, 29.97, 47.952, 59.94, 119.88,
 * ..., including 2-decimal labels such as 23.98 or 47.95) becomes that exact rational; anything else is kept
 * to three decimals (n/1000).
 */
export function parseFps(value: number): Rational | null {
  if (!Number.isFinite(value)) return null;
  const candidates = FPS_PRESETS.map((p) => p.fps);
  // Snap to a preset within 0.01 so rounded labels (23.98, 29.97, 59.94) resolve to the exact NTSC rational.
  for (const c of candidates) if (Math.abs(fpsValue(c) - value) < 0.01) return c;
  let r: Rational;
  const n = Math.round((value * 1001) / 1000);
  if (Number.isInteger(value)) r = { num: value, den: 1 };
  else if (n > 0 && Math.abs((n * 1000) / 1001 - value) <= 0.005 + 1e-9) r = { num: n * 1000, den: 1001 };
  else r = { num: Math.round(value * 1000), den: 1000 };
  return isValidFps(r) ? r : null;
}

export function fpsLabel(fps: Rational): string {
  const v = fpsValue(fps);
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * SMPTE drop-frame: how many frame numbers are skipped at the start of every minute except every 10th
 * minute — 2 at 29.97 (30000/1001), 4 at 59.94 (60000/1001), 0 (no drop-frame timecode) at any other rate.
 */
export function dropFramesPerMinute(fps: Rational): number {
  return fpsEquals(fps, { num: 30000, den: 1001 }) ? 2 : fpsEquals(fps, { num: 60000, den: 1001 }) ? 4 : 0;
}

/** Drop-frame: frame count -> label count (the count a non-drop counter shows for the same HH:MM:SS;FF label). */
function dfFramesToLabel(frames: number, nominal: number, drop: number): number {
  const perMin = nominal * 60 - drop;          // 1798 at 29.97
  const per10Min = nominal * 600 - 9 * drop;   // 17982 at 29.97
  const tens = Math.floor(frames / per10Min);
  const rem = frames % per10Min;
  const droppedMinutes = rem < drop ? 0 : Math.floor((rem - drop) / perMin);
  return frames + 9 * drop * tens + drop * droppedMinutes;
}

/**
 * Format frames as HH:MM:SS:FF. With `dropIndicator` at 29.97 / 59.94 the result is SMPTE drop-frame
 * timecode written HH:MM:SS;FF: frame numbers 00–01 (00–03 at 59.94) are skipped at the start of every
 * minute except minutes 00, 10, 20, ..., so the label tracks real time (107892 frames at 29.97 = 01:00:00;00).
 * Otherwise, and at every other rate, it is non-drop: a plain count at the nominal rate round(fps), with ':'.
 * Negative frames get a leading '-' on the label of |frames| (parseTimecode reads that back).
 */
export function formatTimecode(frames: number, fps: Rational, opts: { dropIndicator?: boolean } = {}): string {
  frames = Math.round(frames);
  const neg = frames < 0;
  frames = Math.abs(frames);
  const nominal = Math.round(fpsValue(fps));
  const drop = opts.dropIndicator ? dropFramesPerMinute(fps) : 0;
  const label = drop ? dfFramesToLabel(frames, nominal, drop) : frames;
  const ff = label % nominal;
  const totalSec = Math.floor(label / nominal);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${neg ? '-' : ''}${p(h)}:${p(m)}:${p(s)}${drop ? ';' : ':'}${p(ff)}`;
}

/** Format seconds as HH:MM:SS:FF using the given frame rate for the frame field. */
export function formatSecondsTimecode(seconds: number, fps: Rational): string {
  return formatTimecode(secondsToFrames(seconds, fps), fps);
}

/**
 * Format seconds as H:MM:SS.mmm or MM:SS.mmm (without `ms`: H:MM:SS / MM:SS, whole seconds truncated).
 * Every field derives from one rounded millisecond count, so float noise never shows (2.3 -> 00:02.300).
 */
export function formatClock(seconds: number, ms = false): string {
  const total = Math.round(Math.abs(seconds) * 1000);
  const neg = seconds < 0 && total > 0;
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const frac = total % 1000;
  const p = (n: number) => String(n).padStart(2, '0');
  const base = h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
  return `${neg ? '-' : ''}${base}${ms ? '.' + String(frac).padStart(3, '0') : ''}`;
}

/**
 * Parse a timecode into frames. Fields fill right-to-left like Premiere's timecode entry:
 * "HH:MM:SS:FF", "MM:SS:FF", "SS:FF", "FF" (separators ':' ';' '.'), or "+N" / "-N" (frames relative to
 * `current`). Surrounding whitespace is ignored. Every field must be ASCII digits only; empty fields, more than
 * four fields, or a result that is not a safe integer give null (nothing is guessed or truncated).
 *
 * Drop-frame: at 29.97 / 59.94 an input containing ';' is SMPTE drop-frame (see formatTimecode); input with
 * only ':' / '.' stays non-drop. Fields may overflow and carry (SS;FF "59;32" = 00:01:00;02), but a label that
 * drop-frame skips (00:01:00;00 and 00:01:00;01 at 29.97, in any minute not divisible by 10) gives null, as
 * Premiere rejects it. At other rates ';' is just a separator.
 *
 * Negative: a leading '-' on a full four-field "-HH:MM:SS:FF" (what formatTimecode prints for frames < 0) is
 * an absolute negative timecode. Shorter signed forms other than "+N" / "-N" ("-1:00") stay null: they read
 * like relative entry and would be ambiguous.
 */
export function parseTimecode(input: string, fps: Rational, current = 0): number | null {
  const str = input.trim();
  if (!str) return null;
  const rel = /^([+-])([0-9]+)$/.exec(str);
  if (rel) {
    const n = current + (rel[1] === '-' ? -1 : 1) * Number(rel[2]);
    return Number.isSafeInteger(n) ? n : null;
  }
  const neg = str.startsWith('-');
  const body = neg ? str.slice(1) : str;
  const fields = body.split(/[:;.]/);
  if (fields.length > 4 || (neg && fields.length !== 4) || !fields.every((p) => /^[0-9]+$/.test(p))) return null;
  const parts = fields.map(Number);
  while (parts.length < 4) parts.unshift(0);
  const [h, m, s, f] = parts;
  const nominal = Math.round(fpsValue(fps));
  // Label count: the frame count of this label on a non-drop counter (overflowing fields carry).
  const label = ((h * 3600 + m * 60 + s) * nominal) + f;
  if (!Number.isSafeInteger(label)) return null;
  let total = label;
  const drop = body.includes(';') ? dropFramesPerMinute(fps) : 0;
  if (drop) {
    const minutes = Math.floor(label / (nominal * 60));
    if (label % (nominal * 60) < drop && minutes % 10 !== 0) return null; // a skipped frame number: not a DF label
    total = label - drop * (minutes - Math.floor(minutes / 10));
  }
  return neg && total !== 0 ? -total : total;
}

export function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
