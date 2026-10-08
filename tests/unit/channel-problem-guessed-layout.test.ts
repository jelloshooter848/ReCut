/**
 * bugs/closed/2026-10-08-channel-warning-names-guessed-layout.md: when the probe guessed a stream's layout from its
 * channel count (PCM in Matroska stores none), a named channel cannot be used; the reason must say the layout is
 * unknown instead of presenting the guess ("the stream (5.1) has no Centre (FC) channel").
 */
import { describe, it, expect } from 'vitest';
import { channelSelectionProblem } from '@shared/audioChannels';

describe('channelSelectionProblem with a guessed layout', () => {
  const guessed = { channels: 6, layout: '5.1', layoutGuessed: true };
  it('says the layout is unknown and that channels are numbered', () => {
    const why = channelSelectionProblem({ mode: 'channel', channel: 'FC' }, guessed);
    expect(why).toBe('the stream (6 channels in an unknown layout) has no Centre (FC) channel; its channels are numbered');
  });
  it('a numbered channel past the count names the count, as before', () => {
    expect(channelSelectionProblem({ mode: 'channel', channel: 'c40' }, guessed)).toBe('the stream (6 channels in an unknown layout) has no Channel 41 channel');
  });
  it('a known layout is unchanged', () => {
    expect(channelSelectionProblem({ mode: 'channel', channel: 'TBR' }, { channels: 6, layout: '5.1' })).toBe('the stream (5.1) has no Top back right (TBR) channel');
    expect(channelSelectionProblem({ mode: 'downmix', centreDb: -3, surroundDb: -3 }, guessed)).toBe("the stream's channel layout is unknown");
  });
});
