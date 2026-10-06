/**
 * src/playback/thumbnails.ts ThumbnailCache holds one loaded image per cached recut-media:// thumbnail URL, so Blink
 * keeps it in its memory cache and a re-mounted tile <img> is not loaded again; the hold follows the LRU (eviction,
 * invalidate, clear release it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThumbnailCache } from '../../src/playback/thumbnails';

class FakeImage {
  static live = new Set<FakeImage>();
  decoding = '';
  private s = '';
  get src(): string { return this.s; }
  set src(v: string) { this.s = v; if (v) FakeImage.live.add(this); }
  removeAttribute(n: string): void { if (n === 'src') { this.s = ''; FakeImage.live.delete(this); } }
}
const url = (t: number) => `recut-media://local/%2Fcache%2Fthumbs%2Fab%2F${t * 1000}_96.jpg`;
const g = globalThis as Record<string, unknown>;

beforeEach(() => {
  FakeImage.live.clear();
  g.Image = FakeImage;
  g.window = {
    recut: {
      thumbnail: vi.fn(async (req: { time: number }) => url(req.time)),
      filmstrip: vi.fn(async (req: { times: number[] }) => req.times.map((t) => (t === 99 ? 'recut-media://local/' : url(t)))),
    },
  };
});
afterEach(() => { delete g.Image; delete g.window; });

const liveSrcs = () => [...FakeImage.live].map((i) => i.src).sort();

describe('ThumbnailCache image hold', () => {
  it('holds one image per cached URL, from get and filmstrip, none for empty results', async () => {
    const tc = new ThumbnailCache(10);
    await tc.get('/a.mkv', 1, 96);
    await tc.get('/a.mkv', 1, 96); // cached: no second hold
    await tc.filmstrip('/a.mkv', [1, 2, 3, 99], 96);
    expect(liveSrcs()).toEqual([url(1), url(2), url(3)].sort());
    for (const img of FakeImage.live) expect(img.decoding).toBe('async');
  });

  it('releases the hold when the LRU evicts, on invalidate and on clear', async () => {
    const tc = new ThumbnailCache(2);
    await tc.filmstrip('/a.mkv', [1, 2], 96);
    await tc.get('/a.mkv', 3, 96); // evicts t=1
    expect(liveSrcs()).toEqual([url(2), url(3)].sort());
    await tc.get('/b.mkv', 4, 96); // evicts t=2
    tc.invalidate('/a.mkv');
    expect(liveSrcs()).toEqual([url(4)]);
    tc.clear();
    expect(liveSrcs()).toEqual([]);
    expect(tc.size).toBe(0);
  });

  it('holds nothing without a DOM Image or for non recut-media URLs', async () => {
    delete g.Image;
    const tc = new ThumbnailCache(10);
    await expect(tc.get('/a.mkv', 1, 96)).resolves.toBe(url(1));
    g.Image = FakeImage;
    (g.window as { recut: { thumbnail: unknown } }).recut.thumbnail = vi.fn(async () => 'blob:x');
    await tc.get('/a.mkv', 5, 96);
    expect(FakeImage.live.size).toBe(0);
  });
});
