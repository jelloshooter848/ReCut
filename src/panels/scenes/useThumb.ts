import { useEffect, useState } from 'react';
import { thumbs } from '@/app/media';

/** Resolves a thumbnail URL for `path` at `time` seconds via the shared ThumbnailCache. '' while loading / unavailable. */
export function useThumb(path: string | undefined, time: number, width: number, mediaId?: string): string {
  const [url, setUrl] = useState<string>(() => (path ? thumbs.peek(path, time, width) ?? '' : ''));
  useEffect(() => {
    if (!path) { setUrl(''); return; }
    const hit = thumbs.peek(path, time, width);
    if (hit) { setUrl(hit); return; }
    let alive = true;
    setUrl('');
    thumbs.get(path, time, width, mediaId).then((u) => { if (alive) setUrl(u); });
    return () => { alive = false; };
  }, [path, time, width, mediaId]);
  return url;
}
