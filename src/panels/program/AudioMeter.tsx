/**
 * Stereo peak meter for the Program monitor (E-10 / UX-08). Taps the sequence player's master gain with a
 * ChannelSplitter → 2 AnalyserNodes (the tap does not alter the output). Draws dBFS bars with tick marks and a
 * clip LED; the rAF loop runs only while playing. If the player exposes no master gain, it renders disabled.
 */
import React, { useEffect, useRef, useState } from 'react';

export const METER_FLOOR_DB = -60;
export const METER_TICKS = [0, -6, -12, -18, -24, -36, -48, -60];
/** Linear sample peak → dBFS, floored at METER_FLOOR_DB. */
export function peakToDb(peak: number): number {
  return peak > 0 ? Math.max(METER_FLOOR_DB, 20 * Math.log10(peak)) : METER_FLOOR_DB;
}
/** dBFS → 0..1 position on the meter (linear in dB). */
export function dbToPos(db: number): number {
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
}

interface Tap { splitter: ChannelSplitterNode; analysers: [AnalyserNode, AnalyserNode]; source: AudioNode }

type GainSource = { getMasterGain?: () => AudioNode | null | undefined };

function createTap(node: AudioNode): Tap | null {
  try {
    const ctx = node.context;
    const splitter = ctx.createChannelSplitter(2);
    splitter.channelCount = 2;
    splitter.channelCountMode = 'explicit';
    splitter.channelInterpretation = 'speakers'; // mono up-mixes to L+R, 5.1 down-mixes
    const mk = () => { const a = ctx.createAnalyser(); a.fftSize = 1024; a.smoothingTimeConstant = 0; return a; };
    const analysers: [AnalyserNode, AnalyserNode] = [mk(), mk()];
    node.connect(splitter);
    splitter.connect(analysers[0], 0);
    splitter.connect(analysers[1], 1);
    return { splitter, analysers, source: node };
  } catch { return null; }
}

function destroyTap(t: Tap): void {
  try { t.source.disconnect(t.splitter); } catch { /* already gone */ }
  try { t.splitter.disconnect(); } catch { /* ignore */ }
}

const W = 132, H = 22;

export function AudioMeter({ player, playing }: { player: () => GainSource | null; playing: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tapRef = useRef<Tap | null>(null);
  const hold = useRef<[number, number]>([METER_FLOOR_DB, METER_FLOOR_DB]);
  const holdAt = useRef<[number, number]>([0, 0]);
  const [clipped, setClipped] = useState(false);
  const [available, setAvailable] = useState(true);

  const draw = (levels: [number, number]) => {
    const cv = canvasRef.current; const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const barW = W - 2;
    const rows: [number, number][] = [[1, 5], [7, 5]];
    rows.forEach(([y, h], i) => {
      ctx.fillStyle = '#101010';
      ctx.fillRect(1, y, barW, h);
      const pos = dbToPos(levels[i]);
      if (pos > 0) {
        const g = ctx.createLinearGradient(1, 0, 1 + barW, 0);
        g.addColorStop(0, '#3fa65a'); g.addColorStop(dbToPos(-12), '#3fa65a');
        g.addColorStop(dbToPos(-6), '#d8c23a'); g.addColorStop(dbToPos(-1), '#e05252'); g.addColorStop(1, '#e05252');
        ctx.fillStyle = g;
        ctx.fillRect(1, y, barW * pos, h);
      }
      const hp = dbToPos(hold.current[i]);
      if (hp > 0) { ctx.fillStyle = '#f0f0f0'; ctx.fillRect(1 + barW * hp - 1, y, 1.5, h); }
    });
    ctx.fillStyle = '#8a8a8a';
    ctx.font = '7px system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    for (const t of METER_TICKS) {
      const x = 1 + barW * dbToPos(t);
      ctx.fillRect(Math.round(x) - 0.5, 13, 1, 2);
      if (t === -48 || t === -36) continue; // keep the low end readable
      const label = String(t);
      const tw = ctx.measureText(label).width;
      ctx.fillText(label, Math.min(W - tw, Math.max(0, x - tw / 2)), H - 1);
    }
  };

  // Attach / detach the analyser tap.
  const ensureTap = (): Tap | null => {
    if (tapRef.current) return tapRef.current;
    const p = player();
    const node = p?.getMasterGain?.() ?? null;
    if (!node) { setAvailable(false); return null; }
    tapRef.current = createTap(node);
    setAvailable(!!tapRef.current);
    return tapRef.current;
  };
  useEffect(() => () => { if (tapRef.current) { destroyTap(tapRef.current); tapRef.current = null; } }, []);

  useEffect(() => {
    if (!playing) {
      hold.current = [METER_FLOOR_DB, METER_FLOOR_DB];
      draw([METER_FLOOR_DB, METER_FLOOR_DB]);
      return;
    }
    const tap = ensureTap();
    if (!tap) { draw([METER_FLOOR_DB, METER_FLOOR_DB]); return; }
    const buf = new Float32Array(tap.analysers[0].fftSize);
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const lv: [number, number] = [METER_FLOOR_DB, METER_FLOOR_DB];
      let clip = false;
      for (let ch = 0; ch < 2; ch++) {
        tap.analysers[ch].getFloatTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > peak) peak = v; }
        if (peak >= 0.999) clip = true;
        lv[ch] = peakToDb(peak);
        if (lv[ch] >= hold.current[ch] || now - holdAt.current[ch] > 1500) { hold.current[ch] = lv[ch]; holdAt.current[ch] = now; }
      }
      if (clip) setClipped(true);
      draw(lv);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  return (
    <div className={['pm-meter', available ? '' : 'unavailable'].filter(Boolean).join(' ')} data-testid="program-meter"
      title={available ? 'Program output peak level (dBFS), L / R' : 'Audio meter unavailable'}>
      <canvas ref={canvasRef} width={W} height={H} style={{ width: W, height: H }} />
      <button type="button" className={['pm-clip-led', clipped ? 'on' : ''].filter(Boolean).join(' ')} data-testid="program-clip-led" tabIndex={-1}
        aria-label={clipped ? 'Clipping detected — click to reset' : 'Clip indicator'} title={clipped ? 'Clipped (≥ 0 dBFS) — click to reset' : 'Clip indicator'}
        onClick={() => setClipped(false)} />
    </div>
  );
}
