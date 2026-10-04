import React, { useEffect, useRef, useState } from 'react';
import { Music } from 'lucide-react';
import type { MediaItem } from '@shared/model';
import type { WaveformData } from '@shared/ipc';
import { clamp } from '@shared/time';
import { peaksForRange } from '@/playback';
import { waves } from '@/app/media';

export interface WaveformViewProps {
  media: MediaItem;
  duration: number;
  time: number;
  inPoint: number | null;
  outPoint: number | null;
}

/** Audio-only media: draws the whole file's waveform across the stage with a moving playhead. */
export function WaveformView({ media, duration, time, inPoint, outPoint }: WaveformViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<WaveformData | null | undefined>(() => waves.peek(media.path));
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    const hit = waves.peek(media.path);
    if (hit) { setData(hit); return; }
    setData(undefined);
    waves.get(media.path, media.id).then((d) => { if (!alive) return; setData(d); if (!d) setFailed(true); });
    return () => { alive = false; };
  }, [media.path, media.id, media.waveformStatus]);

  useEffect(() => {
    const el = ref.current; if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas || !size.w || !size.h) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, size.w, size.h);
    if (!data || !(duration > 0) || !Number.isFinite(duration)) return;
    const buckets = Math.max(1, Math.floor(size.w));
    const peaks = peaksForRange(data, 0, duration, buckets);
    const mid = size.h / 2;
    const amp = size.h * 0.42;
    ctx.fillStyle = 'rgba(83, 153, 122, 0.9)';
    for (let x = 0; x < buckets; x++) {
      const v = peaks[x] / 255;
      const hh = Math.max(0.5, v * amp);
      ctx.fillRect(x, mid - hh, 1, hh * 2);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(0, Math.round(mid), size.w, 1);
  }, [data, size, duration]);

  const pct = (sec: number) => `${Number.isFinite(duration) && duration > 0 ? clamp(sec / duration, 0, 1) * 100 : 0}%`;
  const rIn = inPoint ?? (outPoint !== null ? 0 : null);
  const rOut = outPoint ?? (inPoint !== null ? duration : null);

  return (
    <div ref={ref} className="source-waveform">
      <canvas ref={canvasRef} />
      {rIn !== null && rOut !== null ? <div className="wave-range" style={{ left: pct(rIn), width: `calc(${pct(rOut)} - ${pct(rIn)})` }} /> : null}
      <div className="wave-playhead" style={{ left: pct(time) }} />
      {data === undefined && !failed ? <div className="wave-label"><Music size={14} /> Loading waveform…</div> : null}
      {failed ? <div className="wave-label"><Music size={14} /> Audio — no waveform available</div> : null}
    </div>
  );
}
