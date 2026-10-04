/**
 * Shared renderer-side media infrastructure: one element pool, one AudioContext, one thumbnail/waveform cache.
 * Panels import these instead of creating their own so Compare mode and the Program monitor share decoders.
 */
import { MediaElementPool, ThumbnailCache, WaveformCache } from '@/playback';

let pool: MediaElementPool | null = null;
let audioCtx: AudioContext | null = null;

export function getPool(): MediaElementPool {
  if (!pool) pool = new MediaElementPool(16);
  return pool;
}

/** Lazily created; call resumeAudio() from a user gesture before playback. */
export function getAudioContext(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  if (!audioCtx) audioCtx = new AudioContext({ latencyHint: 'interactive' });
  return audioCtx;
}

export async function resumeAudio(): Promise<void> {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* ignore */ } }
}

export const thumbs = new ThumbnailCache(3000);
export const waves = new WaveformCache();

/** Call when a media file's playable path changed (proxy finished, relinked) so elements reload. */
export function invalidateMediaPath(path: string): void {
  pool?.releasePath(path);
  thumbs.invalidate(path);
  waves.invalidate(path);
}
