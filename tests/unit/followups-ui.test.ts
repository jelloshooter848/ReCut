/**
 * Follow-up fixes (dialogs):
 *  5. Preferences / Proxies take their ranges from shared/limits.ts (no hard-coded copies).
 *  7. Export dialog: switching to AC-3 clamps the sample rate; only rates the codec supports are offered.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { initialExportSettings } from '../../src/panels/export/settings';
import { patchExportSettings, sampleRateChoices } from '../../src/panels/export/ExportDialog';
import { createSequence } from '../../shared/project';

const ROOT = path.resolve(__dirname, '../..');
const src = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('5: single source for settings ranges', () => {
  it('PreferencesDialog has no hard-coded autosave / transition / proxy-height ranges', () => {
    const text = src('src/app/dialogs/PreferencesDialog.tsx');
    expect(text).not.toMatch(/\b3600\b/);
    expect(text).not.toMatch(/max=\{600\}/);
    expect(text).not.toMatch(/'1080'/);
    expect(text).toMatch(/AUTOSAVE_INTERVAL_MAX_SEC/);
    expect(text).toMatch(/DEFAULT_TRANSITION_FRAMES_MAX/);
    expect(text).toMatch(/PROXY_HEIGHTS/);
  });
  it('ProxiesTab takes its heights from shared/limits', () => {
    const text = src('src/panels/jobs/ProxiesTab.tsx');
    expect(text).not.toMatch(/'1080'/);
    expect(text).toMatch(/shared\/limits/);
  });
});

describe('7: export sample rate follows the audio codec', () => {
  const seq = createSequence('S', { num: 24, den: 1 });
  const base = { ...initialExportSettings(seq, null, { fallbackDir: '/x' }), audioCodec: 'aac' as const, sampleRate: 96000 };

  it('switching to AC-3 clamps 96 kHz to 48 kHz', () => {
    const next = patchExportSettings(base, { audioCodec: 'ac3' });
    expect(next.audioCodec).toBe('ac3');
    expect(next.sampleRate).toBe(48000);
  });

  it('the 5.1 shortcut (which switches to AC-3) clamps too', () => {
    expect(patchExportSettings(base, { audioChannels: 6, audioCodec: 'ac3' }).sampleRate).toBe(48000);
  });

  it('AAC keeps 96 kHz; patches always turn proxies off', () => {
    const next = patchExportSettings({ ...base, useProxies: true } as unknown as typeof base, { audioBitrateKbps: 320 });
    expect(next.sampleRate).toBe(96000);
    expect(next.useProxies).toBe(false);
  });

  it('AC-3 is offered 32 / 44.1 / 48 kHz only; AAC also gets 96 kHz', () => {
    expect(sampleRateChoices('ac3', 48000)).toEqual([32000, 44100, 48000]);
    expect(sampleRateChoices('aac', 48000)).toEqual([44100, 48000, 96000]);
    // an unusual current rate stays selectable when the codec supports it
    expect(sampleRateChoices('aac', 22050)).toEqual([22050, 44100, 48000, 96000]);
  });
});
