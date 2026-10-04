/**
 * "SHOW ONLY" filter bar: tag checkboxes with counts, Highlight / Solo mode, Clear, and what-if experiments
 * that disable / enable clips in one undo step.
 */
import React, { useMemo } from 'react';
import { Eye, EyeOff, FlaskConical, RotateCcw, X } from 'lucide-react';
import type { Sequence } from '@shared/model';
import { allTracks } from '@shared/timeline';
import { useStore } from '@/state';
import { filterMatches, filtersActive } from '@/state/selectors';
import type { FilterState } from '@/state/types';
import { Button } from '@/components/ui/Button';
import { formatHMS, formatMS, tagCounts, TAG_KINDS, whatIf, type TagKind } from './util';

export interface FilterBarProps { seq: Sequence; filters: FilterState; palette: Map<string, string> }

export function FilterBar({ seq, filters, palette }: FilterBarProps) {
  const counts = useMemo(() => tagCounts(seq), [seq]);
  const active = filtersActive(filters);
  const stats = useMemo(() => whatIf(seq, filters), [seq, filters]);
  const anyTags = TAG_KINDS.some(({ kind }) => counts[kind].length > 0);

  const toggle = (kind: TagKind, value: string, on: boolean) => {
    const list = filters[kind];
    useStore.getState().setFilters({ [kind]: on ? [...list, value] : list.filter((v) => v !== value) });
  };

  /** One undoable commit over every clip in the sequence. */
  const bulkEnable = (label: string, predicate: (enabled: boolean, matches: boolean) => boolean | null) => {
    const st = useStore.getState();
    const f = st.ui.filters;
    const changed = st.commit(label, (d) => {
      const s = d.sequences[seq.id];
      if (!s) return;
      for (const t of allTracks(s)) for (const c of t.clips) {
        const next = predicate(c.enabled, filterMatches(c, f));
        if (next !== null && next !== c.enabled) c.enabled = next;
      }
    });
    if (!changed) st.toast('info', 'Nothing to change');
  };

  const disabledCount = allTracks(seq).reduce((n, t) => n + t.clips.filter((c) => !c.enabled).length, 0);

  return (
    <div className="sl-filterbar" data-testid="storyline-filterbar">
      <div className="sl-filter-groups">
        <span className="sl-filter-title uppercase">Show only</span>
        {!anyTags ? <span className="text-faint text-sm">No character / plotline / location tags on clips yet. Tag clips in the Inspector.</span> : null}
        {TAG_KINDS.map(({ kind, title }) => counts[kind].length ? (
          <div className="sl-filter-group" key={kind}>
            <span className="sl-filter-group-title">{title}</span>
            {counts[kind].map(({ value, count }) => {
              const on = filters[kind].includes(value);
              return (
                <label key={value} className={`sl-filter-chip ${on ? 'on' : ''}`} title={`${value} · ${count} clip${count === 1 ? '' : 's'}`}>
                  <input type="checkbox" checked={on} data-testid={`filter-${kind}-${value}`} onChange={(e) => toggle(kind, value, e.target.checked)} />
                  {kind === 'characters' ? <span className="sl-dot" style={{ background: palette.get(value) ?? '#5a5a5a' }} /> : null}
                  <span className="ellipsis">{value}</span>
                  <span className="sl-filter-count">{count}</span>
                </label>
              );
            })}
          </div>
        ) : null)}
      </div>

      <div className="sl-filter-actions">
        <div className="btn-group" role="radiogroup" aria-label="Filter mode">
          <Button size="sm" icon={Eye} active={filters.mode === 'highlight'} data-testid="filter-mode-highlight" title="Highlight: dim clips that do not match"
            onClick={() => useStore.getState().setFilters({ mode: 'highlight' })}>Highlight</Button>
          <Button size="sm" icon={EyeOff} active={filters.mode === 'solo'} data-testid="filter-mode-solo" title="Solo: show only matching clips in the timeline"
            onClick={() => useStore.getState().setFilters({ mode: 'solo' })}>Solo</Button>
        </div>
        <Button size="sm" variant="ghost" icon={X} disabled={!active} data-testid="filter-clear" onClick={() => useStore.getState().clearFilters()}>Clear</Button>
        <span className="divider-v" />
        <span className="sl-filter-group-title row gap-4"><FlaskConical size={12} /> What if</span>
        <Button size="sm" disabled={!active} data-testid="disable-non-matching" title="Disable every enabled clip that does not match the filter (one undo step)"
          onClick={() => bulkEnable('Disable non-matching clips', (enabled, matches) => (!matches && enabled ? false : null))}>Disable clips NOT matching</Button>
        <Button size="sm" disabled={!active} data-testid="disable-matching" title="Disable every enabled clip that matches the filter (one undo step)"
          onClick={() => bulkEnable('Disable matching clips', (enabled, matches) => (matches && enabled ? false : null))}>Disable matching</Button>
        <Button size="sm" icon={RotateCcw} disabled={disabledCount === 0} data-testid="enable-all" title="Re-enable every disabled clip (one undo step)"
          onClick={() => bulkEnable('Enable all clips', (enabled) => (enabled ? null : true))}>Enable all{disabledCount ? ` (${disabledCount})` : ''}</Button>
        {stats ? (
          <span className="sl-whatif mono" data-testid="whatif-readout" title="Sequence duration minus the matching clips on V1 (ignores gaps closing and other tracks)">
            Runtime if removed: <b>{formatHMS(stats.runtimeIfRemoved, seq.fps)}</b>
            <span className="text-dim"> (−{formatMS(stats.matchingV1Frames, seq.fps)})</span>
            <span className="text-faint"> · estimated</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
