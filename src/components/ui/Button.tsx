import React from 'react';
import type { LucideIcon } from 'lucide-react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  icon?: LucideIcon;
  active?: boolean;
}

export function Button({ variant = 'default', size = 'md', icon: Icon, active, className = '', children, type = 'button', ...rest }: ButtonProps) {
  const cls = ['btn', variant !== 'default' ? `btn-${variant}` : '', size === 'sm' ? 'btn-sm' : '', active ? 'active' : '', className]
    .filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} {...rest}>
      {Icon ? <Icon /> : null}
      {children}
    </button>
  );
}
