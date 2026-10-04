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

export function framesToSeconds(frames: number, fps: Rational): number {
  return (frames * fps.den) / fps.num;
}

export function secondsToFrames(seconds: number, fps: Rational): number {
  // round to nearest frame with small epsilon to avoid 23.9999 -> 23
  return Math.round(seconds * fps.num / fps.den + 1e-6);
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

export function parseFps(value: number): Rational {
  const candidates = FPS_PRESETS.map((p) => p.fps);
  // Snap to a preset within 0.01 so rounded labels (23.98, 29.97, 59.94) resolve to the exact NTSC rational.
  for (const c of candidates) if (Math.abs(fpsValue(c) - value) < 0.01) return c;
  if (Number.isInteger(value)) return { num: value, den: 1 };
  return { num: Math.round(value * 1000), den: 1000 };
}

export function fpsLabel(fps: Rational): string {
  const v = fpsValue(fps);
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

/** Format frames as HH:MM:SS:FF (non-drop timecode; ';' separator for drop-frame-ish rates is used for 29.97/59.94). */
export function formatTimecode(frames: number, fps: Rational, opts: { dropIndicator?: boolean } = {}): string {
  const neg = frames < 0;
  frames = Math.abs(Math.round(frames));
  const nominal = Math.round(fpsValue(fps));
  const ff = frames % nominal;
  const totalSec = Math.floor(frames / nominal);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const sep = opts.dropIndicator && fps.den === 1001 && (nominal === 30 || nominal === 60) ? ';' : ':';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${neg ? '-' : ''}${p(h)}:${p(m)}:${p(s)}${sep}${p(ff)}`;
}

/** Format seconds as HH:MM:SS:FF using the given frame rate for the frame field. */
export function formatSecondsTimecode(seconds: number, fps: Rational): string {
  return formatTimecode(secondsToFrames(seconds, fps), fps);
}

/** Format seconds as H:MM:SS.mmm or MM:SS.mmm */
export function formatClock(seconds: number, ms = false): string {
  const neg = seconds < 0;
  seconds = Math.abs(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const frac = Math.floor((seconds - Math.floor(seconds)) * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  const base = h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
  return `${neg ? '-' : ''}${base}${ms ? '.' + String(frac).padStart(3, '0') : ''}`;
}

/**
 * Parse a timecode into frames. Fields fill right-to-left like Premiere's timecode entry:
 * "HH:MM:SS:FF", "MM:SS:FF", "SS:FF", "FF", or "+/-N" (frames relative to `current`). Returns null if invalid.
 */
export function parseTimecode(input: string, fps: Rational, current = 0): number | null {
  const str = input.trim();
  if (!str) return null;
  const nominal = Math.round(fpsValue(fps));
  if (/^[+-]\d+$/.test(str)) return current + parseInt(str, 10);
  const parts = str.split(/[:;.]/).map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return null;
  let h = 0, m = 0, s = 0, f = 0;
  if (parts.length === 1) [f] = parts;
  else if (parts.length === 2) [s, f] = parts;
  else if (parts.length === 3) [m, s, f] = parts;
  else [h, m, s, f] = parts.slice(-4);
  return ((h * 3600 + m * 60 + s) * nominal) + f;
}

export function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
