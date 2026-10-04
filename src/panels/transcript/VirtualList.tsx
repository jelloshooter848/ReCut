import React, { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface VirtualListHandle {
  scrollToIndex(index: number, align?: 'nearest' | 'center' | 'start'): void;
  element(): HTMLDivElement | null;
}

export interface VirtualListProps<T> {
  items: T[];
  /** Fixed row height in px, or a per-row height function (heights must not depend on scroll position). */
  itemHeight: number | ((item: T, index: number) => number);
  render: (item: T, index: number) => React.ReactNode;
  itemKey?: (item: T, index: number) => string | number;
  /** Only window the DOM when there are more rows than this; below it every row is rendered (simpler DOM, exact heights). */
  threshold?: number;
  overscan?: number;
  className?: string;
  style?: React.CSSProperties;
  tabIndex?: number;
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  /** Fired when the user scrolls (not on programmatic scrollToIndex). */
  onUserScroll?: () => void;
  'data-testid'?: string;
}

function VirtualListInner<T>(props: VirtualListProps<T>, ref: React.Ref<VirtualListHandle>) {
  const { items, itemHeight, render, itemKey, threshold = 200, overscan = 6, className = '', style, tabIndex, onKeyDown, onUserScroll } = props;
  const el = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const programmatic = useRef(false);
  const windowed = items.length > threshold;

  const offsets = useMemo(() => {
    if (typeof itemHeight === 'number') return null;
    const out = new Float64Array(items.length + 1);
    for (let i = 0; i < items.length; i++) out[i + 1] = out[i] + itemHeight(items[i], i);
    return out;
  }, [items, itemHeight]);
  const total = offsets ? offsets[items.length] : (itemHeight as number) * items.length;
  const offsetOf = useCallback((i: number) => (offsets ? offsets[i] : (itemHeight as number) * i), [offsets, itemHeight]);
  const indexAt = useCallback((y: number) => {
    if (!offsets) return Math.max(0, Math.min(items.length - 1, Math.floor(y / (itemHeight as number))));
    let lo = 0, hi = items.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offsets[mid] <= y) lo = mid; else hi = mid - 1; }
    return lo;
  }, [offsets, itemHeight, items.length]);

  useLayoutEffect(() => {
    const node = el.current; if (!node) return;
    const ro = new ResizeObserver(() => setViewport(node.clientHeight));
    ro.observe(node);
    setViewport(node.clientHeight);
    return () => ro.disconnect();
  }, []);

  useImperativeHandle(ref, () => ({
    element: () => el.current,
    scrollToIndex(index, align = 'nearest') {
      const node = el.current; if (!node || index < 0 || index >= items.length) return;
      if (!windowed) {
        const child = node.querySelector<HTMLElement>(`[data-index="${index}"]`);
        if (child) { programmatic.current = true; child.scrollIntoView({ block: align === 'start' ? 'start' : align === 'center' ? 'center' : 'nearest' }); }
        return;
      }
      const top = offsetOf(index); const h = offsetOf(index + 1) - top;
      const vh = node.clientHeight;
      let target = node.scrollTop;
      if (align === 'start') target = top;
      else if (align === 'center') target = top - (vh - h) / 2;
      else if (top < node.scrollTop) target = top;
      else if (top + h > node.scrollTop + vh) target = top + h - vh;
      if (target !== node.scrollTop) { programmatic.current = true; node.scrollTop = Math.max(0, target); }
    },
  }), [items.length, windowed, offsetOf]);

  const onScroll = () => {
    const node = el.current; if (!node) return;
    setScrollTop(node.scrollTop);
    if (programmatic.current) programmatic.current = false; else onUserScroll?.();
  };

  let first = 0, last = items.length - 1;
  if (windowed) {
    first = Math.max(0, indexAt(scrollTop) - overscan);
    last = Math.min(items.length - 1, indexAt(scrollTop + Math.max(viewport, 1)) + overscan);
  }
  const rows: React.ReactNode[] = [];
  for (let i = first; i <= last; i++) {
    const item = items[i];
    const key = itemKey ? itemKey(item, i) : i;
    const h = offsets ? offsets[i + 1] - offsets[i] : (itemHeight as number);
    rows.push(
      <div key={key} data-index={i} className="tx-vl-row" style={windowed ? { position: 'absolute', top: offsetOf(i), left: 0, right: 0, height: h } : { height: h }}>
        {render(item, i)}
      </div>,
    );
  }
  return (
    <div ref={el} className={['tx-vl', className].filter(Boolean).join(' ')} style={{ overflowY: 'auto', overflowX: 'hidden', position: 'relative', ...style }} tabIndex={tabIndex} onKeyDown={onKeyDown} onScroll={onScroll} data-testid={props['data-testid']}>
      {windowed ? <div style={{ height: total, position: 'relative' }}>{rows}</div> : rows}
    </div>
  );
}

export const VirtualList = forwardRef(VirtualListInner) as <T>(p: VirtualListProps<T> & { ref?: React.Ref<VirtualListHandle> }) => React.ReactElement;
