/**
 * Split the Program monitor's "cannot play" list by cause (E-07): offline files, files that need a proxy
 * (present but not decodable by Chromium) and anything else (decoder errors, unprobed media).
 */
import type { ID, MediaItem, Sequence } from '@shared/model';
import type { MissingMedia } from '@/playback';
import { resolvePlaybackPath } from '@/playback/mediaSource';

/** Distinct media ids referenced by a sequence's clips (cached per sequence object). */
const mediaIdsCache = new WeakMap<Sequence, ID[]>();
function sequenceMediaIds(seq: Sequence): ID[] {
  let ids = mediaIdsCache.get(seq);
  if (ids) return ids;
  const set = new Set<ID>();
  for (const t of seq.videoTracks) for (const c of t.clips) if (c.enabled) set.add(c.mediaId);
  for (const t of seq.audioTracks) for (const c of t.clips) if (c.enabled) set.add(c.mediaId);
  ids = [...set];
  mediaIdsCache.set(seq, ids);
  return ids;
}

/**
 * One entry per distinct media FILE of the whole sequence that cannot be played (BUG-4: the chips counted clips at
 * the playhead). `getError(path)` reports decoder errors seen by the element pool; `atFrame` (the player's current
 * plan) is merged in so per-element failures under the playhead are never lost.
 */
export function sequenceMissing(seq: Sequence, media: Record<ID, MediaItem>, useProxies: boolean,
  getError: (path: string) => { message: string } | undefined, atFrame: readonly MissingMedia[] = []): MissingMedia[] {
  const out: MissingMedia[] = [];
  const seen = new Set<ID>();
  for (const id of sequenceMediaIds(seq)) {
    const m = media[id];
    if (!m) { seen.add(id); out.push({ clipId: '', mediaId: id, reason: 'media not in project' }); continue; }
    const res = resolvePlaybackPath(m, useProxies);
    if (!res.path) { seen.add(id); out.push({ clipId: '', mediaId: id, reason: res.reason ?? 'not playable' }); continue; }
    const err = getError(res.path);
    if (err) { seen.add(id); out.push({ clipId: '', mediaId: id, reason: err.message }); }
  }
  for (const m of atFrame) if (!seen.has(m.mediaId)) { seen.add(m.mediaId); out.push(m); }
  return out;
}

export interface MissingSplit {
  offline: number;
  needsProxy: number;
  other: number;
  /** Media that need a proxy and have none queued / running / ready (one-click Generate). */
  proxyMediaIds: ID[];
  /** Some needs-proxy media already have a proxy in progress. */
  proxyBusy: boolean;
}

export function classifyMissing(missing: readonly MissingMedia[], media: Record<ID, MediaItem>): MissingSplit {
  const out: MissingSplit = { offline: 0, needsProxy: 0, other: 0, proxyMediaIds: [], proxyBusy: false };
  const queued = new Set<ID>();
  for (const m of missing) {
    const item = media[m.mediaId];
    if (!item || item.offline) { out.offline++; continue; }
    if (item.probe && !item.probe.browserPlayable) {
      out.needsProxy++;
      const st = item.proxy.status;
      if (st === 'queued' || st === 'running') out.proxyBusy = true;
      else if (st !== 'ready' && !queued.has(item.id)) { queued.add(item.id); out.proxyMediaIds.push(item.id); }
      continue;
    }
    out.other++;
  }
  return out;
}
