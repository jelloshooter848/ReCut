import React, { useRef } from 'react';
import { Splitter } from '@/components/ui/Splitter';
import { TabbedZone } from './TabbedZone';
import { TopBar, type TopBarProps } from './TopBar';
import { useLayoutStore, visibleZonePanels, WORKSPACE_PRESETS, type LayoutSizes } from './layoutStore';
import { usePanels } from '@/panels/usePanels';
import type { ZoneId } from '@/panels/registry';

export interface LayoutProps extends TopBarProps {
  /** Rendered between the top bar and the zones (e.g. a global toolbar). */
  toolbar?: React.ReactNode;
  /** Rendered below the zones (e.g. a status bar). */
  statusBar?: React.ReactNode;
}

/** One zone in its layout slot. Every zone stays mounted in place when another is maximized (panels never remount). */
function ZoneSlot({ zoneId, style }: { zoneId: ZoneId; style?: React.CSSProperties }) {
  const isMax = useLayoutStore((s) => s.maximized === zoneId);
  return (
    <div className={['layout-col', 'layout-zone-slot', isMax ? 'layout-maximized' : ''].filter(Boolean).join(' ')} style={isMax ? undefined : style} data-zone-slot={zoneId}>
      <TabbedZone zoneId={zoneId} />
    </div>
  );
}

/**
 * Workspace layout:
 *   [TopBar]
 *   [ left-top    ] [ monitor-left | monitor-right ] [ right ]
 *   [ left-bottom ] [ center-bottom                ] [       ]
 * A maximized zone is lifted over the body with CSS (its slot becomes `.layout-maximized`); the other slots and
 * splitters are hidden but stay mounted, so e.g. Program playback survives maximize / restore.
 */
export function Layout({ toolbar, statusBar, ...topBar }: LayoutProps) {
  usePanels(); // re-render on registrations so empty zones collapse/expand
  const zones = useLayoutStore((s) => s.zones);
  const sizes = useLayoutStore((s) => s.sizes);
  const maximized = useLayoutStore((s) => s.maximized);
  const workspace = useLayoutStore((s) => s.workspace);
  const setSizes = useLayoutStore((s) => s.setSizes);

  const has = (z: ZoneId) => visibleZonePanels(zones[z]).length > 0;
  const leftVisible = has('left-top') || has('left-bottom');
  const rightVisible = has('right');
  const monitorsVisible = has('monitor-left') || has('monitor-right');
  const bottomVisible = has('center-bottom');

  const leftCol = useRef<HTMLDivElement>(null);
  const centerCol = useRef<HTMLDivElement>(null);
  const monitorRow = useRef<HTMLDivElement>(null);
  const start = useRef<LayoutSizes>(sizes);
  const begin = () => { start.current = useLayoutStore.getState().sizes; };
  const preset = WORKSPACE_PRESETS[workspace].sizes;

  return (
    <div className="layout" data-workspace={workspace}>
      <TopBar {...topBar} />
      {toolbar}
      <div className={['layout-body', maximized ? 'has-maximized' : ''].filter(Boolean).join(' ')} style={{ padding: 3 }} data-maximized={maximized ?? undefined}>
        {leftVisible && (
          <div className="layout-col" ref={leftCol} style={{ flex: `0 0 ${sizes.leftW}px`, width: sizes.leftW }}>
            {has('left-top') && <ZoneSlot zoneId="left-top" style={{ flex: `${has('left-bottom') ? sizes.leftSplit : 1} 1 0px` }} />}
            {has('left-top') && has('left-bottom') && (
              <Splitter direction="v" onDragStart={begin} onDoubleClick={() => setSizes({ leftSplit: preset.leftSplit })}
                onDrag={(d) => setSizes({ leftSplit: start.current.leftSplit + d / Math.max(1, leftCol.current?.clientHeight ?? 1) })} />
            )}
            {has('left-bottom') && <ZoneSlot zoneId="left-bottom" style={{ flex: `${has('left-top') ? 1 - sizes.leftSplit : 1} 1 0px` }} />}
          </div>
        )}
        {leftVisible && <Splitter direction="h" onDragStart={begin} onDoubleClick={() => setSizes({ leftW: preset.leftW })} onDrag={(d) => setSizes({ leftW: start.current.leftW + d })} />}

        <div className="layout-col" ref={centerCol} style={{ flex: '1 1 0px' }}>
          {monitorsVisible && (
            <div className="layout-row" ref={monitorRow} style={{ flex: `${bottomVisible ? sizes.centerSplit : 1} 1 0px` }}>
              {has('monitor-left') && <ZoneSlot zoneId="monitor-left" style={{ flex: `${has('monitor-right') ? sizes.monitorSplit : 1} 1 0px` }} />}
              {has('monitor-left') && has('monitor-right') && (
                <Splitter direction="h" onDragStart={begin} onDoubleClick={() => setSizes({ monitorSplit: 0.5 })}
                  onDrag={(d) => setSizes({ monitorSplit: start.current.monitorSplit + d / Math.max(1, monitorRow.current?.clientWidth ?? 1) })} />
              )}
              {has('monitor-right') && <ZoneSlot zoneId="monitor-right" style={{ flex: `${has('monitor-left') ? 1 - sizes.monitorSplit : 1} 1 0px` }} />}
            </div>
          )}
          {monitorsVisible && bottomVisible && (
            <Splitter direction="v" onDragStart={begin} onDoubleClick={() => setSizes({ centerSplit: preset.centerSplit })}
              onDrag={(d) => setSizes({ centerSplit: start.current.centerSplit + d / Math.max(1, centerCol.current?.clientHeight ?? 1) })} />
          )}
          {bottomVisible && <ZoneSlot zoneId="center-bottom" style={{ flex: `${monitorsVisible ? 1 - sizes.centerSplit : 1} 1 0px` }} />}
          {!monitorsVisible && !bottomVisible && <div className="zone"><div className="zone-empty">Drop panels here</div></div>}
        </div>

        {rightVisible && <Splitter direction="h" onDragStart={begin} onDoubleClick={() => setSizes({ rightW: preset.rightW })} onDrag={(d) => setSizes({ rightW: start.current.rightW - d })} />}
        {rightVisible && <ZoneSlot zoneId="right" style={{ flex: `0 0 ${sizes.rightW}px`, width: sizes.rightW }} />}
      </div>
      {statusBar}
    </div>
  );
}
