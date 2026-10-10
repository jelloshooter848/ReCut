/**
 * What this machine's Chromium can decode beyond the fixed list in shared/media.ts (#138): HEVC, which Chromium plays
 * through the platform decoder where there is one (macOS VideoToolbox; Windows with HEVC hardware / extensions; not
 * Linux). Asked once per session of the renderer; a direct HEVC file that then fails to load is remembered, and its
 * media falls back to a proxy (markDirectDecodeFailed, src/app/media.ts).
 */
import type { DecodeSupport } from '../../shared/media';

let support: DecodeSupport | null = null;
const failedPaths = new Set<string>();

function canDecode(type: string): boolean {
  try {
    const v = typeof document !== 'undefined' ? document.createElement('video') : null;
    const can = v ? v.canPlayType(type) : '';
    const mse = typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function' ? MediaSource.isTypeSupported(type) : false;
    return (can === 'probably' || can === 'maybe') && mse;
  } catch {
    return false;
  }
}

/** This machine's extra decode support; nothing extra outside a browser (tests, main). */
export function decodeSupport(): DecodeSupport {
  if (!support) {
    support = {
      hevcMain: canDecode('video/mp4; codecs="hvc1.1.6.L93.B0"'),
      hevcMain10: canDecode('video/mp4; codecs="hvc1.2.4.L153.B0"'),
    };
  }
  return support;
}

/** Tests: pretend this machine decodes `s` (null: ask the browser again). */
export function setDecodeSupportForTests(s: DecodeSupport | null): void { support = s; failedPaths.clear(); }

/** A file previewed directly thanks to decodeSupport failed to load: preview it from a proxy from now on. */
export function markDirectDecodeFailed(path: string): void { failedPaths.add(path); }

export function directDecodeFailed(path: string): boolean { return failedPaths.has(path); }
