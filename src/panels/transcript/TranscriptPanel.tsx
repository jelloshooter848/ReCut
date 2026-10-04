import React, { useEffect, useMemo, useState } from 'react';
import { FileText, FileUp, Mic, Search, Upload } from 'lucide-react';
import { useStore } from '@/state';
import { MenuButton, Tabs, type MenuItem } from '@/components/ui';
import type { PanelProps } from '../registry';
import { getProviders, type TranscriptProvider } from '@/transcript/providers';
import { SearchTab } from './SearchTab';
import { TranscriptView } from './TranscriptView';
import { importEmbedded, importSubtitlesDialog, targetMediaId, transcribeWith, useTranscriptIndex } from './shared';

type Tab = 'search' | 'transcript';

function useProviderAvailability(): Map<string, { available: boolean; reason?: string }> {
  const [map, setMap] = useState(new Map<string, { available: boolean; reason?: string }>());
  useEffect(() => {
    let alive = true;
    (async () => {
      const next = new Map<string, { available: boolean; reason?: string }>();
      for (const p of getProviders()) {
        let available = false; let reason: string | undefined;
        try { available = await p.available(); } catch { available = false; }
        if (!available) { try { reason = await p.unavailableReason?.(); } catch { /* ignore */ } }
        next.set(p.id, { available, reason });
      }
      if (alive) setMap(next);
    })();
    return () => { alive = false; };
  }, []);
  return map;
}

export function TranscriptPanel({ active }: PanelProps) {
  const [tab, setTab] = useState<Tab>('search');
  const index = useTranscriptIndex();
  const availability = useProviderAvailability();
  const sourceMediaId = useStore((s) => s.ui.sourceClip?.mediaId ?? null);
  const selectedMediaId = useStore((s) => s.ui.selectedMediaIds[0] ?? null);
  const target = sourceMediaId ?? selectedMediaId;
  const targetMedia = useStore((s) => (target ? s.project.media[target] : undefined));

  const importItems = useMemo((): MenuItem[] => {
    const mediaId = targetMediaId();
    const streams = targetMedia?.probe?.subtitles ?? [];
    const providers: TranscriptProvider[] = getProviders();
    return [
      { heading: targetMedia ? `For: ${targetMedia.name}` : 'No media selected' },
      { label: 'Import subtitles… (.srt / .vtt)', icon: FileUp, onSelect: () => { void importSubtitlesDialog(mediaId); } },
      {
        label: 'Embedded…', disabled: !mediaId || streams.length === 0,
        submenu: streams.map((s) => ({
          label: `#${s.index} ${s.language ?? 'und'}${s.title ? ` — ${s.title}` : ''} (${s.codec})`,
          onSelect: () => { if (mediaId) void importEmbedded(mediaId, s.index); },
        })),
      },
      { separator: true },
      {
        label: 'Transcribe…', icon: Mic, disabled: !mediaId,
        submenu: providers.map((p) => {
          const a = availability.get(p.id);
          const ok = a?.available ?? false;
          return {
            label: ok ? p.name : `${p.name} — ${a?.reason ?? 'not available'}`,
            disabled: !ok,
            onSelect: () => { if (mediaId) void transcribeWith(p, mediaId); },
          };
        }),
      },
    ];
  }, [targetMedia, availability]);

  return (
    <div className="panel tr-panel" data-testid="transcript-panel">
      <Tabs<Tab>
        tabs={[{ id: 'search', label: 'Search', icon: Search }, { id: 'transcript', label: 'Transcript', icon: FileText }]}
        active={tab} onChange={setTab}
        right={<MenuButton size="sm" variant="ghost" icon={Upload} label="Import" items={importItems} title="Import subtitles, extract embedded streams or transcribe" />}
      />
      <div className="panel-body col" style={{ overflow: 'hidden' }}>
        <div className={['col grow', tab === 'search' ? '' : 'hidden'].join(' ')}><SearchTab index={index} active={active && tab === 'search'} /></div>
        <div className={['col grow', tab === 'transcript' ? '' : 'hidden'].join(' ')}><TranscriptView active={active && tab === 'transcript'} /></div>
      </div>
      <div className="panel-footer" data-testid="transcript-stats">
        <span className="nowrap">{index.stats.mediaWithTranscripts} media with transcripts</span>
        <span className="text-faint">·</span>
        <span className="nowrap">{index.stats.cues} cues</span>
        {targetMedia ? <span className="ml-auto ellipsis text-faint" title={targetMedia.path}>{targetMedia.name}</span> : null}
      </div>
    </div>
  );
}
