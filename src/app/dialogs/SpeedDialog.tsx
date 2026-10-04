/** Clip speed / duration dialog (Ctrl+R). Applies `setClipSpeed` to the selected clips (one call per link group). */
import React, { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { NumberField } from '@/components/ui/NumberField';
import { Toggle } from '@/components/ui/Toggle';
import { useStore } from '@/state/store';
import { activeSequence, selectedClips } from '@/state/selectors';
import { formatTimecode } from '@shared/time';
import { toast } from '@/components/ui/toastStore';

interface SpeedDialogState { open: boolean; setOpen(open: boolean): void }
export const useSpeedDialog = create<SpeedDialogState>()((set) => ({ open: false, setOpen: (open) => set({ open }) }));
export function openSpeedDialog(): void { useSpeedDialog.getState().setOpen(true); }
export function closeSpeedDialog(): void { useSpeedDialog.getState().setOpen(false); }

export function SpeedDialog() {
  const open = useSpeedDialog((s) => s.open);
  const seq = useStore((s) => activeSequence(s));
  const selectedIds = useStore((s) => s.ui.selectedClipIds);
  // Selectors must return stable references; derive the clip list from the (stable) sequence + id array.
  const clips = useMemo(() => (open ? selectedClips(useStore.getState()) : []), [open, seq, selectedIds]);
  const [percent, setPercent] = useState(100);
  const [ripple, setRipple] = useState(false);
  useEffect(() => { if (open) setPercent(Math.round((clips[0]?.speed ?? 1) * 1000) / 10); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null;
  const first = clips[0];
  const newDuration = first && seq ? Math.max(1, Math.round(first.duration * first.speed / (percent / 100))) : 0;
  const apply = () => {
    if (!seq || !clips.length) { closeSpeedDialog(); return; }
    const speed = percent / 100;
    if (!(speed > 0)) { toast('warn', 'Speed must be greater than 0%'); return; }
    const seen = new Set<string>();
    for (const c of clips) {
      const key = c.linkId ?? c.id;
      if (seen.has(key)) continue;
      seen.add(key);
      useStore.getState().setClipSpeed(seq.id, c.id, speed, { ripple });
    }
    closeSpeedDialog();
  };
  return (
    <Dialog open title="Clip Speed / Duration" onClose={closeSpeedDialog} width={380}
      footer={<><Button onClick={closeSpeedDialog}>Cancel</Button><Button variant="primary" onClick={apply} disabled={!clips.length}>Apply</Button></>}>
      <div className="col" style={{ gap: 10 }}>
        {!clips.length ? <div className="text-dim">Select one or more clips first.</div> : null}
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <label className="text-dim" style={{ width: 90 }}>Speed</label>
          <NumberField value={percent} onChange={setPercent} min={1} max={10000} step={1} precision={1} unit="%" />
        </div>
        {first && seq ? (
          <div className="row" style={{ gap: 8 }}>
            <label className="text-dim" style={{ width: 90 }}>Duration</label>
            <span className="mono">{formatTimecode(newDuration, seq.fps)}</span>
            <span className="text-faint text-sm">(was {formatTimecode(first.duration, seq.fps)})</span>
          </div>
        ) : null}
        <Toggle checked={ripple} onChange={setRipple} label="Ripple edit, shifting trailing clips" />
        {clips.length > 1 ? <div className="text-faint text-sm">Applies to {clips.length} selected clips.</div> : null}
      </div>
    </Dialog>
  );
}
