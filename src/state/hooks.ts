/**
 * Narrow React hooks over the store. Playhead / scroll are mutated in place on `sequence.view` (see setView),
 * so components must select these primitives rather than reading them off a selected sequence object.
 */
import { useStore } from './store';
import type { StoreState } from './types';

const seqView = (s: StoreState, seqId?: string) => {
  const id = seqId ?? s.project.activeSequenceId;
  return id ? s.project.sequences[id]?.view : undefined;
};

/** Current playhead (frames) of `seqId`, or of the active sequence when omitted. 0 when there is none. */
export function usePlayhead(seqId?: string): number {
  return useStore((s) => seqView(s, seqId)?.playhead ?? 0);
}

/** Current horizontal scroll (frames) of `seqId`, or of the active sequence when omitted. */
export function useViewScroll(seqId?: string): number {
  return useStore((s) => seqView(s, seqId)?.scroll ?? 0);
}
