import React from 'react';
import { Search, X } from 'lucide-react';

export interface SearchFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'size'> {
  value: string;
  onChange: (value: string) => void;
  size?: 'sm' | 'md';
}

export function SearchField({ value, onChange, size = 'md', placeholder = 'Search…', className = '', ...rest }: SearchFieldProps) {
  return (
    <div className={['input-wrap', className].filter(Boolean).join(' ')}>
      <Search />
      <input
        type="text"
        className={['input', size === 'sm' ? 'input-sm' : ''].filter(Boolean).join(' ')}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape' && value) { onChange(''); e.stopPropagation(); } }}
        {...rest}
      />
      {value ? (
        <button type="button" className="btn-icon btn-sm input-clear" aria-label="Clear" onClick={() => onChange('')}><X /></button>
      ) : null}
    </div>
  );
}
