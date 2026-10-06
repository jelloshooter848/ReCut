/**
 * Builds a LARGE synthetic ReCut project through the store API.
 *
 * Plain JS with no imports so the same function runs under vitest (node) and inside the Electron renderer
 * (its source is injected with page.evaluate, which bypasses the renderer CSP). `store` is the zustand store
 * (useStore); `baseMedia` is a list of already-probed media descriptors to clone from.
 *
 * Defaults match docs/attack/performance.md: 60 media, 3000 detected scenes, 8000 cues / 30 subtitle tracks,
 * 400 scene records, one 2500-clip sequence (4V + 4A, 300 transitions, 200 markers) and 10 alternates with snapshots.
 * buildLongSequence (below) adds a separate 3 h multi-hour sequence on top; benches call it after their existing rows.
 * The Electron harness strips every `export ` and injects both functions into the renderer.
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

/**
 * Adds one MULTI-HOUR sequence to a project already built by buildBigProject (one commit, not activated), so the
 * 2,500-clip sequence and every row measured on it stay unchanged. Call it after the existing measurements.
 *
 * Defaults: 3 h at 23.976 fps (258,941 frames). V1 is a continuous cut of shots 1.5–9.5 s long (skewed short,
 * mean ~4 s, clamped to the source length) with linked A1 audio; every ~18th shot gets a linked 2–5 s insert on
 * V2 / A2; A3 carries unlinked music beds (up to 4 min, clamped to the source) with short gaps. 240 transitions on
 * V1 / A1 cuts (cross dissolve / dip to black, audio crossfades), a marker every 2 min, a chapter marker every
 * 15 min and a continuity note every 10 min. Deterministic (seeded PRNG): the same options give the same sequence.
 */
export function buildLongSequence(store, opts) {
  const o = Object.assign({
    hours: 3, fps: { num: 24000, den: 1001 }, label: 'long', mediaIds: null,
    minShotSec: 1.5, maxShotSec: 9.5, insertEvery: 18, transitions: 240,
    markerEverySec: 120, chapterEverySec: 900, continuityEverySec: 600, seed: 1234567,
  }, opts || {});
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const st = () => store.getState();
  const P = o.label;
  const t0 = now();
  let seed = o.seed >>> 0;
  const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const fps = o.fps.num / o.fps.den;
  const sec2f = (s) => Math.max(1, Math.round(s * fps));
  const totalFrames = Math.round(o.hours * 3600 * fps);
  const media = st().project.media;
  const ids = (o.mediaIds || Object.keys(media)).filter((id) => media[id] && media[id].probe && media[id].probe.video);
  if (!ids.length) throw new Error('buildLongSequence: no video media in the project');
  const durOf = (id) => (media[id].probe && media[id].probe.duration) || 60;
  const audioOf = (id) => { const a = media[id].probe && media[id].probe.audio && media[id].probe.audio[0]; return media[id].preferredAudioStream ?? (a ? a.index : undefined); };
  const mkTrack = (kind, i) => ({ id: `${kind === 'video' ? 'v' : 'a'}_${P}_${i}`, name: `${kind === 'video' ? 'V' : 'A'}${i + 1}`, kind, clips: [], transitions: [], muted: false, solo: false, locked: false, height: kind === 'video' ? 64 : 48, volume: 1, patched: i === 0 });
  const mkClip = (id, mediaId, name, kind, start, duration, sourceIn, linkId, audioStream) => ({
    id, mediaId, name, start, duration, sourceIn, speed: 1, linkId, enabled: true, kind, audioStream,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, crop: { left: 0, top: 0, right: 0, bottom: 0 } },
    audio: { gain: 0, volume: 1, fadeIn: 0, fadeOut: 0, muted: false },
    tags: [], characters: [], plotlines: [], locations: [], notes: '',
  });
  /** A shot of `wantSec` seconds from `mediaId`, clamped so it leaves >= 0.5 s of handle on both sides of the source. */
  const shot = (mediaId, wantSec) => {
    const dur = durOf(mediaId);
    const lenSec = Math.max(1 / fps, Math.min(wantSec, dur - 1));
    const room = Math.max(0, dur - lenSec - 1);
    return { frames: sec2f(lenSec), sourceIn: Math.round((0.5 + rnd() * room) * 1000) / 1000 };
  };
  const v = [mkTrack('video', 0), mkTrack('video', 1)];
  const a = [mkTrack('audio', 0), mkTrack('audio', 1), mkTrack('audio', 2)];
  let n = 0; let p = 0; let f = 0;
  while (f < totalFrames) {
    const mediaId = ids[Math.floor(rnd() * ids.length)];
    const want = o.minShotSec + (o.maxShotSec - o.minShotSec) * rnd() * rnd();
    const s = shot(mediaId, want);
    const frames = Math.min(s.frames, totalFrames - f);
    const link = `link_${P}_${p}`; const name = `Shot ${p} ${media[mediaId].name}`;
    v[0].clips.push(mkClip(`clip_${P}_${n++}`, mediaId, name, 'video', f, frames, s.sourceIn, link, undefined));
    a[0].clips.push(mkClip(`clip_${P}_${n++}`, mediaId, name, 'audio', f, frames, s.sourceIn, link, audioOf(mediaId)));
    if (p % o.insertEvery === o.insertEvery - 1 && frames > sec2f(1)) {
      const im = ids[Math.floor(rnd() * ids.length)];
      const is = shot(im, 2 + 3 * rnd());
      const ifr = Math.min(is.frames, frames);
      const il = `link_${P}_ins_${p}`; const iname = `Insert ${p} ${media[im].name}`;
      v[1].clips.push(mkClip(`clip_${P}_${n++}`, im, iname, 'video', f, ifr, is.sourceIn, il, undefined));
      a[1].clips.push(mkClip(`clip_${P}_${n++}`, im, iname, 'audio', f, ifr, is.sourceIn, il, audioOf(im)));
    }
    f += frames; p++;
  }
  // Music beds on A3: up to 4 min each (clamped to the source), 0–20 s gaps.
  let mf = sec2f(5 * rnd()); let beds = 0;
  while (mf < totalFrames - sec2f(10)) {
    const mm = ids[Math.floor(rnd() * ids.length)];
    const bs = shot(mm, 90 + 150 * rnd());
    const frames = Math.min(bs.frames, totalFrames - mf);
    a[2].clips.push(mkClip(`clip_${P}_${n++}`, mm, `Music ${beds} ${media[mm].name}`, 'audio', mf, frames, bs.sourceIn, null, audioOf(mm)));
    mf += frames + sec2f(20 * rnd()); beds++;
  }
  // Transitions on evenly spaced V1 cuts with the matching A1 crossfade (the cut is contiguous on both tracks).
  const cuts = v[0].clips.length - 1; let made = 0;
  const every = Math.max(1, Math.floor(cuts / Math.max(1, o.transitions)));
  for (let i = every - 1; i < cuts && made < o.transitions; i += every) {
    const va = v[0].clips[i], vb = v[0].clips[i + 1];
    if (va.start + va.duration !== vb.start) continue;
    const d = Math.min(va.duration, vb.duration, 12 + Math.floor(rnd() * 13));
    if (d < 4) continue;
    v[0].transitions.push({ id: `tr_${P}_v${made}`, type: made % 3 === 2 ? 'dipToBlack' : 'crossDissolve', duration: d, outClipId: va.id, inClipId: vb.id });
    const aa = a[0].clips[i], ab = a[0].clips[i + 1];
    a[0].transitions.push({ id: `tr_${P}_a${made}`, type: 'audioCrossfade', duration: d, outClipId: aa.id, inClipId: ab.id });
    made++;
  }
  const markers = [];
  const mk = (i, time, kind, name, extra) => markers.push(Object.assign({ id: `mk_${P}_${i}`, time, duration: 0, name, note: '', color: kind === 'chapter' ? '#f5a524' : kind === 'continuity' ? '#e5484d' : '#4d7cfe', kind, resolved: false }, extra || {}));
  let mi = 0;
  for (let s = o.markerEverySec; sec2f(s) < totalFrames; s += o.markerEverySec) mk(mi++, sec2f(s), 'marker', `Beat ${mi}`, { duration: mi % 4 === 0 ? sec2f(2) : 0 });
  for (let s = 0; sec2f(s) < totalFrames; s += o.chapterEverySec) mk(mi++, sec2f(s), 'chapter', `Chapter ${Math.round(s / o.chapterEverySec) + 1}`);
  for (let s = o.continuityEverySec / 2; sec2f(s) < totalFrames; s += o.continuityEverySec) mk(mi++, sec2f(s), 'continuity', `Continuity ${mi}`, { category: 'wardrobe', note: 'jacket changes between shots' });
  markers.sort((x, y) => x.time - y.time);
  const seqId = `seq_${P}_multihour`;
  const tc = Date.now();
  const tBuild = now() - t0;
  const t1 = now();
  st().addSequence({
    id: seqId, name: `Multi-hour ${o.hours} h`, fps: o.fps, width: 1920, height: 1080, sampleRate: 48000, channels: 2,
    videoTracks: v, audioTracks: a, subtitleTracks: [], markers, storyBlocks: [], snapshots: [],
    createdAt: tc, modifiedAt: tc, binId: null, view: { playhead: 0, zoom: 1, scroll: 0, inPoint: null, outPoint: null },
  }, { activate: false });
  const timings = { buildData: Math.round(tBuild * 100) / 100, addSequenceCommit: Math.round((now() - t1) * 100) / 100 };
  const seq = st().project.sequences[seqId];
  const tracks = [...seq.videoTracks, ...seq.audioTracks];
  let end = 0; for (const t of tracks) for (const c of t.clips) end = Math.max(end, c.start + c.duration);
  const counts = {
    clips: tracks.reduce((s, t) => s + t.clips.length, 0),
    clipsPerTrack: tracks.map((t) => t.clips.length).join(' / '),
    transitions: tracks.reduce((s, t) => s + t.transitions.length, 0),
    markers: seq.markers.length,
    durationFrames: end,
    durationHours: Math.round((end / fps / 3600) * 1000) / 1000,
  };
  return { seqId, timings, counts };
}
