# ReCut project format (`.recut`)

A ReCut project is a single UTF-8 JSON document. It references source media by absolute path and never
copies media. Derived data (thumbnails, waveforms, proxies, scene-detection caches) lives in the cache
directory (`<userData>/cache` or `$RECUT_CACHE_DIR`) keyed by file path + size + mtime, so a project file
stays small (typically well under 10 MB even for long-form work) and can be put under version control.

The authoritative TypeScript definitions are in `shared/model.ts`; `shared/project.ts` contains
`normalizeProject()`, which repairs/migrates older or partially damaged files on load.

## Text layout

Any JSON layout loads: ReCut only parses the file. What it writes:

* **Saves** (`serializeProject`, `shared/projectJson.ts`): the structure (project, media items, sequences, tracks,
  snapshots, subtitle tracks, settings, tags) is indented two spaces per level with one field per line, and each record
  inside it (a clip, transition, marker, story block, cue, detected scene, scene, bin) is compact JSON on a line of its
  own. A change to one clip is a one-line diff. ReCut 0.2.2 and earlier wrote a full 2-space pretty print, which is 2.4x
  larger (a 2,500-clip project: 68 MB vs 28 MB) and about 2.5x slower to write; both parse to the same project.
* **Autosaves**: compact JSON on one line (`JSON.stringify`).

The renderer serializes the project in slices (yielding to the UI between them) and sends the text to the main process,
which writes it as-is.

## Top level

| Field | Type | Notes |
|---|---|---|
| `formatVersion` | number | Currently `1`. Files with a higher version are refused; a missing or non-positive-integer value means "not a ReCut project". |
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
* **Valid frame rates** (`isValidFps`, `shared/time.ts`): `num` and `den` are integers from 1 to 1,000,000 and the
  rate is 1–1000 fps. On load an invalid sequence rate is replaced by 24000/1001, an invalid snapshot rate
  by its sequence's rate, and an invalid probe rate is stored as unknown.
* **Limits** (`shared/limits.ts`): every frame value (clip start / duration, markers, story blocks, free cues, cue
  offsets, view playhead / scroll / In / Out, transition durations) is a safe integer in `0..86,400,000` (24 h at
  1000 fps); source seconds are within 10 days; `clip.speed` is 0.01–100 (1 %–10 000 %).

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
  "proxy": { "status": "ready", "path": "/…/cache/proxies/<key>_540p_all.mp4", "width": 960, "height": 540, "audioStreams": [1] },
  "detectedScenes": [{ "id": "…", "start": 0, "end": 83.2, "name": "Scene 001", "tags": [], "characters": [] }],
  "subtitleTrackIds": ["st…"], "preferredAudioStream": 1, "tags": [], "notes": ""
}
```

`path` must be absolute: FFmpeg receives it as `file:<path>`, and a relative path is refused. `proxy.audioStreams`
lists the source audio streams the proxy carries (absolute ffprobe indexes, in its track order): every stream for a
`*_all.mp4` proxy, fewer when FFmpeg could not proxy one of them. It is optional: proxies from older builds have none
and are read by their file name: `*_all.mp4` carries every stream, `*_a<N>.mp4` stream N, any other proxy the stream
in its optional `audioStream`, else the first one. A still image's proxy is `<key>_still.png`. An invalid
`audioStreams` (not a list of non-negative integers) is dropped on load. `probe.video.sar`
(`{num, den}`) is the sample aspect ratio; it is kept only when both terms are positive safe integers and the ratio
is within 1/16–16, otherwise it is dropped (square pixels). Probes from older builds have none.
`probe.audio[].layoutGuessed: true` marks a stream for which ffprobe reported no channel layout (the `layout` shown
is a guess from the channel count, so its channels are numbered, not named). Optional `channelProxies` holds the
preview files of clips' channel selections (see Clip), keyed `<stream>.ch-<channel>` or
`<stream>.dm-c<centre dB>-s<surround dB>`, each a proxy record like `proxy`. On load, entries with other keys and
entries whose job had not finished are dropped; the app removes entries no clip uses.

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

`audio.channelSelection` (optional, audio clips; absent = the stream's normal mix) picks what the clip plays of its
multichannel stream: `{ "mode": "channel", "channel": "FC" }` (one channel as mono: an FFmpeg channel name of the
stream's layout, or `"c<N>"`, 0-based, when the layout is unknown) or
`{ "mode": "downmix", "centreDb": -3, "surroundDb": -3 }` (a stereo downmix; levels −60…+6 dB in 0.1 dB steps, LFE
left out). On load an unusable selection is removed (the normal mix) and out-of-range levels are clamped; both are
reported as repairs. A selection the clip's stream cannot honour is kept and plays the normal mix, with a pre-export
warning. Added in 0.8.0; `formatVersion` stays 1.

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

A sequence subtitle track has `{ id, name, language, enabled, cues, sourcePaths? }`. `sourcePaths` lists the
subtitle files whose cues were imported into it (**Import to track…**, or carried in from media subtitles). Exports
never write over these files.

## SceneRecord

`{ id, name, mediaId, in, out (seconds), characters, location, arc, tags, notes, rating (0–5), color, createdAt }`.

## SubtitleTrack (media)

`{ id, name, language, path?, mediaId, origin: 'srt'|'vtt'|'ocr'|'whisper'|'manual', streamIndex?, cues: [{ id, start, end, text }] }`.
`path` is the file the cues came from, including a sidecar read by the Transcript's subtitle-file provider. Exports
never write over it. `origin: 'ocr'` marks a track read from a bitmap subtitle stream with OCR; `streamIndex` is that
stream's absolute ffprobe index in the media file (a non-negative integer; the loader drops any other value). Reading
the same stream again replaces the track with the same `origin` and `streamIndex`. Both fields are optional additions:
`formatVersion` is unchanged.

## Autosave and recovery

* Autosave writes `<project>.recut.autosave` (or `<userData>/autosave/untitled.recut.autosave` for never-saved
  projects) a few seconds after the last change and at the configured interval.
* Saves are atomic (temp file + rename) and keep one `.bak` of the previous version; a structurally damaged main
  file (not JSON, not an object, or a `media` / `sequences` / `scenes` / `subtitleTracks` value that is not an
  object) falls back to the `.bak` on load, and the damaged file is copied to `<file>.corrupt-<timestamp>`. A file
  refused for its `formatVersion` is never replaced by the `.bak`.
* On launch, an autosave newer than its project is offered for recovery. The prompt says when it needed repairs.

## Repair on load

`normalizeProjectWithReport()` repairs damaged or hostile data and lists each kind of repair. When the file (or
the `.bak` used in its place) needed repairs, the loader first copies it to `<file>.pre-repair-<timestamp>`, and
the app shows a warning naming the repairs and the copy. Repairs include:

* entries that are not objects are dropped, wrongly typed fields reset to their defaults, values nested deeper than
  64 levels dropped;
* frame values outside the limits above: items starting out of range are dropped, ends pulled in, view values
  reset; fractional values rounded (both ends of a span, so touching clips stay touching);
* overlapping clips on one track: a clip loses its overlapping head (`sourceIn` follows) when at least one frame
  remains, otherwise it moves unchanged to an extra track of the same kind (at most 32 per kind and sequence;
  beyond that it is dropped);
* duplicate ids within a sequence are re-issued (the first keeps its id); references that resolve only through
  `Object.prototype` (`"constructor"`, `"toString"`, ...) are cleared;
* settings clamped to the Preferences ranges, clip speed clamped, reversed story blocks turned around.

Valid files and expected resets (jobs that were running) report nothing, and normalizing a repaired project
again reports nothing.

## Compatibility

Unknown fields are preserved on load where possible and dropped on normalisation only when they would make
the file invalid. Future versions bump `formatVersion` and migrate in `normalizeProject()`.
