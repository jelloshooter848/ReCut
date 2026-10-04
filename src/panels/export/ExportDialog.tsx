/**
 * Export dialog (bound to ui.dialogs.export). Premiere-style: a summary column on the left, settings on
 * the right. Starting an export switches the same dialog into a progress view fed by the jobs store.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, FolderOpen, Info, Loader2, Terminal, XCircle } from 'lucide-react';
import type { ExportSettings, JobInfo, Sequence } from '@shared/model';
import type { ExportRequest } from '@shared/ipc';
import { FPS_PRESETS, fpsEquals, fpsLabel, formatTimecode, framesToSeconds } from '@shared/time';
import { allTracks, resolveSubtitleCues } from '@shared/timeline';
import { useStore, activeSequence, recutApi } from '@/state';
import { useJob } from '@/app/jobsStore';
import { Button, Dialog, NumberField, ProgressBar, Select, Slider, TextField, Toggle } from '@/components/ui';
import { toast } from '@/components/ui/toastStore';
import { injectStyle } from './injectStyle';
import {
  CRF_MAX, CRF_MIN, CUSTOM, ENCODER_PRESETS, MAX_DIMENSION, MIN_DIMENSION, applyPreset, checklistBlocks, crfLabel,
  estimateEtaSeconds, estimateFileSize, exportChecklist, exportRange, formatBytes, formatDuration, fpsFromOptionValue,
  fpsOptionValue, hasInOut, initialExportSettings, loadSavedExportSettings, maxSourceChannels, outputPathFor,
  presetNameFor, presetsFor, saveExportSettings, sanitizeFileName, sequenceHasSubtitles, validateExportSettings, withMp4,
} from './settings';

const CSS = `
.xd { display: grid; grid-template-columns: 236px minmax(0, 1fr); gap: 0; min-height: 0; margin: -12px; }
.xd-summary { background: var(--bg-1); border-right: 1px solid var(--border); padding: 12px; display: flex; flex-direction: column; gap: 12px; overflow: auto; }
.xd-summary h4 { margin: 0 0 4px; font-size: var(--font-size-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-dim); font-weight: 600; }
.xd-kv { display: grid; grid-template-columns: auto 1fr; column-gap: 8px; row-gap: 2px; font-size: var(--font-size-sm); }
.xd-kv dt { color: var(--text-dim); margin: 0; }
.xd-kv dd { margin: 0; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.xd-kv dd.wrap { white-space: normal; word-break: break-all; }
.xd-settings { padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; overflow: auto; max-height: calc(100vh - 170px); }
.xd-section { display: flex; flex-direction: column; gap: 5px; }
.xd-section > h4 { margin: 0 0 2px; font-size: var(--font-size-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-dim); font-weight: 600; border-bottom: 1px solid var(--border); padding-bottom: 3px; }
.xd-row { display: grid; grid-template-columns: 104px minmax(0, 1fr); align-items: center; gap: 8px; min-height: 22px; }
.xd-row > label { color: var(--text-dim); font-size: var(--font-size-sm); white-space: nowrap; }
.xd-row .ctl { display: flex; align-items: center; gap: 6px; min-width: 0; }
.xd-row .ctl > .select { max-width: 100%; }
.xd-hint { color: var(--text-faint); font-size: var(--font-size-xs); line-height: 1.3; }
.xd-warn { color: var(--accent-2); font-size: var(--font-size-xs); display: flex; gap: 4px; align-items: flex-start; }
.xd-warn > svg { width: 11px; height: 11px; flex-shrink: 0; margin-top: 1px; }
.xd-check { display: flex; flex-direction: column; gap: 4px; }
.xd-check-item { display: flex; gap: 6px; align-items: flex-start; font-size: var(--font-size-sm); line-height: 1.35; }
.xd-check-item > svg { width: 12px; height: 12px; flex-shrink: 0; margin-top: 2px; }
.xd-check-item.error { color: var(--danger); } .xd-check-item.warning { color: var(--accent-2); } .xd-check-item.info { color: var(--text-dim); }
.xd-path { font-family: var(--font-mono); font-size: var(--font-size-xs); color: var(--text-dim); word-break: break-all; user-select: text; -webkit-user-select: text; }
.xd-cmd { position: relative; background: var(--bg-0); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 8px 8px; font-family: var(--font-mono); font-size: var(--font-size-xs); color: var(--text); white-space: pre-wrap; word-break: break-all; max-height: 180px; overflow: auto; user-select: text; -webkit-user-select: text; line-height: 1.45; }
.xd-cmd-wrap { display: flex; flex-direction: column; gap: 4px; }
.xd-crf { display: grid; grid-template-columns: minmax(0, 1fr) 36px 56px; gap: 8px; align-items: center; }
.xd-progress { display: flex; flex-direction: column; gap: 14px; padding: 8px 4px; min-width: 0; }
.xd-progress .big { font-size: 22px; font-weight: 600; color: var(--text-bright); font-variant-numeric: tabular-nums; }
.xd-progress .progress { height: 8px; }
.xd-status { display: flex; align-items: center; gap: 10px; }
.xd-status > svg { width: 28px; height: 28px; flex-shrink: 0; }
.xd-status.ok > svg { color: var(--ok); } .xd-status.err > svg { color: var(--danger); } .xd-status.run > svg { color: var(--accent); }
.xd-status .title { font-size: 14px; font-weight: 600; color: var(--text-bright); }
.xd-err { background: var(--bg-0); border: 1px solid var(--danger); border-radius: var(--radius); padding: 8px; font-family: var(--font-mono); font-size: var(--font-size-xs); white-space: pre-wrap; word-break: break-all; max-height: 220px; overflow: auto; user-select: text; -webkit-user-select: text; color: var(--text); }
.xd-footer-left { display: flex; align-items: center; gap: 8px; margin-right: auto; min-width: 0; font-size: var(--font-size-sm); color: var(--text-dim); }
.xd-badge-row { display: flex; gap: 6px; align-items: center; }
`;

const CODEC_OPTIONS = [{ value: 'libx264', label: 'H.264 (libx264)' }, { value: 'libx265', label: 'H.265 / HEVC (libx265)' }] as const;
const QUALITY_OPTIONS = [{ value: 'crf', label: 'Constant quality (CRF)' }, { value: 'bitrate', label: 'Target bitrate' }] as const;
const AUDIO_CODEC_OPTIONS = [{ value: 'aac', label: 'AAC' }, { value: 'ac3', label: 'AC-3 (Dolby Digital)' }] as const;
const AUDIO_BITRATES = [96, 128, 160, 192, 256, 320, 384, 448, 640];
const SAMPLE_RATES = [44100, 48000, 96000];
const ENCODER_OPTIONS = ENCODER_PRESETS.map((p) => ({ value: p, label: p }));

type Phase = { kind: 'edit' } | { kind: 'job'; jobId: string; outputPath: string };

function isTerminal(j: JobInfo | undefined): boolean { return !!j && (j.status === 'done' || j.status === 'failed' || j.status === 'canceled'); }

function clipCount(seq: Sequence): number { let n = 0; for (const t of allTracks(seq)) n += t.clips.length; return n; }

async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); toast('ok', 'Copied to clipboard'); } catch { toast('error', 'Could not copy to clipboard'); }
}

export function ExportDialog() {
  injectStyle('recut-export-dialog-css', CSS);
  const open = useStore((s) => s.ui.dialogs.export);
  const closeDialog = useStore((s) => s.closeDialog);
  const seq = useStore(activeSequence);
  const media = useStore((s) => s.project.media);
  const projectId = useStore((s) => s.project.id);
  const projectPath = useStore((s) => s.projectPath);
  const projectUsesProxies = useStore((s) => s.project.settings.useProxies);

  const [settings, setSettings] = useState<ExportSettings | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'edit' });
  const [command, setCommand] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [finalJob, setFinalJob] = useState<JobInfo | null>(null);
  const wasOpen = useRef(false);

  const job = useJob(phase.kind === 'job' ? phase.jobId : undefined);
  useEffect(() => { if (job && isTerminal(job)) setFinalJob(job); }, [job]);

  // Initialize settings whenever the dialog opens.
  useEffect(() => {
    if (!open || wasOpen.current) { wasOpen.current = open; return; }
    wasOpen.current = true;
    if (!seq) return;
    const saved = loadSavedExportSettings(projectId);
    const init = initialExportSettings(seq, saved, { projectPath });
    setSettings(init);
    setCommand(null); setCommandError(null); setStartError(null);
    if (phase.kind === 'job' && isTerminal(job ?? finalJob ?? undefined)) setPhase({ kind: 'edit' });
    const api = recutApi();
    if (api && !init.outputDir) {
      // Preferences' last export dir, else the user's home directory, as the output directory fallback.
      Promise.all([api.getPrefs().catch(() => null), api.appInfo().catch(() => null)]).then(([prefs, info]) => {
        const dir = prefs?.lastExportDir?.trim() || info?.homeDir || '';
        if (dir) setSettings((s) => (s && !s.outputDir ? { ...s, outputDir: dir } : s));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onClose = useCallback(() => closeDialog('export'), [closeDialog]);
  const update = useCallback((patch: Partial<ExportSettings>) => {
    setSettings((s) => (s ? { ...s, ...patch, useProxies: false } : s));
    setCommand(null); setCommandError(null);
  }, []);

  if (!open) return null;
  if (!seq || !settings) {
    return (
      <Dialog open title="Export" onClose={onClose} width={420} footer={<Button onClick={onClose}>Close</Button>}>
        <div className="text-dim">Open or create a sequence to export.</div>
      </Dialog>
    );
  }

  const activeJob = job ?? finalJob;
  if (phase.kind === 'job') {
    return (
      <ProgressView
        seq={seq} settings={settings} job={activeJob ?? undefined} jobId={phase.jobId} outputPath={phase.outputPath}
        onClose={onClose} onAnother={() => { setPhase({ kind: 'edit' }); setFinalJob(null); }}
      />
    );
  }

  return (
    <SettingsView
      seq={seq} settings={settings} media={media} projectUsesProxies={projectUsesProxies} update={update}
      command={command} commandError={commandError} starting={starting} startError={startError}
      onShowCommand={async () => {
        const api = recutApi();
        if (!api) { setCommandError('IPC unavailable'); return; }
        setCommand(null); setCommandError(null);
        try {
          const args = await api.previewExportCommand(buildRequest(seq, media, settings));
          setCommand(['ffmpeg', ...args.map(shellQuote)].join(' '));
        } catch (e) { setCommandError(e instanceof Error ? e.message : String(e)); }
      }}
      onBrowse={async () => {
        const api = recutApi();
        if (!api) return;
        const dir = await api.openFolder({ title: 'Choose export folder', defaultPath: settings.outputDir || undefined });
        if (dir) update({ outputDir: dir });
      }}
      onExport={async () => {
        const api = recutApi();
        if (!api) { setStartError('IPC unavailable'); return; }
        setStarting(true); setStartError(null);
        const final: ExportSettings = { ...settings, fileName: withMp4(sanitizeFileName(settings.fileName)), useProxies: false };
        saveExportSettings(projectId, seq.id, final);
        api.setPrefs({ lastExportDir: final.outputDir }).catch(() => { /* ignore */ });
        try {
          const res = await api.startExport(buildRequest(seq, media, final));
          if (res.ok) { setFinalJob(null); setPhase({ kind: 'job', jobId: res.jobId, outputPath: res.outputPath }); }
          else setStartError(res.error);
        } catch (e) { setStartError(e instanceof Error ? e.message : String(e)); }
        finally { setStarting(false); }
      }}
      onClose={onClose}
    />
  );
}

function shellQuote(a: string): string { return /^[A-Za-z0-9_\-./:=+@,]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`; }

function buildRequest(seq: Sequence, media: ExportRequest['media'], settings: ExportSettings): ExportRequest {
  const subtitles = sequenceHasSubtitles(seq)
    ? resolveSubtitleCues(seq).map((c) => ({ start: framesToSeconds(c.start, seq.fps), end: framesToSeconds(c.end, seq.fps), text: c.text }))
    : undefined;
  return { sequence: seq, media, settings: { ...settings, useProxies: false }, subtitles };
}

// ---------------------------------------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------------------------------------

interface SettingsViewProps {
  seq: Sequence;
  settings: ExportSettings;
  media: ExportRequest['media'];
  projectUsesProxies: boolean;
  update: (patch: Partial<ExportSettings>) => void;
  command: string | null;
  commandError: string | null;
  starting: boolean;
  startError: string | null;
  onShowCommand: () => void;
  onBrowse: () => void;
  onExport: () => void;
  onClose: () => void;
}

function SettingsView(p: SettingsViewProps) {
  const { seq, settings, media, update } = p;
  const presets = useMemo(() => presetsFor(seq), [seq]);
  const [chosenPreset, setChosenPreset] = useState<string | undefined>(undefined);
  const presetName = presetNameFor(settings, presets, chosenPreset);
  const presetOptions = useMemo(() => [...presets.map((x) => ({ value: x.name, label: x.name })), { value: CUSTOM, label: CUSTOM }], [presets]);
  const validation = validateExportSettings(settings);
  const checklist = useMemo(() => exportChecklist(seq, media, settings, p.projectUsesProxies), [seq, media, settings, p.projectUsesProxies]);
  const blocked = checklistBlocks(checklist);
  const range = exportRange(seq, settings);
  const size = estimateFileSize(settings, range.seconds);
  const maxCh = useMemo(() => maxSourceChannels(seq, media), [seq, media]);
  const surroundOk = maxCh >= 6;
  const hasSubs = sequenceHasSubtitles(seq);
  const fpsDiffers = !fpsEquals(settings.fps, seq.fps);
  const outPath = outputPathFor(settings);
  const issueFor = (field: string) => validation.issues.find((i) => i.field === field)?.message;
  const disabledReason = !validation.ok ? validation.issues[0].message : blocked ? checklist.find((c) => c.level === 'error')!.text : p.starting ? 'Starting…' : undefined;

  const fpsOptions = useMemo(() => {
    const opts = FPS_PRESETS.map((f) => ({ value: f.label, label: `${f.label} fps` }));
    if (!FPS_PRESETS.some((f) => fpsEquals(f.fps, seq.fps))) opts.unshift({ value: fpsOptionValue(seq.fps), label: `${fpsLabel(seq.fps)} fps (sequence)` });
    return opts;
  }, [seq.fps]);

  const audioBitrateOptions = useMemo(() => {
    const vals = AUDIO_BITRATES.includes(settings.audioBitrateKbps) ? AUDIO_BITRATES : [...AUDIO_BITRATES, settings.audioBitrateKbps].sort((a, b) => a - b);
    return vals.map((v) => ({ value: String(v), label: `${v} kbps` }));
  }, [settings.audioBitrateKbps]);
  const sampleRateOptions = useMemo(() => {
    const vals = SAMPLE_RATES.includes(settings.sampleRate) ? SAMPLE_RATES : [...SAMPLE_RATES, settings.sampleRate].sort((a, b) => a - b);
    return vals.map((v) => ({ value: String(v), label: `${(v / 1000).toFixed(1).replace(/\.0$/, '')} kHz` }));
  }, [settings.sampleRate]);

  const footer = (
    <>
      <div className="xd-footer-left">
        <Button size="sm" icon={Terminal} onClick={p.onShowCommand} data-testid="export-show-command">Show FFmpeg command</Button>
        {disabledReason ? <span className="text-danger ellipsis" title={disabledReason}>{disabledReason}</span> : null}
      </div>
      <Button onClick={p.onClose}>Cancel</Button>
      <Button variant="primary" disabled={!!disabledReason} title={disabledReason} onClick={p.onExport} data-testid="export-start">
        {p.starting ? <Loader2 className="spin" /> : null}Export
      </Button>
    </>
  );

  return (
    <Dialog open title="Export" onClose={p.onClose} width={760} closeOnBackdrop={false} footer={footer} className="xd-dialog">
      <div className="xd" data-testid="export-dialog">
        <aside className="xd-summary">
          <div>
            <h4>Source</h4>
            <dl className="xd-kv">
              <dt>Sequence</dt><dd title={seq.name}>{seq.name}</dd>
              <dt>Format</dt><dd>{seq.width}×{seq.height} · {fpsLabel(seq.fps)} fps</dd>
              <dt>Audio</dt><dd>{seq.channels === 6 ? '5.1' : 'Stereo'} · {(seq.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz</dd>
              <dt>Clips</dt><dd>{clipCount(seq)}</dd>
              <dt>Length</dt><dd className="mono">{formatTimecode(exportRange(seq, { rangeMode: 'entire' }).frames, seq.fps)}</dd>
            </dl>
          </div>
          <div>
            <h4>Output</h4>
            <dl className="xd-kv">
              <dt>Video</dt><dd>{settings.width}×{settings.height} · {settings.videoCodec === 'libx265' ? 'H.265' : 'H.264'}</dd>
              <dt>Quality</dt><dd>{settings.qualityMode === 'crf' ? `CRF ${settings.crf} (${crfLabel(settings.crf)})` : `${settings.videoBitrateKbps} kbps`} · {settings.preset}</dd>
              <dt>Audio</dt><dd>{settings.audioCodec.toUpperCase().replace('AC3', 'AC-3')} · {settings.audioBitrateKbps} kbps · {settings.audioChannels === 6 ? '5.1' : 'Stereo'}</dd>
              <dt>Range</dt><dd>{range.usesInOut ? 'In → Out' : 'Entire sequence'}</dd>
              <dt>Duration</dt><dd className="mono">{formatTimecode(range.frames, seq.fps)} · {range.frames} fr</dd>
              <dt>Est. size</dt><dd data-testid="export-size">{size.approximate ? '≈ ' : ''}{formatBytes(size.bytes)}</dd>
              <dt>File</dt><dd className="wrap xd-path" title={outPath}>{outPath}</dd>
            </dl>
          </div>
          <div>
            <h4>Checks</h4>
            <div className="xd-check" data-testid="export-checklist">
              {checklist.length === 0 ? <div className="xd-check-item info"><CheckCircle2 style={{ color: 'var(--ok)' }} />Ready to export.</div> : null}
              {checklist.map((c, i) => (
                <div key={i} className={`xd-check-item ${c.level}`}>
                  {c.level === 'error' ? <XCircle /> : c.level === 'warning' ? <AlertTriangle /> : <Info />}
                  <span>{c.text}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>

        <div className="xd-settings">
          <div className="xd-row">
            <label>Preset</label>
            <div className="ctl">
              <Select value={presetName} options={presetOptions} data-testid="export-preset" style={{ minWidth: 220 }}
                onChange={(name) => { const pr = presets.find((x) => x.name === name); if (pr) { setChosenPreset(pr.name); update(applyPreset(settings, pr)); } }} />
            </div>
          </div>

          <section className="xd-section">
            <h4>Output</h4>
            <div className="xd-row">
              <label>File name</label>
              <div className="ctl">
                <TextField value={settings.fileName} onChange={(v) => update({ fileName: v })} invalid={!!issueFor('fileName')} title={issueFor('fileName')} data-testid="export-filename" placeholder="sequence.mp4" />
              </div>
            </div>
            <div className="xd-row">
              <label>Folder</label>
              <div className="ctl">
                <TextField value={settings.outputDir} onChange={(v) => update({ outputDir: v })} invalid={!!issueFor('outputDir')} title={issueFor('outputDir')} data-testid="export-outdir" placeholder="Choose an output folder" />
                <Button icon={FolderOpen} onClick={p.onBrowse}>Browse…</Button>
              </div>
            </div>
            {issueFor('fileName') || issueFor('outputDir') ? <div className="xd-row"><span /><span className="xd-warn"><AlertTriangle />{issueFor('fileName') ?? issueFor('outputDir')}</span></div> : null}
          </section>

          <section className="xd-section">
            <h4>Video</h4>
            <div className="xd-row">
              <label>Frame size</label>
              <div className="ctl">
                <NumberField value={settings.width} min={MIN_DIMENSION} max={MAX_DIMENSION} step={2} unit="px" title={issueFor('width')} onChange={(v) => update({ width: Math.round(v) })} />
                <span className="text-dim">×</span>
                <NumberField value={settings.height} min={MIN_DIMENSION} max={MAX_DIMENSION} step={2} unit="px" title={issueFor('height')} onChange={(v) => update({ height: Math.round(v) })} />
                <Button size="sm" onClick={() => update({ width: seq.width - (seq.width % 2), height: seq.height - (seq.height % 2) })}>Match sequence</Button>
              </div>
            </div>
            {issueFor('width') || issueFor('height') ? <div className="xd-row"><span /><span className="xd-warn"><AlertTriangle />{issueFor('width') ?? issueFor('height')}</span></div> : null}
            <div className="xd-row">
              <label>Frame rate</label>
              <div className="ctl">
                <Select value={fpsOptionValue(settings.fps)} options={fpsOptions} onChange={(v) => update({ fps: fpsFromOptionValue(v, seq.fps) })} />
                {fpsDiffers ? <Button size="sm" onClick={() => update({ fps: seq.fps })}>Use {fpsLabel(seq.fps)}</Button> : null}
              </div>
            </div>
            {fpsDiffers ? <div className="xd-row"><span /><span className="xd-warn"><AlertTriangle />Export uses the sequence frame rate; retiming is not applied.</span></div> : null}
            <div className="xd-row">
              <label>Codec</label>
              <div className="ctl"><Select value={settings.videoCodec} options={CODEC_OPTIONS} onChange={(v) => update({ videoCodec: v })} /></div>
            </div>
            <div className="xd-row">
              <label>Quality</label>
              <div className="ctl"><Select value={settings.qualityMode} options={QUALITY_OPTIONS} onChange={(v) => update({ qualityMode: v })} /></div>
            </div>
            {settings.qualityMode === 'crf' ? (
              <div className="xd-row">
                <label>CRF</label>
                <div className="xd-crf">
                  <Slider value={settings.crf} min={CRF_MIN} max={CRF_MAX} step={1} defaultValue={18} onChange={(v) => update({ crf: Math.round(v) })} title="Lower = better quality, larger file" />
                  <span className="mono text-bright">{settings.crf}</span>
                  <span className="text-dim text-sm">{crfLabel(settings.crf)}</span>
                </div>
              </div>
            ) : (
              <div className="xd-row">
                <label>Bitrate</label>
                <div className="ctl">
                  <NumberField value={settings.videoBitrateKbps} min={100} max={200000} step={100} unit="kbps" title={issueFor('videoBitrateKbps')} onChange={(v) => update({ videoBitrateKbps: Math.round(v) })} />
                  <span className="xd-hint">Constrained (maxrate = bitrate, bufsize = 2×)</span>
                </div>
              </div>
            )}
            <div className="xd-row">
              <label>Encoder preset</label>
              <div className="ctl">
                <Select value={settings.preset} options={ENCODER_OPTIONS.some((o) => o.value === settings.preset) ? ENCODER_OPTIONS : [...ENCODER_OPTIONS, { value: settings.preset, label: settings.preset }]} onChange={(v) => update({ preset: v })} />
                <span className="xd-hint">Slower presets compress better at the same quality.</span>
              </div>
            </div>
          </section>

          <section className="xd-section">
            <h4>Audio</h4>
            <div className="xd-row">
              <label>Codec</label>
              <div className="ctl"><Select value={settings.audioCodec} options={AUDIO_CODEC_OPTIONS} onChange={(v) => update({ audioCodec: v })} /></div>
            </div>
            <div className="xd-row">
              <label>Bitrate</label>
              <div className="ctl"><Select value={String(settings.audioBitrateKbps)} options={audioBitrateOptions} onChange={(v) => update({ audioBitrateKbps: Number(v) })} /></div>
            </div>
            <div className="xd-row">
              <label>Channels</label>
              <div className="ctl">
                <Select value={String(settings.audioChannels)} options={[{ value: '2', label: 'Stereo' }, { value: '6', label: '5.1 Surround', disabled: !surroundOk }]}
                  onChange={(v) => update(v === '6' ? { audioChannels: 6, audioCodec: 'ac3', audioBitrateKbps: Math.max(settings.audioBitrateKbps, 448) } : { audioChannels: 2 })} />
                <span className="xd-hint">{surroundOk ? `Source has ${maxCh}-channel audio.` : 'Needs a source with 6 audio channels.'}</span>
              </div>
            </div>
            <div className="xd-row">
              <label>Sample rate</label>
              <div className="ctl"><Select value={String(settings.sampleRate)} options={sampleRateOptions} onChange={(v) => update({ sampleRate: Number(v) })} /></div>
            </div>
          </section>

          <section className="xd-section">
            <h4>Range</h4>
            <div className="xd-row">
              <label>Export</label>
              <div className="ctl">
                <Select value={settings.rangeMode} onChange={(v) => update({ rangeMode: v })}
                  options={[{ value: 'entire', label: 'Entire sequence' }, { value: 'inOut', label: hasInOut(seq) ? 'In to Out' : 'In to Out (not set)', disabled: !hasInOut(seq) }]} />
                <span className="xd-hint mono">{formatTimecode(range.frames, seq.fps)} · {range.frames} frames · {size.approximate ? '≈ ' : ''}{formatBytes(size.bytes)}</span>
              </div>
            </div>
          </section>

          <section className="xd-section">
            <h4>Subtitles</h4>
            <div className="xd-row">
              <label>Burn in</label>
              <div className="ctl">
                <Toggle checked={settings.burnSubtitles && hasSubs} disabled={!hasSubs} onChange={(v) => update({ burnSubtitles: v })} label={<span className="text-sm">Render subtitles into the picture</span>} />
              </div>
            </div>
            <div className="xd-row">
              <label>Sidecar</label>
              <div className="ctl">
                <Toggle checked={settings.exportSubtitleSidecar && hasSubs} disabled={!hasSubs} onChange={(v) => update({ exportSubtitleSidecar: v })} label={<span className="text-sm">Export .srt next to the video</span>} />
              </div>
            </div>
            {!hasSubs ? <div className="xd-row"><span /><span className="xd-hint">The sequence has no subtitle tracks.</span></div> : null}
          </section>

          <section className="xd-section">
            <h4>Advanced</h4>
            {p.commandError ? <div className="xd-warn"><AlertTriangle />{p.commandError}</div> : null}
            {p.command ? (
              <div className="xd-cmd-wrap">
                <div className="row">
                  <span className="text-dim text-sm">FFmpeg command (filter graph inline)</span>
                  <Button size="sm" icon={Copy} className="ml-auto" onClick={() => copyText(p.command!)}>Copy</Button>
                </div>
                <pre className="xd-cmd" data-testid="export-command">{p.command}</pre>
              </div>
            ) : <div className="xd-hint">Use “Show FFmpeg command” below to preview the exact command before exporting.</div>}
            {p.startError ? <div className="xd-check-item error" data-testid="export-start-error"><XCircle /><span>{p.startError}</span></div> : null}
          </section>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------
// Progress / result view
// ---------------------------------------------------------------------------------------------------

interface ProgressViewProps {
  seq: Sequence;
  settings: ExportSettings;
  job: JobInfo | undefined;
  jobId: string;
  outputPath: string;
  onClose: () => void;
  onAnother: () => void;
}

function ProgressView({ seq, job, jobId, outputPath, onClose, onAnother }: ProgressViewProps) {
  const [, tick] = useState(0);
  const running = !job || job.status === 'queued' || job.status === 'running';
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  const api = recutApi();
  const reveal = () => api?.showItemInFolder(outputPath);
  const now = Date.now();
  const elapsedMs = job?.startedAt ? (job.finishedAt ?? now) - job.startedAt : 0;
  const eta = job?.status === 'running' ? estimateEtaSeconds(job.progress, elapsedMs) : null;
  const pct = Math.round((job?.progress ?? 0) * 100);

  let body: React.ReactNode;
  let footer: React.ReactNode;
  if (running) {
    body = (
      <div className="xd-progress" data-testid="export-progress">
        <div className="xd-status run">
          <Loader2 className="spin" />
          <div>
            <div className="title">{job?.status === 'queued' ? 'Waiting for the export lane…' : 'Exporting…'}</div>
            <div className="text-dim text-sm">{job?.message ?? 'Starting FFmpeg'}</div>
          </div>
          <span className="big ml-auto">{pct}%</span>
        </div>
        <ProgressBar value={job?.status === 'running' && job.progress > 0 ? job.progress : undefined} />
        <dl className="xd-kv">
          <dt>Output</dt><dd className="wrap xd-path">{outputPath}</dd>
          <dt>Elapsed</dt><dd className="mono">{formatDuration(elapsedMs / 1000)}</dd>
          <dt>Remaining</dt><dd className="mono">{eta === null ? '—' : `≈ ${formatDuration(eta)}`}</dd>
        </dl>
      </div>
    );
    footer = (
      <>
        <span className="xd-footer-left">The export keeps running if you close this dialog; see the Jobs panel.</span>
        <Button onClick={onClose}>Hide</Button>
        <Button variant="danger" onClick={() => api?.cancelExport(jobId)} data-testid="export-cancel-job">Cancel export</Button>
      </>
    );
  } else if (job.status === 'done') {
    body = (
      <div className="xd-progress" data-testid="export-done">
        <div className="xd-status ok">
          <CheckCircle2 />
          <div>
            <div className="title">Export complete</div>
            <div className="text-dim text-sm">{seq.name} · {formatDuration(elapsedMs / 1000)}</div>
          </div>
        </div>
        <dl className="xd-kv">
          <dt>File</dt><dd className="wrap xd-path">{outputPath}</dd>
          {(job.result as { sidecarPath?: string } | undefined)?.sidecarPath ? <><dt>Subtitles</dt><dd className="wrap xd-path">{(job.result as { sidecarPath?: string }).sidecarPath}</dd></> : null}
          {Array.isArray((job.result as { warnings?: string[] } | undefined)?.warnings) && (job.result as { warnings: string[] }).warnings.length ? (
            <><dt>Warnings</dt><dd className="wrap"><div className="xd-check">{(job.result as { warnings: string[] }).warnings.map((w, i) => <div key={i} className="xd-check-item warning"><AlertTriangle /><span>{w}</span></div>)}</div></dd></>
          ) : null}
        </dl>
      </div>
    );
    footer = (
      <>
        <Button className="xd-footer-left" onClick={onAnother} data-testid="export-another">Export another</Button>
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" icon={FolderOpen} onClick={reveal} data-testid="export-reveal">Reveal in Folder</Button>
      </>
    );
  } else {
    const canceled = job.status === 'canceled';
    const err = job.error ?? (canceled ? 'The export was canceled.' : 'Unknown error');
    body = (
      <div className="xd-progress" data-testid="export-error">
        <div className="xd-status err">
          <XCircle />
          <div>
            <div className="title">{canceled ? 'Export canceled' : 'Export failed'}</div>
            <div className="text-dim text-sm">{outputPath}</div>
          </div>
        </div>
        <pre className="xd-err">{err}</pre>
      </div>
    );
    footer = (
      <>
        <Button className="xd-footer-left" size="sm" icon={Copy} onClick={() => copyText(err)}>Copy error</Button>
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" onClick={onAnother}>Back to settings</Button>
      </>
    );
  }

  return (
    <Dialog open title={running ? 'Exporting' : job.status === 'done' ? 'Export complete' : 'Export'} onClose={onClose} width={560} closeOnBackdrop={false} footer={footer}>
      {body}
    </Dialog>
  );
}
