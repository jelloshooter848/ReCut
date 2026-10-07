/**
 * Pure edits of an MKV export's output audio tracks and soft subtitle streams (ROADMAP §7), used by the Export dialog
 * (PackagingEditors.tsx). Each returns the settings patch to apply; no DOM, no zustand (unit-tested in
 * tests/unit/export-mkv-plan.test.ts).
 *
 * While `audioOutputs` is absent the export has its one main mix (resolveAudioOutputs); the first edit writes that
 * mix out as an explicit list, and choosing "Main mix only" removes the list again.
 */
import type { ExportAudioOutput, ExportSettings, ExportSubtitleOutput, ID, Sequence } from '@shared/model';
import { audioOutputPreset, defaultOutputBitrate, hasAudioOutputs, resolveAudioOutputs, type AudioOutputPresetId } from '@shared/exportFormat';

/** Most output audio tracks the dialog adds (Matroska has no real limit; this keeps the dialog usable). */
export const MAX_AUDIO_OUTPUTS = 8;

/** The output tracks shown in the dialog: the explicit list, or the one main mix the settings describe. */
export function displayedAudioOutputs(settings: ExportSettings): ExportAudioOutput[] {
  return resolveAudioOutputs(settings).map((o) => ({ ...o }));
}

/** Replace output `i` with `patch` applied (writes the list out first). */
export function updateAudioOutput(settings: ExportSettings, i: number, patch: Partial<ExportAudioOutput>): Partial<ExportSettings> {
  const outs = displayedAudioOutputs(settings);
  if (!outs[i]) return {};
  const next = { ...outs[i], ...patch };
  // A new codec or layout gets that combination's default bitrate unless one is given.
  if ((patch.codec !== undefined || patch.layout !== undefined) && patch.bitrateKbps === undefined) {
    next.bitrateKbps = next.codec === 'aac' || next.codec === 'ac3' ? defaultOutputBitrate(next.codec, next.layout) : undefined;
  }
  if (next.bitrateKbps === undefined) delete next.bitrateKbps;
  outs[i] = next;
  return { audioOutputs: outs };
}

/** Add a stereo AAC mix of every track at the end (at most MAX_AUDIO_OUTPUTS). */
export function addAudioOutput(settings: ExportSettings): Partial<ExportSettings> {
  const outs = displayedAudioOutputs(settings);
  if (outs.length >= MAX_AUDIO_OUTPUTS) return {};
  outs.push({ layout: 'stereo', codec: 'aac', bitrateKbps: defaultOutputBitrate('aac', 'stereo') });
  return { audioOutputs: outs };
}

/** Remove output `i`; the last one cannot be removed (an MKV always has audio). */
export function removeAudioOutput(settings: ExportSettings, i: number): Partial<ExportSettings> {
  const outs = displayedAudioOutputs(settings);
  if (outs.length <= 1 || !outs[i]) return {};
  outs.splice(i, 1);
  return { audioOutputs: outs };
}

/** Move output `i` by `delta` (-1 up, +1 down). The first output is the default track. */
export function moveAudioOutput(settings: ExportSettings, i: number, delta: number): Partial<ExportSettings> {
  const outs = displayedAudioOutputs(settings);
  const j = i + delta;
  if (!outs[i] || j < 0 || j >= outs.length) return {};
  [outs[i], outs[j]] = [outs[j], outs[i]];
  return { audioOutputs: outs };
}

/**
 * Turn sequence audio track `trackId` on or off as a source of output `i`. Turning one off in an "all tracks" mix
 * lists every other track; `allTracks` sets the mix back to every rendered track.
 */
export function setAudioOutputSource(settings: ExportSettings, seq: Pick<Sequence, 'audioTracks'>, i: number, trackId: ID | 'all', on: boolean): Partial<ExportSettings> {
  const outs = displayedAudioOutputs(settings);
  const o = outs[i];
  if (!o) return {};
  if (trackId === 'all') {
    if (on) delete o.sources; else o.sources = [];
    return { audioOutputs: outs };
  }
  const current = Array.isArray(o.sources) ? o.sources : seq.audioTracks.map((t) => t.id);
  const set = new Set(current.filter((id) => id !== trackId));
  if (on) set.add(trackId);
  // Keep sequence order.
  o.sources = seq.audioTracks.map((t) => t.id).filter((id) => set.has(id));
  return { audioOutputs: outs };
}

/** The output tracks of a preset ('main': no list, the one main mix). */
export function applyAudioOutputPreset(id: AudioOutputPresetId, seq: Pick<Sequence, 'audioTracks'>): Partial<ExportSettings> {
  return { audioOutputs: audioOutputPreset(id, seq) };
}

/** The subtitle outputs, in sequence order, with `trackId` added (`on`) or removed. */
export function setSubtitleIncluded(settings: ExportSettings, seq: Pick<Sequence, 'subtitleTracks'>, trackId: ID, on: boolean): Partial<ExportSettings> {
  const cur = Array.isArray(settings.subtitleOutputs) ? settings.subtitleOutputs.filter((o) => o && o.trackId !== trackId) : [];
  if (on) cur.push({ trackId });
  const order = seq.subtitleTracks.map((t) => t.id);
  cur.sort((a, b) => order.indexOf(a.trackId) - order.indexOf(b.trackId));
  return { subtitleOutputs: cur.length ? cur : undefined };
}

/** Patch the subtitle output of `trackId`. Default is exclusive: marking one default clears the others. */
export function updateSubtitleOutput(settings: ExportSettings, trackId: ID, patch: Partial<Omit<ExportSubtitleOutput, 'trackId'>>): Partial<ExportSettings> {
  const cur = Array.isArray(settings.subtitleOutputs) ? settings.subtitleOutputs.map((o) => ({ ...o })) : [];
  const o = cur.find((x) => x.trackId === trackId);
  if (!o) return {};
  Object.assign(o, patch);
  if (patch.default === true) for (const x of cur) if (x !== o) delete x.default;
  for (const k of ['default', 'forced'] as const) if (o[k] === false) delete o[k];
  return { subtitleOutputs: cur };
}

/** True when the settings carry an explicit output track list (not the derived main mix). */
export { hasAudioOutputs };
