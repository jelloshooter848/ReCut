# ReCut project format (`.recut`)

A ReCut project is a single UTF-8 JSON document. It references source media by absolute path and never
copies media. Derived data (thumbnails, waveforms, proxies, scene-detection caches) lives in the cache
directory (`<userData>/cache` or `$RECUT_CACHE_DIR`) keyed by file path + size + mtime, so a project file
stays small (typically well under 10 MB even for long-form work) and can be put under version control.

The authoritative TypeScript definitions are in `shared/model.ts`; `shared/project.ts` contains
`normalizeProject()`, which repairs/migrates older or partially damaged files on load.

## Top level

| Field | Type | Notes |
|---|---|---|
| `formatVersion` | number | Currently `1`. Files with a higher version are refused. |
| `id`, `name`, `createdAt`, `modifiedAt` | string / ms timestamps | |
| `media` | `Record<ID, MediaItem>` | Imported sources. |
| `bins` | `Record<ID, Bin>` | Hierarchical bins (`parentId`), with `kind` `bin` / `series` / `season` / `collection`. |
| `sequences` | `Record<ID, Sequence>` | Timelines. |
| `sequenceOrder` | `ID[]` | Display order. |
| `scenes` | `Record<ID, SceneRecord>` | Scene library (reusable source ranges). |
| `subtitleTracks` | `Record<ID, SubtitleTrack>` | Imported subtitle/transcript tracks attached to media. |
| `tags` | `TagVocabulary` | Known characters / plotlines / locations / themes / custom tags. |
| `settings` | `ProjectSettings` | Proxies on/off, proxy height, autosave interval, carry-subtitles, scene threshold, snapping, defaults. |
| `activeSequenceId` | `ID \| null` | |

## Time conventions

* **Timeline positions and durations are integer frames** at the owning sequence's frame rate
  (`sequence.fps` is a rational `{num, den}`, e.g. `24000/1001`). This keeps every edit frame-exact.
* **Source positions are seconds** (`clip.sourceIn`, scene boundaries, media subtitle cues), because
  sources have their own frame rates. `clip.speed` is source-seconds consumed per timeline second.
  Source out = `sourceIn + duration * den/num * speed`.

## MediaItem

```jsonc
{
  "id": "med…", "name": "The Empire Strikes Back.mkv", "path": "/Volumes/Film/ESB.mkv",
  "kind": "video", "category": "Movie",
  "identity": { "franchise": "Star Wars", "collection": "Original Trilogy", "title": "The Empire Strikes Back", "year": 1980 },
  "binId": "bin-movies", "offline": false, "fileSize": 123, "fileMtime": 1700000000000,
  "probe": { "container": "matroska", "duration": 7620.1, "startTime": 0, "video": { "codec": "h264", "width": 1920, "height": 1080, "fps": {"num": 24000, "den": 1001}, "isVfr": false },
             "audio": [{ "index": 1, "codec": "ac3", "channels": 6, "layout": "5.1", "sampleRate": 48000, "language": "eng" }],
             "subtitles": [], "browserPlayable": false, "playabilityReason": "audio codec ac3 not supported by Chromium" },
  "proxy": { "status": "ready", "path": "/…/cache/proxies/<key>_540p.mp4", "width": 960, "height": 540 },
  "detectedScenes": [{ "id": "…", "start": 0, "end": 83.2, "name": "Scene 001", "tags": [], "characters": [] }],
  "subtitleTrackIds": ["st…"], "preferredAudioStream": 1, "tags": [], "notes": ""
}
```

TV identity uses `identity.series`, `identity.season`, `identity.episode`. The hierarchy is optional; media
without identity simply lives in bins.

## Sequence

```jsonc
{
  "id": "seq…", "name": "Episode 1 – No Jar Jar", "fps": {"num": 24000, "den": 1001}, "width": 1920, "height": 1080,
  "sampleRate": 48000, "channels": 2,
  "videoTracks": [Track], "audioTracks": [Track],
  "subtitleTracks": [SequenceSubtitleTrack], "markers": [Marker], "storyBlocks": [StoryBlock],
  "snapshots": [{ "id": "…", "name": "before act 2 trim", "createdAt": 0, "data": Sequence-without-snapshots }],
  "parentSequenceId": "seq…", "versionLabel": "v2",
  "view": { "playhead": 1200, "zoom": 2, "scroll": 0, "inPoint": null, "outPoint": null }
}
```

### Track

`{ id, name, kind: 'video'|'audio', clips: Clip[], transitions: Transition[], muted, solo, locked, height, volume, patched }`

### Clip

```jsonc
{
  "id": "clip…", "mediaId": "med…", "name": "Luke meets Yoda", "kind": "video",
  "start": 2400, "duration": 480, "sourceIn": 3012.5, "speed": 1,
  "linkId": "link…",            // shared by linked video/audio clips
  "enabled": true, "audioStream": 1,
  "transform": { "x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1, "crop": { "left": 0, "top": 0, "right": 0, "bottom": 0 } },
  "audio": { "gain": 0, "volume": 1, "fadeIn": 0, "fadeOut": 12, "muted": false },
  "characters": ["Luke", "Yoda"], "plotlines": ["Jedi Training"], "locations": ["Dagobah"], "tags": [],
  "notes": "", "color": "#4d7cfe", "sceneRecordId": "scn…", "originLabel": "transcript"
}
```

### Transition

`{ id, type: 'crossDissolve'|'dipToBlack'|'audioCrossfade', duration (frames), outClipId, inClipId }`.
A transition is centred on the cut between `outClipId` and `inClipId`; either may be `null` for a
fade from/to black (silence). It uses source handles (media beyond the clip's in/out) and never changes
timeline positions. Transitions are automatically dropped when their clips stop being adjacent.

### Markers and continuity notes

`{ id, time, duration, name, note, color, kind: 'marker'|'continuity'|'chapter', category?, resolved?, clipId? }`.
Continuity issues are markers with `kind: 'continuity'`; the Continuity panel aggregates them across all sequences.

### Sequence subtitles

Sequence subtitle cues can be **attached to a clip** (`clipId`, `srcStart`, `srcEnd` in source seconds,
plus a frame `offset`). Their timeline position is derived from the clip's current position, so cues move
with clips through ripple edits, trims and speed changes. Cues without `clipId` use absolute `start`/`duration`.

## SceneRecord

`{ id, name, mediaId, in, out (seconds), characters, location, arc, tags, notes, rating (0–5), color, createdAt }`.

## SubtitleTrack (media)

`{ id, name, language, path?, mediaId, origin: 'srt'|'vtt'|'whisper'|'manual', cues: [{ id, start, end, text }] }`.

## Autosave and recovery

* Autosave writes `<project>.recut.autosave` (or `<userData>/autosave/untitled.recut.autosave` for never-saved
  projects) a few seconds after the last change and at the configured interval.
* Saves are atomic (temp file + rename) and keep one `.bak` of the previous version; a corrupt main file falls
  back to the `.bak` on load.
* On launch, an autosave newer than its project is offered for recovery.

## Compatibility

Unknown fields are preserved on load where possible and dropped on normalisation only when they would make
the file invalid. Future versions bump `formatVersion` and migrate in `normalizeProject()`.
