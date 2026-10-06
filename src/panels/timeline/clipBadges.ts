/**
 * Pure helpers behind the timeline clip badges: linked-partner sync offsets (Premiere's red "+N / −N") and
 * "needs a proxy" status for media Chromium cannot decode.
 */
import type { Clip, ID, MediaItem, Rational, Track } from '@shared/model';
import { mediaNeedsProxyForPreview } from '@/playback/mediaSource';

/** Timeline frame at which source time 0 of the clip would sit (fractional). Equal anchors = in sync. */
export function clipSyncAnchor(clip: Pick<Clip, 'start' | 'sourceIn' | 'speed'>, fps: Rational): number {
  const speed = clip.speed > 0 ? clip.speed : 1;
  return clip.start - (clip.sourceIn * fps.num) / fps.den / speed;
}

/**
 * Out-of-sync offsets for linked clips, keyed by clip id: `anchor(clip) − anchor(partner)` rounded to frames,
 * where the partner is the first linked clip of the other kind from the same media (video ↔ audio). Clips in
 * sync, unlinked, or without a partner are omitted.
 */
export function linkedSyncOffsets(tracks: readonly Track[], fps: Rational): Map<ID, number> {
  const groups = new Map<ID, Clip[]>();
  for (const t of tracks) for (const c of t.clips) {
    if (!c.linkId) continue;
    const g = groups.get(c.linkId);
    if (g) g.push(c); else groups.set(c.linkId, [c]);
  }
  const out = new Map<ID, number>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    for (const c of g) {
      const partner = g.find((o) => o !== c && o.kind !== c.kind && o.mediaId === c.mediaId);
      if (!partner) continue;
      const off = Math.round(clipSyncAnchor(c, fps) - clipSyncAnchor(partner, fps));
      if (off !== 0) out.set(c.id, off);
    }
  }
  return out;
}

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

/** "+12" / "−12" (true minus sign) label for an offset in frames. */
export function formatSyncOffset(frames: number): string {
  return frames > 0 ? `+${frames}` : `−${Math.abs(frames)}`;
}

/** Media that Chromium cannot decode and that has no usable proxy yet (amber PROXY badge). */
export function mediaNeedsProxy(m: MediaItem | undefined): boolean {
  return mediaNeedsProxyForPreview(m) && m!.proxy.status !== 'ready';
}
