/**
 * The one Source → sequence edit implementation, shared by the `,` / `.` commands, the Source monitor's
 * Insert / Overwrite buttons and drags from the Source monitor onto the Timeline.
 *
 *  - Three-point editing (see threePoint.ts): sequence In/Out + source In/Out decide target and duration.
 *  - Keyboard / button edits then move the playhead to the end of the new material and clear sequence In/Out.
 *  - First edit into an EMPTY sequence whose frame rate / size differ from the clip asks (once per sequence)
 *    "Change sequence to match clip?" and conforms the sequence before inserting.
 */
import type { ID, MediaItem, Sequence } from '@shared/model';
import { fpsEquals, fpsLabel, isValidFps } from '@shared/time';
import { sequenceDuration } from '@shared/timeline';
import { useStore } from '@/state';
import type { InsertFromSourceOptions } from '@/state/types';
import { toast } from '@/components/ui/toastStore';
import { confirmInApp } from '@/app/dialogs/ConfirmDialog';
import { resolveThreePointEdit, type ThreePointResult } from './threePoint';

/** Nominal duration for still images (no intrinsic length). */
export const IMAGE_DURATION = 5;

export interface InsertSourceResult { ok: boolean; clipIds: string[]; endFrame: number | null; reason?: string; /** A conform prompt is open; the edit runs after it. */ pending?: boolean }

export interface SourceEditRequest {
  mode: 'insert' | 'overwrite';
  mediaId: ID;
  /** Source marks in seconds (null = unset). */
  srcIn: number | null;
  srcOut: number | null;
  /** Media length override in seconds (the Source player's measured duration). */
  duration?: number;
  /** Explicit target frame (drag & drop). Sequence In/Out are ignored and the playhead stays put. */
  at?: number;
  videoTrackId?: ID;
  audioTrackId?: ID;
  /** Drag and drop: the other kind goes on its track at the drop row's index (#120). */
  videoTrackIndex?: number;
  audioTrackIndex?: number;
  includeVideo?: boolean;
  includeAudio?: boolean;
  extra?: InsertFromSourceOptions['extra'];
  quiet?: boolean;
}

function mediaLength(m: MediaItem, override?: number): number {
  if (m.kind === 'image') return Infinity;
  const d = override ?? m.probe?.duration ?? 0;
  return Number.isFinite(d) && d > 0 ? d : 0;
}

// ------------------------------------------------------------------ conform prompt

/** Per-sequence answer to the conform prompt (session memory). */
const conformAnswers = new Map<ID, 'change' | 'keep'>();
export function resetConformMemory(): void { conformAnswers.clear(); }

export interface ConformTarget { fps: Sequence['fps']; width: number; height: number }

/** Settings the sequence should change to for `media`, or null when it already matches / nothing to match (unknown or unusable rate / size). */
export function conformTargetFor(seq: Sequence, media: MediaItem | undefined): ConformTarget | null {
  const v = media?.probe?.video;
  if (!media || media.kind !== 'video' || !v || !Number.isSafeInteger(v.width) || !(v.width > 0) || !Number.isSafeInteger(v.height) || !(v.height > 0) || !isValidFps(v.fps)) return null;
  if (sequenceDuration(seq) > 0) return null;
  if (fpsEquals(seq.fps, v.fps) && seq.width === v.width && seq.height === v.height) return null;
  return { fps: { num: v.fps.num, den: v.fps.den }, width: v.width, height: v.height };
}

function applyConform(seqId: ID, target: ConformTarget): void {
  useStore.getState().updateSequenceSettings(seqId, { fps: target.fps, width: target.width, height: target.height });
}

/**
 * Before the first edit into an empty sequence: returns null when the edit can proceed synchronously, else a
 * promise that resolves once the user answered (and the sequence was conformed when they chose Change).
 */
export function maybeConformSequence(seqId: ID, mediaId: ID): Promise<void> | null {
  const st = useStore.getState();
  const seq = st.project.sequences[seqId];
  const target = seq ? conformTargetFor(seq, st.project.media[mediaId]) : null;
  if (!seq || !target) return null;
  const remembered = conformAnswers.get(seqId);
  if (remembered === 'keep') return null;
  if (remembered === 'change') { applyConform(seqId, target); return null; }
  const desc = `${fpsLabel(target.fps)} fps, ${target.width}×${target.height}`;
  return confirmInApp({
    title: 'Timeline settings',
    message: `Change timeline to match clip (${desc})?`,
    detail: `“${seq.name}” is ${fpsLabel(seq.fps)} fps, ${seq.width}×${seq.height}. Matching avoids frame-rate conversion on preview and export.`,
    buttons: ['Change', 'Keep'], defaultId: 0, cancelId: 1, testId: 'conform-dialog', buttonTestIds: ['conform-change', 'conform-keep'],
  }).then((i) => {
    const answer = i === 0 ? 'change' : 'keep';
    conformAnswers.set(seqId, answer);
    if (answer === 'change' && useStore.getState().project.sequences[seqId]) applyConform(seqId, target);
  });
}

// ------------------------------------------------------------------ edit

/** Resolve a request against the current sequence marks (exported for the Source monitor's range readout). */
export function resolveSourceEdit(seq: Sequence, media: MediaItem, req: Pick<SourceEditRequest, 'srcIn' | 'srcOut' | 'duration' | 'at'>): ThreePointResult {
  const explicit = req.at !== undefined;
  return resolveThreePointEdit({
    fps: seq.fps, playhead: seq.view.playhead,
    seqIn: explicit ? Math.max(0, Math.round(req.at!)) : seq.view.inPoint,
    seqOut: explicit ? null : seq.view.outPoint,
    srcIn: req.srcIn, srcOut: req.srcOut,
    mediaDuration: mediaLength(media, req.duration) || Infinity,
    // Stills and not-yet-probed media have no intrinsic length.
    defaultLength: IMAGE_DURATION,
  });
}

function runEdit(seqId: ID, req: SourceEditRequest): InsertSourceResult {
  const st = useStore.getState();
  const seq = st.project.sequences[seqId];
  const m = st.project.media[req.mediaId];
  const fail = (reason: string, kind: 'info' | 'warn' | 'error' = 'warn'): InsertSourceResult => { if (!req.quiet) toast(kind, reason); return { ok: false, clipIds: [], endFrame: null, reason }; };
  if (!seq) return fail('No active timeline');
  if (!m) return fail('No source clip loaded');
  const r = resolveSourceEdit(seq, m, req);
  if (!r.ok) return fail(r.reason, 'info');
  const ids = st.insertFromSource(seqId, {
    mediaId: m.id, in: r.inS, out: r.outS, atFrame: r.atFrame, mode: req.mode,
    videoTrackId: req.videoTrackId, audioTrackId: req.audioTrackId, videoTrackIndex: req.videoTrackIndex, audioTrackIndex: req.audioTrackIndex, includeVideo: req.includeVideo, includeAudio: req.includeAudio, extra: req.extra,
  });
  if (ids.length === 0) return fail(`${req.mode === 'insert' ? 'Insert' : 'Overwrite'} failed — target tracks may be locked`, 'error');
  const after = useStore.getState().project.sequences[seqId];
  let end = r.atFrame;
  if (after) for (const t of [...after.videoTracks, ...after.audioTracks]) for (const c of t.clips) if (ids.includes(c.id)) end = Math.max(end, c.start + c.duration);
  if (req.at === undefined) useStore.getState().setView(seqId, { playhead: end, inPoint: null, outPoint: null });
  if (!req.quiet) {
    if (r.notes.includes('seqOutIgnored')) toast('info', 'Timeline Out ignored — source In/Out set the duration');
    if (r.notes.includes('sourceTooShort')) toast('warn', 'Source media is shorter than the marked timeline range');
  }
  return { ok: true, clipIds: ids, endFrame: end };
}

/** Run a Source → sequence edit into `seqId` (active sequence by default). */
export function performSourceEdit(req: SourceEditRequest, seqId: ID | null = useStore.getState().project.activeSequenceId): InsertSourceResult {
  if (!seqId || !useStore.getState().project.sequences[seqId]) {
    if (!req.quiet) toast('warn', 'No active timeline');
    return { ok: false, clipIds: [], endFrame: null, reason: 'No active timeline' };
  }
  const pending = maybeConformSequence(seqId, req.mediaId);
  if (pending) {
    void pending.then(() => runEdit(seqId, req));
    return { ok: true, clipIds: [], endFrame: null, pending: true };
  }
  return runEdit(seqId, req);
}

/** Insert / Overwrite the Source monitor's marked range (three-point rules) into the active sequence. */
export function insertSourceIntoSequence(mode: 'insert' | 'overwrite', opts: { duration?: number; quiet?: boolean } = {}): InsertSourceResult {
  const st = useStore.getState();
  const sc = st.ui.sourceClip;
  const m = sc ? st.project.media[sc.mediaId] : undefined;
  if (!sc || !m) {
    if (!opts.quiet) toast('info', 'Open a clip in the Source monitor first');
    return { ok: false, clipIds: [], endFrame: null, reason: 'No source clip loaded' };
  }
  return performSourceEdit({ mode, mediaId: m.id, srcIn: sc.inPoint, srcOut: sc.outPoint, duration: opts.duration, quiet: opts.quiet });
}
