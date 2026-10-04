/** Sequence inspector (nothing selected): settings, counts, lineage, snapshots and a tracks table. */
import React, { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Camera, Copy, Headphones, Lock, LockOpen, RotateCcw, Trash2, Volume2, VolumeX } from 'lucide-react';
import type { ID, Sequence, Track } from '@shared/model';
import { sequenceDuration } from '@shared/timeline';
import { fpsLabel } from '@shared/time';
import { useStore } from '@/state';
import type { StoreState } from '@/state';
import { Button, IconButton, NumberField, Select, TextField } from '@/components/ui';
import { Row, Section, Value, dbFromLinear, finish, framesLabel, linearFromDb, pluralize, transient } from './primitives';

const SAMPLE_RATES = [{ value: '44100', label: '44.1 kHz' }, { value: '48000', label: '48 kHz' }, { value: '96000', label: '96 kHz' }];
const CHANNELS = [{ value: '2', label: 'Stereo' }, { value: '6', label: '5.1 Surround' }];
const RES_PRESETS: { label: string; w: number; h: number }[] = [
  { label: '1080p (1920×1080)', w: 1920, h: 1080 }, { label: '4K UHD (3840×2160)', w: 3840, h: 2160 }, { label: '720p (1280×720)', w: 1280, h: 720 },
  { label: '2K DCI (2048×1080)', w: 2048, h: 1080 }, { label: 'Vertical (1080×1920)', w: 1080, h: 1920 },
];

export function SequenceInspector({ seqId }: { seqId: ID }) {
  const seq = useStore(useShallow((s: StoreState) => {
    const q = s.project.sequences[seqId];
    return q ? {
      name: q.name, fps: q.fps, width: q.width, height: q.height, sampleRate: q.sampleRate, channels: q.channels, versionLabel: q.versionLabel,
      parentSequenceId: q.parentSequenceId, snapshots: q.snapshots, videoTracks: q.videoTracks, audioTracks: q.audioTracks, markers: q.markers,
      subtitleTracks: q.subtitleTracks, storyBlocks: q.storyBlocks, createdAt: q.createdAt, modifiedAt: q.modifiedAt,
    } : null;
  }));
  const parentName = useStore((s) => (seq?.parentSequenceId ? s.project.sequences[seq.parentSequenceId]?.name : undefined));
  const childCount = useStore((s) => Object.values(s.project.sequences).filter((q) => q.parentSequenceId === seqId).length);
  const { updateSequenceSettings, duplicateSequence, takeSnapshot, restoreSnapshot, deleteSnapshot, setTrackFlags } = useStore.getState();
  const [form, setForm] = useState<{ kind: 'snapshot' | 'duplicate'; name: string } | null>(null);

  const stats = useMemo(() => {
    if (!seq) return null;
    const tracks = [...seq.videoTracks, ...seq.audioTracks];
    const clips = tracks.reduce((n, t) => n + t.clips.length, 0);
    const transitions = tracks.reduce((n, t) => n + t.transitions.length, 0);
    const markers = seq.markers.filter((m) => m.kind !== 'continuity').length;
    const continuityOpen = seq.markers.filter((m) => m.kind === 'continuity' && !m.resolved).length;
    const duration = sequenceDuration({ videoTracks: seq.videoTracks, audioTracks: seq.audioTracks } as Sequence);
    return { clips, transitions, markers, continuityOpen, duration };
  }, [seq]);

  if (!seq || !stats) return <div className="insp-empty p-8">No active sequence.</div>;
  const fps = seq.fps;
  const resPreset = RES_PRESETS.find((r) => r.w === seq.width && r.h === seq.height);
  const setDim = (key: 'width' | 'height', v: number) => transient((d) => { const q = d.sequences[seqId]; if (q) q[key] = Math.max(16, Math.round(v / 2) * 2); });
  const submitForm = () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) return;
    if (form.kind === 'snapshot') takeSnapshot(seqId, name); else duplicateSequence(seqId, name);
    setForm(null);
  };
  const fmtDate = (ts: number) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <>
      <div className="insp-head" data-testid="sequence-header">
        <div className="insp-title-row">
          <TextField size="sm" value={seq.name} commitOnBlur selectOnFocus data-prop="sequence-name" onChange={(v) => { if (v.trim() && v !== seq.name) updateSequenceSettings(seqId, { name: v.trim() }); }} />
          {seq.versionLabel ? <span className="badge dim" title="Version label">{seq.versionLabel}</span> : null}
        </div>
        <div className="insp-sub">
          <span className="mono">{seq.width}×{seq.height}</span><span className="text-faint">·</span>
          <span className="mono">{fpsLabel(fps)} fps</span><span className="text-faint">·</span>
          <span className="mono">{framesLabel(stats.duration, fps)}</span>
        </div>
      </div>

      <Section id="seq-settings" title="Sequence settings">
        <Row label="Frame rate" title="Frame rate is fixed once a sequence has clips (positions are frames)."><Value copy={fpsLabel(fps)}>{fpsLabel(fps)} fps <span className="text-faint">({fps.num}/{fps.den})</span></Value></Row>
        <Row label="Resolution" prop="resolution">
          <Select size="sm" value={resPreset ? `${resPreset.w}x${resPreset.h}` : 'custom'}
            options={[...RES_PRESETS.map((r) => ({ value: `${r.w}x${r.h}`, label: r.label })), { value: 'custom', label: `Custom (${seq.width}×${seq.height})` }]}
            onChange={(v) => { const r = RES_PRESETS.find((x) => `${x.w}x${x.h}` === v); if (r) updateSequenceSettings(seqId, { width: r.w, height: r.h }); }} />
        </Row>
        <Row label="Frame size" prop="frame-size">
          <NumberField value={seq.width} min={16} max={16384} unit="w" title="Width (even px)" onChange={(v) => setDim('width', v)} onCommit={() => finish('Sequence settings')} />
          <span className="insp-axis">×</span>
          <NumberField value={seq.height} min={16} max={16384} unit="h" title="Height (even px)" onChange={(v) => setDim('height', v)} onCommit={() => finish('Sequence settings')} />
        </Row>
        <Row label="Sample rate" prop="sample-rate">
          <Select size="sm" value={String(seq.sampleRate)} options={SAMPLE_RATES.some((r) => r.value === String(seq.sampleRate)) ? SAMPLE_RATES : [...SAMPLE_RATES, { value: String(seq.sampleRate), label: `${seq.sampleRate} Hz` }]}
            onChange={(v) => updateSequenceSettings(seqId, { sampleRate: Number(v) })} />
        </Row>
        <Row label="Channels" prop="channels">
          <Select size="sm" value={String(seq.channels)} options={CHANNELS.some((c) => c.value === String(seq.channels)) ? CHANNELS : [...CHANNELS, { value: String(seq.channels), label: `${seq.channels} ch` }]}
            onChange={(v) => updateSequenceSettings(seqId, { channels: Number(v) })} />
        </Row>
        <Row label="Version label" prop="version-label">
          <TextField size="sm" value={seq.versionLabel ?? ''} placeholder="e.g. v2 – shorter act 2" commitOnBlur onChange={(v) => { if ((seq.versionLabel ?? '') !== v.trim()) updateSequenceSettings(seqId, { versionLabel: v.trim() || undefined }); }} />
        </Row>
      </Section>

      <Section id="seq-stats" title="Contents">
        <Row label="Duration"><Value copy={String(stats.duration)}>{framesLabel(stats.duration, fps)}</Value></Row>
        <div className="insp-stats">
          <div className="insp-kv"><span className="k">Clips</span><span className="v">{stats.clips}</span></div>
          <div className="insp-kv"><span className="k">Transitions</span><span className="v">{stats.transitions}</span></div>
          <div className="insp-kv"><span className="k">Markers</span><span className="v">{stats.markers}</span></div>
          <div className="insp-kv"><span className="k">Continuity open</span><span className={['v', stats.continuityOpen ? 'text-accent-2' : ''].join(' ')}>{stats.continuityOpen}</span></div>
          <div className="insp-kv"><span className="k">Subtitle tracks</span><span className="v">{seq.subtitleTracks.length}</span></div>
          <div className="insp-kv"><span className="k">Story blocks</span><span className="v">{seq.storyBlocks.length}</span></div>
        </div>
        <Row label="Modified"><Value dim>{fmtDate(seq.modifiedAt)}</Value></Row>
      </Section>

      <Section id="seq-versions" title="Versions" badge={seq.snapshots.length ? pluralize(seq.snapshots.length, 'snapshot') : undefined}>
        {parentName ? <Row label="Alternate cut of"><Value title={seq.parentSequenceId}>{parentName}</Value></Row> : null}
        {childCount ? <Row label="Alternate cuts"><Value dim>{childCount}</Value></Row> : null}
        <div className="insp-btn-row">
          <Button size="sm" icon={Copy} onClick={() => setForm({ kind: 'duplicate', name: `${seq.name} copy` })} title="Duplicate this sequence as a new alternate cut" data-testid="duplicate-sequence">Duplicate sequence</Button>
          <Button size="sm" icon={Camera} onClick={() => setForm({ kind: 'snapshot', name: `Snapshot ${seq.snapshots.length + 1}` })} title="Save a restorable snapshot of this sequence" data-testid="take-snapshot">Snapshot</Button>
        </div>
        {form ? (
          <div className="insp-inline-form" data-testid="inline-form">
            <TextField size="sm" value={form.name} autoFocus selectOnFocus onChange={(name) => setForm({ ...form, name })} onKeyDown={(e) => { if (e.key === 'Enter') submitForm(); if (e.key === 'Escape') setForm(null); }} />
            <Button size="sm" variant="primary" onClick={submitForm}>{form.kind === 'snapshot' ? 'Save' : 'Create'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
          </div>
        ) : null}
        {seq.snapshots.length === 0 ? <div className="insp-empty">No snapshots yet.</div> : null}
        {[...seq.snapshots].reverse().map((snap) => (
          <div key={snap.id} className="insp-snap" data-testid="snapshot">
            <div className="col"><span className="n" title={snap.name}>{snap.name}</span><span className="d">{fmtDate(snap.createdAt)}</span></div>
            <span className="row gap-2">
              <IconButton icon={RotateCcw} label="Restore snapshot" size="sm" onClick={() => restoreSnapshot(seqId, snap.id)} />
              <IconButton icon={Trash2} label="Delete snapshot" size="sm" onClick={() => deleteSnapshot(seqId, snap.id)} />
            </span>
          </div>
        ))}
      </Section>

      <Section id="seq-tracks" title="Tracks" badge={`${seq.videoTracks.length}V · ${seq.audioTracks.length}A`}>
        <div className="insp-tracks">
          {[...seq.videoTracks].reverse().map((t) => <TrackRow key={t.id} seqId={seqId} t={t} setTrackFlags={setTrackFlags} />)}
          <div className="divider-h" />
          {seq.audioTracks.map((t) => <TrackRow key={t.id} seqId={seqId} t={t} setTrackFlags={setTrackFlags} />)}
        </div>
      </Section>
    </>
  );
}

function TrackRow({ seqId, t, setTrackFlags }: { seqId: ID; t: Track; setTrackFlags: (seqId: ID, trackId: ID, patch: Partial<Track>) => void }) {
  const db = dbFromLinear(t.volume);
  return (
    <div className="insp-track" data-track={t.id}>
      <div className="row gap-4">
        <span className="cnt" title={pluralize(t.clips.length, 'clip')}>{t.clips.length}</span>
        <TextField size="sm" value={t.name} commitOnBlur selectOnFocus title="Track name" onChange={(v) => { if (v.trim() && v !== t.name) setTrackFlags(seqId, t.id, { name: v.trim() }); }} />
      </div>
      <div className="row gap-4">
        {t.kind === 'audio' ? (
          <NumberField value={Math.round(db * 10) / 10} min={-60} max={12} step={0.5} precision={1} unit="dB" defaultValue={0} title="Track volume (dB) — double-click resets"
            format={(v) => (v <= -60 ? '-∞' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`)}
            onChange={(v) => transient((d) => { const q = d.sequences[seqId]; const tr = q && [...q.videoTracks, ...q.audioTracks].find((x) => x.id === t.id); if (tr) tr.volume = linearFromDb(v); })}
            onCommit={() => finish('Track volume')} />
        ) : null}
        <span className="flags">
          <IconButton icon={t.muted ? VolumeX : Volume2} label={t.muted ? 'Unmute track' : 'Mute track'} size="sm" toggled={t.muted} className={t.muted ? 'danger' : ''} onClick={() => setTrackFlags(seqId, t.id, { muted: !t.muted })} />
          <IconButton icon={Headphones} label={t.solo ? 'Unsolo track' : 'Solo track'} size="sm" toggled={t.solo} className={t.solo ? 'warn' : ''} onClick={() => setTrackFlags(seqId, t.id, { solo: !t.solo })} />
          <IconButton icon={t.locked ? Lock : LockOpen} label={t.locked ? 'Unlock track' : 'Lock track'} size="sm" toggled={t.locked} onClick={() => setTrackFlags(seqId, t.id, { locked: !t.locked })} />
        </span>
      </div>
    </div>
  );
}
