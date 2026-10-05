import React, { useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';

export interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export function TagInput({ value, onChange, suggestions = [], placeholder = 'Add tag…', className = '', disabled }: TagInputProps) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    return suggestions.filter((s) => !value.includes(s) && (!q || s.toLowerCase().includes(q))).slice(0, 8);
  }, [text, suggestions, value]);

  const add = (t: string) => {
    const tag = t.trim();
    if (!tag || value.includes(tag)) { setText(''); return; }
    onChange([...value, tag]); setText(''); setHi(0);
  };
  const remove = (t: string) => onChange(value.filter((v) => v !== t));

  return (
    <div className={['input taginput', className].filter(Boolean).join(' ')} onClick={() => inputRef.current?.focus()} style={disabled ? { opacity: 0.5 } : undefined}>
      {value.map((t) => (
        <span key={t} className="tag">
          {t}
          {!disabled && <span className="tag-x" role="button" aria-label={`Remove ${t}`} onClick={(e) => { e.stopPropagation(); remove(t); }}><X size={9} /></span>}
        </span>
      ))}
      <input
        ref={inputRef} value={text} placeholder={value.length ? '' : placeholder} disabled={disabled} spellCheck={false}
        onChange={(e) => { setText(e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          // Enter on an empty field is left to the surrounding form/dialog (Enter = Apply).
          if ((e.key === 'Enter' && text.trim()) || e.key === ',') { e.preventDefault(); add(open && matches[hi] && text ? matches[hi] : text); }
          else if (e.key === 'Backspace' && !text && value.length) remove(value[value.length - 1]);
          else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, matches.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === 'Escape') { setOpen(false); e.stopPropagation(); }
        }}
      />
      {open && matches.length > 0 && (
        <div className="taginput-suggest list">
          {matches.map((m, i) => (
            <div key={m} className={['list-item', i === hi ? 'selected' : ''].join(' ')} onMouseDown={(e) => { e.preventDefault(); add(m); }}>{m}</div>
          ))}
        </div>
      )}
    </div>
  );
}
