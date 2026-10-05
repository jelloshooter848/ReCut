import type { MediaItem, MediaProbe, Rational, Sequence } from '@shared/model';
import { formatClock, formatSequenceTimecode, fpsLabel } from '@shared/time';
import { sequenceDuration } from '@shared/timeline';
import { identityLabel } from '@/state/selectors';
import { episodeLabel } from './parseIdentity';

export function formatBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${u[i]}`;
}

export function channelsLabel(channels: number, layout?: string): string {
  if (layout && /5\.1/.test(layout)) return '5.1';
  if (layout && /7\.1/.test(layout)) return '7.1';
  if (channels === 1) return 'mono';
  if (channels === 2) return '2ch';
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  return `${channels}ch`;
}

/** "2ch aac", "5.1 ac3", "2 tracks" */
export function audioSummary(probe: MediaProbe | undefined): string {
  if (!probe || probe.audio.length === 0) return '';
  const a = probe.audio[0];
  const base = `${channelsLabel(a.channels, a.layout)} ${a.codec}`;
  return probe.audio.length > 1 ? `${base} +${probe.audio.length - 1}` : base;
}

export function resolutionLabel(probe: MediaProbe | undefined): string {
  const v = probe?.video;
  return v ? `${v.width}×${v.height}` : '';
}

export function mediaFpsLabel(probe: MediaProbe | undefined): string {
  const v = probe?.video;
  if (!v) return '';
  return `${fpsLabel(v.fps)}${v.isVfr ? ' VFR' : ''}`;
}

export function mediaDurationLabel(m: MediaItem): string {
  if (m.kind === 'image') return 'still';
  const d = m.probe?.duration;
  return d !== undefined && Number.isFinite(d) ? formatClock(d) : '';
}

/** Poster-frame time used for list thumbnails. */
export function posterTime(m: MediaItem): number {
  if (m.thumbnailTime !== undefined) return m.thumbnailTime;
  if (m.kind === 'image') return 0;
  const d = m.probe?.duration ?? 0;
  return d > 0 ? Math.min(d * 0.1, 5) : 0;
}

export function canThumb(m: MediaItem): boolean {
  return !m.offline && (m.kind === 'video' || m.kind === 'image') && !!m.probe;
}

/** Short identity for a row: "S01E03", "Original Trilogy", "Star Wars" */
export function shortIdentity(m: MediaItem): string {
  const idn = m.identity;
  const ep = episodeLabel(idn);
  if (idn.series) return ep || idn.series;
  if (ep) return ep;
  return idn.collection ?? idn.franchise ?? (idn.year ? String(idn.year) : '');
}

export function fullIdentity(m: MediaItem): string { return identityLabel(m); }

export function sequenceDurationLabel(seq: Sequence): string {
  return formatSequenceTimecode(sequenceDuration(seq), seq.fps);
}

export function rationalLabel(r: Rational): string { return fpsLabel(r); }

export function dateLabel(ts: number | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function sceneRangeLabel(start: number, end: number): string {
  return `${formatClock(start)}–${formatClock(end)}`;
}
