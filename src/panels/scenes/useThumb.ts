import { useEffect, useState } from 'react';
import { thumbs } from '@/app/media';

/** Uncached thumbnails are requested only after the row has stayed mounted this long (ms): typing in the filter or
 *  scrolling the virtualised list must not spawn ffmpeg work for rows that vanish on the next keystroke / frame. */
const SETTLE_MS = 200;

/** Resolves a thumbnail URL for `path` at `time` seconds via the shared ThumbnailCache. '' while loading / unavailable. */
export function useThumb(path: string | undefined, time: number, width: number, mediaId?: string): string {
  const [url, setUrl] = useState<string>(() => (path ? thumbs.peek(path, time, width) ?? '' : ''));
  useEffect(() => {
    if (!path) { setUrl(''); return; }
    const hit = thumbs.peek(path, time, width);
    if (hit) { setUrl(hit); return; }
    let alive = true;
    setUrl('');
    const timer = window.setTimeout(() => { thumbs.get(path, time, width, mediaId).then((u) => { if (alive) setUrl(u); }); }, SETTLE_MS);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [path, time, width, mediaId]);
  return url;
}
