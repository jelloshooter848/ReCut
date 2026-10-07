/**
 * Sample aspect ratio (SAR) rules shared by the project loader, the export filter graph and the preview
 * compositor. Pure: no DOM, no Node.
 *
 * A probe stores the stream's SAR (`VideoStreamInfo.sar`); `width` / `height` are storage pixels on the display
 * axes (already swapped for 90 / 270 rotation), and SAR stretches the storage x axis.
 */
import type { Rational, VideoStreamInfo } from './model';

/**
 * Still-image file extensions (lower case, no dot). FFmpeg decodes all of them; Chromium draws only some
 * (src/playback/mediaSource.ts DISPLAYABLE_IMAGE_EXTS), the rest preview from a PNG proxy. The one list behind the
 * main-process classifier (electron/media/probe.ts IMAGE_EXT), the renderer's (src/state/store.ts kindFromProbe,
 * src/playback/mediaSource.ts isStillImage) and the import dialog's Images filter / default bin
 * (src/state/parseIdentity.ts IMAGE_EXTS).
 */
export const STILL_IMAGE_EXTS: readonly string[] = [
  'png', 'apng', 'jpg', 'jpeg', 'jpe', 'jfif', 'webp', 'bmp', 'tif', 'tiff', 'gif', 'heic', 'heif', 'avif',
  'jxl', 'tga', 'exr', 'psd', 'dpx', 'sgi', 'pcx', 'ppm', 'pgm', 'pbm', 'pam', 'qoi', 'hdr', 'jp2', 'j2k',
];

/**
 * ffprobe codec names of still pictures. av1 / hevc count only without duration (AVIF / HEIC items in a mov
 * container); the classifiers apply that rule.
 */
export const STILL_IMAGE_CODECS: readonly string[] = [
  'png', 'apng', 'mjpeg', 'jpegls', 'webp', 'bmp', 'tiff', 'gif', 'jpegxl', 'targa', 'exr', 'psd', 'dpx', 'sgi', 'pcx',
  'ppm', 'pgm', 'pgmyuv', 'pbm', 'pam', 'qoi', 'hdr', 'jpeg2000', 'av1', 'hevc',
];

/** Smallest / largest SAR treated as real; anything outside (or not a ratio of positive safe integers) is square. */
export const MIN_SAR = 1 / 16;
export const MAX_SAR = 16;

/** `{ num, den }` when `s` is a SAR of positive safe integers within MIN_SAR..MAX_SAR, else null. */
export function saneSar(s: unknown): Rational | null {
  if (!s || typeof s !== 'object') return null;
  const { num, den } = s as { num?: unknown; den?: unknown };
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || (num as number) <= 0 || (den as number) <= 0) return null;
  const r = (num as number) / (den as number);
  return r >= MIN_SAR && r <= MAX_SAR ? { num: num as number, den: den as number } : null;
}

/** The SAR as a number; 1 (square) when missing or not sane. */
export function sampleAspectRatio(s: unknown): number {
  const r = saneSar(s);
  return r ? r.num / r.den : 1;
}

/**
 * Display size of a probed video stream: the storage size un-squeezed by its SAR (wider for SAR > 1, taller for
 * SAR < 1). A missing or insane SAR counts as square. Null when the size is unknown.
 *
 * - 'element': what Chromium reports in videoWidth / videoHeight (the preview compositor's probe fallback). The
 *   storage x axis is stretched (the display y axis on a 90 / 270 stream), rounded to the nearest pixel.
 * - 'filter': what the export graph's first fitFilters scale produces after ffmpeg's autorotate, which transposes
 *   a 90 / 270 stream and inverts its SAR: the display axes with that inverted ratio, even sizes (at least 2),
 *   and a SAR within 1e-6 of 1 left alone (the filter expression's `gt(sar,1.000001)` / `lt(sar,0.999999)`).
 */
export function videoDisplaySize(v: VideoStreamInfo | undefined, mode: 'element' | 'filter'): { width: number; height: number } | null {
  if (!v || !(v.width > 0) || !(v.height > 0)) return null;
  const sar = sampleAspectRatio(v.sar);
  const rotated = v.rotation === 90 || v.rotation === 270;
  if (mode === 'filter') {
    const s = rotated ? 1 / sar : sar;
    const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);
    if (s > 1.000001) return { width: even(v.width * s), height: v.height };
    if (s < 0.999999) return { width: v.width, height: even(v.height / s) };
    return { width: v.width, height: v.height };
  }
  let w = rotated ? v.height : v.width, h = rotated ? v.width : v.height; // storage axes
  if (sar > 1) w = Math.round(w * sar); else if (sar < 1) h = Math.round(h / sar);
  return rotated ? { width: h, height: w } : { width: w, height: h };
}
