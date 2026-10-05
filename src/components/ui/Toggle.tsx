import React from 'react';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: React.ReactNode;
  disabled?: boolean;
  className?: string;
  title?: string;
}

export function Toggle({ checked, onChange, label, disabled, className = '', title }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      className={['toggle', checked ? 'on' : '', disabled ? 'disabled' : '', className].filter(Boolean).join(' ')}
      style={{ background: 'none', border: 'none', padding: 0 }}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span className="toggle-track"><span className="toggle-thumb" /></span>
      {label ? <span>{label}</span> : null}
    </button>
  );
}
