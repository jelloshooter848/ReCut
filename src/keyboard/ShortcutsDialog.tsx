import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Keyboard, RotateCcw, X } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { SearchField } from '@/components/ui/SearchField';
import { closeShortcutsDialog, useShortcutsDialogOpen } from './shortcutsDialogStore';
import {
  addKey, findCommandsForKey, formatKeyLabel, getCommandsSnapshot, getKeys, isOverridden, keyFromEvent, removeKey, resetKeys, subscribeCommands, type Command,
} from './shortcuts';

function KeyCapture({ commandId, onDone }: { commandId: string; onDone: () => void }) {
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { setListening(false); return; }
      const chord = keyFromEvent(e);
      if (!chord) return; // bare modifier
      addKey(commandId, chord);
      setListening(false);
      onDone();
    };
    window.addEventListener('keydown', onKey, true);
    const onDown = (ev: MouseEvent) => { if (!(ev.target as HTMLElement).closest?.('.capture')) setListening(false); };
    window.addEventListener('pointerdown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true); };
  }, [listening, commandId, onDone]);
  return (
    <button type="button" className={['capture', listening ? 'listening' : ''].join(' ')} style={{ background: 'none' }} onClick={() => setListening(true)}>
      {listening ? 'press keys… (Esc cancels)' : '+ add'}
    </button>
  );
}

function ShortcutRow({ cmd }: { cmd: Command }) {
  const keys = getKeys(cmd.id);
  const conflicts = keys.filter((k) => findCommandsForKey(k).some((c) => c.id !== cmd.id));
  const over = isOverridden(cmd.id);
  const conflictTitle = conflicts.map((k) => `${formatKeyLabel(k)} also: ${findCommandsForKey(k).filter((c) => c.id !== cmd.id).map((c) => c.title).join(', ')}`).join('\n');
  return (
    <div className={['shortcut-row', conflicts.length ? 'conflict' : ''].join(' ')} title={conflictTitle || undefined}>
      <div className="ellipsis">
        {cmd.title}
        {cmd.placeholder ? <span className="text-faint text-xs" style={{ marginLeft: 6 }}>(not yet available)</span> : null}
      </div>
      <div className="shortcut-keys">
        {keys.length === 0 ? <span className="unbound">unbound</span> : null}
        {keys.map((k) => (
          <span key={k} className="kbd" title="Click to remove" onClick={() => removeKey(cmd.id, k)}
            style={conflicts.includes(k) ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : undefined}>
            {formatKeyLabel(k)}
          </span>
        ))}
        <KeyCapture commandId={cmd.id} onDone={() => undefined} />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {over ? <button type="button" className="btn-icon btn-sm" title="Reset to default" onClick={() => resetKeys(cmd.id)}><RotateCcw /></button> : null}
      </div>
    </div>
  );
}

export function ShortcutsDialog() {
  const open = useShortcutsDialogOpen();
  const snap = useSyncExternalStore(subscribeCommands, getCommandsSnapshot, getCommandsSnapshot);
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const query = q.trim().toLowerCase();
    const map = new Map<string, Command[]>();
    for (const c of snap.commands) {
      if (query && !(c.title.toLowerCase().includes(query) || c.id.toLowerCase().includes(query) || getKeys(c.id).some((k) => formatKeyLabel(k).toLowerCase().includes(query)))) continue;
      const list = map.get(c.category) ?? []; list.push(c); map.set(c.category, list);
    }
    return Array.from(map.entries()).map(([cat, cmds]) => [cat, cmds.sort((a, b) => a.title.localeCompare(b.title))] as const).sort((a, b) => a[0].localeCompare(b[0]));
  }, [snap, q]);
  const conflictCount = useMemo(() => snap.commands.filter((c) => getKeys(c.id).some((k) => findCommandsForKey(k).length > 1)).length, [snap]);
  const overrideCount = Object.keys(snap.overrides).length;

  return (
    <Dialog open={open} onClose={closeShortcutsDialog} width={720} title={<span className="row gap-6"><Keyboard size={14} /> Keyboard Shortcuts</span>}
      footer={
        <>
          <span className="text-dim text-sm grow">
            {overrideCount ? `${overrideCount} customized` : 'Default bindings'}
            {conflictCount ? <span className="text-danger"> · {conflictCount} with conflicts</span> : null}
          </span>
          <Button icon={RotateCcw} onClick={() => resetKeys()} disabled={!overrideCount}>Reset All</Button>
          <Button variant="primary" onClick={closeShortcutsDialog}>Done</Button>
        </>
      }>
      <div className="shortcuts">
        <div className="row gap-8">
          <SearchField value={q} onChange={setQ} placeholder="Filter commands or keys…" autoFocus />
          {q ? <button type="button" className="btn-icon" onClick={() => setQ('')} aria-label="Clear"><X /></button> : null}
        </div>
        <div className="text-dim text-sm">Click a key chip to remove it, "+ add" to capture a new one. Red chips are bound to more than one command.</div>
        <div className="scroll-y" style={{ maxHeight: '58vh', paddingRight: 4 }}>
          {groups.length === 0 ? <div className="empty">No commands match.</div> : null}
          {groups.map(([cat, cmds]) => (
            <div key={cat}>
              <div className="shortcuts-cat">{cat}</div>
              {cmds.map((c) => <ShortcutRow key={c.id} cmd={c} />)}
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
