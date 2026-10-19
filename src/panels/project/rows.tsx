import React, { memo } from 'react';
import { previewPlayable, previewReason } from '@/playback/mediaSource';
import {
  ChevronDown, ChevronRight, Clapperboard, FileQuestion, FileText, Film, Folder, FolderOpen, Image as ImageIcon, Layers, Library, ListVideo, Music, Tv, Unlink,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ID, MediaItem, Rational } from '@shared/model';
import { formatClock, formatSequenceTimecode } from '@shared/time';
import { useStore } from '@/state/store';
import { sequenceDurationOf } from '@/state/selectors';
import { ProgressBar, TextField } from '@/components/ui';
import { useThumb } from './useThumb';
import { useMediaJob } from '@/app/jobsStore';
import { audioSummary, canThumb, dateLabel, mediaDurationLabel, mediaFpsLabel, posterTime, rationalLabel, resolutionLabel, sceneRangeLabel, shortIdentity } from './format';
import type { BinRow, CardsRow, GroupRow, ItemRow, MediaRow, Row, SceneRow, SequenceRow, SortKey } from './tree';
import { expandKey } from './tree';

import { ITEMS_DND_TYPE } from '@/app/dnd';
export { ITEMS_DND_TYPE };
export interface ItemsDragPayload { ids: ID[] }

export interface RowCallbacks {
  onClick(e: React.MouseEvent, row: ItemRow | BinRow | GroupRow): void;
  onOpen(row: ItemRow | BinRow | GroupRow): void;
  onContextMenu(e: React.MouseEvent, row: ItemRow | BinRow | GroupRow): void;
  onToggle(key: string): void;
  onRenameCommit(row: ItemRow | BinRow, name: string): void;
  onRenameCancel(): void;
  onDragStart(e: React.DragEvent, row: ItemRow | BinRow): void;
  onDragEnd(): void;
  /** Bin / root drop target. */
  onDragOverTarget(e: React.DragEvent, key: string): void;
  onDragLeaveTarget(key: string): void;
  onDropTarget(e: React.DragEvent, binId: ID | null, key: string): void;
  onRelink(mediaId: ID): void;
}

export interface RowViewProps {
  row: Row;
  selected: Set<string>;
  renamingKey: string | null;
  dropKey: string | null;
  sort: SortKey;
  cb: RowCallbacks;
}

const INDENT = 12;
const Indent = ({ depth }: { depth: number }) => <span className="pp-indent" style={{ width: 4 + depth * INDENT }} />;

function Chevron({ expanded, visible, onClick }: { expanded: boolean; visible: boolean; onClick: () => void }) {
  return (
    <span className={['pp-chev', visible ? '' : 'hidden-chev'].join(' ')} role="button" aria-label={expanded ? 'Collapse' : 'Expand'} aria-expanded={expanded}
      onClick={(e) => { e.stopPropagation(); onClick(); }} onDoubleClick={(e) => e.stopPropagation()}>
      {expanded ? <ChevronDown /> : <ChevronRight />}
    </span>
  );
}

function kindIcon(m: MediaItem): LucideIcon {
  if (m.offline) return Unlink;
  switch (m.kind) {
    case 'video': return Film;
    case 'audio': return Music;
    case 'image': return ImageIcon;
    case 'subtitle': return FileText;
    default: return FileQuestion;
  }
}

export function Thumb({ media, time, className = '' }: { media: MediaItem; time: number; className?: string }) {
  const url = useThumb(media.path, time, canThumb(media), media.id);
  const Icon = kindIcon(media);
  return <div className={['pp-thumb', className].filter(Boolean).join(' ')}>{url ? <img src={url} alt="" draggable={false} /> : <Icon />}</div>;
}

function RenameField({ value, onCommit, onCancel }: { value: string; onCommit: (v: string) => void; onCancel: () => void }) {
  return (
    <TextField className="pp-rename" size="sm" value={value} onChange={() => { /* local */ }} commitOnBlur selectOnFocus autoFocus
      onCommit={(v) => { const t = v.trim(); if (t && t !== value) onCommit(t); else onCancel(); }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onCancel(); }}
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} data-testid="rename-field" />
  );
}

// ---------------------------------------------------------------- badges

function MediaBadges({ m, onRelink }: { m: MediaItem; onRelink: (id: ID) => void }) {
  const proxyJob = useMediaJob(m.id, 'proxy');
  const sceneJob = useMediaJob(m.id, 'sceneDetect');
  const out: React.ReactNode[] = [];
  if (m.offline) out.push(<span key="off" className="pp-badge danger link" title="File not found — click to relink" onClick={(e) => { e.stopPropagation(); onRelink(m.id); }}>Offline · Relink</span>);
  else if (m.probeError) out.push(<span key="err" className="pp-badge danger" title={`Cannot read this file: ${m.probeError}`} aria-label={`Error: ${m.probeError}`} data-testid="probe-error-badge">Error</span>);
  const p = m.proxy;
  if (p.status === 'queued') out.push(<span key="pq" className="pp-badge running" title="Proxy queued">Proxy ⋯</span>);
  else if (p.status === 'running') {
    const pr = proxyJob?.progress ?? p.progress ?? 0;
    out.push(<span key="pr" className="pp-badge running" title={`Proxy ${Math.round(pr * 100)}%`}>Proxy {Math.round(pr * 100)}%<ProgressBar value={pr} /></span>);
  } else if (p.status === 'ready') out.push(<span key="pok" className="pp-badge ok" title={p.path}>Proxy</span>);
  else if (p.status === 'failed') out.push(<span key="pf" className="pp-badge danger" title={p.error}>Proxy failed</span>);
  else if (m.probe && !previewPlayable(m) && (m.kind === 'video' || m.kind === 'audio')) out.push(<span key="np" className="pp-badge warn" title={previewReason(m) ?? 'Not directly playable; generate a proxy'}>Needs proxy</span>);
  const sd = m.sceneDetectStatus;
  if (sd === 'running') {
    const pr = sceneJob?.progress ?? 0;
    out.push(<span key="sr" className="pp-badge running" title="Detecting shots…">Shots {Math.round(pr * 100)}%<ProgressBar value={sceneJob ? pr : undefined} /></span>);
  } else if (sd === 'failed') out.push(<span key="sf" className="pp-badge danger">Shots failed</span>);
  else if (m.detectedScenes.length) out.push(<span key="sd" className="pp-badge accent" title="Detected shots">{m.detectedScenes.length} shot{m.detectedScenes.length === 1 ? '' : 's'}</span>);
  if (m.subtitleTrackIds.length) out.push(<span key="cc" className="pp-badge" title={`${m.subtitleTrackIds.length} subtitle track(s)`}>CC{m.subtitleTrackIds.length > 1 ? ` ${m.subtitleTrackIds.length}` : ''}</span>);
  return <>{out}</>;
}

function metaLine(m: MediaItem, sort: SortKey): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const ident = shortIdentity(m);
  if (ident) parts.push(<span key="id" className="ident" title={m.identity.series ? `${m.identity.series}${m.identity.title ? ` › ${m.identity.title}` : ''}` : undefined}>{ident}</span>);
  if (!m.probe && !m.probeError && !m.offline) parts.push(<span key="pb">probing…</span>);
  const res = resolutionLabel(m.probe); if (res) parts.push(<span key="res">{res}</span>);
  const fps = mediaFpsLabel(m.probe); if (fps) parts.push(<span key="fps">{fps}</span>);
  const au = audioSummary(m.probe); if (au) parts.push(<span key="au">{au}</span>);
  if (m.probe && !m.probe.video && m.probe.audio.length === 0 && m.probe.subtitles.length) parts.push(<span key="sub">{m.probe.subtitles.length} subtitle stream{m.probe.subtitles.length === 1 ? '' : 's'}</span>);
  if (sort === 'added') parts.push(<span key="dt">{dateLabel(m.addedAt)}</span>);
  if (m.probe?.container) parts.push(<span key="c">{m.probe.container.split(',')[0]}</span>);
  const out: React.ReactNode[] = [];
  parts.forEach((p, i) => { if (i) out.push(<span key={`s${i}`} className="sep">·</span>); out.push(p); });
  return out;
}

// ---------------------------------------------------------------- rows

/**
 * A sequence's duration, read live from the store: the tree's sequence rows are rebuilt only when what else they show
 * changes (name, format, bin, lineage), so a timeline edit re-renders this cell alone. The selector returns a number
 * (cached on the track arrays), so playhead moves and other sequences' edits do not render it.
 */
const SequenceDuration = memo(function SequenceDuration({ id, fps }: { id: ID; fps: Rational }) {
  const frames = useStore((s) => sequenceDurationOf(s.project.sequences[id]));
  return <span className="pp-dur">{formatSequenceTimecode(frames, fps)}</span>;
});

const MediaRowView = memo(function MediaRowView({ row, selected, renaming, cb, sort }: { row: MediaRow; selected: boolean; renaming: boolean; cb: RowCallbacks; sort: SortKey }) {
  const m = row.media;
  const cat = m.category !== 'Other' ? <span className="pp-badge cat" title="Category">{m.category}</span> : null;
  return (
    <div className={['pp-row', selected ? 'selected' : '', m.offline ? 'offline' : ''].filter(Boolean).join(' ')}
      data-row-kind="media" data-media-id={m.id} data-row-key={row.key} title={m.path}
      draggable={!renaming}
      onClick={(e) => cb.onClick(e, row)} onDoubleClick={() => cb.onOpen(row)} onContextMenu={(e) => cb.onContextMenu(e, row)}
      onDragStart={(e) => cb.onDragStart(e, row)} onDragEnd={cb.onDragEnd}>
      <Indent depth={row.depth} />
      <Chevron expanded={row.expanded} visible={m.detectedScenes.length > 0} onClick={() => cb.onToggle(expandKey.scenes(m.id))} />
      <Thumb media={m} time={posterTime(m)} />
      <div className="pp-text">
        <div className="pp-line">
          {renaming ? <RenameField value={m.name} onCommit={(v) => cb.onRenameCommit(row, v)} onCancel={cb.onRenameCancel} /> : <span className="pp-name">{m.name}</span>}
          {cat}
          <MediaBadges m={m} onRelink={cb.onRelink} />
        </div>
        <div className="pp-meta">{metaLine(m, sort)}</div>
      </div>
      <div className="pp-right"><span className="pp-dur">{mediaDurationLabel(m)}</span></div>
    </div>
  );
});

const SceneRowView = memo(function SceneRowView({ row, selected, renaming, cb }: { row: SceneRow; selected: boolean; renaming: boolean; cb: RowCallbacks }) {
  const { media: m, scene: s } = row;
  return (
    <div className={['pp-row', selected ? 'selected' : ''].filter(Boolean).join(' ')} data-row-kind="scene" data-scene-id={s.id} data-media-id={m.id} data-row-key={row.key}
      draggable={!renaming}
      onClick={(e) => cb.onClick(e, row)} onDoubleClick={() => cb.onOpen(row)} onContextMenu={(e) => cb.onContextMenu(e, row)}
      onDragStart={(e) => cb.onDragStart(e, row)} onDragEnd={cb.onDragEnd}>
      <Indent depth={row.depth} />
      <Chevron expanded={false} visible={false} onClick={() => { /* leaf */ }} />
      <Thumb media={m} time={s.start + Math.min(0.5, (s.end - s.start) / 4)} className="scene" />
      <div className="pp-text">
        <div className="pp-line">
          {renaming ? <RenameField value={s.name} onCommit={(v) => cb.onRenameCommit(row, v)} onCancel={cb.onRenameCancel} /> : <span className="pp-name">{s.name}</span>}
          {(s.characters.length || s.tags.length) ? (
            <span className="pp-tags">{[...s.characters, ...s.tags].slice(0, 4).map((t) => <span key={t} className="tag">{t}</span>)}</span>
          ) : null}
        </div>
        <div className="pp-meta"><span className="pp-scene-range">{sceneRangeLabel(s.start, s.end)}</span></div>
      </div>
      <div className="pp-right"><span className="pp-dur">{formatClock(s.end - s.start)}</span></div>
    </div>
  );
});

const SequenceRowView = memo(function SequenceRowView({ row, selected, renaming, cb }: { row: SequenceRow; selected: boolean; renaming: boolean; cb: RowCallbacks }) {
  const s = row.seq;
  const lineage = s.parentSequenceId ? `${s.versionLabel ?? 'v2'} of ${row.parentName ?? 'deleted timeline'}` : s.versionLabel;
  return (
    <div className={['pp-row', selected ? 'selected' : ''].filter(Boolean).join(' ')} data-row-kind="sequence" data-sequence-id={s.id} data-row-key={row.key}
      draggable={!renaming}
      onClick={(e) => cb.onClick(e, row)} onDoubleClick={() => cb.onOpen(row)} onContextMenu={(e) => cb.onContextMenu(e, row)}
      onDragStart={(e) => cb.onDragStart(e, row)} onDragEnd={cb.onDragEnd}>
      <Indent depth={row.depth} />
      <Chevron expanded={false} visible={false} onClick={() => { /* leaf */ }} />
      <Layers className="pp-icon" />
      {renaming ? <RenameField value={s.name} onCommit={(v) => cb.onRenameCommit(row, v)} onCancel={cb.onRenameCancel} /> : <span className="pp-name">{s.name}</span>}
      {lineage ? <span className="pp-badge accent" title="Alternate cut lineage">{lineage}</span> : null}
      <span className="pp-meta" style={{ flex: '0 4 auto', marginLeft: 6 }} title={`${s.width}×${s.height} @ ${rationalLabel(s.fps)} fps`}>{rationalLabel(s.fps)} fps</span>
      <div className="pp-right"><SequenceDuration id={s.id} fps={s.fps} /></div>
    </div>
  );
});

function binIcon(kind: BinRow['bin']['kind'], expanded: boolean): LucideIcon {
  switch (kind) {
    case 'series': return Tv;
    case 'season': return ListVideo;
    case 'collection': return Library;
    default: return expanded ? FolderOpen : Folder;
  }
}

const BinRowView = memo(function BinRowView({ row, selected, renaming, dropOver, cb }: { row: BinRow; selected: boolean; renaming: boolean; dropOver: boolean; cb: RowCallbacks }) {
  const b = row.bin;
  const Icon = binIcon(b.kind, row.expanded);
  return (
    <div className={['pp-row', 'pp-group', selected ? 'selected' : '', dropOver ? 'drop-over' : ''].filter(Boolean).join(' ')} data-row-kind="bin" data-bin-id={b.id} data-row-key={row.key}
      draggable={!renaming}
      onClick={(e) => cb.onClick(e, row)} onDoubleClick={() => cb.onOpen(row)} onContextMenu={(e) => cb.onContextMenu(e, row)}
      onDragStart={(e) => cb.onDragStart(e, row)} onDragEnd={cb.onDragEnd}
      onDragOver={(e) => cb.onDragOverTarget(e, row.key)} onDragLeave={() => cb.onDragLeaveTarget(row.key)} onDrop={(e) => cb.onDropTarget(e, b.id, row.key)}>
      <Indent depth={row.depth} />
      <Chevron expanded={row.expanded} visible onClick={() => cb.onToggle(expandKey.bin(b.id))} />
      <Icon className="pp-icon" style={b.color ? { color: b.color } : undefined} />
      {renaming ? <RenameField value={b.name} onCommit={(v) => cb.onRenameCommit(row, v)} onCancel={cb.onRenameCancel} /> : <span className="pp-name">{b.name}</span>}
      <span className="pp-count">{row.count}</span>
    </div>
  );
});

function groupIcon(kind: GroupRow['groupKind']): LucideIcon {
  switch (kind) {
    case 'series': return Tv;
    case 'season': return ListVideo;
    case 'collection': return Library;
    case 'sequences': return Layers;
    case 'loose': return Clapperboard;
    default: return FolderOpen;
  }
}

const GroupRowView = memo(function GroupRowView({ row, dropOver, cb }: { row: GroupRow; dropOver: boolean; cb: RowCallbacks }) {
  const Icon = groupIcon(row.groupKind);
  const isRoot = row.groupKind === 'root';
  return (
    <div className={['pp-row', 'pp-group', dropOver ? 'drop-over' : ''].filter(Boolean).join(' ')} data-row-kind="group" data-group-id={row.id} data-group-kind={row.groupKind} data-row-key={row.key}
      onClick={(e) => cb.onClick(e, row)} onDoubleClick={() => cb.onOpen(row)} onContextMenu={(e) => cb.onContextMenu(e, row)}
      onDragOver={isRoot ? (e) => cb.onDragOverTarget(e, row.key) : undefined} onDragLeave={isRoot ? () => cb.onDragLeaveTarget(row.key) : undefined}
      onDrop={isRoot ? (e) => cb.onDropTarget(e, null, row.key) : undefined}>
      <Indent depth={row.depth} />
      <Chevron expanded={row.expanded} visible onClick={() => cb.onToggle(expandKey.group(row.id))} />
      <Icon className="pp-icon" />
      <span className="pp-name">{row.label}</span>
      <span className="pp-count">{row.count}</span>
    </div>
  );
});

// ---------------------------------------------------------------- grid cards

const Card = memo(function Card({ row, selected, renaming, cb }: { row: ItemRow; selected: boolean; renaming: boolean; cb: RowCallbacks }) {
  const common = {
    draggable: !renaming,
    onClick: (e: React.MouseEvent) => cb.onClick(e, row), onDoubleClick: () => cb.onOpen(row), onContextMenu: (e: React.MouseEvent) => cb.onContextMenu(e, row),
    onDragStart: (e: React.DragEvent) => cb.onDragStart(e, row), onDragEnd: cb.onDragEnd,
  };
  if (row.kind === 'media') {
    const m = row.media;
    return (
      <div className={['pp-card', selected ? 'selected' : '', m.offline ? 'offline' : ''].filter(Boolean).join(' ')} data-row-kind="media" data-media-id={m.id} data-row-key={row.key} title={m.path} {...common}>
        <Thumb media={m} time={posterTime(m)} />
        {renaming ? <RenameField value={m.name} onCommit={(v) => cb.onRenameCommit(row, v)} onCancel={cb.onRenameCancel} /> : <div className="pp-card-name">{m.name}</div>}
        <div className="pp-card-meta"><span className="ellipsis">{shortIdentity(m) || resolutionLabel(m.probe)}</span><span className="pp-dur">{mediaDurationLabel(m)}</span></div>
      </div>
    );
  }
  if (row.kind === 'scene') {
    const { media: m, scene: s } = row;
    return (
      <div className={['pp-card', selected ? 'selected' : ''].filter(Boolean).join(' ')} data-row-kind="scene" data-scene-id={s.id} data-media-id={m.id} data-row-key={row.key} {...common}>
        <Thumb media={m} time={s.start + Math.min(0.5, (s.end - s.start) / 4)} className="scene" />
        {renaming ? <RenameField value={s.name} onCommit={(v) => cb.onRenameCommit(row, v)} onCancel={cb.onRenameCancel} /> : <div className="pp-card-name">{s.name}</div>}
        <div className="pp-card-meta"><span className="pp-scene-range ellipsis">{formatClock(s.start)}</span><span className="pp-dur">{formatClock(s.end - s.start)}</span></div>
      </div>
    );
  }
  const s = row.seq;
  return (
    <div className={['pp-card', selected ? 'selected' : ''].filter(Boolean).join(' ')} data-row-kind="sequence" data-sequence-id={s.id} data-row-key={row.key} {...common}>
      <div className="pp-thumb"><Layers /></div>
      {renaming ? <RenameField value={s.name} onCommit={(v) => cb.onRenameCommit(row, v)} onCancel={cb.onRenameCancel} /> : <div className="pp-card-name">{s.name}</div>}
      <div className="pp-card-meta"><span className="ellipsis">{rationalLabel(s.fps)} fps</span><SequenceDuration id={s.id} fps={s.fps} /></div>
    </div>
  );
});

const CardsRowView = memo(function CardsRowView({ row, selected, renamingKey, cb }: { row: CardsRow; selected: Set<string>; renamingKey: string | null; cb: RowCallbacks }) {
  return (
    <div className="pp-cards" style={{ paddingLeft: 6 + row.depth * INDENT }}>
      {row.items.map((it) => {
        const id = it.kind === 'media' ? it.media.id : it.kind === 'scene' ? it.scene.id : it.seq.id;
        return <Card key={it.key} row={it} selected={selected.has(id)} renaming={renamingKey === it.key} cb={cb} />;
      })}
    </div>
  );
});

// ---------------------------------------------------------------- dispatcher

/** Memoised: the rows keep their identity across tree rebuilds (tree.ts reuseRows), so unchanged rows skip. */
export const RowView = memo(function RowView({ row, selected, renamingKey, dropKey, sort, cb }: RowViewProps) {
  switch (row.kind) {
    case 'media': return <MediaRowView row={row} selected={selected.has(row.media.id)} renaming={renamingKey === row.key} cb={cb} sort={sort} />;
    case 'scene': return <SceneRowView row={row} selected={selected.has(row.scene.id)} renaming={renamingKey === row.key} cb={cb} />;
    case 'sequence': return <SequenceRowView row={row} selected={selected.has(row.seq.id)} renaming={renamingKey === row.key} cb={cb} />;
    case 'bin': return <BinRowView row={row} selected={selected.has(row.bin.id)} renaming={renamingKey === row.key} dropOver={dropKey === row.key} cb={cb} />;
    case 'group': return <GroupRowView row={row} dropOver={dropKey === row.key} cb={cb} />;
    case 'cards': return <CardsRowView row={row} selected={selected} renamingKey={renamingKey} cb={cb} />;
  }
});
