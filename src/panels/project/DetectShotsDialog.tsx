/**
 * Detect Shots (#142): one dialog for the Project panel's Detect Shots… and the Media Inspector's Detect button.
 * Sensitivity in plain words (Fewer / Normal / More cuts, or the project's custom value), the shortest shot kept,
 * naming from the transcript, and a warning when it would replace shots that were renamed, merged, split, tagged or
 * deleted.
 */
import React, { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { ID } from '@shared/model';
import { SHOT_SENSITIVITY, shotSensitivityOf, type ShotSensitivity } from '@shared/shotDetect';
import { Button, Dialog, Select, Toggle } from '@/components/ui';
import { useStore } from '@/state';
import { detectScenes } from './actions';

export const useDetectShotsDialog = create<{ ids: ID[] | null }>()(() => ({ ids: null }));

/** Open Detect Shots for these media (videos only are kept). */
export function openDetectShots(ids: readonly ID[]): void {
  const media = useStore.getState().project.media;
  const videos = ids.filter((id) => media[id]?.kind === 'video' && !media[id]?.offline);
  if (videos.length) useDetectShotsDialog.setState({ ids: videos });
}

const MIN_SHOT_OPTIONS = [0.5, 1, 2, 3, 5].map((s) => ({ value: String(s), label: s === 1 ? '1 second' : `${s} seconds` }));

/** Mounted once in the app. */
export function DetectShotsHost() {
  const ids = useDetectShotsDialog((s) => s.ids);
  return ids ? <DetectShotsDialog ids={ids} onClose={() => useDetectShotsDialog.setState({ ids: null })} /> : null;
}

export function DetectShotsDialog({ ids, onClose }: { ids: ID[]; onClose: () => void }) {
  const settings = useStore((s) => s.project.settings);
  const media = useStore((s) => s.project.media);
  const [threshold, setThreshold] = useState(settings.sceneThreshold);
  const [minShot, setMinShot] = useState(settings.minShotSeconds);
  const [saveDefault, setSaveDefault] = useState(false);
  useEffect(() => { setThreshold(settings.sceneThreshold); setMinShot(settings.minShotSeconds); }, [settings.sceneThreshold, settings.minShotSeconds]);

  const sens = shotSensitivityOf(threshold);
  const sensOptions = [
    { value: 'fewer', label: 'Fewer cuts' }, { value: 'normal', label: 'Normal' }, { value: 'more', label: 'More cuts' },
    ...(sens === 'custom' ? [{ value: 'custom', label: `Custom (${threshold.toFixed(2)})` }] : []),
  ];
  const minOptions = MIN_SHOT_OPTIONS.some((o) => Number(o.value) === minShot) ? MIN_SHOT_OPTIONS : [...MIN_SHOT_OPTIONS, { value: String(minShot), label: `${minShot} s` }];
  const edited = ids.map((id) => media[id]).filter((m) => m?.shotsEdited && m.detectedScenes.length);

  const run = () => {
    const st = useStore.getState();
    // The shortest-shot setting is read by the detection job itself, so it is the project's while this runs.
    if (saveDefault || minShot !== settings.minShotSeconds) st.setSettings({ minShotSeconds: minShot, ...(saveDefault ? { sceneThreshold: threshold } : {}) });
    void detectScenes(ids, threshold);
    onClose();
  };

  return (
    <Dialog open title="Detect Shots" onClose={onClose} width={420} onSubmit={run}
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={run} data-testid="detect-run">{edited.length ? 'Detect and Replace' : 'Detect'}</Button></>}>
      <div className="pp-dialog-grid" data-testid="detect-shots-dialog">
        <label>Sensitivity</label>
        <Select value={sens} options={sensOptions} data-testid="detect-sensitivity" aria-label="Sensitivity"
          onChange={(v) => { if (v !== 'custom') setThreshold(SHOT_SENSITIVITY[v as ShotSensitivity]); }} />
        <label>Shortest shot</label>
        <Select value={String(minShot)} options={minOptions} data-testid="detect-min-shot" aria-label="Shortest shot"
          title="Cuts closer than this to the previous one are ignored" onChange={(v) => setMinShot(Number(v))} />
        <label />
        <Toggle checked={saveDefault} onChange={setSaveDefault} label="Save as project default" />
        <label />
        <Toggle checked={settings.nameShotsFromTranscript} onChange={(v) => useStore.getState().setSettings({ nameShotsFromTranscript: v })} label="Name shots from the transcript"
          title="When the video has a Whisper transcript or subtitles, each shot is named from the first words spoken in it" data-testid="detect-name-shots" />
      </div>
      <div className="text-dim text-xs mt-8">
        Finds the cuts between shots in {ids.length} file{ids.length === 1 ? '' : 's'} in the background. <b>Fewer cuts</b> ignores
        weaker changes such as fast camera moves; <b>More cuts</b> catches soft cuts and dissolves.
      </div>
      {edited.length ? (
        <div className="text-sm text-accent-2 mt-8" data-testid="detect-replace-warning">
          {edited.length === 1 ? `${edited[0]!.name} has shots` : `${edited.length} of these have shots`} you renamed, merged, split, tagged or deleted.
          Detecting again replaces them, and those changes are lost.
        </div>
      ) : <div className="text-dim text-xs mt-8">Existing detected shots are replaced.</div>}
    </Dialog>
  );
}
