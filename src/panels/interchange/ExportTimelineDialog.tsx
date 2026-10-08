/**
 * Export Timeline dialog (File › Export Timeline…, roadmap §10): pick a sequence and an interchange format, see
 * what transfers (the report of `exportTimeline`, shared/interchange) and what does not, then save the file(s)
 * for DaVinci Resolve or another editor, which relinks them to the original media.
 *
 * The report is computed here, in the renderer (exportTimeline is pure), debounced while the project changes. The
 * main process only writes the files (electron/interchange.ts). The open project is never changed.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileOutput, Info } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { toast } from '@/components/ui/toastStore';
import { useStore } from '@/state/store';
import { recutApi } from '@/state/mediaActions';
import { confirm } from '@/app/dialogs/ConfirmDialog';
import { projectSourcePaths } from '@/panels/export/request';
import { formatSequenceTimecode } from '@shared/time';
import { exportTimeline, INTERCHANGE_FORMATS, type InterchangeFormat, type InterchangeResult } from '@shared/interchange';
import { defaultTimelineFileName, groupIssues, interchangeTargets } from './interchangeFiles';
import { closeExportTimelineDialog, useInterchangeUi } from './interchangeUi';
import '@/panels/collect/collect.css';
import './interchange.css';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const FORMATS = Object.keys(INTERCHANGE_FORMATS) as InterchangeFormat[];
/** Wait this long after the last project change before computing the report again. */
const REPORT_DEBOUNCE_MS = 250;

type Report = { ok: true; result: InterchangeResult } | { ok: false; error: string };

function ReportView({ result, fps }: { result: InterchangeResult; fps: Parameters<typeof formatSequenceTimecode>[1] }) {
  const s = result.summary;
  const groups = groupIssues(result.issues);
  return (
    <div className="collect-summary col gap-4" data-testid="interchange-report" aria-live="polite">
      <div className="row gap-6 interchange-summary" data-testid="interchange-summary">
        <span>{plural(s.clips, 'clip')}</span>
        <span className="text-dim">·</span><span>{plural(s.videoTracks, 'video track')}, {plural(s.audioTracks, 'audio track')}</span>
        <span className="text-dim">·</span><span className="mono">{formatSequenceTimecode(s.durationFrames, fps)}</span>
        <span className="text-dim">·</span><span>{plural(s.media, 'media file')}</span>
        {result.files.length > 1 ? <><span className="text-dim">·</span><span>{plural(result.files.length, 'file')}</span></> : null}
      </div>
      {groups.length === 0 ? (
        <div className="row gap-6 text-dim" data-testid="interchange-no-issues"><CheckCircle2 size={13} className="text-ok" /> Everything in this sequence transfers.</div>
      ) : groups.map((g) => (
        <div key={g.severity} className={g.severity === 'warning' ? 'collect-warn' : 'interchange-info'} data-testid={`interchange-issues-${g.severity}`}>
          <div className="row gap-6">
            {g.severity === 'warning' ? <AlertTriangle size={13} /> : <Info size={13} />}
            <span>{g.title} ({g.issues.length})</span>
          </div>
          <ul className="interchange-issues">{g.issues.map((i, n) => <li key={`${i.kind}-${n}`} data-kind={i.kind}>{i.message}</li>)}</ul>
        </div>
      ))}
    </div>
  );
}

export function ExportTimelineDialog() {
  const { open, sequenceId, format } = useInterchangeUi();
  const project = useStore((s) => s.project);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [written, setWritten] = useState<string[] | null>(null);
  const options = useMemo(() => project.sequenceOrder.map((id) => project.sequences[id]).filter(Boolean).map((s) => ({ value: s.id, label: s.name })), [project]);
  const seq = sequenceId ? project.sequences[sequenceId] : undefined;

  useEffect(() => { setWritten(null); setWriteError(null); }, [sequenceId, format]);
  useEffect(() => {
    if (!open || !sequenceId) { setReport(null); return; }
    const t = window.setTimeout(() => {
      try { setReport({ ok: true, result: exportTimeline(project, sequenceId, format) }); }
      catch (e) { setReport({ ok: false, error: errText(e) }); }
    }, REPORT_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [open, project, sequenceId, format]);

  if (!open) return null;
  const info = INTERCHANGE_FORMATS[format];
  const ready = !!seq && report?.ok === true && report.result.files.length > 0 && !busy;

  const doExport = async () => {
    const api = recutApi();
    const proj = useStore.getState().project;
    const s = sequenceId ? proj.sequences[sequenceId] : undefined;
    if (!api || !s) return;
    setWriteError(null);
    let result: InterchangeResult;
    try { result = exportTimeline(proj, s.id, format); } catch (e) { setReport({ ok: false, error: errText(e) }); return; }
    if (!result.files.length) { setWriteError('There is nothing to write for this sequence.'); return; }
    const multi = result.files.length > 1;
    setBusy(true);
    try {
      const picked = await api.saveFile({
        title: multi ? `Export Timeline: base name (one ${info.extension.toUpperCase()} per video track)` : 'Export Timeline',
        defaultPath: defaultTimelineFileName(s.name, info.extension),
        filters: [{ name: info.label, extensions: [info.extension] }],
      });
      if (!picked) return;
      const { folder, names } = interchangeTargets(picked, result.files, info.extension);
      const req = { folder, files: names.map((name, i) => ({ name, contents: result.files[i].contents })), protectedPaths: projectSourcePaths(proj) };
      // One file: the native save dialog already asked before replacing it.
      let res = await api.writeInterchangeFiles({ ...req, overwrite: !multi });
      if (!res.ok && res.code === 'exists') {
        const answer = await confirm({
          type: 'warning', title: 'Replace files?', buttons: ['Replace', 'Cancel'], defaultId: 1, cancelId: 1,
          message: `${plural(res.existing?.length ?? 0, 'file')} with these names already exist${res.existing?.length === 1 ? 's' : ''}. Replace?`,
          detail: (res.existing ?? []).join('\n'),
        });
        if (answer !== 0) return;
        res = await api.writeInterchangeFiles({ ...req, overwrite: true });
      }
      if (!res.ok) { setWriteError(res.error); return; }
      setWritten(res.paths);
      toast('ok', `Exported ${plural(res.paths.length, 'file')}`);
    } catch (e) {
      setWriteError(`Export failed: ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open title={<span className="row gap-6"><FileOutput size={14} /> Export Timeline</span>} onClose={closeExportTimelineDialog} width={620}
      className="interchange-dialog" submitDisabled={!ready}
      footer={<>
        <span className="text-dim text-sm grow">{busy ? 'Exporting…' : ''}</span>
        <Button onClick={closeExportTimelineDialog} data-testid="interchange-cancel">{written ? 'Close' : 'Cancel'}</Button>
        <Button variant="primary" disabled={!ready} onClick={() => { void doExport(); }} data-testid="interchange-export">Export…</Button>
      </>}>
      <div className="col gap-8" data-testid="interchange-dialog">
        <p className="text-dim collect-note">
          Writes the sequence as an editable timeline for DaVinci Resolve or another editor, linked to the original
          media files. In Resolve, use File › Import › Timeline… to open it. This project is not changed.
        </p>
        <label className="row gap-6">
          <span className="collect-k">Sequence</span>
          <Select className="grow" value={sequenceId ?? ''} options={options} aria-label="Sequence"
            onChange={(v) => useInterchangeUi.setState({ sequenceId: v })} data-testid="interchange-sequence" />
        </label>
        <fieldset className="collect-options col gap-6">
          <legend className="interchange-legend">Format</legend>
          {FORMATS.map((f) => (
            <label key={f} className="interchange-format row gap-6">
              <input type="radio" name="interchange-format" value={f} checked={format === f}
                onChange={() => useInterchangeUi.setState({ format: f })} data-testid={`interchange-format-${f}`} />
              <span className="col">
                <span className="text-bright">{INTERCHANGE_FORMATS[f].label}</span>
                <span className="text-dim text-sm">{INTERCHANGE_FORMATS[f].description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {format === 'edl' ? (
          <div className="text-dim text-sm" data-testid="interchange-edl-note">
            An EDL holds one video track: one file is written per video track, named after the base name you choose
            (&lt;name&gt;_V1.edl, &lt;name&gt;_V2.edl…).
          </div>
        ) : null}
        {!report ? <div className="text-dim" data-testid="interchange-checking">Checking…</div> : null}
        {report && !report.ok ? <div className="collect-problem" role="alert" data-testid="interchange-error">Cannot export this sequence: {report.error}</div> : null}
        {report?.ok && seq ? <ReportView result={report.result} fps={seq.fps} /> : null}
        {writeError ? <div className="collect-problem" role="alert" data-testid="interchange-write-error">{writeError}</div> : null}
        {written ? (
          <div className="collect-done col gap-4" data-testid="interchange-done">
            <div className="row gap-6"><CheckCircle2 size={13} className="text-ok" /> Exported {plural(written.length, 'file')}:</div>
            <ul className="interchange-files mono">{written.map((p) => <li key={p} title={p}>{p}</li>)}</ul>
            <div className="row gap-6">
              <Button size="sm" onClick={() => { void recutApi()?.showItemInFolder(written[0]); }} data-testid="interchange-reveal">Show in folder</Button>
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
