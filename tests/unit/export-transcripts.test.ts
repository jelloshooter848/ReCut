/**
 * #127: "Include transcripts as subtitles" adds the on-screen transcript (what the Subtitles row and the Program
 * monitor show, #126) to an export as a subtitle track named "Transcript". Off by default.
 */
import { describe, it, expect } from 'vitest';
import { createMediaItem, createSequence } from '../../shared/project';
import { defaultAudio, defaultTransform } from '../../shared/timeline';
import { onScreenTranscript, transcriptIndex } from '../../shared/transcripts';
import { buildExportRequest, TRANSCRIPT_EXPORT_TRACK_ID, transcriptExportTrack, withTranscriptTrack } from '../../src/panels/export/request';
import { defaultExportSettings } from '../../src/panels/export/settings';
import { assText, buildBurnInAss } from '../../electron/export/renderGraph';
import type { Clip, MediaItem, SubtitleTrack } from '../../shared/model';

const FPS = { num: 10, den: 1 };

function project() {
  const m: MediaItem = {
    ...createMediaItem('/m/talk.mp4', 'talk.mp4'), kind: 'video', subtitleTrackIds: ['w'],
    probe: { container: 'mp4', duration: 100, size: 1, startTime: 0, browserPlayable: true, subtitles: [],
      video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: FPS, avgFps: FPS, isVfr: false },
      audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }] },
  };
  const w: SubtitleTrack = { id: 'w', name: 'English (Whisper)', language: 'eng', mediaId: m.id, origin: 'whisper', streamIndex: 1,
    cues: [{ id: 'c1', start: 1, end: 2, text: 'um, hello' }, { id: 'c2', start: 3, end: 4, text: 'there' }] };
  const clip = (id: string, kind: 'video' | 'audio'): Clip => ({
    id, mediaId: m.id, name: id, kind, start: 0, duration: 100, sourceIn: 0, speed: 1, linkId: 'L', enabled: true,
    transform: defaultTransform(), audio: defaultAudio(), tags: [], characters: [], plotlines: [], locations: [], notes: '', ...(kind === 'audio' ? { audioStream: 1 } : {}),
  });
  const seq = createSequence('S', FPS);
  seq.videoTracks[0].clips.push(clip('v', 'video'));
  seq.audioTracks[0].clips.push(clip('a', 'audio'));
  return { sources: { media: { [m.id]: m }, subtitleTracks: { w }, sequences: { [seq.id]: seq } }, seq };
}

describe('export: include transcripts (#127)', () => {
  it('the transcript track is the on-screen transcript, in the transcript\'s language', () => {
    const { sources, seq } = project();
    const track = transcriptExportTrack(sources, seq)!;
    expect(track).toMatchObject({ id: TRANSCRIPT_EXPORT_TRACK_ID, name: 'Transcript', language: 'eng', enabled: true });
    const onScreen = onScreenTranscript(seq, transcriptIndex(seq, sources.media, sources.subtitleTracks));
    expect(track.cues.map((c) => [c.start, c.start + c.duration, c.text])).toEqual(onScreen.map((c) => [c.start, c.end, c.text]));
    expect(transcriptExportTrack({ ...sources, subtitleTracks: {} }, seq)).toBeNull();
  });

  it('is off by default: no transcript in the exported subtitles', () => {
    const { sources, seq } = project();
    const settings = defaultExportSettings(seq);
    expect(settings.includeTranscripts).toBeFalsy();
    expect(buildExportRequest(sources, seq, settings).subtitles).toBeUndefined();
  });

  it('when on, burn-in / sidecar get the transcript in seconds, and MKV can mux it as a soft track', () => {
    const { sources, seq } = project();
    const settings = { ...defaultExportSettings(seq), includeTranscripts: true };
    expect(buildExportRequest(sources, seq, settings).subtitles).toEqual([{ start: 1, end: 2, text: 'um, hello' }, { start: 3, end: 4, text: 'there' }]);
    const mkv = { ...settings, container: 'mkv' as const, subtitleOutputs: [{ trackId: TRANSCRIPT_EXPORT_TRACK_ID }] };
    const req = buildExportRequest(sources, seq, mkv);
    expect(req.subtitleTracks?.map((t) => [t.name, t.cues.length])).toEqual([['Transcript', 2]]);
  });

  it('adds the track once, and leaves the sequence alone when off or without a transcript', () => {
    const { sources, seq } = project();
    const once = withTranscriptTrack(sources, seq, { includeTranscripts: true });
    expect(withTranscriptTrack(sources, once, { includeTranscripts: true })).toBe(once);
    expect(withTranscriptTrack(sources, seq, { includeTranscripts: false })).toBe(seq);
    expect(withTranscriptTrack({ ...sources, subtitleTracks: {} }, seq, { includeTranscripts: true })).toBe(seq);
  });
});

describe('burn-in highlighting (#134)', () => {
  it('words reach the request only with Include transcripts and Highlight on', () => {
    const { sources, seq } = project();
    sources.subtitleTracks.w.cues[0].words = [{ start: 1, end: 1.5, text: 'um,' }, { start: 1.5, end: 2, text: 'hello' }];
    const base = { ...defaultExportSettings(seq), includeTranscripts: true, burnSubtitles: true };
    const sub = (over: object) => buildExportRequest(sources, seq, { ...base, ...over }).subtitles![0];
    expect(sub({ highlightWords: false }).words).toBeUndefined();
    expect(sub({ highlightWords: true }).words).toEqual([{ start: 1, end: 1.5, text: 'um,' }, { start: 1.5, end: 2, text: 'hello' }]);
  });

  it('ASS: one event per word span with the active word coloured, timed at frame centres; text escaped', () => {
    const fps = { num: 25, den: 1 };
    const seq = createSequence('S', fps);
    const req = { sequence: seq, media: {}, settings: defaultExportSettings(seq),
      subtitles: [
        { start: 0.2, end: 2, text: 'a {b}', words: [{ start: 0.4, end: 1, text: 'a' }, { start: 1, end: 2, text: '{b}' }] },
        { start: 3, end: 4, text: 'plain\nline' },
      ] };
    const ass = buildBurnInAss(req as never, 0, 200)!;
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    // Frames: cue 5-50, words at 10 and 25. Frame f is shown from (f - 0.5) / 25 s.
    expect(events).toEqual([
      'Dialogue: 0,0:00:00.18,0:00:00.38,Default,,0,0,0,,a \\{b\\}',
      'Dialogue: 0,0:00:00.38,0:00:00.98,Default,,0,0,0,,{\\c&H4DD8FF&}a{\\c} \\{b\\}',
      'Dialogue: 0,0:00:00.98,0:00:01.98,Default,,0,0,0,,a {\\c&H4DD8FF&}\\{b\\}{\\c}',
      'Dialogue: 0,0:00:02.98,0:00:03.98,Default,,0,0,0,,plain\\Nline',
    ]);
    expect(ass.startsWith('[Script Info]')).toBe(true);
    expect(assText('x\\y')).toBe('x\\\\y');
  });
});
