/**
 * Collect Project (roadmap §16): the pure part. Which files a collect copies, where each one goes inside the
 * collected folder, and the collected project with its paths rewritten. The copying itself (a cancellable job with
 * byte progress and verification) is electron/project/collect.ts; the dialog is src/panels/collect/.
 *
 * Layout of a collected project, inside the destination folder the user picked:
 *
 *   <Project name>/
 *     <Project name>.recut
 *     Media/        the media files
 *     Subtitles/    subtitle files the project imported (option)
 *     Proxies/      ready proxies (option): `<media file name>_<proxy suffix>`, e.g. `title_t00.mkv_540p_all.mp4`
 *     COLLECT-INCOMPLETE.txt   only while copying, or when the collect failed or was canceled
 *
 * Names (allocateCollectNames): a file keeps its own name directly in its folder (`Media/feature.mkv`). Files from
 * different folders that share a name (case-insensitively: `D:\Rips\Disc 1\title_t00.mkv` and
 * `D:\Rips\Disc 2\title_t00.mkv`) each go into a subfolder named after the fewest trailing folders of their original
 * location that tell them apart: `Media/Disc 1/title_t00.mkv`, `Media/Disc 2/title_t00.mkv`. Only when even their
 * whole folder paths do not (paths that differ only in case) is a number added: `title_t00 (2).mkv`. Characters
 * Windows refuses in names are replaced with `_`. Planning is deterministic: paths are processed in sorted order.
 *
 * Paths stay absolute in the collected project (relative media roots are roadmap §17): every copied file's path is
 * rewritten to its new absolute location. Media that are not copied (offline, or unused when only media used in
 * sequences are collected) keep their original paths.
 *
 * Pure: no DOM, no Node. Paths are handled as strings (POSIX, or Windows when they look like Windows paths).
 */
import type { ID, MediaItem, Project, Sequence } from './model';

export type CollectScope = 'sequences' | 'all';

export interface CollectOptions {
  /** 'sequences': only media used by a clip in some sequence (or sequence snapshot); 'all': every project media. */
  scope: CollectScope;
  /** Copy the subtitle files the project imported (media subtitle tracks, sequence subtitle sources). */
  includeSubtitles: boolean;
  /** Copy ready proxies, so the collected project previews without rebuilding them on another machine. */
  includeProxies: boolean;
}

export const DEFAULT_COLLECT_OPTIONS: CollectOptions = { scope: 'all', includeSubtitles: true, includeProxies: false };

export type CollectFileKind = 'media' | 'subtitle' | 'proxy';

/** Subfolder of the collected folder for each kind of file. */
export const COLLECT_FOLDERS: Record<CollectFileKind, string> = { media: 'Media', subtitle: 'Subtitles', proxy: 'Proxies' };

/** Present in a collected folder while it is being written, and left behind when the collect failed or was canceled. */
export const COLLECT_INCOMPLETE_MARKER = 'COLLECT-INCOMPLETE.txt';

/** A file the project references that a collect would copy. */
export interface CollectSource {
  kind: CollectFileKind;
  /** Absolute path of the original. */
  path: string;
  /** Media items this file belongs to (media and proxies; the media of a subtitle track). */
  mediaIds: ID[];
  /** Display names (media names, subtitle track names) for warnings. */
  names: string[];
}

/** What the planner needs to know about a source (from a stat). */
export interface CollectSourceStat { exists: boolean; isFile?: boolean; size?: number }

/** One copy of the plan. */
export interface CollectEntry {
  kind: CollectFileKind;
  source: string;
  /** Path inside the collected folder, `/`-separated (`Media/Disc 1/title_t00.mkv`). */
  rel: string;
  size: number;
  mediaIds: ID[];
  names: string[];
}

/** A referenced file that cannot be copied (offline media, a missing subtitle file). Skipped with a warning. */
export interface CollectMissing { kind: CollectFileKind; path: string; mediaIds: ID[]; names: string[] }

export interface CollectPlan {
  /** Folder created in the destination: the project name, made safe for every OS. */
  folderName: string;
  /** Project file inside it. */
  projectFileName: string;
  entries: CollectEntry[];
  missing: CollectMissing[];
  totalBytes: number;
  /** Media items not copied because no sequence uses them (scope 'sequences'). They keep their original paths. */
  unusedMedia: number;
}

/** Totals per kind, for the dialog's summary. */
export interface CollectKindTotals { files: number; bytes: number }

/**
 * The dialog's summary before starting (IPC collect:preflight). `problems` block the start (folder not empty, not
 * enough space, ...); `missing` are skipped with a warning.
 */
export type CollectSummary =
  | {
    ok: true;
    /** `<destination>/<Project name>`: created by the collect. */
    folder: string;
    projectFile: string;
    files: number;
    totalBytes: number;
    byKind: Record<CollectFileKind, CollectKindTotals>;
    /** Free bytes on the destination's volume; null when the OS does not say. */
    freeBytes: number | null;
    missing: CollectMissing[];
    unusedMedia: number;
    problems: string[];
  }
  | { ok: false; error: string };

/** What the renderer sends for a preflight or a start: the current project (serialized) and the choices. */
export interface CollectRequest {
  /** The open project, serialized (shared/project.ts serializeProject); the open project itself is never changed. */
  projectJson: string;
  /** Absolute folder the user picked; the collect creates `<Project name>/` inside it. */
  destination: string;
  options: CollectOptions;
}

export type CollectStartResult = { ok: true; jobId: ID; folder: string; projectFile: string } | { ok: false; error: string };

/** Result of a finished 'collect' job (JobInfo.result). */
export interface CollectResult {
  folder: string;
  projectFile: string;
  files: number;
  bytes: number;
  missing: CollectMissing[];
}

// ------------------------------------------------------------------
// Paths (pure string handling)
// ------------------------------------------------------------------

/** A Windows path: a drive (`C:\`, `C:/`) or a UNC share (`\\server\share`). */
export function isWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/** Components of an absolute path (drive letter `C:` becomes `C`). */
export function pathComponents(p: string): string[] {
  const parts = p.split(isWindowsPath(p) ? /[\\/]+/ : /\/+/).filter(Boolean);
  if (parts.length && /^[a-zA-Z]:$/.test(parts[0])) parts[0] = parts[0][0];
  return parts;
}

/** File name of a path (either separator on Windows paths). */
export function pathBaseName(p: string): string {
  const parts = pathComponents(p);
  return parts[parts.length - 1] ?? '';
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** A name every supported OS accepts: no `<>:"/\|?*` or control characters, no trailing dot / space, no device name. */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let s = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  if (!s) s = '_';
  if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
  return s;
}

/** The collected folder's name for a project. */
export function collectFolderName(projectName: string): string {
  return safeFileName(projectName.trim() || 'Untitled Project');
}

const fold = (s: string) => s.toLowerCase();

function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
}

/**
 * Claims relative paths so that no two are equal case-insensitively and no file name is also used as a folder
 * (`Media/Extras` the file vs `Media/Extras/x.mkv`). A taken path gets ` (2)`, ` (3)`, ... before its extension.
 */
export class NameClaims {
  private files = new Set<string>();
  private dirs = new Set<string>();

  claim(segments: string[]): string {
    const dirs = segments.slice(0, -1);
    const [stem, ext] = splitExt(segments[segments.length - 1]);
    for (let n = 1; ; n++) {
      const file = n === 1 ? `${stem}${ext}` : `${stem} (${n})${ext}`;
      const rel = [...dirs, file].join('/');
      if (this.free(dirs, rel)) {
        this.files.add(fold(rel));
        for (let i = 1; i <= dirs.length; i++) this.dirs.add(fold(dirs.slice(0, i).join('/')));
        return rel;
      }
    }
  }

  private free(dirs: string[], rel: string): boolean {
    const f = fold(rel);
    if (this.files.has(f) || this.dirs.has(f)) return false;
    for (let i = 1; i <= dirs.length; i++) if (this.files.has(fold(dirs.slice(0, i).join('/')))) return false;
    return true;
  }
}

/**
 * Relative names (under `folder`) for a set of source files, by the scheme in the header: own name when unique;
 * when several share a name, the fewest trailing parent folders that tell them apart become subfolders; numbers last.
 * Returns source path -> `folder/...` (`/`-separated). Exported for tests.
 */
export function allocateCollectNames(paths: readonly string[], folder: string, claims: NameClaims = new NameClaims()): Map<string, string> {
  const uniq = [...new Set(paths)].sort();
  const groups = new Map<string, { path: string; base: string; dirs: string[] }[]>();
  for (const p of uniq) {
    const parts = pathComponents(p).map(safeFileName);
    const base = parts.pop() ?? '_';
    const g = groups.get(fold(base)) ?? [];
    g.push({ path: p, base, dirs: parts });
    groups.set(fold(base), g);
  }
  const out = new Map<string, string>();
  for (const key of [...groups.keys()].sort()) {
    const g = groups.get(key)!;
    if (g.length === 1) {
      out.set(g[0].path, claims.claim([folder, g[0].base]));
      continue;
    }
    const maxDepth = Math.max(...g.map((x) => x.dirs.length));
    let depth = 0;
    for (let d = 1; d <= maxDepth; d++) {
      const tails = new Set(g.map((x) => fold(x.dirs.slice(-d).join('/'))));
      if (tails.size === g.length) { depth = d; break; }
    }
    for (const x of g) out.set(x.path, claims.claim([folder, ...(depth ? x.dirs.slice(-depth) : []), x.base]));
  }
  return out;
}

/** The part of a cache proxy's file name after its key: `540p_all.mp4`, `720p_a1_a3.mp4`, `still.png`. */
const PROXY_SUFFIX = /_(\d+p(?:_all|(?:_a\d+)*)\.mp4|still\.png)$/i;

/** File name of a collected proxy: the media's collected name + the proxy's suffix (keeps `_all` / `_a<N>` readable). */
export function collectedProxyName(mediaFileName: string, proxyPath: string): string {
  const m = PROXY_SUFFIX.exec(pathBaseName(proxyPath));
  if (m) return `${mediaFileName}_${m[1]}`;
  const [, ext] = splitExt(pathBaseName(proxyPath));
  return `${mediaFileName}_proxy${ext}`;
}

// ------------------------------------------------------------------
// Selection
// ------------------------------------------------------------------

function clipMediaIds(seq: Pick<Sequence, 'videoTracks' | 'audioTracks'>, into: Set<ID>): void {
  for (const t of [...(seq.videoTracks ?? []), ...(seq.audioTracks ?? [])]) for (const c of t.clips ?? []) into.add(c.mediaId);
}

/** Media used by a clip in any sequence, or in any sequence snapshot (restoring one needs its media). */
export function mediaUsedInSequences(project: Project): Set<ID> {
  const used = new Set<ID>();
  for (const seq of Object.values(project.sequences)) {
    clipMediaIds(seq, used);
    for (const snap of seq.snapshots ?? []) clipMediaIds(snap.data, used);
  }
  return used;
}

/** Media items a collect copies with these options (in project order). */
export function collectedMedia(project: Project, options: Pick<CollectOptions, 'scope'>): MediaItem[] {
  const all = Object.values(project.media).filter((m) => typeof m.path === 'string' && m.path !== '');
  if (options.scope === 'all') return all;
  const used = mediaUsedInSequences(project);
  return all.filter((m) => used.has(m.id));
}

function addSource(map: Map<string, CollectSource>, kind: CollectFileKind, p: string, mediaId: ID | null, name: string): void {
  if (!p) return;
  const s = map.get(p) ?? { kind, path: p, mediaIds: [], names: [] };
  if (mediaId && !s.mediaIds.includes(mediaId)) s.mediaIds.push(mediaId);
  if (name && !s.names.includes(name)) s.names.push(name);
  map.set(p, s);
}

/** Every file a collect with these options would copy, before checking which exist. Deduplicated by path. */
export function collectSources(project: Project, options: CollectOptions): CollectSource[] {
  const media = collectedMedia(project, options);
  const chosen = new Set(media.map((m) => m.id));
  const mediaSources = new Map<string, CollectSource>();
  for (const m of media) addSource(mediaSources, 'media', m.path, m.id, m.name);
  // Another item with the same file (imported twice) shares the copy.
  for (const m of Object.values(project.media)) if (mediaSources.has(m.path)) addSource(mediaSources, 'media', m.path, m.id, m.name);

  const subtitles = new Map<string, CollectSource>();
  if (options.includeSubtitles) {
    for (const t of Object.values(project.subtitleTracks)) {
      if (!t.path || mediaSources.has(t.path)) continue;
      if (t.mediaId && !chosen.has(t.mediaId)) continue;
      addSource(subtitles, 'subtitle', t.path, t.mediaId, t.name);
    }
    for (const seq of Object.values(project.sequences)) {
      for (const t of seq.subtitleTracks ?? []) for (const p of t.sourcePaths ?? []) if (!mediaSources.has(p)) addSource(subtitles, 'subtitle', p, null, t.name);
    }
  }

  const proxies = new Map<string, CollectSource>();
  if (options.includeProxies) {
    for (const m of media) {
      const p = m.proxy?.status === 'ready' ? m.proxy.path : undefined;
      if (p && !mediaSources.has(p) && !subtitles.has(p)) addSource(proxies, 'proxy', p, m.id, m.name);
    }
  }
  return [...mediaSources.values(), ...subtitles.values(), ...proxies.values()];
}

// ------------------------------------------------------------------
// Plan
// ------------------------------------------------------------------

/**
 * The copy plan: each source that exists as a file gets its place in the collected folder (allocateCollectNames);
 * the rest are `missing`. A proxy goes with its media: it is copied only when its media is, and named after it.
 */
export function planCollect(project: Project, options: CollectOptions, stat: (path: string) => CollectSourceStat | undefined): CollectPlan {
  const sources = collectSources(project, options);
  const folderName = collectFolderName(project.name);
  const present = (s: CollectSource) => { const st = stat(s.path); return !!st?.exists && st.isFile !== false; };
  const sizeOf = (s: CollectSource) => Math.max(0, stat(s.path)?.size ?? 0);
  const missing: CollectMissing[] = [];
  const ok: CollectSource[] = [];
  for (const s of sources) {
    if (present(s)) ok.push(s);
    else if (s.kind !== 'proxy') missing.push({ kind: s.kind, path: s.path, mediaIds: [...s.mediaIds], names: [...s.names] });
    // A missing proxy is not worth a warning: the collected project marks it missing and rebuilds it when needed.
  }

  const claims = new NameClaims();
  const entries: CollectEntry[] = [];
  const of = (kind: CollectFileKind) => ok.filter((s) => s.kind === kind);
  for (const kind of ['media', 'subtitle'] as const) {
    const list = of(kind);
    const names = allocateCollectNames(list.map((s) => s.path), COLLECT_FOLDERS[kind], claims);
    for (const s of list) entries.push({ kind, source: s.path, rel: names.get(s.path)!, size: sizeOf(s), mediaIds: [...s.mediaIds], names: [...s.names] });
  }
  const mediaRel = new Map<ID, string>();
  for (const e of entries) if (e.kind === 'media') for (const id of e.mediaIds) mediaRel.set(id, e.rel);
  for (const s of of('proxy').sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const rel = s.mediaIds.map((id) => mediaRel.get(id)).find((r): r is string => !!r);
    if (!rel) continue; // its media is not copied (offline)
    const parts = rel.split('/').slice(1); // drop "Media"
    const file = collectedProxyName(parts.pop()!, s.path);
    entries.push({ kind: 'proxy', source: s.path, rel: claims.claim([COLLECT_FOLDERS.proxy, ...parts, file]), size: sizeOf(s), mediaIds: [...s.mediaIds], names: [...s.names] });
  }

  const chosen = new Set(collectedMedia(project, options).map((m) => m.id));
  for (const s of sources) if (s.kind === 'media') for (const id of s.mediaIds) chosen.add(id);
  const unusedMedia = Object.values(project.media).filter((m) => m.path && !chosen.has(m.id)).length;
  return {
    folderName,
    projectFileName: `${folderName}.recut`,
    entries,
    missing,
    totalBytes: entries.reduce((a, e) => a + e.size, 0),
    unusedMedia,
  };
}

/** Totals per kind of a plan. */
export function collectTotalsByKind(plan: Pick<CollectPlan, 'entries'>): Record<CollectFileKind, CollectKindTotals> {
  const t: Record<CollectFileKind, CollectKindTotals> = { media: { files: 0, bytes: 0 }, subtitle: { files: 0, bytes: 0 }, proxy: { files: 0, bytes: 0 } };
  for (const e of plan.entries) { t[e.kind].files++; t[e.kind].bytes += e.size; }
  return t;
}

/**
 * Rewrite `project` (MUTATED, pass a copy) to the collected locations: `abs(rel)` is the absolute path of a planned
 * file. Media paths, ready proxy paths, subtitle track files and sequence subtitle sources (also in snapshots) that
 * were copied point at their copies; everything else keeps its path. Returns the same object.
 */
export function rewriteCollectedProject(project: Project, plan: Pick<CollectPlan, 'entries'>, abs: (rel: string) => string): Project {
  const bySource = new Map<string, CollectEntry>();
  for (const e of plan.entries) bySource.set(`${e.kind}\0${e.source}`, e);
  const moved = (kind: CollectFileKind, p: string | undefined) => {
    const e = p ? bySource.get(`${kind}\0${p}`) : undefined;
    return e ? abs(e.rel) : undefined;
  };
  for (const m of Object.values(project.media)) {
    const np = moved('media', m.path);
    if (np) m.path = np;
    if (m.proxy?.path) {
      const pp = moved('proxy', m.proxy.path);
      if (pp) m.proxy.path = pp;
    }
  }
  for (const t of Object.values(project.subtitleTracks)) {
    const np = moved('subtitle', t.path);
    if (np) t.path = np;
  }
  const remapSources = (tracks: Sequence['subtitleTracks'] | undefined) => {
    for (const t of tracks ?? []) if (t.sourcePaths) t.sourcePaths = t.sourcePaths.map((p) => moved('subtitle', p) ?? p);
  };
  for (const seq of Object.values(project.sequences)) {
    remapSources(seq.subtitleTracks);
    for (const snap of seq.snapshots ?? []) remapSources(snap.data.subtitleTracks);
  }
  return project;
}

/** "1.4 GB" style size for summaries (base 1024, like the OS file managers on Windows). */
export function formatCollectBytes(n: number): string {
  if (!(n > 0)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
