/**
 * #112 / #125: transcripts read live from the media into T lanes, the on-screen transcript (top visible clip, falling
 * through), and the clean-up of the copies older builds put into sequence subtitle tracks.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createMediaItem, createProject, createSequence } from '../../shared/project';
import { defaultAudio, defaultTransform } from '../../shared/timeline';
import {
  clipTranscriptCues, clipTranscriptTrack, cuesAt, onScreenTranscript, onScreenTranscriptAt, onScreenTranscriptClip, transcriptIndex, withoutCopiedTranscripts,
} from '../../shared/transcripts';
import { layoutTracks, TRANSCRIPT_COLLAPSED_PX, TRANSCRIPT_LANE_PX } from '../../src/panels/timeline/viewMath';
import { useStore, resetStore } from '../../src/state/store';
import type { Clip, MediaItem, Sequence, SubtitleTrack } from '../../shared/model';

const FPS = { num: 10, den: 1 }; // 10 fps: frame = seconds × 10

function media(name: string, streams = [1]): MediaItem {
  return {
    ...createMediaItem(`/m/${name}`, name), kind: 'video',
    probe: { container: 'mp4', duration: 100, size: 1, startTime: 0, browserPlayable: true, subtitles: [],
      video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: FPS, avgFps: FPS, isVfr: false },
      audio: streams.map((index) => ({ index, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 })) },
  };
}
function whisper(id: string, m: MediaItem, cues: [number, number, string][], streamIndex = 1): SubtitleTrack {
  m.subtitleTrackIds.push(id);
  return { id, name: 'English (Whisper)', language: 'eng', mediaId: m.id, origin: 'whisper', streamIndex,
    cues: cues.map(([start, end, text], i) => ({ id: `${id}c${i}`, start, end, text, words: [{ start, end, text }] })) };
}
function clip(id: string, m: MediaItem, kind: 'video' | 'audio', start: number, duration: number, sourceIn: number, linkId: string | null, extra: Partial<Clip> = {}): Clip {
  return {
    id, mediaId: m.id, name: id, kind, start, duration, sourceIn, speed: 1, linkId, enabled: true,
    transform: defaultTransform(), audio: defaultAudio(), tags: [], characters: [], plotlines: [], locations: [], notes: '',
    ...(kind === 'audio' ? { audioStream: 1 } : {}), ...extra,
  };
}

/** V1/A1: interview 0-100 frames; V2/A2: a cutaway 30-60 frames. */
function scene(opts: { cutawayTranscript: boolean }) {
  const interview = media('interview.mp4');
  const cutaway = media('cutaway.mp4');
  const tracks: Record<string, SubtitleTrack> = {
    wi: whisper('wi', interview, [[0, 2, 'hello there'], [3, 6, 'we built a monitor'], [7, 9, 'the end']]),
    ...(opts.cutawayTranscript ? { wc: whisper('wc', cutaway, [[1, 2, 'look at this']]) } : {}),
  };
  const seq = createSequence('S', FPS);
  seq.videoTracks[0].clips.push(clip('v1', interview, 'video', 0, 100, 0, 'L1'));
  seq.audioTracks[0].clips.push(clip('a1', interview, 'audio', 0, 100, 0, 'L1'));
  seq.videoTracks[1].clips.push(clip('v2', cutaway, 'video', 30, 30, 0, 'L2'));
  seq.audioTracks[1].clips.push(clip('a2', cutaway, 'audio', 30, 30, 0, 'L2'));
  return { seq, media: { [interview.id]: interview, [cutaway.id]: cutaway }, tracks, interview, cutaway };
}

describe('clip transcripts', () => {
  it('uses the Whisper track of the clip\'s audio stream, the latest when there are several', () => {
    const m = media('two-streams.mp4', [1, 2]);
    const t1 = whisper('t1', m, [[0, 1, 'one']], 1);
    const t2 = whisper('t2', m, [[0, 1, 'two']], 2);
    const t2b = whisper('t2b', m, [[0, 1, 'deux']], 2);
    const tracks = { t1, t2, t2b };
    expect(clipTranscriptTrack(clip('a', m, 'audio', 0, 10, 0, null, { audioStream: 1 }), m, tracks)?.id).toBe('t1');
    expect(clipTranscriptTrack(clip('a', m, 'audio', 0, 10, 0, null, { audioStream: 2 }), m, tracks)?.id).toBe('t2b');
    expect(clipTranscriptTrack(clip('a', m, 'audio', 0, 10, 0, null, { audioStream: 3 }), m, tracks)).toBeNull();
  });

  it('maps the clip\'s source range to frames, words included, through trims and speed', () => {
    const m = media('x.mp4');
    const t = whisper('t', m, [[1, 2, 'before'], [5, 7, 'inside'], [9.5, 11, 'across the end']]);
    // Source 4-10 s at 2× speed: 3 s on the timeline from frame 100.
    const cues = clipTranscriptCues(clip('a', m, 'audio', 100, 30, 4, null, { speed: 2 }), t, FPS);
    expect(cues.map((c) => [c.text, c.start, c.end])).toEqual([['inside', 105, 115], ['across the end', 128, 130]]);
    expect(cues[0].words).toEqual([{ start: 105, end: 115, text: 'inside' }]);
    expect(cues[0].id).toBe('a:tc1');
  });

  it('builds a T lane per audio track with transcribed clips', () => {
    const { seq, media: md, tracks } = scene({ cutawayTranscript: false });
    const idx = transcriptIndex(seq, md, tracks);
    expect([...idx.lanes.keys()]).toEqual([seq.audioTracks[0].id]);
    expect(idx.lanes.get(seq.audioTracks[0].id)!.map((c) => c.text)).toEqual(['hello there', 'we built a monitor', 'the end']);
  });

  it('a transcript added after the clip was inserted shows at once (nothing is copied)', () => {
    const { seq, media: md, tracks, cutaway } = scene({ cutawayTranscript: false });
    expect(transcriptIndex(seq, md, tracks).byClip.has('a2')).toBe(false);
    const later = { ...tracks, wc: whisper('wc', cutaway, [[1, 2, 'look at this']]) };
    expect(transcriptIndex(seq, md, later).byClip.get('a2')!.map((c) => c.text)).toEqual(['look at this']);
  });
});

describe('the on-screen transcript', () => {
  it('follows the top visible clip: the cutaway\'s words while it is on screen, the interview\'s otherwise', () => {
    const { seq, media: md, tracks } = scene({ cutawayTranscript: true });
    const idx = transcriptIndex(seq, md, tracks);
    expect(onScreenTranscriptAt(seq, idx, 5).map((c) => c.text)).toEqual(['hello there']);
    expect(onScreenTranscriptClip(seq, idx, 35)).toBe('a2');
    expect(onScreenTranscriptAt(seq, idx, 45).map((c) => c.text)).toEqual(['look at this']);
    // While the cutaway owns the screen, its pause shows nothing (not the interview's words underneath).
    expect(onScreenTranscriptAt(seq, idx, 55)).toEqual([]);
    expect(onScreenTranscriptAt(seq, idx, 75).map((c) => c.text)).toEqual(['the end']);
  });

  it('falls through a cutaway without a transcript to the dialogue below', () => {
    const { seq, media: md, tracks } = scene({ cutawayTranscript: false });
    const idx = transcriptIndex(seq, md, tracks);
    expect(onScreenTranscriptAt(seq, idx, 40).map((c) => c.text)).toEqual(['we built a monitor']);
  });

  it('falls through when the top clip is not heard (muted track, muted clip, another track soloed) or hidden', () => {
    for (const mute of [
      (s: Sequence) => { s.audioTracks[1].muted = true; },
      (s: Sequence) => { s.audioTracks[1].clips[0].audio = { ...defaultAudio(), muted: true }; },
      (s: Sequence) => { s.audioTracks[0].solo = true; },
      (s: Sequence) => { s.videoTracks[1].muted = true; },
      (s: Sequence) => { s.videoTracks[1].clips[0].enabled = false; },
    ]) {
      const { seq, media: md, tracks } = scene({ cutawayTranscript: true });
      mute(seq);
      expect(onScreenTranscriptClip(seq, transcriptIndex(seq, md, tracks), 45)).toBe('a1');
    }
  });

  it('with no video on screen, an audio-only clip\'s transcript is used', () => {
    const { seq, media: md, tracks, interview } = scene({ cutawayTranscript: false });
    seq.videoTracks[0].clips = [];
    seq.audioTracks[0].clips = [clip('vo', interview, 'audio', 0, 100, 0, null)];
    expect(onScreenTranscriptAt(seq, transcriptIndex(seq, md, tracks), 5).map((c) => c.text)).toEqual(['hello there']);
  });
});

describe('the Subtitles row (#126): the whole on-screen transcript', () => {
  it('matches the per-frame on-screen rule at every frame', () => {
    for (const cutawayTranscript of [true, false]) {
      const { seq, media: md, tracks } = scene({ cutawayTranscript });
      seq.audioTracks[1].clips[0].audio = { ...defaultAudio(), muted: !cutawayTranscript }; // a second variant: a muted cutaway
      const idx = transcriptIndex(seq, md, tracks);
      const row = onScreenTranscript(seq, idx);
      for (let f = 0; f < 110; f++) {
        expect(cuesAt(row, f).map((c) => c.text), `frame ${f}`).toEqual(onScreenTranscriptAt(seq, idx, f).map((c) => c.text));
      }
    }
  });

  it('switches between the clips at the cut and back, cutting a cue that spans the cutaway', () => {
    const { seq, media: md, tracks } = scene({ cutawayTranscript: true });
    const row = onScreenTranscript(seq, transcriptIndex(seq, md, tracks));
    expect(row.map((c) => [c.text, c.start, c.end])).toEqual([
      ['hello there', 0, 20], ['look at this', 40, 50], ['the end', 70, 90],
    ]);
  });

  it('joins a cue cut by a clip edge that does not change the owner, keeping all its words', () => {
    const { seq, media: md, interview } = scene({ cutawayTranscript: false });
    seq.videoTracks[1].clips = []; seq.audioTracks[1].clips = [];
    seq.audioTracks[2].clips.push(clip('music', md[Object.keys(md)[1]], 'audio', 40, 10, 0, null)); // an edge at 40 and 50
    const t = whisper('w2', interview, [[3, 6, 'we built a monitor']]);
    t.cues[0].words = [{ start: 3, end: 4, text: 'we' }, { start: 4.5, end: 5, text: 'built' }, { start: 5.2, end: 6, text: 'a monitor' }];
    const row = onScreenTranscript(seq, transcriptIndex(seq, md, { w2: t }));
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ start: 30, end: 60, text: 'we built a monitor' });
    expect(row[0].words!.map((w) => w.text)).toEqual(['we', 'built', 'a monitor']);
  });
});

describe('copies from older builds', () => {
  it('removes sequence cues that exactly match the clip\'s Whisper transcript, keeps the rest', () => {
    const { seq, media: md, tracks } = scene({ cutawayTranscript: false });
    seq.subtitleTracks.push(
      { id: 'copied', name: 'eng', language: 'eng', enabled: true, cues: [
        { id: 's1', clipId: 'v1', srcStart: 0, srcEnd: 2, start: 0, duration: 20, offset: 0, text: 'hello there' },
        { id: 's2', clipId: 'v1', srcStart: 3, srcEnd: 6, start: 30, duration: 30, offset: 0, text: 'we built a monitor' },
      ] },
      { id: 'mixed', name: 'eng', language: 'eng', enabled: true, cues: [
        { id: 's3', clipId: 'v1', srcStart: 7, srcEnd: 9, start: 70, duration: 20, offset: 0, text: 'the end' },
        { id: 's4', clipId: 'v1', srcStart: 7, srcEnd: 9, start: 70, duration: 20, offset: 0, text: 'THE END (edited)' },
        { id: 's5', start: 90, duration: 5, offset: 0, text: 'a free cue' },
      ] },
    );
    const p = { ...createProject('P'), media: md, subtitleTracks: tracks, sequences: { [seq.id]: seq }, sequenceOrder: [seq.id], activeSequenceId: seq.id };
    const out = withoutCopiedTranscripts(p);
    expect(out.sequences[seq.id].subtitleTracks.map((t) => [t.id, t.cues.map((c) => c.id)])).toEqual([['mixed', ['s4', 's5']]]);
    expect(withoutCopiedTranscripts(out)).toBe(out);
  });
});

describe('store', () => {
  beforeEach(() => resetStore());
  it('inserting a clip no longer copies its Whisper transcript into the sequence; loading drops old copies', () => {
    const S = useStore.getState;
    const m = media('talk.mp4');
    S().addMedia([m]);
    S().putWhisperSubtitleTrack({ id: 'w', name: 'English (Whisper)', language: 'eng', mediaId: m.id, origin: 'whisper', streamIndex: 1, cues: [{ id: 'c', start: 1, end: 2, text: 'hi' }] });
    const seq = createSequence('S', FPS);
    S().addSequence(seq);
    S().insertFromSource(seq.id, { mediaId: m.id, in: 0, out: 10, atFrame: 0, mode: 'overwrite' });
    expect(S().project.sequences[seq.id].subtitleTracks).toEqual([]);
    const s = S().project;
    const withCopy = structuredClone(s);
    const vid = withCopy.sequences[seq.id].videoTracks[0].clips[0].id;
    withCopy.sequences[seq.id].subtitleTracks.push({ id: 'x', name: 'eng', language: 'eng', enabled: true,
      cues: [{ id: 'y', clipId: vid, srcStart: 1, srcEnd: 2, start: 10, duration: 10, offset: 0, text: 'hi' }] });
    S().loadProjectData(withCopy, null);
    expect(S().project.sequences[seq.id].subtitleTracks).toEqual([]);
  });
});

describe('timeline layout', () => {
  it('puts a T lane under each audio track with a transcript', () => {
    const V = [{ id: 'v1', height: 60, kind: 'video' as const }];
    const A = [{ id: 'a1', height: 40, kind: 'audio' as const }, { id: 'a2', height: 40, kind: 'audio' as const }];
    const l = layoutTracks(V, A, { transcripts: new Set(['a1']) });
    const a1 = l.rows.find((r) => r.id === 'a1')!;
    const a2 = l.rows.find((r) => r.id === 'a2')!;
    expect(l.transcripts).toEqual([{ trackId: 'a1', index: 0, top: a1.top + 40, height: TRANSCRIPT_LANE_PX, collapsed: false }]);
    expect(a2.top).toBe(a1.top + 40 + TRANSCRIPT_LANE_PX);
    expect(l.total).toBe(a2.top + 40);
  });

  it('a collapsed T lane is a thin row (#132)', () => {
    const V = [{ id: 'v1', height: 60, kind: 'video' as const }];
    const A = [{ id: 'a1', height: 40, kind: 'audio' as const }, { id: 'a2', height: 40, kind: 'audio' as const }];
    const l = layoutTracks(V, A, { transcripts: new Set(['a1']), collapsedTranscripts: { a1: true } });
    const a1 = l.rows.find((r) => r.id === 'a1')!;
    expect(l.transcripts[0]).toMatchObject({ height: TRANSCRIPT_COLLAPSED_PX, collapsed: true });
    expect(l.rows.find((r) => r.id === 'a2')!.top).toBe(a1.top + 40 + TRANSCRIPT_COLLAPSED_PX);
  });
});
