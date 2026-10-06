/**
 * Timeline playhead geometry (A4: the playhead is one composited layer moved by transform only). The line's x must
 * stay exactly frameToX(playhead) snapped to the device pixel grid, at every zoom, scroll and device pixel ratio,
 * with no drift; at dpr 1 it is the former `left: Math.round(frameToX(...))`.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frameToX, playheadX } from '../../src/panels/timeline/viewMath';
import { PlayheadLayer, holdTransform } from '../../src/panels/timeline/Playhead';

const DPRS = [1, 1.25, 1.5, 2, 3];
const ZOOMS = [0.0137, 0.1, 0.5, 1, 1.37, 2, 3.3333, 7.25, 24, 100];
const SCROLLS = [0, 0.25, 1, 17.4, 100, 999.75, 12345.678, 259200];

let seed = 99;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

describe('playheadX', () => {
  it('is frameToX snapped to the nearest device pixel at every zoom / scroll / dpr', () => {
    for (const dpr of DPRS) for (const zoom of ZOOMS) for (const scroll of SCROLLS) {
      for (let k = 0; k < 20; k++) {
        const frame = Math.round(scroll + rnd() * (1600 / zoom));
        const x = playheadX(frame, zoom, scroll, dpr);
        const exact = frameToX(frame, zoom, scroll);
        // On a whole device pixel (what the compositor translates the layer by).
        expect(Math.abs(x * dpr - Math.round(x * dpr))).toBeLessThan(1e-6);
        // Within half a device pixel of the exact position, and the nearest one.
        expect(Math.abs(x - exact)).toBeLessThanOrEqual(0.5 / dpr + 1e-9);
        expect(Math.round(x * dpr)).toBe(Math.round(exact * dpr));
      }
    }
  });

  it('at dpr 1 equals the former line position Math.round(frameToX)', () => {
    for (const zoom of ZOOMS) for (const scroll of SCROLLS) {
      for (let k = 0; k < 20; k++) {
        const frame = Math.round(scroll + rnd() * (1600 / zoom));
        expect(playheadX(frame, zoom, scroll, 1)).toBe(Math.round(frameToX(frame, zoom, scroll)));
      }
    }
  });

  it('does not drift: stepping frame by frame advances by zoom device-snapped, never accumulating error', () => {
    for (const dpr of DPRS) for (const zoom of [1, 2, 0.5, 1.37, 3.3333]) {
      const scroll = 1234.5;
      for (let f = 1234; f < 1234 + 2000; f++) {
        const x = playheadX(f, zoom, scroll, dpr);
        expect(Math.abs(x - (f - scroll) * zoom)).toBeLessThanOrEqual(0.5 / dpr + 1e-9);
        expect(playheadX(f + 1, zoom, scroll, dpr)).toBeGreaterThanOrEqual(x);
      }
      // Integer device-pixel steps are exact.
      if (Number.isInteger(zoom * dpr)) {
        for (let f = 0; f < 500; f++) expect((playheadX(f + 1, zoom, 0, dpr) - playheadX(f, zoom, 0, dpr)) * dpr).toBeCloseTo(zoom * dpr, 9);
      }
    }
  });

  it('treats an unusable dpr as 1', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(playheadX(37, 1.5, 3.2, bad)).toBe(Math.round((37 - 3.2) * 1.5));
  });
});

describe('Playhead layer element', () => {
  it('is one layer translated by playheadX, holding the line and the head (no left offsets)', () => {
    for (const dpr of DPRS) for (const [ph, zoom, scroll] of [[100, 2, 40], [57, 1.37, 3.25], [1000, 0.5, 900], [12, 3.3333, 0.1]] as const) {
      const x = playheadX(ph, zoom, scroll, dpr);
      const html = renderToStaticMarkup(createElement(PlayheadLayer, { x, dpr }));
      expect(html.startsWith(`<div class="tl-playhead-layer" style="transform:translateX(${x}px)">`)).toBe(true);
      // The 1px line is whole device pixels: 1 device px at dpr 1.25 / 1.5, dpr px at integer dprs.
      const lw = Number(/class="tl-playhead" data-playhead="true" style="width:([^p]+)px"/.exec(html)![1]);
      expect(Math.round(lw * dpr * 1e6) / 1e6).toBe(Math.max(1, Math.floor(dpr)));
      expect(html).toContain('class="tl-playhead-head"');
      // Positioned by the layer's transform only.
      expect(html).not.toMatch(/left:/);
      expect(html).toContain('class="tl-playhead-head" style="height:')
      // The CSS string round-trips to the same device pixel.
      const parsed = Number(/translateX\(([^p]+)px\)/.exec(html)![1]);
      expect(Math.round(parsed * dpr)).toBe(Math.round(frameToX(ph, zoom, scroll) * dpr));
    }
  });
});

describe('holdTransform (the layer is moved by a held animation, not by its style attribute)', () => {
  function stubEl() {
    const made: { keyframes: Keyframe[]; options: KeyframeAnimationOptions; anim: { playState: string; cancelled: boolean; paused: boolean; effect: { frames: Keyframe[]; setKeyframes(k: Keyframe[]): void } } }[] = [];
    const el = {
      style: { transform: '' },
      animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
        const anim = {
          playState: 'running', cancelled: false, paused: false,
          effect: { frames: keyframes, setKeyframes(k: Keyframe[]) { this.frames = k; } },
          pause() { this.playState = 'paused'; this.paused = true; },
          cancel() { this.playState = 'idle'; this.cancelled = true; },
        };
        made.push({ keyframes, options, anim });
        return anim as unknown as Animation;
      },
    };
    return { el, made };
  }

  it('holds the exact transform in a paused two-keyframe animation and reuses it for later moves', () => {
    const { el, made } = stubEl();
    const held = { current: null as Animation | null };
    for (const dpr of DPRS) {
      const x = playheadX(1234, 1.37, 1000.25, dpr);
      holdTransform(el, `translateX(${x}px)`, held);
      const a = made[0].anim;
      expect(a.paused).toBe(true);
      // Both keyframes are the exact target value: the held value is exactly playheadX, no interpolation.
      expect(a.effect.frames).toEqual([{ transform: `translateX(${x}px)` }, { transform: `translateX(${x}px)` }]);
    }
    expect(made).toHaveLength(1);
    // The style attribute is never written (a style transform change re-layerizes the page).
    expect(el.style.transform).toBe('');
  });

  it('recreates the animation if it was cancelled, and falls back to style.transform without Web Animations', () => {
    const { el, made } = stubEl();
    const held = { current: null as Animation | null };
    holdTransform(el, 'translateX(10px)', held);
    held.current!.cancel();
    holdTransform(el, 'translateX(20px)', held);
    expect(made).toHaveLength(2);
    expect(made[1].anim.effect.frames[0]).toEqual({ transform: 'translateX(20px)' });
    const plain = { style: { transform: '' } };
    holdTransform(plain, 'translateX(30px)', { current: null });
    expect(plain.style.transform).toBe('translateX(30px)');
  });
});
