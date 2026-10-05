/**
 * Clip inspector: header, prominent original-source timecode block, Video (transform), Speed, Audio, Tags and
 * Transitions sections. Works on one or many selected clips; multi-edits apply to every selected clip and mixed
 * values display as '—'. Scrubs are routed through the store transaction API so a drag is a single undo step.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { FolderOpen, Link2, Plus, RotateCcw, Unlink2, X } from 'lucide-react';
import type { Clip, ClipAudio, ClipTransform, ID, MediaItem, Rational, TagVocabulary, Track, Transition, TransitionType } from '@shared/model';
import { clampSpeedPercent, clipEnd, clipSourceOut, defaultAudio, defaultTransform, findClip, linkedClips, SPEED_PERCENT_MAX, SPEED_PERCENT_MIN, transitionsForClip } from '@shared/timeline';
import { formatSequenceSecondsTimecode, fpsEquals, fpsLabel, validFpsOr } from '@shared/time';
import { activeSequence, identityLabel, originalTimecode, selectedClips, useStore } from '@/state';
import type { StoreState } from '@/state';
import { Button, ColorSwatchPicker, IconButton, NumberField, Slider, TagInput, TextField, Toggle, labelColorHex } from '@/components/ui';
import { MIXED, Range, Row, Section, Value, allSame, copyText, finish, framesLabel, openInFolder, secondsLabel, tc, transient } from './primitives';

export const TRANSITION_LABEL: Record<TransitionType, string> = { crossDissolve: 'Cross Dissolve', dipToBlack: 'Dip to Black', audioCrossfade: 'Audio Crossfade' };
const SCRUB_HINT = 'Drag to scrub · Shift ×10 · Alt ×0.1 · Double-click or Alt-click resets';

/** Apply `fn` to every clip in `ids` inside a transient (transaction) edit. */
function editClips(seqId: ID, ids: ID[], fn: (clip: Clip) => void): void {
  transient((d) => {
    const seq = d.sequences[seqId];
    if (!seq) return;
    for (const id of ids) { const loc = findClip(seq, id); if (loc) fn(loc.clip); }
  });
}

function addVocab(tags: TagVocabulary, kind: keyof TagVocabulary, values: string[]): void {
  for (const v of values) { const t = v.trim(); if (t && !tags[kind].includes(t)) tags[kind].push(t); }
}

// ------------------------------------------------------------------ number field with mixed-state display
interface NFProps {
  value: number; mixed?: boolean; onChange: (v: number) => void; onCommit: (v: number) => void;
  min?: number; max?: number; step?: number; precision?: number; unit?: string; signed?: boolean; def?: number; title?: string; fixed?: boolean;
}
function NF({ value, mixed, onChange, onCommit, min, max, step = 1, precision = 0, unit, signed, def, title, fixed }: NFProps) {
  const fmt = (v: number) => (mixed ? MIXED : `${signed && v > 0 ? '+' : ''}${v.toFixed(precision)}`);
  return (
    <NumberField value={value} onChange={onChange} onCommit={onCommit} min={min} max={max} step={step} precision={precision} unit={unit}
      defaultValue={def} format={fmt} title={title ?? SCRUB_HINT} className={fixed ? 'insp-nf-fixed' : ''} />
  );
}

// ------------------------------------------------------------------ root
export function ClipInspector({ seqId, fps }: { seqId: ID; fps: Rational }) {
  const clips = useStore(useShallow(selectedClips));
  const tracks = useStore(useShallow((s: StoreState) => {
    const seq = activeSequence(s);
    return clips.map((c) => (seq ? findClip(seq, c.id)?.track ?? null : null));
  }));
  // audio clips to edit: selected audio clips + the linked audio of selected video clips
  const audioTargets = useStore(useShallow((s: StoreState) => {
    const seq = activeSequence(s);
    if (!seq) return [] as Clip[];
    const out: Clip[] = []; const seen = new Set<ID>();
    for (const c of clips) {
      if (c.kind === 'audio') { if (!seen.has(c.id)) { seen.add(c.id); out.push(c); } continue; }
      if (!c.linkId) continue;
      for (const t of seq.audioTracks) for (const a of t.clips) if (a.linkId === c.linkId && !seen.has(a.id)) { seen.add(a.id); out.push(a); }
    }
    return out;
  }));
  const media = useStore((s) => (clips.length ? s.project.media[clips[0].mediaId] : undefined));
  const linkedCount = useStore((s) => { const seq = activeSequence(s); return seq && clips.length === 1 ? linkedClips(seq, clips[0]).length : 0; });

  if (clips.length === 0) return <div className="insp-empty p-8">Selected clips are not in the active sequence.</div>;
  const single = clips.length === 1 ? clips[0] : null;
  const videoClips = clips.filter((c) => c.kind === 'video');
  const ids = clips.map((c) => c.id);

  return (
    <>
      <ClipHeader seqId={seqId} clips={clips} media={media} linkedCount={linkedCount} />
      <SourceSection seqId={seqId} fps={fps} clips={clips} media={media} />
      {videoClips.length > 0 ? <VideoSection seqId={seqId} clips={videoClips} /> : null}
      <SpeedSection seqId={seqId} fps={fps} clips={clips} />
      <AudioSection seqId={seqId} fps={fps} targets={audioTargets} selectedIds={ids} />
      <TagsSection seqId={seqId} clips={clips} />
      {single && tracks[0] ? <TransitionsSection seqId={seqId} fps={fps} clip={single} track={tracks[0]} /> : null}
      {!single ? <div className="insp-note p-8">Selected: {ids.length} clips. Edits above apply to all of them.</div> : null}
    </>
  );
}

// ------------------------------------------------------------------ header
function ClipHeader({ seqId, clips, media, linkedCount }: { seqId: ID; clips: Clip[]; media: MediaItem | undefined; linkedCount: number }) {
  const single = clips.length === 1 ? clips[0] : null;
  const ids = clips.map((c) => c.id);
  const allEnabled = clips.every((c) => c.enabled);
  const sameColor = allSame(clips, (c) => c.color);
  const color = sameColor ? clips[0].color : undefined;
  const setClipTags = useStore((s) => s.setClipTags);
  const kinds = new Set(clips.map((c) => c.kind));
  const kindLabel = kinds.size === 2 ? 'video + audio' : [...kinds][0];

  return (
    <div className="insp-head" data-testid="clip-header">
      <div className="insp-title-row">
        {single ? (
          <TextField size="sm" value={single.name} onChange={(v) => { if (v.trim() && v !== single.name) setClipTags(seqId, single.id, { name: v.trim() }); }} commitOnBlur selectOnFocus title="Clip name (Enter to apply)" data-prop="clip-name" />
        ) : (
          <span className="grow text-bright" style={{ fontWeight: 600 }}>{clips.length} clips</span>
        )}
        <Toggle checked={allEnabled} title={allEnabled ? 'Disable clip (Shift+E)' : 'Enable clip (Shift+E)'}
          onChange={(on) => { editClips(seqId, ids, (c) => { c.enabled = on; }); finish('Toggle enabled'); }} />
      </div>
      <div className="insp-sub">
        <span className="badge dim">{kindLabel}</span>
        {media ? <span className="ellipsis" title={media.path}>{media.name}</span> : <span className="text-danger">media missing</span>}
        {media?.offline ? <span className="badge danger">offline</span> : null}
        {!allEnabled ? <span className="badge warn">disabled</span> : null}
        {single ? (
          single.linkId ? (
            <span className="row gap-2 text-dim" title={`Linked group (${linkedCount} clips)`}><Link2 size={11} />Linked{linkedCount > 1 ? ` (${linkedCount})` : ''}</span>
          ) : (
            <span className="row gap-2 text-faint" title="Not linked to other clips"><Unlink2 size={11} />Unlinked</span>
          )
        ) : null}
      </div>
      <div className="row gap-4" data-prop="color">
        <span className="insp-label" style={{ width: 36 }}>Label</span>
        <ColorSwatchPicker value={color} onChange={(hex) => { editClips(seqId, ids, (c) => { c.color = hex; }); finish('Clip color'); }} />
        <button type="button" className={['insp-swatch-none', !color && sameColor ? 'selected' : ''].join(' ')} title="No label color"
          onClick={() => { editClips(seqId, ids, (c) => { c.color = undefined; }); finish('Clip color'); }} />
        {!sameColor ? <span className="text-faint text-xs">mixed</span> : null}
        {color ? <span className="text-xs text-dim">{labelColorHex(color)}</span> : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ source (original timecode) block
function SourceAtPlayhead({ clip, fps, media }: { clip: Clip; fps: Rational; media: MediaItem | undefined }) {
  const playhead = useStore((s) => activeSequence(s)?.view.playhead ?? 0);
  const inside = playhead >= clip.start && playhead < clipEnd(clip);
  const at = inside ? playhead : clip.start;
  const o = originalTimecode(clip, at, fps, media);
  return (
    <div className="insp-source-card" data-testid="source-card">
      <div className="lbl"><span>Original source timecode</span><span className="where">{inside ? 'at playhead' : 'at clip start'}</span></div>
      <span className="tc" role="button" title={`Source ${secondsLabel(o.sourceSeconds)} — click to copy`} data-testid="source-tc"
        onClick={() => copyText(o.sourceTimecode)}>{o.sourceTimecode}</span>
      {o.identityLabel ? <div className="idn" title={o.identityLabel}>{o.identityLabel}{media?.category ? <span className="text-faint"> · {media.category}</span> : null}</div> : null}
      {media ? (
        <div className="file" role="button" title={`${media.path}\nClick to reveal in file manager`} data-testid="source-file" onClick={() => openInFolder(media.path)}>
          <FolderOpen /><span>{o.fileName}</span>
        </div>
      ) : null}
    </div>
  );
}

function SourceSection({ seqId: _seqId, fps, clips, media }: { seqId: ID; fps: Rational; clips: Clip[]; media: MediaItem | undefined }) {
  const single = clips.length === 1 ? clips[0] : null;
  const mediaFps = validFpsOr(media?.probe?.video?.fps, fps);
  // Loops, not Math.min/max(...spread): huge selections would overflow the stack.
  let start = Infinity, end = -Infinity;
  for (const c of clips) { if (c.start < start) start = c.start; if (clipEnd(c) > end) end = clipEnd(c); }
  if (!single) {
    return (
      <Section id="source" title="Source" badge={`${clips.length} clips`}>
        <Row label="Sequence range"><Range a={tc(start, fps)} b={tc(end, fps)} /></Row>
        <Row label="Span"><Value>{framesLabel(end - start, fps)}</Value></Row>
        <Row label="Total duration"><Value>{framesLabel(clips.reduce((a, c) => a + c.duration, 0), fps)}</Value></Row>
        <Row label="Media"><Value dim>{new Set(clips.map((c) => c.mediaId)).size} source file(s)</Value></Row>
      </Section>
    );
  }
  const srcIn = single.sourceIn;
  const srcOut = clipSourceOut(single, fps);
  const tcIn = formatSequenceSecondsTimecode(srcIn, mediaFps);
  const tcOut = formatSequenceSecondsTimecode(srcOut, mediaFps);
  const tcStart = originalTimecode(single, single.start, fps, media).sourceTimecode;
  const idn = identityLabel(media);
  return (
    <Section id="source" title="Source" badge={media ? fpsLabel(mediaFps) + ' fps' : undefined}>
      <SourceAtPlayhead clip={single} fps={fps} media={media} />
      <Row label="Sequence" title="Clip position in the sequence"><Range a={tc(single.start, fps)} b={tc(clipEnd(single), fps)} /></Row>
      <Row label="Source at start" title="Original source timecode at the first frame of the clip"><Value copy={tcStart}>{tcStart}</Value></Row>
      <Row label="Source range" title="Source in → out (media timecode)"><Range a={tcIn} b={tcOut} testId="source-range" /></Row>
      <Row label=""><Range a={secondsLabel(srcIn)} b={secondsLabel(srcOut)} dim /></Row>
      <Row label="Duration"><Value copy={String(single.duration)}>{framesLabel(single.duration, fps)}</Value></Row>
      <Row label="Speed"><Value>{Math.round(single.speed * 1000) / 10}%{single.speed !== 1 ? <span className="text-faint"> · {secondsLabel(srcOut - srcIn)} of source</span> : null}</Value></Row>
      {media ? <Row label="File" title={media.path}><Value onClick={() => openInFolder(media.path)} title="Reveal in file manager">{originalTimecode(single, single.start, fps, media).fileName}</Value></Row> : null}
      {media ? <Row label="Path"><Value copy={media.path} dim>{media.path}</Value></Row> : null}
      {idn ? <Row label="Identity"><Value copy={idn}>{idn}</Value></Row> : null}
      {media ? <Row label="Category"><Value dim>{media.category}{media.identity.year ? ` · ${media.identity.year}` : ''}</Value></Row> : null}
      {single.audioStream !== undefined ? <Row label="Audio stream"><Value dim>#{single.audioStream}</Value></Row> : null}
      {single.originLabel ? <Row label="Origin"><Value dim>{single.originLabel}</Value></Row> : null}
      {media && !fpsEquals(mediaFps, fps) ? <div className="insp-note warn">Media is {fpsLabel(mediaFps)} fps, sequence is {fpsLabel(fps)} fps — source timecode uses the media rate.</div> : null}
    </Section>
  );
}

// ------------------------------------------------------------------ video / transform
function VideoSection({ seqId, clips }: { seqId: ID; clips: Clip[] }) {
  const ids = clips.map((c) => c.id);
  const t0 = clips[0].transform;
  const def = defaultTransform();
  const set = (fn: (t: ClipTransform) => void) => editClips(seqId, ids, (c) => fn(c.transform));
  const commit = () => finish('Transform');
  const same = (pick: (t: ClipTransform) => number) => allSame(clips, (c) => pick(c.transform));
  const reset = (fn: (t: ClipTransform) => void) => { set(fn); finish('Reset transform'); };
  const changed = (pick: (t: ClipTransform) => number, d: number) => clips.some((c) => pick(c.transform) !== d);

  return (
    <Section id="video" title="Video" badge={clips.length > 1 ? `${clips.length} clips` : undefined}
      actions={<IconButton icon={RotateCcw} label="Reset all transform properties" size="sm" onClick={() => reset((t) => Object.assign(t, defaultTransform()))} />}>
      <Row label="Position" prop="position" onReset={() => reset((t) => { t.x = 0; t.y = 0; })} canReset={changed((t) => t.x, 0) || changed((t) => t.y, 0)}>
        <span className="insp-axis">X</span>
        <NF value={t0.x} mixed={!same((t) => t.x)} unit="px" def={0} onChange={(v) => set((t) => { t.x = v; })} onCommit={commit} />
        <span className="insp-axis">Y</span>
        <NF value={t0.y} mixed={!same((t) => t.y)} unit="px" def={0} onChange={(v) => set((t) => { t.y = v; })} onCommit={commit} />
      </Row>
      <Row label="Scale" prop="scale" onReset={() => reset((t) => { t.scale = 1; })} canReset={changed((t) => t.scale, 1)} title="Uniform scale">
        <NF value={Math.round(t0.scale * 1000) / 10} mixed={!same((t) => t.scale)} unit="%" min={1} max={10000} precision={1} def={100}
          onChange={(v) => set((t) => { t.scale = v / 100; })} onCommit={commit} />
      </Row>
      <Row label="Rotation" prop="rotation" onReset={() => reset((t) => { t.rotation = 0; })} canReset={changed((t) => t.rotation, 0)}>
        <NF value={t0.rotation} mixed={!same((t) => t.rotation)} unit="°" min={-3600} max={3600} precision={1} def={0}
          onChange={(v) => set((t) => { t.rotation = v; })} onCommit={commit} />
      </Row>
      <Row label="Opacity" prop="opacity" onReset={() => reset((t) => { t.opacity = 1; })} canReset={changed((t) => t.opacity, 1)}>
        <Slider value={t0.opacity} min={0} max={1} step={0.01} defaultValue={1} title="Opacity" onChange={(v) => set((t) => { t.opacity = v; })} onCommit={commit} />
        <NF value={Math.round(t0.opacity * 100)} mixed={!same((t) => t.opacity)} unit="%" min={0} max={100} def={100} fixed
          onChange={(v) => set((t) => { t.opacity = v / 100; })} onCommit={commit} />
      </Row>
      <Row label="Crop L · R" prop="crop-lr" onReset={() => reset((t) => { t.crop.left = 0; t.crop.right = 0; })} canReset={changed((t) => t.crop.left, 0) || changed((t) => t.crop.right, 0)}>
        <span className="insp-axis">L</span>
        <NF value={Math.round(t0.crop.left * 1000) / 10} mixed={!same((t) => t.crop.left)} unit="%" min={0} max={100} precision={1} def={0}
          onChange={(v) => set((t) => { t.crop.left = v / 100; })} onCommit={commit} />
        <span className="insp-axis">R</span>
        <NF value={Math.round(t0.crop.right * 1000) / 10} mixed={!same((t) => t.crop.right)} unit="%" min={0} max={100} precision={1} def={0}
          onChange={(v) => set((t) => { t.crop.right = v / 100; })} onCommit={commit} />
      </Row>
      <Row label="Crop T · B" prop="crop-tb" onReset={() => reset((t) => { t.crop.top = 0; t.crop.bottom = 0; })} canReset={changed((t) => t.crop.top, 0) || changed((t) => t.crop.bottom, 0)}>
        <span className="insp-axis">T</span>
        <NF value={Math.round(t0.crop.top * 1000) / 10} mixed={!same((t) => t.crop.top)} unit="%" min={0} max={100} precision={1} def={0}
          onChange={(v) => set((t) => { t.crop.top = v / 100; })} onCommit={commit} />
        <span className="insp-axis">B</span>
        <NF value={Math.round(t0.crop.bottom * 1000) / 10} mixed={!same((t) => t.crop.bottom)} unit="%" min={0} max={100} precision={1} def={0}
          onChange={(v) => set((t) => { t.crop.bottom = v / 100; })} onCommit={commit} />
      </Row>
      {JSON.stringify(def) === JSON.stringify(t0) && clips.length === 1 ? <div className="insp-note">All properties at defaults.</div> : null}
    </Section>
  );
}

// ------------------------------------------------------------------ speed
function SpeedSection({ seqId, fps, clips }: { seqId: ID; fps: Rational; clips: Clip[] }) {
  const setClipSpeed = useStore((s) => s.setClipSpeed);
  const [draft, setDraft] = useState<number | null>(null);
  const [ripple, setRipple] = useState(false);
  const mixed = !allSame(clips, (c) => c.speed);
  const speedPct = Math.round(clips[0].speed * 1000) / 10;
  useEffect(() => { setDraft(null); }, [speedPct]);
  const apply = (pct: number) => {
    setDraft(null);
    const speed = clampSpeedPercent(pct);
    // one call per link group (setClipSpeed already applies to the linked clips)
    const seen = new Set<string>();
    for (const c of clips) { const key = c.linkId ?? c.id; if (seen.has(key)) continue; seen.add(key); setClipSpeed(seqId, c.id, speed, { ripple }); }
  };
  const dur = clips.reduce((a, c) => a + c.duration, 0);
  return (
    <Section id="speed" title="Speed / Duration" badge={mixed ? MIXED : `${speedPct}%`}>
      <Row label="Speed" prop="speed" onReset={() => apply(100)} canReset={clips.some((c) => c.speed !== 1)} title={`${SPEED_PERCENT_MIN}% – ${SPEED_PERCENT_MAX}%. Changes clip duration; linked clips follow.`}>
        <NF value={draft ?? speedPct} mixed={mixed && draft === null} unit="%" min={SPEED_PERCENT_MIN} max={SPEED_PERCENT_MAX} precision={1} def={100} onChange={setDraft} onCommit={apply} />
      </Row>
      <Row label="Duration"><Value copy={String(dur)}>{framesLabel(dur, fps)}</Value></Row>
      <Row label="Ripple" title="Shift following clips when the duration changes">
        <Toggle checked={ripple} onChange={setRipple} label={<span className="text-sm text-dim">Ripple following clips</span>} />
      </Row>
    </Section>
  );
}

// ------------------------------------------------------------------ audio
function AudioSection({ seqId, fps, targets, selectedIds }: { seqId: ID; fps: Rational; targets: Clip[]; selectedIds: ID[] }) {
  if (targets.length === 0) {
    return <Section id="audio" title="Audio"><div className="insp-empty">No audio in selection.</div></Section>;
  }
  const ids = targets.map((c) => c.id);
  const a0 = targets[0].audio;
  const def = defaultAudio();
  const set = (fn: (a: ClipAudio) => void) => editClips(seqId, ids, (c) => fn(c.audio));
  const commit = () => finish('Audio');
  const same = (pick: (a: ClipAudio) => number | boolean) => allSame(targets, (c) => pick(c.audio));
  const reset = (fn: (a: ClipAudio) => void) => { set(fn); finish('Reset audio'); };
  let maxFade = Infinity; // a loop, not Math.min(...spread): huge selections would overflow the stack
  for (const c of targets) if (c.duration < maxFade) maxFade = c.duration;
  const linkedOnly = targets.every((t) => !selectedIds.includes(t.id));
  return (
    <Section id="audio" title="Audio" badge={linkedOnly ? 'linked audio' : targets.length > 1 ? `${targets.length} clips` : undefined}
      actions={<IconButton icon={RotateCcw} label="Reset all audio properties" size="sm" onClick={() => reset((a) => Object.assign(a, defaultAudio()))} />}>
      <Row label="Gain" prop="gain" onReset={() => reset((a) => { a.gain = 0; })} canReset={targets.some((c) => c.audio.gain !== def.gain)} title="Clip gain in dB (applied before level)">
        <NF value={a0.gain} mixed={!same((a) => a.gain)} unit="dB" min={-60} max={24} step={0.5} precision={1} signed def={0}
          onChange={(v) => set((a) => { a.gain = v; })} onCommit={commit} />
      </Row>
      <Row label="Level" prop="volume" onReset={() => reset((a) => { a.volume = 1; })} canReset={targets.some((c) => c.audio.volume !== 1)} title="Clip level 0–200%">
        <Slider value={a0.volume} min={0} max={2} step={0.01} defaultValue={1} onChange={(v) => set((a) => { a.volume = v; })} onCommit={commit} />
        <NF value={Math.round(a0.volume * 100)} mixed={!same((a) => a.volume)} unit="%" min={0} max={200} def={100} fixed
          onChange={(v) => set((a) => { a.volume = v / 100; })} onCommit={commit} />
      </Row>
      <Row label="Fade in" prop="fade-in" onReset={() => reset((a) => { a.fadeIn = 0; })} canReset={targets.some((c) => c.audio.fadeIn !== 0)}>
        <NF value={a0.fadeIn} mixed={!same((a) => a.fadeIn)} unit="fr" min={0} max={maxFade} def={0} onChange={(v) => set((a) => { a.fadeIn = v; })} onCommit={commit} />
        <Value dim>{tc(a0.fadeIn, fps)}</Value>
      </Row>
      <Row label="Fade out" prop="fade-out" onReset={() => reset((a) => { a.fadeOut = 0; })} canReset={targets.some((c) => c.audio.fadeOut !== 0)}>
        <NF value={a0.fadeOut} mixed={!same((a) => a.fadeOut)} unit="fr" min={0} max={maxFade} def={0} onChange={(v) => set((a) => { a.fadeOut = v; })} onCommit={commit} />
        <Value dim>{tc(a0.fadeOut, fps)}</Value>
      </Row>
      <Row label="Mute" prop="mute">
        <Toggle checked={targets.every((c) => c.audio.muted)} title="Mute clip audio" onChange={(on) => { set((a) => { a.muted = on; }); finish(on ? 'Mute clip' : 'Unmute clip'); }} />
        {!same((a) => a.muted) ? <span className="text-faint text-xs">mixed</span> : null}
        {targets.length === 1 && targets[0].audioStream !== undefined ? <span className="text-faint text-xs ml-auto">stream #{targets[0].audioStream}</span> : null}
      </Row>
    </Section>
  );
}

// ------------------------------------------------------------------ tags
type TagKind = 'characters' | 'plotlines' | 'locations' | 'tags';
const TAG_ROWS: { kind: TagKind; vocab: keyof TagVocabulary; label: string; placeholder: string }[] = [
  { kind: 'characters', vocab: 'characters', label: 'Characters', placeholder: 'Add character…' },
  { kind: 'plotlines', vocab: 'plotlines', label: 'Plotlines', placeholder: 'Add plotline…' },
  { kind: 'locations', vocab: 'locations', label: 'Locations', placeholder: 'Add location…' },
  { kind: 'tags', vocab: 'custom', label: 'Tags', placeholder: 'Add tag…' },
];

function TagsSection({ seqId, clips }: { seqId: ID; clips: Clip[] }) {
  const vocab = useStore((s) => s.project.tags);
  const notes = allSame(clips, (c) => c.notes) ? clips[0].notes : '';
  const [noteDraft, setNoteDraft] = useState(notes);
  useEffect(() => { setNoteDraft(notes); }, [notes, clips.length]);
  const ids = clips.map((c) => c.id);

  /** Shown value: tags common to every selected clip. Changes are applied as add/remove deltas to each clip (and linked clips). */
  const common = (kind: TagKind) => clips.slice(1).reduce((acc, c) => acc.filter((t) => c[kind].includes(t)), [...clips[0][kind]]);
  const change = (kind: TagKind, vocabKind: keyof TagVocabulary, next: string[]) => {
    const shown = common(kind);
    const added = next.filter((t) => !shown.includes(t));
    const removed = shown.filter((t) => !next.includes(t));
    transient((d) => {
      const seq = d.sequences[seqId];
      if (!seq) return;
      const done = new Set<ID>();
      for (const id of ids) {
        const loc = findClip(seq, id); if (!loc) continue;
        for (const c of linkedClips(seq, loc.clip)) {
          if (done.has(c.id)) continue; done.add(c.id);
          c[kind] = [...c[kind].filter((t) => !removed.includes(t)), ...added.filter((t) => !c[kind].includes(t))];
        }
      }
      addVocab(d.tags, vocabKind, added);
    });
    finish('Tag clip');
  };
  const commitNotes = () => {
    if (noteDraft === notes) return;
    transient((d) => {
      const seq = d.sequences[seqId]; if (!seq) return;
      for (const id of ids) { const loc = findClip(seq, id); if (loc) for (const c of linkedClips(seq, loc.clip)) c.notes = noteDraft; }
    });
    finish('Clip notes');
  };
  const total = TAG_ROWS.reduce((n, r) => n + common(r.kind).length, 0);
  return (
    <Section id="tags" title="Story tags" badge={total ? `${total}` : undefined}>
      {TAG_ROWS.map((r) => {
        const shown = common(r.kind);
        const mixed = clips.some((c) => c[r.kind].length !== shown.length);
        return (
          <Row key={r.kind} label={<>{r.label}{mixed ? <span className="text-faint"> (mixed)</span> : null}</>} prop={r.kind} top>
            <TagInput value={shown} suggestions={vocab[r.vocab]} placeholder={r.placeholder} onChange={(next) => change(r.kind, r.vocab, next)} />
          </Row>
        );
      })}
      <Row label="Notes" prop="notes" top>
        <textarea className="input" value={noteDraft} placeholder={clips.length > 1 && !allSame(clips, (c) => c.notes) ? '(mixed) — typing replaces all' : 'Notes…'} spellCheck={false}
          onChange={(e) => setNoteDraft(e.target.value)} onBlur={commitNotes}
          onKeyDown={(e) => { if (e.key === 'Escape') { setNoteDraft(notes); (e.target as HTMLElement).blur(); } e.stopPropagation(); }} />
      </Row>
      {clips.length === 1 && clips[0].linkId ? <div className="insp-note">Tags and notes are shared with linked clips.</div> : null}
    </Section>
  );
}

// ------------------------------------------------------------------ transitions
function TransitionRow({ seqId, fps, tr, edge, limit }: { seqId: ID; fps: Rational; tr: Transition; edge: 'start' | 'end'; limit: number }) {
  const removeTransition = useStore((s) => s.removeTransition);
  const selectTransition = useStore((s) => s.selectTransition);
  return (
    <div className="insp-tr" data-testid={`transition-${edge}`}>
      <div className="insp-tr-name" role="button" title="Select transition" onClick={() => selectTransition(tr.id)}>
        <span className="t">{TRANSITION_LABEL[tr.type]}</span>
        <span className="m">{edge === 'start' ? 'in' : 'out'} · {tc(tr.duration, fps)}{tr.outClipId && tr.inClipId ? '' : edge === 'start' ? ' · from black' : ' · to black'}</span>
      </div>
      <NumberField value={tr.duration} min={1} max={Math.max(1, limit)} unit="fr" title="Duration (frames)"
        onChange={(v) => transient((d) => { const seq = d.sequences[seqId]; if (!seq) return; for (const t of [...seq.videoTracks, ...seq.audioTracks]) { const x = t.transitions.find((y) => y.id === tr.id); if (x) x.duration = Math.max(1, Math.round(v)); } })}
        onCommit={() => finish('Transition duration')} />
      <IconButton icon={X} label="Remove transition" size="sm" onClick={() => removeTransition(seqId, tr.id)} />
    </div>
  );
}

function TransitionsSection({ seqId, fps, clip, track }: { seqId: ID; fps: Rational; clip: Clip; track: Track }) {
  const addTransitionAtCut = useStore((s) => s.addTransitionAtCut);
  const defaultFrames = useStore((s) => s.project.settings.defaultTransitionFrames);
  const { in: trIn, out: trOut } = useMemo(() => transitionsForClip(track, clip.id), [track, clip.id]);
  const type: TransitionType = track.kind === 'audio' ? 'audioCrossfade' : 'crossDissolve';
  const label = track.kind === 'audio' ? 'Crossfade' : 'Dissolve';
  const idx = track.clips.findIndex((c) => c.id === clip.id);
  const prev = idx > 0 ? track.clips[idx - 1] : undefined;
  const next = idx >= 0 ? track.clips[idx + 1] : undefined;
  const limitIn = Math.min(clip.duration, prev && clipEnd(prev) === clip.start ? prev.duration : Infinity);
  const limitOut = Math.min(clip.duration, next && next.start === clipEnd(clip) ? next.duration : Infinity);
  const count = (trIn ? 1 : 0) + (trOut ? 1 : 0);
  return (
    <Section id="transitions" title="Transitions" badge={count ? `${count}` : undefined}>
      {trIn ? <TransitionRow seqId={seqId} fps={fps} tr={trIn} edge="start" limit={limitIn} /> : null}
      {trOut ? <TransitionRow seqId={seqId} fps={fps} tr={trOut} edge="end" limit={limitOut} /> : null}
      {!count ? <div className="insp-empty">No transitions on this clip.</div> : null}
      <div className="insp-btn-row">
        <Button size="sm" icon={Plus} disabled={!!trIn || track.locked} title={`${TRANSITION_LABEL[type]} (${defaultFrames} fr) at clip start${prev && clipEnd(prev) === clip.start ? `, shared with "${prev.name}"` : ' (from black)'}`}
          onClick={() => addTransitionAtCut(seqId, track.id, clip.start, type)} data-testid="add-transition-start">{label} at start</Button>
        <Button size="sm" icon={Plus} disabled={!!trOut || track.locked} title={`${TRANSITION_LABEL[type]} (${defaultFrames} fr) at clip end${next && next.start === clipEnd(clip) ? `, shared with "${next.name}"` : ' (to black)'}`}
          onClick={() => addTransitionAtCut(seqId, track.id, clipEnd(clip), type)} data-testid="add-transition-end">{label} at end</Button>
      </div>
      <div className="insp-note">Transitions are centered on the cut · default {defaultFrames} fr ({tc(defaultFrames, fps)}).</div>
    </Section>
  );
}
