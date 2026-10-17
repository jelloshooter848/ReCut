/**
 * #133: every export to an exFAT drive failed at the end with "The render file ... was replaced by another file during
 * the export". exFAT has no inode numbers; macOS gives an empty file a made-up one that changes once the file has data
 * (measured on a Samsung T7: dev:-5468 empty, dev:10064254 after 1 MB). The render file is now also recognised by its
 * device and creation time, which exFAT keeps.
 */
import { describe, it, expect } from 'vitest';
import { sameRenderFile, type RenderFileStamp } from '../../electron/export/exporter';

const reserved: RenderFileStamp = { id: '16777270:-5468', dev: 16777270n, birthNs: 1791584943710000000n };

describe('sameRenderFile', () => {
  it('the same dev:ino is the same file', () => {
    expect(sameRenderFile(reserved, { id: '16777270:-5468', dev: 16777270n, birthNs: 1n, isFile: true })).toBe(true);
  });

  it('exFAT: the inode number changed once ffmpeg wrote data, same device and creation time: still ours', () => {
    expect(sameRenderFile(reserved, { id: '16777270:10064254', dev: 16777270n, birthNs: 1791584943710000000n, isFile: true })).toBe(true);
  });

  it('another file put there (other creation time, other device, a symlink, or nothing) is refused', () => {
    expect(sameRenderFile(reserved, { id: '16777270:999', dev: 16777270n, birthNs: 1791584999000000000n, isFile: true })).toBe(false);
    expect(sameRenderFile(reserved, { id: '5:10064254', dev: 5n, birthNs: 1791584943710000000n, isFile: true })).toBe(false);
    expect(sameRenderFile(reserved, { id: '16777270:10064254', dev: 16777270n, birthNs: 1791584943710000000n, isFile: false })).toBe(false);
    expect(sameRenderFile(reserved, null)).toBe(false);
  });

  it('without a creation time (a file system that reports none) only the identity counts', () => {
    const noBirth: RenderFileStamp = { id: '9:1', dev: 9n, birthNs: 0n };
    expect(sameRenderFile(noBirth, { id: '9:2', dev: 9n, birthNs: 0n, isFile: true })).toBe(false);
    expect(sameRenderFile(noBirth, { id: '9:1', dev: 9n, birthNs: 0n, isFile: true })).toBe(true);
  });
});
