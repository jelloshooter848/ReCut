/**
 * Whether FFmpeg / FFprobe were found at startup (from window.recut.appInfo()). `missing` is null until known, so
 * unit tests and the browser-only renderer never block on it. Import / proxy / export check it to fail with a clear
 * message instead of an opaque IPC error, and the startup banner renders from it.
 */
import { create } from 'zustand';
import { ffmpegMissingMessage, type AppInfo } from '../../shared/ipc';

export type FfBinaryName = 'ffmpeg' | 'ffprobe';

export interface FfmpegStatusState {
  /** Binaries that were not found; null while unknown. */
  missing: FfBinaryName[] | null;
}

export const useFfmpegStatus = create<FfmpegStatusState>()(() => ({ missing: null }));

export function setFfmpegAvailability(info: Pick<AppInfo, 'ffmpegPath' | 'ffprobePath'> | null): void {
  if (!info) { useFfmpegStatus.setState({ missing: null }); return; }
  const missing: FfBinaryName[] = [];
  if (!info.ffmpegPath) missing.push('ffmpeg');
  if (!info.ffprobePath) missing.push('ffprobe');
  useFfmpegStatus.setState({ missing });
}

/** The clear "install FFmpeg" error when one of `needs` is known to be missing, else null. */
export function ffmpegUnavailable(...needs: FfBinaryName[]): string | null {
  const missing = useFfmpegStatus.getState().missing;
  if (!missing) return null;
  const hit = needs.find((n) => missing.includes(n));
  return hit ? ffmpegMissingMessage(hit) : null;
}
