/**
 * Suggested scenes (#147), renderer side: gather the signals shared/sceneSuggest.ts groups shots by (a colour
 * histogram per shot from two small frames, the audio level peaks, the transcript) and create the accepted scenes.
 */
import type { ID, MediaItem, SceneRecord } from '@shared/model';
import { uid } from '@shared/ids';
import { histogramFromRgba, meanHistogram, type AudioPeaks } from '@shared/sceneSuggest';
import { mediaSpeechCues, nameFromSpeech } from '@shared/sceneNaming';
import { useStore, recutApi } from '@/state';
import { toast } from '@/components/ui/toastStore';

export interface ShotFeatures {
  hists: (Float32Array | null)[];
  audio: AudioPeaks | null;
}

const FRAME_W = 64;
const CHUNK = 24;

function histogramOfImage(url: string): Promise<Float32Array | null> {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 32; c.height = 18;
        const g = c.getContext('2d', { willReadFrequently: true });
        if (!g) { resolve(null); return; }
        g.drawImage(img, 0, 0, c.width, c.height);
        resolve(histogramFromRgba(g.getImageData(0, 0, c.width, c.height).data));
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Two frames per shot (at a third and two thirds) -> one histogram per shot; the media's audio peaks. */
export async function gatherShotFeatures(m: MediaItem, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<ShotFeatures> {
  const api = recutApi();
  const shots = m.detectedScenes;
  const hists: (Float32Array | null)[] = shots.map(() => null);
  if (!api || m.offline || m.kind !== 'video') return { hists, audio: null };
  const audioP = m.probe?.audio.length
    ? api.waveform(m.path, m.id, m.preferredAudioStream ?? m.probe.audio[0]?.index).then((w) => ({ rate: w.rate, peaks: w.peaks })).catch(() => null)
    : Promise.resolve(null);
  const requestId = uid('sgst');
  signal?.addEventListener('abort', () => { void api.cancelThumbnails([requestId]).catch(() => undefined); }, { once: true });
  for (let i = 0; i < shots.length; i += CHUNK) {
    if (signal?.aborted) break;
    const part = shots.slice(i, i + CHUNK);
    const times = part.flatMap((s) => { const d = s.end - s.start; return [s.start + d / 3, s.start + (2 * d) / 3]; });
    const urls = await api.filmstrip({ path: m.path, times, width: FRAME_W, mediaId: m.id, requestId }).catch(() => times.map(() => ''));
    const frames = await Promise.all(urls.map(histogramOfImage));
    part.forEach((_, k) => { hists[i + k] = meanHistogram([frames[2 * k], frames[2 * k + 1]].filter((h): h is Float32Array => !!h)); });
    onProgress?.(Math.min(shots.length, i + CHUNK), shots.length);
  }
  return { hists, audio: await audioP };
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
