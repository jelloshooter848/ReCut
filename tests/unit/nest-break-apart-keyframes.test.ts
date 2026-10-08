/** Break Apart Compound Clip keeps keyframed picture and level (Roadmap §8 x §11): the copies play what the nested clip played. */
import { it, expect } from 'vitest';
import type { Clip, ID, MediaItem, Sequence } from '../../shared/model';
import { createSequence } from '../../shared/project';
import { defaultAudio, defaultTransform } from '../../shared/timeline';
import { flattenSequence, breakApartCompoundClip } from '../../shared/nest';
import { planFrame } from '../../src/playback/planner';
const R24 = { num: 24, den: 1 };
function media(id: string): MediaItem { return { id, name: id, path: `/m/${id}.mp4`, kind: 'video', category: 'Movie', identity: {}, binId: null, probe: { container: 'mov', duration: 600, size: 1, audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000 }], subtitles: [], startTime: 0, browserPlayable: true, video: { index: 0, codec: 'h264', width: 1920, height: 1080, fps: R24, avgFps: R24, isVfr: false } }, offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [], notes: '', tags: [], addedAt: 0 } as MediaItem; }
const MEDIA: Record<ID, MediaItem> = { A: media('A') };
const clip = (id: string, m: string, start: number, duration: number, sourceIn: number, over: Partial<Clip> = {}): Clip => ({ id, mediaId: m, name: id, start, duration, sourceIn, speed: 1, linkId: null, enabled: true, kind: 'video', transform: defaultTransform(), audio: defaultAudio(), tags: [], characters: [], plotlines: [], locations: [], notes: '', ...over });
it('break apart keeps the keyed picture and level', () => {
  const I = createSequence('I', R24, 1920, 1080); I.id = 'I';
  I.videoTracks[0].clips.push(clip('a', 'A', 6, 90, 10, { transform: { ...defaultTransform(), x: 50, keyframes: { opacity: [{ frame: 10, value: 1 }, { frame: 40, value: 0.2 }], scale: [{ frame: 0, value: 0.5 }, { frame: 80, value: 1.5 }] } } }));
  I.audioTracks[0].clips.push(clip('aa', 'A', 6, 90, 10, { kind: 'audio', audio: { ...defaultAudio(), keyframes: { volume: [{ frame: 0, value: 1 }, { frame: 40, value: 0.2 }] } } }));
  I.audioTracks[0].volume = 0.5;
  const O = createSequence('O', R24, 1920, 1080); O.id = 'O';
  O.videoTracks[0].clips.push(clip('N', 'I', 10, 60, 0.5, { sequenceId: 'I', transform: { ...defaultTransform(), keyframes: { x: [{ frame: 0, value: -100 }, { frame: 30, value: 200, interp: 'ease' }], scale: [{ frame: 5, value: 1 }, { frame: 50, value: 0.5 }] } } }));
  O.audioTracks[0].clips.push(clip('Na', 'I', 10, 60, 0.5, { sequenceId: 'I', kind: 'audio', audio: { ...defaultAudio(), volume: 0.8, keyframes: { volume: [{ frame: 0, value: 1 }, { frame: 30, value: 2, interp: 'ease' }] } } }));
  const seqs: Record<ID, Sequence> = { I, O };
  const flat = flattenSequence(O, seqs, MEDIA);
  const before = Array.from({ length: 60 }, (_, i) => planFrame(flat, MEDIA, 10 + i, false));
  const O2 = JSON.parse(JSON.stringify(O)) as Sequence;
  for (const id of ['N', 'Na']) { const r = breakApartCompoundClip(O2, id, seqs, MEDIA); if (O2.videoTracks.concat(O2.audioTracks).some((t) => t.clips.some((c) => c.id === id))) expect(r.ok).toBe(true); }
  for (let i = 0; i < 60; i++) {
    const a = planFrame(O2, MEDIA, 10 + i, false);
    const L0 = before[i].layers[0], L1 = a.layers[0];
    for (const p of ['x', 'y', 'scale', 'opacity'] as const) expect(L1.transform[p], `${p}@${i}`).toBeCloseTo(L0.transform[p], 6);
    expect(a.audio[0].gain * a.audio[0].trackVolume, `v@${i}`).toBeCloseTo(before[i].audio[0].gain * before[i].audio[0].trackVolume, 6);
  }
});
