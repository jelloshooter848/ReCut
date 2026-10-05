/**
 * Builds a LARGE synthetic ReCut project through the store API.
 *
 * Plain JS with no imports so the same function runs under vitest (node) and inside the Electron renderer
 * (its source is injected with page.evaluate, which bypasses the renderer CSP). `store` is the zustand store
 * (useStore); `baseMedia` is a list of already-probed media descriptors to clone from.
 *
 * Defaults match docs/attack/performance.md: 60 media, 3000 detected scenes, 8000 cues / 30 subtitle tracks,
 * 400 scene records, one 2500-clip sequence (4V + 4A, 300 transitions, 200 markers) and 10 alternates with snapshots.
 */
export function buildBigProject(store, baseMedia, opts) {
  const o = Object.assign({
    mediaCount: 60, scenesTotal: 3000, cueTracks: 30, cuesTotal: 8000, sceneRecords: 400,
    clips: 2500, videoTracks: 4, audioTracks: 4, transitions: 300, markers: 200, altSequences: 10,
    clipFrames: 120, fps: { num: 24, den: 1 }, label: 'perf',
  }, opts || {});
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const timings = {};
  const time = (name, fn) => { const t = now(); const r = fn(); timings[name] = Math.round((now() - t) * 100) / 100; return r; };
  const st = () => store.getState();
  const P = o.label;
  const WORDS = ['the', 'ship', 'is', 'ready', 'captain', 'we', 'must', 'find', 'temple', 'hold', 'line', 'dawn', 'father', 'station', 'doctor', 'airlock', 'alone', 'secret', 'tide', 'dark', 'engines', 'failed', 'hope', 'rises', 'open'];
  const sentence = (i) => {
    const n = 4 + (i % 6); const out = [];
    for (let k = 0; k < n; k++) out.push(WORDS[(i * 7 + k * 3) % WORDS.length]);
    return out.join(' ') + (i % 3 === 0 ? '.' : i % 3 === 1 ? '!' : '?');
  };

  // ---- 1. media (one commit) ----
  const mediaIds = [];
  time('addMedia', () => {
    const items = [];
    for (let i = 0; i < o.mediaCount; i++) {
      const base = baseMedia[i % baseMedia.length];
      const id = `med_${P}_${i}`;
      mediaIds.push(id);
      const series = `Series ${i % 6}`;
      items.push({
        id, name: `${series} S${String(1 + Math.floor(i / 12) % 3).padStart(2, '0')}E${String((i % 12) + 1).padStart(2, '0')} ${base.name}`,
        path: base.path, kind: base.probe && !base.probe.video ? 'audio' : 'video', category: 'Episode',
        identity: { series, season: 1 + Math.floor(i / 12) % 3, episode: (i % 12) + 1, title: `Episode ${i}` },
        binId: 'bin-tv', probe: base.probe, offline: false, proxy: { status: 'none' }, detectedScenes: [], subtitleTrackIds: [],
        notes: `notes for item ${i}`, tags: i % 5 === 0 ? ['favorite'] : [], addedAt: Date.now() - i * 1000,
        preferredAudioStream: base.probe && base.probe.audio && base.probe.audio[0] ? base.probe.audio[0].index : undefined,
      });
    }
    st().addMedia(items);
  });

  // ---- 2. detected scenes ----
  time('detectedScenes', () => {
    const per = Math.max(1, Math.round(o.scenesTotal / o.mediaCount));
    for (let i = 0; i < o.mediaCount; i++) {
      const m = st().project.media[mediaIds[i]];
      const dur = (m.probe && m.probe.duration) || 60;
      const b = [];
      for (let k = 1; k < per; k++) b.push(Math.round((dur * k / per) * 1000) / 1000);
      st().setDetectedScenes(mediaIds[i], b, dur);
    }
  });

  // ---- 3. media subtitle tracks (cueTracks commits) ----
  const subtitleTrackIds = [];
  time('subtitleTracks', () => {
    const per = Math.ceil(o.cuesTotal / o.cueTracks);
    for (let t = 0; t < o.cueTracks; t++) {
      const mediaId = mediaIds[t % o.mediaCount];
      const m = st().project.media[mediaId];
      const dur = (m.probe && m.probe.duration) || 60;
      const cues = [];
      for (let k = 0; k < per && cues.length + t * per < o.cuesTotal; k++) {
        const start = (dur * k) / per; const end = Math.min(dur, start + (dur / per) * 0.9);
        cues.push({ id: `cue_${P}_${t}_${k}`, start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, text: sentence(t * per + k) });
      }
      const id = `sub_${P}_${t}`;
      subtitleTrackIds.push(id);
      st().addMediaSubtitleTrack({ id, name: `track ${t}.srt`, language: t % 2 ? 'en' : 'fr', mediaId, cues, origin: 'srt' });
    }
  });

  // ---- 4. scene library records (one commit) ----
  time('sceneRecords', () => {
    st().commit(`Add ${o.sceneRecords} scenes`, (d) => {
      for (let i = 0; i < o.sceneRecords; i++) {
        const mediaId = mediaIds[i % o.mediaCount];
        const m = d.media[mediaId]; const dur = (m.probe && m.probe.duration) || 60;
        const inS = (dur * (i % 10)) / 10; const outS = Math.min(dur, inS + dur / 10);
        const chars = [WORDS[i % 7], WORDS[(i + 3) % 7]];
        d.scenes[`scn_${P}_${i}`] = {
          id: `scn_${P}_${i}`, name: `Scene ${i} ${sentence(i)}`, mediaId, in: inS, out: outS, characters: chars,
          location: `Location ${i % 9}`, arc: `Arc ${i % 5}`, tags: i % 4 === 0 ? ['action'] : ['dialogue'], notes: sentence(i + 11),
          rating: i % 6, color: '#4d7cfe', createdAt: Date.now() - i,
        };
        for (const c of chars) if (!d.tags.characters.includes(c)) d.tags.characters.push(c);
      }
    });
  });

  // ---- 5. the big sequence (one commit) ----
  const seqId = `seq_${P}_big`;
  const mkTrack = (kind, i) => ({ id: `${kind === 'video' ? 'v' : 'a'}_${P}_${i}`, name: `${kind === 'video' ? 'V' : 'A'}${i + 1}`, kind, clips: [], transitions: [], muted: false, solo: false, locked: false, height: kind === 'video' ? 64 : 48, volume: 1, patched: i === 0 });
  const mkClip = (id, mediaId, name, kind, start, duration, sourceIn, linkId, audioStream) => ({
    id, mediaId, name, start, duration, sourceIn, speed: 1, linkId, enabled: true, kind, audioStream,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, crop: { left: 0, top: 0, right: 0, bottom: 0 } },
    audio: { gain: 0, volume: 1, fadeIn: 0, fadeOut: 0, muted: false },
    tags: [], characters: [], plotlines: [], locations: [], notes: '',
  });
  let seqDuration = 0;
  time('bigSequence', () => {
    const video = []; const audio = [];
    for (let i = 0; i < o.videoTracks; i++) video.push(mkTrack('video', i));
    for (let i = 0; i < o.audioTracks; i++) audio.push(mkTrack('audio', i));
    const pairs = Math.floor(o.clips / 2);
    const perTrack = Math.ceil(pairs / Math.max(o.videoTracks, 1));
    let n = 0;
    for (let p = 0; p < pairs; p++) {
      const ti = Math.floor(p / perTrack) % o.videoTracks; const slot = p % perTrack;
      const mediaId = mediaIds[p % o.mediaCount];
      const m = st().project.media[mediaId]; const dur = (m.probe && m.probe.duration) || 60;
      const start = slot * o.clipFrames;
      const sourceIn = Math.round(((p * 7) % Math.max(1, Math.floor(dur - o.clipFrames * o.fps.den / o.fps.num))) * 100) / 100;
      const link = `link_${P}_${p}`;
      const name = `Clip ${p} ${m.name}`;
      video[ti].clips.push(mkClip(`clip_${P}_${n++}`, mediaId, name, 'video', start, o.clipFrames, sourceIn, link, undefined));
      audio[ti % o.audioTracks].clips.push(mkClip(`clip_${P}_${n++}`, mediaId, name, 'audio', start, o.clipFrames, sourceIn, link, m.preferredAudioStream));
      seqDuration = Math.max(seqDuration, start + o.clipFrames);
    }
    // transitions on adjacent cuts, alternating video / audio tracks
    let made = 0;
    const tracks = [...video, ...audio];
    for (let k = 0; made < o.transitions && k < 100000; k++) {
      const t = tracks[k % tracks.length]; const idx = (Math.floor(k / tracks.length) * 3 + 1) % Math.max(1, t.clips.length - 1);
      const a = t.clips[idx], b = t.clips[idx + 1];
      if (!a || !b || a.start + a.duration !== b.start) continue;
      if (t.transitions.some((tr) => tr.outClipId === a.id || tr.inClipId === b.id)) continue;
      t.transitions.push({ id: `tr_${P}_${made}`, type: t.kind === 'audio' ? 'audioCrossfade' : (made % 2 ? 'dipToBlack' : 'crossDissolve'), duration: 24, outClipId: a.id, inClipId: b.id });
      made++;
    }
    const markers = [];
    for (let i = 0; i < o.markers; i++) markers.push({ id: `mk_${P}_${i}`, time: Math.floor((seqDuration * i) / o.markers), duration: i % 4 === 0 ? 48 : 0, name: `Marker ${i}`, note: sentence(i), color: '#4d7cfe', kind: i % 5 === 0 ? 'continuity' : 'marker', category: i % 5 === 0 ? 'wardrobe' : undefined, resolved: false });
    const t0 = Date.now();
    st().addSequence({
      id: seqId, name: `Big ${o.clips} clips`, fps: o.fps, width: 1920, height: 1080, sampleRate: 48000, channels: 2,
      videoTracks: video, audioTracks: audio, subtitleTracks: [], markers, storyBlocks: [], snapshots: [],
      createdAt: t0, modifiedAt: t0, binId: null, view: { playhead: 0, zoom: 4, scroll: 0, inPoint: null, outPoint: null },
    });
  });

  // ---- 6. alternates + snapshots ----
  const altIds = [];
  const altTimes = []; const snapTimes = [];
  time('alternates', () => {
    for (let i = 0; i < o.altSequences; i++) {
      let t = now(); const id = st().duplicateSequence(seqId, `Alt ${i + 1}`); altTimes.push(Math.round((now() - t) * 100) / 100);
      altIds.push(id);
      t = now(); st().takeSnapshot(id, `snap ${i + 1}`); snapTimes.push(Math.round((now() - t) * 100) / 100);
    }
    st().setActiveSequence(seqId);
  });
  timings.duplicateSequenceEach = altTimes; timings.takeSnapshotEach = snapTimes;

  const seq = st().project.sequences[seqId];
  const counts = {
    media: Object.keys(st().project.media).length,
    detectedScenes: Object.values(st().project.media).reduce((a, m) => a + m.detectedScenes.length, 0),
    cues: Object.values(st().project.subtitleTracks).reduce((a, t) => a + t.cues.length, 0),
    subtitleTracks: Object.keys(st().project.subtitleTracks).length,
    sceneRecords: Object.keys(st().project.scenes).length,
    clips: [...seq.videoTracks, ...seq.audioTracks].reduce((a, t) => a + t.clips.length, 0),
    transitions: [...seq.videoTracks, ...seq.audioTracks].reduce((a, t) => a + t.transitions.length, 0),
    markers: seq.markers.length,
    sequences: Object.keys(st().project.sequences).length,
    historyDepth: st().history.past.length,
    seqDurationFrames: seqDuration,
  };
  return { seqId, altIds, mediaIds, subtitleTrackIds, timings, counts };
}
