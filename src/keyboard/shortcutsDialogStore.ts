import { useSyncExternalStore } from 'react';

let open = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function openShortcutsDialog() { if (!open) { open = true; emit(); } }
export function closeShortcutsDialog() { if (open) { open = false; emit(); } }
export function toggleShortcutsDialog() { open = !open; emit(); }
export function useShortcutsDialogOpen() { return useSyncExternalStore(subscribe, () => open, () => open); }
