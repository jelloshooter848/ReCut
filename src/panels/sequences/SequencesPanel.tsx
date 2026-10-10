/**
 * Sequences panel (#146): groups of Scene library scenes in story order (an act, a storyline, a set piece). Not
 * timelines: a sequence is placed on a timeline (Insert / Overwrite at Playhead, drag, New Timeline from Sequence).
 */
import React, { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Clapperboard, Film, ListOrdered, ListPlus, Palette, Pencil, Plus, Scissors, Trash2, X } from 'lucide-react';
import type { ID, SceneRecord, SceneSequence } from '@shared/model';
import type { PanelProps } from '@/panels/registry';
import { useStore } from '@/state';
import { setClipDrag } from '@/app/dnd';
import { EmptyState, IconButton, LABEL_COLORS, useContextMenu, type MenuItem } from '@/components/ui';
import { toast } from '@/components/ui/toastStore';
import {
  durationLabel, insertSequenceAtPlayhead, loadSceneInSource, newTimelineFromSequence, nextSequenceName, sequenceDragPayload, sequenceDuration,
  sequenceScenes, sourceLabel,
} from '@/panels/scenes/sceneUtils';
import { NamePromptDialog } from '@/panels/scenes/NamePromptDialog';
import { formatClock } from '@shared/time';

const secondsLabel = (sec: number) => formatClock(Math.max(0, sec), false).replace(/^00:/, '0:');

export function SequencesPanel(_props: PanelProps) {
  const sequencesMap = useStore((s) => s.project.sceneSequences);
  const scenes = useStore((s) => s.project.scenes);
  const media = useStore((s) => s.project.media);
  const selectedSceneIds = useStore((s) => s.ui.selectedSceneIds);
  const hasTimeline = useStore((s) => !!s.project.activeSequenceId);
  const [selected, setSelected] = useState<ID | null>(null);
  const [expanded, setExpanded] = useState<Set<ID>>(() => new Set());
  const [renaming, setRenaming] = useState<ID | null>(null);
  const [newPrompt, setNewPrompt] = useState<ID[] | null>(null);
  const menu = useContextMenu();

  const sequences = useMemo(() => Object.values(sequencesMap ?? {}).sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name)), [sequencesMap]);
  /** Library scenes selected in the Scenes tab, in library order of selection. */
  const pickedScenes = useMemo(() => selectedSceneIds.filter((id) => !!scenes[id]), [selectedSceneIds, scenes]);
  const st = useStore.getState;

  const toggle = (id: ID) => setExpanded((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const moveScene = (q: SceneSequence, i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= q.sceneIds.length) return;
    const ids = [...q.sceneIds];
    [ids[i], ids[j]] = [ids[j], ids[i]];
    st().updateSceneSequence(q.id, { sceneIds: ids });
  };
  const removeScene = (q: SceneSequence, i: number) => st().updateSceneSequence(q.id, { sceneIds: q.sceneIds.filter((_, k) => k !== i) });
  const addPicked = (q: SceneSequence) => {
    if (!pickedScenes.length) { toast.info('Select scenes in the Scenes tab first'); return; }
    st().updateSceneSequence(q.id, { sceneIds: [...q.sceneIds, ...pickedScenes] });
    toast.ok(`Added ${pickedScenes.length} scene${pickedScenes.length === 1 ? '' : 's'} to "${q.name}"`);
  };
  const remove = (q: SceneSequence) => {
    st().removeSceneSequence(q.id);
    if (selected === q.id) setSelected(null);
    toast.ok(`Deleted sequence "${q.name}" (its scenes stay in the library)`);
  };

  const sequenceMenu = (q: SceneSequence): MenuItem[] => {
    const empty = sequenceScenes(q).length === 0;
    return [
      { label: 'Insert at Playhead', icon: Plus, disabled: empty || !hasTimeline, onSelect: () => insertSequenceAtPlayhead(q, 'insert') },
      { label: 'Overwrite at Playhead', icon: Scissors, disabled: empty || !hasTimeline, onSelect: () => insertSequenceAtPlayhead(q, 'overwrite') },
      { label: 'New Timeline from Sequence', icon: Film, disabled: empty, onSelect: () => { newTimelineFromSequence(q); } },
      { separator: true },
      { label: 'Rename', icon: Pencil, shortcut: 'F2', onSelect: () => setRenaming(q.id) },
      { label: 'Set color', icon: Palette, submenu: LABEL_COLORS.map((c) => ({ label: c.name, checked: q.color.toLowerCase() === c.hex.toLowerCase(), onSelect: () => st().updateSceneSequence(q.id, { color: c.hex }) })) },
      {
        label: pickedScenes.length ? `Add ${pickedScenes.length} Selected Scene${pickedScenes.length === 1 ? '' : 's'}` : 'Add Selected Scenes', icon: ListPlus,
        disabled: !pickedScenes.length, title: pickedScenes.length ? undefined : 'Select scenes in the Scenes tab first', onSelect: () => addPicked(q),
      },
      { separator: true },
      { label: 'Delete Sequence', icon: Trash2, shortcut: 'Del', onSelect: () => remove(q) },
    ];
  };
  const sceneMenu = (q: SceneSequence, i: number, sc: SceneRecord): MenuItem[] => [
    { label: 'Load in Source', icon: Film, onSelect: () => loadSceneInSource(sc) },
    { separator: true },
    { label: 'Move Up', icon: ArrowUp, disabled: i === 0, onSelect: () => moveScene(q, i, -1) },
    { label: 'Move Down', icon: ArrowDown, disabled: i >= q.sceneIds.length - 1, onSelect: () => moveScene(q, i, 1) },
    { separator: true },
    { label: 'Remove from Sequence', icon: X, onSelect: () => removeScene(q, i) },
  ];

  const onKeyDown = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const q = selected ? sequencesMap?.[selected] : undefined;
    if (!q) return;
    if (e.key === 'F2') { e.preventDefault(); setRenaming(q.id); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); remove(q); }
    else if (e.key === 'Enter') { e.preventDefault(); toggle(q.id); }
  };

  return (
    <div className="panel" data-testid="sequences-panel" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="toolbar">
        <span className="text-dim text-sm">Groups of scenes, in story order</span>
        <span className="grow" />
        <IconButton size="sm" icon={ListOrdered} disabled={!pickedScenes.length} data-testid="sequence-new-from-selected"
          label={pickedScenes.length ? `New sequence from the ${pickedScenes.length} selected scene${pickedScenes.length === 1 ? '' : 's'}` : 'New sequence from scenes selected in the Scenes tab'}
          onClick={() => setNewPrompt(pickedScenes)} />
      </div>
      <div className="panel-body scroll-y" onClick={(e) => { if (e.target === e.currentTarget) setSelected(null); }}>
        {sequences.length === 0 ? (
          <EmptyState icon={ListOrdered} title="No sequences yet"
            description="A sequence groups scenes into a larger part of the story. Select scenes in the Scenes tab, right-click and choose Make Sequence…" />
        ) : (
          <div className="list">
            {sequences.map((q) => {
              const list = sequenceScenes(q, scenes);
              const open = expanded.has(q.id);
              return (
                <React.Fragment key={q.id}>
                  <div className={['list-item', q.id === selected ? 'selected' : ''].join(' ')} data-testid="sequence-row" data-sequence-id={q.id}
                    style={{ gap: 6, padding: '3px 6px' }} draggable={list.length > 0}
                    onClick={() => setSelected(q.id)} onDoubleClick={() => toggle(q.id)}
                    onContextMenu={(e) => { e.preventDefault(); setSelected(q.id); menu.open(e, sequenceMenu(q)); }}
                    onDragStart={(e) => setClipDrag(e.dataTransfer, sequenceDragPayload(q))}>
                    <button type="button" className="btn-icon btn-sm" aria-label={open ? 'Collapse' : 'Expand'} onClick={(e) => { e.stopPropagation(); toggle(q.id); }}>
                      {open ? <ChevronDown /> : <ChevronRight />}
                    </button>
                    <span className="swatch" style={{ background: q.color, width: 8, height: 8, borderRadius: 2, flexShrink: 0 }} />
                    {renaming === q.id ? (
                      <input className="input grow" autoFocus defaultValue={q.name} data-testid="sequence-rename" spellCheck={false}
                        onFocus={(e) => e.currentTarget.select()} onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { st().updateSceneSequence(q.id, { name: e.currentTarget.value }); setRenaming(null); }
                          else if (e.key === 'Escape') setRenaming(null);
                          e.stopPropagation();
                        }}
                        onBlur={(e) => { st().updateSceneSequence(q.id, { name: e.currentTarget.value }); setRenaming(null); }} />
                    ) : <span className="ellipsis grow" data-testid="sequence-name">{q.name}</span>}
                    <span className="text-faint text-xs" style={{ flexShrink: 0 }} data-testid="sequence-meta">
                      {list.length} scene{list.length === 1 ? '' : 's'} · {secondsLabel(sequenceDuration(q, scenes))}
                    </span>
                  </div>
                  {open ? (list.length === 0
                    ? <div className="text-faint text-sm" style={{ padding: '2px 0 4px 34px' }}>No scenes. Select scenes in the Scenes tab, then right-click › Add Selected Scenes.</div>
                    : q.sceneIds.map((sid, i) => {
                      const sc = scenes[sid];
                      if (!sc) return null;
                      return (
                        <div key={`${q.id}:${sid}`} className="list-item" data-testid="sequence-scene-row" data-scene-id={sid}
                          style={{ gap: 6, padding: '2px 6px 2px 34px' }}
                          onDoubleClick={() => loadSceneInSource(sc)}
                          onContextMenu={(e) => { e.preventDefault(); menu.open(e, sceneMenu(q, i, sc)); }}>
                          <span className="mono text-faint text-xs" style={{ width: 18, textAlign: 'right', flexShrink: 0 }}>{i + 1}</span>
                          <Clapperboard size={12} style={{ flexShrink: 0, color: sc.color }} />
                          <span className="ellipsis grow" title={`${sc.name}\n${sourceLabel(media[sc.mediaId])}`}>{sc.name}</span>
                          <span className="text-faint text-xs" style={{ flexShrink: 0 }}>{durationLabel(sc)}</span>
                          <button type="button" className="btn-icon btn-sm" title="Move up" disabled={i === 0} onClick={() => moveScene(q, i, -1)}><ArrowUp /></button>
                          <button type="button" className="btn-icon btn-sm" title="Move down" disabled={i >= q.sceneIds.length - 1} onClick={() => moveScene(q, i, 1)}><ArrowDown /></button>
                          <button type="button" className="btn-icon btn-sm" title="Remove from sequence" data-testid="sequence-scene-remove" onClick={() => removeScene(q, i)}><X /></button>
                        </div>
                      );
                    })) : null}
                </React.Fragment>
              );
            })}
          </div>
        )}
      </div>
      <div className="panel-footer">
        <span data-testid="sequences-count">{sequences.length} sequence{sequences.length === 1 ? '' : 's'}</span>
        <span className="grow" />
        <span className="text-faint">Drag a sequence to the timeline</span>
      </div>
      <NamePromptDialog open={!!newPrompt} title="New Sequence" label="Sequence name" initial={newPrompt ? nextSequenceName() : ''} confirmLabel="Make Sequence"
        onCancel={() => setNewPrompt(null)}
        onConfirm={(name) => { const ids = newPrompt ?? []; setNewPrompt(null); const id = st().addSceneSequence(name, ids); setSelected(id); setExpanded((c) => new Set(c).add(id)); }} />
    </div>
  );
}
