/**
 * Content identity of a media file: a cheap fingerprint that survives moving, renaming, copying and relinking the
 * file, without hashing the whole of it (sources are often 20-40 GB remuxes).
 *
 * The fingerprint is the SHA-1 of a version tag, the file size and FINGERPRINT_BLOCKS blocks of FINGERPRINT_BLOCK
 * bytes: the first block, the last block and the rest spread evenly in between (a file no larger than all the blocks
 * together is hashed whole). That is 9 reads of 64 KiB, about 0.6 MB per file, whatever its size.
 *
 * Neither the path nor the modification time is part of it: copy tools (`cp` without `-p`, rsync without `-t`, some
 * NAS and cloud clients) do not keep mtimes, and the path is exactly what a move changes.
 *
 * Collision risk (two different files with one identity, so one is served the other's thumbnails, waveform, proxy,
 * scene cuts or OCR text):
 *  - Two independent media files: they must have exactly the same size AND the same bytes in all nine sampled blocks.
 *    Compressed audio and video differ everywhere, so this does not happen in practice (and SHA-1 is not the weak
 *    link: the sampled bytes are).
 *  - A file changed IN PLACE without changing its size, where every changed byte lies outside the sampled blocks
 *    (a hex patch, or a tag editor that rewrites a fixed-size field in the middle of the file). The old derived media
 *    would be reused. Clearing the cache folder fixes it. Tools that remux or re-encode change the size or the
 *    sampled bytes (container headers at the start, index at the end).
 *  - A preallocated file still being written (a torrent client's full-size file that is mostly zeros): two stages of
 *    the download could share sampled blocks. Import media once it is complete.
 *
 * Nothing here imports Electron; other caches (transcripts, ...) should key on `cacheKeyForPath` in ./cache.ts, which
 * is built on this.
 */
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';

/** Bumped when the sampling changes: every content key changes with it. */
export const FINGERPRINT_VERSION = 1;
/** Bytes per sampled block. */
export const FINGERPRINT_BLOCK = 64 * 1024;
/** Sampled blocks: first, last and the rest evenly spaced between them. */
export const FINGERPRINT_BLOCKS = 9;

/**
 * Offsets of the sampled blocks of a file of `size` bytes, ascending and distinct. A file of at most
 * FINGERPRINT_BLOCK * FINGERPRINT_BLOCKS bytes is read whole (one "block" at 0 covering it, see fingerprintFile).
 */
export function fingerprintOffsets(size: number): number[] {
  if (!(size > 0)) return [];
  if (size <= FINGERPRINT_BLOCK * FINGERPRINT_BLOCKS) return [0];
  const last = size - FINGERPRINT_BLOCK;
  const out: number[] = [];
  for (let i = 0; i < FINGERPRINT_BLOCKS; i++) {
    const off = Math.floor((last * i) / (FINGERPRINT_BLOCKS - 1));
    if (out[out.length - 1] !== off) out.push(off);
  }
  return out;
}

/** Hash input: version, size and the sampled bytes (each block prefixed by its offset). Exported for tests. */
export function fingerprintOfBlocks(size: number, blocks: { offset: number; bytes: Uint8Array }[]): string {
  const h = createHash('sha1');
  // frozen: changing this salt would change every media fingerprint, hence every content cache key: all cached
  // thumbnails, waveforms, proxies, scenes, OCR and Whisper results would be orphaned and rebuilt.
  h.update(`recut-media-fingerprint-v${FINGERPRINT_VERSION}\0${size}\0`);
  for (const b of blocks) {
    h.update(`${b.offset}:${b.bytes.byteLength}\0`);
    h.update(b.bytes);
  }
  return h.digest('hex');
}

/**
 * Content fingerprint of the file at `filePath` (40 hex characters). Reads at most ~0.6 MB. `size` may be passed
 * when the caller has just stat'ed the file; the read itself checks the file did not shrink under it.
 * Throws when the file cannot be read.
 */
export async function fingerprintFile(filePath: string, size?: number): Promise<string> {
  const fh = await fsp.open(filePath, 'r');
  try {
    const st = await fh.stat();
    const total = size ?? st.size;
    if (total !== st.size) throw new Error(`file size changed while fingerprinting ${filePath}`);
    const offsets = fingerprintOffsets(total);
    const whole = offsets.length === 1 && total <= FINGERPRINT_BLOCK * FINGERPRINT_BLOCKS;
    const blocks: { offset: number; bytes: Uint8Array }[] = [];
    for (const offset of offsets) {
      const len = whole ? total : FINGERPRINT_BLOCK;
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const { bytesRead } = await fh.read(buf, got, len - got, offset + got);
        if (bytesRead <= 0) break;
        got += bytesRead;
      }
      if (got !== len) throw new Error(`short read while fingerprinting ${filePath}`);
      blocks.push({ offset, bytes: buf });
    }
    return fingerprintOfBlocks(total, blocks);
  } finally {
    await fh.close().catch(() => undefined);
  }
}
