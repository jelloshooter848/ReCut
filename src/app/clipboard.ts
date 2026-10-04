/**
 * The one clip clipboard (Cut / Copy / Paste), shared by the global Edit-menu commands (src/app/commands.ts) and
 * the Timeline panel's key handling and context menus. Entries remember their source track (id and index within
 * the kind) so a paste lands on the same tracks — by id, else by kind + index, else the first unlocked track — at
 * the target frame, with relative timing preserved and fresh clip / link ids.
 */
import type { Clip, ID, Sequence } from '@shared/model';
import { uid } from '@shared/ids';
import { useStore } from '@/state/store';

export interface ClipboardEntry { clip: Clip; trackId: ID; trackKind: 'video' | 'audio'; trackIndex: number }
export interface ClipClipboard { entries: ClipboardEntry[]; origin: number; sequenceId: ID }

let clipboard: ClipClipboard | null = null;

function plain<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

export function getClipboard(): ClipClipboard | null { return clipboard; }
export function setClipboard(c: ClipClipboard | null): void { clipboard = c; }
export function clipboardHasClips(): boolean { return (clipboard?.entries.length ?? 0) > 0; }
export function clipboardCount(): number { return clipboard?.entries.length ?? 0; }

/** Copy the given clips (by id) from `seq`. Returns the number captured; the clipboard is untouched when it is 0. */
export function copyClipsToClipboard(seq: Sequence, ids: ID[]): number {
  const want = new Set(ids);
  const entries: ClipboardEntry[] = [];
  seq.videoTracks.forEach((t, i) => { for (const c of t.clips) if (want.has(c.id)) entries.push({ clip: plain(c), trackId: t.id, trackKind: 'video', trackIndex: i }); });
  seq.audioTracks.forEach((t, i) => { for (const c of t.clips) if (want.has(c.id)) entries.push({ clip: plain(c), trackId: t.id, trackKind: 'audio', trackIndex: i }); });
  if (entries.length) clipboard = { entries, origin: Math.min(...entries.map((e) => e.clip.start)), sequenceId: seq.id };
  return entries.length;
}

/** Build placements for pasting at `atFrame` into `seq` (locked targets are skipped). */
export function clipboardPlacements(seq: Sequence, atFrame: number): { trackId: ID; clip: Clip }[] {
  if (!clipboard?.entries.length) return [];
  const links = new Map<ID, ID>();
  const out: { trackId: ID; clip: Clip }[] = [];
  for (const e of clipboard.entries) {
    const list = e.trackKind === 'video' ? seq.videoTracks : seq.audioTracks;
    const track = list.find((t) => t.id === e.trackId && !t.locked) ?? list[Math.min(e.trackIndex, list.length - 1)] ?? list.find((t) => !t.locked);
    if (!track || track.locked) continue;
    const clip = plain(e.clip);
    clip.id = uid('clip');
    clip.start = Math.max(0, Math.round(atFrame + (e.clip.start - clipboard.origin)));
    if (clip.linkId) {
      let l = links.get(clip.linkId);
      if (!l) { l = uid('link'); links.set(clip.linkId, l); }
      clip.linkId = l;
    }
    out.push({ trackId: track.id, clip });
  }
  return out;
}

/** Paste the clipboard at `frame` (overwrite). Returns the new clip ids ([] when nothing could be placed). */
export function pasteClipboardAt(seq: Sequence, frame: number): ID[] {
  const placements = clipboardPlacements(seq, frame);
  if (!placements.length) return [];
  const ok = useStore.getState().placeClipsAction(seq.id, placements, 'overwrite');
  return ok ? placements.map((p) => p.clip.id) : [];
}
