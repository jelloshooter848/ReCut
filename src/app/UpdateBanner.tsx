import React from 'react';
import { Info, X } from 'lucide-react';
import { PRODUCT_NAME } from '@shared/productIdentity';
import { dismissUpdateNotice, noticeRelease, openReleasePage, setUpdateCheckSetting, showsUpdatePrompt, skipUpdateVersion, useUpdateStore } from './updates';

/**
 * Update banners, in the same place and style as the FFmpeg-missing banner (src/app/FfmpegBanner.tsx):
 *  - the one-time opt-in prompt while Preferences › Check for updates is still "ask";
 *  - the notice when a newer release exists (Release notes / Skip this version / close for this session).
 * Neither is modal; nothing is downloaded or installed.
 */
export function UpdateBanner() {
  const status = useUpdateStore((s) => s.status);
  const dismissed = useUpdateStore((s) => s.dismissed);
  const release = noticeRelease(status, dismissed);
  return (
    <>
      {showsUpdatePrompt(status) ? (
        <div className="ffmpeg-banner update-banner" role="status" data-testid="update-prompt">
          <Info size={14} />
          <span className="grow">
            <strong>Check for new {PRODUCT_NAME} versions on GitHub once a day?</strong> Only the request itself is sent; nothing is
            downloaded or installed. You can change this in Preferences.
          </span>
          <button type="button" className="btn btn-primary" onClick={() => void setUpdateCheckSetting('on')}>Yes</button>
          <button type="button" className="btn btn-ghost" onClick={() => void setUpdateCheckSetting('off')}>No</button>
        </div>
      ) : null}
      {release ? (
        <div className="ffmpeg-banner update-banner" role="status" data-testid="update-notice">
          <Info size={14} />
          <span className="grow">
            <strong>{PRODUCT_NAME} {release.version} is available</strong> — {' '}
            <button type="button" className="link-button" onClick={() => void openReleasePage(release.url)}>Release notes</button>
          </span>
          <button type="button" className="btn btn-ghost" onClick={() => void skipUpdateVersion(release.version)}>Skip this version</button>
          <button type="button" className="btn btn-ghost update-banner-close" aria-label="Close" title="Close (shown again next time)" onClick={() => dismissUpdateNotice(release.version)}>
            <X size={14} />
          </button>
        </div>
      ) : null}
    </>
  );
}
