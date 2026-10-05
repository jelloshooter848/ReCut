import React, { useEffect, useState } from 'react';
import { Button, Dialog } from '@/components/ui';

export interface NamePromptProps {
  open: boolean;
  title: string;
  label?: string;
  initial: string;
  confirmLabel?: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
  /** Extra content rendered under the name field (hints, previews). */
  children?: React.ReactNode;
}

/** Small in-app replacement for window.prompt: a Dialog with a single name field. */
export function NamePromptDialog({ open, title, label = 'Name', initial, confirmLabel = 'Create', onConfirm, onCancel, children }: NamePromptProps) {
  const [value, setValue] = useState(initial);
  useEffect(() => { if (open) setValue(initial); }, [open, initial]);
  const submit = () => { const v = value.trim(); if (v) onConfirm(v); };
  return (
    <Dialog open={open} title={title} onClose={onCancel} width={380}
      footer={<>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={!value.trim()} onClick={submit} data-testid="name-prompt-confirm">{confirmLabel}</Button>
      </>}>
      <form className="col gap-6" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label className="text-dim text-sm" htmlFor="name-prompt-input">{label}</label>
        <input id="name-prompt-input" data-testid="name-prompt-input" className="input" value={value} autoFocus spellCheck={false}
          onFocus={(e) => e.currentTarget.select()} onChange={(e) => setValue(e.target.value)} />
        {children}
      </form>
    </Dialog>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ open, title, message, confirmLabel = 'Delete', danger = true, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <Dialog open={open} title={title} onClose={onCancel} width={380}
      footer={<>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} data-testid="confirm-dialog-confirm">{confirmLabel}</Button>
      </>}>
      <div className="text-dim" style={{ lineHeight: 1.5 }}>{message}</div>
    </Dialog>
  );
}
