import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Brackets, FileText, LocateFixed, X } from 'lucide-react';
import type { SubtitleCue } from '../../../shared/model';
import { useStore, mediaSubtitleTracks } from '@/state';
import { Button, EmptyState, IconButton, Select } from '@/components/ui';
import { formatClock } from '../../../shared/time';
import { setClipDrag } from '@/app/dnd';
import { insertAtPlayhead, sourceTimecode } from './shared';

/** Index of the cue active at `time` (last cue whose start <= time and end > time), or -1. */
export function cueIndexAt(cues: SubtitleCue[], time: number): number {
  let lo = 0, hi = cues.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= time) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best >= 0 && cues[best].end > time ? best : -1;
}

function useThrottled<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  const last = useRef(0);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    const now = performance.now();
    const due = Math.max(0, ms - (now - last.current));
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { last.current = performance.now(); setV(value); }, due);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [value, ms]);
  return v;
}

export function TranscriptView({ active }: { active: boolean }) {
  const sourceMediaId = useStore((s) => s.ui.sourceClip?.mediaId ?? null);
  const selectedMediaId = useStore((s) => s.ui.selectedMediaIds[0] ?? null);
  const mediaId = sourceMediaId ?? selectedMediaId;
  const media = useStore((s) => (mediaId ? s.project.media[mediaId] : undefined));
  const subtitleTracks = useStore((s) => s.project.subtitleTracks);
  const seqFps = useStore((s) => (s.project.activeSequenceId ? s.project.sequences[s.project.activeSequenceId]?.fps : undefined));
  const rawTime = useStore((s) => (s.ui.sourceClip && s.ui.sourceClip.mediaId === mediaId ? s.ui.sourceClip.time : -1));
  const time = useThrottled(rawTime, 150);

  const tracks = useMemo(() => (mediaId ? mediaSubtitleTracks(useStore.getState(), mediaId) : []), [mediaId, subtitleTracks, media]); // eslint-disable-line react-hooks/exhaustive-deps
  const [trackId, setTrackId] = useState<string>('');
  useEffect(() => { if (!tracks.some((t) => t.id === trackId)) setTrackId(tracks[0]?.id ?? ''); }, [tracks, trackId]);
  const track = tracks.find((t) => t.id === trackId) ?? tracks[0];
  const cues = track?.cues ?? [];

  const [follow, setFollow] = useState(true);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [range, setRange] = useState<[number, number] | null>(null);
  useEffect(() => { setAnchor(null); setRange(null); }, [mediaId, track?.id]);

  const current = useMemo(() => cueIndexAt(cues, time), [cues, time]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!follow || !active || current < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${current}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [current, follow, active]);

  const seek = useCallback((cue: SubtitleCue) => {
    if (!mediaId) return;
    const st = useStore.getState();
    st.setSourceClip(mediaId, cue.start);
    st.setSourceTime(cue.start);
  }, [mediaId]);

  const onLineClick = (i: number, e: React.MouseEvent) => {
    if (e.shiftKey && anchor !== null) { setRange([Math.min(anchor, i), Math.max(anchor, i)]); return; }
    setAnchor(i); setRange(null);
    seek(cues[i]);
  };

  const span = range ? { start: cues[range[0]].start, end: cues[range[1]].end } : null;
  const markInOut = () => {
    if (!span || !mediaId) return;
    const st = useStore.getState();
    if (st.ui.sourceClip?.mediaId !== mediaId) st.setSourceClip(mediaId, span.start);
    st.setSourceIn(span.start); st.setSourceOut(span.end);
    st.setActivePanel('source');
  };
  const insertSelection = () => { if (span && mediaId) insertAtPlayhead(mediaId, span.start, span.end); };

  if (!mediaId || !media) {
    return <EmptyState icon={FileText} title="No source clip" description="Load a clip in the Source monitor (or select a media item) to read its transcript." />;
  }
  if (tracks.length === 0) {
    return <EmptyState icon={FileText} title={`No transcript for ${media.name}`} description="Use Import subtitles… in the toolbar to attach an .srt/.vtt, extract an embedded stream, or transcribe." />;
  }

  return (
    <div className="tr-view col grow">
      <div className="tr-bar">
        <span className="ellipsis text-dim" title={media.path}>{media.name}</span>
        <span className="ml-auto" />
        {tracks.length > 1 ? (
          <Select size="sm" value={track?.id ?? ''} onChange={setTrackId} title="Language / track"
            options={tracks.map((t) => ({ value: t.id, label: `${t.language !== 'und' ? t.language : t.name}${t.origin ? ` · ${t.origin}` : ''}` }))} />
        ) : <span className="text-faint text-sm nowrap">{cues.length} lines</span>}
        <IconButton size="sm" icon={LocateFixed} label="Follow playhead" toggled={follow} onClick={() => setFollow((v) => !v)} />
      </div>
      {range ? (
        <div className="tr-bar tr-selbar">
          <span className="text-sm nowrap">{range[1] - range[0] + 1} lines · {formatClock(span!.start, true)} – {formatClock(span!.end, true)}</span>
          <span className="ml-auto" />
          <Button size="sm" icon={Brackets} onClick={markInOut} title="Set Source in/out to the selected span">Mark In/Out</Button>
          <Button size="sm" icon={ArrowDownToLine} onClick={insertSelection} title="Insert the selected span at the playhead">Insert</Button>
          <IconButton size="sm" icon={X} label="Clear selection" onClick={() => setRange(null)} />
        </div>
      ) : null}
      <div className="tr-lines grow scroll-y" ref={listRef} data-testid="transcript-lines">
        {cues.map((c, i) => {
          const inRange = range ? i >= range[0] && i <= range[1] : i === anchor;
          return (
            <div key={c.id} data-index={i}
              className={['tr-line', i === current ? 'current' : '', inRange ? 'selected' : ''].filter(Boolean).join(' ')}
              onClick={(e) => onLineClick(i, e)}
              draggable
              onDragStart={(ev) => {
                const s = range && inRange ? span! : { start: c.start, end: c.end };
                setClipDrag(ev.dataTransfer, { mediaId, in: s.start, out: s.end, name: c.text.replace(/\s+/g, ' ').slice(0, 60), origin: 'transcript' });
              }}
            >
              <span className="tr-line-tc mono">{sourceTimecode(c.start, media, seqFps)}</span>
              <span className="tr-line-text">{c.text}</span>
            </div>
          );
        })}
      </div>
      <div className="tr-hint text-faint text-xs">Click a line to seek · Shift+click to select a span · drag a line onto the timeline</div>
    </div>
  );
}
