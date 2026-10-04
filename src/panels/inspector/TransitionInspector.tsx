/** Transition inspector: type, duration, alignment, the two clips at the cut and Remove. */
import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Trash2 } from 'lucide-react';
import type { ID, Rational, Transition, TransitionType } from '@shared/model';
import { addTransition as tlAddTransition, allTracks, clipEnd, findClip, removeTransition as tlRemoveTransition } from '@shared/timeline';
import { activeSequence, useStore } from '@/state';
import type { StoreState } from '@/state';
import { Button, NumberField, Select } from '@/components/ui';
import { Row, Section, Value, finish, framesLabel, tc, transient } from './primitives';
import { TRANSITION_LABEL } from './ClipInspector';

const VIDEO_TYPES: { value: TransitionType; label: string }[] = [
  { value: 'crossDissolve', label: TRANSITION_LABEL.crossDissolve },
  { value: 'dipToBlack', label: TRANSITION_LABEL.dipToBlack },
];
const AUDIO_TYPES: { value: TransitionType; label: string }[] = [{ value: 'audioCrossfade', label: TRANSITION_LABEL.audioCrossfade }];

export function TransitionInspector({ seqId, fps, id }: { seqId: ID; fps: Rational; id: ID }) {
  const loc = useStore(useShallow((s: StoreState) => {
    const seq = activeSequence(s);
    if (!seq) return { track: null, tr: null as Transition | null };
    for (const t of allTracks(seq)) { const tr = t.transitions.find((x) => x.id === id); if (tr) return { track: t, tr }; }
    return { track: null, tr: null as Transition | null };
  }));
  const outClip = useStore((s) => { const seq = activeSequence(s); return seq && loc.tr?.outClipId ? findClip(seq, loc.tr.outClipId)?.clip : undefined; });
  const inClip = useStore((s) => { const seq = activeSequence(s); return seq && loc.tr?.inClipId ? findClip(seq, loc.tr.inClipId)?.clip : undefined; });
  const removeTransition = useStore((s) => s.removeTransition);
  const selectTransition = useStore((s) => s.selectTransition);
  const select = useStore((s) => s.select);

  const { track, tr } = loc;
  if (!track || !tr) return <div className="insp-empty p-8">Transition no longer exists.</div>;

  const cut = outClip ? clipEnd(outClip) : inClip ? inClip.start : 0;
  const limit = Math.max(1, Math.min(outClip?.duration ?? Infinity, inClip?.duration ?? Infinity));
  const half = Math.floor(tr.duration / 2);
  const types = track.kind === 'audio' ? AUDIO_TYPES : VIDEO_TYPES;

  const changeType = (type: TransitionType) => {
    if (type === tr.type) return;
    let newId: ID | null = null;
    useStore.getState().commit('Change transition type', (d) => {
      const seq = d.sequences[seqId]; if (!seq) return;
      tlRemoveTransition(seq, tr.id);
      const made = tlAddTransition(seq, track.id, cut, type, tr.duration);
      newId = made?.id ?? null;
    });
    if (newId) selectTransition(newId);
  };

  return (
    <>
      <div className="insp-head" data-testid="transition-header">
        <div className="insp-title-row"><span className="grow text-bright" style={{ fontWeight: 600 }}>{TRANSITION_LABEL[tr.type]}</span><span className="badge dim">{track.kind}</span></div>
        <div className="insp-sub"><span>{track.name}</span><span className="text-faint">·</span><span className="mono">{tc(cut, fps)}</span></div>
      </div>
      <Section id="transition" title="Transition">
        <Row label="Type" prop="transition-type">
          <Select size="sm" value={tr.type} options={types} onChange={changeType} disabled={types.length === 1} />
        </Row>
        <Row label="Duration" prop="transition-duration" title={`1 – ${limit} frames (limited by the shorter clip)`}>
          <NumberField value={tr.duration} min={1} max={limit} unit="fr" title="Drag to scrub · click to type"
            onChange={(v) => transient((d) => { const seq = d.sequences[seqId]; if (!seq) return; const t = allTracks(seq).find((x) => x.id === track.id); const x = t?.transitions.find((y) => y.id === tr.id); if (x) x.duration = Math.max(1, Math.min(limit, Math.round(v))); })}
            onCommit={() => finish('Transition duration')} />
          <Value dim>{tc(tr.duration, fps)}</Value>
        </Row>
        <Row label="Alignment"><Value dim>Centered on cut</Value></Row>
        <Row label="Cut at"><Value copy={tc(cut, fps)}>{tc(cut, fps)}</Value></Row>
        <Row label="Range"><Value copy={`${tc(cut - half, fps)} → ${tc(cut - half + tr.duration, fps)}`}>{tc(cut - half, fps)}<span className="arrow">→</span>{tc(cut - half + tr.duration, fps)}</Value></Row>
        <Row label="Length"><Value>{framesLabel(tr.duration, fps)}</Value></Row>
      </Section>
      <Section id="transition-clips" title="Clips">
        <Row label="Outgoing">{outClip ? <Value onClick={() => select([outClip.id])} title="Select clip">{outClip.name}</Value> : <Value dim>{track.kind === 'audio' ? 'Silence' : 'Black'}</Value>}</Row>
        <Row label="Incoming">{inClip ? <Value onClick={() => select([inClip.id])} title="Select clip">{inClip.name}</Value> : <Value dim>{track.kind === 'audio' ? 'Silence' : 'Black'}</Value>}</Row>
        <Row label="Max length"><Value dim>{framesLabel(limit, fps)}</Value></Row>
        <div className="insp-btn-row mt-4">
          <Button size="sm" variant="danger" icon={Trash2} onClick={() => removeTransition(seqId, tr.id)} data-testid="remove-transition">Remove transition</Button>
        </div>
      </Section>
    </>
  );
}
