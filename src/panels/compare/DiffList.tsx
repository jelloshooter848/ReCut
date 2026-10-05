/**
 * Two-column structural diff rendering (A | B) with colored rows per DiffKind.
 */
import React from 'react';
import type { Rational } from '@shared/model';
import { formatSequenceTimecode } from '@shared/time';
import type { DiffEntry, DiffKind, DiffResult } from './diff';

export const KIND_LABEL: Record<DiffKind, string> = { same: 'same', moved: 'moved', trimmed: 'trimmed', onlyA: 'only in A', onlyB: 'only in B' };

export interface DiffListProps {
  diff: DiffResult;
  fpsA: Rational;
  fpsB: Rational;
  selectedClipId: string | null;
  onPick: (entry: DiffEntry) => void;
  nameA: string;
  nameB: string;
}

function signed(n: number): string { return n > 0 ? `+${n}` : String(n); }

const Row = React.memo(function Row({ e, fps, selected, onPick }: { e: DiffEntry; fps: Rational; selected: boolean; onPick: (e: DiffEntry) => void }) {
  const detail: string[] = [];
  if (e.positionDelta !== undefined && e.positionDelta !== 0) detail.push(`${signed(e.positionDelta)}f ${e.side === 'A' ? 'in B' : 'in A'}`);
  if (e.kind === 'trimmed') {
    if (e.headDelta) detail.push(`head ${signed(e.headDelta)}f`);
    if (e.tailDelta) detail.push(`tail ${signed(e.tailDelta)}f`);
    if (!e.headDelta && !e.tailDelta) detail.push('speed / rate differs');
  }
  return (
    <div
      className={`cmp-diff-row kind-${e.kind} ${selected ? 'selected' : ''} ${e.enabled ? '' : 'disabled'}`}
      data-testid="diff-row" data-kind={e.kind} data-side={e.side} data-clip={e.clipId}
      title={`${e.name}\n${formatSequenceTimecode(e.start, fps)} – ${formatSequenceTimecode(e.end, fps)}\n${KIND_LABEL[e.kind]}${detail.length ? ` · ${detail.join(', ')}` : ''}${e.enabled ? '' : '\n(disabled)'}`}
      onClick={() => onPick(e)}
    >
      <div className="cmp-diff-main">
        <span className="cmp-diff-name ellipsis">{e.name}</span>
        <span className={`cmp-diff-kind k-${e.kind}`}>{KIND_LABEL[e.kind]}</span>
      </div>
      <div className="cmp-diff-sub mono">
        <span>{formatSequenceTimecode(e.start, fps)}</span>
        {e.trackIndex > 0 ? <span className="text-faint">V{e.trackIndex + 1}</span> : null}
        {detail.length ? <span className="cmp-diff-detail">{detail.join(' · ')}</span> : null}
      </div>
    </div>
  );
});

export function DiffList({ diff, fpsA, fpsB, selectedClipId, onPick, nameA, nameB }: DiffListProps) {
  return (
    <div className="cmp-diff">
      <div className="cmp-diff-col">
        <div className="cmp-diff-colhead"><span className="cmp-side-badge">A</span><span className="ellipsis">{nameA}</span><span className="text-faint ml-auto">{diff.a.length}</span></div>
        {diff.a.length ? diff.a.map((e) => <Row key={e.clipId} e={e} fps={fpsA} selected={e.clipId === selectedClipId} onPick={onPick} />) : <div className="cmp-diff-empty">No video clips</div>}
      </div>
      <div className="cmp-diff-col">
        <div className="cmp-diff-colhead"><span className="cmp-side-badge b">B</span><span className="ellipsis">{nameB}</span><span className="text-faint ml-auto">{diff.b.length}</span></div>
        {diff.b.length ? diff.b.map((e) => <Row key={e.clipId} e={e} fps={fpsB} selected={e.clipId === selectedClipId} onPick={onPick} />) : <div className="cmp-diff-empty">No video clips</div>}
      </div>
    </div>
  );
}
