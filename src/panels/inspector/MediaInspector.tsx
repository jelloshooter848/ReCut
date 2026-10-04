/** Media inspector: identity / category / tags, probe summary, proxy + scene detection status and subtitle tracks. */
import React, { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Play, ScanSearch, Square, X } from 'lucide-react';
import { MEDIA_CATEGORIES, type ID, type JobInfo, type MediaCategory, type MediaItem, type SourceIdentity } from '@shared/model';
import { fpsLabel, fpsValue } from '@shared/time';
import { identityLabel, mediaSubtitleTracks, startProxy, startSceneDetect, useStore } from '@/state';
import type { StoreState } from '@/state';
import { useJobsStore } from '@/app/jobsStore';
import { Button, ColorSwatchPicker, IconButton, ProgressBar, Select, TagInput, TextField } from '@/components/ui';
import { MIXED, Row, Section, Value, clock, finish, formatBytes, openInFolder, pluralize, transient } from './primitives';

type IdentityKey = keyof SourceIdentity;
const TEXT_IDENTITY: { key: IdentityKey; label: string; placeholder: string }[] = [
  { key: 'title', label: 'Title', placeholder: 'Human title' },
  { key: 'franchise', label: 'Franchise', placeholder: 'e.g. Star Wars' },
  { key: 'collection', label: 'Collection', placeholder: 'e.g. Original Trilogy' },
  { key: 'series', label: 'Series', placeholder: 'e.g. Station Eleven' },
];
const NUM_IDENTITY: { key: IdentityKey; label: string }[] = [
  { key: 'season', label: 'Season' }, { key: 'episode', label: 'Episode' }, { key: 'year', label: 'Year' },
];

/** Transactional patch across one or many media items (one undo step). */
function patchMedia(ids: ID[], label: string, fn: (m: MediaItem) => void): void {
  transient((d) => { for (const id of ids) { const m = d.media[id]; if (m) fn(m); } });
  finish(label);
}

function OptionalNumber({ value, placeholder, prop, onCommit }: { value: number | undefined; placeholder?: string; prop: string; onCommit: (v: number | undefined) => void }) {
  return (
    <TextField size="sm" value={value === undefined ? '' : String(value)} commitOnBlur selectOnFocus inputMode="numeric" placeholder={placeholder ?? '—'} data-prop={prop}
      onChange={(t) => { const n = parseInt(t, 10); onCommit(Number.isFinite(n) ? n : undefined); }} style={{ width: 56, flex: '0 0 auto' }} />
  );
}

export function MediaInspector({ ids }: { ids: ID[] }) {
  const items = useStore(useShallow((s: StoreState) => ids.map((id) => s.project.media[id]).filter((m): m is MediaItem => !!m)));
  if (items.length === 0) return <div className="insp-empty p-8">No media selected.</div>;
  return items.length === 1 ? <SingleMedia m={items[0]} /> : <MultiMedia items={items} />;
}

// ------------------------------------------------------------------ one item
function SingleMedia({ m }: { m: MediaItem }) {
  const updateMedia = useStore((s) => s.updateMedia);
  const removeMediaSubtitleTrack = useStore((s) => s.removeMediaSubtitleTrack);
  const vocab = useStore((s) => s.project.tags.custom);
  const subs = useStore(useShallow((s: StoreState) => mediaSubtitleTracks(s, m.id)));
  const storeJobs = useStore((s) => s.jobs);
  const shellJobs = useJobsStore((s) => s.jobs);
  const jobs = storeJobs.length ? storeJobs : shellJobs;
  const activeJob = (kind: JobInfo['kind']) => jobs.find((j) => j.kind === kind && j.mediaId === m.id && (j.status === 'queued' || j.status === 'running'));
  const proxyJob = activeJob('proxy');
  const sceneJob = activeJob('sceneDetect');
  const p = m.probe;
  const idn = m.identity;
  const setIdentity = (patch: Partial<SourceIdentity>) => updateMedia(m.id, { identity: { ...idn, ...patch } });
  const audioOptions = useMemo(() => [
    { value: 'auto', label: 'Auto (first stream)' },
    ...(p?.audio ?? []).map((a, i) => ({ value: String(a.index), label: `#${i + 1} ${a.codec} ${a.layout || `${a.channels}ch`}${a.language ? ` ${a.language}` : ''}${a.title ? ` — ${a.title}` : ''}` })),
  ], [p]);
  const cancelJob = (id: ID) => { void window.recut?.cancelJob?.(id); };

  return (
    <>
      <div className="insp-head" data-testid="media-header">
        <div className="insp-title-row">
          <TextField size="sm" value={m.name} commitOnBlur selectOnFocus data-prop="media-name" onChange={(v) => { if (v.trim() && v !== m.name) updateMedia(m.id, { name: v.trim() }); }} />
        </div>
        <div className="insp-sub">
          <span className="badge dim">{m.kind}</span>
          <span className="ellipsis" title={identityLabel(m)}>{identityLabel(m)}</span>
          {m.offline ? <span className="badge danger">offline</span> : null}
          {m.probeError ? <span className="badge danger" title={m.probeError}>probe failed</span> : null}
          {p && !p.browserPlayable ? <span className="badge warn" title={p.playabilityReason ?? 'Needs a proxy for playback'}>needs proxy</span> : null}
        </div>
        <div className="row gap-4">
          <span className="insp-label" style={{ width: 36 }}>Label</span>
          <ColorSwatchPicker value={m.color} onChange={(hex) => updateMedia(m.id, { color: hex })} />
          <button type="button" className={['insp-swatch-none', !m.color ? 'selected' : ''].join(' ')} title="No label color" onClick={() => updateMedia(m.id, { color: undefined })} />
        </div>
      </div>

      <Section id="media-identity" title="Identity">
        <Row label="Category" prop="category">
          <Select<MediaCategory> size="sm" value={m.category} options={MEDIA_CATEGORIES.map((c) => ({ value: c, label: c }))} onChange={(c) => updateMedia(m.id, { category: c })} />
        </Row>
        {TEXT_IDENTITY.map((f) => (
          <Row key={f.key} label={f.label} prop={f.key}>
            <TextField size="sm" value={(idn[f.key] as string | undefined) ?? ''} placeholder={f.placeholder} commitOnBlur selectOnFocus
              onChange={(v) => { const t = v.trim(); if ((idn[f.key] ?? '') !== t) setIdentity({ [f.key]: t || undefined }); }} />
          </Row>
        ))}
        <Row label="Season · Ep · Year" prop="numbers">
          {NUM_IDENTITY.map((f) => (
            <OptionalNumber key={f.key} prop={f.key} value={idn[f.key] as number | undefined} placeholder={f.label.slice(0, 2)}
              onCommit={(n) => { if (idn[f.key] !== n) setIdentity({ [f.key]: n }); }} />
          ))}
        </Row>
        <Row label="Tags" prop="media-tags" top>
          <TagInput value={m.tags} suggestions={vocab} onChange={(tags) => updateMedia(m.id, { tags })} />
        </Row>
        <Row label="Notes" prop="media-notes" top>
          <textarea className="input" defaultValue={m.notes} key={m.id} placeholder="Notes…" spellCheck={false}
            onBlur={(e) => { if (e.target.value !== m.notes) updateMedia(m.id, { notes: e.target.value }); }} onKeyDown={(e) => e.stopPropagation()} />
        </Row>
        {p && p.audio.length > 0 ? (
          <Row label="Audio stream" prop="preferred-audio" title="Audio stream used for new clips">
            <Select size="sm" value={m.preferredAudioStream === undefined ? 'auto' : String(m.preferredAudioStream)} options={audioOptions}
              onChange={(v) => updateMedia(m.id, { preferredAudioStream: v === 'auto' ? undefined : Number(v) })} />
          </Row>
        ) : null}
      </Section>

      <Section id="media-probe" title="Media info" badge={p ? p.container : undefined}>
        {!p && !m.probeError ? <div className="insp-empty">Probing…</div> : null}
        {m.probeError ? <div className="insp-note warn">{m.probeError}</div> : null}
        {p ? (
          <>
            <Row label="Duration"><Value copy={p.duration.toFixed(3)}>{clock(p.duration)}{p.video ? <span className="text-faint"> · {Math.round(p.duration * fpsValue(p.video.fps))} fr</span> : null}</Value></Row>
            {p.video ? <Row label="Resolution"><Value copy={`${p.video.width}x${p.video.height}`}>{p.video.width}×{p.video.height}{p.video.pixFmt ? <span className="text-faint"> {p.video.pixFmt}</span> : null}</Value></Row> : null}
            {p.video ? (
              <Row label="Frame rate">
                <Value>{fpsLabel(p.video.fps)} fps{!p.video.isVfr && fpsValue(p.video.avgFps) && Math.abs(fpsValue(p.video.avgFps) - fpsValue(p.video.fps)) > 0.01 ? <span className="text-faint"> (avg {fpsLabel(p.video.avgFps)})</span> : null}</Value>
                {p.video.isVfr ? <span className="badge warn" title="Variable frame rate: timecodes may drift; consider a proxy">VFR</span> : null}
              </Row>
            ) : null}
            <Row label="Codecs"><Value dim>{[p.video?.codec, ...p.audio.map((a) => a.codec)].filter(Boolean).join(' · ') || '—'}</Value></Row>
            {p.audio.length ? <Row label="Audio" top><Value dim className="nowrap" title={p.audio.map((a) => `#${a.index} ${a.codec} ${a.layout} ${a.sampleRate} Hz ${a.language ?? ''}`).join('\n')}>{p.audio.map((a, i) => `${i + 1}: ${a.layout || `${a.channels}ch`}${a.language ? ` ${a.language}` : ''}`).join(' · ')}</Value></Row> : null}
            {p.subtitles.length ? <Row label="Embedded subs"><Value dim>{p.subtitles.map((s) => `${s.codec}${s.language ? ` ${s.language}` : ''}`).join(' · ')}</Value></Row> : null}
            <Row label="Start time"><Value dim>{p.startTime.toFixed(3)}s</Value></Row>
            <Row label="Size"><Value dim>{formatBytes(m.fileSize ?? p.size)}{p.bitrate ? ` · ${Math.round(p.bitrate / 1000)} kb/s` : ''}</Value></Row>
            <Row label="Playback"><Value dim={p.browserPlayable} className={p.browserPlayable ? '' : 'text-accent-2'}>{p.browserPlayable ? 'Direct' : `Proxy required${p.playabilityReason ? ` — ${p.playabilityReason}` : ''}`}</Value></Row>
          </>
        ) : null}
        <Row label="File"><Value onClick={() => openInFolder(m.path)} title={`${m.path}\nReveal in file manager`}>{m.path.split(/[\\/]/).pop()}</Value></Row>
        <Row label="Path"><Value copy={m.path} dim>{m.path}</Value></Row>
      </Section>

      <Section id="media-processing" title="Processing">
        <Row label="Proxy" prop="proxy">
          <Value dim={m.proxy.status === 'none'} className={m.proxy.status === 'failed' ? 'text-danger' : m.proxy.status === 'ready' ? 'text-ok' : ''} title={m.proxy.error ?? m.proxy.path}>
            {m.proxy.status}{m.proxy.status === 'ready' && m.proxy.height ? ` ${m.proxy.height}p` : ''}
          </Value>
          {proxyJob || m.proxy.status === 'running' || m.proxy.status === 'queued' ? <ProgressBar value={proxyJob?.progress ?? m.proxy.progress} /> : null}
          {proxyJob ? (
            <IconButton icon={Square} label="Cancel proxy job" size="sm" onClick={() => cancelJob(proxyJob.id)} />
          ) : (
            <Button size="sm" icon={Play} disabled={m.kind !== 'video' || m.offline} title="Generate a proxy for smooth playback" onClick={() => { void startProxy(m.id); }}>
              {m.proxy.status === 'ready' ? 'Regenerate' : 'Generate'}
            </Button>
          )}
        </Row>
        {m.proxy.error ? <div className="insp-note warn">{m.proxy.error}</div> : null}
        <Row label="Scenes" prop="scenes">
          <Value dim={!m.detectedScenes.length}>{m.sceneDetectStatus && m.sceneDetectStatus !== 'none' ? m.sceneDetectStatus : 'not run'}{m.detectedScenes.length ? ` · ${pluralize(m.detectedScenes.length, 'scene')}` : ''}</Value>
          {sceneJob ? <ProgressBar value={sceneJob.progress} /> : null}
          {sceneJob ? (
            <IconButton icon={Square} label="Cancel scene detection" size="sm" onClick={() => cancelJob(sceneJob.id)} />
          ) : (
            <Button size="sm" icon={ScanSearch} disabled={m.kind !== 'video' || m.offline || m.sceneDetectStatus === 'running'} title="Detect scene cuts" onClick={() => { void startSceneDetect(m.id); }}>Detect</Button>
          )}
        </Row>
        <Row label="Waveform"><Value dim>{m.waveformStatus ?? 'none'}</Value></Row>
      </Section>

      <Section id="media-subtitles" title="Subtitle tracks" badge={subs.length ? `${subs.length}` : undefined}>
        {subs.length === 0 ? <div className="insp-empty">No subtitle tracks attached.</div> : null}
        {subs.map((t) => (
          <div key={t.id} className="insp-tr" data-testid="media-subtitle">
            <div className="insp-tr-name" title={t.path ?? t.origin}>
              <span className="t">{t.name}</span>
              <span className="m">{t.language} · {pluralize(t.cues.length, 'cue')} · {t.origin}</span>
            </div>
            <span />
            <IconButton icon={X} label="Remove subtitle track" size="sm" onClick={() => removeMediaSubtitleTrack(t.id)} />
          </div>
        ))}
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ several items (batch identity)
function MultiMedia({ items }: { items: MediaItem[] }) {
  const ids = items.map((m) => m.id);
  const same = <T,>(pick: (m: MediaItem) => T): T | undefined => (items.every((m) => pick(m) === pick(items[0])) ? pick(items[0]) : undefined);
  const category = same((m) => m.category);
  const series = same((m) => m.identity.series);
  const franchise = same((m) => m.identity.franchise);
  const collection = same((m) => m.identity.collection);
  const season = same((m) => m.identity.season);
  const year = same((m) => m.identity.year);
  const text = (key: IdentityKey, value: string | undefined, label: string) => (
    <Row key={key} label={label} prop={key}>
      <TextField size="sm" value={value ?? ''} placeholder={value === undefined && items.some((m) => m.identity[key] !== undefined) ? MIXED : label} commitOnBlur selectOnFocus
        onChange={(v) => { const t = v.trim(); if (t !== (value ?? '')) patchMedia(ids, 'Edit media', (m) => { (m.identity as Record<string, unknown>)[key] = t || undefined; }); }} />
    </Row>
  );
  const categoryOptions = [...(category === undefined ? [{ value: '' as MediaCategory | '', label: MIXED }] : []), ...MEDIA_CATEGORIES.map((c) => ({ value: c as MediaCategory | '', label: c }))];
  return (
    <>
      <div className="insp-head" data-testid="media-header">
        <div className="insp-title-row"><span className="grow text-bright" style={{ fontWeight: 600 }}>{items.length} media items</span></div>
        <div className="insp-multi-list">{items.map((m) => <div key={m.id} title={m.path}>{m.name}</div>)}</div>
      </div>
      <Section id="media-identity" title="Batch identity">
        <Row label="Category" prop="category">
          <Select size="sm" value={category ?? ''} options={categoryOptions} onChange={(c) => { if (c) patchMedia(ids, 'Edit media', (m) => { m.category = c; }); }} />
        </Row>
        {text('series', series, 'Series')}
        <Row label="Season" prop="numbers">
          <OptionalNumber prop="season" value={season} placeholder={season === undefined && items.some((m) => m.identity.season !== undefined) ? MIXED : 'Season'}
            onCommit={(n) => { if (n !== season) patchMedia(ids, 'Edit media', (m) => { m.identity.season = n; }); }} />
          <span className="insp-note">applies to all {items.length}</span>
        </Row>
        {text('franchise', franchise, 'Franchise')}
        {text('collection', collection, 'Collection')}
        <Row label="Year" prop="year-batch">
          <OptionalNumber prop="year" value={year} placeholder={year === undefined && items.some((m) => m.identity.year !== undefined) ? MIXED : 'Year'}
            onCommit={(n) => { if (n !== year) patchMedia(ids, 'Edit media', (m) => { m.identity.year = n; }); }} />
        </Row>
        <div className="insp-note">Episode numbers and titles are per item — select one item to edit them.</div>
      </Section>
      <Section id="media-probe" title="Summary">
        <Row label="Total duration"><Value>{clock(items.reduce((a, m) => a + (m.probe?.duration ?? 0), 0))}</Value></Row>
        <Row label="Total size"><Value dim>{formatBytes(items.reduce((a, m) => a + (m.fileSize ?? m.probe?.size ?? 0), 0))}</Value></Row>
        <Row label="Offline"><Value dim>{items.filter((m) => m.offline).length}</Value></Row>
        <Row label="Proxies ready"><Value dim>{items.filter((m) => m.proxy.status === 'ready').length} / {items.length}</Value></Row>
      </Section>
    </>
  );
}
