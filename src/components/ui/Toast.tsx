import React, { useSyncExternalStore } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { dismissToast, getToasts, runToastAction, subscribeToasts } from './toastStore';

const ICONS = { info: Info, ok: CheckCircle2, warn: AlertTriangle, error: XCircle } as const;

/** Render once in App. */
export function ToastHost() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  if (!toasts.length) return null;
  return (
    <div className="toast-host" aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div key={t.id} className={`toast ${t.kind}`} role="status">
            <Icon />
            <span className="grow selectable">{t.text}</span>
            {t.action ? <button type="button" className="btn btn-sm toast-action" data-testid="toast-action" onClick={() => runToastAction(t.id)}>{t.action.label}</button> : null}
            <button type="button" className="btn-icon btn-sm" aria-label="Dismiss" onClick={() => dismissToast(t.id)}><X /></button>
          </div>
        );
      })}
    </div>
  );
}
