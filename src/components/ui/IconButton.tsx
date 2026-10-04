import React from 'react';
import type { LucideIcon } from 'lucide-react';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  size?: 'sm' | 'md';
  toggled?: boolean;
  /** Use the orange accent when toggled (e.g. in/out, snapping). */
  accent2?: boolean;
  shortcut?: string;
}

export function IconButton({ icon: Icon, label, size = 'md', toggled, accent2, shortcut, className = '', type = 'button', ...rest }: IconButtonProps) {
  const cls = ['btn-icon', size === 'sm' ? 'btn-sm' : '', toggled ? 'toggled' : '', accent2 ? 'accent-2' : '', className].filter(Boolean).join(' ');
  const title = shortcut ? `${label} (${shortcut})` : label;
  return (
    <button type={type} className={cls} aria-label={label} title={title} aria-pressed={toggled} {...rest}>
      <Icon />
    </button>
  );
}
