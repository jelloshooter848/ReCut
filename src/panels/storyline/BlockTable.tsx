/**
 * Story block table: one row per block sorted by start, with inline-editable name and notes.
 */
import React from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import type { Sequence, StoryBlock } from '@shared/model';
import { formatTimecode } from '@shared/time';
import { useStore } from '@/state';
import { TextField } from '@/components/ui/TextField';
import { IconButton } from '@/components/ui/IconButton';
import { blockStats, clipsOverlapping, formatMS } from './util';

export interface BlockTableProps {
  seq: Sequence;
  totalFrames: number;
  palette: Map<string, string>;
  selectedBlockId: string | null;
  onSelectBlock: (id: string | null) => void;
  onEditBlock: (id: string) => void;
}

export function BlockTable({ seq, totalFrames, palette, selectedBlockId, onSelectBlock, onEditBlock }: BlockTableProps) {
  const blocks = [...seq.storyBlocks].sort((a, b) => a.start - b.start);
  const st = () => useStore.getState();
  const rowClick = (b: StoryBlock) => {
    st().setView(seq.id, { inPoint: b.start, outPoint: b.end });
    st().select(clipsOverlapping(seq, b.start, b.end).map((c) => c.id));
    onSelectBlock(b.id);
  };
  const totalBlockFrames = blocks.reduce((n, b) => n + (b.end - b.start), 0);

  return (
    <table className="sl-table" data-testid="storyline-table">
      <thead>
        <tr>
          <th style={{ width: '22%' }}>Block</th>
          <th>Start</th>
          <th>End</th>
          <th>Duration</th>
          <th className="num">% runtime</th>
          <th className="num">Clips</th>
          <th>Characters</th>
          <th style={{ width: '24%' }}>Notes</th>
          <th style={{ width: 54 }} />
        </tr>
      </thead>
      <tbody>
        {blocks.map((b) => {
          const s = blockStats(seq, b, totalFrames);
          return (
            <tr key={b.id} className={b.id === selectedBlockId ? 'selected' : ''} data-testid="story-block-row" onClick={() => rowClick(b)}>
              <td>
                <div className="row gap-6">
                  <span className="sl-dot lg" style={{ background: b.color }} />
                  <TextField size="sm" value={b.name} commitOnBlur selectOnFocus aria-label="Block name" onChange={() => { /* committed below */ }}
                    onCommit={(v) => { const name = v.trim(); if (name && name !== b.name) st().updateStoryBlock(seq.id, b.id, { name }); }}
                    onClick={(e) => e.stopPropagation()} />
                </div>
              </td>
              <td className="mono">{formatTimecode(b.start, seq.fps)}</td>
              <td className="mono">{formatTimecode(b.end, seq.fps)}</td>
              <td className="mono">{formatMS(b.end - b.start, seq.fps)}</td>
              <td className="num mono">
                <div className="sl-pct">
                  <div className="sl-pct-bar" style={{ width: `${Math.min(100, s.percent)}%`, background: b.color }} />
                  <span>{s.percent.toFixed(1)}%</span>
                </div>
              </td>
              <td className="num mono">{s.clipCount}</td>
              <td>
                <div className="row gap-4" style={{ flexWrap: 'wrap' }}>
                  {s.characters.length ? s.characters.map((c) => (
                    <span key={c} className="tag" title={c}><span className="sl-dot" style={{ background: palette.get(c) ?? '#5a5a5a' }} />{c}</span>
                  )) : <span className="text-faint">—</span>}
                </div>
              </td>
              <td>
                <TextField size="sm" value={b.notes} commitOnBlur placeholder="Notes…" aria-label="Block notes" onChange={() => { /* committed below */ }}
                  onCommit={(v) => { if (v !== b.notes) st().updateStoryBlock(seq.id, b.id, { notes: v }); }}
                  onClick={(e) => e.stopPropagation()} />
              </td>
              <td>
                <div className="row gap-2" onClick={(e) => e.stopPropagation()}>
                  <IconButton size="sm" icon={Pencil} label="Edit block" onClick={() => onEditBlock(b.id)} />
                  <IconButton size="sm" icon={Trash2} label="Delete block" onClick={() => { st().removeStoryBlock(seq.id, b.id); if (selectedBlockId === b.id) onSelectBlock(null); }} />
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
      {blocks.length > 1 ? (
        <tfoot>
          <tr>
            <td className="text-dim">{blocks.length} blocks</td>
            <td /><td />
            <td className="mono text-dim">{formatMS(totalBlockFrames, seq.fps)}</td>
            <td className="num mono text-dim">{totalFrames > 0 ? `${Math.min(999, (totalBlockFrames / totalFrames) * 100).toFixed(1)}%` : '—'}</td>
            <td colSpan={4} />
          </tr>
        </tfoot>
      ) : null}
    </table>
  );
}
