/**
 * Export dialog editors for MKV packaging (ROADMAP §7): the output audio tracks (each a mix of chosen sequence audio
 * tracks with its own layout, codec, language and title; add / remove / reorder; presets) and the soft subtitle
 * streams (which sequence subtitle tracks, with language, title, Default and Forced). The edits are the pure
 * functions of packaging.ts; the Checks list reports problems (settings.ts packagingChecks).
 */
import React from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { ExportAudioCodec, ExportAudioLayout, ExportSettings, Sequence } from '@shared/model';
import {
  AUDIO_CODECS, AUDIO_LAYOUTS, AUDIO_OUTPUT_PRESETS, audioOutputBitrate, exportLanguageCode, matchingAudioOutputPreset, type AudioOutputPresetId,
} from '@shared/exportFormat';
import { Button, IconButton, Select, TextField } from '@/components/ui';
import {
  MAX_AUDIO_OUTPUTS, addAudioOutput, applyAudioOutputPreset, displayedAudioOutputs, moveAudioOutput, removeAudioOutput, setAudioOutputSource,
  setSubtitleIncluded, updateAudioOutput, updateSubtitleOutput,
} from './packaging';
import { injectStyle } from './injectStyle';

const CSS = `
.xp-list { display: flex; flex-direction: column; gap: 6px; }
.xp-card { border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; background: var(--bg-1); }
.xp-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.xp-num { font-weight: 600; color: var(--text-bright); min-width: 14px; }
.xp-badge { font-size: var(--font-size-xs); color: var(--accent); border: 1px solid var(--accent); border-radius: 3px; padding: 0 4px; white-space: nowrap; }
.xp-line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: var(--font-size-sm); }
.xp-line > .lbl { color: var(--text-dim); min-width: 52px; }
.xp-check { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; color: var(--text); }
.xp-check.off { color: var(--text-faint); }
.xp-lang { width: 52px; }
.xp-title { flex: 1 1 120px; min-width: 80px; }
`;

const LAYOUT_OPTIONS = AUDIO_LAYOUTS.map((l) => ({ value: l.id, label: l.label }));
const CODEC_OPTIONS = AUDIO_CODECS.map((c) => ({ value: c.id, label: c.label }));
const BITRATES = [96, 128, 160, 192, 224, 256, 320, 384, 448, 512, 640];
const CUSTOM_PRESET = 'custom';

interface EditorProps {
  seq: Sequence;
  settings: ExportSettings;
  update: (patch: Partial<ExportSettings>) => void;
}

/** The output audio tracks of an MKV export. */
export function AudioOutputsEditor({ seq, settings, update }: EditorProps) {
  injectStyle('recut-export-packaging-css', CSS);
  const outs = displayedAudioOutputs(settings);
  const preset = matchingAudioOutputPreset(settings, seq) ?? CUSTOM_PRESET;
  const presetOptions = [
    ...AUDIO_OUTPUT_PRESETS.map((p) => ({ value: p.id as string, label: p.label })),
    ...(preset === CUSTOM_PRESET ? [{ value: CUSTOM_PRESET, label: 'Custom' }] : []),
  ];
  return (
    <>
      <div className="xd-row">
        <label>Tracks</label>
        <div className="ctl">
          <Select value={preset} options={presetOptions} data-testid="export-audio-preset"
            onChange={(v) => { if (v !== CUSTOM_PRESET) update(applyAudioOutputPreset(v as AudioOutputPresetId, seq)); }} />
          <Button size="sm" icon={Plus} disabled={outs.length >= MAX_AUDIO_OUTPUTS} onClick={() => update(addAudioOutput(settings))} data-testid="export-audio-add">Add track</Button>
        </div>
      </div>
      <div className="xp-list" data-testid="export-audio-outputs">
        {outs.map((o, i) => {
          const lossy = o.codec === 'aac' || o.codec === 'ac3';
          const kbps = audioOutputBitrate(o);
          const rates = BITRATES.includes(kbps) ? BITRATES : [...BITRATES, kbps].sort((a, b) => a - b);
          const all = !Array.isArray(o.sources);
          return (
            <div key={i} className="xp-card" data-testid={`export-audio-output-${i}`}>
              <div className="xp-head">
                <span className="xp-num">{i + 1}</span>
                <TextField className="xp-title" size="sm" value={o.title ?? ''} placeholder={i === 0 ? 'Title (e.g. Main)' : 'Title (e.g. Commentary)'}
                  onChange={(v) => update(updateAudioOutput(settings, i, { title: v }))} data-testid={`export-audio-title-${i}`} />
                <TextField className="xp-lang" size="sm" value={o.language ?? ''} placeholder="und" maxLength={3} title="Language: ISO 639-2 code (eng, fre, ger, spa, jpn, ...)"
                  onChange={(v) => update(updateAudioOutput(settings, i, { language: v.trim().toLowerCase() }))} data-testid={`export-audio-lang-${i}`} />
                {i === 0 ? <span className="xp-badge" title="Players play this track first">Default</span> : null}
                <IconButton icon={ArrowUp} size="sm" label="Move up" disabled={i === 0} onClick={() => update(moveAudioOutput(settings, i, -1))} data-testid={`export-audio-up-${i}`} />
                <IconButton icon={ArrowDown} size="sm" label="Move down" disabled={i === outs.length - 1} onClick={() => update(moveAudioOutput(settings, i, 1))} data-testid={`export-audio-down-${i}`} />
                <IconButton icon={Trash2} size="sm" label="Remove track" disabled={outs.length <= 1} onClick={() => update(removeAudioOutput(settings, i))} data-testid={`export-audio-remove-${i}`} />
              </div>
              <div className="xp-line">
                <span className="lbl">Sources</span>
                <label className="xp-check">
                  <input type="checkbox" checked={all} onChange={(e) => update(setAudioOutputSource(settings, seq, i, 'all', e.target.checked))} data-testid={`export-audio-source-${i}-all`} />
                  All tracks
                </label>
                {seq.audioTracks.map((t, n) => {
                  const on = all || o.sources!.includes(t.id);
                  const name = t.name && t.name.toLowerCase() !== `a${n + 1}` ? ` ${t.name}` : '';
                  return (
                    <label key={t.id} className={`xp-check${t.muted ? ' off' : ''}`} title={t.muted ? 'Muted: not in any export mix' : undefined}>
                      <input type="checkbox" checked={on} onChange={(e) => update(setAudioOutputSource(settings, seq, i, t.id, e.target.checked))} data-testid={`export-audio-source-${i}-${n + 1}`} />
                      A{n + 1}{name}
                    </label>
                  );
                })}
              </div>
              <div className="xp-line">
                <span className="lbl">Format</span>
                <Select size="sm" value={o.layout} options={LAYOUT_OPTIONS} onChange={(v) => update(updateAudioOutput(settings, i, { layout: v as ExportAudioLayout }))} data-testid={`export-audio-layout-${i}`} />
                <Select size="sm" value={o.codec} options={CODEC_OPTIONS} onChange={(v) => update(updateAudioOutput(settings, i, { codec: v as ExportAudioCodec }))} data-testid={`export-audio-codec-${i}`} />
                {lossy ? (
                  <Select size="sm" value={String(kbps)} options={rates.map((r) => ({ value: String(r), label: `${r} kbps` }))}
                    onChange={(v) => update(updateAudioOutput(settings, i, { bitrateKbps: Number(v) }))} data-testid={`export-audio-bitrate-${i}`} />
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** The soft subtitle streams of an MKV export: one row per sequence subtitle track. */
export function SubtitleOutputsEditor({ seq, settings, update }: EditorProps) {
  injectStyle('recut-export-packaging-css', CSS);
  const chosen = Array.isArray(settings.subtitleOutputs) ? settings.subtitleOutputs : [];
  return (
    <div className="xp-list" data-testid="export-subtitle-outputs">
      {seq.subtitleTracks.map((t, n) => {
        const o = chosen.find((x) => x?.trackId === t.id);
        return (
          <div key={t.id} className="xp-card" data-testid={`export-sub-output-${n + 1}`}>
            <div className="xp-head">
              <label className="xp-check">
                <input type="checkbox" checked={!!o} onChange={(e) => update(setSubtitleIncluded(settings, seq, t.id, e.target.checked))} data-testid={`export-sub-include-${n + 1}`} />
                {t.name || `Subtitles ${n + 1}`}{t.enabled ? '' : ' (hidden)'}
              </label>
            </div>
            {o ? (
              <div className="xp-line">
                <TextField className="xp-title" size="sm" value={o.title ?? t.name} onChange={(v) => update(updateSubtitleOutput(settings, t.id, { title: v }))} data-testid={`export-sub-title-${n + 1}`} />
                <TextField className="xp-lang" size="sm" value={o.language ?? ''} placeholder={exportLanguageCode(t.language)} maxLength={3} title="Language: ISO 639-2 code (eng, fre, ger, spa, jpn, ...)"
                  onChange={(v) => update(updateSubtitleOutput(settings, t.id, { language: v.trim().toLowerCase() }))} data-testid={`export-sub-lang-${n + 1}`} />
                <label className="xp-check" title="Players show this track without being asked">
                  <input type="checkbox" checked={o.default === true} onChange={(e) => update(updateSubtitleOutput(settings, t.id, { default: e.target.checked }))} data-testid={`export-sub-default-${n + 1}`} />
                  Default
                </label>
                <label className="xp-check" title="For lines in another language: shown even when subtitles are off">
                  <input type="checkbox" checked={o.forced === true} onChange={(e) => update(updateSubtitleOutput(settings, t.id, { forced: e.target.checked }))} data-testid={`export-sub-forced-${n + 1}`} />
                  Forced
                </label>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
