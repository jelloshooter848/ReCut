import React, { memo, useEffect, useRef, useState } from 'react';
import { Captions, Eye, EyeOff, Highlighter, Lock, LockOpen } from 'lucide-react';
import type { Track } from '@shared/model';
import { useStore } from '@/state';
import { NumberField } from '@/components/ui/NumberField';
import { openContextMenu, type MenuItem } from '@/components/ui/ContextMenu';
import { useTimelineUi } from './timelineStore';
import { MAX_TRACK_HEIGHT, MIN_TRACK_HEIGHT, dbToLinear, linearToDb } from './viewMath';

export interface TrackHeaderProps {
  seqId: string;
  track: Track;
  top: number;
  height: number;
  /** 1-based display number (V1 / A3). */
  number: number;
  canRemove: boolean;
  /** Stable callback (keeps the memo effective): called with this track's id. */
  onRename: (trackId: string) => void;
}

export const TrackHeader = memo(function TrackHeader({ seqId, track, top, height, number, canRemove, onRename }: TrackHeaderProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(track.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const resize = useRef<{ startY: number; startH: number; pointerId: number } | null>(null);
  useEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select(); } }, [editing]);
  useEffect(() => { setName(track.name); }, [track.name]);

  const flags = (patch: Parameters<ReturnType<typeof useStore.getState>['setTrackFlags']>[2]) => useStore.getState().setTrackFlags(seqId, track.id, patch);
  const isAudio = track.kind === 'audio';
  const label = `${isAudio ? 'A' : 'V'}${number}`;

  const commitName = () => {
    setEditing(false);
    const v = name.trim();
    if (v && v !== track.name) flags({ name: v });
    else setName(track.name);
  };

  // Video tracks stack upwards from the divider (V1 lowest), audio tracks downwards (A1 highest).
  const index = number - 1;
  const aboveIndex = isAudio ? index : index + 1;
  const belowIndex = isAudio ? index + 1 : index;
  const kindLabel = isAudio ? 'Audio' : 'Video';
  const menu = (): MenuItem[] => [
    { heading: `${label} · ${track.name}` },
    { label: 'Rename…', onSelect: () => onRename(track.id) },
    { separator: true },
    { label: `Add ${kindLabel} Track Above`, onSelect: () => useStore.getState().addTrack(seqId, track.kind, aboveIndex) },
    { label: `Add ${kindLabel} Track Below`, onSelect: () => useStore.getState().addTrack(seqId, track.kind, belowIndex) },
    { label: 'Add Video Track', onSelect: () => useStore.getState().addTrack(seqId, 'video') },
    { label: 'Add Audio Track', onSelect: () => useStore.getState().addTrack(seqId, 'audio') },
    { separator: true },
    { label: track.locked ? 'Unlock Track' : 'Lock Track', onSelect: () => flags({ locked: !track.locked }) },
    { label: isAudio ? (track.muted ? 'Unmute' : 'Mute') : (track.muted ? 'Show Track' : 'Hide Track'), onSelect: () => flags({ muted: !track.muted }) },
    ...(isAudio ? [{ label: track.solo ? 'Unsolo' : 'Solo', onSelect: () => flags({ solo: !track.solo }) }] : []),
    { label: track.patched ? 'Unpatch Source' : 'Patch Source Here', onSelect: () => flags({ patched: !track.patched }) },
    { separator: true },
    { label: 'Reset Height', onSelect: () => flags({ height: isAudio ? 48 : 64 }) },
    { label: 'Delete Track', disabled: !canRemove, onSelect: () => useStore.getState().removeTrack(seqId, track.id) },
  ];

  const db = Math.max(-60, Math.min(12, linearToDb(track.volume)));

  return (
    <div
      className={['tl-th', track.kind, track.locked ? 'locked' : ''].filter(Boolean).join(' ')}
      style={{ top, height }} data-track-header={track.id}
      onContextMenu={(e) => { e.preventDefault(); openContextMenu(menu(), e); }}
    >
      <div className="tl-th-row">
        <button type="button" className={['tl-th-btn', 'patch', track.patched ? 'on' : ''].join(' ')} title={track.patched ? 'Source patched here (click to unpatch)' : 'Patch source to this track'}
          onClick={() => flags({ patched: !track.patched })} data-patch>{label}</button>
        <div className="tl-th-name" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
          {editing ? (
            <input ref={inputRef} value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commitName(); else if (e.key === 'Escape') { setName(track.name); setEditing(false); } }} />
          ) : track.name}
        </div>
        <button type="button" className={['tl-th-btn', track.locked ? 'on warn' : ''].join(' ')} title={track.locked ? 'Unlock track' : 'Lock track'} onClick={() => flags({ locked: !track.locked })} data-lock>
          {track.locked ? <Lock /> : <LockOpen />}
        </button>
        {isAudio ? (
          <>
            <button type="button" className={['tl-th-btn', track.muted ? 'on danger' : ''].join(' ')} title="Mute" onClick={() => flags({ muted: !track.muted })} data-mute>M</button>
            <button type="button" className={['tl-th-btn', track.solo ? 'on warn' : ''].join(' ')} title="Solo" onClick={() => flags({ solo: !track.solo })} data-solo>S</button>
          </>
        ) : (
          <button type="button" className={['tl-th-btn', track.muted ? 'on danger' : ''].join(' ')} title={track.muted ? 'Show track output' : 'Hide track output'} onClick={() => flags({ muted: !track.muted })} data-mute>
            {track.muted ? <EyeOff /> : <Eye />}
          </button>
        )}
      </div>
      {isAudio && height >= 44 ? (
        <div className="tl-th-row">
          <NumberField className="tl-th-vol" value={Math.round(db * 10) / 10} min={-60} max={12} step={0.5} precision={1} unit="dB" signed
            defaultValue={0} title="Track volume (drag, double-click to reset)"
            onChange={() => { /* commit only */ }} onCommit={(v) => flags({ volume: dbToLinear(v) })} />
        </div>
      ) : null}
      <div
        className="tl-th-resize" title="Drag to resize track"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault(); e.stopPropagation();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          resize.current = { startY: e.clientY, startH: track.height, pointerId: e.pointerId };
          document.body.classList.add('resizing-v');
        }}
        onPointerMove={(e) => {
          const r = resize.current; if (!r) return;
          const h = Math.max(MIN_TRACK_HEIGHT, Math.min(MAX_TRACK_HEIGHT, Math.round(r.startH + e.clientY - r.startY)));
          useTimelineUi.getState().setLiveHeight(track.id, h);
        }}
        onPointerUp={(e) => {
          const r = resize.current; if (!r) return;
          resize.current = null;
          document.body.classList.remove('resizing-v');
          try { (e.currentTarget as HTMLElement).releasePointerCapture(r.pointerId); } catch { /* ignore */ }
          const h = Math.max(MIN_TRACK_HEIGHT, Math.min(MAX_TRACK_HEIGHT, Math.round(r.startH + e.clientY - r.startY)));
          useTimelineUi.getState().setLiveHeight(track.id, null);
          if (h !== track.height) flags({ height: h });
        }}
        onDoubleClick={() => flags({ height: isAudio ? 48 : 64 })}
      />
    </div>
  );
});

export function SubtitleLaneHeader({ height, count }: { height: number; count: number }) {
  const highlight = useStore((s) => s.project.settings.highlightSpokenWords);
  return (
    <div className="tl-th-sub" style={{ height }} title="Subtitles: the transcript of the clip on screen (green; it follows the visible clip) and imported subtitles (double-click one to open the Subtitles panel)">
      <Captions /> <span>Subtitles</span><span className="text-faint">{count}</span>
      <button type="button" className={['tl-th-btn', 'tl-th-sub-btn', highlight ? 'on' : ''].join(' ')} aria-pressed={highlight} data-highlight-words
        title={highlight ? 'Highlighting the spoken word in the monitors (click to turn off)' : 'Highlight the spoken word in the monitors'}
        onClick={() => useStore.getState().setSettings({ highlightSpokenWords: !highlight })}>
        <Highlighter />
      </button>
    </div>
  );
}

/** Header of a transcript lane (#112): "T1" under A1, with the number of transcript cues on it. */
export function TranscriptLaneHeader({ top, height, number, count }: { top: number; height: number; number: number; count: number }) {
  return (
    <div className="tl-th-sub tl-th-t" style={{ top, height }} title={`Transcript of the clips on A${number} (from their media; transcribe a clip to fill it)`} data-transcript-lane={number}>
      <span className="tl-th-t-name">T{number}</span><span>Transcript</span><span className="text-faint">{count}</span>
    </div>
  );
}
