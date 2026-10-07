/**
 * Sync of linked clips (Premiere's red "+N / −N" out-of-sync badge): used by the timeline badges
 * (src/panels/timeline/clipBadges.ts) and the Export dialog's checklist (src/panels/export/settings.ts). Pure.
 */
import type { Clip, ID, Rational, Track } from './model';

/** Timeline frame at which source time 0 of the clip would sit (fractional). Equal anchors = in sync. */
export function clipSyncAnchor(clip: Pick<Clip, 'start' | 'sourceIn' | 'speed'>, fps: Rational): number {
  const speed = clip.speed > 0 ? clip.speed : 1;
  return clip.start - (clip.sourceIn * fps.num) / fps.den / speed;
}

/**
 * Out-of-sync offsets for linked clips, keyed by clip id: `anchor(clip) − anchor(partner)` rounded to frames,
 * where the partner is the first linked clip of the other kind from the same media (video ↔ audio). Clips in
 * sync, unlinked, or without a partner are omitted. Only `clips` of each track is read.
 */
export function linkedSyncOffsets(tracks: readonly Pick<Track, 'clips'>[], fps: Rational): Map<ID, number> {
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

/** "+12" / "−12" (true minus sign) label for an offset in frames. */
export function formatSyncOffset(frames: number): string {
  return frames > 0 ? `+${frames}` : `−${Math.abs(frames)}`;
}
