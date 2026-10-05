import { useEffect } from 'react';
import { findCommandsForKey, keyFromEvent } from './shortcuts';

/** Chords that still fire while typing in a text field or while a dialog has focus. */
const ALLOWED_IN_INPUTS = new Set(['Escape', 'Ctrl+S', 'Ctrl+Shift+S']);

/** True when `t` sits inside a modal dialog or a popover form (their keys belong to the dialog). */
export function isInsideDialog(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !(el instanceof HTMLElement)) return false;
  return !!el.closest('[role="dialog"], .dialog, .dialog-backdrop, .tl-popover');
}

/** True when global shortcuts must not handle a key whose target is `t` (text entry or dialog). */
export function shouldIgnoreShortcutTarget(t: EventTarget | null): boolean {
  if (isEditableTarget(t) || isInsideDialog(t)) return true;
  // Focus inside a dialog while the event targets body (e.g. focus lost to a removed node): still a dialog.
  if (typeof document !== 'undefined' && document.querySelector('[role="dialog"][aria-modal="true"]')) return true;
  return false;
}

export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'range', 'color', 'file', 'submit'].includes(type);
  }
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable;
}

/** Dispatch a keyboard event to the command registry. Returns true if a command handled it. */
export function dispatchKeyEvent(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return false;
  const chord = keyFromEvent(e);
  if (!chord) return false;
  if (shouldIgnoreShortcutTarget(e.target) && !ALLOWED_IN_INPUTS.has(chord)) return false;
  const candidates = findCommandsForKey(chord);
  for (const cmd of candidates) {
    if (cmd.when && !cmd.when()) continue;
    e.preventDefault();
    e.stopPropagation();
    try { cmd.run(); } catch (err) { console.error(`[shortcuts] ${cmd.id} failed`, err); }
    return true;
  }
  return false;
}

/** Installs the single global keydown listener. Call once from App. */
export function useShortcuts(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => { if (!e.repeat || isRepeatable(e)) dispatchKeyEvent(e); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}

function isRepeatable(e: KeyboardEvent): boolean {
  // Allow key repeat for stepping/nudging, not for toggles like Space or tool switches.
  return e.key.startsWith('Arrow') || e.key === '=' || e.key === '-' || e.code === 'Equal' || e.code === 'Minus';
}
