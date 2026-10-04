/**
 * Split the Program monitor's "cannot play" list by cause (E-07): offline files, files that need a proxy
 * (present but not decodable by Chromium) and anything else (decoder errors, unprobed media).
 */
import type { ID, MediaItem } from '@shared/model';
import type { MissingMedia } from '@/playback';

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
