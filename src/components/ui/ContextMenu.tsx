import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface MenuItem {
  label?: string;
  shortcut?: string;
  disabled?: boolean;
  separator?: boolean;
  checked?: boolean;
  icon?: LucideIcon;
  heading?: string;
  submenu?: MenuItem[];
  onSelect?: () => void;
  /** Keep the menu open after selection (e.g. toggles). */
  keepOpen?: boolean;
}

interface MenuState { open: boolean; x: number; y: number; items: MenuItem[]; anchorRect?: DOMRect | null }

let state: MenuState = { open: false, x: 0, y: 0, items: [] };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getSnapshot = () => state;

export function openContextMenu(items: MenuItem[], at: { x: number; y: number } | MouseEvent | React.MouseEvent | HTMLElement) {
  let x = 0, y = 0, anchorRect: DOMRect | null = null;
  if (at instanceof HTMLElement) { anchorRect = at.getBoundingClientRect(); x = anchorRect.left; y = anchorRect.bottom + 2; }
  else if ('clientX' in at) { x = at.clientX; y = at.clientY; if ('preventDefault' in at) at.preventDefault(); }
  else { x = at.x; y = at.y; }
  state = { open: true, x, y, items, anchorRect };
  emit();
}
export function closeContextMenu() { if (state.open) { state = { ...state, open: false }; emit(); } }
export function isContextMenuOpen() { return state.open; }

/** Hook returning helpers to open a context menu at the pointer or anchored under an element. */
export function useContextMenu() {
  const open = useCallback((e: React.MouseEvent | MouseEvent, items: MenuItem[]) => { e.preventDefault(); e.stopPropagation(); openContextMenu(items, e); }, []);
  const openAt = useCallback((el: HTMLElement, items: MenuItem[]) => openContextMenu(items, el), []);
  return { open, openAt, close: closeContextMenu };
}

function clampToViewport(x: number, y: number, w: number, h: number) {
  const vw = window.innerWidth, vh = window.innerHeight;
  if (x + w > vw - 4) x = Math.max(4, vw - w - 4);
  if (y + h > vh - 4) y = Math.max(4, vh - h - 4);
  return { x, y };
}

function MenuList({ items, x, y, depth, onClose }: { items: MenuItem[]; x: number; y: number; depth: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [sub, setSub] = useState<{ index: number; x: number; y: number } | null>(null);
  const [hi, setHi] = useState(-1);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x, ny = y;
    if (depth > 0 && x + r.width > window.innerWidth - 4) nx = x - r.width - (x - (x - 6)) - 6; // flip left of parent
    setPos(clampToViewport(nx, ny, r.width, r.height));
  }, [x, y, depth]);

  const selectable = items.map((it, i) => (!it.separator && !it.heading && !it.disabled ? i : -1)).filter((i) => i >= 0);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const idx = selectable.indexOf(hi);
      const next = e.key === 'ArrowDown' ? selectable[(idx + 1) % selectable.length] : selectable[(idx - 1 + selectable.length) % selectable.length];
      if (next !== undefined) setHi(next);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const it = items[hi]; if (it) activate(it, hi, e.currentTarget.children[hi] as HTMLElement | undefined);
    } else if (e.key === 'ArrowRight') {
      const it = items[hi]; if (it?.submenu) openSub(hi, e.currentTarget.children[hi] as HTMLElement);
    }
  };
  const openSub = (i: number, el: HTMLElement | undefined) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    setSub({ index: i, x: r.right + 2, y: r.top - 4 });
  };
  const activate = (it: MenuItem, i: number, el?: HTMLElement) => {
    if (it.disabled) return;
    if (it.submenu) { openSub(i, el); return; }
    it.onSelect?.();
    if (!it.keepOpen) onClose();
  };
  useEffect(() => { ref.current?.focus(); }, []);

  return (
    <>
      <div ref={ref} className="menu" role="menu" tabIndex={-1} style={{ left: pos.x, top: pos.y }} onKeyDown={onKeyDown} onContextMenu={(e) => e.preventDefault()}>
        {items.map((it, i) => {
          if (it.separator) return <div key={i} className="menu-sep" role="separator" />;
          if (it.heading) return <div key={i} className="menu-heading">{it.heading}</div>;
          const Icon = it.icon;
          return (
            <div
              key={i} role="menuitem" aria-disabled={it.disabled}
              className={['menu-item', it.disabled ? 'disabled' : '', sub?.index === i || hi === i ? 'open' : ''].filter(Boolean).join(' ')}
              onMouseEnter={(e) => { setHi(i); if (it.submenu) openSub(i, e.currentTarget); else setSub(null); }}
              onClick={(e) => activate(it, i, e.currentTarget)}
            >
              {it.checked ? <Check className="menu-check" /> : Icon ? <Icon className="menu-icon" /> : null}
              <span className="menu-label">{it.label}</span>
              {it.shortcut ? <span className="menu-shortcut">{it.shortcut}</span> : null}
              {it.submenu ? <ChevronRight className="menu-arrow" /> : null}
            </div>
          );
        })}
      </div>
      {sub && items[sub.index]?.submenu ? (
        <MenuList items={items[sub.index].submenu!} x={sub.x} y={sub.y} depth={depth + 1} onClose={onClose} />
      ) : null}
    </>
  );
}

/** Render once in App. Hosts the global context menu. */
export function ContextMenuHost() {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (!s.open) return;
    const onDown = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest?.('.menu')) closeContextMenu(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeContextMenu(); } };
    const onBlur = () => closeContextMenu();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, [s.open]);
  if (!s.open) return null;
  return <MenuList items={s.items} x={s.x} y={s.y} depth={0} onClose={closeContextMenu} />;
}
