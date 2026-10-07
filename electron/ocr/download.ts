/**
 * OCR language downloads: the verified downloader (electron/net/download.ts) with the OCR policy. Language files
 * come only from `https://raw.githubusercontent.com/` (pinned tessdata_fast files) and redirects stay on that origin;
 * a loopback origin is accepted only with `allowLoopback` (the test override RECUT_OCR_LANG_URL, read by the media
 * layer, never here).
 */
import {
  downloadVerified as downloadWithPolicy, isAllowedStartUrl, parseLoopbackBaseUrl,
  type DownloadPolicy, type DownloadVerifiedOptions as NetDownloadOptions,
} from '../net/download';

export { DownloadCanceledError, renameRetrying, sha256File } from '../net/download';

/** The only host language files are downloaded from (pinned tessdata_fast files). */
export const ALLOWED_DOWNLOAD_ORIGIN = 'https://raw.githubusercontent.com';

/** OCR downloads: raw.githubusercontent.com only, redirects within that origin only. */
export const OCR_DOWNLOAD_POLICY: DownloadPolicy = { origins: [ALLOWED_DOWNLOAD_ORIGIN], redirectHosts: [] };

export type DownloadVerifiedOptions = Omit<NetDownloadOptions, 'policy'>;

/** True when `url` may be downloaded from: the pinned https host, or (with `allowLoopback`) a loopback origin. */
export function isAllowedDownloadUrl(url: string, allowLoopback = false): boolean {
  return isAllowedStartUrl(url, OCR_DOWNLOAD_POLICY, allowLoopback);
}

/**
 * Normalized base URL from the RECUT_OCR_LANG_URL test override (ending in '/'), or null when it is unset or not a
 * loopback http(s) URL (a value pointing anywhere else is ignored, so the override can never send downloads to
 * another host).
 */
export function parseLangUrlOverride(value: string | undefined | null): string | null {
  return parseLoopbackBaseUrl(value);
}

/** Download one OCR language file (see electron/net/download.ts downloadVerified) under the OCR policy. */
export function downloadVerified(o: DownloadVerifiedOptions): Promise<void> {
  return downloadWithPolicy({ ...o, policy: OCR_DOWNLOAD_POLICY });
}
