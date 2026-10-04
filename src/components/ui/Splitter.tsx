import React, { useRef, useState } from 'react';

export interface SplitterProps {
  /** 'h' = vertical bar separating left/right (col-resize); 'v' = horizontal bar separating top/bottom. */
  direction: 'h' | 'v';
  /** Called with the pointer delta (px) relative to drag start. */
  onDrag: (delta: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDoubleClick?: () => void;
  className?: string;
}

export function Splitter({ direction, onDrag, onDragStart, onDragEnd, onDoubleClick, className = '' }: SplitterProps) {
  const [dragging, setDragging] = useState(false);
  const start = useRef(0);
  return (
    <div
      className={['splitter', direction, dragging ? 'dragging' : '', className].filter(Boolean).join(' ')}
      role="separator" aria-orientation={direction === 'h' ? 'vertical' : 'horizontal'}
      onDoubleClick={onDoubleClick}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        start.current = direction === 'h' ? e.clientX : e.clientY;
        setDragging(true);
        document.body.classList.add(direction === 'h' ? 'resizing-h' : 'resizing-v');
        onDragStart?.();
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        const pos = direction === 'h' ? e.clientX : e.clientY;
        onDrag(pos - start.current);
      }}
      onPointerUp={(e) => {
        if (!dragging) return;
        setDragging(false);
        document.body.classList.remove('resizing-h', 'resizing-v');
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        onDragEnd?.();
      }}
      onPointerCancel={() => { setDragging(false); document.body.classList.remove('resizing-h', 'resizing-v'); onDragEnd?.(); }}
    />
  );
}
