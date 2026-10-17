import React from 'react';
import { TriangleAlert } from 'lucide-react';
import { FFMPEG_INSTALL_HELP } from '@shared/ipc';
import { PRODUCT_NAME, envVarName } from '@shared/productIdentity';
import { recutApi, useFfmpegStatus } from '@/state';

/** Persistent banner shown while FFmpeg or FFprobe is missing (import, proxies, thumbnails and export need both). */
export function FfmpegBanner() {
  const missing = useFfmpegStatus((s) => s.missing);
  if (!missing || !missing.length) return null;
  const what = missing.length === 2 ? 'FFmpeg and FFprobe were' : `${missing[0] === 'ffmpeg' ? 'FFmpeg' : 'FFprobe'} was`;
  const details = () => {
    void recutApi()?.message({
      type: 'warning', title: 'FFmpeg not found',
      message: `${what} not found.`,
      detail: `${PRODUCT_NAME} uses FFmpeg to read media, make thumbnails, waveforms and proxies, and to export. Until it is installed, import, proxies and export are unavailable.\n\n${FFMPEG_INSTALL_HELP}\n\nIf you package ${PRODUCT_NAME} yourself, put static ffmpeg and ffprobe binaries in resources/ffmpeg before running npm run dist.`,
      buttons: ['OK'],
    }).catch(() => undefined);
  };
  return (
    <div className="ffmpeg-banner" role="alert" data-testid="ffmpeg-banner">
      <TriangleAlert size={14} />
      <span className="grow">
        <strong>{what} not found.</strong> Import, proxies and export will not work until FFmpeg is installed or {envVarName('FFMPEG')} / {envVarName('FFPROBE')} point to it. Restart {PRODUCT_NAME} afterwards.
      </span>
      <button type="button" className="btn btn-ghost" onClick={details}>How to install…</button>
    </div>
  );
}
