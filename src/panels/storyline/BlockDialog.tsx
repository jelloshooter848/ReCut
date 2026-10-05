/**
 * Create / edit dialog for a story block (name, color, notes). Range is shown read-only; adjust it on the strip.
 */
import React, { useEffect, useState } from 'react';
import type { Rational, StoryBlock } from '@shared/model';
import { formatSequenceTimecode } from '@shared/time';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { ColorSwatchPicker, LABEL_COLORS } from '@/components/ui/ColorSwatch';
import { BLOCK_PRESET_NAMES, formatMS } from './util';

export type BlockDialogState =
  | { mode: 'create'; start: number; end: number }
  | { mode: 'edit'; block: StoryBlock };

export interface BlockDialogProps {
  state: BlockDialogState | null;
  fps: Rational;
  /** Suggested color for new blocks (cycles through the palette). */
  nextColor: string;
  onClose: () => void;
  onSubmit: (values: { name: string; color: string; notes: string }) => void;
}

export function BlockDialog({ state, fps, nextColor, onClose, onSubmit }: BlockDialogProps) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(nextColor);
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!state) return;
    if (state.mode === 'edit') { setName(state.block.name); setColor(state.block.color); setNotes(state.block.notes); }
    else { setName(''); setColor(nextColor); setNotes(''); }
  }, [state, nextColor]);

  if (!state) return null;
  const start = state.mode === 'create' ? state.start : state.block.start;
  const end = state.mode === 'create' ? state.end : state.block.end;
  const valid = name.trim().length > 0;
  const submit = () => { if (valid) onSubmit({ name: name.trim(), color, notes }); };

  return (
    <Dialog open title={state.mode === 'create' ? 'New story block' : 'Edit story block'} onClose={onClose} width={420}
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} data-testid="block-dialog-submit" onClick={submit}>{state.mode === 'create' ? 'Create' : 'Save'}</Button>
        </>
      )}>
      <div className="col gap-8" onKeyDown={(e) => { if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); submit(); } }}>
        <label className="col gap-4">
          <span className="text-dim text-sm">Name</span>
          <input className="input" value={name} autoFocus placeholder="e.g. Act I" data-testid="block-name" spellCheck={false} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="row gap-4" style={{ flexWrap: 'wrap' }}>
          {BLOCK_PRESET_NAMES.map((p) => (
            <button key={p} type="button" className={`tag ${name === p ? 'accent' : ''}`} style={{ cursor: 'default' }} onClick={() => setName(p)}>{p}</button>
          ))}
        </div>
        <div className="row gap-8">
          <span className="text-dim text-sm" style={{ width: 60 }}>Range</span>
          <span className="mono">{formatSequenceTimecode(start, fps)}</span>
          <span className="text-faint">→</span>
          <span className="mono">{formatSequenceTimecode(end, fps)}</span>
          <span className="text-dim mono">({formatMS(end - start, fps)})</span>
        </div>
        <div className="row gap-8">
          <span className="text-dim text-sm" style={{ width: 60 }}>Color</span>
          <ColorSwatchPicker value={color} size="lg" onChange={(hex) => setColor(hex)} />
          <span className="text-dim text-sm">{LABEL_COLORS.find((c) => c.hex.toLowerCase() === color.toLowerCase())?.name ?? color}</span>
        </div>
        <label className="col gap-4">
          <span className="text-dim text-sm">Notes</span>
          <textarea className="input" rows={3} value={notes} placeholder="Beats, intent, what to protect in this block…" onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
    </Dialog>
  );
}
