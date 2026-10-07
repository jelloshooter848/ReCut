/**
 * Pure helpers behind the timeline clip badges: linked-partner sync offsets (Premiere's red "+N / −N", computed in
 * shared/linkSync.ts, which the Export dialog's checklist uses too) and "needs a proxy" status for media Chromium
 * cannot decode.
 */
import type { ID, MediaItem, Track } from '@shared/model';
import { mediaNeedsProxyForPreview } from '@/playback/mediaSource';

export { clipSyncAnchor, formatSyncOffset, linkedSyncOffsets } from '@shared/linkSync';

/**
 * Split clip-id -> offset into one map per track, reusing the previous per-track map when its content is unchanged,
 * so an edit on one track does not hand every other lane a new `syncOffsets` prop.
 */
export function syncOffsetsByTrack(tracks: readonly Track[], all: ReadonlyMap<ID, number>, prev: ReadonlyMap<ID, ReadonlyMap<ID, number>> | null): Map<ID, ReadonlyMap<ID, number>> {
  const out = new Map<ID, ReadonlyMap<ID, number>>();
  if (all.size === 0) return out;
  for (const t of tracks) {
    let m: Map<ID, number> | null = null;
    for (const c of t.clips) { const off = all.get(c.id); if (off !== undefined) (m ??= new Map()).set(c.id, off); }
    if (!m) continue;
    const old = prev?.get(t.id);
    if (old && old.size === m.size) {
      let same = true;
      for (const [k, v] of m) if (old.get(k) !== v) { same = false; break; }
      if (same) { out.set(t.id, old); continue; }
    }
    out.set(t.id, m);
  }
  return out;
}

/** Media that Chromium cannot decode and that has no usable proxy yet (amber PROXY badge). */
export function mediaNeedsProxy(m: MediaItem | undefined): boolean {
  return mediaNeedsProxyForPreview(m) && m!.proxy.status !== 'ready';
}
