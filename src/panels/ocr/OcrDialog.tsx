/**
 * Read with OCR dialog (src/ocr/ocrUi.ts openOcrDialog({ mediaId, streamIndex })): turns one bitmap subtitle stream
 * (PGS, VobSub, DVB, XSUB) into a text subtitle track.
 *
 * Shows the stream (format, language tag, title) and a choice of the installed OCR languages. The language guessed
 * from the stream's tag is selected when it is installed, else the last one used, else the first installed. When
 * the guess is not installed, an inline "Install <Language> (x MB)" button downloads it (a 'download' job; progress
 * from the jobs mirror). Start runs an 'ocr' job in the main process and closes the dialog: the job shows in Jobs
 * and the jobs router adds the track when it finishes.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Download, ScanText } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { toast } from '@/components/ui/toastStore';
import { useJobsStore, isJobActive } from '@/app/jobsStore';
import { useStore } from '@/state';
import { recutApi } from '@/state/mediaActions';
import { formatOcrSize, useOcrStatus } from '@/state/ocrStatus';
import {
  activeOcrJob, chooseOcrLanguage, closeOcrDialog, openOcrLanguages, subtitleCodecLabel, useOcrUi, ocrStream,
} from '@/ocr/ocrUi';
import { ocrLanguage } from '@shared/ocr';
import './ocrLanguages.css';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function OcrDialog() {
  const target = useOcrUi((s) => s.ocrTarget);
  const media = useStore((s) => (target ? s.project.media[target.mediaId] : undefined));
  const languages = useOcrStatus((s) => s.languages);
  const refresh = useOcrStatus((s) => s.refresh);
  const jobs = useJobsStore((s) => s.jobs);
  const [lastLanguage, setLastLanguage] = useState<string | null | undefined>(undefined);
  const [code, setCode] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [starting, setStarting] = useState(false);
  const api = recutApi();

  const stream = target ? ocrStream(media, target.streamIndex) : undefined;
  const installed = useMemo(() => (languages ?? []).filter((l) => l.installed).map((l) => l.code), [languages]);
  const choice = useMemo(() => chooseOcrLanguage(stream?.language, installed, lastLanguage), [stream?.language, installed, lastLanguage]);

  useEffect(() => {
    if (!target) return;
    setTouched(false);
    setCode(null);
    setStarting(false);
    setLastLanguage(undefined);
    void refresh();
    if (api) api.getPrefs().then((p) => setLastLanguage(p.ocrLastLanguage ?? null)).catch(() => setLastLanguage(null));
    else setLastLanguage(null);
  }, [target?.mediaId, target?.streamIndex]);

  // Follow the default until the user picks a language (e.g. the guessed language finishes installing).
  useEffect(() => {
    if (!target) return;
    if (!touched || !code || !installed.includes(code)) setCode(choice.code);
  }, [target, choice.code, installed, touched]);

  if (!target) return null;

  const guess = choice.guess ? ocrLanguage(choice.guess) : undefined;
  const guessJob = guess ? jobs.find((j) => j.kind === 'download' && isJobActive(j) && j.title.startsWith(`Install ${guess.name} OCR data`)) : undefined;
  const running = media ? activeOcrJob(jobs, media.id, target.streamIndex) : undefined;
  const selected = code && installed.includes(code) ? code : null;
  const blocked = !api ? 'Reading subtitles with OCR needs the desktop app.'
    : !media ? 'This media is no longer in the project.'
      : media.offline ? 'This media is offline.'
        : !stream ? `Stream #${target.streamIndex} is not a bitmap subtitle stream.`
          : running ? 'This stream is already being read (see Jobs).'
            : languages !== null && installed.length === 0 ? 'Install an OCR language first.'
              : null;
  const canStart = !blocked && !!selected && !starting;

  const installGuess = async () => {
    if (!api || !guess) return;
    try {
      await api.ocrInstallLanguage(guess.code);
      await refresh();
    } catch (e) {
      toast('error', `Could not install ${guess.name}: ${errText(e)}`);
    }
  };

  const start = async () => {
    if (!api || !media || !stream || !selected || !canStart) return;
    setStarting(true);
    try {
      await api.startOcr({ mediaId: media.id, path: media.path, streamIndex: stream.index, language: selected, codec: stream.codec });
      api.setPrefs({ ocrLastLanguage: selected }).catch(() => { /* ignore */ });
      toast('info', `Reading subtitles of ${media.name} #${stream.index} with OCR… (see Jobs)`);
      closeOcrDialog();
    } catch (e) {
      toast('error', `Could not start OCR: ${errText(e)}`);
      setStarting(false);
    }
  };

  const options = (languages ?? []).filter((l) => l.installed).map((l) => ({ value: l.code, label: l.name }));

  return (
    <Dialog open title={<span className="row gap-6"><ScanText size={14} /> Read Subtitles with OCR</span>} onClose={closeOcrDialog} width={480}
      className="ocr-dialog" onSubmit={canStart ? () => { void start(); } : false}
      footer={<>
        <Button variant="ghost" onClick={() => openOcrLanguages(choice.guess ?? selected ?? undefined)} data-testid="ocr-manage-languages">Manage languages…</Button>
        <span className="grow" />
        <Button onClick={closeOcrDialog}>Cancel</Button>
        <Button variant="primary" disabled={!canStart} onClick={() => { void start(); }} data-testid="ocr-start" title={blocked ?? undefined}>Start</Button>
      </>}>
      <div className="col gap-10" data-testid="ocr-dialog">
        <div className="ocr-stream col gap-2">
          <div className="text-bright ellipsis" title={media?.path}>{media?.name ?? 'Missing media'}</div>
          {stream ? (
            <div className="text-dim text-sm" data-testid="ocr-stream-summary">
              Stream #{stream.index} · {subtitleCodecLabel(stream.codec)} image subtitles · {stream.language ? `language tag “${stream.language}”` : 'no language tag'}
              {stream.title ? ` · “${stream.title}”` : ''}
            </div>
          ) : null}
        </div>
        <label className="row gap-8 ocr-lang-row">
          <span className="text-sm">Language</span>
          {options.length ? (
            <Select value={selected ?? ''} options={selected ? options : [{ value: '', label: 'Choose…' }, ...options]} size="sm" className="grow"
              onChange={(v) => { setCode(v || null); setTouched(true); }} data-testid="ocr-language" aria-label="OCR language" />
          ) : (
            <span className="text-dim text-sm grow" data-testid="ocr-no-languages">{languages === null ? 'Loading…' : 'No OCR language installed'}</span>
          )}
        </label>
        {choice.offerInstall && guess ? (
          <div className="row gap-8 ocr-install" data-testid="ocr-install-guess">
            {guessJob ? (
              <>
                <span className="text-sm grow">Installing {guess.name}…</span>
                <ProgressBar value={guessJob.status === 'queued' ? undefined : guessJob.progress ?? 0} title={guessJob.message} />
                <Button size="sm" variant="ghost" onClick={() => { void api?.cancelJob(guessJob.id); }}>Cancel</Button>
              </>
            ) : (
              <>
                <span className="text-dim text-sm grow">{guess.name} is not installed.</span>
                <Button size="sm" icon={Download} disabled={!api} onClick={() => { void installGuess(); }} data-testid="ocr-install">
                  Install {guess.name} ({formatOcrSize(guess.bytes)})
                </Button>
              </>
            )}
          </div>
        ) : null}
        {blocked ? <div className="text-sm text-accent-2" data-testid="ocr-blocked">{blocked}</div> : null}
        <p className="text-dim text-sm ocr-note">
          OCR runs on this computer and adds a subtitle track named “{selected ? `${ocrLanguage(selected)?.name} (OCR #${target.streamIndex})` : `Language (OCR #${target.streamIndex})`}”.
          Italics, coloured text and signs may be read imperfectly; check the lines you rely on.
        </p>
      </div>
    </Dialog>
  );
}
