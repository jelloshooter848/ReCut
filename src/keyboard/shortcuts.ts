/**
 * Command registry + keyboard binding engine.
 *
 * Key strings are canonical chords: modifiers in the order Ctrl, Alt, Shift, Meta, then the key, joined by '+'.
 * 'Ctrl' means the platform primary modifier (Cmd on macOS, Control elsewhere). On macOS the physical Control key is 'Control'.
 * Keys: 'A'..'Z', '0'..'9', 'Space', 'ArrowLeft', 'Enter', 'Escape', 'Delete', 'Backspace', 'Home', 'End', 'Tab', 'F1'.., and
 * punctuation as the literal character (',', '.', ';', "'", '=', '-', '\\', '`', '[', ']', '/').
 */
import { COMMAND_IDS } from './commandIds';

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');

export interface CommandInput {
  id: string;
  title: string;
  category: string;
  /** Falls back to DEFAULT_BINDINGS[id] when omitted. */
  defaultKeys?: string[];
  when?: () => boolean;
  run: () => void;
  /** True for shell stubs that only reserve the id/binding until an implementation registers. */
  placeholder?: boolean;
}
export interface Command extends CommandInput { defaultKeys: string[] }

/** Default key bindings per command id. */
export const DEFAULT_BINDINGS: Record<string, string[]> = {
  [COMMAND_IDS.playPause]: ['Space'],
  [COMMAND_IDS.shuttleBack]: ['J'],
  [COMMAND_IDS.shuttleStop]: ['K'],
  [COMMAND_IDS.shuttleForward]: ['L'],
  [COMMAND_IDS.stepBack]: ['ArrowLeft'],
  [COMMAND_IDS.stepForward]: ['ArrowRight'],
  [COMMAND_IDS.stepBack5]: ['Shift+ArrowLeft'],
  [COMMAND_IDS.stepForward5]: ['Shift+ArrowRight'],
  [COMMAND_IDS.prevEdit]: ['ArrowUp'],
  [COMMAND_IDS.nextEdit]: ['ArrowDown'],
  [COMMAND_IDS.goToStart]: ['Home'],
  [COMMAND_IDS.goToEnd]: ['End'],
  [COMMAND_IDS.goToIn]: ['Shift+I'],
  [COMMAND_IDS.goToOut]: ['Shift+O'],
  [COMMAND_IDS.nudgeLeft]: ['Alt+ArrowLeft'],
  [COMMAND_IDS.nudgeRight]: ['Alt+ArrowRight'],
  [COMMAND_IDS.markIn]: ['I'],
  [COMMAND_IDS.markOut]: ['O'],
  [COMMAND_IDS.clearInOut]: ['Ctrl+Shift+X'],
  [COMMAND_IDS.addMarker]: ['M'],
  [COMMAND_IDS.matchFrame]: ['F'],
  [COMMAND_IDS.deleteSelection]: ['Delete', 'Backspace'],
  [COMMAND_IDS.rippleDelete]: ['Shift+Delete'],
  [COMMAND_IDS.addEdit]: ['Ctrl+K'],
  [COMMAND_IDS.insert]: [','],
  [COMMAND_IDS.overwrite]: ['.'],
  [COMMAND_IDS.lift]: [';'],
  [COMMAND_IDS.extract]: ["'"],
  [COMMAND_IDS.rippleTrimPrev]: ['Q'],
  [COMMAND_IDS.rippleTrimNext]: ['W'],
  [COMMAND_IDS.defaultVideoTransition]: ['Ctrl+D'],
  [COMMAND_IDS.defaultAudioTransition]: ['Ctrl+Shift+D'],
  [COMMAND_IDS.toggleClipEnabled]: ['Shift+E'],
  [COMMAND_IDS.linkUnlink]: ['Ctrl+L'],
  [COMMAND_IDS.undo]: ['Ctrl+Z'],
  [COMMAND_IDS.redo]: ['Ctrl+Shift+Z', 'Ctrl+Y'],
  [COMMAND_IDS.cut]: ['Ctrl+X'],
  [COMMAND_IDS.copy]: ['Ctrl+C'],
  [COMMAND_IDS.paste]: ['Ctrl+V'],
  [COMMAND_IDS.selectAll]: ['Ctrl+A'],
  [COMMAND_IDS.deselectAll]: ['Ctrl+Shift+A'],
  [COMMAND_IDS.toolSelect]: ['V'],
  [COMMAND_IDS.toolRazor]: ['C'],
  [COMMAND_IDS.toolRipple]: ['B'],
  [COMMAND_IDS.toolRolling]: ['N'],
  [COMMAND_IDS.toolSlip]: ['Y'],
  [COMMAND_IDS.toolSlide]: ['U'],
  [COMMAND_IDS.toolTrack]: ['A'],
  [COMMAND_IDS.newProject]: ['Ctrl+N'],
  [COMMAND_IDS.openProject]: ['Ctrl+O'],
  [COMMAND_IDS.save]: ['Ctrl+S'],
  [COMMAND_IDS.saveAs]: ['Ctrl+Shift+S'],
  [COMMAND_IDS.importMedia]: ['Ctrl+I'],
  [COMMAND_IDS.export]: ['Ctrl+M'],
  [COMMAND_IDS.newSequence]: ['Ctrl+Shift+N'],
  [COMMAND_IDS.zoomIn]: ['='],
  [COMMAND_IDS.zoomOut]: ['-'],
  [COMMAND_IDS.zoomToFit]: ['\\'],
  [COMMAND_IDS.maximizePanel]: ['Ctrl+`'],
  [COMMAND_IDS.fullscreenProgram]: ['Ctrl+Shift+F'],
  [COMMAND_IDS.toggleFullscreen]: ['F11'],
  [COMMAND_IDS.focusPanel1]: ['Shift+1'],
  [COMMAND_IDS.focusPanel2]: ['Shift+2'],
  [COMMAND_IDS.focusPanel3]: ['Shift+3'],
  [COMMAND_IDS.focusPanel4]: ['Shift+4'],
  [COMMAND_IDS.focusPanel5]: ['Shift+5'],
  [COMMAND_IDS.focusPanel6]: ['Shift+6'],
  [COMMAND_IDS.focusPanel7]: ['Shift+7'],
  [COMMAND_IDS.focusPanel8]: ['Shift+8'],
  [COMMAND_IDS.focusPanel9]: ['Shift+9'],
  [COMMAND_IDS.workspaceEditing]: ['Alt+Shift+1'],
  [COMMAND_IDS.workspaceResearch]: ['Alt+Shift+2'],
  [COMMAND_IDS.workspaceAudio]: ['Alt+Shift+3'],
  [COMMAND_IDS.workspaceCompare]: ['Alt+Shift+4'],
  [COMMAND_IDS.resetWorkspace]: ['Alt+Shift+0'],
  [COMMAND_IDS.openShortcuts]: ['Ctrl+Alt+K'],
};

// ---------------------------------------------------------------- registry
const commands = new Map<string, Command>();
let commandList: Command[] = [];
let overrides: Record<string, string[]> = {};
const listeners = new Set<() => void>();
let snapshot = { commands: commandList, overrides };
const emit = () => { commandList = Array.from(commands.values()); snapshot = { commands: commandList, overrides }; listeners.forEach((l) => l()); };

/** Register or replace a command. Returns an unregister function. */
export function registerCommand(input: CommandInput): () => void {
  const cmd: Command = { ...input, defaultKeys: input.defaultKeys ?? DEFAULT_BINDINGS[input.id] ?? [] };
  commands.set(cmd.id, cmd);
  emit();
  return () => { if (commands.get(cmd.id) === cmd) { commands.delete(cmd.id); emit(); } };
}
export function registerCommands(inputs: CommandInput[]): () => void {
  const offs = inputs.map(registerCommand);
  return () => offs.forEach((o) => o());
}
export function getCommand(id: string): Command | undefined { return commands.get(id); }
export function getCommands(): Command[] { return commandList; }
export function subscribeCommands(cb: () => void): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; }
export function getCommandsSnapshot() { return snapshot; }

/** Run a command by id (respects `when`). Returns true when it ran. */
export function runCommand(id: string): boolean {
  const cmd = commands.get(id);
  if (!cmd) return false;
  if (cmd.when && !cmd.when()) return false;
  try { cmd.run(); } catch (err) { console.error(`[commands] ${id} failed`, err); }
  return true;
}

// ---------------------------------------------------------------- bindings
export function getKeys(id: string): string[] {
  if (overrides[id]) return overrides[id];
  return commands.get(id)?.defaultKeys ?? DEFAULT_BINDINGS[id] ?? [];
}
export function isOverridden(id: string): boolean { return id in overrides; }
export function getOverrides(): Record<string, string[]> { return overrides; }

export function setKeys(id: string, keys: string[]): void {
  const def = commands.get(id)?.defaultKeys ?? DEFAULT_BINDINGS[id] ?? [];
  const norm = Array.from(new Set(keys.map(normalizeKeyString).filter(Boolean)));
  if (norm.length === def.length && norm.every((k, i) => k === def[i])) delete overrides[id];
  else overrides = { ...overrides, [id]: norm };
  overrides = { ...overrides };
  emit();
  void persistOverrides();
}
export function addKey(id: string, key: string): void { setKeys(id, [...getKeys(id), key]); }
export function removeKey(id: string, key: string): void { setKeys(id, getKeys(id).filter((k) => k !== key)); }
export function resetKeys(id?: string): void {
  if (id === undefined) overrides = {};
  else { overrides = { ...overrides }; delete overrides[id]; }
  emit();
  void persistOverrides();
}

/** All commands bound to a key chord (first = highest priority: most recently registered wins). */
export function findCommandsForKey(key: string): Command[] {
  const out: Command[] = [];
  for (const cmd of commandList) if (getKeys(cmd.id).includes(key)) out.push(cmd);
  return out.reverse();
}

/** Commands that share any key with the given command (conflicts). */
export function findConflicts(id: string): { key: string; command: Command }[] {
  const out: { key: string; command: Command }[] = [];
  for (const key of getKeys(id)) for (const c of findCommandsForKey(key)) if (c.id !== id) out.push({ key, command: c });
  return out;
}

// ---------------------------------------------------------------- persistence
const LS_KEY = 'recut.shortcuts.v1';
const SEP = ' ';
let persistTimer: number | undefined;

async function persistOverrides(): Promise<void> {
  try { localStorage.setItem(LS_KEY, JSON.stringify(overrides)); } catch { /* ignore */ }
  const api = typeof window !== 'undefined' ? window.recut : undefined;
  if (!api?.setPrefs) return;
  if (persistTimer) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    const shortcuts: Record<string, string> = {};
    for (const [id, keys] of Object.entries(overrides)) shortcuts[id] = keys.join(SEP);
    api.setPrefs({ shortcuts }).catch(() => { /* ignore */ });
  }, 300);
}

/** Load user overrides: prefs via window.recut when available, else localStorage. */
export async function loadOverrides(): Promise<void> {
  let loaded: Record<string, string[]> | null = null;
  const api = typeof window !== 'undefined' ? window.recut : undefined;
  if (api?.getPrefs) {
    try {
      const prefs = await api.getPrefs();
      if (prefs?.shortcuts && Object.keys(prefs.shortcuts).length) {
        loaded = {};
        for (const [id, v] of Object.entries(prefs.shortcuts)) loaded[id] = String(v).split(SEP).map(normalizeKeyString).filter(Boolean);
      }
    } catch { /* ignore */ }
  }
  if (!loaded) {
    try { const raw = localStorage.getItem(LS_KEY); if (raw) loaded = JSON.parse(raw); } catch { /* ignore */ }
  }
  if (loaded && typeof loaded === 'object') { overrides = loaded; emit(); }
}

// ---------------------------------------------------------------- key parsing / formatting
const CODE_KEYS: Record<string, string> = {
  Comma: ',', Period: '.', Semicolon: ';', Quote: "'", Equal: '=', Minus: '-', Backslash: '\\', Backquote: '`',
  BracketLeft: '[', BracketRight: ']', Slash: '/', IntlBackslash: '\\', Space: 'Space',
  NumpadAdd: '=', NumpadSubtract: '-', NumpadEnter: 'Enter', NumpadDecimal: '.',
};
const KEY_ALIASES: Record<string, string> = {
  ' ': 'Space', spacebar: 'Space', esc: 'Escape', del: 'Delete', return: 'Enter', plus: '=', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  cmd: 'Ctrl', command: 'Ctrl', mod: 'Ctrl', meta: 'Meta', control: 'Control', option: 'Alt', opt: 'Alt',
};
const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta', 'Control'];

/** Canonicalize a key chord string like 'ctrl+shift+z' → 'Ctrl+Shift+Z'. */
export function normalizeKeyString(s: string): string {
  if (!s) return '';
  const parts = s.trim().split('+');
  // handle a literal '+' key: 'Ctrl++' → ['Ctrl','','']
  const tokens: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '' && i > 0) { tokens.push('='); i++; continue; }
    tokens.push(parts[i]);
  }
  const mods = new Set<string>();
  let key = '';
  for (let t of tokens) {
    const low = t.toLowerCase();
    t = KEY_ALIASES[low] ?? t;
    if (low === 'ctrl' || low === 'cmd' || low === 'command' || low === 'mod') mods.add('Ctrl');
    else if (low === 'alt' || low === 'option' || low === 'opt') mods.add('Alt');
    else if (low === 'shift') mods.add('Shift');
    else if (low === 'meta' || low === 'win' || low === 'super') mods.add('Meta');
    else if (low === 'control') mods.add('Control');
    else key = t.length === 1 ? t.toUpperCase() : t.charAt(0).toUpperCase() + t.slice(1);
  }
  if (!key) return '';
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}

export function isModifierKey(key: string): boolean {
  return key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta' || key === 'OS' || key === 'AltGraph' || key === 'CapsLock';
}

/** Canonical chord for a keyboard event, or null for a bare modifier press. */
export function keyFromEvent(e: KeyboardEvent | { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): string | null {
  if (isModifierKey(e.key)) return null;
  let key: string;
  const code = e.code || '';
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^Numpad[0-9]$/.test(code)) key = code.slice(6);
  else if (CODE_KEYS[code]) key = CODE_KEYS[code];
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else {
    key = e.key;
    if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();
    else if (key === 'Esc') key = 'Escape';
    else if (key === 'Spacebar') key = 'Space';
  }
  const mods: string[] = [];
  const primary = IS_MAC ? e.metaKey : e.ctrlKey;
  if (primary) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (IS_MAC ? false : e.metaKey) mods.push('Meta');
  if (IS_MAC && e.ctrlKey) mods.push('Control');
  return [...mods, key].join('+');
}

const PRETTY: Record<string, string> = {
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Space: 'Space', Escape: 'Esc', Delete: IS_MAC ? '⌦' : 'Del', Backspace: IS_MAC ? '⌫' : 'Backspace',
  Enter: IS_MAC ? '↩' : 'Enter', Tab: 'Tab', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
};

/** Human label for a chord: '⌘⇧Z' on macOS, 'Ctrl+Shift+Z' elsewhere. */
export function formatKeyLabel(chord: string): string {
  if (!chord) return '';
  const parts = chord.split('+');
  // literal '=' encoded; split('+') is safe because we never store '+' as a key
  const key = parts.pop()!;
  const k = PRETTY[key] ?? key;
  if (IS_MAC) {
    const sym: Record<string, string> = { Ctrl: '⌘', Alt: '⌥', Shift: '⇧', Control: '⌃', Meta: '⌘' };
    return parts.map((p) => sym[p] ?? p).join('') + k;
  }
  return [...parts.map((p) => (p === 'Meta' ? 'Win' : p)), k].join('+');
}

/** Primary shortcut label for a command (for menus/tooltips). '' when unbound. */
export function getShortcutLabel(commandId: string): string {
  const keys = getKeys(commandId);
  return keys.length ? formatKeyLabel(keys[0]) : '';
}
/** All shortcut labels for a command. */
export function getShortcutLabels(commandId: string): string[] { return getKeys(commandId).map(formatKeyLabel); }
