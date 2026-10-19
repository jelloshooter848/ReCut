/**
 * Shared renderer-side media infrastructure: one element pool, one AudioContext, one thumbnail/waveform cache.
 * Panels import these instead of creating their own so Compare mode and the Program monitor share decoders.
 */
import { MediaElementPool, ThumbnailCache, WaveformCache } from '@/playback';
import { onSourceLoadError } from '@/playback/sourcePlayer';
import { previewPlayable } from '@/playback/mediaSource';
import { markDirectDecodeFailed } from '@/playback/codecSupport';
import { useStore } from '@/state';

let pool: MediaElementPool | null = null;
let audioCtx: AudioContext | null = null;

export function getPool(): MediaElementPool {
  if (!pool) {
    pool = new MediaElementPool(16);
    pool.onError((err) => handleLoadError(err.path));
  }
  return pool;
}

/**
 * A "ready" proxy whose file was deleted / is unreadable makes its element fail (recut-media:// 404).
 * Forget the proxy so playback re-resolves to the original (when the browser can decode it) or reports
 * "needs proxy", and drop the cached elements / thumbnails for the dead path.
 */
export function handleLoadError(path: string): void {
  const st = useStore.getState();
  for (const m of Object.values(st.project.media)) {
    // An original previewed directly only because this machine's decoder supports it (HEVC, #138) failed to load:
    // preview it from a proxy from now on (previewPlayable checks directDecodeFailed).
    if (m.path === path && m.probe && !m.probe.browserPlayable && previewPlayable(m)) {
      markDirectDecodeFailed(path);
      invalidateMediaPath(path);
      st.toast('warning', `"${m.name}" could not be decoded directly on this machine; generate a proxy to preview it.`);
      continue;
    }
    if (m.proxy.status !== 'ready' || m.proxy.path !== path) continue;
    st.invalidateProxy(m.id);
    invalidateMediaPath(path);
    st.toast('warning', previewPlayable(m)
      ? `Proxy for "${m.name}" could not be loaded; playing the original.`
      : `Proxy for "${m.name}" could not be loaded; generate a new proxy to preview it.`);
  }
}
onSourceLoadError(handleLoadError);

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
