import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Captions, Download, Eraser, Eye, EyeOff, FileUp, ListPlus, LocateFixed, Merge, Minus, Plus, Scissors, Trash2 } from 'lucide-react';
import type { ID, Sequence, SequenceSubtitleCue } from '../../../shared/model';
import { formatTimecode, secondsToFrames } from '../../../shared/time';
import { allTracks, type ResolvedCue } from '../../../shared/timeline';
import { useStore, recutApi } from '@/state';
import { Button, EmptyState, IconButton, MenuButton, Select, toast, type MenuItem } from '@/components/ui';
import type { PanelProps } from '../registry';
import { VirtualList, type VirtualListHandle } from '../transcript/VirtualList';
import { exportSubtitlesDialog, importSubtitlesToTrack, orphanCues, removeOrphanCues, resolveAllTracks } from './exportSubtitles';

const ROW_H = 64;

function CueText({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [local, setLocal] = useState(value);
  useEffect(() => { setLocal(value); }, [value]);
  const commit = () => { if (local !== value) onCommit(local); };
  return (
    <textarea
      className="input st-text" value={local} spellCheck={false} data-testid="subtitle-cue-text"
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); e.currentTarget.blur(); }
        else if (e.key === 'Escape') { setLocal(value); e.currentTarget.blur(); }
      }}
    />
  );
}

interface RowProps {
  seq: Sequence; cue: ResolvedCue; raw: SequenceSubtitleCue | undefined; next: ResolvedCue | undefined; originLabel: string;
  current: boolean; playhead: number;
}

function CueRow({ seq, cue, raw, next, originLabel, current, playhead }: RowProps) {
  const st = useStore.getState;
  const fps = seq.fps;
  const nudge = (dir: 1 | -1, e: React.MouseEvent) => {
    e.stopPropagation();
    st().updateCue(seq.id, cue.id, { offset: (raw?.offset ?? 0) + dir * (e.shiftKey ? 10 : 1) });
  };
  const canSplit = playhead > cue.start && playhead < cue.end;
  return (
    <div className={['st-row', current ? 'current' : ''].filter(Boolean).join(' ')} data-testid="subtitle-cue" data-cue-id={cue.id}
      onClick={() => st().setView(seq.id, { playhead: cue.start })}>
      <div className="st-tc mono">
        <span className="st-tc-start" title="Start" data-testid="subtitle-cue-start">{formatTimecode(cue.start, fps)}</span>
        <span className="st-tc-end text-dim" title="End">{formatTimecode(cue.end, fps)}</span>
        <span className="st-tc-dur text-faint" title="Duration">{cue.end - cue.start}f{raw?.offset ? ` · ${raw.offset > 0 ? '+' : ''}${raw.offset}` : ''}</span>
      </div>
      <CueText value={cue.text} onCommit={(text) => st().updateCue(seq.id, cue.id, { text })} />
      <div className="st-side" onClick={(e) => e.stopPropagation()}>
        <span className={['st-origin', 'ellipsis', cue.clipId ? 'clip' : 'manual'].join(' ')} title={cue.clipId ? `Attached to clip "${originLabel}"` : 'Manual cue'}>{originLabel}</span>
        <div className="row gap-0">
          <IconButton size="sm" icon={Minus} label="Nudge earlier (−1 frame, Shift −10)" onClick={(e) => nudge(-1, e)} />
          <IconButton size="sm" icon={Plus} label="Nudge later (+1 frame, Shift +10)" onClick={(e) => nudge(1, e)} />
          <IconButton size="sm" icon={Scissors} label="Split at playhead" disabled={!canSplit} onClick={() => st().splitCue(seq.id, cue.id, playhead)} />
          <IconButton size="sm" icon={Merge} label="Merge with next" disabled={!next} onClick={() => next && st().mergeCues(seq.id, [cue.id, next.id])} />
          <IconButton size="sm" icon={Trash2} label="Delete cue" onClick={() => st().removeCue(seq.id, cue.id)} />
        </div>
      </div>
    </div>
  );
}

export function SubtitlesPanel({ active }: PanelProps) {
  const seq = useStore((s) => (s.project.activeSequenceId ? s.project.sequences[s.project.activeSequenceId] ?? null : null));
  const [trackId, setTrackId] = useState<ID>('');
  const [follow, setFollow] = useState(true);
  const listRef = useRef<VirtualListHandle>(null);
  const tracks = seq?.subtitleTracks ?? [];
  useEffect(() => { if (!tracks.some((t) => t.id === trackId)) setTrackId(tracks[0]?.id ?? ''); }, [tracks, trackId]);
  const track = tracks.find((t) => t.id === trackId) ?? tracks[0];

  const resolved = useMemo(() => (seq && track ? resolveAllTracks(seq).filter((c) => c.trackId === track.id) : []), [seq, track]);
  const rawById = useMemo(() => { const m = new Map<ID, SequenceSubtitleCue>(); for (const c of track?.cues ?? []) m.set(c.id, c); return m; }, [track]);
  const clipNames = useMemo(() => { const m = new Map<ID, string>(); if (seq) for (const t of allTracks(seq)) for (const c of t.clips) m.set(c.id, c.name); return m; }, [seq]);
  const orphans = useMemo(() => (seq ? orphanCues(seq) : []), [seq]);
  const playhead = seq?.view.playhead ?? 0;
  const currentIndex = useMemo(() => resolved.findIndex((c) => c.start <= playhead && c.end > playhead), [resolved, playhead]);

  useEffect(() => { if (follow && active && currentIndex >= 0) listRef.current?.scrollToIndex(currentIndex); }, [currentIndex, follow, active]);

  const addTrack = useCallback(() => {
    if (!seq) return;
    const id = useStore.getState().addSequenceSubtitleTrack(seq.id, { name: `Subtitles ${tracks.length + 1}`, language: 'und' });
    if (id) setTrackId(id);
  }, [seq, tracks.length]);

  const addCueAtPlayhead = useCallback(() => {
    if (!seq) return;
    let tid: ID | undefined = track?.id;
    if (!tid) { tid = useStore.getState().addSequenceSubtitleTrack(seq.id, { name: 'Subtitles 1', language: 'und' }) ?? undefined; if (tid) setTrackId(tid); }
    if (!tid) return;
    useStore.getState().addManualCue(seq.id, tid, { start: seq.view.playhead, duration: secondsToFrames(2, seq.fps), text: 'New subtitle' });
  }, [seq, track]);

  const importToTrack = useCallback(async () => {
    const api = recutApi();
    if (!seq || !api) return;
    let tid: ID | undefined = track?.id;
    if (!tid) { tid = useStore.getState().addSequenceSubtitleTrack(seq.id, { name: 'Subtitles 1', language: 'und' }) ?? undefined; if (tid) setTrackId(tid); }
    if (!tid) return;
    const paths = await api.openFiles({ title: 'Import subtitles to track', multi: false, filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }] });
    if (!paths?.[0]) return;
    const res = await importSubtitlesToTrack({ seqId: seq.id, trackId: tid, path: paths[0] });
    if (res.ok) toast.ok(`Imported ${res.count} cue${res.count === 1 ? '' : 's'}`); else toast.error(`Import failed: ${res.error}`);
    if (res.warnings.length) toast.warn(`${res.warnings.length} warning${res.warnings.length === 1 ? '' : 's'}: ${res.warnings.slice(0, 2).join('; ')}`);
  }, [seq, track]);

  const doExport = useCallback(async (format: 'srt' | 'vtt') => {
    if (!seq) return;
    const res = await exportSubtitlesDialog(seq.id, format, track?.id);
    if (!res) return;
    if (res.ok) toast.ok(`Exported ${res.count} cue${res.count === 1 ? '' : 's'} to ${res.path}`); else toast.error(`Export failed: ${res.error}`);
  }, [seq, track]);

  const exportItems = useMemo((): MenuItem[] => [
    { label: 'Export SRT…', icon: Download, disabled: !track, onSelect: () => { void doExport('srt'); } },
    { label: 'Export VTT…', icon: Download, disabled: !track, onSelect: () => { void doExport('vtt'); } },
    { separator: true },
    { label: 'Import to track…', icon: FileUp, onSelect: () => { void importToTrack(); } },
  ], [track, doExport, importToTrack]);

  if (!seq) return <div className="panel"><EmptyState icon={Captions} title="No active sequence" description="Open or create a sequence to manage its subtitles." /></div>;

  const trackOptions = tracks.map((t) => ({ value: t.id, label: `${t.name}${t.language && t.language !== 'und' ? ` (${t.language})` : ''}${t.enabled ? '' : ' — off'}` }));

  return (
    <div className="panel st-panel" data-testid="subtitles-panel">
      <div className="toolbar">
        {tracks.length > 0 ? (
          <Select size="sm" className="grow" value={track?.id ?? ''} options={trackOptions} onChange={setTrackId} title="Subtitle track" data-testid="subtitle-track-select" />
        ) : <span className="text-dim text-sm grow px-6">No subtitle tracks</span>}
        {track ? <IconButton size="sm" icon={track.enabled ? Eye : EyeOff} label={track.enabled ? 'Track enabled (click to disable)' : 'Track disabled (click to enable)'} toggled={track.enabled} onClick={() => useStore.getState().toggleSubtitleTrack(seq.id, track.id)} /> : null}
        <IconButton size="sm" icon={Plus} label="Add subtitle track" onClick={addTrack} />
        <IconButton size="sm" icon={Trash2} label="Remove subtitle track" disabled={!track} onClick={() => track && useStore.getState().removeSequenceSubtitleTrack(seq.id, track.id)} />
        <span className="sep" />
        <IconButton size="sm" icon={LocateFixed} label="Follow playhead" toggled={follow} onClick={() => setFollow((v) => !v)} />
        <MenuButton size="sm" variant="ghost" icon={Download} label="Export" items={exportItems} />
      </div>
      <div className="toolbar st-sub">
        <Button size="sm" icon={ListPlus} onClick={addCueAtPlayhead} title="Add a 2-second manual cue at the playhead">Add cue at playhead</Button>
        <span className="text-dim text-sm ml-auto nowrap" data-testid="subtitle-count">{resolved.length} cue{resolved.length === 1 ? '' : 's'}</span>
        {orphans.length ? (
          <>
            <span className="badge warn" title="Cues attached to clips that are no longer in the sequence">{orphans.length} orphan{orphans.length === 1 ? '' : 's'}</span>
            <Button size="sm" icon={Eraser} onClick={() => { const n = removeOrphanCues(seq.id); if (n) toast.ok(`Removed ${n} orphan cue${n === 1 ? '' : 's'}`); }} title="Delete cues whose clips were removed">Clean up</Button>
          </>
        ) : null}
      </div>
      {resolved.length === 0 ? (
        <EmptyState icon={Captions} title={track ? 'No cues on this track' : 'No subtitle tracks'}
          description={track ? 'Insert clips from media with transcripts (cues are carried along), add a cue at the playhead, or import an SRT to this track.' : 'Add a track, or insert a clip from media that has subtitles — a track is created automatically.'}
          action={!track ? <Button size="sm" icon={Plus} onClick={addTrack}>Add track</Button> : undefined} />
      ) : (
        <VirtualList ref={listRef} className="st-list grow" items={resolved} itemHeight={ROW_H} itemKey={(c) => c.id}
          render={(c, i) => (
            <CueRow seq={seq} cue={c} raw={rawById.get(c.id)} next={resolved[i + 1]} playhead={playhead} current={i === currentIndex}
              originLabel={c.clipId ? clipNames.get(c.clipId) ?? 'clip' : 'manual'} />
          )} />
      )}
    </div>
  );
}
