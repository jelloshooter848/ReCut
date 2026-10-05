import React, { useMemo } from 'react';
import { Star, X, LogIn, LogOut, Trash2, Film } from 'lucide-react';
import type { MediaItem, SceneRecord } from '@shared/model';
import { framesToSeconds, secondsToFrames } from '@shared/time';
import { useStore } from '@/state';
import { Button, ColorSwatchPicker, IconButton, TagInput, TextField, TimecodeField } from '@/components/ui';
import { loadSceneInSource, mediaFps, sourceLabel } from './sceneUtils';

// ------------------------------------------------------------------ rating stars

export function RatingStars({ value, onChange, size = 12, className = '' }: { value: number; onChange?: (v: number) => void; size?: number; className?: string }) {
  return (
    <div className={['scn-stars', onChange ? 'editable' : '', className].filter(Boolean).join(' ')} role="radiogroup" aria-label="Rating" data-rating={value}
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" className={['scn-star', n <= value ? 'on' : ''].join(' ')} role="radio" aria-checked={n === value}
          aria-label={`${n} star${n > 1 ? 's' : ''}`} title={`${n} / 5`} disabled={!onChange}
          onClick={(e) => { e.stopPropagation(); onChange?.(n === value ? 0 : n); }}>
          <Star size={size} fill={n <= value ? 'currentColor' : 'none'} />
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ single-record editor

interface EditorProps { scene: SceneRecord; media: MediaItem | undefined; onClose: () => void; onDelete: () => void }

export function SceneEditor({ scene, media, onClose, onDelete }: EditorProps) {
  const tags = useStore((s) => s.project.tags);
  const scenes = useStore((s) => s.project.scenes);
  const sourceClip = useStore((s) => s.ui.sourceClip);
  const fps = mediaFps(media);
  const maxFrames = media?.probe?.duration ? secondsToFrames(media.probe.duration, fps) : Infinity;

  const arcSuggestions = useMemo(() => {
    const set = new Set<string>(tags.plotlines);
    for (const s of Object.values(scenes)) if (s.arc) set.add(s.arc);
    return [...set].sort();
  }, [tags.plotlines, scenes]);
  const locationSuggestions = useMemo(() => {
    const set = new Set<string>(tags.locations);
    for (const s of Object.values(scenes)) if (s.location) set.add(s.location);
    return [...set].sort();
  }, [tags.locations, scenes]);

  const patch = (p: Partial<SceneRecord>) => useStore.getState().updateScene(scene.id, p);
  const sourceMatches = !!sourceClip && sourceClip.mediaId === scene.mediaId;
  const canSetIn = sourceMatches && sourceClip!.inPoint !== null;
  const canSetOut = sourceMatches && sourceClip!.outPoint !== null;

  return (
    <div className="scn-editor" data-testid="scene-editor" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div className="scn-editor-head">
        <span className="scn-editor-swatch" style={{ background: scene.color || 'var(--bg-5)' }} />
        <span className="grow ellipsis text-bright" title={scene.name}>{scene.name || 'Untitled scene'}</span>
        <span className="text-dim text-sm ellipsis" style={{ maxWidth: 140 }} title={sourceLabel(media)}>{sourceLabel(media)}</span>
        <IconButton icon={Film} label="Load in Source" size="sm" onClick={() => loadSceneInSource(scene)} />
        <IconButton icon={Trash2} label="Delete scene" size="sm" onClick={onDelete} />
        <IconButton icon={X} label="Close editor" size="sm" onClick={onClose} />
      </div>
      <div className="scn-form">
        <label>Name</label>
        <TextField value={scene.name} commitOnBlur onChange={(v) => patch({ name: v })} size="sm" data-testid="scene-name" />

        <label>In</label>
        <div className="row gap-4">
          <TimecodeField value={secondsToFrames(scene.in, fps)} fps={fps} min={0} max={Math.max(0, secondsToFrames(scene.out, fps) - 1)} tone="default" scrub={false}
            onChange={() => { /* commit only */ }} onCommit={(f) => patch({ in: Math.min(framesToSeconds(f, fps), scene.out) })} className="scn-tc" />
          <Button size="sm" icon={LogIn} disabled={!canSetIn} title="Set from Source In" onClick={() => canSetIn && patch({ in: Math.min(sourceClip!.inPoint!, scene.out) })}>Source In</Button>
        </div>

        <label>Out</label>
        <div className="row gap-4">
          <TimecodeField value={secondsToFrames(scene.out, fps)} fps={fps} min={secondsToFrames(scene.in, fps) + 1} max={maxFrames} tone="default" scrub={false}
            onChange={() => { /* commit only */ }} onCommit={(f) => patch({ out: Math.max(framesToSeconds(f, fps), scene.in) })} className="scn-tc" />
          <Button size="sm" icon={LogOut} disabled={!canSetOut} title="Set from Source Out" onClick={() => canSetOut && patch({ out: Math.max(sourceClip!.outPoint!, scene.in) })}>Source Out</Button>
        </div>

        <label>Characters</label>
        <div data-testid="scene-characters">
          <TagInput value={scene.characters} suggestions={tags.characters} placeholder="Add character…"
            onChange={(v) => { patch({ characters: v }); }} />
        </div>

        <label>Location</label>
        <>
          <TextField value={scene.location} commitOnBlur onChange={(v) => patch({ location: v })} size="sm" list="scn-location-list" placeholder="e.g. Cantina" data-testid="scene-location" />
          <datalist id="scn-location-list">{locationSuggestions.map((l) => <option key={l} value={l} />)}</datalist>
        </>

        <label>Arc</label>
        <>
          <TextField value={scene.arc} commitOnBlur onChange={(v) => patch({ arc: v })} size="sm" list="scn-arc-list" placeholder="e.g. Rescue the princess" data-testid="scene-arc" />
          <datalist id="scn-arc-list">{arcSuggestions.map((a) => <option key={a} value={a} />)}</datalist>
        </>

        <label>Tags</label>
        <div data-testid="scene-tags">
          <TagInput value={scene.tags} suggestions={tags.custom} placeholder="Add tag…" onChange={(v) => patch({ tags: v })} />
        </div>

        <label>Rating</label>
        <RatingStars value={scene.rating} onChange={(v) => patch({ rating: v })} size={13} />

        <label>Color</label>
        <ColorSwatchPicker value={scene.color} onChange={(hex) => patch({ color: hex })} />

        <label>Notes</label>
        <NotesField value={scene.notes} onCommit={(v) => patch({ notes: v })} />
      </div>
    </div>
  );
}

function NotesField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [local, setLocal] = React.useState(value);
  React.useEffect(() => { setLocal(value); }, [value]);
  return (
    <textarea className="input scn-notes" value={local} placeholder="Continuity, dialogue, why this scene matters…" spellCheck={false} data-testid="scene-notes"
      onChange={(e) => setLocal(e.target.value)} onBlur={() => { if (local !== value) onCommit(local); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { setLocal(value); e.currentTarget.blur(); } e.stopPropagation(); }} />
  );
}

// ------------------------------------------------------------------ batch editor (multi-selection)

export function SceneBatchEditor({ scenes, onClose }: { scenes: SceneRecord[]; onClose: () => void }) {
  const tags = useStore((s) => s.project.tags);
  const addToAll = (field: 'characters' | 'tags', value: string) => {
    const v = value.trim(); if (!v) return;
    const s = useStore.getState();
    s.addTag(field === 'characters' ? 'characters' : 'custom', v);
    for (const sc of scenes) if (!sc[field].includes(v)) s.updateScene(sc.id, { [field]: [...sc[field], v] });
  };
  const setAll = (p: Partial<SceneRecord>) => { const s = useStore.getState(); for (const sc of scenes) s.updateScene(sc.id, p); };
  return (
    <div className="scn-editor" data-testid="scene-batch-editor">
      <div className="scn-editor-head">
        <span className="grow text-bright">{scenes.length} scenes selected</span>
        <IconButton icon={X} label="Close editor" size="sm" onClick={onClose} />
      </div>
      <div className="scn-form">
        <label>Add character</label>
        <div data-testid="batch-characters"><TagInput value={[]} suggestions={tags.characters} placeholder="Type and press Enter to add to all…" onChange={(v) => v[0] && addToAll('characters', v[0])} /></div>
        <label>Add tag</label>
        <div data-testid="batch-tags"><TagInput value={[]} suggestions={tags.custom} placeholder="Type and press Enter to add to all…" onChange={(v) => v[0] && addToAll('tags', v[0])} /></div>
        <label>Rating</label>
        <RatingStars value={scenes.every((s) => s.rating === scenes[0].rating) ? scenes[0].rating : 0} onChange={(v) => setAll({ rating: v })} size={13} />
        <label>Color</label>
        <ColorSwatchPicker value={scenes.every((s) => s.color === scenes[0].color) ? scenes[0].color : undefined} onChange={(hex) => setAll({ color: hex })} />
      </div>
    </div>
  );
}
