import React, { useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { openContextMenu, type MenuItem } from './ContextMenu';

export interface MenuButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  items: MenuItem[] | (() => MenuItem[]);
  label?: React.ReactNode;
  icon?: LucideIcon;
  variant?: 'default' | 'ghost' | 'primary';
  size?: 'sm' | 'md';
  /** Hide the chevron (icon-only dropdowns). */
  noChevron?: boolean;
}

/** A button that opens a dropdown menu anchored beneath it. */
export function MenuButton({ items, label, icon: Icon, variant = 'default', size = 'md', noChevron, className = '', type = 'button', ...rest }: MenuButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const cls = ['btn', 'dropdown-btn', variant !== 'default' ? `btn-${variant}` : '', size === 'sm' ? 'btn-sm' : '', className].filter(Boolean).join(' ');
  return (
    <button ref={ref} type={type} className={cls} aria-haspopup="menu"
      onClick={(e) => { e.stopPropagation(); if (ref.current) openContextMenu(typeof items === 'function' ? items() : items, ref.current); }} {...rest}>
      {Icon ? <Icon /> : null}
      {label}
      {noChevron ? null : <ChevronDown className="chev" />}
    </button>
  );
}

export type { MenuItem };
