import React from 'react';
import type { LucideIcon } from 'lucide-react';

export interface TabItem<T extends string = string> { id: T; label: React.ReactNode; icon?: LucideIcon; count?: number; disabled?: boolean }

export interface TabsProps<T extends string = string> {
  tabs: TabItem<T>[] | readonly TabItem<T>[];
  active: T;
  onChange: (id: T) => void;
  variant?: 'block' | 'underline';
  className?: string;
  right?: React.ReactNode;
}

/** Simple in-panel tab strip (not the layout zone tabs). */
export function Tabs<T extends string = string>({ tabs, active, onChange, variant = 'block', className = '', right }: TabsProps<T>) {
  return (
    <div className={['tabs', className].filter(Boolean).join(' ')} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id} type="button" role="tab" aria-selected={t.id === active} disabled={t.disabled}
          className={['tab', variant === 'underline' ? 'underline' : '', t.id === active ? 'active' : ''].filter(Boolean).join(' ')}
          style={{ border: 'none', borderRight: variant === 'block' ? '1px solid var(--bg-0)' : 'none' }}
          onClick={() => onChange(t.id)}
        >
          {t.icon ? <t.icon size={12} /> : null}
          <span className="ellipsis">{t.label}</span>
          {t.count !== undefined ? <span className="tab-count">{t.count}</span> : null}
        </button>
      ))}
      {right ? <div className="row ml-auto px-6" style={{ height: '100%' }}>{right}</div> : null}
    </div>
  );
}
