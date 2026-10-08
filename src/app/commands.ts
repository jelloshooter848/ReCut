/**
 * Editing command implementations behind every keyboard shortcut and menu item.
 *
 * `registerEditingCommands()` re-registers every stub id from COMMAND_IDS (plus a few extra ids that the
 * application menu sends) with real implementations over the zustand store, the active transport and the
 * layout store. Commands never throw: each `run` is wrapped and failures surface as toasts.
 *
 * Transport fallback: when no monitor has registered a transport yet, playback/mark commands act on the
 * active sequence's view (playhead / in / out) and the store's playback flags directly.
 */
import { COMMAND_IDS } from '@/keyboard/commandIds';
import { COMMAND_META } from '@/keyboard/commands';
import { registerCommand, runCommand, type CommandInput } from '@/keyboard/shortcuts';
import { useStore } from '@/state/store';
import { activeSequence, selectedClips } from '@/state/selectors';
import { importSubtitleFile, recutApi } from '@/state/mediaActions';
import { IMPORT_FILTERS, SUBTITLE_FILTERS, importPaths } from '@/panels/project/actions';
import { useLayoutStore } from '@/components/layout/layoutStore';
import { toast } from '@/components/ui/toastStore';
import type { Clip, ID, Sequence, Track, TransitionType } from '@shared/model';
import { secondsToFrames, validFpsOr } from '@shared/time';
import { addTransition, allTracks, clipAt, clipEnd, findClip, nextEdit, prevEdit, removableDisabledClipIds, sequenceDuration, sourceTimeAt } from '@shared/timeline';
import { isNestedClip, sourceUnder } from '@shared/nest';
import { MAX_ZOOM, MIN_ZOOM, minZoomFor, zoomAround, zoomToFit } from '@/panels/timeline/viewMath';
import { useTimelineUi } from '@/panels/timeline/timelineStore';
import { insertSourceIntoSequence } from '@/panels/source/insert';
import { clipboardHasClips, copyClipsToClipboard, pasteClipboardAt } from './clipboard';
import { getActiveTransport, shuttle, type Transport } from './transport';
import { requestNewProject, requestOpenProject, requestSave, requestSaveAs } from './project';
import { confirm, promptText } from './dialogs/ConfirmDialog';
import { openSpeedDialog } from './dialogs/SpeedDialog';
import { openSequenceDialog } from './dialogs/NewSequenceDialog';
import { openOcrLanguages } from '@/ocr/ocrUi';
import { openWhisperModels } from '@/whisper/whisperUi';
import { openCollectDialog } from '@/panels/collect/collectUi';
import type { Tool } from '@/state/types';

/** Command ids implemented here that are not part of the shell's COMMAND_IDS (menu names match electron/menu.ts). */
export const EXTRA_COMMAND_IDS = {
  playInToOut: 'playback.playInToOut',
  markClip: 'mark.clip',
  addEditAllTracks: 'edit.addEditAllTracks',
  nudgeLeft5: 'edit.nudgeLeft5',
  nudgeRight5: 'edit.nudgeRight5',
  speedDuration: 'clip.speedDuration',
  toolHand: 'tool.hand',
  toggleSnapping: 'view.toggleSnapping',
  importSubtitles: 'file.importSubtitles',
  preferences: 'app.preferences',
  ocrLanguages: 'app.ocrLanguages',
  whisperModels: 'app.whisperModels',
  collectProject: 'file.collect',
  quit: 'file.quit',
  duplicateSequence: 'sequence.duplicate',
  removeDisabledClips: 'sequence.removeDisabledClips',
  duplicateWithoutDisabled: 'sequence.duplicateWithoutDisabled',
  takeSnapshot: 'sequence.takeSnapshot',
  renameSequence: 'sequence.rename',
  sequenceSettings: 'sequence.settings',
  about: 'help.about',
  extractCentreChannel: 'clip.extractCentreChannel',
  makeCompoundClip: 'clip.makeCompound',
  openInTimeline: 'clip.openInTimeline',
  breakApartCompound: 'clip.breakApart',
} as const;

const EXTRA_META: Record<string, { title: string; category: string; keys: string[] }> = {
  [EXTRA_COMMAND_IDS.playInToOut]: { title: 'Play In to Out', category: 'Playback', keys: ['Ctrl+Shift+Space'] },
  [EXTRA_COMMAND_IDS.markClip]: { title: 'Mark Clip', category: 'Marks & Markers', keys: ['X'] },
  [EXTRA_COMMAND_IDS.addEditAllTracks]: { title: 'Add Edit to All Tracks', category: 'Editing', keys: ['Ctrl+Shift+K'] },
  [EXTRA_COMMAND_IDS.nudgeLeft5]: { title: 'Nudge Selection Left 5 Frames', category: 'Editing', keys: ['Alt+Shift+ArrowLeft'] },
  [EXTRA_COMMAND_IDS.nudgeRight5]: { title: 'Nudge Selection Right 5 Frames', category: 'Editing', keys: ['Alt+Shift+ArrowRight'] },
  [EXTRA_COMMAND_IDS.speedDuration]: { title: 'Speed / Duration…', category: 'Editing', keys: ['Ctrl+R'] },
  [EXTRA_COMMAND_IDS.toolHand]: { title: 'Hand Tool', category: 'Tools', keys: ['H'] },
  [EXTRA_COMMAND_IDS.toggleSnapping]: { title: 'Toggle Snapping', category: 'View & Panels', keys: ['S'] },
  [EXTRA_COMMAND_IDS.importSubtitles]: { title: 'Import Subtitles…', category: 'File', keys: [] },
  [EXTRA_COMMAND_IDS.preferences]: { title: 'Preferences…', category: 'File', keys: ['Ctrl+,'] },
  [EXTRA_COMMAND_IDS.ocrLanguages]: { title: 'OCR Languages…', category: 'File', keys: [] },
  [EXTRA_COMMAND_IDS.whisperModels]: { title: 'Transcription Models…', category: 'File', keys: [] },
  [EXTRA_COMMAND_IDS.collectProject]: { title: 'Collect Project…', category: 'File', keys: [] },
  [EXTRA_COMMAND_IDS.quit]: { title: 'Quit', category: 'File', keys: ['Ctrl+Q'] },
  [EXTRA_COMMAND_IDS.duplicateSequence]: { title: 'Duplicate Sequence…', category: 'File', keys: [] },
  [EXTRA_COMMAND_IDS.removeDisabledClips]: { title: 'Remove Disabled Clips…', category: 'Editing', keys: [] },
  [EXTRA_COMMAND_IDS.duplicateWithoutDisabled]: { title: 'Duplicate as Cut Without Disabled Clips…', category: 'File', keys: [] },
  [EXTRA_COMMAND_IDS.takeSnapshot]: { title: 'Take Sequence Snapshot…', category: 'File', keys: [] },
  [EXTRA_COMMAND_IDS.renameSequence]: { title: 'Rename Sequence…', category: 'File', keys: [] },
  [EXTRA_COMMAND_IDS.sequenceSettings]: { title: 'Sequence Settings…', category: 'File', keys: [] },
  [EXTRA_COMMAND_IDS.about]: { title: 'About ReCut', category: 'Help', keys: [] },
  [EXTRA_COMMAND_IDS.extractCentreChannel]: { title: 'Extract Centre Channel (Dialogue)', category: 'Editing', keys: [] },
  [EXTRA_COMMAND_IDS.makeCompoundClip]: { title: 'Make Compound Clip', category: 'Editing', keys: [] },
  [EXTRA_COMMAND_IDS.openInTimeline]: { title: 'Open in Timeline', category: 'Editing', keys: [] },
  [EXTRA_COMMAND_IDS.breakApartCompound]: { title: 'Break Apart Compound Clip', category: 'Editing', keys: [] },
};

/**
 * The About dialog's licence line. Every release build (Windows installer, Linux AppImage, both macOS dmgs) bundles a
 * GPL-3.0-or-later FFmpeg build: see THIRD_PARTY_NOTICES.md.
 */
export const ABOUT_LICENCE_TEXT = 'ReCut is free software under the MIT License. FFmpeg is a separate program with its own licence '
  + '(the FFmpeg bundled with every ReCut release build is GPL-3.0-or-later); see Licences.';

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

const S = () => useStore.getState();

/**
 * Extract Centre Channel (Dialogue) on `clipId` (Roadmap §9): a toast says what happened, or why it cannot run (no
 * centre channel). Shared by the command (Clip menu) and the timeline's clip context menu.
 */
export function runExtractCentreChannel(seqId: ID, clipId: ID | undefined): boolean {
  if (!clipId) { toast('info', 'Select a clip linked to a 5.1 source first'); return false; }
  const r = S().extractCentreChannel(seqId, clipId);
  if (!r.ok) { toast('warn', r.reason); return false; }
  const seq = S().project.sequences[seqId];
  const track = seq?.audioTracks.find((t) => t.id === r.trackId);
  toast('ok', `Centre channel extracted to ${track?.name ?? 'a new audio track'}. It still carries music and effects mixed with the dialogue.`);
  return true;
}
const seqNow = (): Sequence | null => activeSequence(S());

/** The selected nested clip under (or nearest to) the playhead, else the first selected nested clip (Roadmap §8). */
function selectedNestedClip(seq: Sequence): Clip | undefined {
  const nested = selectedClips(S()).filter(isNestedClip);
  const ph = seq.view.playhead;
  return nested.find((c) => c.kind === 'video' && c.start <= ph && clipEnd(c) > ph) ?? nested.find((c) => c.start <= ph && clipEnd(c) > ph) ?? nested[0];
}

/** Open in Timeline (Roadmap §8): the nested clip's sequence becomes the active one, at the frame under the playhead. */
export function runOpenInTimeline(seqId: ID, clipId: ID | undefined, frame?: number): boolean {
  if (!clipId) { toast('info', 'Select a nested sequence clip first'); return false; }
  return S().openNestedSequence(seqId, clipId, frame);
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Visible timeline width in px, reported by the Timeline panel on resize (fallback when it is not mounted). */
let viewportWidth = 1200;
export function setTimelineViewportWidth(px: number): void { if (Number.isFinite(px) && px > 0) viewportWidth = px; }
/** The live `.tl-tracks-col` width when the Timeline panel is mounted and laid out, else the last reported width. */
export function getTimelineViewportWidth(): number {
  if (typeof document !== 'undefined') {
    const w = document.querySelector<HTMLElement>('.tl-tracks-col')?.clientWidth ?? 0;
    if (w > 0) return w;
  }
  return viewportWidth;
}
export const ZOOM_MIN = MIN_ZOOM;
export const ZOOM_MAX = MAX_ZOOM;

/** Zoom (px per frame) that fits `durationFrames` into `widthPx` (same math as the Timeline panel's zoom-to-fit). */
export function zoomToFitValue(durationFrames: number, widthPx = getTimelineViewportWidth()): number {
  return zoomToFit(Math.max(1, durationFrames), widthPx);
}

/** Multiply the zoom keeping the playhead at the same screen x (and visible). */
export function zoomAroundPlayhead(seq: Sequence, factor: number): void {
  const { zoom, scroll, playhead } = seq.view;
  const next = zoomAround(zoom, scroll, (playhead - scroll) * zoom, zoom * factor, minZoomFor(sequenceDuration(seq), getTimelineViewportWidth()));
  if (next.zoom === zoom) return;
  const visible = getTimelineViewportWidth() / next.zoom;
  if (playhead < next.scroll || playhead > next.scroll + visible) next.scroll = Math.max(0, playhead - visible / 2);
  S().setView(seq.id, next);
}

/** Store-backed transport over the active sequence, used when no monitor has registered one. */
export function programFallbackTransport(): Transport | null {
  const seq = seqNow();
  if (!seq) return null;
  const id = seq.id;
  const view = () => S().project.sequences[id]?.view ?? seq.view;
  const seek = (f: number) => S().setView(id, { playhead: Math.max(0, Math.round(f)) });
  const dur = () => { const s = S().project.sequences[id]; return s ? sequenceDuration(s) : 0; };
  return {
    id: 'program',
    toggle: () => S().setPlaying(!S().playback.playing),
    play: () => S().setPlaying(true),
    pause: () => S().setPlaying(false),
    stop: () => { S().setPlaying(false); S().setPlaybackRate(1); },
    setRate: (rate) => { S().setPlaybackRate(rate === 0 ? 1 : rate); S().setPlaying(rate !== 0); },
    getRate: () => (S().playback.playing ? S().playback.rate : 0),
    stepFrames: (n) => seek(view().playhead + n),
    seekFrame: seek,
    currentFrame: () => view().playhead,
    durationFrames: dur,
    goToStart: () => seek(0),
    goToEnd: () => seek(dur()),
    markIn: () => S().setView(id, { inPoint: view().playhead }),
    markOut: () => S().setView(id, { outPoint: view().playhead }),
    clearInOut: () => S().setView(id, { inPoint: null, outPoint: null }),
    goToIn: () => { const i = view().inPoint; if (i !== null) seek(i); },
    goToOut: () => { const o = view().outPoint; if (o !== null) seek(o); },
    playInToOut: () => { const i = view().inPoint; if (i !== null) seek(i); S().setPlaying(true); },
    isPlaying: () => S().playback.playing,
  };
}

/** Active transport, else the store fallback. */
export function transport(): Transport | null { return getActiveTransport() ?? programFallbackTransport(); }
/** True when the program side (timeline / program monitor) is the keyboard target rather than the source monitor. */
export function isProgramContext(): boolean {
  if (S().ui.timelineFocus) return true;
  const t = getActiveTransport(); return !t || t.id !== 'source';
}

export interface ClipHit { track: Track; clip: Clip }
/** Topmost clip under `frame`: highest video track first, then audio tracks. */
export function topmostClipAt(seq: Sequence, frame: number, opts: { unlockedOnly?: boolean } = {}): ClipHit | null {
  for (const t of [...seq.videoTracks].reverse()) { if (opts.unlockedOnly && t.locked) continue; const c = clipAt(t, frame); if (c) return { track: t, clip: c }; }
  for (const t of seq.audioTracks) { if (opts.unlockedOnly && t.locked) continue; const c = clipAt(t, frame); if (c) return { track: t, clip: c }; }
  return null;
}

/** Clips the ripple-trim commands act on: selected clips containing the playhead, else the topmost clip there. */
function trimTargets(seq: Sequence, frame: number): Clip[] {
  const sel = selectedClips(S()).filter((c) => c.start < frame && clipEnd(c) > frame);
  if (sel.length) return sel;
  const hit = topmostClipAt(seq, frame, { unlockedOnly: true });
  return hit ? [hit.clip] : [];
}

function sourceSceneBoundaries(): { seconds: number[]; time: number; fps: { num: number; den: number } } | null {
  const st = S();
  const sc = st.ui.sourceClip;
  if (!sc) return null;
  const media = st.project.media[sc.mediaId];
  if (!media) return null;
  const set = new Set<number>([0]);
  for (const s of media.detectedScenes) { set.add(s.start); set.add(s.end); }
  if (media.probe?.duration) set.add(media.probe.duration);
  // An unknown probe rate ({num:0,den:1}) would make every boundary frame 0: use the sequence rate instead.
  const fps = validFpsOr(media.probe?.video?.fps, validFpsOr(activeSequence(st)?.fps, { num: 24000, den: 1001 }));
  return { seconds: [...set].sort((a, b) => a - b), time: sc.time, fps };
}

function seekSource(seconds: number, fps: { num: number; den: number }): void {
  const t = getActiveTransport();
  if (t && t.id === 'source') t.seekFrame(secondsToFrames(seconds, fps));
  else S().setSourceTime(seconds);
}

/**
 * Next / previous scene boundary for a source position, compared in frames (the player reports frame-centre
 * times, so a seconds comparison sticks just after a boundary).
 */
export function sceneBoundaryTarget(boundaries: number[], timeSeconds: number, fps: { num: number; den: number }, dir: -1 | 1): number | undefined {
  const cur = Math.floor(timeSeconds * fps.num / fps.den + 1e-6);
  const frameOf = (b: number) => Math.round(b * fps.num / fps.den);
  return dir > 0 ? boundaries.find((x) => frameOf(x) > cur) : [...boundaries].reverse().find((x) => frameOf(x) < cur);
}

function goToEditPoint(dir: -1 | 1): void {
  if (!isProgramContext()) {
    const b = sourceSceneBoundaries();
    if (!b) return;
    const target = sceneBoundaryTarget(b.seconds, b.time, b.fps, dir);
    if (target !== undefined) seekSource(target, b.fps);
    return;
  }
  const seq = seqNow();
  const t = transport();
  if (!seq || !t) return;
  const cur = t.currentFrame();
  const target = dir > 0 ? (nextEdit(seq, cur) ?? sequenceDuration(seq)) : (prevEdit(seq, cur) ?? 0);
  if (target !== cur) t.seekFrame(target);
}

// ------------------------------------------------------------------
// Clipboard (shared with the Timeline panel: src/app/clipboard.ts)
// ------------------------------------------------------------------

export { getClipboard, setClipboard, pasteClipboardAt, type ClipboardEntry, type ClipClipboard } from './clipboard';

function copySelection(): boolean {
  const seq = seqNow();
  if (!seq) return false;
  if (!copyClipsToClipboard(seq, S().ui.selectedClipIds)) { toast('info', 'Nothing selected to copy'); return false; }
  return true;
}

// ------------------------------------------------------------------
// File helpers
// ------------------------------------------------------------------

async function importMediaViaDialog(): Promise<void> {
  const api = recutApi();
  if (!api) { toast('warn', 'Importing requires the desktop app'); return; }
  const paths = await api.openFiles({ title: 'Import Media', filters: IMPORT_FILTERS, multi: true });
  if (!paths.length) return;
  // Same path as the Project panel's Import button: auto-routes into Movies / TV › Series › Season bins,
  // picks up sidecar subtitles and reports results with its own toasts.
  await importPaths(paths, null);
}

async function importSubtitlesViaDialog(): Promise<void> {
  const api = recutApi();
  if (!api) { toast('warn', 'Importing requires the desktop app'); return; }
  const st = S();
  const mediaId = st.ui.selectedMediaIds[0] ?? st.ui.sourceClip?.mediaId ?? null;
  const media = mediaId ? st.project.media[mediaId] : undefined;
  if (!media) { toast('info', 'Select a media item in the Project panel (or open it in the Source monitor) first, then import subtitles for it'); return; }
  const paths = await api.openFiles({ title: `Import Subtitles for ${media.name}`, filters: SUBTITLE_FILTERS, multi: true });
  for (const p of paths) {
    const res = await importSubtitleFile(media.id, p);
    if (!res.trackId) toast('error', `No cues found in ${p.split(/[\\/]/).pop()}${res.warnings.length ? `: ${res.warnings[0]}` : ''}`);
    else {
      toast('ok', `Subtitles attached to ${media.name}`);
      if (res.warnings.length) toast('warn', `${res.warnings.length} subtitle warning${res.warnings.length === 1 ? '' : 's'} (see Subtitles panel)`);
    }
  }
}

// ------------------------------------------------------------------
// Registration
// ------------------------------------------------------------------

let registered = false;

function wrap(id: string, run: () => void | Promise<void>): () => void {
  return () => {
    try {
      const r = run();
      if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch((e) => { console.error(`[commands] ${id} failed`, e); toast('error', `${COMMAND_META[id]?.title ?? EXTRA_META[id]?.title ?? id}: ${errText(e)}`); });
    } catch (e) {
      console.error(`[commands] ${id} failed`, e);
      toast('error', `${COMMAND_META[id]?.title ?? EXTRA_META[id]?.title ?? id}: ${errText(e)}`);
    }
  };
}

/** Build a CommandInput for a shell id (meta from COMMAND_META) or an extra id (meta + default keys from EXTRA_META). */
function cmd(id: string, run: () => void | Promise<void>, when?: () => boolean): CommandInput {
  const meta = COMMAND_META[id] ?? EXTRA_META[id];
  const extra = EXTRA_META[id];
  return { id, title: meta?.title ?? id, category: meta?.category ?? 'Editing', when, run: wrap(id, run), ...(extra ? { defaultKeys: extra.keys } : {}) };
}

const MARK_IN_OUT_FIRST = 'Mark In and Out first (I / O)';

/**
 * Cuts a default transition goes on (Ctrl+D video tracks only, Ctrl+Shift+D audio only): selected adjacent
 * pairs, else the selected clips' edge nearest the playhead, else the edit point nearest the playhead.
 */
export function defaultTransitionCuts(seq: Sequence, selectedIds: readonly ID[], kind: 'video' | 'audio'): { trackId: ID; frame: number }[] {
  const tracks = (kind === 'video' ? seq.videoTracks : seq.audioTracks).filter((t) => !t.locked);
  const cuts: { trackId: ID; frame: number }[] = [];
  const ph = seq.view.playhead;
  if (selectedIds.length) {
    const sel = new Set(selectedIds);
    for (const t of tracks) for (let i = 0; i < t.clips.length - 1; i++) {
      const a = t.clips[i], b = t.clips[i + 1];
      if (sel.has(a.id) && sel.has(b.id) && clipEnd(a) === b.start) cuts.push({ trackId: t.id, frame: b.start });
    }
    if (cuts.length) return cuts;
    for (const t of tracks) for (const c of t.clips) {
      if (!sel.has(c.id)) continue;
      cuts.push({ trackId: t.id, frame: Math.abs(ph - c.start) <= Math.abs(clipEnd(c) - ph) ? c.start : clipEnd(c) });
    }
    if (cuts.length) return cuts;
  }
  let best: number | null = null;
  for (const t of tracks) for (const c of t.clips) for (const f of [c.start, clipEnd(c)]) if (best === null || Math.abs(f - ph) < Math.abs(best - ph)) best = f;
  if (best === null) return [];
  for (const t of tracks) if (t.clips.some((c) => c.start === best || clipEnd(c) === best)) cuts.push({ trackId: t.id, frame: best });
  return cuts;
}

function addDefaultTransitionsOfKind(seq: Sequence, kind: 'video' | 'audio'): void {
  const cuts = defaultTransitionCuts(seq, S().ui.selectedClipIds, kind);
  if (!cuts.length) { toast('info', `No ${kind} cut to add a transition to`); return; }
  const type: TransitionType = kind === 'audio' ? 'audioCrossfade' : 'crossDissolve';
  const frames = Math.max(1, S().project.settings.defaultTransitionFrames);
  // One undo step: a transient transaction around the pure timeline op.
  S().beginTransaction();
  S().updateTransient((d) => { const s = d.sequences[seq.id]; if (s) for (const c of cuts) addTransition(s, c.trackId, c.frame, type, frames); });
  if (!S().endTransaction(kind === 'audio' ? 'Add audio transition' : 'Add video transition')) toast('info', 'No room for a transition there');
}

const hasSeq = () => !!seqNow();
const hasClipSelection = () => S().ui.selectedClipIds.length > 0;
const hasSelection = () => { const u = S().ui; return u.selectedClipIds.length > 0 || !!u.selectedTransitionId || !!u.selectedMarkerId; };
const hasInOut = () => { const v = seqNow()?.view; return !!v && v.inPoint !== null && v.outPoint !== null && v.outPoint > v.inPoint; };
const layout = () => useLayoutStore.getState();

const T = (fn: (t: Transport) => void) => () => { const t = transport(); if (t) fn(t); };

function toolCmd(id: string, tool: Tool): CommandInput { return cmd(id, () => S().setTool(tool)); }

export function buildEditingCommands(): CommandInput[] {
  const C = COMMAND_IDS; const X = EXTRA_COMMAND_IDS;
  return [
    // ---- playback ----
    cmd(C.playPause, T((t) => t.toggle())),
    cmd(C.shuttleStop, T((t) => t.setRate(0))),
    cmd(C.shuttleBack, T((t) => shuttle(t, -1))),
    cmd(C.shuttleForward, T((t) => shuttle(t, 1))),
    cmd(C.stepBack, T((t) => t.stepFrames(-1))),
    cmd(C.stepForward, T((t) => t.stepFrames(1))),
    cmd(C.stepBack5, T((t) => t.stepFrames(-5))),
    cmd(C.stepForward5, T((t) => t.stepFrames(5))),
    cmd(C.goToStart, T((t) => t.goToStart())),
    cmd(C.goToEnd, T((t) => t.goToEnd())),
    cmd(C.prevEdit, () => goToEditPoint(-1)),
    cmd(C.nextEdit, () => goToEditPoint(1)),
    cmd(C.goToIn, T((t) => t.goToIn())),
    cmd(C.goToOut, T((t) => t.goToOut())),
    cmd(X.playInToOut, T((t) => { if (t.playInToOut) t.playInToOut(); else { t.goToIn(); t.play(); } })),

    // ---- marks ----
    cmd(C.markIn, T((t) => t.markIn())),
    cmd(C.markOut, T((t) => t.markOut())),
    cmd(C.clearInOut, T((t) => t.clearInOut())),
    cmd(X.markClip, () => {
      const seq = seqNow(); if (!seq) return;
      const sel = selectedClips(S());
      let range: { start: number; end: number } | null = null;
      if (sel.length) {
        // Loops, not Math.min/max(...spread): huge selections would overflow the stack.
        range = { start: Infinity, end: -Infinity };
        for (const c of sel) { if (c.start < range.start) range.start = c.start; if (clipEnd(c) > range.end) range.end = clipEnd(c); }
      }
      else { const hit = topmostClipAt(seq, seq.view.playhead); if (hit) range = { start: hit.clip.start, end: clipEnd(hit.clip) }; }
      if (!range) { toast('info', 'No clip under the playhead'); return; }
      S().setView(seq.id, { inPoint: range.start, outPoint: range.end });
    }, hasSeq),
    cmd(C.addMarker, () => {
      const seq = seqNow(); if (!seq) return;
      const frame = seq.view.playhead;
      const existing = seq.markers.find((m) => m.time === frame || (m.duration > 0 && m.time <= frame && m.time + m.duration > frame));
      if (existing) {
        S().selectMarker(existing.id);
        // Premiere: M on an existing marker opens its editor (in the Timeline), else the Markers panel.
        if (useTimelineUi.getState().markerEditorHosts > 0) useTimelineUi.getState().requestMarkerEdit(existing.id);
        else layout().focusPanel('markers');
        return;
      }
      const id = S().addMarker(seq.id, { time: frame });
      if (id) S().selectMarker(id);
    }, hasSeq),
    cmd(C.matchFrame, () => {
      const seq = seqNow(); if (!seq) return;
      const sel = selectedClips(S()).filter((c) => c.start <= seq.view.playhead && clipEnd(c) > seq.view.playhead);
      const hit = sel[0] ? { clip: sel[0] } : topmostClipAt(seq, seq.view.playhead);
      if (!hit) { toast('info', 'No clip under the playhead'); return; }
      // A nested clip matches through to the media playing inside it at this frame (Roadmap §8).
      const p = S().project;
      const under = sourceUnder(seq, hit.clip, seq.view.playhead, p.sequences, p.media);
      if (!under) { toast('info', 'Nothing plays inside the nested clip at the playhead'); return; }
      const media = p.media[under.clip.mediaId];
      if (!media) { toast('warn', 'Clip media is missing from the project'); return; }
      S().setSourceClip(media.id, Math.max(0, under.time));
      S().setActivePanel('source');
      layout().focusPanel('source');
    }, hasSeq),

    // ---- editing ----
    cmd(C.undo, () => { if (!S().undo()) toast('info', 'Nothing to undo'); }, () => S().canUndo()),
    cmd(C.redo, () => { if (!S().redo()) toast('info', 'Nothing to redo'); }, () => S().canRedo()),
    cmd(C.deleteSelection, () => {
      const seq = seqNow(); if (!seq) return;
      const u = S().ui;
      if (u.selectedClipIds.length || u.selectedTransitionId) S().deleteSelected(seq.id);
      else if (u.selectedMarkerId) S().removeMarker(seq.id, u.selectedMarkerId);
    }, () => hasSeq() && hasSelection()),
    cmd(C.rippleDelete, () => { const seq = seqNow(); if (seq) S().rippleDeleteSelected(seq.id); }, () => hasSeq() && (hasClipSelection() || !!S().ui.selectedTransitionId)),
    cmd(C.addEdit, () => {
      const seq = seqNow(); if (!seq) return;
      if (!S().razorAtPlayhead(seq.id).length) toast('info', 'No clip to cut at the playhead');
    }, hasSeq),
    cmd(X.addEditAllTracks, () => {
      const seq = seqNow(); if (!seq) return;
      const ids = allTracks(seq).filter((t) => !t.locked).map((t) => t.id);
      if (!S().razor(seq.id, seq.view.playhead, ids).length) toast('info', 'No clip to cut at the playhead');
    }, hasSeq),
    cmd(C.insert, () => { insertSourceIntoSequence('insert'); }, hasSeq),
    cmd(C.overwrite, () => { insertSourceIntoSequence('overwrite'); }, hasSeq),
    cmd(C.lift, () => { const seq = seqNow(); if (!seq) return; if (!hasInOut()) { toast('info', MARK_IN_OUT_FIRST); return; } S().liftInOut(seq.id); }, hasSeq),
    cmd(C.extract, () => { const seq = seqNow(); if (!seq) return; if (!hasInOut()) { toast('info', MARK_IN_OUT_FIRST); return; } S().extractInOut(seq.id); }, hasSeq),
    cmd(C.rippleTrimPrev, () => {
      const seq = seqNow(); if (!seq) return;
      const targets = trimTargets(seq, seq.view.playhead);
      if (!targets.length) { toast('info', 'No clip under the playhead'); return; }
      for (const c of targets) S().trimClipEdge(seq.id, c.id, 'start', seq.view.playhead, true);
    }, hasSeq),
    cmd(C.rippleTrimNext, () => {
      const seq = seqNow(); if (!seq) return;
      const targets = trimTargets(seq, seq.view.playhead);
      if (!targets.length) { toast('info', 'No clip under the playhead'); return; }
      for (const c of targets) S().trimClipEdge(seq.id, c.id, 'end', seq.view.playhead, true);
    }, hasSeq),
    cmd(C.defaultVideoTransition, () => { const seq = seqNow(); if (seq) addDefaultTransitionsOfKind(seq, 'video'); }, hasSeq),
    cmd(C.defaultAudioTransition, () => { const seq = seqNow(); if (seq) addDefaultTransitionsOfKind(seq, 'audio'); }, hasSeq),
    cmd(C.toggleClipEnabled, () => { const seq = seqNow(); if (seq) S().toggleClipEnabledSelected(seq.id); }, () => hasSeq() && hasClipSelection()),
    cmd(C.linkUnlink, () => {
      const seq = seqNow(); if (!seq) return;
      const sel = selectedClips(S());
      if (!sel.length) return;
      const allLinked = sel.every((c) => c.linkId !== null) && new Set(sel.map((c) => c.linkId)).size === 1;
      if (allLinked) S().unlinkSelected(seq.id);
      else if (sel.length >= 2) S().linkSelected(seq.id);
      else toast('info', 'Select two or more clips to link');
    }, () => hasSeq() && hasClipSelection()),
    cmd(C.nudgeLeft, () => S().nudgeSelected(-1), () => hasSeq() && hasClipSelection()),
    cmd(C.nudgeRight, () => S().nudgeSelected(1), () => hasSeq() && hasClipSelection()),
    cmd(X.nudgeLeft5, () => S().nudgeSelected(-5), () => hasSeq() && hasClipSelection()),
    cmd(X.nudgeRight5, () => S().nudgeSelected(5), () => hasSeq() && hasClipSelection()),
    cmd(C.selectAll, () => {
      const seq = seqNow(); if (!seq) return;
      S().select(allTracks(seq).flatMap((t) => t.clips.map((c) => c.id)));
    }, hasSeq),
    cmd(C.deselectAll, () => { S().select([], 'clear'); S().selectTransition(null); S().selectMarker(null); }),
    cmd(C.copy, () => { copySelection(); }, () => hasSeq() && hasClipSelection()),
    cmd(C.cut, () => { const seq = seqNow(); if (seq && copySelection()) S().deleteSelected(seq.id); }, () => hasSeq() && hasClipSelection()),
    cmd(C.paste, () => {
      const seq = seqNow(); if (!seq) return;
      if (!clipboardHasClips()) { toast('info', 'Clipboard is empty'); return; }
      const ids = pasteClipboardAt(seq, seq.view.playhead);
      if (ids.length) S().select(ids); else toast('warn', 'Could not paste here (target tracks locked?)');
    }, hasSeq),
    cmd(X.speedDuration, () => openSpeedDialog(), () => hasSeq() && hasClipSelection()),
    cmd(X.extractCentreChannel, () => { const seq = seqNow(); if (seq) runExtractCentreChannel(seq.id, selectedClips(S())[0]?.id); }, () => hasSeq() && hasClipSelection()),
    // ---- nested sequences (Roadmap §8) ----
    cmd(X.makeCompoundClip, () => { const seq = seqNow(); if (seq) S().makeCompoundClip(seq.id); }, () => hasSeq() && hasClipSelection()),
    cmd(X.openInTimeline, () => { const seq = seqNow(); if (seq) runOpenInTimeline(seq.id, selectedNestedClip(seq)?.id); }, () => hasSeq() && selectedClips(S()).some(isNestedClip)),
    cmd(X.breakApartCompound, () => {
      const seq = seqNow(); const c = seq && selectedNestedClip(seq);
      if (!seq || !c) { toast('info', 'Select a nested sequence clip first'); return; }
      S().breakApartCompoundClip(seq.id, c.id);
    }, () => hasSeq() && selectedClips(S()).some(isNestedClip)),

    // ---- tools ----
    toolCmd(C.toolSelect, 'select'),
    toolCmd(C.toolRazor, 'razor'),
    toolCmd(C.toolRipple, 'ripple'),
    toolCmd(C.toolRolling, 'rolling'),
    toolCmd(C.toolSlip, 'slip'),
    toolCmd(C.toolSlide, 'slide'),
    toolCmd(C.toolTrack, 'track'),
    toolCmd(X.toolHand, 'hand'),

    // ---- view ----
    cmd(C.zoomIn, () => { const seq = seqNow(); if (seq) zoomAroundPlayhead(seq, 1.5); }, hasSeq),
    cmd(C.zoomOut, () => { const seq = seqNow(); if (seq) zoomAroundPlayhead(seq, 1 / 1.5); }, hasSeq),
    cmd(C.zoomToFit, () => {
      const seq = seqNow(); if (!seq) return;
      S().setView(seq.id, { zoom: zoomToFitValue(sequenceDuration(seq)), scroll: 0 });
    }, hasSeq),
    cmd(X.toggleSnapping, () => {
      const next = !S().project.settings.snapping;
      S().setSettings({ snapping: next });
      toast('info', `Snapping ${next ? 'on' : 'off'}`);
    }),

    // ---- file ----
    cmd(C.newProject, () => requestNewProject().then(() => undefined)),
    cmd(C.openProject, () => requestOpenProject().then(() => undefined)),
    cmd(C.save, () => requestSave().then(() => undefined)),
    cmd(C.saveAs, () => requestSaveAs().then(() => undefined)),
    cmd(C.importMedia, () => importMediaViaDialog()),
    cmd(X.importSubtitles, () => importSubtitlesViaDialog()),
    cmd(C.export, () => S().openDialog('export'), hasSeq),
    cmd(X.preferences, () => S().openDialog('preferences')),
    cmd(X.ocrLanguages, () => openOcrLanguages()),
    cmd(X.whisperModels, () => openWhisperModels()),
    cmd(X.collectProject, () => openCollectDialog()),
    cmd(X.quit, () => { const api = recutApi(); if (api) void api.quit(false); }),

    // ---- sequence ----
    cmd(C.newSequence, () => S().openDialog('newSequence')),
    cmd(X.duplicateSequence, async () => {
      const seq = seqNow(); if (!seq) return;
      const name = await promptText({ title: 'Duplicate Sequence', label: 'Name for the new version', initial: `${seq.name} copy` });
      if (name === null) return;
      const id = S().duplicateSequence(seq.id, name.trim() || `${seq.name} copy`);
      if (id) toast('ok', `Created ${S().project.sequences[id]?.name}`);
    }, hasSeq),
    cmd(X.removeDisabledClips, async () => { await removeDisabledClipsConfirmed(); }, () => hasSeq() && disabledCount() > 0),
    cmd(X.duplicateWithoutDisabled, async () => {
      const seq = seqNow(); if (!seq) return;
      const n = disabledCount();
      if (!n) { toast('info', 'No disabled clips in this sequence'); return; }
      const name = await promptText({ title: 'Duplicate as Cut Without Disabled Clips', label: `Name for the new cut (${n} disabled clip${n === 1 ? '' : 's'} removed, gaps closed)`, initial: `${seq.name} cut` });
      if (name === null) return;
      const id = S().duplicateWithoutDisabled(seq.id, name.trim() || `${seq.name} cut`);
      if (id) toast('ok', `Created ${S().project.sequences[id]?.name} without ${n} disabled clip${n === 1 ? '' : 's'}`);
    }, () => hasSeq() && disabledCount() > 0),
    cmd(X.takeSnapshot, async () => {
      const seq = seqNow(); if (!seq) return;
      const name = await promptText({ title: 'Take Snapshot', label: 'Snapshot name', initial: `Snapshot ${seq.snapshots.length + 1}` });
      if (name === null) return;
      if (S().takeSnapshot(seq.id, name.trim() || `Snapshot ${seq.snapshots.length + 1}`)) toast('ok', 'Snapshot saved');
    }, hasSeq),
    cmd(X.renameSequence, async () => {
      const seq = seqNow(); if (!seq) return;
      const name = await promptText({ title: 'Rename Sequence', label: 'Sequence name', initial: seq.name });
      if (name === null || !name.trim() || name.trim() === seq.name) return;
      S().renameSequence(seq.id, name.trim());
    }, hasSeq),
    cmd(X.sequenceSettings, () => { const seq = seqNow(); if (seq) openSequenceDialog({ mode: 'edit', sequenceId: seq.id }); }, hasSeq),

    // ---- help ----
    cmd(X.about, async () => {
      const api = recutApi();
      if (!api) { toast('info', 'ReCut — fan-edit video editor'); return; }
      const info = await api.appInfo();
      const files = await api.licenceFiles?.().catch(() => []) ?? [];
      const licence = ABOUT_LICENCE_TEXT;
      const choice = await api.message({
        type: 'info', title: 'About ReCut', message: `ReCut ${info.version}`,
        detail: `${licence}\n\nFFmpeg: ${info.ffmpegVersion ?? 'not found'}\n${info.ffmpegPath ?? ''}\nCache: ${info.cacheDir}`,
        buttons: files.length ? ['OK', 'Licences…'] : ['OK'], defaultId: 0, cancelId: 0,
      });
      if (choice !== 1 || !files.length) return;
      const pick = await api.message({
        type: 'none', title: 'Licences', message: 'Licences and notices',
        detail: 'Choose a file to open. ReCut is MIT-licensed; the third-party notices list everything ReCut ships with, '
          + 'and the FFmpeg files describe the bundled FFmpeg build and where to get its source.',
        buttons: [...files.map((f) => f.label), 'Close'], defaultId: files.length, cancelId: files.length,
      });
      const file = files[pick];
      if (!file) return;
      const res = await api.openLicenceFile(file.id);
      if (!res.ok) toast('error', res.error);
    }),
  ];
}

/** Removable disabled clips in the active sequence. */
function disabledCount(): number {
  const seq = seqNow();
  return seq ? removableDisabledClipIds(seq).length : 0;
}

/**
 * Remove Disabled Clips: confirm with the count, then ripple-delete them in one undo step (turns a what-if
 * experiment into the real cut). Returns the number of clips removed.
 */
export async function removeDisabledClipsConfirmed(): Promise<number> {
  const seq = seqNow(); if (!seq) return 0;
  const n = disabledCount();
  if (!n) { toast('info', 'No disabled clips in this sequence'); return 0; }
  const i = await confirm({
    type: 'question', title: 'Remove Disabled Clips',
    message: `Remove ${n} disabled clip${n === 1 ? '' : 's'} from "${seq.name}" and close the gaps?`,
    detail: 'This is one undo step. To keep the original, use Duplicate as Cut Without Disabled Clips instead.',
    buttons: ['Remove', 'Cancel'], defaultId: 0, cancelId: 1,
  });
  if (i !== 0) return 0;
  const removed = S().removeDisabledClips(seq.id);
  if (removed) toast('ok', `Removed ${removed} disabled clip${removed === 1 ? '' : 's'}`);
  return removed;
}

/** Register (or re-register) every editing command. Idempotent. */
export function registerEditingCommands(): void {
  if (registered) return;
  registered = true;
  for (const c of buildEditingCommands()) registerCommand(c);
}

/** Run a command by id; convenience re-export for panels. */
export { runCommand };
