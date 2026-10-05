/**
 * Inspector / Effect Controls. Context-sensitive by selection priority:
 * selected transition → selected clip(s) → selected media item(s) → active sequence.
 * Subscribes to ids only; each sub-inspector selects the objects it needs so unrelated store changes stay cheap.
 */
import React from 'react';
import type { PanelProps } from '../registry';
import { useStore } from '@/state';
import { ClipInspector } from './ClipInspector';
import { TransitionInspector } from './TransitionInspector';
import { MediaInspector } from './MediaInspector';
import { SequenceInspector } from './SequenceInspector';
import './inspector.css';

type Mode = 'transition' | 'clip' | 'media' | 'sequence' | 'none';

export function InspectorPanel({ active }: PanelProps) {
  const transitionId = useStore((s) => s.ui.selectedTransitionId);
  const clipIds = useStore((s) => s.ui.selectedClipIds);
  const mediaIds = useStore((s) => s.ui.selectedMediaIds);
  const seqId = useStore((s) => s.project.activeSequenceId);
  const fps = useStore((s) => (s.project.activeSequenceId ? s.project.sequences[s.project.activeSequenceId]?.fps : undefined)) ?? { num: 24000, den: 1001 };
  const contextName = useStore((s) => {
    if (seqId && s.ui.selectedTransitionId) return 'Transition';
    if (seqId && s.ui.selectedClipIds.length) return s.ui.selectedClipIds.length === 1 ? 'Clip' : `${s.ui.selectedClipIds.length} clips`;
    if (s.ui.selectedMediaIds.length) return s.ui.selectedMediaIds.length === 1 ? (s.project.media[s.ui.selectedMediaIds[0]]?.name ?? 'Media') : `${s.ui.selectedMediaIds.length} media items`;
    const seq = seqId ? s.project.sequences[seqId] : undefined;
    return seq?.name ?? 'No sequence';
  });

  // Hidden panels stay mounted; skip their subtree entirely so background edits do not re-render the inspector.
  if (!active) return <div className="panel insp" data-testid="inspector" data-mode="hidden" />;

  const mode: Mode = seqId && transitionId ? 'transition' : seqId && clipIds.length ? 'clip' : mediaIds.length ? 'media' : seqId ? 'sequence' : 'none';
  const kind = mode === 'transition' ? 'Transition' : mode === 'clip' ? 'Clip' : mode === 'media' ? 'Media' : 'Sequence';

  return (
    <div className="panel insp" data-testid="inspector" data-mode={mode}>
      <div className="insp-context">
        <span className="kind">{kind}</span>
        <span className="name" title={contextName}>{contextName}</span>
      </div>
      <div className="insp-body scroll-y">
        {mode === 'transition' && seqId && transitionId ? <TransitionInspector seqId={seqId} fps={fps} id={transitionId} /> : null}
        {mode === 'clip' && seqId ? <ClipInspector seqId={seqId} fps={fps} /> : null}
        {mode === 'media' ? <MediaInspector ids={mediaIds} /> : null}
        {mode === 'sequence' && seqId ? <SequenceInspector seqId={seqId} /> : null}
        {mode === 'none' ? <div className="insp-empty p-8">Nothing to inspect — create or open a sequence.</div> : null}
      </div>
    </div>
  );
}
