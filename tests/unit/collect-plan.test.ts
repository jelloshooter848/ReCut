/**
 * Collect Project, the pure part (shared/collect.ts): selection, the name-collision scheme, missing files, proxies
 * and the path rewrite.
 */
import { describe, expect, it } from 'vitest';
import type { MediaItem, Project } from '../../shared/model';
import { createMediaItem, createProject } from '../../shared/project';
import { makeClip } from '../../shared/timeline';
import {
  allocateCollectNames, collectFolderName, collectSources, collectTotalsByKind, collectedProxyName, formatCollectBytes,
  mediaUsedInSequences, pathComponents, planCollect, rewriteCollectedProject, safeFileName,
  type CollectOptions, type CollectSourceStat,
} from '../../shared/collect';

const ALL: CollectOptions = { scope: 'all', includeSubtitles: true, includeProxies: true };
const SEQ: CollectOptions = { scope: 'sequences', includeSubtitles: true, includeProxies: false };

function addMedia(p: Project, path: string, name = path.split(/[\\/]/).pop()!): MediaItem {
  const m = createMediaItem(path, name);
  p.media[m.id] = m;
  return m;
}

function useInSequence(p: Project, m: MediaItem, start = 0): void {
  const seq = Object.values(p.sequences)[0];
  seq.videoTracks[0].clips.push(makeClip({ mediaId: m.id, name: m.name, sourceIn: 0, duration: 24, kind: 'video' }, start));
}

const allExist = (sizes: Record<string, number> = {}) => (path: string): CollectSourceStat => ({ exists: true, isFile: true, size: sizes[path] ?? 100 });

describe('allocateCollectNames (name-collision scheme)', () => {
  it('keeps unique names flat in the folder', () => {
    const m = allocateCollectNames(['/rips/a/Movie.mkv', '/other/Song.flac'], 'Media');
    expect(m.get('/rips/a/Movie.mkv')).toBe('Media/Movie.mkv');
    expect(m.get('/other/Song.flac')).toBe('Media/Song.flac');
  });

  it('separates files that share a name by the fewest trailing folders that tell them apart', () => {
    const paths = ['/mnt/rips/Disc 1/title_t00.mkv', '/mnt/rips/Disc 2/title_t00.mkv', '/mnt/rips/Disc 2/title_t01.mkv'];
    const m = allocateCollectNames(paths, 'Media');
    expect(m.get(paths[0])).toBe('Media/Disc 1/title_t00.mkv');
    expect(m.get(paths[1])).toBe('Media/Disc 2/title_t00.mkv');
    expect(m.get(paths[2])).toBe('Media/title_t01.mkv');
    // Same last folder: two levels are needed.
    const deep = ['/a/Season 1/Extras/clip.mp4', '/a/Season 2/Extras/clip.mp4'];
    const d = allocateCollectNames(deep, 'Media');
    expect(d.get(deep[0])).toBe('Media/Season 1/Extras/clip.mp4');
    expect(d.get(deep[1])).toBe('Media/Season 2/Extras/clip.mp4');
  });

  it('compares names case-insensitively (Windows and macOS folders are) and handles Windows paths', () => {
    const paths = ['D:\\Rips\\Disc 1\\TITLE_T00.MKV', 'E:\\Backup\\Disc 1\\title_t00.mkv'];
    const m = allocateCollectNames(paths, 'Media');
    // "Disc 1" does not tell them apart; "Rips/Disc 1" vs "Backup/Disc 1" does.
    expect(m.get(paths[0])).toBe('Media/Rips/Disc 1/TITLE_T00.MKV');
    expect(m.get(paths[1])).toBe('Media/Backup/Disc 1/title_t00.mkv');
    expect(pathComponents('C:\\Users\\me\\a.mkv')).toEqual(['C', 'Users', 'me', 'a.mkv']);
    expect(pathComponents('\\\\nas\\share\\a.mkv')).toEqual(['nas', 'share', 'a.mkv']);
  });

  it('numbers files whose whole folder paths differ only in case', () => {
    const paths = ['/x/Rips/a.mkv', '/x/rips/A.mkv'];
    const m = allocateCollectNames(paths, 'Media');
    expect(new Set([m.get(paths[0]), m.get(paths[1])])).toEqual(new Set(['Media/a.mkv', 'Media/A (2).mkv']));
  });

  it('never gives a file and a folder the same name, and is deterministic whatever the input order', () => {
    const paths = ['/one/Extras', '/a/Extras/x.mkv', '/b/Extras/x.mkv'];
    const m = allocateCollectNames(paths, 'Media');
    expect(m.get('/a/Extras/x.mkv')).toBe('Media/a/Extras/x.mkv');
    expect(m.get('/b/Extras/x.mkv')).toBe('Media/b/Extras/x.mkv');
    expect(m.get('/one/Extras')).toBe('Media/Extras');
    const rev = allocateCollectNames([...paths].reverse(), 'Media');
    expect([...rev.entries()].sort()).toEqual([...m.entries()].sort());
    // A file named like a folder another group needs: the folder is numbered.
    const clash = allocateCollectNames(['/p/Disc 1/t.mkv', '/q/Disc 2/t.mkv', '/r/Disc 1'], 'Media');
    expect(clash.get('/r/Disc 1')).toBe('Media/Disc 1');
    expect(clash.get('/p/Disc 1/t.mkv')).toBe('Media/Disc 1 (2)/t.mkv');
    expect(clash.get('/q/Disc 2/t.mkv')).toBe('Media/Disc 2/t.mkv');
  });

  it('makes names safe for every OS', () => {
    expect(safeFileName('a:b*c?.mkv')).toBe('a_b_c_.mkv');
    expect(safeFileName('CON.mkv')).toBe('_CON.mkv');
    expect(safeFileName('trailing. ')).toBe('trailing');
    expect(collectFolderName('My Cut: Director/Fan Edit')).toBe('My Cut_ Director_Fan Edit');
    expect(collectFolderName('  ')).toBe('Untitled Project');
  });
});

describe('collectedProxyName', () => {
  it('keeps the proxy suffix that says which audio streams it carries', () => {
    expect(collectedProxyName('title_t00.mkv', '/cache/proxies/0123456789abcdef0123456789abcdef01234567_540p_all.mp4')).toBe('title_t00.mkv_540p_all.mp4');
    expect(collectedProxyName('a.mkv', '/c/proxies/k_720p_a1_a3.mp4')).toBe('a.mkv_720p_a1_a3.mp4');
    expect(collectedProxyName('pic.tif', '/c/proxies/k_still.png')).toBe('pic.tif_still.png');
    expect(collectedProxyName('a.mkv', '/elsewhere/odd-name.mov')).toBe('a.mkv_proxy.mov');
  });
});

describe('selection', () => {
  it("'sequences' takes media used by clips (and snapshots); 'all' takes every media", () => {
    const p = createProject('Cut');
    const used = addMedia(p, '/m/used.mkv');
    const inSnapshot = addMedia(p, '/m/snap.mkv');
    const unused = addMedia(p, '/m/unused.mkv');
    useInSequence(p, used);
    const seq = Object.values(p.sequences)[0];
    const snapData = JSON.parse(JSON.stringify(seq));
    snapData.videoTracks[0].clips = [makeClip({ mediaId: inSnapshot.id, name: 's', sourceIn: 0, duration: 10, kind: 'video' }, 0)];
    seq.snapshots.push({ id: 'snap1', name: 'v1', createdAt: 0, data: snapData });
    expect([...mediaUsedInSequences(p)].sort()).toEqual([used.id, inSnapshot.id].sort());
    expect(collectSources(p, SEQ).map((s) => s.path).sort()).toEqual(['/m/snap.mkv', '/m/used.mkv']);
    expect(collectSources(p, { ...SEQ, scope: 'all' }).map((s) => s.path).sort()).toEqual(['/m/snap.mkv', '/m/unused.mkv', '/m/used.mkv']);
    const plan = planCollect(p, SEQ, allExist());
    expect(plan.unusedMedia).toBe(1);
    expect(plan.entries.map((e) => e.rel).sort()).toEqual(['Media/snap.mkv', 'Media/used.mkv']);
    void unused;
  });

  it('copies one file once when two media items share it, and rewrites both', () => {
    const p = createProject('Dup');
    const a = addMedia(p, '/m/movie.mkv', 'Movie');
    const b = addMedia(p, '/m/movie.mkv', 'Movie (again)');
    const plan = planCollect(p, ALL, allExist());
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].mediaIds.sort()).toEqual([a.id, b.id].sort());
    rewriteCollectedProject(p, plan, (rel) => `/dest/Dup/${rel}`);
    expect(p.media[a.id].path).toBe('/dest/Dup/Media/movie.mkv');
    expect(p.media[b.id].path).toBe('/dest/Dup/Media/movie.mkv');
  });

  it('subtitle files: media tracks of collected media and sequence sources, only when included', () => {
    const p = createProject('Subs');
    const used = addMedia(p, '/m/ep1.mkv');
    const unused = addMedia(p, '/m/ep2.mkv');
    useInSequence(p, used);
    p.subtitleTracks.t1 = { id: 't1', name: 'ep1.srt', language: 'eng', path: '/m/ep1.srt', mediaId: used.id, cues: [], origin: 'srt' };
    p.subtitleTracks.t2 = { id: 't2', name: 'ep2.srt', language: 'eng', path: '/m/ep2.srt', mediaId: unused.id, cues: [], origin: 'srt' };
    p.subtitleTracks.t3 = { id: 't3', name: 'ocr', language: 'eng', mediaId: used.id, cues: [], origin: 'ocr', streamIndex: 3 };
    const seq = Object.values(p.sequences)[0];
    seq.subtitleTracks.push({ id: 's1', name: 'Fan subs', language: 'eng', enabled: true, cues: [], sourcePaths: ['/subs/fan.srt'] });
    expect(collectSources(p, SEQ).filter((s) => s.kind === 'subtitle').map((s) => s.path).sort()).toEqual(['/m/ep1.srt', '/subs/fan.srt']);
    expect(collectSources(p, { ...SEQ, includeSubtitles: false }).filter((s) => s.kind === 'subtitle')).toEqual([]);
    const plan = planCollect(p, SEQ, allExist());
    rewriteCollectedProject(p, plan, (rel) => `/d/${rel}`);
    expect(p.subtitleTracks.t1.path).toBe('/d/Subtitles/ep1.srt');
    expect(p.subtitleTracks.t2.path).toBe('/m/ep2.srt'); // not collected: unchanged
    expect(seq.subtitleTracks[0].sourcePaths).toEqual(['/d/Subtitles/fan.srt']);
  });
});

describe('planCollect', () => {
  it('lists offline media as missing (kept at their paths) and sums sizes per kind', () => {
    const p = createProject('Partial');
    const ok = addMedia(p, '/m/ok.mkv', 'OK');
    const gone = addMedia(p, '/gone/lost.mkv', 'Lost');
    ok.proxy = { status: 'ready', path: '/cache/proxies/abc_540p_all.mp4' };
    gone.proxy = { status: 'ready', path: '/cache/proxies/def_540p_all.mp4' };
    const stat = (path: string): CollectSourceStat => (path.startsWith('/gone') ? { exists: false } : { exists: true, isFile: true, size: path.endsWith('.mp4') ? 10 : 1000 });
    const plan = planCollect(p, ALL, stat);
    expect(plan.missing).toEqual([{ kind: 'media', path: '/gone/lost.mkv', mediaIds: [gone.id], names: ['Lost'] }]);
    expect(plan.entries.map((e) => [e.kind, e.rel])).toEqual([['media', 'Media/ok.mkv'], ['proxy', 'Proxies/ok.mkv_540p_all.mp4']]);
    expect(plan.totalBytes).toBe(1010);
    expect(collectTotalsByKind(plan)).toEqual({ media: { files: 1, bytes: 1000 }, subtitle: { files: 0, bytes: 0 }, proxy: { files: 1, bytes: 10 } });
    rewriteCollectedProject(p, plan, (rel) => `/d/Partial/${rel}`);
    expect(p.media[ok.id].path).toBe('/d/Partial/Media/ok.mkv');
    expect(p.media[ok.id].proxy.path).toBe('/d/Partial/Proxies/ok.mkv_540p_all.mp4');
    expect(p.media[gone.id].path).toBe('/gone/lost.mkv');
    expect(p.media[gone.id].proxy.path).toBe('/cache/proxies/def_540p_all.mp4');
  });

  it('a folder at a media path is not a file: reported missing', () => {
    const p = createProject('X');
    addMedia(p, '/m/dir.mkv');
    const plan = planCollect(p, ALL, () => ({ exists: true, isFile: false, size: 0 }));
    expect(plan.entries).toEqual([]);
    expect(plan.missing).toHaveLength(1);
  });

  it('proxies follow their media subfolder; without the option they are not copied and keep their cache path', () => {
    const p = createProject('Px');
    const a = addMedia(p, '/r/Disc 1/title_t00.mkv');
    const b = addMedia(p, '/r/Disc 2/title_t00.mkv');
    a.proxy = { status: 'ready', path: '/c/1_540p_all.mp4' };
    b.proxy = { status: 'ready', path: '/c/2_540p_all.mp4' };
    const plan = planCollect(p, ALL, allExist());
    expect(plan.entries.filter((e) => e.kind === 'proxy').map((e) => e.rel).sort()).toEqual([
      'Proxies/Disc 1/title_t00.mkv_540p_all.mp4', 'Proxies/Disc 2/title_t00.mkv_540p_all.mp4',
    ]);
    const without = planCollect(p, { ...ALL, includeProxies: false }, allExist());
    expect(without.entries.some((e) => e.kind === 'proxy')).toBe(false);
    rewriteCollectedProject(p, without, (rel) => `/d/${rel}`);
    expect(p.media[a.id].proxy.path).toBe('/c/1_540p_all.mp4');
    // A proxy that is not ready is never copied.
    const q = createProject('Q');
    const c = addMedia(q, '/r/c.mkv');
    c.proxy = { status: 'failed', path: '/c/3_540p_all.mp4' };
    expect(planCollect(q, ALL, allExist()).entries.map((e) => e.kind)).toEqual(['media']);
  });

  it('names the folder and project file after the project', () => {
    const plan = planCollect(createProject('Star Saga: Fan Cut'), ALL, allExist());
    expect(plan.folderName).toBe('Star Saga_ Fan Cut');
    expect(plan.projectFileName).toBe('Star Saga_ Fan Cut.recut');
  });
});

describe('formatCollectBytes', () => {
  it('formats sizes', () => {
    expect(formatCollectBytes(0)).toBe('0 B');
    expect(formatCollectBytes(512)).toBe('512 B');
    expect(formatCollectBytes(1536)).toBe('1.5 KB');
    expect(formatCollectBytes(40 * 1024 ** 3)).toBe('40.0 GB');
  });
});
