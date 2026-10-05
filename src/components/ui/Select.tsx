import React from 'react';

export interface SelectOption<T extends string = string> { value: T; label: string; disabled?: boolean }

export interface SelectProps<T extends string = string> extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value' | 'size'> {
  value: T;
  options: SelectOption<T>[] | readonly SelectOption<T>[];
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
}

export function Select<T extends string = string>({ value, options, onChange, size = 'md', className = '', ...rest }: SelectProps<T>) {
  return (
    <select
      className={['select', size === 'sm' ? 'select-sm' : '', className].filter(Boolean).join(' ')}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      {...rest}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
      ))}
    </select>
  );
}
