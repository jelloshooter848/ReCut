/**
 * Transcribe dialog (src/whisper/whisperUi.ts openTranscribeDialog(mediaIds)): speech-to-text with the bundled
 * whisper.cpp engine, for one or several media at once.
 *
 * Lists the project's media with audio (the ones it was opened for checked first, a filter for long lists), the audio
 * stream of each, the model (installed ones; "Manage models…" opens Transcription Models), the spoken language
 * (auto-detect, or the stream's tag when Whisper knows it) and "Translate to English" (off by default; not offered by
 * English-only models). Start queues one 'transcribe' job per checked media and closes the dialog: the jobs show in
 * Jobs and the jobs router adds each track when its job finishes. Nothing is uploaded: the engine runs on this
 * computer and never uses the network.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Mic } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { SearchField } from '@/components/ui/SearchField';
import { toast } from '@/components/ui/toastStore';
import { useJobsStore } from '@/app/jobsStore';
import { useStore } from '@/state';
import { recutApi } from '@/state/mediaActions';
import { formatModelSize, useWhisperStatus } from '@/state/whisperStatus';
import {
  activeTranscribeJob, audioStreamLabel, chooseWhisperModel, closeTranscribeDialog, defaultAudioStream, defaultSpokenLanguage,
  openWhisperModels, transcribeUnavailableReason, useWhisperUi,
} from '@/whisper/whisperUi';
import { WHISPER_LANGUAGES, whisperTrackName } from '@shared/whisper';
import type { ID, MediaItem } from '@shared/model';
import './whisper.css';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const LANGUAGE_OPTIONS = [
  { value: 'auto', label: 'Auto-detect' },
  ...[...WHISPER_LANGUAGES].sort((a, b) => a.name.localeCompare(b.name)).map((l) => ({ value: l.code, label: l.name })),
];

export function TranscribeDialog() {
  const openFor = useWhisperUi((s) => s.transcribeFor);
  const mediaMap = useStore((s) => s.project.media);
  const models = useWhisperStatus((s) => s.models);
  const engine = useWhisperStatus((s) => s.engine);
  const refresh = useWhisperStatus((s) => s.refresh);
  const jobs = useJobsStore((s) => s.jobs);
  const [checked, setChecked] = useState<Set<ID>>(new Set());
  const [streams, setStreams] = useState<Record<ID, number>>({});
  const [model, setModel] = useState<string | null>(null);
  const [lastModel, setLastModel] = useState<string | null | undefined>(undefined);
  const [language, setLanguage] = useState('auto');
  const [languageTouched, setLanguageTouched] = useState(false);
  const [translate, setTranslate] = useState(false);
  const [query, setQuery] = useState('');
  const [starting, setStarting] = useState(false);
  const api = recutApi();

  // Opened-for media first, then every other media with audio.
  const candidates = useMemo((): MediaItem[] => {
    if (!openFor) return [];
    const first = openFor.map((id) => mediaMap[id]).filter((m): m is MediaItem => !!m);
    const rest = Object.values(mediaMap).filter((m) => !openFor.includes(m.id) && (m.probe?.audio.length ?? 0) > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...first, ...rest];
  }, [openFor, mediaMap]);

  useEffect(() => {
    if (!openFor) return;
    setChecked(new Set(openFor.filter((id) => !transcribeUnavailableReason(mediaMap[id]))));
    setStreams({});
    setQuery('');
    setStarting(false);
    setTranslate(false);
    setLanguageTouched(false);
    setModel(null);
    setLastModel(undefined);
    void refresh();
    if (api) api.getPrefs().then((p) => setLastModel(p.whisperLastModel ?? null)).catch(() => setLastModel(null));
    else setLastModel(null);
  }, [openFor]);

  const streamOf = (m: MediaItem): number | undefined => streams[m.id] ?? defaultAudioStream(m)?.index;
  const chosen = candidates.filter((m) => checked.has(m.id) && !transcribeUnavailableReason(m));

  // Default model: the last used / Small / first installed, until the user picks one.
  const defaultModel = useMemo(() => chooseWhisperModel(models, lastModel), [models, lastModel]);
  const installed = (models ?? []).filter((m) => m.installed);
  const selectedModel = model && installed.some((m) => m.id === model) ? model : defaultModel;
  const modelInfo = installed.find((m) => m.id === selectedModel);
  const englishOnly = !!modelInfo?.englishOnly;

  // Default language: the tag every checked stream shares, else auto-detect (until the user picks one).
  const defaultLanguage = useMemo(() => {
    const tags = new Set(chosen.map((m) => defaultSpokenLanguage(m.probe?.audio.find((a) => a.index === streamOf(m)))));
    return tags.size === 1 ? [...tags][0] : 'auto';
  }, [chosen.map((m) => `${m.id}:${streamOf(m)}`).join('|')]);
  const lang = englishOnly ? 'en' : languageTouched ? language : defaultLanguage;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? candidates.filter((m) => m.name.toLowerCase().includes(q)) : candidates;
  }, [candidates, query]);

  if (!openFor) return null;

  const running = chosen.filter((m) => activeTranscribeJob(jobs, m.id, streamOf(m)));
  const blocked = !api ? 'Transcription needs the desktop app.'
    : engine && !engine.version ? (engine.error ?? 'The speech-to-text engine is not available.')
      : chosen.length === 0 ? 'Choose the media to transcribe.'
        : models !== null && installed.length === 0 ? 'Install a transcription model first.'
          : null;
  const canStart = !blocked && !!selectedModel && !starting;

  const start = async () => {
    if (!api || !canStart || !selectedModel) return;
    setStarting(true);
    let queued = 0;
    for (const m of chosen) {
      const streamIndex = streamOf(m);
      if (streamIndex === undefined) continue;
      try {
        await api.startTranscribe({ mediaId: m.id, path: m.path, streamIndex, model: selectedModel, language: lang, translate: translate && !englishOnly });
        queued++;
      } catch (e) {
        toast('error', `Could not start transcribing ${m.name}: ${errText(e)}`);
      }
    }
    api.setPrefs({ whisperLastModel: selectedModel }).catch(() => { /* ignore */ });
    if (queued) toast('info', queued === 1 ? `Transcribing ${chosen[0].name}… (see Jobs)` : `Transcribing ${queued} media… (see Jobs)`);
    closeTranscribeDialog();
  };

  const toggle = (id: ID, on: boolean) => setChecked((prev) => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  const modelOptions = installed.map((m) => ({ value: m.id, label: `${m.name} (${formatModelSize(m.bytes)})` }));
  const exampleName = whisperTrackName(lang === 'auto' ? 'en' : lang, modelInfo?.name ?? 'Small', translate && !englishOnly);

  return (
    <Dialog open title={<span className="row gap-6"><Mic size={14} /> Transcribe with Whisper</span>} onClose={closeTranscribeDialog} width={620}
      className="transcribe-dialog" onSubmit={canStart ? () => { void start(); } : false}
      footer={<>
        <Button variant="ghost" onClick={() => openWhisperModels(selectedModel ?? undefined)} data-testid="transcribe-manage-models">Manage models…</Button>
        <span className="grow" />
        <Button onClick={closeTranscribeDialog}>Cancel</Button>
        <Button variant="primary" disabled={!canStart} onClick={() => { void start(); }} data-testid="transcribe-start" title={blocked ?? undefined}>
          {chosen.length > 1 ? `Transcribe ${chosen.length} media` : 'Transcribe'}
        </Button>
      </>}>
      <div className="col gap-10" data-testid="transcribe-dialog">
        {candidates.length > 6 ? <SearchField value={query} onChange={setQuery} placeholder="Filter media…" size="sm" aria-label="Filter media" /> : null}
        <div className="trx-media" role="list" aria-label="Media to transcribe">
          {candidates.length === 0 ? <div className="text-dim text-sm trx-empty">No media with audio in the project.</div> : null}
          {shown.map((m) => {
            const why = transcribeUnavailableReason(m);
            const audio = m.probe?.audio ?? [];
            const sIdx = streamOf(m);
            const busy = sIdx !== undefined && activeTranscribeJob(jobs, m.id, sIdx);
            return (
              <div key={m.id} className="trx-row" role="listitem" data-transcribe-media={m.id}>
                <label className="row gap-6 trx-name" title={m.path}>
                  <input type="checkbox" checked={checked.has(m.id) && !why} disabled={!!why} onChange={(e) => toggle(m.id, e.target.checked)}
                    data-testid={`transcribe-check-${m.id}`} aria-label={`Transcribe ${m.name}`} />
                  <span className="ellipsis">{m.name}</span>
                </label>
                {why ? <span className="text-faint text-sm">{why}</span>
                  : audio.length > 1 ? (
                    <Select size="sm" value={String(sIdx ?? '')} options={audio.map((a) => ({ value: String(a.index), label: audioStreamLabel(a) }))}
                      onChange={(v) => setStreams((p) => ({ ...p, [m.id]: Number(v) }))} aria-label={`Audio stream of ${m.name}`} className="trx-stream" />
                  ) : <span className="text-dim text-sm ellipsis trx-stream">{audio[0] ? audioStreamLabel(audio[0]) : ''}</span>}
                {busy ? <span className="text-accent-2 text-sm nowrap">transcribing…</span> : null}
              </div>
            );
          })}
        </div>
        <label className="row gap-8 trx-field">
          <span className="text-sm">Model</span>
          {modelOptions.length ? (
            <Select value={selectedModel ?? ''} options={modelOptions} size="sm" className="grow" onChange={(v) => setModel(v || null)}
              data-testid="transcribe-model" aria-label="Whisper model" />
          ) : (
            <span className="row gap-8 grow">
              <span className="text-dim text-sm" data-testid="transcribe-no-model">{models === null ? 'Loading…' : 'No model installed.'}</span>
              {models !== null ? <Button size="sm" onClick={() => openWhisperModels('small')} data-testid="transcribe-install-model">Install a model…</Button> : null}
            </span>
          )}
        </label>
        <label className="row gap-8 trx-field">
          <span className="text-sm">Language</span>
          <Select value={lang} options={englishOnly ? [{ value: 'en', label: 'English' }] : LANGUAGE_OPTIONS} size="sm" className="grow"
            disabled={englishOnly} onChange={(v) => { setLanguage(v); setLanguageTouched(true); }} data-testid="transcribe-language" aria-label="Spoken language" />
        </label>
        <label className="row gap-6 trx-check">
          <input type="checkbox" checked={translate && !englishOnly} disabled={englishOnly} onChange={(e) => setTranslate(e.target.checked)} data-testid="transcribe-translate" />
          <span className="text-sm">Translate the speech to English</span>
        </label>
        {blocked && blocked !== 'Install a transcription model first.' ? <div className="text-sm text-accent-2" data-testid="transcribe-blocked">{blocked}</div> : null}
        {running.length ? <div className="text-sm text-dim">{running.length === 1 ? `${running[0].name} is already being transcribed; starting again joins that job.` : `${running.length} of these are already being transcribed.`}</div> : null}
        <p className="text-dim text-sm trx-note">
          Runs on this computer; nothing is uploaded. Each media gets a subtitle track named “{exampleName}” that Transcript search finds.
          Transcribing takes a while on a CPU (see Jobs); names, songs and overlapping voices may be misheard.
        </p>
      </div>
    </Dialog>
  );
}
