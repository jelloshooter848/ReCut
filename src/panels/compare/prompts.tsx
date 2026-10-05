/**
 * Small prompt / confirm dialogs used by the Compare panel (built on the shared Dialog).
 */
import React, { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';

export interface PromptField { key: string; label: string; placeholder?: string; initial?: string; required?: boolean }

export interface PromptDialogProps {
  open: boolean;
  title: string;
  fields: PromptField[];
  submitLabel?: string;
  description?: React.ReactNode;
  onClose: () => void;
  onSubmit: (values: Record<string, string>) => void;
  testId?: string;
}

export function PromptDialog({ open, title, fields, submitLabel = 'OK', description, onClose, onSubmit, testId }: PromptDialogProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    const init: Record<string, string> = {};
    for (const f of fields) init[f.key] = f.initial ?? '';
    setValues(init);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!open) return null;
  const valid = fields.every((f) => !f.required || (values[f.key] ?? '').trim().length > 0);
  const submit = () => { if (valid) onSubmit(Object.fromEntries(fields.map((f) => [f.key, (values[f.key] ?? '').trim()]))); };
  return (
    <Dialog open title={title} onClose={onClose} width={380}
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} data-testid={testId ? `${testId}-submit` : undefined} onClick={submit}>{submitLabel}</Button>
        </>
      )}>
      <div className="col gap-8" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}>
        {description ? <div className="text-dim text-sm">{description}</div> : null}
        {fields.map((f, i) => (
          <label key={f.key} className="col gap-4">
            <span className="text-dim text-sm">{f.label}</span>
            <input className="input" value={values[f.key] ?? ''} autoFocus={i === 0} placeholder={f.placeholder} spellCheck={false}
              data-testid={testId ? `${testId}-${f.key}` : undefined}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
          </label>
        ))}
      </div>
    </Dialog>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onClose: () => void;
  onConfirm: () => void;
  testId?: string;
}

export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', danger, onClose, onConfirm, testId }: ConfirmDialogProps) {
  if (!open) return null;
  return (
    <Dialog open title={title} onClose={onClose} width={380}
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} data-testid={testId ? `${testId}-confirm` : undefined} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      )}>
      <div className="text-sm" style={{ lineHeight: 1.5 }}>{message}</div>
    </Dialog>
  );
}
