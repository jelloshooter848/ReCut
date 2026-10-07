/**
 * Preview audio for clips' channel selections (Roadmap §9, ClipAudio.channelSelection).
 *
 * Media proxies are stereo and Chromium cannot decode most surround codecs, so the preview cannot pick a channel or
 * downmix itself. Every (media, audio stream, selection) that some clip uses gets a channel proxy instead: a stereo
 * audio file the main process makes from the original with the export's own `pan` filter
 * (electron/media/channelProxy.ts). Its state lives in MediaItem.channelProxies (quiet writes, like media.proxy), so
 * the planner reads it with the media and the Program monitor reports a pending one as "Needs proxy … generating…".
 *
 * `initChannelProxies` watches the project: a short while after clips or media change (never during a drag), it
 * requests the proxies clips need (the main process returns a cached file at once), checks once per session that
 * ready files still exist, and prunes entries no clip uses. Channel proxies are made whatever the "Use proxies"
 * setting says: without one the preview of a channel selection would be wrong. A failed or canceled one is not
 * retried automatically (the Clip Inspector has Rebuild).
 */
import type { AudioChannelSelection, ID, JobInfo, Project, ProxyInfo } from '@shared/model';
import { channelProxyKey, clipAudioStream, resolveChannelSelection } from '@shared/audioChannels';
import { useStore } from '@/state/store';
import { recutApi } from '@/state/mediaActions';
import { useJobsStore } from './jobsStore';
import { invalidateMediaPath } from './media';

export interface WantedChannelProxy { mediaId: ID; key: string; stream: number; selection: AudioChannelSelection }

/**
 * The channel proxies the clips of every sequence need, by media id then key: audio clips with a channel selection
 * their (probed, online) stream can honour. A selection the stream cannot honour plays the normal mix and needs none.
 */
export function wantedChannelProxies(project: Pick<Project, 'sequences' | 'media'>): Map<ID, Map<string, WantedChannelProxy>> {
  const out = new Map<ID, Map<string, WantedChannelProxy>>();
  for (const seq of Object.values(project.sequences)) {
    for (const t of seq.audioTracks) {
      for (const c of t.clips) {
        const sel = c.audio?.channelSelection;
        if (!sel || c.kind !== 'audio') continue;
        const m = project.media[c.mediaId];
        if (!m || m.offline || !m.probe) continue;
        const stream = clipAudioStream(m, c);
        if (!stream || !resolveChannelSelection(sel, stream)) continue;
        const key = channelProxyKey(stream.index, sel);
        let byKey = out.get(m.id);
        if (!byKey) { byKey = new Map(); out.set(m.id, byKey); }
        if (!byKey.has(key)) byKey.set(key, { mediaId: m.id, key, stream: stream.index, selection: sel });
      }
    }
  }
  return out;
}

/** Requested job id -> what it builds. Jobs from an earlier renderer session are matched by their result instead. */
const jobTargets = new Map<ID, { mediaId: ID; key: string }>();
/** The job building `key` of a media item, when this session requested it (for progress). */
export function channelProxyJobId(mediaId: ID, key: string): ID | undefined {
  for (const [id, t] of jobTargets) if (t.mediaId === mediaId && t.key === key) return id;
  return undefined;
}
/** Ready proxy files checked to exist this session. */
const verified = new Set<string>();
/** Requests made and not yet answered (so a burst of syncs never requests one key twice). */
const requesting = new Set<string>();

const isActive = (p: ProxyInfo | undefined) => p?.status === 'queued' || p?.status === 'running';

/** Ask the main process for one channel proxy; marks it queued and routes the job when it answers. */
export async function requestChannelProxy(w: WantedChannelProxy): Promise<void> {
  const api = recutApi();
  const m = useStore.getState().project.media[w.mediaId];
  if (!api?.startChannelProxy || !m) return;
  const tag = `${w.mediaId}\u0000${w.key}`;
  if (requesting.has(tag)) return;
  requesting.add(tag);
  useStore.getState().setChannelProxies(w.mediaId, { [w.key]: { status: 'queued', progress: 0 } });
  try {
    const job = await api.startChannelProxy({ mediaId: w.mediaId, path: m.path, stream: w.stream, selection: w.selection });
    jobTargets.set(job.id, { mediaId: w.mediaId, key: w.key });
    // The job may have moved on before this answer arrived: route its latest state.
    routeChannelProxyJob(useJobsStore.getState().jobs.find((j) => j.id === job.id) ?? job);
  } catch (e) {
    useStore.getState().setChannelProxies(w.mediaId, { [w.key]: { status: 'failed', error: e instanceof Error ? e.message : String(e) } });
  } finally {
    requesting.delete(tag);
  }
}

/** Build again (Clip Inspector › Rebuild preview audio): forget the entry and request it. */
export function rebuildChannelProxy(w: WantedChannelProxy): void {
  useStore.getState().setChannelProxies(w.mediaId, { [w.key]: null });
  void requestChannelProxy(w);
}

/** Mirror a 'channelProxy' job into MediaItem.channelProxies (called by jobsRouter for every job update). */
export function routeChannelProxyJob(job: JobInfo): void {
  if (job.kind !== 'channelProxy') return;
  const result = (job.result ?? null) as { path?: string; key?: string } | null;
  const target = jobTargets.get(job.id) ?? (job.mediaId && typeof result?.key === 'string' ? { mediaId: job.mediaId, key: result.key } : undefined);
  if (!target) return;
  const st = useStore.getState();
  const m = st.project.media[target.mediaId];
  if (!m) return;
  const cur = m.channelProxies?.[target.key];
  const set = (info: ProxyInfo | null) => st.setChannelProxies(m.id, { [target.key]: info });
  switch (job.status) {
    case 'queued':
      if (!cur) set({ status: 'queued', progress: 0 });
      break;
    case 'running':
      if (cur?.status !== 'running' && cur?.status !== 'ready') set({ status: 'running', progress: job.progress || 0 });
      break;
    case 'done':
      jobTargets.delete(job.id);
      if (!result?.path) { set({ status: 'failed', error: 'The preview audio job finished without a file' }); break; }
      if (cur?.status === 'ready' && cur.path === result.path) break;
      invalidateMediaPath(result.path);
      verified.add(result.path);
      set({ status: 'ready', path: result.path, progress: 1 });
      break;
    case 'failed':
      jobTargets.delete(job.id);
      if (cur?.status !== 'failed') set({ status: 'failed', error: job.error ?? 'Preview audio failed' });
      break;
    case 'canceled':
      jobTargets.delete(job.id);
      if (isActive(cur)) set({ status: 'failed', error: 'Canceled' });
      break;
  }
}

/**
 * One pass: request the missing proxies, re-check ready files once per session (a deleted cache file is requested
 * again), and drop entries no clip needs any more (unless their job is still running).
 */
export async function syncChannelProxies(): Promise<void> {
  const st = useStore.getState();
  const { project } = st;
  const wanted = wantedChannelProxies(project);
  const api = recutApi();
  for (const [mediaId, byKey] of wanted) {
    const m = project.media[mediaId];
    for (const w of byKey.values()) {
      const cur = m.channelProxies?.[w.key];
      if (cur?.status === 'ready' && cur.path && !verified.has(cur.path)) {
        let exists = true;
        try { exists = api ? (await api.stat(cur.path)).exists : true; } catch { /* keep it */ }
        if (exists) { verified.add(cur.path); continue; }
        useStore.getState().setChannelProxies(mediaId, { [w.key]: null });
        void requestChannelProxy(w);
        continue;
      }
      if (!cur || cur.status === 'none') void requestChannelProxy(w);
    }
  }
  const prune = new Map<ID, Record<string, null>>();
  for (const m of Object.values(useStore.getState().project.media)) {
    if (!m.channelProxies) continue;
    for (const [k, p] of Object.entries(m.channelProxies)) {
      if (wanted.get(m.id)?.has(k) || isActive(p)) continue;
      const patch = prune.get(m.id) ?? {};
      patch[k] = null;
      prune.set(m.id, patch);
    }
  }
  for (const [id, patch] of prune) useStore.getState().setChannelProxies(id, patch);
}

const SYNC_DELAY_MS = 400;
let timer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;

function schedule(): void {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    // Never mid-drag (a level being dragged would request a proxy per value): try again once the drag ends.
    if (useStore.getState().transaction) { schedule(); return; }
    void syncChannelProxies();
  }, SYNC_DELAY_MS);
}

/** Watch the project (idempotent); returns a dispose function. */
export function initChannelProxies(): () => void {
  if (unsubscribe) return unsubscribe;
  schedule();
  const off = useStore.subscribe((s, prev) => {
    if (s.project.sequences !== prev.project.sequences || s.project.media !== prev.project.media) schedule();
  });
  unsubscribe = () => { off(); if (timer !== null) { clearTimeout(timer); timer = null; } unsubscribe = null; };
  return unsubscribe;
}
