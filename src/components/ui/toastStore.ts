export type ToastKind = 'info' | 'ok' | 'warn' | 'error';
/** A button on a toast (#110): runs `run`, then dismisses the toast. */
export interface ToastAction { label: string; run: () => void }
export interface Toast { id: number; kind: ToastKind; text: string; createdAt: number; timeout: number; action?: ToastAction }

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function subscribeToasts(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
export function getToasts() { return toasts; }

export function dismissToast(id: number) {
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id); emit();
}

/**
 * Show a toast. Returns its id. kind: 'info' | 'ok' | 'warn' | 'error'. `timeout` 0 keeps it until dismissed;
 * `action` adds a button.
 */
export function toast(kind: ToastKind, text: string, timeout = kind === 'error' ? 8000 : 3500, action?: ToastAction): number {
  const id = nextId++;
  toasts = [...toasts.slice(-5), { id, kind, text, createdAt: Date.now(), timeout, ...(action ? { action } : {}) }];
  emit();
  if (timeout > 0) window.setTimeout(() => dismissToast(id), timeout);
  return id;
}
/** Run a toast's action and dismiss it. */
export function runToastAction(id: number) {
  const t = toasts.find((x) => x.id === id);
  if (!t?.action) return;
  dismissToast(id);
  t.action.run();
}
toast.info = (text: string) => toast('info', text);
toast.ok = (text: string) => toast('ok', text);
toast.warn = (text: string) => toast('warn', text);
toast.error = (text: string) => toast('error', text);
