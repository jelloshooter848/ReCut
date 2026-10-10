import React, { useEffect, useMemo, useState } from 'react';
import type { DetectedScene, ID, MediaItem } from '@shared/model';
import { Button, Dialog, NumberField, TagInput, TextField, Toggle } from '@/components/ui';
import { toast } from '@/components/ui/toastStore';
import { useStore, fileNameOf } from '@/state';
import { formatClock } from '@shared/time';
import { parseEpisodeInfo } from './parseIdentity';
import { detectScenes, makeSceneFromShots, nextSceneName } from './actions';
import { NamePromptDialog } from '@/panels/scenes/NamePromptDialog';

/** Partial identity update; store.updateMedia merges over the current identity and clears fields set to undefined. */
function patchIdentity(id: ID, patch: Partial<MediaItem['identity']>): void {
  useStore.getState().updateMedia(id, { identity: patch as MediaItem['identity'] });
}

export type PanelDialog =
  | { type: 'series'; ids: ID[] }
  | { type: 'collection'; ids: ID[] }
  | { type: 'tag'; mediaId: ID; sceneId: ID }
  | { type: 'split'; mediaId: ID; sceneId: ID }
  | { type: 'detect'; ids: ID[] }
  | { type: 'makeScene'; mediaId: ID; shotIds: ID[] }
  | null;

// ---------------------------------------------------------------- Organize as Series

interface EpisodeDraft { id: ID; name: string; season: number; episode: number; title: string }

export function OrganizeSeriesDialog({ items, onClose }: { items: MediaItem[]; onClose: () => void }) {
  const parsed = useMemo(() => items.map((m) => ({ m, p: parseEpisodeInfo(fileNameOf(m.path)) })), [items]);
  const defaultSeries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { m, p } of parsed) { const s = m.identity.series ?? p.series; if (s) counts.set(s, (counts.get(s) ?? 0) + 1); }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  }, [parsed]);
  const [series, setSeries] = useState(defaultSeries);
  const [rows, setRows] = useState<EpisodeDraft[]>(() => parsed.map(({ m, p }, i) => ({
    id: m.id, name: m.name,
    season: m.identity.season ?? p.season ?? 1,
    episode: m.identity.episode ?? p.episode ?? i + 1,
    title: m.identity.title ?? p.title ?? '',
  })));
  const [season, setSeason] = useState<number>(() => rows[0]?.season ?? 1);
  const setAllSeasons = (n: number) => { setSeason(n); setRows((r) => r.map((x) => ({ ...x, season: n }))); };
  const patch = (id: ID, p: Partial<EpisodeDraft>) => setRows((r) => r.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const apply = () => {
    const name = series.trim();
    if (!name) { toast('warn', 'Enter a series name'); return; }
    const st = useStore.getState();
    const bySeason = new Map<number, EpisodeDraft[]>();
    for (const r of rows) { const l = bySeason.get(r.season) ?? []; l.push(r); bySeason.set(r.season, l); }
    for (const [s, list] of bySeason) {
      st.organizeAsSeries(list.map((r) => ({ id: r.id, episode: r.episode, title: r.title.trim() })), name, s);
    }
    toast('ok', `Organized ${rows.length} item${rows.length === 1 ? '' : 's'} as ${name}`);
    onClose();
  };

  return (
    <Dialog open title="Organize as Series" onClose={onClose} width={520}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={apply} data-testid="series-apply">Organize</Button></>}>
      <div className="pp-dialog-grid">
        <label>Series</label>
        <TextField value={series} onChange={setSeries} placeholder="Series name" autoFocus selectOnFocus data-testid="series-name" />
        <label>Season</label>
        <div className="row gap-6">
          <NumberField value={season} onChange={setAllSeasons} min={0} max={99} />
          <span className="text-dim text-sm">applies to every row (edit rows below for mixed seasons)</span>
        </div>
      </div>
      <table className="pp-dialog-table">
        <thead><tr><th>File</th><th>Season</th><th>Episode</th><th>Title</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="name" title={r.name}>{r.name}</td>
              <td><NumberField value={r.season} onChange={(v) => patch(r.id, { season: v })} min={0} max={99} /></td>
              <td><NumberField value={r.episode} onChange={(v) => patch(r.id, { episode: v })} min={0} max={999} /></td>
              <td><TextField size="sm" value={r.title} onChange={(v) => patch(r.id, { title: v })} placeholder="Episode title" /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-dim text-xs mt-8">Episode numbers are parsed from file names (S01E03, 1x03, "Season 1 Episode 3"). Items move into TV › {series || 'Series'} › Season bins.</div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Collection / Franchise

export function CollectionDialog({ items, onClose }: { items: MediaItem[]; onClose: () => void }) {
  const first = items[0];
  const [collection, setCollection] = useState(first?.identity.collection ?? '');
  const [franchise, setFranchise] = useState(first?.identity.franchise ?? '');
  const apply = () => {
    for (const m of items) patchIdentity(m.id, { collection: collection.trim() || undefined, franchise: franchise.trim() || undefined });
    toast('ok', `Updated ${items.length} item${items.length === 1 ? '' : 's'}`);
    onClose();
  };
  return (
    <Dialog open title="Set Collection / Franchise" onClose={onClose} width={420}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={apply}>Apply</Button></>}>
      <div className="pp-dialog-grid">
        <label>Collection</label><TextField value={collection} onChange={setCollection} placeholder="e.g. Original Trilogy" autoFocus />
        <label>Franchise</label><TextField value={franchise} onChange={setFranchise} placeholder="e.g. Star Wars" />
      </div>
      <div className="text-dim text-xs mt-8">Applies to {items.length} selected item{items.length === 1 ? '' : 's'}. Leave a field empty to clear it.</div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Tag scene

export function TagSceneDialog({ media, scene, onClose }: { media: MediaItem; scene: DetectedScene; onClose: () => void }) {
  const vocab = useStore((s) => s.project.tags);
  const [characters, setCharacters] = useState<string[]>(scene.characters);
  const [tags, setTags] = useState<string[]>(scene.tags);
  const apply = () => { useStore.getState().tagDetectedScene(media.id, scene.id, { characters, tags }); onClose(); };
  return (
    <Dialog open title={`Tag "${scene.name}"`} onClose={onClose} width={420}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={apply}>Apply</Button></>}>
      <div className="pp-dialog-grid">
        <label>Characters</label><TagInput value={characters} onChange={setCharacters} suggestions={vocab.characters} placeholder="Add character…" />
        <label>Tags</label><TagInput value={tags} onChange={setTags} suggestions={[...vocab.custom, ...vocab.themes]} placeholder="Add tag…" />
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Split shot

export function SplitSceneDialog({ media, scene, onClose }: { media: MediaItem; scene: DetectedScene; onClose: () => void }) {
  const [at, setAt] = useState((scene.start + scene.end) / 2);
  const apply = () => {
    if (at <= scene.start || at >= scene.end) { toast('warn', 'Split time must be inside the shot'); return; }
    useStore.getState().splitDetectedScene(media.id, scene.id, at);
    onClose();
  };
  return (
    <Dialog open title={`Split "${scene.name}"`} onClose={onClose} width={360}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={apply}>Split</Button></>}>
      <div className="pp-dialog-grid">
        <label>Shot</label><span className="mono text-dim">{formatClock(scene.start, true)} – {formatClock(scene.end, true)}</span>
        <label>Split at</label>
        <div className="row gap-6"><NumberField value={at} onChange={setAt} min={scene.start} max={scene.end} step={0.1} precision={2} unit="s" /><span className="mono text-dim">{formatClock(at, true)}</span></div>
      </div>
      <div className="text-dim text-xs mt-8">Tip: load the media in the Source monitor and park the playhead; "Split at source time" then uses that time directly.</div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Detect shots

export function DetectScenesDialog({ ids, onClose }: { ids: ID[]; onClose: () => void }) {
  const defaultThreshold = useStore((s) => s.project.settings.sceneThreshold);
  const [threshold, setThreshold] = useState(defaultThreshold);
  const [saveDefault, setSaveDefault] = useState(false);
  useEffect(() => { setThreshold(defaultThreshold); }, [defaultThreshold]);
  const run = () => {
    if (saveDefault && threshold !== defaultThreshold) useStore.getState().setSettings({ sceneThreshold: threshold });
    void detectScenes(ids, threshold);
    onClose();
  };
  return (
    <Dialog open title="Detect Shots" onClose={onClose} width={380}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={run} data-testid="detect-run">Detect</Button></>}>
      <div className="pp-dialog-grid">
        <label>Threshold</label>
        <div className="row gap-6"><NumberField value={threshold} onChange={setThreshold} min={0.05} max={0.95} step={0.01} precision={2} /><span className="text-dim text-sm">lower = more cuts</span></div>
        <label />
        <Toggle checked={saveDefault} onChange={setSaveDefault} label="Save as project default" />
      </div>
      <div className="text-dim text-xs mt-8">Finds the cuts between shots in {ids.length} file{ids.length === 1 ? '' : 's'} in the background. Existing detected shots are replaced.</div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- host

export function PanelDialogs({ dialog, onClose }: { dialog: PanelDialog; onClose: () => void }) {
  const media = useStore((s) => s.project.media);
  if (!dialog) return null;
  if (dialog.type === 'series' || dialog.type === 'collection') {
    const items = dialog.ids.map((id) => media[id]).filter((m): m is MediaItem => !!m);
    if (!items.length) return null;
    return dialog.type === 'series' ? <OrganizeSeriesDialog items={items} onClose={onClose} /> : <CollectionDialog items={items} onClose={onClose} />;
  }
  if (dialog.type === 'detect') return <DetectScenesDialog ids={dialog.ids} onClose={onClose} />;
  if (dialog.type === 'makeScene') {
    const { mediaId, shotIds } = dialog;
    return (
      <NamePromptDialog open title={shotIds.length > 1 ? `Make Scene from ${shotIds.length} Shots` : 'Make Scene from Shot'} label="Scene name" initial={nextSceneName()}
        confirmLabel="Make Scene" onCancel={onClose} onConfirm={(name) => { makeSceneFromShots(mediaId, shotIds, name); onClose(); }}>
        <div className="text-dim text-xs">The scene is added to the Scenes tab, covering the selected shots.</div>
      </NamePromptDialog>
    );
  }
  const m = media[dialog.mediaId];
  const scene = m?.detectedScenes.find((s) => s.id === dialog.sceneId);
  if (!m || !scene) return null;
  return dialog.type === 'tag' ? <TagSceneDialog media={m} scene={scene} onClose={onClose} /> : <SplitSceneDialog media={m} scene={scene} onClose={onClose} />;
}
