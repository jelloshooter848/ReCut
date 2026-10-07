/**
 * Export dialog (bound to ui.dialogs.export). Premiere-style: a summary column on the left, settings on
 * the right. Starting an export switches the same dialog into a progress view fed by the jobs store.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, FolderOpen, Info, Loader2, Terminal, XCircle } from 'lucide-react';
import type { ExportSettings, JobInfo, Sequence } from '@shared/model';
import type { ExportRequest } from '@shared/ipc';
import { FPS_PRESETS, fpsEquals, fpsLabel, formatSequenceTimecode } from '@shared/time';
import { allTracks } from '@shared/timeline';
import { useStore, activeSequence, recutApi, ffmpegUnavailable } from '@/state';
import { getTransport } from '@/app/transport';
import { useJob } from '@/app/jobsStore';
import { Button, Dialog, NumberField, ProgressBar, Select, Slider, TextField, Toggle } from '@/components/ui';
import { toast } from '@/components/ui/toastStore';
import { confirm } from '@/app/dialogs/ConfirmDialog';
import { injectStyle } from './injectStyle';
import { buildExportRequest } from './request';
import {
  AC3_SAMPLE_RATES, CRF_MAX, CRF_MIN, CUSTOM, ENCODER_PRESETS, MAX_DIMENSION, MIN_DIMENSION, applyPreset, checklistBlocks, crfLabel,
  effectiveExportFps, estimateEtaSeconds, estimateFileSize, exportChecklist, exportOutputFrames, exportRange, formatBytes,
  formatDuration, fpsConversionNote, fpsFromOptionValue, type ChecklistTarget,
  fpsOptionValue, hasInOut, initialExportSettings, loadSavedExportSettings, maxSourceChannels, outputPathFor,
  clampSampleRateForCodec, presetNameFor, presetsFor, sampleRateSupported, saveExportSettings, sanitizeFileName, sequenceHasSubtitles, validateExportSettings,
  audioSummary, perTrackOutputPaths, withFormatExtension,
} from './settings';
import {
  CONTAINER_IDS, CONTAINERS, DNXHR_PROFILES, INTERMEDIATE_CODECS, PRORES_PROFILES, audioBitDepth, dnxhrProfile, exportContainer, intermediateCodec,
  isPerTrackAudio, proresProfile, videoEncoder, withExportExtension,
} from '@shared/exportFormat';

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
.xd-check-show { background: none; border: none; padding: 0; margin-left: 4px; font: inherit; color: var(--accent); text-decoration: underline; cursor: pointer; }
.xd-check-show:hover { color: var(--text); }
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

/**
 * Sample rates offered for `codec`: AC-3 (MP4) gets 32 / 44.1 / 48 kHz only; others the common rates. The current
 * rate stays selectable when the codec supports it (e.g. a sequence at 22.05 kHz). With `settings` whose format is
 * not MP4 (PCM, FLAC) the AC-3 limit does not apply.
 */
export function sampleRateChoices(codec: ExportSettings['audioCodec'], current: number, settings?: Pick<ExportSettings, 'container'>): number[] {
  const ac3 = codec === 'ac3' && (!settings || exportContainer(settings) === 'mp4');
  const base = ac3 ? AC3_SAMPLE_RATES : SAMPLE_RATES;
  const vals = base.filter((r) => sampleRateSupported(codec, r, settings));
  if (current > 0 && !vals.includes(current) && sampleRateSupported(codec, current, settings)) vals.push(current);
  return vals.sort((a, b) => a - b);
}

/**
 * A settings edit from the dialog: proxies stay off, the sample rate follows the audio codec (AC-3 ≤ 48 kHz), and
 * the file name's extension follows the format.
 */
export function patchExportSettings(settings: ExportSettings, patch: Partial<ExportSettings>): ExportSettings {
  const next: ExportSettings = { ...settings, ...patch, useProxies: false };
  if (patch.container !== undefined && exportContainer(next) !== exportContainer(settings)) next.fileName = withExportExtension(next.fileName, exportContainer(next));
  return clampSampleRateForCodec(next);
}

const FORMAT_OPTIONS = CONTAINER_IDS.map((c) => ({ value: c, label: CONTAINERS[c].label }));
const INTERMEDIATE_OPTIONS = INTERMEDIATE_CODECS.map((c) => ({ value: c.id, label: c.label }));
const PRORES_OPTIONS = PRORES_PROFILES.map((p) => ({ value: p.id, label: p.label }));
const DNXHR_OPTIONS = DNXHR_PROFILES.map((p) => ({ value: p.id, label: p.label }));
const BIT_DEPTH_OPTIONS = [{ value: '24', label: '24-bit' }, { value: '16', label: '16-bit' }];
const AUDIO_FILES_OPTIONS = [{ value: 'mix', label: 'One mixed file' }, { value: 'tracks', label: 'One file per audio track' }];
const ENCODER_OPTIONS = ENCODER_PRESETS.map((p) => ({ value: p, label: p }));

type Phase = { kind: 'edit' } | { kind: 'job'; jobId: string; outputPath: string; outputPaths?: string[] };

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
  const subtitleTracks = useStore((s) => s.project.subtitleTracks);
  const sequences = useStore((s) => s.project.sequences);
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
  /** A checklist item's "Show": select its clips (or transition), move the playhead there and close the dialog. */
  const onShowTarget = useCallback((seqId: string, t: ChecklistTarget) => {
    const st = useStore.getState();
    if (t.transitionId) st.selectTransition(t.transitionId); else st.select(t.clipIds);
    const transport = getTransport('program');
    if (transport) transport.seekFrame(t.frame); else st.setView(seqId, { playhead: t.frame });
    closeDialog('export');
  }, [closeDialog]);
  const update = useCallback((patch: Partial<ExportSettings>) => {
    setSettings((s) => (s ? patchExportSettings(s, patch) : s));
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
        seq={seq} settings={settings} job={activeJob ?? undefined} jobId={phase.jobId} outputPath={phase.outputPath} outputPaths={phase.outputPaths}
        onClose={onClose} onAnother={() => { setPhase({ kind: 'edit' }); setFinalJob(null); }}
      />
    );
  }

  return (
    <SettingsView
      seq={seq} settings={settings} media={media} projectUsesProxies={projectUsesProxies} update={update}
      onShowTarget={(t) => onShowTarget(seq.id, t)}
      command={command} commandError={commandError} starting={starting} startError={startError}
      onShowCommand={async () => {
        const api = recutApi();
        if (!api) { setCommandError('IPC unavailable'); return; }
        setCommand(null); setCommandError(null);
        try {
          const args = await api.previewExportCommand(buildRequest(seq, { media, subtitleTracks, sequences }, settings));
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
        const final: ExportSettings = { ...settings, fileName: withFormatExtension(sanitizeFileName(settings.fileName), settings), useProxies: false };
        saveExportSettings(projectId, seq.id, final);
        api.setPrefs({ lastExportDir: final.outputDir }).catch(() => { /* ignore */ });
        const noFfmpeg = ffmpegUnavailable('ffmpeg');
        if (noFfmpeg) { setStartError(noFfmpeg); setStarting(false); return; }
        try {
          const req = buildRequest(seq, { media, subtitleTracks, sequences }, final);
          let res = await api.startExport(req);
          if (!res.ok && res.code === 'exists') {
            // The output (or its sidecar .srt) is already there: replace it only when the user says so.
            const choice = await confirm({
              type: 'warning', title: 'Replace file?', message: `${res.error} Replace it?`,
              buttons: ['Replace', 'Cancel'], defaultId: 1, cancelId: 1, testId: 'export-replace-confirm',
            });
            if (choice !== 0) return;
            res = await api.startExport({ ...req, overwrite: true });
          }
          if (res.ok) { setFinalJob(null); setPhase({ kind: 'job', jobId: res.jobId, outputPath: res.outputPath, outputPaths: res.outputPaths }); }
          else setStartError(res.error);
        } catch (e) { setStartError(e instanceof Error ? e.message : String(e)); }
        finally { setStarting(false); }
      }}
      onClose={onClose}
    />
  );
}

function shellQuote(a: string): string { return /^[A-Za-z0-9_\-./:=+@,]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`; }

/** The request sent to main: see request.ts (pure, unit-tested). */
function buildRequest(seq: Sequence, project: Parameters<typeof buildExportRequest>[0], settings: ExportSettings): ExportRequest {
  return buildExportRequest(project, seq, settings);
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
  onShowTarget: (target: ChecklistTarget) => void;
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
  const container = exportContainer(settings);
  const cinfo = CONTAINERS[container];
  const audioOnly = cinfo.audioOnly;
  const mp4 = container === 'mp4';
  const vEnc = videoEncoder(settings);
  const perTrackPaths = useMemo(() => perTrackOutputPaths(seq, settings), [seq, settings]);
  const size = estimateFileSize(settings, range.seconds, perTrackPaths?.length || 1);
  const maxCh = useMemo(() => maxSourceChannels(seq, media), [seq, media]);
  const surroundOk = maxCh >= 6;
  const hasSubs = sequenceHasSubtitles(seq);
  const outFps = effectiveExportFps(settings, seq);
  const fpsDiffers = !fpsEquals(outFps, seq.fps);
  /** Output video frames (differs from range.frames when the frame rate is converted). */
  const outFrames = exportOutputFrames(range.frames, seq, settings);
  const outFramesLabel = `${outFrames} fr${fpsDiffers ? ` @ ${fpsLabel(outFps)} fps` : ''}`;
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
    return sampleRateChoices(settings.audioCodec, settings.sampleRate, { container })
      .map((v) => ({ value: String(v), label: `${(v / 1000).toFixed(1).replace(/\.0$/, '')} kHz` }));
  }, [settings.audioCodec, settings.sampleRate, container]);
  const channelsLabel = settings.audioChannels === 6 ? '5.1' : 'Stereo';
  const kHz = `${(settings.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz`;

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
              <dt>Length</dt><dd className="mono">{formatSequenceTimecode(exportRange(seq, { rangeMode: 'entire' }).frames, seq.fps)}</dd>
            </dl>
          </div>
          <div>
            <h4>Output</h4>
            <dl className="xd-kv">
              <dt>Format</dt><dd data-testid="export-summary-format">{cinfo.ext.slice(1).toUpperCase()}{perTrackPaths ? ' · one per track' : ''}</dd>
              <dt>Video</dt><dd>{vEnc ? <>{settings.width}×{settings.height} · {fpsLabel(outFps)} fps · {vEnc.label}</> : 'None (audio only)'}</dd>
              {mp4 ? <><dt>Quality</dt><dd>{settings.qualityMode === 'crf' ? `CRF ${settings.crf} (${crfLabel(settings.crf)})` : `${settings.videoBitrateKbps} kbps`} · {settings.preset}</dd></> : null}
              <dt>Audio</dt><dd>{audioSummary(settings)} · {channelsLabel} · {kHz}</dd>
              <dt>Range</dt><dd>{range.usesInOut ? 'In → Out' : 'Entire sequence'}</dd>
              <dt>Duration</dt><dd className="mono">{formatSequenceTimecode(range.frames, seq.fps)}{audioOnly ? '' : ` · ${outFramesLabel}`}</dd>
              <dt>Est. size</dt><dd data-testid="export-size">{size.approximate ? '≈ ' : ''}{formatBytes(size.bytes)}</dd>
              {perTrackPaths ? (
                <><dt>Files</dt><dd className="wrap xd-path" data-testid="export-files" title={perTrackPaths.join('\n')}>{perTrackPaths.length ? perTrackPaths.map((f) => <div key={f}>{f}</div>) : 'none'}</dd></>
              ) : <><dt>File</dt><dd className="wrap xd-path" title={outPath}>{outPath}</dd></>}
            </dl>
          </div>
          <div>
            <h4>Checks</h4>
            <div className="xd-check" data-testid="export-checklist">
              {checklist.length === 0 ? <div className="xd-check-item info"><CheckCircle2 style={{ color: 'var(--ok)' }} />Ready to export.</div> : null}
              {checklist.map((c, i) => (
                <div key={i} className={`xd-check-item ${c.level}`} data-level={c.level}>
                  {c.level === 'error' ? <XCircle /> : c.level === 'warning' ? <AlertTriangle /> : <Info />}
                  <span>{c.text}{c.target ? (
                    <button type="button" className="xd-check-show" data-testid="export-check-show" title="Select on the timeline and close the dialog" onClick={() => p.onShowTarget(c.target!)}>Show</button>
                  ) : null}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>

        <div className="xd-settings">
          <div className="xd-row">
            <label>Preset</label>
            <div className="ctl">
              {/* First focus: the preset, not a checklist item's "Show" (which comes first in the DOM). */}
              <Select value={presetName} options={presetOptions} data-testid="export-preset" data-autofocus="" style={{ minWidth: 220 }}
                onChange={(name) => { const pr = presets.find((x) => x.name === name); if (pr) { setChosenPreset(pr.name); update(applyPreset(settings, pr)); } }} />
            </div>
          </div>

          <section className="xd-section">
            <h4>Output</h4>
            <div className="xd-row">
              <label>Format</label>
              <div className="ctl">
                <Select value={container} options={FORMAT_OPTIONS} data-testid="export-format" onChange={(v) => update({ container: v })} />
              </div>
            </div>
            <div className="xd-row">
              <label>File name</label>
              <div className="ctl">
                <TextField value={settings.fileName} onChange={(v) => update({ fileName: v })} invalid={!!issueFor('fileName')} title={issueFor('fileName')} data-testid="export-filename" placeholder={`sequence${cinfo.ext}`} />
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
            {audioOnly ? <div className="xd-hint" data-testid="export-audio-only-note">Audio only: {cinfo.ext.slice(1).toUpperCase()} files have no picture.</div> : <>
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
                <Select value={fpsOptionValue(outFps)} options={fpsOptions} onChange={(v) => update({ fps: fpsFromOptionValue(v, seq.fps) })} />
                {fpsDiffers ? <Button size="sm" onClick={() => update({ fps: seq.fps })}>Use {fpsLabel(seq.fps)}</Button> : null}
              </div>
            </div>
            {fpsDiffers ? <div className="xd-row"><span /><span className="xd-hint" data-testid="export-fps-note">{fpsConversionNote(seq.fps, outFps)}</span></div> : null}
            {!mp4 ? <>
              <div className="xd-row">
                <label>Codec</label>
                <div className="ctl"><Select value={intermediateCodec(settings)} options={INTERMEDIATE_OPTIONS} data-testid="export-intermediate-codec" onChange={(v) => update({ intermediateCodec: v })} /></div>
              </div>
              <div className="xd-row">
                <label>Profile</label>
                <div className="ctl">
                  {intermediateCodec(settings) === 'dnxhr'
                    ? <Select value={dnxhrProfile(settings).id} options={DNXHR_OPTIONS} data-testid="export-profile" onChange={(v) => update({ dnxhrProfile: v })} />
                    : <Select value={proresProfile(settings).id} options={PRORES_OPTIONS} data-testid="export-profile" onChange={(v) => update({ proresProfile: v })} />}
                  <span className="xd-hint">{vEnc ? `${vEnc.pixFmt}, every frame a key frame` : ''}</span>
                </div>
              </div>
            </> : <>
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
            </>}
            </>}
          </section>

          <section className="xd-section">
            <h4>Audio</h4>
            {mp4 ? <>
              <div className="xd-row">
                <label>Codec</label>
                <div className="ctl"><Select value={settings.audioCodec} options={AUDIO_CODEC_OPTIONS} onChange={(v) => update({ audioCodec: v })} /></div>
              </div>
              <div className="xd-row">
                <label>Bitrate</label>
                <div className="ctl"><Select value={String(settings.audioBitrateKbps)} options={audioBitrateOptions} onChange={(v) => update({ audioBitrateKbps: Number(v) })} /></div>
              </div>
            </> : (
              <div className="xd-row">
                <label>Codec</label>
                <div className="ctl">
                  <span className="text-sm">{container === 'flac' ? 'FLAC (lossless)' : 'PCM (uncompressed)'}</span>
                  <Select value={String(audioBitDepth(settings))} options={BIT_DEPTH_OPTIONS} data-testid="export-bit-depth" onChange={(v) => update({ audioBitDepth: v === '16' ? 16 : 24 })} />
                </div>
              </div>
            )}
            {audioOnly ? (
              <div className="xd-row">
                <label>Files</label>
                <div className="ctl">
                  <Select value={isPerTrackAudio(settings) ? 'tracks' : 'mix'} options={AUDIO_FILES_OPTIONS} data-testid="export-audio-files" onChange={(v) => update({ audioPerTrack: v === 'tracks' })} />
                  <span className="xd-hint">{isPerTrackAudio(settings) ? 'Each track with its clip and track levels, all the same length.' : 'All audio tracks mixed, as in a video export.'}</span>
                </div>
              </div>
            ) : null}
            <div className="xd-row">
              <label>Channels</label>
              <div className="ctl">
                <Select value={String(settings.audioChannels)} options={[{ value: '2', label: 'Stereo' }, { value: '6', label: '5.1 Surround', disabled: !surroundOk }]}
                  onChange={(v) => update(v === '6' ? (mp4 ? { audioChannels: 6, audioCodec: 'ac3', audioBitrateKbps: Math.max(settings.audioBitrateKbps, 448) } : { audioChannels: 6 }) : { audioChannels: 2 })} />
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
                <span className="xd-hint mono">{formatSequenceTimecode(range.frames, seq.fps)} · {outFramesLabel} · {size.approximate ? '≈ ' : ''}{formatBytes(size.bytes)}</span>
              </div>
            </div>
          </section>

          <section className="xd-section">
            <h4>Subtitles</h4>
            <div className="xd-row">
              <label>Burn in</label>
              <div className="ctl">
                <Toggle checked={settings.burnSubtitles && hasSubs && !audioOnly} disabled={!hasSubs || audioOnly} onChange={(v) => update({ burnSubtitles: v })} label={<span className="text-sm">Render subtitles into the picture</span>} />
              </div>
            </div>
            {audioOnly && hasSubs ? <div className="xd-row"><span /><span className="xd-hint" data-testid="export-burn-in-note">Burn-in needs a picture, so it is off for audio-only formats. A sidecar .srt can still be written.</span></div> : null}
            <div className="xd-row">
              <label>Sidecar</label>
              <div className="ctl">
                <Toggle checked={settings.exportSubtitleSidecar && hasSubs} disabled={!hasSubs} onChange={(v) => update({ exportSubtitleSidecar: v })} label={<span className="text-sm">{perTrackPaths ? 'Export one .srt next to the audio files' : `Export .srt next to the ${audioOnly ? 'audio file' : 'video'}`}</span>} />
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
            ) : <div className="xd-hint">Use “Show FFmpeg command” below to preview the exact command before exporting.{perTrackPaths ? ' A per-track export runs one command per file; the preview shows the first.' : ''}</div>}
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
  /** Every file of a per-track audio export. */
  outputPaths?: string[];
  onClose: () => void;
  onAnother: () => void;
}

function ProgressView({ seq, job, jobId, outputPath, outputPaths, onClose, onAnother }: ProgressViewProps) {
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
          <dt>Output</dt><dd className="wrap xd-path">{outputPaths && outputPaths.length > 1 ? outputPaths.map((f) => <div key={f}>{f}</div>) : outputPath}</dd>
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
          {(() => {
            const files = (job.result as { outputPaths?: string[] } | undefined)?.outputPaths ?? outputPaths;
            return files && files.length > 1
              ? <><dt>Files</dt><dd className="wrap xd-path" data-testid="export-done-files">{files.map((f) => <div key={f}>{f}</div>)}</dd></>
              : <><dt>File</dt><dd className="wrap xd-path">{outputPath}</dd></>;
          })()}
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
