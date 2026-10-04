import React from 'react';

export interface LabelColor { id: string; name: string; hex: string }

/** Eight Premiere-style label colors. */
export const LABEL_COLORS: readonly LabelColor[] = [
  { id: 'violet', name: 'Violet', hex: '#8e6cf0' },
  { id: 'iris', name: 'Iris', hex: '#5b7cf5' },
  { id: 'caribbean', name: 'Caribbean', hex: '#2bb3c0' },
  { id: 'lavender', name: 'Lavender', hex: '#c47ad6' },
  { id: 'cerulean', name: 'Cerulean', hex: '#3f8de0' },
  { id: 'forest', name: 'Forest', hex: '#4caf6e' },
  { id: 'rose', name: 'Rose', hex: '#e0609a' },
  { id: 'mango', name: 'Mango', hex: '#f0a040' },
];

export function labelColorHex(idOrHex: string | undefined): string | undefined {
  if (!idOrHex) return undefined;
  return LABEL_COLORS.find((c) => c.id === idOrHex)?.hex ?? idOrHex;
}

export interface ColorSwatchProps { color: string; selected?: boolean; size?: 'md' | 'lg'; title?: string; onClick?: () => void }

export function ColorSwatch({ color, selected, size = 'md', title, onClick }: ColorSwatchProps) {
  return (
    <button type="button" className={['swatch', size === 'lg' ? 'swatch-lg' : '', selected ? 'selected' : ''].filter(Boolean).join(' ')}
      style={{ background: labelColorHex(color), padding: 0 }} title={title} aria-label={title} aria-pressed={selected} onClick={onClick} />
  );
}

export interface ColorSwatchPickerProps {
  /** Selected color id or hex */
  value?: string;
  onChange: (hex: string, color: LabelColor) => void;
  size?: 'md' | 'lg';
  className?: string;
}

export function ColorSwatchPicker({ value, onChange, size = 'md', className = '' }: ColorSwatchPickerProps) {
  const hex = labelColorHex(value)?.toLowerCase();
  return (
    <div className={['swatches', className].filter(Boolean).join(' ')} role="radiogroup">
      {LABEL_COLORS.map((c) => (
        <ColorSwatch key={c.id} color={c.hex} size={size} title={c.name} selected={hex === c.hex.toLowerCase()} onClick={() => onChange(c.hex, c)} />
      ))}
    </div>
  );
}
