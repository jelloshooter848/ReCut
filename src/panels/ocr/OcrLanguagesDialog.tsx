/**
 * OCR Languages dialog (src/ocr/ocrUi.ts openOcrLanguages()): every installable Tesseract language with its size
 * and state — Installed [Remove], downloading n% [Cancel], or [Install] — plus a search box, Install from file…
 * (for the selected language) and Open folder. Installs run as 'download' jobs in the main process; the jobs router
 * refreshes the list when one settles.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, FileUp, FolderOpen, Languages } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { SearchField } from '@/components/ui/SearchField';
import { toast } from '@/components/ui/toastStore';
import { useJobsStore, isJobActive } from '@/app/jobsStore';
import { recutApi } from '@/state/mediaActions';
import { formatOcrSize, useOcrStatus } from '@/state/ocrStatus';
import { closeOcrLanguages, useOcrUi } from '@/ocr/ocrUi';
import type { JobInfo } from '@shared/model';
import type { OcrLanguageState } from '@shared/ocr';
import { PRODUCT_NAME } from '@shared/productIdentity';
import './ocrLanguages.css';

export const OCR_LANGUAGES_NOTE = `Language data from the Tesseract project (tessdata_fast, Apache-2.0). ${PRODUCT_NAME} downloads a language only when you click Install; reading subtitles then works offline.`;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `dir` + file name with the separator `dir` already uses (the renderer has no path module). */
function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

function LanguageRow({ lang, job, selected, onSelect, busy, setBusy }: {
  lang: OcrLanguageState; job: JobInfo | undefined; selected: boolean; onSelect(): void;
  busy: boolean; setBusy(v: boolean): void;
}) {
  const refresh = useOcrStatus((s) => s.refresh);
  const api = recutApi();
  const downloading = job && isJobActive(job);
  const state = downloading ? 'downloading' : lang.installed ? 'installed' : 'available';
  const pct = job ? Math.round((job.progress || 0) * 100) : 0;

  const install = async () => {
    if (!api) return;
    try {
      await api.ocrInstallLanguage(lang.code);
      await refresh();
    } catch (e) {
      toast('error', `Could not install ${lang.name}: ${errText(e)}`);
    }
  };
  const remove = async () => {
    if (!api) return;
    setBusy(true);
    try {
      const r = await api.ocrRemoveLanguage(lang.code);
      if (!r.ok) toast('error', r.error ?? `Could not remove ${lang.name}`);
      else toast('info', `${lang.name} OCR data removed`);
    } catch (e) {
      toast('error', `Could not remove ${lang.name}: ${errText(e)}`);
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  return (
    <div className={['ocrl-row', selected ? 'selected' : ''].filter(Boolean).join(' ')} data-ocr-lang={lang.code} data-state={state}
      role="option" aria-selected={selected} onClick={onSelect}>
      <span className="ocrl-name ellipsis" title={lang.name}>{lang.name}</span>
      <span className="ocrl-code mono text-faint">{lang.code}</span>
      <span className="ocrl-size mono text-dim">{formatOcrSize(lang.bytes)}</span>
      <span className="ocrl-state" onClick={(e) => e.stopPropagation()}>
        {state === 'downloading' ? (
          <>
            <ProgressBar value={job?.status === 'queued' ? undefined : job?.progress ?? 0} title={job?.message} />
            <span className="mono text-dim ocrl-pct">{job?.status === 'queued' ? 'queued' : `${pct}%`}</span>
            <Button size="sm" variant="ghost" onClick={() => { if (job) void api?.cancelJob(job.id); }}>Cancel</Button>
          </>
        ) : state === 'installed' ? (
          <>
            <span className="text-ok text-sm row gap-4"><Check size={12} /> Installed</span>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void remove(); }}>Remove</Button>
          </>
        ) : (
          <Button size="sm" disabled={!api} onClick={() => { void install(); }}>Install</Button>
        )}
      </span>
    </div>
  );
}

export function OcrLanguagesDialog() {
  const open = useOcrUi((s) => s.languagesOpen);
  const focusCode = useOcrUi((s) => s.focusCode);
  const languages = useOcrStatus((s) => s.languages);
  const loadError = useOcrStatus((s) => s.error);
  const refresh = useOcrStatus((s) => s.refresh);
  const jobs = useJobsStore((s) => s.jobs);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dataDir, setDataDir] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const api = recutApi();

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(focusCode);
    void refresh();
    api?.appInfo().then((i) => setDataDir(i.ocrDataDir)).catch(() => setDataDir(null));
  }, [open, focusCode]);

  useEffect(() => {
    if (!open || !focusCode) return;
    listRef.current?.querySelector(`[data-ocr-lang="${focusCode}"]`)?.scrollIntoView({ block: 'center' });
  }, [open, focusCode, languages]);

  // The live download job per language: the one the main process reports, or the newest active download whose
  // title names the language (covers the moment between Install and the next refresh).
  const jobFor = useMemo(() => {
    const byId = new Map(jobs.map((j) => [j.id, j]));
    return (l: OcrLanguageState): JobInfo | undefined => {
      const j = l.jobId ? byId.get(l.jobId) : undefined;
      if (j) return j;
      return jobs.find((x) => x.kind === 'download' && isJobActive(x) && x.title.startsWith(`Install ${l.name} OCR data`));
    };
  }, [jobs]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = languages ?? [];
    return q ? all.filter((l) => l.name.toLowerCase().includes(q) || l.code.includes(q)) : all;
  }, [languages, query]);

  if (!open) return null;
  const installed = (languages ?? []).filter((l) => l.installed);
  const sel = selected ? (languages ?? []).find((l) => l.code === selected) : undefined;

  const installFromFile = async () => {
    if (!api || !sel) return;
    const [file] = await api.openFiles({
      title: `Install ${sel.name} OCR data from a file (${sel.code}.traineddata)`,
      filters: [{ name: 'Tesseract language data', extensions: ['traineddata'] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (!file) return;
    setBusy(true);
    try {
      const r = await api.ocrInstallLanguageFromFile(sel.code, file);
      if (r.ok) toast('ok', `${sel.name} OCR data installed`);
      else toast('error', r.error ?? `Could not install ${sel.name}`);
    } catch (e) {
      toast('error', `Could not install ${sel.name}: ${errText(e)}`);
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const openFolder = () => {
    if (!api || !dataDir) return;
    // Reveal an installed file when there is one (the folder itself is created with the first install).
    const target = installed.length ? joinPath(dataDir, `${installed[0].code}.traineddata`) : dataDir;
    api.showItemInFolder(target).catch(() => toast('error', 'Could not open the OCR language folder'));
  };

  return (
    <Dialog open title={<span className="row gap-6"><Languages size={14} /> OCR Languages</span>} onClose={closeOcrLanguages} width={600} className="ocrl-dialog"
      footer={<>
        <span className="text-dim text-sm grow">{languages ? `${installed.length} installed` : ''}</span>
        <Button icon={FolderOpen} onClick={openFolder} disabled={!api || !dataDir} title={dataDir ?? undefined}>Open folder</Button>
        <Button icon={FileUp} onClick={() => { void installFromFile(); }} disabled={!api || !sel || busy}
          title={sel ? `Install ${sel.name} from a ${sel.code}.traineddata file you downloaded` : 'Select a language in the list first'}>
          {sel ? `Install ${sel.name} from file…` : 'Install from file…'}
        </Button>
        <Button variant="primary" onClick={closeOcrLanguages}>Done</Button>
      </>}>
      <div className="col gap-8" data-testid="ocr-languages-dialog">
        <p className="ocrl-note text-dim text-sm">{OCR_LANGUAGES_NOTE}</p>
        <SearchField value={query} onChange={setQuery} placeholder="Search languages…" size="sm" aria-label="Search languages" />
        <div className="ocrl-list" ref={listRef} role="listbox" aria-label="OCR languages">
          {!api ? <div className="text-dim text-sm ocrl-empty">OCR languages are available in the desktop app.</div>
            : languages === null ? <div className="text-dim text-sm ocrl-empty">{loadError ? `Could not read the language list: ${loadError}` : 'Loading…'}</div>
              : shown.length === 0 ? <div className="text-dim text-sm ocrl-empty">No language matches “{query}”.</div>
                : shown.map((l) => (
                  <LanguageRow key={l.code} lang={l} job={jobFor(l)} selected={l.code === selected} onSelect={() => setSelected(l.code)} busy={busy} setBusy={setBusy} />
                ))}
        </div>
      </div>
    </Dialog>
  );
}
