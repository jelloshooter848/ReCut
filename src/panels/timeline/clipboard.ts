/**
 * Module-level clip clipboard for the timeline (Cut / Copy / Paste). Clips remember which track index
 * (within their kind) they came from so a paste lands on the same tracks at the playhead.
 */
import type { Clip, ID, Sequence } from '@shared/model';
import { uid } from '@shared/ids';
import { allTracks } from '@shared/timeline';

interface Entry { clip: Clip; kind: 'video' | 'audio'; trackIndex: number }

let entries: Entry[] = [];

function plain<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

/** Copy the given clips (by id) from `seq`. Returns the number of clips captured. */
export function copyClipsToClipboard(seq: Sequence, ids: ID[]): number {
  const want = new Set(ids);
  const out: Entry[] = [];
  seq.videoTracks.forEach((t, i) => { for (const c of t.clips) if (want.has(c.id)) out.push({ clip: plain(c), kind: 'video', trackIndex: i }); });
  seq.audioTracks.forEach((t, i) => { for (const c of t.clips) if (want.has(c.id)) out.push({ clip: plain(c), kind: 'audio', trackIndex: i }); });
  if (out.length) entries = out;
  return out.length;
}

export function clipboardHasClips(): boolean { return entries.length > 0; }
export function clipboardCount(): number { return entries.length; }

/**
 * Build placements for pasting at `atFrame`: relative timing is preserved, ids and link ids are fresh,
 * tracks map to the same index within their kind (clamped to the last track).
 */
export function clipboardPlacements(seq: Sequence, atFrame: number): { trackId: ID; clip: Clip }[] {
  if (!entries.length) return [];
  const origin = Math.min(...entries.map((e) => e.clip.start));
  const links = new Map<ID, ID>();
  const out: { trackId: ID; clip: Clip }[] = [];
  for (const e of entries) {
    const list = e.kind === 'video' ? seq.videoTracks : seq.audioTracks;
    const track = list[Math.min(e.trackIndex, list.length - 1)];
    if (!track) continue;
    const clip = plain(e.clip);
    clip.id = uid('clip');
    clip.start = Math.max(0, atFrame + (e.clip.start - origin));
    if (clip.linkId) {
      let l = links.get(clip.linkId);
      if (!l) { l = uid('link'); links.set(clip.linkId, l); }
      clip.linkId = l;
    }
    out.push({ trackId: track.id, clip });
  }
  return out;
}

/** True when every id refers to a clip in the sequence (used to disable Cut/Copy when nothing is selected). */
export function clipsExist(seq: Sequence, ids: ID[]): boolean {
  if (!ids.length) return false;
  const have = new Set<ID>();
  for (const t of allTracks(seq)) for (const c of t.clips) have.add(c.id);
  return ids.every((id) => have.has(id));
}
