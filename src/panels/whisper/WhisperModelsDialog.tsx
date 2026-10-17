/**
 * Transcription Models dialog (File › Transcription Models…, Preferences, the Transcribe dialog): every Whisper model
 * the app can install, with its size, a short note and its state — Installed [Remove], downloading n% [Cancel], a
 * paused partial download [Resume] [Discard], or [Install] — plus the disk space models use, Install from file… (for
 * the selected model) and Open folder. Installs run as 'download' jobs in the main process (resumable, checked against
 * a pinned SHA-256); the jobs router refreshes the list when one settles.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Check, FileUp, FolderOpen } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { toast } from '@/components/ui/toastStore';
import { useJobsStore, isJobActive } from '@/app/jobsStore';
import { recutApi } from '@/state/mediaActions';
import { formatModelSize, modelsDiskUsage, useWhisperStatus } from '@/state/whisperStatus';
import { closeWhisperModels, useWhisperUi, WHISPER_DOWNLOAD_PREFIX } from '@/whisper/whisperUi';
import type { JobInfo } from '@shared/model';
import type { WhisperModelState } from '@shared/whisper';
import { PRODUCT_NAME } from '@shared/productIdentity';
import './whisper.css';

export const WHISPER_MODELS_NOTE = 'Speech recognition models for the built-in whisper.cpp engine (OpenAI Whisper weights, MIT licence). '
  + `${PRODUCT_NAME} downloads a model only when you click Install; transcribing then works offline and nothing is uploaded.`;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `dir` + file name with the separator `dir` already uses (the renderer has no path module). */
function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

function ModelRow({ model, job, selected, onSelect, busy, setBusy }: {
  model: WhisperModelState; job: JobInfo | undefined; selected: boolean; onSelect(): void; busy: boolean; setBusy(v: boolean): void;
}) {
  const refresh = useWhisperStatus((s) => s.refresh);
  const api = recutApi();
  const downloading = job && isJobActive(job);
  const state = downloading ? 'downloading' : model.installed ? 'installed' : model.partialBytes > 0 ? 'partial' : 'available';
  const pct = job ? Math.round((job.progress || 0) * 100) : 0;

  const install = async () => {
    if (!api) return;
    try {
      await api.whisperInstallModel(model.id);
      await refresh();
    } catch (e) {
      toast('error', `Could not install the ${model.name} model: ${errText(e)}`);
    }
  };
  const remove = async () => {
    if (!api) return;
    setBusy(true);
    try {
      const r = await api.whisperRemoveModel(model.id);
      if (!r.ok) toast('error', r.error ?? `Could not remove the ${model.name} model`);
      else toast('info', model.installed ? `${model.name} model removed` : `Partial ${model.name} download discarded`);
    } catch (e) {
      toast('error', `Could not remove the ${model.name} model: ${errText(e)}`);
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  return (
    <div className={['wm-row', selected ? 'selected' : ''].filter(Boolean).join(' ')} data-whisper-model={model.id} data-state={state}
      role="option" aria-selected={selected} onClick={onSelect}>
      <span className="col wm-name">
        <span className="text-bright ellipsis">{model.name}{model.englishOnly ? <span className="text-faint"> · English only</span> : null}</span>
        <span className="text-dim text-sm ellipsis" title={model.note}>{model.note}</span>
      </span>
      <span className="wm-size mono text-dim">{formatModelSize(model.bytes)}</span>
      <span className="wm-state" onClick={(e) => e.stopPropagation()}>
        {state === 'downloading' ? (
          <>
            <ProgressBar value={job?.status === 'queued' ? undefined : job?.progress ?? 0} title={job?.message} />
            <span className="mono text-dim wm-pct">{job?.status === 'queued' ? 'queued' : `${pct}%`}</span>
            <Button size="sm" variant="ghost" onClick={() => { if (job) void api?.cancelJob(job.id); }}>Cancel</Button>
          </>
        ) : state === 'installed' ? (
          <>
            <span className="text-ok text-sm row gap-4"><Check size={12} /> Installed</span>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void remove(); }}>Remove</Button>
          </>
        ) : state === 'partial' ? (
          <>
            <span className="text-dim text-sm nowrap" title="The download stopped part way; Resume continues it">{formatModelSize(model.partialBytes)} so far</span>
            <Button size="sm" disabled={!api} onClick={() => { void install(); }}>Resume</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void remove(); }}>Discard</Button>
          </>
        ) : (
          <Button size="sm" disabled={!api} onClick={() => { void install(); }}>Install</Button>
        )}
      </span>
    </div>
  );
}

export function WhisperModelsDialog() {
  const open = useWhisperUi((s) => s.modelsOpen);
  const focusModel = useWhisperUi((s) => s.focusModel);
  const models = useWhisperStatus((s) => s.models);
  const engine = useWhisperStatus((s) => s.engine);
  const loadError = useWhisperStatus((s) => s.error);
  const refresh = useWhisperStatus((s) => s.refresh);
  const jobs = useJobsStore((s) => s.jobs);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const api = recutApi();

  useEffect(() => {
    if (!open) return;
    setSelected(focusModel);
    void refresh();
  }, [open, focusModel]);

  useEffect(() => {
    if (!open || !focusModel) return;
    listRef.current?.querySelector(`[data-whisper-model="${focusModel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, focusModel, models]);

  // The live download job per model: the one the main process reports, or the newest active download whose title
  // names the model (covers the moment between Install and the next refresh).
  const jobFor = useMemo(() => {
    const byId = new Map(jobs.map((j) => [j.id, j]));
    return (m: WhisperModelState): JobInfo | undefined => {
      const j = m.jobId ? byId.get(m.jobId) : undefined;
      if (j) return j;
      return jobs.find((x) => x.kind === 'download' && isJobActive(x) && x.title.startsWith(`${WHISPER_DOWNLOAD_PREFIX}${m.name} (`));
    };
  }, [jobs]);

  if (!open) return null;
  const installed = (models ?? []).filter((m) => m.installed);
  const sel = selected ? (models ?? []).find((m) => m.id === selected) : undefined;
  const modelsDir = engine?.modelsDir ?? null;

  const installFromFile = async () => {
    if (!api || !sel) return;
    const [file] = await api.openFiles({
      title: `Install the ${sel.name} Whisper model from a file (ggml-${sel.id}.bin)`,
      filters: [{ name: 'Whisper model (ggml)', extensions: ['bin'] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (!file) return;
    setBusy(true);
    toast('info', `Checking ${file.split(/[\\/]/).pop()}…`);
    try {
      const r = await api.whisperInstallModelFromFile(sel.id, file);
      if (r.ok) toast('ok', `${sel.name} model installed`);
      else toast('error', r.error ?? `Could not install the ${sel.name} model`);
    } catch (e) {
      toast('error', `Could not install the ${sel.name} model: ${errText(e)}`);
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const openFolder = () => {
    if (!api || !modelsDir) return;
    const target = installed.length ? joinPath(modelsDir, `ggml-${installed[0].id}.bin`) : modelsDir;
    api.showItemInFolder(target).catch(() => toast('error', 'Could not open the models folder'));
  };

  const usage = modelsDiskUsage(models);

  return (
    <Dialog open title={<span className="row gap-6"><AudioLines size={14} /> Transcription Models</span>} onClose={closeWhisperModels} width={640} className="wm-dialog"
      footer={<>
        <span className="text-dim text-sm grow" data-testid="whisper-disk-usage">{models ? `${installed.length} installed · ${formatModelSize(usage)} on disk` : ''}</span>
        <Button icon={FolderOpen} onClick={openFolder} disabled={!api || !modelsDir} title={modelsDir ?? undefined}>Open folder</Button>
        <Button icon={FileUp} onClick={() => { void installFromFile(); }} disabled={!api || !sel || busy}
          title={sel ? `Install ${sel.name} from a ggml-${sel.id}.bin file you downloaded` : 'Select a model in the list first'}>
          {sel ? `Install ${sel.name} from file…` : 'Install from file…'}
        </Button>
        <Button variant="primary" onClick={closeWhisperModels}>Done</Button>
      </>}>
      <div className="col gap-8" data-testid="whisper-models-dialog">
        <p className="wm-note text-dim text-sm">{WHISPER_MODELS_NOTE}</p>
        {engine && !engine.version ? <div className="text-sm text-accent-2" data-testid="whisper-engine-missing">{engine.error ?? 'The speech-to-text engine is not available.'}</div> : null}
        <div className="wm-list" ref={listRef} role="listbox" aria-label="Transcription models">
          {!api ? <div className="text-dim text-sm wm-empty">Transcription models are available in the desktop app.</div>
            : models === null ? <div className="text-dim text-sm wm-empty">{loadError ? `Could not read the model list: ${loadError}` : 'Loading…'}</div>
              : models.map((m) => (
                <ModelRow key={m.id} model={m} job={jobFor(m)} selected={m.id === selected} onSelect={() => setSelected(m.id)} busy={busy} setBusy={setBusy} />
              ))}
        </div>
        <p className="text-faint text-sm wm-note">
          Bigger models are more accurate, slower and need more memory. Small is a good start; on a CPU, Medium and
          Large v3 Turbo can take longer than the media plays. English-only models are a little more accurate on English.
        </p>
      </div>
    </Dialog>
  );
}
