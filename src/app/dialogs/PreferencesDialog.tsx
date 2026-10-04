/** Preferences dialog (ui.dialogs.preferences): project settings + read-only app info. */
import React, { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Toggle } from '@/components/ui/Toggle';
import { Select } from '@/components/ui/Select';
import { NumberField } from '@/components/ui/NumberField';
import { Slider } from '@/components/ui/Slider';
import { useStore } from '@/state/store';
import { recutApi } from '@/state/mediaActions';
import { resetAllLayouts } from '@/components/layout/layoutStore';
import { runCommand } from '@/keyboard/shortcuts';
import { COMMAND_IDS } from '@/keyboard/commandIds';
import type { AppInfo } from '@shared/ipc';
import type { ProjectSettings } from '@shared/model';
import { toast } from '@/components/ui/toastStore';

const PROXY_HEIGHTS = [{ value: '540', label: '540p' }, { value: '720', label: '720p' }, { value: '1080', label: '1080p' }];
const PLAYBACK_RES = [{ value: 'full', label: 'Full' }, { value: '1/2', label: '1/2' }, { value: '1/4', label: '1/4' }];

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="row" style={{ gap: 8, alignItems: 'center', minHeight: 26 }}>
      <label className="text-dim" style={{ width: 170, flexShrink: 0 }} title={hint}>{label}</label>
      <div className="grow row" style={{ gap: 8, alignItems: 'center', minWidth: 0 }}>{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="text-faint text-xs uppercase" style={{ letterSpacing: '0.06em' }}>{title}</div>
      {children}
    </div>
  );
}

export function PreferencesDialog() {
  const open = useStore((s) => s.ui.dialogs.preferences);
  const settings = useStore((s) => s.project.settings);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [threshold, setThreshold] = useState(settings.sceneThreshold);
  useEffect(() => { if (open) setThreshold(settings.sceneThreshold); }, [open, settings.sceneThreshold]);
  useEffect(() => {
    if (!open || info) return;
    recutApi()?.appInfo().then(setInfo).catch(() => setInfo(null));
  }, [open, info]);
  if (!open) return null;
  const close = () => useStore.getState().closeDialog('preferences');
  const set = (patch: Partial<ProjectSettings>) => useStore.getState().setSettings(patch);

  return (
    <Dialog open title="Preferences" onClose={close} width={560} footer={<Button variant="primary" onClick={close}>Done</Button>}>
      <div className="col" style={{ gap: 16 }} data-testid="preferences-dialog">
        <Section title="Project — media">
          <Row label="Use proxies for playback" hint="Prefer the proxy file when one is ready (originals are always used for export)">
            <Toggle checked={settings.useProxies} onChange={(v) => set({ useProxies: v })} />
          </Row>
          <Row label="Proxy height">
            <Select value={String(settings.proxyHeight)} options={PROXY_HEIGHTS} onChange={(v) => set({ proxyHeight: Number(v) })} />
          </Row>
          <Row label="Playback resolution">
            <Select value={settings.playbackResolution} options={PLAYBACK_RES} onChange={(v) => set({ playbackResolution: v as ProjectSettings['playbackResolution'] })} />
          </Row>
          <Row label="Scene detection threshold" hint="Higher values detect fewer, stronger cuts">
            <Slider value={threshold} min={0.05} max={0.95} step={0.01} onChange={setThreshold} onCommit={(v) => set({ sceneThreshold: v })} className="grow" />
            <span className="mono text-dim" style={{ width: 36, textAlign: 'right' }}>{threshold.toFixed(2)}</span>
          </Row>
        </Section>

        <Section title="Project — editing">
          <Row label="Autosave interval">
            <NumberField value={settings.autosaveIntervalSec} min={5} max={3600} step={5} unit="s" onChange={(v) => set({ autosaveIntervalSec: Math.max(5, Math.round(v)) })} />
          </Row>
          <Row label="Default transition" hint="Length of transitions added with Ctrl+D / Ctrl+Shift+D">
            <NumberField value={settings.defaultTransitionFrames} min={1} max={600} step={1} unit="frames" onChange={(v) => set({ defaultTransitionFrames: Math.max(1, Math.round(v)) })} />
          </Row>
          <Row label="Snapping"><Toggle checked={settings.snapping} onChange={(v) => set({ snapping: v })} /></Row>
          <Row label="Carry subtitles into sequence" hint="Copy the media's subtitle cues onto new clips">
            <Toggle checked={settings.carrySubtitles} onChange={(v) => set({ carrySubtitles: v })} />
          </Row>
          <Row label="Show source timecode on clips">
            <Toggle checked={settings.showSourceTimecodeOnClips} onChange={(v) => set({ showSourceTimecodeOnClips: v })} />
          </Row>
        </Section>

        <Section title="Application">
          <Row label="Cache folder">
            <span className="mono text-sm ellipsis grow" title={info?.cacheDir}>{info?.cacheDir ?? (recutApi() ? '…' : 'unavailable outside the desktop app')}</span>
            {info?.cacheDir ? <Button size="sm" onClick={() => recutApi()?.showItemInFolder(info.cacheDir).catch(() => toast('error', 'Could not open the cache folder'))}>Reveal</Button> : null}
          </Row>
          <Row label="FFmpeg">
            <span className="mono text-sm ellipsis grow" title={info?.ffmpegPath ?? ''}>
              {info ? (info.ffmpegPath ? `${info.ffmpegPath}${info.ffmpegVersion ? ` (${info.ffmpegVersion})` : ''}` : 'not found') : '…'}
            </span>
          </Row>
          <Row label="FFprobe"><span className="mono text-sm ellipsis grow" title={info?.ffprobePath ?? ''}>{info ? info.ffprobePath ?? 'not found' : '…'}</span></Row>
          <Row label="Version"><span className="text-sm">{info ? `ReCut ${info.version} · ${info.platform}${info.isDev ? ' · dev' : ''}` : '…'}</span></Row>
          <Row label="Layout">
            <Button size="sm" onClick={() => { resetAllLayouts(); toast('info', 'All workspaces reset'); }}>Reset layout</Button>
            <Button size="sm" onClick={() => { close(); runCommand(COMMAND_IDS.openShortcuts); }}>Keyboard shortcuts…</Button>
          </Row>
        </Section>
      </div>
    </Dialog>
  );
}
