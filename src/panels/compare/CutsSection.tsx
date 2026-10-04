/**
 * Alternate cuts management: sequences grouped by lineage, duplicate-as-new-cut, and snapshots of A.
 */
import React, { useMemo, useState } from 'react';
import { Camera, Copy, GitBranch, History, RotateCcw, Trash2 } from 'lucide-react';
import type { ID, Sequence, SequenceSnapshot } from '@shared/model';
import { formatTimecode } from '@shared/time';
import { sequenceDuration } from '@shared/timeline';
import { useStore } from '@/state';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { PromptDialog, ConfirmDialog } from './prompts';

export interface CutsSectionProps {
  sequences: Record<ID, Sequence>;
  order: ID[];
  activeId: ID | null;
  aId: ID | null;
  bId: ID | null;
  /** Snapshot currently loaded as B, if any. */
  bSnapshotId: ID | null;
  onSetA: (id: ID) => void;
  onSetB: (id: ID) => void;
  onCompareSnapshot: (snapshotId: ID | null) => void;
}

interface Lineage { root: Sequence; members: Sequence[] }

export function groupByLineage(sequences: Record<ID, Sequence>, order: ID[]): Lineage[] {
  const list = order.map((id) => sequences[id]).filter((s): s is Sequence => !!s);
  const rootOf = (s: Sequence): Sequence => {
    let cur = s; const seen = new Set<ID>([s.id]);
    while (cur.parentSequenceId && sequences[cur.parentSequenceId] && !seen.has(cur.parentSequenceId)) { cur = sequences[cur.parentSequenceId]; seen.add(cur.id); }
    return cur;
  };
  const groups = new Map<ID, Lineage>();
  for (const s of list) {
    const root = rootOf(s);
    const g = groups.get(root.id) ?? { root, members: [] };
    g.members.push(s);
    groups.set(root.id, g);
  }
  for (const g of groups.values()) g.members.sort((x, y) => (x.id === g.root.id ? -1 : y.id === g.root.id ? 1 : x.createdAt - y.createdAt));
  return [...groups.values()];
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function CutsSection({ sequences, order, activeId, aId, bId, bSnapshotId, onSetA, onSetB, onCompareSnapshot }: CutsSectionProps) {
  const lineages = useMemo(() => groupByLineage(sequences, order), [sequences, order]);
  const seqA = aId ? sequences[aId] ?? null : null;
  const [dupOpen, setDupOpen] = useState(false);
  const [snapOpen, setSnapOpen] = useState(false);
  const [restore, setRestore] = useState<SequenceSnapshot | null>(null);
  const st = () => useStore.getState();

  const duplicate = (v: Record<string, string>) => {
    if (!seqA) return;
    const id = st().duplicateSequence(seqA.id, v.name || `${seqA.name} copy`);
    if (!id) return;
    if (v.version) st().updateSequenceSettings(id, { versionLabel: v.version });
    onSetB(id);
    st().toast('success', `Created "${v.name}" from ${seqA.name}`);
    setDupOpen(false);
  };

  const takeSnapshot = (v: Record<string, string>) => {
    if (!seqA) return;
    const id = st().takeSnapshot(seqA.id, v.name || `Snapshot ${seqA.snapshots.length + 1}`);
    if (id) st().toast('success', 'Snapshot taken');
    setSnapOpen(false);
  };

  return (
    <>
      <div className="cmp-section" data-testid="compare-cuts">
        <div className="cmp-section-head">
          <GitBranch size={12} />
          <span className="grow">Alternate cuts</span>
          <Button size="sm" icon={Copy} disabled={!seqA} data-testid="duplicate-cut" title="Duplicate A as a new alternate cut" onClick={() => setDupOpen(true)}>Duplicate A as new cut…</Button>
        </div>
        <div className="cmp-cuts">
          {lineages.map((g) => (
            <div key={g.root.id} className="cmp-lineage">
              {g.members.map((s) => {
                const isRoot = s.id === g.root.id;
                const dur = sequenceDuration(s);
                return (
                  <div key={s.id} className={`cmp-cut-row ${s.id === activeId ? 'active' : ''}`} data-testid="cut-row" data-seq={s.id} style={{ paddingLeft: isRoot ? 8 : 22 }}
                    title={`${s.name}${s.versionLabel ? ` (${s.versionLabel})` : ''} · ${formatTimecode(dur, s.fps)}${s.parentSequenceId ? `\nderived from ${sequences[s.parentSequenceId]?.name ?? 'missing sequence'}` : ''}`}
                    onDoubleClick={() => st().setActiveSequence(s.id)}>
                    {!isRoot ? <span className="cmp-branch" /> : null}
                    <span className="ellipsis grow">{s.name}</span>
                    {s.versionLabel ? <span className="badge dim">{s.versionLabel}</span> : null}
                    {s.snapshots.length ? <span className="text-faint text-xs" title={`${s.snapshots.length} snapshot(s)`}><History size={10} /> {s.snapshots.length}</span> : null}
                    <span className="mono text-dim text-xs">{formatTimecode(dur, s.fps)}</span>
                    <button type="button" className={`cmp-ab ${s.id === aId ? 'on' : ''}`} title="Use as A" onClick={() => onSetA(s.id)}>A</button>
                    <button type="button" className={`cmp-ab b ${s.id === bId && !bSnapshotId ? 'on' : ''}`} title="Use as B" onClick={() => onSetB(s.id)}>B</button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="cmp-section" data-testid="compare-snapshots">
        <div className="cmp-section-head">
          <Camera size={12} />
          <span className="grow">Snapshots of A{seqA ? <span className="text-dim"> · {seqA.name}</span> : null}</span>
          <Button size="sm" icon={Camera} disabled={!seqA} data-testid="take-snapshot" onClick={() => setSnapOpen(true)}>Take snapshot…</Button>
        </div>
        {!seqA || seqA.snapshots.length === 0 ? (
          <div className="cmp-empty">No snapshots yet. A snapshot freezes the whole cut so you can restore it or compare against it later.</div>
        ) : (
          <div className="cmp-snaps">
            {[...seqA.snapshots].sort((x, y) => y.createdAt - x.createdAt).map((snap) => {
              const comparing = snap.id === bSnapshotId;
              return (
                <div key={snap.id} className={`cmp-snap-row ${comparing ? 'comparing' : ''}`} data-testid="snapshot-row" data-snapshot={snap.id}>
                  <History size={12} className="text-dim" />
                  <div className="col grow" style={{ minWidth: 0 }}>
                    <span className="ellipsis">{snap.name}</span>
                    <span className="text-faint text-xs mono">{fmtDate(snap.createdAt)} · {formatTimecode(sequenceDuration({ ...snap.data, snapshots: [] } as Sequence), snap.data.fps)}</span>
                  </div>
                  <Button size="sm" active={comparing} data-testid="snapshot-compare" title={comparing ? 'Stop comparing with this snapshot' : 'Load this snapshot as B'}
                    onClick={() => onCompareSnapshot(comparing ? null : snap.id)}>{comparing ? 'Comparing' : 'Compare'}</Button>
                  <IconButton size="sm" icon={RotateCcw} label="Restore snapshot" data-testid="snapshot-restore" onClick={() => setRestore(snap)} />
                  <IconButton size="sm" icon={Trash2} label="Delete snapshot" data-testid="snapshot-delete"
                    onClick={() => { st().deleteSnapshot(seqA.id, snap.id); if (comparing) onCompareSnapshot(null); }} />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <PromptDialog open={dupOpen} title="Duplicate A as new cut" submitLabel="Duplicate" testId="duplicate-dialog"
        description={seqA ? <>Creates a copy of <b>{seqA.name}</b> linked to it as an alternate cut and loads it as B.</> : null}
        fields={[
          { key: 'name', label: 'Name', initial: seqA ? `${seqA.name} — alt` : '', required: true },
          { key: 'version', label: 'Version label (optional)', placeholder: seqA ? `v${Object.values(sequences).filter((s) => s.parentSequenceId === seqA.id || s.id === seqA.id).length + 1}` : 'v2' },
        ]}
        onClose={() => setDupOpen(false)} onSubmit={duplicate} />

      <PromptDialog open={snapOpen} title="Take snapshot" submitLabel="Take snapshot" testId="snapshot-dialog"
        fields={[{ key: 'name', label: 'Snapshot name', initial: seqA ? `Snapshot ${seqA.snapshots.length + 1}` : '', required: true }]}
        onClose={() => setSnapOpen(false)} onSubmit={takeSnapshot} />

      <ConfirmDialog open={!!restore} title="Restore snapshot" confirmLabel="Restore" danger testId="restore-dialog"
        message={restore && seqA ? <>Replace the current contents of <b>{seqA.name}</b> with snapshot <b>{restore.name}</b> ({fmtDate(restore.createdAt)})?<br />This is undoable; other snapshots are kept.</> : null}
        onClose={() => setRestore(null)}
        onConfirm={() => { if (restore && seqA) { st().restoreSnapshot(seqA.id, restore.id); st().toast('success', `Restored "${restore.name}"`); } setRestore(null); }} />
    </>
  );
}
