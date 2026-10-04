/**
 * Compare panel: two SequencePlayers (A / B) from the shared element pool, optionally locked together with a
 * SyncGroup; duration + structural comparison; alternate cuts and snapshots.
 *
 * Players exist only while the panel's tab is active and are destroyed on unmount / deactivation.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, Columns2, Pause, Play, SkipBack, SkipForward, StepBack, StepForward, Volume2, VolumeX } from 'lucide-react';
import type { ID, Sequence } from '@shared/model';
import { formatTimecode } from '@shared/time';
import { useStore } from '@/state';
import type { PanelProps } from '@/panels/registry';
import { SequencePlayer, SyncGroup } from '@/playback';
import { getAudioContext, getPool, resumeAudio } from '@/app/media';
import { registerTransport, setActiveTransport, type Transport } from '@/app/transport';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Select, type SelectOption } from '@/components/ui/Select';
import { Toggle } from '@/components/ui/Toggle';
import { NumberField } from '@/components/ui/NumberField';
import { EmptyState } from '@/components/ui/EmptyState';
import { diffSequences, summarizeDiff, type DiffEntry } from './diff';
import { DiffList } from './DiffList';
import { CutsSection } from './CutsSection';
import './compare.css';

type ViewMode = 'side' | 'a' | 'b';
const SNAP_PREFIX = 'snap:';

interface Players { a: SequencePlayer; b: SequencePlayer; group: SyncGroup | null }

/** Default B for a given A: a child cut, else A's parent, else the next sequence in project order. */
export function defaultBFor(aId: ID | null, sequences: Record<ID, Sequence>, order: ID[]): ID | null {
  if (!aId || !sequences[aId]) return null;
  const child = order.find((id) => sequences[id]?.parentSequenceId === aId);
  if (child) return child;
  const parent = sequences[aId].parentSequenceId;
  if (parent && sequences[parent]) return parent;
  const i = order.indexOf(aId);
  for (let k = 1; k <= order.length; k++) { const id = order[(i + k) % order.length]; if (id !== aId && sequences[id]) return id; }
  return null;
}

function signedTc(frames: number, fps: Sequence['fps']): string {
  return `${frames < 0 ? '−' : frames > 0 ? '+' : '±'}${formatTimecode(Math.abs(frames), fps)}`;
}

export function ComparePanel({ active, focused }: PanelProps) {
  const sequences = useStore((s) => s.project.sequences);
  const order = useStore((s) => s.project.sequenceOrder);
  const activeId = useStore((s) => s.project.activeSequenceId);
  const media = useStore((s) => s.project.media);
  const useProxies = useStore((s) => s.project.settings.useProxies);
  const playbackResolution = useStore((s) => s.project.settings.playbackResolution);
  const compare = useStore((s) => s.ui.compare);

  const aId = compare.sequenceA && sequences[compare.sequenceA] ? compare.sequenceA : activeId;
  const seqA = aId ? sequences[aId] ?? null : null;
  const [bSnapshotId, setBSnapshotId] = useState<ID | null>(null);
  const snapshot = bSnapshotId ? seqA?.snapshots.find((s) => s.id === bSnapshotId) ?? null : null;
  const bId = snapshot ? null : (compare.sequenceB && sequences[compare.sequenceB] && compare.sequenceB !== aId ? compare.sequenceB : defaultBFor(aId, sequences, order));
  const snapshotSeq = useMemo<Sequence | null>(() => (snapshot ? { ...snapshot.data, snapshots: [] } : null), [snapshot]);
  const seqB: Sequence | null = snapshotSeq ?? (bId ? sequences[bId] ?? null : null);
  const nameB = snapshot ? `Snapshot: ${snapshot.name}` : seqB?.name ?? '—';

  const [sync, setSync] = useState(true);
  const [offset, setOffset] = useState(0);
  const [mode, setMode] = useState<ViewMode>('side');
  const [mutedA, setMutedA] = useState(false);
  const [mutedB, setMutedB] = useState(true);
  const [frameA, setFrameA] = useState(0);
  const [frameB, setFrameB] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [rootH, setRootH] = useState(0);
  const [selectedClip, setSelectedClip] = useState<ID | null>(null);
  const [ready, setReady] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const canvasA = useRef<HTMLCanvasElement>(null);
  const canvasB = useRef<HTMLCanvasElement>(null);
  const players = useRef<Players | null>(null);
  const latest = useRef({ aId, bId, seqA, seqB, mode, sync, offset });
  latest.current = { aId, bId, seqA, seqB, mode, sync, offset };

  // Mirror the effective pair into ui.compare so other panels can read it.
  useEffect(() => {
    const st = useStore.getState();
    const patch: Partial<typeof compare> = {};
    if (compare.sequenceA !== aId) patch.sequenceA = aId;
    if (compare.sequenceB !== bId && bId) patch.sequenceB = bId;
    if (compare.open !== active) patch.open = active;
    if (Object.keys(patch).length) st.setCompare(patch);
  }, [aId, bId, active, compare]);

  // Drop a snapshot override that no longer exists.
  useEffect(() => { if (bSnapshotId && !snapshot) setBSnapshotId(null); }, [bSnapshotId, snapshot]);

  // Width → stacked monitors.
  useEffect(() => {
    const el = rootRef.current; if (!el) return;
    const measure = () => { setNarrow(el.clientWidth < 300); setRootH(el.clientHeight); };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  // ---- players: create while active, destroy otherwise ----
  useEffect(() => {
    if (!active) return;
    const ca = canvasA.current, cb = canvasB.current;
    if (!ca || !cb) return;
    const pool = getPool();
    const ctx = getAudioContext() ?? undefined;
    const a = new SequencePlayer(ca, pool, ctx, { drawSubtitles: true });
    const b = new SequencePlayer(cb, pool, ctx, { drawSubtitles: true });
    players.current = { a, b, group: null };
    setReady((n) => n + 1);
    return () => {
      players.current?.group?.release();
      a.destroy(); b.destroy();
      players.current = null;
      setPlaying(false);
      setReady((n) => n + 1);
    };
  }, [active]);

  // Feed sequences / media / settings.
  useEffect(() => {
    const p = players.current; if (!p) return;
    const settings = { useProxies, playbackResolution };
    if (seqA) p.a.setSequence(seqA, media, settings);
    if (seqB) p.b.setSequence(seqB, media, settings);
  }, [ready, seqA, seqB, media, useProxies, playbackResolution]);

  // Sync group.
  useEffect(() => {
    const p = players.current; if (!p) return;
    if (sync && !p.group) { p.group = new SyncGroup(p.a, p.b); p.group.setOffset(offset); }
    else if (!sync && p.group) { p.group.release(); p.group = null; }
  }, [ready, sync, offset]);
  useEffect(() => { players.current?.group?.setOffset(offset); }, [offset, ready]);

  // Volume.
  useEffect(() => { players.current?.a.setMasterVolume(mutedA ? 0 : 1); }, [ready, mutedA]);
  useEffect(() => { players.current?.b.setMasterVolume(mutedB ? 0 : 1); }, [ready, mutedB]);

  // Frame / state readouts.
  useEffect(() => {
    const p = players.current; if (!p) return;
    setFrameA(p.a.currentFrame()); setFrameB(p.b.currentFrame());
    const upd = () => setPlaying(p.a.isPlaying || p.b.isPlaying);
    const offs = [p.a.onFrame(setFrameA), p.b.onFrame(setFrameB), p.a.onStateChange(upd), p.b.onStateChange(upd)];
    return () => offs.forEach((f) => f());
  }, [ready]);

  // ---- driver: what the transport controls act on ----
  const driver = useCallback(() => {
    const p = players.current;
    if (!p) return null;
    const { mode: m } = latest.current;
    if (p.group) {
      const g = p.group;
      return {
        play: () => g.play(), pause: () => g.pause(), toggle: () => g.toggle(), isPlaying: () => g.isPlaying,
        seek: (f: number) => g.seek(f), currentFrame: () => g.currentFrame(), duration: () => p.a.sequenceDurationFrames,
        setRate: (r: number) => g.setRate(r), getRate: () => p.a.playbackRate,
      };
    }
    const pl = m === 'b' ? p.b : p.a;
    return {
      play: () => pl.play(), pause: () => pl.pause(), toggle: () => pl.toggle(), isPlaying: () => pl.isPlaying,
      seek: (f: number) => pl.seek(f), currentFrame: () => pl.currentFrame(), duration: () => pl.sequenceDurationFrames,
      setRate: (r: number) => pl.setRate(r), getRate: () => pl.playbackRate,
    };
  }, []);

  const togglePlay = () => { void resumeAudio(); driver()?.toggle(); };
  const step = (n: number) => { const d = driver(); if (!d) return; d.pause(); d.seek(d.currentFrame() + n); };
  const goStart = () => { const d = driver(); if (!d) return; d.pause(); d.seek(0); };
  const goEnd = () => { const d = driver(); if (!d) return; d.pause(); d.seek(d.duration()); };

  // Transport registration (focused panel drives the global playback shortcuts).
  useEffect(() => {
    if (!players.current) return;
    const st = () => useStore.getState();
    const view = () => { const id = latest.current.aId; return id ? st().project.sequences[id]?.view : undefined; };
    const t: Transport = {
      id: 'compare',
      toggle: () => { void resumeAudio(); driver()?.toggle(); },
      play: () => { void resumeAudio(); driver()?.play(); },
      pause: () => driver()?.pause(),
      stop: () => { const d = driver(); if (d) { d.pause(); d.seek(0); } },
      setRate: (r) => { void resumeAudio(); driver()?.setRate(r); },
      getRate: () => driver()?.getRate() ?? 1,
      stepFrames: (n) => step(n),
      seekFrame: (f) => driver()?.seek(f),
      currentFrame: () => driver()?.currentFrame() ?? 0,
      durationFrames: () => driver()?.duration() ?? 0,
      goToStart: goStart,
      goToEnd: goEnd,
      markIn: () => { const id = latest.current.aId; if (id) st().setView(id, { inPoint: driver()?.currentFrame() ?? 0 }); },
      markOut: () => { const id = latest.current.aId; if (id) st().setView(id, { outPoint: driver()?.currentFrame() ?? 0 }); },
      clearInOut: () => { const id = latest.current.aId; if (id) st().setView(id, { inPoint: null, outPoint: null }); },
      goToIn: () => { const v = view(); if (v && v.inPoint !== null) driver()?.seek(v.inPoint); },
      goToOut: () => { const v = view(); if (v && v.outPoint !== null) driver()?.seek(v.outPoint); },
      isPlaying: () => driver()?.isPlaying() ?? false,
    };
    return registerTransport(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  useEffect(() => { if (focused && players.current) setActiveTransport('compare'); }, [focused, ready]);

  // Alt (pressed alone) toggles A only / B only while the panel is focused.
  useEffect(() => {
    if (!focused) return;
    let pure = false;
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt') { if (!e.repeat) pure = true; e.preventDefault(); }
      else if (e.altKey) pure = false;
    };
    const up = (e: KeyboardEvent) => { if (e.key === 'Alt' && pure) { pure = false; e.preventDefault(); setMode((m) => (m === 'b' ? 'a' : 'b')); } };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [focused]);

  // ---- selection ----
  const st = () => useStore.getState();
  const setA = (id: ID) => {
    st().setCompare({ sequenceA: id, ...(id === bId ? { sequenceB: aId ?? null } : {}) });
    setBSnapshotId(null);
  };
  const setB = (value: string) => {
    if (value.startsWith(SNAP_PREFIX)) { setBSnapshotId(value.slice(SNAP_PREFIX.length)); return; }
    setBSnapshotId(null);
    st().setCompare({ sequenceB: value, ...(value === aId ? { sequenceA: bId ?? null } : {}) });
  };
  const swap = () => {
    if (!aId || !bId) return;
    setBSnapshotId(null);
    st().setCompare({ sequenceA: bId, sequenceB: aId });
  };

  const seqOptions: SelectOption[] = order.filter((id) => sequences[id]).map((id) => ({ value: id, label: `${sequences[id].name}${sequences[id].versionLabel ? ` (${sequences[id].versionLabel})` : ''}` }));
  const bOptions: SelectOption[] = [
    ...seqOptions.filter((o) => o.value !== aId),
    ...(seqA?.snapshots ?? []).map((s) => ({ value: `${SNAP_PREFIX}${s.id}`, label: `Snapshot: ${s.name}` })),
  ];
  if (!bOptions.length) bOptions.push({ value: '', label: 'No other sequence', disabled: true });
  const bValue = snapshot ? `${SNAP_PREFIX}${snapshot.id}` : bId ?? '';

  // ---- comparison ----
  // Only diff while visible: a hidden Compare tab must not re-diff on every edit.
  const diff = useMemo(() => (active && seqA && seqB ? diffSequences(seqA, seqB) : null), [active, seqA, seqB]);

  const pickRef = useRef<(e: DiffEntry) => void>(() => {});
  const onPickEntry = useCallback((e: DiffEntry) => pickRef.current(e), []);
  const pickEntry = (e: DiffEntry) => {
    const p = players.current;
    const fA = e.side === 'A' ? e.start : e.match?.start ?? null;
    const fB = e.side === 'B' ? e.start : e.match?.start ?? null;
    setSelectedClip(e.clipId);
    if (p) {
      const d = driver(); d?.pause();
      if (p.group) p.group.seek(fA !== null ? fA : (fB ?? 0) - p.group.getOffset());
      else { if (fA !== null) p.a.seek(fA); if (fB !== null) p.b.seek(fB); }
    }
    const s = st();
    const act = s.project.activeSequenceId;
    if (act && act === aId && fA !== null) s.setView(act, { playhead: fA });
    else if (act && act === bId && fB !== null) s.setView(act, { playhead: fB });
    if (e.side === 'A' && act === aId) s.select([e.clipId]);
    else if (e.side === 'B' && act === bId) s.select([e.clipId]);
  };

  pickRef.current = pickEntry;

  const durA = diff?.durationA ?? 0;
  const durB = diff?.durationB ?? 0;
  const delta = diff?.durationDelta ?? 0;
  const pct = durA > 0 ? (delta / durA) * 100 : 0;

  // Hidden tab: a lightweight shell (players are only created while active; see above).
  if (!active) return <div className="panel compare-panel" ref={rootRef} data-testid="compare-panel" data-active="false" />;

  if (!seqA) {
    return (
      <div className="panel compare-panel" ref={rootRef}>
        <EmptyState icon={Columns2} title="Nothing to compare" description="Create a sequence first; Compare shows two cuts side by side." />
      </div>
    );
  }

  // Keep the monitors from starving the comparison lists: cap each box at a share of the panel height.
  const stacked = narrow || mode !== 'side';
  const visibleMonitors = mode === 'side' ? 2 : 1;
  const maxBoxH = Math.max(64, Math.floor((rootH || 600) * (stacked && visibleMonitors === 2 ? 0.18 : 0.34)));
  const monitor = (side: 'A' | 'B', seq: Sequence | null, ref: React.RefObject<HTMLCanvasElement>, frame: number, muted: boolean, setMuted: (v: boolean) => void, label: string) => {
    const ratio = seq ? seq.width / Math.max(1, seq.height) : 16 / 9;
    return (
    <div className={`cmp-monitor ${mode === 'side' || mode === side.toLowerCase() ? '' : 'hidden'}`} data-testid={`compare-monitor-${side.toLowerCase()}`}>
      <div className="cmp-canvas-box" style={{ aspectRatio: `${ratio}`, maxHeight: maxBoxH, maxWidth: Math.round(maxBoxH * ratio) }}>
        <canvas ref={ref} className="cmp-canvas" />
        {!seq ? <div className="cmp-canvas-empty">Select a sequence for {side}</div> : null}
      </div>
      <div className="cmp-monitor-bar">
        <span className={`cmp-side-badge ${side === 'B' ? 'b' : ''}`}>{side}</span>
        <span className="ellipsis grow" title={label}>{label}</span>
        <span className="mono cmp-tc" data-testid={`compare-tc-${side.toLowerCase()}`} data-frame={frame}>{seq ? formatTimecode(frame, seq.fps) : '--:--:--:--'}</span>
        <IconButton size="sm" icon={muted ? VolumeX : Volume2} label={muted ? `Unmute ${side}` : `Mute ${side}`} toggled={!muted} data-testid={`compare-mute-${side.toLowerCase()}`} onClick={() => setMuted(!muted)} />
      </div>
    </div>
    );
  };

  return (
    <div className={`panel compare-panel ${narrow ? 'narrow' : ''}`} ref={rootRef} data-testid="compare-panel">
      <div className="cmp-header">
        <div className="cmp-header-row">
          <span className="cmp-side-badge">A</span>
          <Select size="sm" className="grow" value={aId ?? ''} options={seqOptions} onChange={setA} data-testid="compare-select-a" aria-label="Sequence A" />
          <IconButton size="sm" icon={ArrowLeftRight} label="Swap A and B" data-testid="compare-swap" disabled={!bId} onClick={swap} />
          <span className="cmp-side-badge b">B</span>
          <Select size="sm" className="grow" value={bValue} options={bOptions} onChange={setB} data-testid="compare-select-b" aria-label="Sequence B" />
        </div>
        <div className="cmp-header-row">
          <Toggle checked={sync} onChange={setSync} label="Sync" title="Lock both players to one clock" className="cmp-sync" />
          <span data-testid="compare-sync" data-on={sync} hidden />
          <NumberField value={offset} onChange={setOffset} step={1} signed unit="f" label="Offset" title="B frame offset relative to A (frames)" disabled={!sync} defaultValue={0} className="cmp-offset" />
          <div className="btn-group ml-auto" role="radiogroup" aria-label="View mode">
            <Button size="sm" active={mode === 'side'} data-testid="compare-mode-side" title="Side by side" onClick={() => setMode('side')}>A | B</Button>
            <Button size="sm" active={mode === 'a'} data-testid="compare-mode-a" title="A only (Alt toggles A/B)" onClick={() => setMode('a')}>A</Button>
            <Button size="sm" active={mode === 'b'} data-testid="compare-mode-b" title="B only (Alt toggles A/B)" onClick={() => setMode('b')}>B</Button>
          </div>
        </div>
      </div>

      <div className={`cmp-monitors ${stacked ? 'stacked' : ''}`}>
        {monitor('A', seqA, canvasA, frameA, mutedA, setMutedA, seqA.name)}
        {monitor('B', seqB, canvasB, frameB, mutedB, setMutedB, nameB)}
      </div>

      <div className="cmp-transport">
        <div className="row gap-2">
          <IconButton size="sm" icon={SkipBack} label="Go to start" data-testid="compare-start" onClick={goStart} />
          <IconButton size="sm" icon={StepBack} label="Step back" data-testid="compare-step-back" onClick={() => step(-1)} />
          <IconButton icon={playing ? Pause : Play} label={playing ? 'Pause' : 'Play'} data-testid="compare-play" className="cmp-playbtn" onClick={togglePlay} />
          <IconButton size="sm" icon={StepForward} label="Step forward" data-testid="compare-step-fwd" onClick={() => step(1)} />
          <IconButton size="sm" icon={SkipForward} label="Go to end" data-testid="compare-end" onClick={goEnd} />
        </div>
        <div className="col grow gap-2">
          <ScrubBar side="A" frame={frameA} duration={durA} inPoint={seqA.view.inPoint} outPoint={seqA.view.outPoint}
            onSeek={(f) => { const p = players.current; if (!p) return; (p.group ?? p.a).pause(); if (p.group) p.group.seek(f); else p.a.seek(f); }} />
          {!sync && seqB ? (
            <ScrubBar side="B" frame={frameB} duration={durB} inPoint={null} outPoint={null}
              onSeek={(f) => { const p = players.current; if (!p) return; p.b.pause(); p.b.seek(f); }} />
          ) : null}
        </div>
      </div>

      <div className="cmp-durations" data-testid="compare-durations">
        <span className="cmp-dur"><span className="cmp-side-badge">A</span><span className="mono" data-testid="duration-a" data-frames={durA}>{formatTimecode(durA, seqA.fps)}</span></span>
        <span className="cmp-dur"><span className="cmp-side-badge b">B</span><span className="mono" data-testid="duration-b" data-frames={durB}>{seqB ? formatTimecode(durB, seqB.fps) : '—'}</span></span>
        <span className={`cmp-dur cmp-delta ${delta < 0 ? 'neg' : delta > 0 ? 'pos' : ''}`} title="B minus A (in A's frame rate)">
          <span className="text-dim">Δ</span>
          <span className="mono" data-testid="duration-delta" data-frames={delta}>{seqB ? signedTc(delta, seqA.fps) : '—'}</span>
          {seqB && durA > 0 ? <span className="mono text-dim">({pct > 0 ? '+' : ''}{pct.toFixed(1)}%)</span> : null}
        </span>
        {diff?.fpsMismatch ? <span className="badge warn" title="A and B use different frame rates; positions are compared in A frames">fps</span> : null}
      </div>

      <div className="cmp-body scroll-y">
        <div className="cmp-section">
          <div className="cmp-section-head">
            <Columns2 size={12} />
            <span className="grow">Structure</span>
            {diff ? <span className="text-dim text-sm" data-testid="diff-summary">{summarizeDiff(diff.counts)}</span> : null}
          </div>
          {diff && seqB ? (
            <>
              <div className="cmp-legend">
                <span className="k-same">same</span><span className="k-moved">moved</span><span className="k-trimmed">trimmed</span><span className="k-onlyA">only A</span><span className="k-onlyB">only B</span>
              </div>
              <DiffList diff={diff} fpsA={seqA.fps} fpsB={seqB.fps} selectedClipId={selectedClip} onPick={onPickEntry} nameA={seqA.name} nameB={nameB} />
            </>
          ) : <div className="cmp-empty">Pick a second sequence (or a snapshot) for B to compare structure.</div>}
        </div>

        <CutsSection sequences={sequences} order={order} activeId={activeId} aId={aId} bId={bId} bSnapshotId={snapshot?.id ?? null}
          onSetA={setA} onSetB={(id) => setB(id)} onCompareSnapshot={(id) => setBSnapshotId(id)} />
      </div>
    </div>
  );
}

function ScrubBar({ side, frame, duration, inPoint, outPoint, onSeek }: { side: 'A' | 'B'; frame: number; duration: number; inPoint: number | null; outPoint: number | null; onSeek: (f: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const frameAt = (clientX: number) => {
    const el = ref.current; if (!el || duration <= 0) return 0;
    const r = el.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width))) * duration);
  };
  const pct = duration > 0 ? (Math.min(frame, duration) / duration) * 100 : 0;
  return (
    <div
      ref={ref} className={`cmp-scrub ${side === 'B' ? 'b' : ''}`} data-testid={`compare-scrub-${side.toLowerCase()}`} title={`Scrub ${side}`}
      onPointerDown={(e) => { if (e.button !== 0) return; dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); onSeek(frameAt(e.clientX)); }}
      onPointerMove={(e) => { if (dragging.current) onSeek(frameAt(e.clientX)); }}
      onPointerUp={(e) => { dragging.current = false; try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ } }}
    >
      {inPoint !== null && outPoint !== null && duration > 0 && outPoint > inPoint ? (
        <div className="cmp-scrub-inout" style={{ left: `${(inPoint / duration) * 100}%`, width: `${((outPoint - inPoint) / duration) * 100}%` }} />
      ) : null}
      <div className="cmp-scrub-fill" style={{ width: `${pct}%` }} />
      <div className="cmp-scrub-head" style={{ left: `${pct}%` }} />
    </div>
  );
}
