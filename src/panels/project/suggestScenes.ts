/**
 * Suggested scenes (#147), renderer side: start the analysis job (#151, electron/media/suggestScenes.ts), keep its
 * result, and create the accepted scenes. The transcript signal and the grouping are added in the dialog.
 */
import type { ID, MediaItem, SceneRecord } from '@shared/model';
import { uid } from '@shared/ids';
import type { SuggestScenesResult } from '@shared/ipc';
import { create } from 'zustand';
import { mediaSpeechCues, nameFromSpeech } from '@shared/sceneNaming';
import { useStore, recutApi } from '@/state';
import { toast } from '@/components/ui/toastStore';
import { activeJobFor, useJobsStore } from '@/app/jobsStore';

/** A finished analysis (#151): what the job measured, for the shots it was run on. */
export interface SuggestAnalysis { shotKey: string; hists: (number[] | null)[]; audioLinks: (number | null)[] }

interface SuggestState {
  /** Finished analyses by media id (kept for the session, so reopening Suggest Scenes needs no new job). */
  results: Record<ID, SuggestAnalysis>;
  /** The media whose Suggest Scenes dialog is open. */
  open: ID | null;
  /** Media whose analysis was asked for and not reviewed yet: the review opens when its job finishes. */
  waiting: Record<ID, true>;
}

export const useSuggestStore = create<SuggestState>()(() => ({ results: {}, open: null, waiting: {} }));

/** Identifies a media item's current shots: an analysis of other shots is stale. */
export function shotKey(m: MediaItem): string {
  const s = m.detectedScenes;
  if (!s.length) return '0';
  let sum = 0;
  for (const x of s) sum += Math.round(x.start * 1000);
  return `${s.length}:${s[0].id}:${s[s.length - 1].id}:${sum}`;
}

export function validAnalysis(m: MediaItem | undefined): SuggestAnalysis | null {
  if (!m) return null;
  const r = useSuggestStore.getState().results[m.id];
  return r && r.shotKey === shotKey(m) ? r : null;
}

/**
 * Suggest Scenes… : review straight away when this video's shots were already analysed, else start the analysis job
 * (listed in Jobs) and show its progress; the review opens when it finishes, also after Run in Background.
 */
export async function openSuggestScenes(mediaId: ID): Promise<void> {
  const st = useStore.getState();
  const m = st.project.media[mediaId];
  if (!m || !m.detectedScenes.length) return;
  useSuggestStore.setState((s) => ({ open: mediaId, waiting: validAnalysis(m) ? s.waiting : { ...s.waiting, [mediaId]: true } }));
  if (validAnalysis(m) || activeJobFor(useJobsStore.getState().jobs, mediaId, 'suggestScenes')) return;
  const api = recutApi();
  if (!api) return;
  const audio = m.probe?.audio.length ? { audioPath: m.path, audioStream: m.preferredAudioStream ?? m.probe.audio[0]?.index } : {};
  try {
    await api.startSuggestScenes({
      mediaId, name: m.name, shots: m.detectedScenes.map((x) => ({ start: x.start, end: x.end })),
      videoPath: m.proxy.status === 'ready' && m.proxy.path ? m.proxy.path : m.path, duration: m.probe?.duration ?? 0, ...audio,
    });
  } catch (e) {
    toast('error', `Suggest Scenes could not start: ${e instanceof Error ? e.message : String(e)}`);
    useSuggestStore.setState((s) => { const w = { ...s.waiting }; delete w[mediaId]; return { waiting: w }; });
  }
}

/** jobsRouter: a finished analysis is kept, and its review opens when it was asked for. */
export function suggestJobFinished(mediaId: ID, status: 'done' | 'failed' | 'canceled', result: SuggestScenesResult | null, error?: string): void {
  const m = useStore.getState().project.media[mediaId];
  const s = useSuggestStore.getState();
  const wanted = !!s.waiting[mediaId];
  const waiting = { ...s.waiting };
  delete waiting[mediaId];
  if (status !== 'done' || !result || !m) {
    useSuggestStore.setState({ waiting, open: s.open === mediaId ? null : s.open });
    if (status === 'failed') toast('error', `Suggest Scenes failed${m ? ` for ${m.name}` : ''}: ${error ?? 'unknown error'}`);
    return;
  }
  const results = { ...s.results, [mediaId]: { shotKey: shotKey(m), hists: result.hists, audioLinks: result.audioLinks } };
  if (wanted && (s.open === null || s.open === mediaId)) useSuggestStore.setState({ results, waiting, open: mediaId });
  else {
    useSuggestStore.setState({ results, waiting });
    if (wanted) toast('ok', `Scene suggestions for ${m.name} are ready: right-click it › Suggest Scenes… to review`, 8000);
  }
}

export interface SuggestedScene { shotIndices: number[]; name: string; accepted: boolean }

/** Default names: what is said in the scene, else the next free "Scene NN". */
export function nameSuggestions(m: MediaItem, groups: number[][]): string[] {
  const st = useStore.getState();
  const cues = mediaSpeechCues(m, st.project.subtitleTracks);
  const taken = new Set(Object.values(st.project.scenes).map((s) => s.name));
  let n = 1;
  return groups.map((g) => {
    const start = m.detectedScenes[g[0]].start, end = m.detectedScenes[g[g.length - 1]].end;
    const spoken = cues ? nameFromSpeech(cues, start, end) : null;
    if (spoken) return spoken;
    while (taken.has(`Scene ${String(n).padStart(2, '0')}`)) n++;
    const name = `Scene ${String(n).padStart(2, '0')}`;
    taken.add(name);
    return name;
  });
}

/** Accepted suggestions become Scene library scenes covering their shots, in one undo step. Returns their ids. */
export function createSuggestedScenes(mediaId: ID, suggestions: SuggestedScene[]): ID[] {
  const st = useStore.getState();
  const m = st.project.media[mediaId];
  if (!m) return [];
  const ids: ID[] = [];
  const accepted = suggestions.filter((s) => s.accepted && s.shotIndices.length);
  st.batch(`Create ${accepted.length} suggested scene${accepted.length === 1 ? '' : 's'}`, () => {
    for (const s of accepted) {
      const shots = s.shotIndices.map((i) => m.detectedScenes[i]).filter(Boolean);
      if (!shots.length) continue;
      const rec: SceneRecord = {
        id: uid('scn'), name: s.name.trim() || 'Scene', mediaId, in: shots[0].start, out: shots[shots.length - 1].end,
        characters: [...new Set(shots.flatMap((x) => x.characters))], location: '', arc: '', tags: [...new Set(shots.flatMap((x) => x.tags))],
        notes: '', rating: 0, color: '#4d7cfe', createdAt: Date.now(),
      };
      useStore.getState().addScene(rec);
      ids.push(rec.id);
    }
  });
  if (ids.length) toast('ok', `${ids.length} scene${ids.length === 1 ? '' : 's'} added to the Scenes tab`);
  return ids;
}
