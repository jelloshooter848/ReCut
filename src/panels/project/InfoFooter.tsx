import React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ID } from '@shared/model';
import { formatClock } from '@shared/time';
import { allTracks } from '@shared/timeline';
import { useStore, identityLabel } from '@/state';
import { isStillImage, mediaNeedsProxyForPreview, previewPlaybackLabel, previewReason } from '@/playback/mediaSource';
import { channelsLabel, dateLabel, formatBytes, rationalLabel, sequenceDurationLabel } from './format';

export interface InfoFooterProps { mediaId: ID | null; sequenceId: ID | null; open: boolean; onToggle(): void }

/** Read-only metadata for the selected item (identity editing lives in the Inspector). */
export function InfoFooter({ mediaId, sequenceId, open, onToggle }: InfoFooterProps) {
  const m = useStore((s) => (mediaId ? s.project.media[mediaId] : undefined));
  const seq = useStore((s) => (sequenceId ? s.project.sequences[sequenceId] : undefined));
  const title = m ? m.name : seq ? seq.name : 'Nothing selected';
  const rows: { k: string; v: React.ReactNode; cls?: string }[] = [];
  if (m) {
    const p = m.probe;
    rows.push({ k: 'Path', v: m.path, cls: 'wrap' });
    if (m.offline) rows.push({ k: 'Status', v: 'Offline — file not found', cls: 'danger' });
    if (m.probeError) rows.push({ k: 'Probe', v: m.probeError, cls: 'danger' });
    const idn = identityLabel(m);
    if (idn && idn !== m.name) rows.push({ k: 'Identity', v: idn });
    rows.push({ k: 'Category', v: m.category });
    const size = m.fileSize ?? p?.size;
    if (size) rows.push({ k: 'Size', v: formatBytes(size) });
    if (p) {
      rows.push({ k: 'Container', v: p.container });
      if (Number.isFinite(p.duration) && m.kind !== 'image') rows.push({ k: 'Duration', v: formatClock(p.duration, true) });
      if (p.video) {
        rows.push({ k: 'Video', v: `${p.video.codec} ${p.video.width}×${p.video.height} @ ${rationalLabel(p.video.fps)} fps${p.video.pixFmt ? ` · ${p.video.pixFmt}` : ''}${p.video.colorSpace ? ` · ${p.video.colorSpace}` : ''}` });
        if (p.video.isVfr) rows.push({ k: 'Frame rate', v: `Variable frame rate (avg ${rationalLabel(p.video.avgFps)}) — timing may drift; consider a proxy`, cls: 'warn' });
      }
      p.audio.forEach((a, i) => rows.push({ k: i === 0 ? 'Audio' : '', v: `#${a.index} ${a.codec} ${channelsLabel(a.channels, a.layout)} (${a.layout}) ${a.sampleRate ? `${a.sampleRate / 1000} kHz` : ''}${a.language ? ` [${a.language}]` : ''}${a.title ? ` ${a.title}` : ''}${m.preferredAudioStream === a.index && p.audio.length > 1 ? ' ★' : ''}` }));
      if (p.subtitles.length) rows.push({ k: 'Embedded subs', v: p.subtitles.map((s) => `#${s.index} ${s.codec}${s.language ? ` [${s.language}]` : ''}`).join(', ') });
      if (p.startTime) rows.push({ k: 'Start time', v: `${p.startTime.toFixed(3)} s` });
      if (p.bitrate) rows.push({ k: 'Bitrate', v: `${Math.round(p.bitrate / 1000)} kb/s` });
      if (!p.browserPlayable) { const pl = previewPlaybackLabel(m); rows.push({ k: 'Playback', v: pl.direct ? pl.text : mediaNeedsProxyForPreview(m) && !isStillImage(m) ? (previewReason(m) ?? 'Not directly decodable — needs a proxy') : pl.text, cls: pl.direct ? undefined : 'warn' }); }
    }
    if (m.proxy.status !== 'none') rows.push({ k: 'Proxy', v: m.proxy.status === 'ready' ? `${m.proxy.path ?? ''}${m.proxy.width ? ` (${m.proxy.width}×${m.proxy.height})` : ''}` : m.proxy.status === 'failed' ? `failed: ${m.proxy.error ?? ''}` : m.proxy.status, cls: m.proxy.status === 'failed' ? 'danger' : m.proxy.status === 'ready' ? 'wrap' : undefined });
    if (m.detectedScenes.length) rows.push({ k: 'Scenes', v: `${m.detectedScenes.length} detected` });
    if (m.subtitleTrackIds.length) rows.push({ k: 'Subtitles', v: `${m.subtitleTrackIds.length} track${m.subtitleTrackIds.length === 1 ? '' : 's'}` });
    if (m.tags.length) rows.push({ k: 'Tags', v: m.tags.join(', ') });
    rows.push({ k: 'Added', v: dateLabel(m.addedAt) });
  } else if (seq) {
    const tracks = allTracks(seq);
    rows.push({ k: 'Format', v: `${seq.width}×${seq.height} @ ${rationalLabel(seq.fps)} fps · ${seq.sampleRate / 1000} kHz ${seq.channels === 6 ? '5.1' : 'stereo'}` });
    rows.push({ k: 'Duration', v: sequenceDurationLabel(seq) });
    rows.push({ k: 'Tracks', v: `${seq.videoTracks.length} video · ${seq.audioTracks.length} audio · ${seq.subtitleTracks.length} subtitle` });
    rows.push({ k: 'Clips', v: String(tracks.reduce((n, t) => n + t.clips.length, 0)) });
    if (seq.parentSequenceId) rows.push({ k: 'Lineage', v: `${seq.versionLabel ?? 'alternate cut'} of ${useStore.getState().project.sequences[seq.parentSequenceId]?.name ?? 'deleted sequence'}` });
    rows.push({ k: 'Created', v: dateLabel(seq.createdAt) });
  }
  return (
    <div className="pp-info" data-testid="info-footer">
      <div className="pp-info-head" role="button" aria-expanded={open} onClick={onToggle}>
        {open ? <ChevronDown /> : <ChevronRight />}
        <span>Info</span>
        <span className="title grow" title={title}>{title}</span>
      </div>
      {open && rows.length ? (
        <dl className="pp-info-body">
          {rows.map((r, i) => (
            <React.Fragment key={i}>
              <dt>{r.k}</dt>
              <dd className={r.cls} title={typeof r.v === 'string' ? r.v : undefined}>{r.v}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
