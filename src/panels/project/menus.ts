import type { ID, MediaCategory, MediaItem } from '@shared/model';
import { MEDIA_CATEGORIES } from '@shared/model';
import type { MenuItem } from '@/components/ui';
import { toast } from '@/components/ui/toastStore';
import { useStore } from '@/state';
import { IS_MAC } from '@/keyboard/shortcuts';
import { embeddedStreamEntry } from '@/ocr/ocrUi';
import { openTranscribeDialog } from '@/whisper/whisperUi';
import type { BinRow, GroupRow, SceneRow, SequenceRow } from './tree';
import type { PanelDialog } from './dialogs';
import {
  addSceneToLibrary, cancelMediaJob, contiguousShots, deleteSequenceConfirmed, generateProxy, importEmbedded, importSubtitlesViaDialog, importViaDialog,
  insertAllShots, insertAtPlayhead, insertRangesAtPlayhead, loadInSource, locateMedia, mergeWithNext, openSequence, removeMediaConfirmed, revealInFolder,
} from './actions';

export interface MenuEnv {
  /** All selected media ids (the clicked one is always included). */
  selectedMedia: ID[];
  /** Selected shot rows (detected scenes), in list order. */
  selectedShots: SceneRow[];
  openPanelDialog(d: PanelDialog): void;
  startRename(key: string): void;
  expandScenes(mediaId: ID): void;
  newBin(parentId: ID | null): void;
}

const revealLabel = IS_MAC ? 'Reveal in Finder' : 'Show in Folder';

export function mediaMenu(m: MediaItem, env: MenuEnv): MenuItem[] {
  const ids = env.selectedMedia.includes(m.id) ? env.selectedMedia : [m.id];
  const many = ids.length > 1;
  const st = useStore.getState();
  const hasSeq = !!st.project.activeSequenceId;
  const proxyBusy = m.proxy.status === 'queued' || m.proxy.status === 'running';
  const sceneBusy = m.sceneDetectStatus === 'running';
  const embedded = m.probe?.subtitles ?? [];
  const n = (s: string) => (many ? `${s} (${ids.length})` : s);
  return [
    { label: 'Load in Source', shortcut: 'Enter', disabled: m.offline, onSelect: () => loadInSource(m.id, 0) },
    { label: 'Insert at Playhead', shortcut: ',', disabled: m.offline || !hasSeq, onSelect: () => insertAtPlayhead(m.id, 'insert') },
    { label: 'Overwrite at Playhead', shortcut: '.', disabled: m.offline || !hasSeq, onSelect: () => insertAtPlayhead(m.id, 'overwrite') },
    ...(m.detectedScenes.length ? [{
      label: 'Insert All Shots at Playhead', disabled: m.offline || !hasSeq, title: `Places all ${m.detectedScenes.length} shots back to back, in order`,
      onSelect: () => { insertAllShots(m.id, 'insert'); },
    }] : []),
    { separator: true },
    proxyBusy
      ? { label: 'Cancel Proxy', onSelect: () => { void cancelMediaJob(m.id, 'proxy'); } }
      : { label: n(m.proxy.status === 'ready' ? 'Regenerate Proxy' : 'Generate Proxy'), disabled: m.offline || m.kind !== 'video', onSelect: () => { for (const id of ids) void generateProxy(id); } },
    sceneBusy
      ? { label: 'Cancel Shot Detection', onSelect: () => { void cancelMediaJob(m.id, 'sceneDetect'); } }
      : { label: n('Detect Shots…'), disabled: m.offline || m.kind !== 'video', onSelect: () => { for (const id of ids) env.expandScenes(id); env.openPanelDialog({ type: 'detect', ids: ids.filter((id) => st.project.media[id]?.kind === 'video') }); } },
    { label: 'Import Subtitles…', disabled: m.offline, onSelect: () => { void importSubtitlesViaDialog(m.id); } },
    {
      label: 'Embedded Subtitles', disabled: m.offline || embedded.length === 0,
      submenu: embedded.map((s) => {
        const e = embeddedStreamEntry(s);
        return { label: e.label, disabled: e.disabled, onSelect: () => { void importEmbedded(m.id, s.index); } };
      }),
    },
    { label: n('Transcribe with Whisper…'), disabled: m.offline || !m.probe?.audio?.length, onSelect: () => openTranscribeDialog(ids) },
    { separator: true },
    {
      label: n('Set Category'),
      submenu: MEDIA_CATEGORIES.map((c: MediaCategory) => ({ label: c, checked: !many && m.category === c, onSelect: () => { for (const id of ids) st.updateMedia(id, { category: c }); } })),
    },
    { label: n('Organize as Series…'), onSelect: () => env.openPanelDialog({ type: 'series', ids }) },
    { label: n('Set Collection / Franchise…'), onSelect: () => env.openPanelDialog({ type: 'collection', ids }) },
    { separator: true },
    { label: 'Rename', shortcut: 'F2', onSelect: () => env.startRename(`media:${m.id}`) },
    { label: revealLabel, disabled: m.offline, onSelect: () => revealInFolder(m.path) },
    { label: 'Relink…', onSelect: () => { void locateMedia(m.id); } },
    { separator: true },
    { label: n('Remove from Project'), shortcut: 'Del', onSelect: () => { void removeMediaConfirmed(ids); } },
  ];
}

export function sceneMenu(row: SceneRow, env: MenuEnv): MenuItem[] {
  const { media: m, scene: s } = row;
  const st = useStore.getState();
  const hasSeq = !!st.project.activeSequenceId;
  const range = { in: s.start, out: s.end };
  // Several shots selected (and the clicked one among them): the actions apply to all of them (#143).
  const sel = env.selectedShots.some((r) => r.scene.id === s.id) ? env.selectedShots : [row];
  const many = sel.length > 1;
  const ranges = sel.map((r) => ({ mediaId: r.media.id, in: r.scene.start, out: r.scene.end }));
  const anyOffline = sel.some((r) => r.media.offline);
  const sameMedia = sel.every((r) => r.media.id === m.id);
  const run = sameMedia ? contiguousShots(m, sel.map((r) => r.scene.id)) : null;
  const notRun = !sameMedia ? 'The selected shots are from different clips' : run ? undefined : 'The selected shots must follow each other';
  const splitAtSource = () => {
    const sc = useStore.getState().ui.sourceClip;
    if (sc && sc.mediaId === m.id) {
      if (sc.time > s.start && sc.time < s.end) { useStore.getState().splitDetectedScene(m.id, s.id, sc.time); return; }
      toast('warn', 'Source playhead is outside this shot; enter a time instead');
    }
    env.openPanelDialog({ type: 'split', mediaId: m.id, sceneId: s.id });
  };
  const ids = sel.map((r) => r.scene.id);
  return [
    { label: 'Load in Source', shortcut: 'Enter', disabled: m.offline, onSelect: () => loadInSource(m.id, s.start, range) },
    { label: many ? `Insert ${sel.length} Shots at Playhead` : 'Insert at Playhead', disabled: anyOffline || !hasSeq, onSelect: () => { insertRangesAtPlayhead(ranges, 'insert'); } },
    { label: many ? `Overwrite ${sel.length} Shots at Playhead` : 'Overwrite at Playhead', disabled: anyOffline || !hasSeq, onSelect: () => { insertRangesAtPlayhead(ranges, 'overwrite'); } },
    { separator: true },
    {
      label: many ? `Make Scene from ${sel.length} Shots…` : 'Make Scene from Shot…', disabled: !run, title: notRun,
      onSelect: () => env.openPanelDialog({ type: 'makeScene', mediaId: m.id, shotIds: ids }),
    },
    many
      ? { label: `Merge ${sel.length} Shots`, disabled: !run, title: notRun, onSelect: () => st.mergeDetectedScenes(m.id, ids) }
      : { label: 'Merge with Next', disabled: row.index >= m.detectedScenes.length - 1, onSelect: () => mergeWithNext(m, s.id) },
    { label: 'Split at Source Time…', disabled: many, onSelect: splitAtSource },
    { separator: true },
    { label: 'Rename', shortcut: 'F2', disabled: many, onSelect: () => env.startRename(row.key) },
    { label: 'Tag…', disabled: many, onSelect: () => env.openPanelDialog({ type: 'tag', mediaId: m.id, sceneId: s.id }) },
    { label: many ? `Add ${sel.length} Shots to Scene Library` : 'Add to Scene Library', onSelect: () => { st.batch('Add to Scene library', () => { for (const r of sel) addSceneToLibrary(r.media, r.scene); }); } },
    { separator: true },
    {
      label: many ? `Delete ${sel.length} Shots` : 'Delete Shot', shortcut: 'Del',
      onSelect: () => { st.batch(many ? 'Delete shots' : 'Delete shot', () => { for (const r of sel) useStore.getState().deleteDetectedScene(r.media.id, r.scene.id); }); },
    },
  ];
}

export function sequenceMenu(row: SequenceRow, env: MenuEnv): MenuItem[] {
  const s = row.seq;
  const st = useStore.getState();
  return [
    { label: 'Open in Timeline', shortcut: 'Enter', onSelect: () => openSequence(s.id) },
    { label: 'Duplicate', onSelect: () => { const id = st.duplicateSequence(s.id, `${s.name} copy`); if (id) toast('ok', 'Timeline duplicated'); } },
    {
      // Roadmap §8: nest this sequence in the active one at its playhead (cycles are refused with a toast).
      label: 'Nest in Active Timeline', disabled: !st.project.activeSequenceId || st.project.activeSequenceId === s.id,
      onSelect: () => { const a = st.project.activeSequenceId; if (a) st.nestSequence(a, s.id, st.project.sequences[a]?.view.playhead ?? 0); },
    },
    { separator: true },
    { label: 'Rename', shortcut: 'F2', onSelect: () => env.startRename(row.key) },
    { label: 'Delete Timeline', shortcut: 'Del', onSelect: () => { void deleteSequenceConfirmed(s.id); } },
  ];
}

export function binMenu(row: BinRow, env: MenuEnv): MenuItem[] {
  const b = row.bin;
  const st = useStore.getState();
  return [
    { label: 'Import into Bin…', onSelect: () => { void importViaDialog(b.id); } },
    { label: 'New Bin inside', onSelect: () => env.newBin(b.id) },
    { separator: true },
    { label: 'Rename', shortcut: 'F2', onSelect: () => env.startRename(row.key) },
    { label: 'Delete Bin', shortcut: 'Del', onSelect: () => { st.deleteBin(b.id); if (st.ui.selectedBinId === b.id) st.selectBin(null); } },
  ];
}

export function groupMenu(row: GroupRow, env: MenuEnv): MenuItem[] {
  if (row.groupKind === 'root') return backgroundMenu(env, null);
  return [{ heading: row.label }, { label: 'Collapse', onSelect: () => { /* handled by toggle */ } }];
}

export function backgroundMenu(env: MenuEnv, binId: ID | null): MenuItem[] {
  const st = useStore.getState();
  return [
    { label: 'Import…', shortcut: 'Ctrl+I', onSelect: () => { void importViaDialog(binId); } },
    { label: 'New Bin', onSelect: () => env.newBin(binId) },
    { label: 'New Timeline…', shortcut: 'Ctrl+Shift+N', onSelect: () => st.openDialog('newSequence') },
  ];
}
