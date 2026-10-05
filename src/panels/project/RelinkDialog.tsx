import React, { useCallback, useMemo, useState } from 'react';
import { FolderSearch, Link2, Unlink } from 'lucide-react';
import type { ID } from '@shared/model';
import type { RelinkCandidate } from '@shared/ipc';
import { Button, Dialog, EmptyState } from '@/components/ui';
import { toast } from '@/components/ui/toastStore';
import { useStore, recutApi, verifyMediaOnline, fileNameOf } from '@/state';
import { locateMedia, relinkWithPath } from './actions';

/** Bound to ui.dialogs.relink (hosted by App so it works even when the Project panel is hidden): lists offline media, lets the user locate files one by one or scan a folder. */
export function RelinkDialog() {
  const open = useStore((s) => s.ui.dialogs.relink);
  const media = useStore((s) => s.project.media);
  const close = useCallback(() => useStore.getState().closeDialog('relink'), []);
  const offline = useMemo(() => Object.values(media).filter((m) => m.offline).sort((a, b) => a.name.localeCompare(b.name)), [media]);
  const [candidates, setCandidates] = useState<Record<ID, RelinkCandidate>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Set<ID>>(new Set());

  const searchFolder = async () => {
    const api = recutApi();
    if (!api) return;
    const folder = await api.openFolder({ title: 'Search folder for missing media' });
    if (!folder) return;
    setBusy('Scanning…');
    try {
      const found = await api.scanForRelink({ folder, missing: offline.map((m) => ({ mediaId: m.id, fileName: fileNameOf(m.path), size: m.fileSize ?? m.probe?.size })) });
      const next: Record<ID, RelinkCandidate> = { ...candidates };
      for (const c of found) {
        const prev = next[c.missingMediaId];
        if (!prev || (prev.confidence === 'name' && c.confidence === 'name+size')) next[c.missingMediaId] = c;
      }
      setCandidates(next);
      toast(found.length ? 'ok' : 'info', found.length ? `Found ${found.length} match${found.length === 1 ? '' : 'es'}` : 'No matching files in that folder');
    } catch (e) { toast('error', `Scan failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(null); }
  };

  const applyAll = async () => {
    const list = offline.filter((m) => candidates[m.id] && !skipped.has(m.id));
    if (!list.length) return;
    setBusy('Relinking…');
    try { for (const m of list) await relinkWithPath(m.id, candidates[m.id].path); }
    finally { setBusy(null); }
  };

  const recheck = async () => {
    setBusy('Checking files…');
    try { const missing = await verifyMediaOnline(); toast('info', missing.length ? `${missing.length} file${missing.length === 1 ? '' : 's'} still offline` : 'All media online'); }
    finally { setBusy(null); }
  };

  if (!open) return null;
  const matchCount = offline.filter((m) => candidates[m.id] && !skipped.has(m.id)).length;
  return (
    <Dialog open title={<span className="row gap-6"><Link2 size={14} /> Relink offline media</span>} onClose={close} width={560} className="pp-relink"
      footer={<>
        <span className="text-dim text-sm grow">{busy ?? `${offline.length} offline`}</span>
        <Button onClick={recheck} disabled={!!busy}>Check files</Button>
        <Button icon={FolderSearch} onClick={searchFolder} disabled={!!busy || !offline.length}>Search folder…</Button>
        <Button variant="primary" onClick={applyAll} disabled={!!busy || matchCount === 0}>Apply {matchCount ? `${matchCount} ` : ''}match{matchCount === 1 ? '' : 'es'}</Button>
        <Button onClick={close}>Close</Button>
      </>}>
      {offline.length === 0 ? (
        <EmptyState icon={Link2} title="All media is online" description="Nothing to relink." />
      ) : (
        <div className="col" data-testid="relink-list">
          {offline.map((m) => {
            const c = candidates[m.id];
            const isSkipped = skipped.has(m.id);
            return (
              <div key={m.id} className={['pp-relink-row', isSkipped ? 'dim' : ''].join(' ')} data-media-id={m.id}>
                <div className="col gap-2" style={{ minWidth: 0 }}>
                  <div className="row gap-6"><Unlink size={12} className="text-danger" /><span className="ellipsis text-bright">{m.name}</span></div>
                  <div className="path" title={m.path}>{m.path}</div>
                  {c && !isSkipped ? <div className="path cand" title={c.path}>→ {c.path} <span className="pp-badge ok">{c.confidence === 'name+size' ? 'name + size' : 'name'}</span></div> : null}
                </div>
                <div className="actions">
                  <Button size="sm" disabled={!!busy} onClick={() => { void locateMedia(m.id); }}>Locate…</Button>
                  {c && !isSkipped ? <Button size="sm" variant="primary" disabled={!!busy} onClick={() => { void relinkWithPath(m.id, c.path); }}>Use match</Button> : null}
                  <Button size="sm" variant="ghost" onClick={() => setSkipped((s) => { const n = new Set(s); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })}>{isSkipped ? 'Include' : 'Keep offline'}</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
