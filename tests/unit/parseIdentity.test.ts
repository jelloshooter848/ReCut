import { describe, it, expect } from 'vitest';
import { parseEpisodeInfo, episodeLabel, classifyPath, importIdentity, sidecarLanguage } from '../../src/state/parseIdentity';
import * as compat from '../../src/panels/project/parseIdentity';

describe('parseEpisodeInfo', () => {
  it('parses SxxEyy release names and strips quality junk from the title', () => {
    expect(parseEpisodeInfo('Station.Eleven.S01E03.Hurricane.1080p.WEB-DL.DDP5.1.x264-NTb.mkv')).toEqual({
      series: 'Station Eleven', season: 1, episode: 3, title: 'Hurricane',
    });
  });

  it('parses the synthetic test media names', () => {
    expect(parseEpisodeInfo('/tmp/tv/Season 01/Station Eleven S01E01.mp4')).toEqual({ series: 'Station Eleven', season: 1, episode: 1 });
    expect(parseEpisodeInfo('Station Eleven S01E02.mp4')).toEqual({ series: 'Station Eleven', season: 1, episode: 2 });
  });

  it('parses 1x03 style', () => {
    expect(parseEpisodeInfo('Firefly - 1x03 - Bushwhacked.avi')).toEqual({ series: 'Firefly', season: 1, episode: 3, title: 'Bushwhacked' });
    expect(parseEpisodeInfo('Firefly 01x11.mkv')).toEqual({ series: 'Firefly', season: 1, episode: 11 });
  });

  it('parses "Season 1 Episode 3" wording', () => {
    expect(parseEpisodeInfo('The Expanse Season 2 Episode 5.mp4')).toEqual({ series: 'The Expanse', season: 2, episode: 5 });
    expect(parseEpisodeInfo('The Expanse - Season 02, Ep 05 - Home.mkv')).toEqual({ series: 'The Expanse', season: 2, episode: 5, title: 'Home' });
  });

  it('parses a bare "Season 1" with no episode number', () => {
    expect(parseEpisodeInfo('Lost Season 1.mkv')).toEqual({ series: 'Lost', season: 1 });
  });

  it('parses episode-only markers', () => {
    expect(parseEpisodeInfo('Cowboy Bebop E05.mkv')).toEqual({ series: 'Cowboy Bebop', episode: 5 });
    expect(parseEpisodeInfo('Cowboy Bebop Episode 12 - Jupiter Jazz.mkv')).toEqual({ series: 'Cowboy Bebop', episode: 12, title: 'Jupiter Jazz' });
  });

  it('handles multi-episode files', () => {
    expect(parseEpisodeInfo('Show.S01E01E02.Pilot.mkv')).toEqual({ series: 'Show', season: 1, episode: 1, episodeEnd: 2, title: 'Pilot' });
    expect(parseEpisodeInfo('Show S01E01-E02.mkv')).toEqual({ series: 'Show', season: 1, episode: 1, episodeEnd: 2 });
  });

  it('extracts a year next to the series name', () => {
    expect(parseEpisodeInfo('Battlestar Galactica (2003) S02E05.mkv')).toEqual({ series: 'Battlestar Galactica', year: 2003, season: 2, episode: 5 });
    expect(parseEpisodeInfo('Doctor.Who.2005.S04E10.Midnight.720p.mkv')).toEqual({ series: 'Doctor Who', year: 2005, season: 4, episode: 10, title: 'Midnight' });
  });

  it('treats movie-like names as a title with an optional year', () => {
    expect(parseEpisodeInfo('Galaxy Saga 1 - A New Dawn.mp4')).toEqual({ title: 'Galaxy Saga 1 - A New Dawn' });
    expect(parseEpisodeInfo('The.Matrix.1999.1080p.BluRay.x264.mkv')).toEqual({ title: 'The Matrix', year: 1999 });
    expect(parseEpisodeInfo('Blade Runner (1982).mkv')).toEqual({ title: 'Blade Runner', year: 1982 });
  });

  it('never throws on odd input', () => {
    expect(parseEpisodeInfo('')).toEqual({});
    expect(parseEpisodeInfo('.mkv')).toEqual({});
    expect(parseEpisodeInfo('S01E01')).toEqual({ season: 1, episode: 1 });
    expect(parseEpisodeInfo('1080p.mkv')).toEqual({});
  });

  it('does not mistake resolutions for episode markers', () => {
    const r = parseEpisodeInfo('Some Show 1080p x265.mkv');
    expect(r.episode).toBeUndefined();
    expect(r.series).toBeUndefined();
    expect(r.title).toBe('Some Show');
  });
});

describe('episodeLabel', () => {
  it('formats labels', () => {
    expect(episodeLabel({ season: 1, episode: 3 })).toBe('S01E03');
    expect(episodeLabel({ season: 2 })).toBe('S02');
    expect(episodeLabel({ episode: 7 })).toBe('E07');
    expect(episodeLabel({ season: 1, episode: 1, episodeEnd: 2 })).toBe('S01E01-E02');
    expect(episodeLabel({})).toBe('');
  });
});

describe('import-time identity', () => {
  it('keeps the panel re-export working', () => {
    expect(compat.parseEpisodeInfo).toBe(parseEpisodeInfo);
    expect(compat.episodeLabel).toBe(episodeLabel);
  });

  it('classifies paths by extension', () => {
    expect(classifyPath('/a/Show S01E01.MKV')).toBe('video');
    expect(classifyPath('/a/score.m4a')).toBe('audio');
    expect(classifyPath('C:\\x\\card.PNG')).toBe('image');
    expect(classifyPath('/a/Show S01E01.en.srt')).toBe('subtitle');
    expect(classifyPath('/a/b.vtt')).toBe('subtitle');
    expect(classifyPath('/a/proj.recut')).toBe('unknown');
    expect(classifyPath('/a/noext')).toBe('unknown');
  });

  it('SxxEyy → Episode in TV with series/season/episode/title', () => {
    expect(importIdentity('/tv/Station.Eleven.S01E03.Hurricane.1080p.WEB.mkv')).toEqual({
      identity: { series: 'Station Eleven', season: 1, episode: 3, title: 'Hurricane' }, category: 'Episode', bin: 'tv',
    });
    expect(importIdentity('/tv/Station Eleven S01E01.mp4')).toEqual({ identity: { series: 'Station Eleven', season: 1, episode: 1 }, category: 'Episode', bin: 'tv' });
    // Multi-episode end is not part of the stored identity
    expect(importIdentity('/tv/Show S01E01E02.mkv').identity).toEqual({ series: 'Show', season: 1, episode: 1 });
    // Episode marker without a series name: Episode, but no series bin
    expect(importIdentity('/tv/E05.mkv')).toEqual({ identity: { episode: 5 }, category: 'Episode', bin: null });
  });

  it('year without an episode → Movie; nothing recognisable → Other with empty identity', () => {
    expect(importIdentity('/m/Blade.Runner.1982.Final.Cut.2160p.UHD.mkv')).toEqual({ identity: { title: 'Blade Runner', year: 1982 }, category: 'Movie', bin: 'movies' });
    expect(importIdentity('/m/Galaxy Saga 1 - A New Dawn.mp4')).toEqual({ identity: {}, category: 'Other', bin: null });
    expect(importIdentity('/m/clip-001.mp4')).toEqual({ identity: {}, category: 'Other', bin: null });
  });

  it('audio → Music, images → Other in Graphics, regardless of the name', () => {
    expect(importIdentity('/a/Soundtrack (2001) S01E01.flac')).toEqual({ identity: {}, category: 'Music', bin: 'audio' });
    expect(importIdentity('/a/title-card.png')).toEqual({ identity: {}, category: 'Other', bin: 'graphics' });
    expect(importIdentity('/a/anything.bin', 'audio').category).toBe('Music');
  });

  it('sidecar subtitle matching and language suffixes', () => {
    const v = 'Station Eleven S01E01.mkv';
    expect(sidecarLanguage(v, 'Station Eleven S01E01.srt')).toBe('und');
    expect(sidecarLanguage(v, 'Station Eleven S01E01.vtt')).toBe('und');
    expect(sidecarLanguage(v, 'station eleven s01e01.EN.srt')).toBe('en');
    expect(sidecarLanguage(v, 'Station Eleven S01E01.pt-BR.srt')).toBe('pt-br');
    expect(sidecarLanguage(v, 'Station Eleven S01E01.eng.forced.srt')).toBe('eng');
    expect(sidecarLanguage(v, 'Station Eleven S01E01.sdh.srt')).toBe('und');
    expect(sidecarLanguage(v, 'Station Eleven S01E01.forced.srt')).toBe('und');
    expect(sidecarLanguage(v, 'Station Eleven S01E012.srt')).toBeNull();   // different file
    expect(sidecarLanguage(v, 'Station Eleven S01E02.srt')).toBeNull();
    expect(sidecarLanguage(v, 'Station Eleven S01E01.ass')).toBeNull();
    expect(sidecarLanguage(v, 'Station Eleven S01E01.mkv')).toBeNull();
  });
});
