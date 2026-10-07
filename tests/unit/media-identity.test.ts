/**
 * Content identity of media files (electron/media/identity.ts) and the cache keys built on it
 * (electron/media/cache.ts): the fingerprint ignores path and mtime, samples fixed blocks, and the key lookups fall
 * back to the legacy path-based key.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recut-identity-'));
process.env.RECUT_CACHE_DIR = path.join(tmp, 'cache');

import {
  FINGERPRINT_BLOCK, FINGERPRINT_BLOCKS, fingerprintFile, fingerprintOffsets,
} from '../../electron/media/identity';
import {
  cacheKeyForFile, cacheKeyForPath, cacheKeysForPath, cacheSubdir, findCachedFile, identityStats, resetContentKeyMemo,
} from '../../electron/media/cache';

afterAll(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });
beforeEach(() => { resetContentKeyMemo(); });

/** Deterministic pseudo-random bytes (a different stream per seed). */
function bytes(n: number, seed = 1): Buffer {
  const b = Buffer.alloc(n);
  let x = seed * 2654435761 >>> 0;
  for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 0xff; }
  return b;
}

function write(rel: string, data: Buffer): string {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}

describe('fingerprintOffsets', () => {
  it('reads small files whole and samples first, last and evenly spaced blocks of large ones', () => {
    expect(fingerprintOffsets(0)).toEqual([]);
    expect(fingerprintOffsets(100)).toEqual([0]);
    expect(fingerprintOffsets(FINGERPRINT_BLOCK * FINGERPRINT_BLOCKS)).toEqual([0]);
    const size = 40 * 1024 ** 3; // a 40 GB remux
    const offs = fingerprintOffsets(size);
    expect(offs).toHaveLength(FINGERPRINT_BLOCKS);
    expect(offs[0]).toBe(0);
    expect(offs[offs.length - 1]).toBe(size - FINGERPRINT_BLOCK);
    for (let i = 1; i < offs.length; i++) expect(offs[i]).toBeGreaterThan(offs[i - 1] + FINGERPRINT_BLOCK - 1);
    // just over the whole-file limit: blocks overlap but stay distinct and in range
    const small = fingerprintOffsets(FINGERPRINT_BLOCK * FINGERPRINT_BLOCKS + 1);
    expect(new Set(small).size).toBe(small.length);
    expect(Math.max(...small)).toBe(FINGERPRINT_BLOCK * FINGERPRINT_BLOCKS + 1 - FINGERPRINT_BLOCK);
  });
});

describe('fingerprintFile', () => {
  const big = bytes(3 * 1024 * 1024 + 123, 7);

  it('is the same for a copy at another path with another mtime, and differs for other content', async () => {
    const a = write('a/movie.mkv', big);
    const b = write('b/elsewhere/renamed.mkv', big);
    fs.utimesSync(b, new Date(1_600_000_000_000), new Date(1_600_000_000_000));
    expect(await fingerprintFile(a)).toBe(await fingerprintFile(b));
    expect(await fingerprintFile(a)).toMatch(/^[0-9a-f]{40}$/);
    const other = write('c/other.mkv', bytes(big.length, 8));
    expect(await fingerprintFile(other)).not.toBe(await fingerprintFile(a));
  });

  it('changes with the size, and with a byte inside a sampled block; not with a byte between blocks (documented risk)', async () => {
    const base = await fingerprintFile(write('d/base.mkv', big));
    expect(await fingerprintFile(write('d/longer.mkv', Buffer.concat([big, Buffer.from([0])])))).not.toBe(base);
    const offs = fingerprintOffsets(big.length);
    for (const at of [offs[0] + 10, offs[4] + 100, big.length - 1]) {
      const changed = Buffer.from(big);
      changed[at] ^= 0xff;
      expect(await fingerprintFile(write(`d/changed-${at}.mkv`, changed)), `byte ${at}`).not.toBe(base);
    }
    // A byte outside every sampled block is not seen: same size, same samples (the collision risk in identity.ts).
    const gap = offs[1] + FINGERPRINT_BLOCK + 5;
    expect(offs.some((o) => gap >= o && gap < o + FINGERPRINT_BLOCK)).toBe(false);
    const unseen = Buffer.from(big);
    unseen[gap] ^= 0xff;
    expect(await fingerprintFile(write('d/unseen.mkv', unseen))).toBe(base);
  });

  it('hashes small files whole', async () => {
    const small = bytes(5000, 3);
    const base = await fingerprintFile(write('e/s.srt', small));
    const changed = Buffer.from(small);
    changed[2500] ^= 1;
    expect(await fingerprintFile(write('e/s2.srt', changed))).not.toBe(base);
  });

  it('throws for a missing file', async () => {
    await expect(fingerprintFile(path.join(tmp, 'missing.mkv'))).rejects.toThrow();
  });
});

describe('cache keys', () => {
  it('content key: equal for copies; legacy key: path + size + mtime as before', async () => {
    const data = bytes(1024 * 1024, 11);
    const a = write('k/one/title_t00.mkv', data);
    const b = write('k/two/title_t00.mkv', data);
    const ka = await cacheKeysForPath(a), kb = await cacheKeysForPath(b);
    expect(ka.key).toBe(kb.key);
    expect(ka.legacyKey).not.toBe(kb.legacyKey);
    const st = fs.statSync(a);
    expect(ka.legacyKey).toBe(cacheKeyForFile(a, st.size, st.mtimeMs));
    expect(ka.key).not.toBe(ka.legacyKey);
    expect(ka.size).toBe(data.length);
    await expect(cacheKeyForPath('relative/path.mkv')).rejects.toThrow(/absolute/);
  });

  it('fingerprints a file once: remembered in memory, then in the on-disk index', async () => {
    const a = write('m/x.mkv', bytes(2 * 1024 * 1024, 12));
    const n0 = identityStats.fingerprinted;
    const k = await cacheKeyForPath(a);
    await Promise.all([cacheKeyForPath(a), cacheKeyForPath(a)]);
    expect(identityStats.fingerprinted).toBe(n0 + 1);
    resetContentKeyMemo(); // a new session: the index file answers
    expect(await cacheKeyForPath(a)).toBe(k);
    expect(identityStats.fingerprinted).toBe(n0 + 1);
    // A changed file (new size / mtime) is a new legacy key, so it is fingerprinted again.
    fs.appendFileSync(a, 'more');
    expect(await cacheKeyForPath(a)).not.toBe(k);
    expect(identityStats.fingerprinted).toBe(n0 + 2);
    // A corrupt index entry is ignored.
    const keys = await cacheKeysForPath(a);
    fs.writeFileSync(path.join(cacheSubdir('ids'), keys.legacyKey), 'garbage');
    resetContentKeyMemo();
    expect(await cacheKeyForPath(a)).toBe(keys.key);
  });

  it('findCachedFile: content key first, then the legacy key (adopted by a hard link), else null', async () => {
    const dir = path.join(tmp, 'lookup');
    fs.mkdirSync(dir, { recursive: true });
    const pathFor = (k: string) => path.join(dir, `${k}.json`);
    const keys = { key: 'c'.repeat(40), legacyKey: 'l'.repeat(40) };
    expect(await findCachedFile(keys, pathFor)).toBeNull();
    fs.writeFileSync(pathFor(keys.legacyKey), '{"old":true}');
    const hit = await findCachedFile(keys, pathFor);
    expect(hit).toBe(pathFor(keys.key));
    expect(fs.readFileSync(pathFor(keys.key), 'utf8')).toBe('{"old":true}');
    expect(fs.statSync(pathFor(keys.key)).ino).toBe(fs.statSync(pathFor(keys.legacyKey)).ino);
    // The content entry wins once it exists; `accept` can reject a corrupt one.
    fs.rmSync(pathFor(keys.key));
    fs.writeFileSync(pathFor(keys.key), '{"new":true}');
    expect(await findCachedFile(keys, pathFor)).toBe(pathFor(keys.key));
    expect(await findCachedFile(keys, pathFor, async (f) => f === pathFor(keys.legacyKey))).toBe(pathFor(keys.key)); // EEXIST: adopted already
    expect(await findCachedFile(keys, pathFor, async () => false)).toBeNull();
  });
});
