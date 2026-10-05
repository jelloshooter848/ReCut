import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export interface DialogProps {
  open: boolean;
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number | string;
  /** Clicking the backdrop closes the dialog (default true). */
  closeOnBackdrop?: boolean;
  className?: string;
  /**
   * Primary action run by Enter (outside textareas / buttons). When omitted, Enter clicks the enabled primary
   * footer button (`.btn-primary`, or `[data-dialog-primary]`). Pass `false` to disable Enter-to-submit.
   */
  onSubmit?: (() => void) | false;
  /** When true, Enter does nothing (e.g. the primary action is not ready yet). */
  submitDisabled?: boolean;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Elements whose own Enter behaviour wins over the dialog's primary action. */
function enterIsLocal(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.closest('textarea, [contenteditable="true"], [data-dialog-enter="local"]')) return true;
  const tag = el.tagName;
  if (tag === 'BUTTON' || tag === 'A') return true;
  const role = el.getAttribute('role');
  return role === 'button' || role === 'checkbox' || role === 'switch' || role === 'menuitem' || role === 'option' || role === 'tab';
}

function visible(n: HTMLElement): boolean { return n.offsetParent !== null || n.getClientRects().length > 0; }

/** The enabled primary footer button of a dialog element, if any. */
export function findPrimaryButton(dialog: HTMLElement): HTMLButtonElement | null {
  const explicit = dialog.querySelector<HTMLButtonElement>('.dialog-footer [data-dialog-primary]');
  if (explicit) return explicit;
  const prim = Array.from(dialog.querySelectorAll<HTMLButtonElement>('.dialog-footer .btn-primary'));
  return prim[prim.length - 1] ?? null;
}

/** Initial focus: an [autofocus] element, else the first focusable control in the body, else the primary footer button. */
export function initialFocusTarget(dialog: HTMLElement): HTMLElement | null {
  const body = dialog.querySelector<HTMLElement>('.dialog-body');
  const auto = dialog.querySelector<HTMLElement>('[autofocus]:not([disabled]), [data-autofocus]:not([disabled])');
  if (auto) return auto;
  const first = body ? Array.from(body.querySelectorAll<HTMLElement>(FOCUSABLE)).find(visible) : undefined;
  if (first) return first;
  const primary = findPrimaryButton(dialog);
  if (primary && !primary.disabled) return primary;
  const footerBtn = dialog.querySelector<HTMLElement>('.dialog-footer button:not([disabled])');
  return footerBtn ?? null;
}

export function Dialog({ open, title, onClose, children, footer, width, closeOnBackdrop = true, className = '', onSubmit, submitDisabled }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<Element | null>(null);
  // Latest props for the deferred Enter handler (state set by a field's own Enter must be visible to the action).
  const submitRef = useRef<{ onSubmit: DialogProps['onSubmit']; disabled: boolean }>({ onSubmit, disabled: !!submitDisabled });
  submitRef.current = { onSubmit, disabled: !!submitDisabled };
  const formSubmitAt = useRef(0);
  // Callers often pass an inline onClose; keep it in a ref so a parent re-render does not re-run the open effect
  // (which would steal focus back and drop a pending Enter).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    prevFocus.current = document.activeElement;
    const el = ref.current;
    // Children with autoFocus have already focused themselves during commit; keep that.
    if (el && !el.contains(document.activeElement)) (initialFocusTarget(el) ?? el).focus();
    const isTopmost = () => {
      const all = document.querySelectorAll('[role="dialog"]');
      return all[all.length - 1] === el;
    };
    const onKey = (e: KeyboardEvent) => {
      if (!isTopmost()) return;
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onCloseRef.current(); return; }
      if (e.key === 'Tab' && el) {
        const nodes = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(visible);
        if (!nodes.length) { e.preventDefault(); return; }
        const firstN = nodes[0], lastN = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === firstN) { e.preventDefault(); lastN.focus(); }
        else if (!e.shiftKey && document.activeElement === lastN) { e.preventDefault(); firstN.focus(); }
        return;
      }
      if (e.key === 'Enter' && !e.isComposing && !e.altKey && !e.metaKey && el) {
        const target = e.target as HTMLElement | null;
        if (target && target !== el && !el.contains(target) && target !== document.body) return;
        if (enterIsLocal(target)) return;
        if (submitRef.current.onSubmit === false) return;
        const startedAt = performance.now();
        // Run after the focused field's own Enter handling (commit / tag add) and React's re-render.
        window.setTimeout(() => {
          if (!alive || e.defaultPrevented) return;
          if (formSubmitAt.current >= startedAt) return; // a <form onSubmit> already handled it
          const { onSubmit: fn, disabled } = submitRef.current;
          if (disabled) return;
          if (typeof fn === 'function') { fn(); return; }
          const btn = findPrimaryButton(el);
          if (btn && !btn.disabled) btn.click();
        }, 0);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      alive = false;
      window.removeEventListener('keydown', onKey, true);
      (prevFocus.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="dialog-backdrop" onPointerDown={(e) => { if (closeOnBackdrop && e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={['dialog', className].filter(Boolean).join(' ')} role="dialog" aria-modal="true" tabIndex={-1} style={{ width }}
        onKeyDown={(e) => e.stopPropagation()} onSubmitCapture={() => { formSubmitAt.current = performance.now(); }}>
        <div className="dialog-title">
          <span className="grow ellipsis">{title}</span>
          <button type="button" className="btn-icon btn-sm" aria-label="Close" tabIndex={-1} onClick={onClose}><X /></button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-footer">{footer}</div> : null}
      </div>
    </div>
  );
}
