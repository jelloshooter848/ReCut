/**
 * Suggest Scenes (#147): proposes groupings of a video's shots into scenes from speech, picture and sound at each cut.
 * Review them (untick to reject, join with the next, split at a shot, rename), then create the accepted ones.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { ID } from '@shared/model';
import { formatClock } from '@shared/time';
import { cutLinks, groupShots, SUGGEST_THRESHOLD, type CutLink } from '@shared/sceneSuggest';
import { mediaSpeechCues } from '@shared/sceneNaming';
import { Button, Dialog, ProgressBar, Slider } from '@/components/ui';
import { useStore } from '@/state';
import { createSuggestedScenes, gatherShotFeatures, nameSuggestions, type SuggestedScene } from './suggestScenes';

const clock = (s: number) => formatClock(Math.max(0, s), false).replace(/^00:/, '0:');

export function SuggestScenesDialog({ mediaId, onClose }: { mediaId: ID; onClose: () => void }) {
  const media = useStore((s) => s.project.media[mediaId]);
  const [links, setLinks] = useState<CutLink[] | null>(null);
  const [progress, setProgress] = useState(0);
  // The slider is "how readily shots join": high joins more (fewer, longer scenes).
  const [join, setJoin] = useState(1 - SUGGEST_THRESHOLD);
  const [suggestions, setSuggestions] = useState<SuggestedScene[]>([]);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    if (!media) return;
    const ac = new AbortController();
    void gatherShotFeatures(media, (d, t) => setProgress(t ? d / t : 1), ac.signal).then((f) => {
      if (ac.signal.aborted) return;
      const st = useStore.getState();
      setLinks(cutLinks({ shots: media.detectedScenes, cues: mediaSpeechCues(media, st.project.subtitleTracks), hists: f.hists, audio: f.audio }));
    });
    return () => ac.abort();
    // Analyse once per opening; edits to the shots meanwhile are picked up next time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaId]);

  const regroup = (groups: number[][]) => {
    if (!media) return;
    const names = nameSuggestions(media, groups);
    setSuggestions(groups.map((g, i) => ({ shotIndices: g, name: names[i], accepted: true })));
    setOpen(null);
  };
  useEffect(() => { if (links) regroup(groupShots(links, 1 - join)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [links, join]);

  const accepted = suggestions.filter((s) => s.accepted).length;
  const summary = useMemo(() => {
    const multi = suggestions.filter((s) => s.shotIndices.length > 1).length;
    return `${suggestions.length} scene${suggestions.length === 1 ? '' : 's'} from ${media?.detectedScenes.length ?? 0} shots (${multi} with several shots)`;
  }, [suggestions, media]);

  if (!media) return null;
  const shots = media.detectedScenes;
  const update = (i: number, patch: Partial<SuggestedScene>) => setSuggestions((cur) => cur.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const joinNext = (i: number) => setSuggestions((cur) => {
    if (i >= cur.length - 1) return cur;
    const merged = { ...cur[i], shotIndices: [...cur[i].shotIndices, ...cur[i + 1].shotIndices] };
    return [...cur.slice(0, i), merged, ...cur.slice(i + 2)];
  });
  const splitAt = (i: number, k: number) => setSuggestions((cur) => {
    const g = cur[i];
    if (k <= 0 || k >= g.shotIndices.length) return cur;
    const tail: SuggestedScene = { shotIndices: g.shotIndices.slice(k), name: `${g.name} (2)`, accepted: g.accepted };
    return [...cur.slice(0, i), { ...g, shotIndices: g.shotIndices.slice(0, k) }, tail, ...cur.slice(i + 1)];
  });
  const create = () => { createSuggestedScenes(mediaId, suggestions); onClose(); };

  return (
    <Dialog open title={`Suggest Scenes · ${media.name}`} onClose={onClose} width={620}
      footer={<>
        <span className="text-dim text-sm grow">{links ? summary : 'Analysing…'}</span>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!links || !accepted} onClick={create} data-testid="suggest-create">{`Create ${accepted} Scene${accepted === 1 ? '' : 's'}`}</Button>
      </>}>
      {!links ? (
        <div className="col gap-6" data-testid="suggest-analysing">
          <div className="text-dim text-sm">Comparing the shots: what is said across each cut, how alike the pictures are, and whether the sound carries on.</div>
          <ProgressBar value={progress} />
        </div>
      ) : (
        <div className="col gap-6">
          <div className="row gap-6">
            <span className="text-dim text-sm">More, shorter scenes</span>
            <Slider value={join} min={0.1} max={0.9} step={0.05} onChange={setJoin} className="grow" title="How readily shots are joined into one scene" />
            <span className="text-dim text-sm">Fewer, longer</span>
          </div>
          <div className="list scroll-y" style={{ maxHeight: 360 }} data-testid="suggest-list">
            {suggestions.map((s, i) => {
              const first = shots[s.shotIndices[0]], last = shots[s.shotIndices[s.shotIndices.length - 1]];
              if (!first || !last) return null;
              return (
                <React.Fragment key={`${i}:${s.shotIndices[0]}`}>
                  <div className="list-item" style={{ gap: 6, padding: '2px 6px' }} data-testid="suggest-row">
                    <input type="checkbox" checked={s.accepted} onChange={(e) => update(i, { accepted: e.target.checked })} aria-label="Create this scene" />
                    <input className="input grow" value={s.name} onChange={(e) => update(i, { name: e.target.value })} spellCheck={false} aria-label="Scene name" />
                    <span className="mono text-faint text-xs" style={{ flexShrink: 0 }}>{clock(first.start)}–{clock(last.end)}</span>
                    <button type="button" className="btn btn-sm btn-ghost" style={{ flexShrink: 0 }} data-testid="suggest-shots" onClick={() => setOpen(open === i ? null : i)}
                      title="Show the shots (split the scene at one)">{s.shotIndices.length} shot{s.shotIndices.length === 1 ? '' : 's'}</button>
                    <button type="button" className="btn btn-sm btn-ghost" style={{ flexShrink: 0 }} disabled={i >= suggestions.length - 1} onClick={() => joinNext(i)}
                      title="Join with the next scene" data-testid="suggest-join">Join next</button>
                  </div>
                  {open === i ? s.shotIndices.map((si, k) => (
                    <div key={si} className="list-item text-sm" style={{ gap: 6, padding: '1px 6px 1px 32px' }}>
                      <span className="ellipsis grow">{shots[si].name}</span>
                      <span className="mono text-faint text-xs">{clock(shots[si].start)}–{clock(shots[si].end)}</span>
                      {k > 0 ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => splitAt(i, k)} title="Start a new scene at this shot">Split here</button> : null}
                    </div>
                  )) : null}
                </React.Fragment>
              );
            })}
          </div>
          <div className="text-faint text-xs">Untick a scene to skip it. Created scenes appear in the Scenes tab; the shots are unchanged.</div>
        </div>
      )}
    </Dialog>
  );
}
