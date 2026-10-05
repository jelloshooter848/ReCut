import React, { useEffect, useState } from 'react';

export interface TextFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'size'> {
  value: string;
  onChange: (value: string) => void;
  /** Called on Enter/blur with the final value (when commitOnBlur). */
  onCommit?: (value: string) => void;
  /** Keep local state while typing; only call onChange on Enter/blur. */
  commitOnBlur?: boolean;
  size?: 'sm' | 'md';
  invalid?: boolean;
  selectOnFocus?: boolean;
}

export function TextField({ value, onChange, onCommit, commitOnBlur, size = 'md', invalid, selectOnFocus, className = '', onKeyDown, onBlur, onFocus, ...rest }: TextFieldProps) {
  const [local, setLocal] = useState(value);
  useEffect(() => { setLocal(value); }, [value]);
  const commit = (v: string) => { if (commitOnBlur) onChange(v); onCommit?.(v); };
  return (
    <input
      type="text"
      className={['input', size === 'sm' ? 'input-sm' : '', invalid ? 'invalid' : '', className].filter(Boolean).join(' ')}
      value={commitOnBlur ? local : value}
      spellCheck={false}
      onChange={(e) => { setLocal(e.target.value); if (!commitOnBlur) onChange(e.target.value); }}
      onFocus={(e) => { if (selectOnFocus) e.currentTarget.select(); onFocus?.(e); }}
      onBlur={(e) => { commit(e.currentTarget.value); onBlur?.(e); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit(e.currentTarget.value); e.currentTarget.blur(); }
        else if (e.key === 'Escape') { setLocal(value); e.currentTarget.blur(); }
        onKeyDown?.(e);
      }}
      {...rest}
    />
  );
}
