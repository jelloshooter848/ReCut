/**
 * Audio track selection on media elements: HTMLMediaElement.audioTracks, which Chromium exposes behind the
 * AudioVideoTracks Blink feature (enabled in electron/main.ts). lib.dom has no typing for it.
 *
 * Chromium (Electron 33) switches tracks cleanly only before the element is sought: enabling another track on a
 * paused element whose seek has completed stalls playback (it never resumes; a later seek takes ~1.5 s to recover),
 * and a switch while playing freezes currentTime for 0.5–1.2 s. Choosing the track once, as soon as the metadata is
 * loaded and before the first seek, plays the right track within ~60 ms with the clock intact. So an element is
 * dedicated to one track (the players key elements by track) and is neither sought nor played until it is chosen.
 */

export interface MediaAudioTrack {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly language: string;
  enabled: boolean;
}

export interface MediaAudioTrackList extends EventTarget {
  readonly length: number;
  readonly [index: number]: MediaAudioTrack;
}

declare global {
  interface HTMLMediaElement {
    /** Chromium with the AudioVideoTracks feature; undefined elsewhere. */
    readonly audioTracks?: MediaAudioTrackList;
  }
}

const HAVE_METADATA = 1;

/**
 * Result of selectAudioTrack: 'ready' when the element plays the wanted track (or cannot choose: no track list, fewer
 * tracks than expected, a load error); 'waiting' while its metadata is not loaded (do not seek or play it yet);
 * 'switched' when the track was enabled by this call (seek the element before playing it).
 */
export type AudioTrackSelection = 'ready' | 'waiting' | 'switched';

/** Enable audio track `ordinal` of `el` (and only it). `ordinal` < 0 keeps the default track. */
export function selectAudioTrack(el: HTMLMediaElement, ordinal: number): AudioTrackSelection {
  if (ordinal < 0) return 'ready';
  const list = el.audioTracks;
  if (!list) return 'ready';
  if (el.readyState < HAVE_METADATA) return el.error ? 'ready' : 'waiting';
  if (ordinal >= list.length) return 'ready';
  let ok = true;
  for (let i = 0; i < list.length; i++) if (list[i].enabled !== (i === ordinal)) { ok = false; break; }
  if (ok) return 'ready';
  for (let i = 0; i < list.length; i++) list[i].enabled = i === ordinal;
  return 'switched';
}

/** Index of the enabled audio track of `el` (-1: none, or no track list). */
export function enabledAudioTrack(el: HTMLMediaElement): number {
  const list = el.audioTracks;
  if (!list) return -1;
  for (let i = 0; i < list.length; i++) if (list[i].enabled) return i;
  return -1;
}
