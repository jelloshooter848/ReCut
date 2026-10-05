/** History panel: undo stack with click-to-jump and clear. */
import React from 'react';
import { History, Trash2 } from 'lucide-react';
import type { PanelProps } from '@/panels/registry';
import { useStore } from '@/state/store';
import { IconButton } from '@/components/ui/IconButton';
import { EmptyState } from '@/components/ui/EmptyState';

/** Jump to a point in history: `steps` < 0 undoes that many times, > 0 redoes. */
export function jumpHistory(steps: number): void {
  const st = useStore.getState();
  if (steps < 0) for (let i = 0; i < -steps; i++) if (!st.undo()) break;
  else for (let i = 0; i < steps; i++) if (!st.redo()) break;
}

export function HistoryPanel(_props: PanelProps) {
  const pastLabels = useStore((s) => s.history.pastLabels);
  const futureLabels = useStore((s) => s.history.futureLabels);
  const total = pastLabels.length + futureLabels.length;
  // Entries in chronological order: past (oldest first), then "current", then future (next redo first).
  const redoOrder = [...futureLabels].reverse();
  return (
    <div className="panel" data-testid="history-panel">
      <div className="toolbar">
        <span className="text-dim text-sm">{pastLabels.length} undoable · {futureLabels.length} redoable</span>
        <span className="grow" />
        <IconButton size="sm" icon={Trash2} label="Clear history" disabled={total === 0} onClick={() => useStore.getState().clearHistory()} data-testid="history-clear" />
      </div>
      <div className="panel-body scroll-y">
        {total === 0 ? <EmptyState icon={History} title="No history" description="Edits you make will be listed here. Click an entry to undo or redo to that point." /> : (
          <div className="list">
            {pastLabels.map((label, i) => {
              const steps = -(pastLabels.length - i);
              return (
                <div key={`p${i}`} className="list-item" data-testid="history-row" title={`Undo ${-steps} step${steps === -1 ? '' : 's'}`} onClick={() => jumpHistory(steps)}>
                  <span className="text-faint mono text-xs" style={{ width: 28 }}>{i + 1}</span>
                  <span className="ellipsis">{label}</span>
                </div>
              );
            })}
            <div className="list-item selected" data-testid="history-current" style={{ fontStyle: 'italic' }}>
              <span className="text-faint mono text-xs" style={{ width: 28 }}>▸</span>
              <span className="ellipsis">Current state</span>
            </div>
            {redoOrder.map((label, i) => (
              <div key={`f${i}`} className="list-item text-dim" data-testid="history-row" title={`Redo ${i + 1} step${i === 0 ? '' : 's'}`} onClick={() => jumpHistory(i + 1)}>
                <span className="text-faint mono text-xs" style={{ width: 28 }}>{pastLabels.length + i + 1}</span>
                <span className="ellipsis">{label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
