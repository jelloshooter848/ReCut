/**
 * New Sequence dialog (bound to ui.dialogs.newSequence) — also reused in edit mode for "Sequence Settings…".
 */
import React, { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { Select } from '@/components/ui/Select';
import { NumberField } from '@/components/ui/NumberField';
import { useStore } from '@/state/store';
import { activeSequence } from '@/state/selectors';
import { createSequence } from '@shared/project';
import { FPS_PRESETS, fpsEquals, fpsLabel } from '@shared/time';
import type { ID, Rational, Sequence } from '@shared/model';
import { toast } from '@/components/ui/toastStore';

export const RESOLUTION_PRESETS: { id: string; label: string; width: number; height: number }[] = [
  { id: '1080p', label: '1080p (1920×1080)', width: 1920, height: 1080 },
  { id: '2160p', label: '4K UHD (3840×2160)', width: 3840, height: 2160 },
  { id: '720p', label: '720p (1280×720)', width: 1280, height: 720 },
  { id: 'custom', label: 'Custom…', width: 0, height: 0 },
];
const SAMPLE_RATES = [{ value: '48000', label: '48 kHz' }, { value: '44100', label: '44.1 kHz' }, { value: '96000', label: '96 kHz' }];
const CHANNELS = [{ value: '2', label: 'Stereo' }, { value: '6', label: '5.1 Surround' }];

interface SeqDialogState { editSequenceId: ID | null; openEdit(id: ID): void; closeEdit(): void }
const useSeqDialog = create<SeqDialogState>()((set) => ({ editSequenceId: null, openEdit: (id) => set({ editSequenceId: id }), closeEdit: () => set({ editSequenceId: null }) }));

/** Open the dialog: `mode: 'new'` (same as store.openDialog('newSequence')) or `mode: 'edit'` for an existing sequence. */
export function openSequenceDialog(opts: { mode: 'new' } | { mode: 'edit'; sequenceId: ID }): void {
  if (opts.mode === 'edit') useSeqDialog.getState().openEdit(opts.sequenceId);
  else useStore.getState().openDialog('newSequence');
}

function presetForFps(fps: Rational): string {
  const p = FPS_PRESETS.find((x) => fpsEquals(x.fps, fps));
  return p ? p.label : 'custom';
}
function presetForSize(w: number, h: number): string {
  return RESOLUTION_PRESETS.find((p) => p.width === w && p.height === h)?.id ?? 'custom';
}

interface FormState { name: string; fps: Rational; width: number; height: number; sampleRate: number; channels: number }

function initialForm(edit: Sequence | null, count: number): FormState {
  if (edit) return { name: edit.name, fps: edit.fps, width: edit.width, height: edit.height, sampleRate: edit.sampleRate, channels: edit.channels };
  return { name: `Sequence ${String(count + 1).padStart(2, '0')}`, fps: { num: 24000, den: 1001 }, width: 1920, height: 1080, sampleRate: 48000, channels: 2 };
}

export function NewSequenceDialog() {
  const storeOpen = useStore((s) => s.ui.dialogs.newSequence);
  const editId = useSeqDialog((s) => s.editSequenceId);
  const editSeq = useStore((s) => (editId ? s.project.sequences[editId] ?? null : null));
  const count = useStore((s) => s.project.sequenceOrder.length);
  const open = storeOpen || !!editSeq;
  const [form, setForm] = useState<FormState>(() => initialForm(null, 0));
  const [customFps, setCustomFps] = useState(false);

  useEffect(() => {
    if (open) { setForm(initialForm(editSeq, count)); setCustomFps(editSeq ? presetForFps(editSeq.fps) === 'custom' : false); }
  }, [open, editId]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => { useStore.getState().closeDialog('newSequence'); useSeqDialog.getState().closeEdit(); };

  const fpsOptions = useMemo(() => [...FPS_PRESETS.map((p) => ({ value: p.label, label: `${p.label} fps` })), { value: 'custom', label: 'Custom…' }], []);
  const fpsPreset = customFps ? 'custom' : presetForFps(form.fps);
  const sizePreset = presetForSize(form.width, form.height);

  const matchMedia = () => {
    const st = useStore.getState();
    const id = st.ui.selectedMediaIds[0] ?? st.ui.sourceClip?.mediaId ?? (editSeq ? undefined : undefined);
    const media = id ? st.project.media[id] : undefined;
    if (!media?.probe) { toast('info', 'Select a probed media item in the Project panel first'); return; }
    const p = media.probe;
    const v = p.video;
    const audioCh = Math.max(0, ...p.audio.map((a) => a.channels));
    setForm((f) => ({
      ...f,
      fps: v ? (v.isVfr ? v.avgFps : v.fps) : f.fps,
      width: v?.width ?? f.width,
      height: v?.height ?? f.height,
      sampleRate: p.audio[0]?.sampleRate ?? f.sampleRate,
      channels: audioCh >= 6 ? 6 : 2,
    }));
    setCustomFps(false);
    if (!form.name.trim() || /^Sequence \d+$/.test(form.name)) setForm((f) => ({ ...f, name: media.name.replace(/\.[^.]+$/, '') }));
  };

  const submit = () => {
    const name = form.name.trim() || 'Sequence';
    const width = Math.max(16, Math.round(form.width)); const height = Math.max(16, Math.round(form.height));
    const st = useStore.getState();
    if (editSeq) {
      st.updateSequenceSettings(editSeq.id, { name, fps: form.fps, width, height, sampleRate: form.sampleRate, channels: form.channels });
    } else {
      const seq = createSequence(name, form.fps, width, height);
      seq.sampleRate = form.sampleRate; seq.channels = form.channels;
      st.addSequence(seq, { activate: true });
      toast('ok', `Created ${name}`);
    }
    close();
  };

  if (!open) return null;
  const row = (label: string, control: React.ReactNode) => (
    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
      <label className="text-dim" style={{ width: 110, flexShrink: 0 }}>{label}</label>
      <div className="grow row" style={{ gap: 6, minWidth: 0 }}>{control}</div>
    </div>
  );
  return (
    <Dialog open title={editSeq ? 'Sequence Settings' : 'New Sequence'} onClose={close} width={460} className="new-sequence-dialog" onSubmit={submit}
      footer={<>
        <Button onClick={matchMedia} title="Fill settings from the selected media item">Match Media</Button>
        <span className="grow" />
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" onClick={submit} data-testid="sequence-dialog-ok">{editSeq ? 'Apply' : 'Create'}</Button>
      </>}>
      <form className="col" style={{ gap: 10 }} data-testid="sequence-dialog" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {row('Name', <TextField autoFocus selectOnFocus value={form.name} onChange={(name) => setForm((f) => ({ ...f, name }))} />)}
        {row('Frame rate', <>
          <Select value={fpsPreset} options={fpsOptions} onChange={(v) => {
            if (v === 'custom') { setCustomFps(true); return; }
            const p = FPS_PRESETS.find((x) => x.label === v); if (p) { setCustomFps(false); setForm((f) => ({ ...f, fps: p.fps })); }
          }} />
          {fpsPreset === 'custom' ? (
            <NumberField value={Math.round((form.fps.num / form.fps.den) * 1000) / 1000} precision={3} min={1} max={240} step={1} unit="fps"
              onChange={(v) => setForm((f) => ({ ...f, fps: Number.isInteger(v) ? { num: v, den: 1 } : { num: Math.round(v * 1000), den: 1000 } }))} />
          ) : <span className="text-faint text-sm mono">{form.fps.num}/{form.fps.den}</span>}
        </>)}
        {row('Resolution', <>
          <Select value={sizePreset} options={RESOLUTION_PRESETS.map((p) => ({ value: p.id, label: p.label }))} onChange={(v) => {
            const p = RESOLUTION_PRESETS.find((x) => x.id === v);
            if (p && p.id !== 'custom') setForm((f) => ({ ...f, width: p.width, height: p.height }));
            else setForm((f) => ({ ...f, width: f.width + (presetForSize(f.width, f.height) === 'custom' ? 0 : 2) }));
          }} />
        </>)}
        {row('Size', <>
          <NumberField value={form.width} min={16} max={16384} step={2} onChange={(width) => setForm((f) => ({ ...f, width }))} unit="px" />
          <span className="text-faint">×</span>
          <NumberField value={form.height} min={16} max={16384} step={2} onChange={(height) => setForm((f) => ({ ...f, height }))} unit="px" />
        </>)}
        {row('Audio', <>
          <Select value={String(form.sampleRate)} options={SAMPLE_RATES} onChange={(v) => setForm((f) => ({ ...f, sampleRate: Number(v) }))} />
          <Select value={String(form.channels)} options={CHANNELS} onChange={(v) => setForm((f) => ({ ...f, channels: Number(v) }))} />
        </>)}
        {editSeq ? <div className="text-faint text-sm">Changing the frame rate does not re-time existing clips (positions stay in frames). Timebase: {fpsLabel(form.fps)} fps.</div> : null}
      </form>
    </Dialog>
  );
}

/** Convenience for other panels: the active sequence's name or null. */
export function useActiveSequenceName(): string | null { return useStore((s) => activeSequence(s)?.name ?? null); }
