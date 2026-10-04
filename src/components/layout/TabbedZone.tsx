import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronsRight, Maximize2, Minimize2, MoreHorizontal } from 'lucide-react';
import { getPanel, ZONE_IDS, ZONE_TITLES, type ZoneId } from '@/panels/registry';
import { usePanels } from '@/panels/usePanels';
import { useLayoutStore } from './layoutStore';
import { openContextMenu, type MenuItem } from '@/components/ui/ContextMenu';
import { getShortcutLabel } from '@/keyboard/shortcuts';
import { COMMAND_IDS } from '@/keyboard/commandIds';

export const PANEL_DND_TYPE = 'application/x-recut-panel';

interface DragPayload { panelId: string; fromZone: ZoneId }

function readPayload(dt: DataTransfer): DragPayload | null {
  try { const raw = dt.getData(PANEL_DND_TYPE); return raw ? (JSON.parse(raw) as DragPayload) : null; } catch { return null; }
}

export interface TabbedZoneProps { zoneId: ZoneId }

export function TabbedZone({ zoneId }: TabbedZoneProps) {
  const panelIds = useLayoutStore((s) => s.zones[zoneId]);
  const activeId = useLayoutStore((s) => s.active[zoneId]);
  const focused = useLayoutStore((s) => s.focusedZone === zoneId);
  const maximized = useLayoutStore((s) => s.maximized === zoneId);
  const { setActive, movePanel, toggleMaximize, setFocusedZone } = useLayoutStore.getState();
  const allPanels = usePanels();

  const visible = panelIds.filter((id) => !!getPanel(id));
  const active = activeId && visible.includes(activeId) ? activeId : visible[0];

  const [dropOver, setDropOver] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragDepth = useRef(0);
  const stripRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  // Track tab overflow and keep the active tab in view.
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const check = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible.length]);
  useEffect(() => {
    const el = scrollRef.current; if (!el || !active) return;
    const tab = el.querySelector<HTMLElement>(`.zone-tab[data-panel="${active}"]`);
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  const overflowMenuItems = useCallback((): MenuItem[] =>
    visible.map((id) => ({ label: getPanel(id)!.title, icon: getPanel(id)!.icon, checked: id === active, onSelect: () => setActive(zoneId, id) })),
  [visible, active, zoneId, setActive]);

  const zoneMenuItems = useCallback((): MenuItem[] => [
    { heading: ZONE_TITLES[zoneId] },
    { label: maximized ? 'Restore' : 'Maximize', shortcut: getShortcutLabel(COMMAND_IDS.maximizePanel), onSelect: () => toggleMaximize(zoneId) },
    { separator: true },
    { heading: 'Show panel here' },
    ...allPanels.map((p) => ({ label: p.title, icon: p.icon, checked: visible.includes(p.id), onSelect: () => (visible.includes(p.id) ? setActive(zoneId, p.id) : movePanel(p.id, zoneId)) })),
  ], [zoneId, maximized, allPanels, visible, toggleMaximize, setActive, movePanel]);

  const tabMenuItems = useCallback((panelId: string): MenuItem[] => [
    {
      label: 'Move to…',
      submenu: ZONE_IDS.filter((z) => z !== zoneId).map((z) => ({ label: ZONE_TITLES[z], onSelect: () => movePanel(panelId, z) })),
    },
    { separator: true },
    { label: maximized ? 'Restore' : 'Maximize', shortcut: getShortcutLabel(COMMAND_IDS.maximizePanel), onSelect: () => toggleMaximize(zoneId) },
  ], [zoneId, maximized, movePanel, toggleMaximize]);

  const dropIndex = (clientX: number): number => {
    const strip = stripRef.current; if (!strip) return visible.length;
    const tabs = Array.from(strip.querySelectorAll<HTMLElement>('.zone-tab'));
    let i = 0;
    for (const t of tabs) { const r = t.getBoundingClientRect(); if (clientX > r.left + r.width / 2) i++; }
    return i;
  };

  return (
    <div
      className={['zone', focused ? 'focused' : '', dropOver ? 'drop-target' : ''].filter(Boolean).join(' ')}
      data-zone={zoneId}
      onPointerDownCapture={() => setFocusedZone(zoneId)}
      onDragEnter={(e) => { if (e.dataTransfer.types.includes(PANEL_DND_TYPE)) { dragDepth.current++; setDropOver(true); } }}
      onDragLeave={() => { if (dragDepth.current > 0) dragDepth.current--; if (dragDepth.current === 0) setDropOver(false); }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes(PANEL_DND_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
      onDrop={(e) => {
        dragDepth.current = 0; setDropOver(false);
        const p = readPayload(e.dataTransfer); if (!p) return;
        e.preventDefault();
        const inStrip = !!(e.target as HTMLElement).closest?.('.zone-tabs');
        movePanel(p.panelId, zoneId, inStrip ? dropIndex(e.clientX) : undefined);
      }}
    >
      <div className="zone-tabs" ref={stripRef} role="tablist" onContextMenu={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); openContextMenu(zoneMenuItems(), e); } }}>
        <div className="zone-tabs-scroll" ref={scrollRef}>
          {visible.map((id) => {
            const def = getPanel(id)!;
            const Icon = def.icon;
            return (
              <div
                key={id} role="tab" aria-selected={id === active} title={def.description ?? def.title} data-panel={id}
                className={['zone-tab', id === active ? 'active' : '', draggingId === id ? 'dragging' : ''].filter(Boolean).join(' ')}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(PANEL_DND_TYPE, JSON.stringify({ panelId: id, fromZone: zoneId } satisfies DragPayload));
                  e.dataTransfer.effectAllowed = 'move';
                  setDraggingId(id);
                }}
                onDragEnd={() => setDraggingId(null)}
                onMouseDown={(e) => { if (e.button === 0) setActive(zoneId, id); }}
                onDoubleClick={() => toggleMaximize(zoneId)}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setActive(zoneId, id); openContextMenu(tabMenuItems(id), e); }}
              >
                {Icon ? <Icon /> : null}
                <span>{def.title}</span>
              </div>
            );
          })}
          <div className="zone-tab-spacer" onDoubleClick={() => toggleMaximize(zoneId)} />
        </div>
        {overflowing ? (
          <div className="zone-tabs-overflow">
            <button type="button" className="btn-icon" title="More tabs" aria-label="More tabs" onClick={(e) => openContextMenu(overflowMenuItems(), e.currentTarget)}><ChevronsRight /></button>
          </div>
        ) : null}
        <div className="zone-actions">
          <button type="button" className="btn-icon" title={maximized ? 'Restore' : 'Maximize'} aria-label={maximized ? 'Restore' : 'Maximize'} onClick={() => toggleMaximize(zoneId)}>
            {maximized ? <Minimize2 /> : <Maximize2 />}
          </button>
          <button type="button" className="btn-icon" title="Panel menu" aria-label="Panel menu" onClick={(e) => openContextMenu(zoneMenuItems(), e.currentTarget)}>
            <MoreHorizontal />
          </button>
        </div>
      </div>
      <div className="zone-body">
        {visible.length === 0 ? <div className="zone-empty">Drop a panel here</div> : null}
        {visible.map((id) => {
          const def = getPanel(id)!;
          const Comp = def.component;
          const isActive = id === active;
          return (
            <div key={id} className="zone-panel" role="tabpanel" hidden={!isActive} style={isActive ? undefined : { display: 'none' }}>
              <Comp panelId={id} zoneId={zoneId} active={isActive} focused={focused && isActive} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
