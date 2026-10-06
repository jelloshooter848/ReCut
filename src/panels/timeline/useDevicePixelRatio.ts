import { useEffect, useState } from 'react';
import { validDpr } from './waveBars';

function currentDpr(): number {
  return validDpr(typeof window === 'undefined' ? 1 : window.devicePixelRatio);
}

/**
 * window.devicePixelRatio, re-rendering when it changes (the window moves to a display with another scale, or the
 * page zoom changes): the waveform canvases and the playhead snap to device pixels.
 */
export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(currentDpr);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let mq: MediaQueryList | null = null;
    const listen = () => {
      mq?.removeEventListener('change', onChange);
      mq = window.matchMedia(`(resolution: ${currentDpr()}dppx)`);
      mq.addEventListener('change', onChange);
    };
    function onChange() { setDpr(currentDpr()); listen(); }
    listen();
    setDpr(currentDpr());
    return () => { mq?.removeEventListener('change', onChange); };
  }, []);
  return dpr;
}
