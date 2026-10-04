/**
 * Insert / Overwrite the Source Monitor's marked range into the active sequence at its playhead, then advance the
 * playhead to the end of the inserted range (Premiere behaviour). Usable from the panel and from global commands.
 */
import { useStore } from '@/state';
import { toast } from '@/components/ui/toastStore';

/** Nominal duration for still images (no intrinsic length). */
export const IMAGE_DURATION = 5;

export interface InsertSourceResult { ok: boolean; clipIds: string[]; endFrame: number | null; reason?: string }

export function insertSourceIntoSequence(mode: 'insert' | 'overwrite', opts: { duration?: number; quiet?: boolean } = {}): InsertSourceResult {
  const st = useStore.getState();
  const sc = st.ui.sourceClip;
  const m = sc ? st.project.media[sc.mediaId] : undefined;
  const seqId = st.project.activeSequenceId;
  const seq = seqId ? st.project.sequences[seqId] : undefined;
  const fail = (reason: string, kind: 'warn' | 'error' = 'warn'): InsertSourceResult => { if (!opts.quiet) toast(kind, reason); return { ok: false, clipIds: [], endFrame: null, reason }; };
  if (!sc || !m) return fail('No source clip loaded');
  if (!seq || !seqId) return fail('No active sequence');
  const mediaDur = opts.duration ?? (m.kind === 'image' ? IMAGE_DURATION : m.probe?.duration ?? 0);
  const inS = sc.inPoint ?? 0;
  const outS = sc.outPoint ?? (Number.isFinite(mediaDur) && mediaDur > 0 ? mediaDur : inS + IMAGE_DURATION);
  if (!(outS > inS)) return fail('In/Out range is empty');
  const at = seq.view.playhead;
  const ids = st.insertFromSource(seqId, { mediaId: m.id, in: inS, out: outS, atFrame: at, mode });
  if (ids.length === 0) return fail(`${mode === 'insert' ? 'Insert' : 'Overwrite'} failed — target tracks may be locked`, 'error');
  const after = useStore.getState().project.sequences[seqId];
  let end = at;
  if (after) for (const t of [...after.videoTracks, ...after.audioTracks]) for (const c of t.clips) if (ids.includes(c.id)) end = Math.max(end, c.start + c.duration);
  useStore.getState().setView(seqId, { playhead: end });
  return { ok: true, clipIds: ids, endFrame: end };
}
