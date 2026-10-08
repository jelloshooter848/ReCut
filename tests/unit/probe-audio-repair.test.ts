/**
 * bugs/closed/2026-10-08-stored-probe-audio-streams-not-repaired.md: a project's stored probe is used as is until the
 * file is probed again (an offline file never is), so its audio stream entries are repaired on load, and the channel
 * menu of a stream never lists more channels than a selection can address (c0..c99).
 */
import { describe, it, expect } from 'vitest';
import { createMediaItem, createProject, normalizeProjectWithReport } from '@shared/project';
import { streamChannelIds } from '@shared/audioChannels';

function projectWithAudio(audio: unknown[]): unknown {
  const p = createProject('p');
  const m = createMediaItem('/media/a.mkv', 'a.mkv');
  m.kind = 'video';
  m.probe = { container: 'matroska', duration: 10, size: 1, startTime: 0, browserPlayable: true, audio: audio as never, subtitles: [] };
  p.media[m.id] = m;
  return JSON.parse(JSON.stringify(p));
}

describe('stored probe audio streams are repaired on load', () => {
  it('unusable index drops the entry; wrong channel count, codec, layout, sample rate are reset; valid entries are kept', () => {
    const good = { index: 1, codec: 'ac3', channels: 6, layout: '5.1', sampleRate: 48000, language: 'eng', title: 'Main' };
    const { project, repairs } = normalizeProjectWithReport(projectWithAudio([
      good,
      { index: 2, codec: 'pcm', channels: 1.5, layout: 42, sampleRate: -1, language: 7, title: null, layoutGuessed: 'yes' },
      { index: 'x', codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 },
      { index: -1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 },
      { index: 3, codec: 'aac', channels: -2, layout: 'stereo', sampleRate: 48000 },
    ]));
    const audio = Object.values(project.media)[0].probe!.audio;
    expect(audio).toEqual([
      good,
      { index: 2, codec: 'pcm', channels: 0, layout: '', sampleRate: 0 },
      { index: 3, codec: 'aac', channels: 0, layout: 'stereo', sampleRate: 48000 },
    ]);
    expect(repairs.join('\n')).toMatch(/probed audio stream without a usable index removed \(2x\)/);
    expect(normalizeProjectWithReport(JSON.parse(JSON.stringify(project))).repairs).toEqual([]);
  });

  it('a valid probe reports nothing', () => {
    expect(normalizeProjectWithReport(projectWithAudio([{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000, layoutGuessed: true }])).repairs).toEqual([]);
  });
});

describe('streamChannelIds', () => {
  it('lists at most the 100 numbered channels a selection can store, whatever the channel count claims', () => {
    const t0 = performance.now();
    const ids = streamChannelIds({ channels: 1e9, layout: '' });
    expect(performance.now() - t0).toBeLessThan(50);
    expect(ids.length).toBe(100);
    expect(ids[99]).toBe('c99');
    expect(streamChannelIds({ channels: 3, layout: '' })).toEqual(['c0', 'c1', 'c2']);
    expect(streamChannelIds({ channels: 6, layout: '5.1' })).toEqual(['FL', 'FR', 'FC', 'LFE', 'BL', 'BR']);
  });
});
