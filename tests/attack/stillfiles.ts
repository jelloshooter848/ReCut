/**
 * Test-only writers for still images FFmpeg cannot (or not always) produce: a single-image HEIC (or AVIF) built from a
 * one-frame HEVC (AV1) mp4, optionally with an `irot` rotation (FFmpeg has no HEIF muxer, and its AVIF muxer writes no
 * irot), and a JPEG with an EXIF orientation tag.
 */
import fs from 'node:fs';

interface Box { type: string; start: number; hdr: number; end: number }

function boxes(buf: Buffer, start: number, end: number): Box[] {
  const res: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; }
    if (size === 0) size = end - p;
    if (size < hdr) break;
    res.push({ type, start: p, hdr, end: p + size });
    p += size;
  }
  return res;
}

function child(buf: Buffer, parent: Box, ...types: string[]): Box {
  let cur = parent;
  for (const t of types) {
    const b = boxes(buf, cur.start + cur.hdr, cur.end).find((x) => x.type === t);
    if (!b) throw new Error(`mp4 box not found: ${t}`);
    cur = b;
  }
  return cur;
}

const u8 = (n: number) => Buffer.from([n & 0xff]);
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const str = (t: string) => Buffer.from(t, 'latin1');
function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), str(type), body]);
}
function fullBox(type: string, version: number, flags: number, ...parts: Buffer[]): Buffer {
  return box(type, u32(((version & 0xff) << 24) | (flags & 0xffffff)), ...parts);
}

/**
 * Write a single-image HEIF from a one-frame mp4: HEVC (`-c:v libx265 -tag:v hvc1`) gives a HEIC (`ftyp heic`, an
 * `hvc1` item with hvcC + ispe), AV1 (`-c:v libaom-av1`) an AVIF (`ftyp avif`, an `av01` item with av1C + ispe).
 * `irotQuarterTurns` adds an `irot` property (counter-clockwise quarter turns).
 */
export function writeHeifFromMp4(mp4Path: string, outPath: string, irotQuarterTurns?: number): void {
  const mp4 = fs.readFileSync(mp4Path);
  const root: Box = { type: 'root', start: 0, hdr: 0, end: mp4.length };
  const trak = child(mp4, root, 'moov', 'trak');
  const tkhd = child(mp4, trak, 'tkhd');
  const width = mp4.readUInt32BE(tkhd.end - 8) >>> 16, height = mp4.readUInt32BE(tkhd.end - 4) >>> 16;
  const stbl = child(mp4, trak, 'mdia', 'minf', 'stbl');
  const stsd = child(mp4, stbl, 'stsd');
  const entry = boxes(mp4, stsd.start + stsd.hdr + 8, stsd.end)[0];
  // VisualSampleEntry: 8-byte header + 78 bytes of fields, then child boxes.
  const av1 = entry.type === 'av01';
  const cfgType = av1 ? 'av1C' : 'hvcC';
  const hvcC = boxes(mp4, entry.start + 8 + 78, entry.end).find((b) => b.type === cfgType);
  if (!hvcC) throw new Error(`no ${cfgType} in sample entry ${entry.type}`);
  const stsz = child(mp4, stbl, 'stsz');
  const fixed = mp4.readUInt32BE(stsz.start + stsz.hdr + 4);
  const sampleSize = fixed || mp4.readUInt32BE(stsz.start + stsz.hdr + 12);
  const stco = child(mp4, stbl, 'stco');
  const sampleOff = mp4.readUInt32BE(stco.start + stco.hdr + 8);
  const sample = mp4.subarray(sampleOff, sampleOff + sampleSize);

  const props = [mp4.subarray(hvcC.start, hvcC.end), fullBox('ispe', 0, 0, u32(width), u32(height))];
  if (irotQuarterTurns !== undefined) props.push(box('irot', u8(irotQuarterTurns & 3)));
  const brand = av1 ? 'avif' : 'heic';
  const ftyp = box('ftyp', str(brand), u32(0), str('mif1'), str(brand), str('miaf'));
  const meta = (dataOffset: number) => fullBox('meta', 0, 0,
    fullBox('hdlr', 0, 0, u32(0), str('pict'), u32(0), u32(0), u32(0), u8(0)),
    fullBox('pitm', 0, 0, u16(1)),
    fullBox('iloc', 0, 0, u8(0x44), u8(0x00), u16(1), u16(1), u16(0), u16(1), u32(dataOffset), u32(sample.length)),
    fullBox('iinf', 0, 0, u16(1), fullBox('infe', 2, 0, u16(1), u16(0), str(av1 ? 'av01' : 'hvc1'), u8(0))),
    box('iprp', box('ipco', ...props), fullBox('ipma', 0, 0, u32(1), u16(1), u8(props.length), ...props.map((_, i) => u8((i === 0 ? 0x80 : 0) | (i + 1))))),
  );
  const dataOffset = ftyp.length + meta(0).length + 8;
  fs.writeFileSync(outPath, Buffer.concat([ftyp, meta(dataOffset), box('mdat', sample)]));
}

/** Copy a JPEG, inserting an EXIF APP1 segment (big-endian TIFF, IFD0 with one Orientation entry) after SOI. */
export function writeJpegWithOrientation(jpegPath: string, outPath: string, orientation: number): void {
  const jpg = fs.readFileSync(jpegPath);
  if (jpg.readUInt16BE(0) !== 0xffd8) throw new Error('not a JPEG');
  const tiff = Buffer.concat([
    str('MM'), u16(42), u32(8), // header, IFD0 at 8
    u16(1), u16(0x0112), u16(3), u32(1), u16(orientation), u16(0), // one SHORT entry, value left-aligned
    u32(0), // no next IFD
  ]);
  const payload = Buffer.concat([str('Exif\0\0'), tiff]);
  fs.writeFileSync(outPath, Buffer.concat([jpg.subarray(0, 2), u16(0xffe1), u16(payload.length + 2), payload, jpg.subarray(2)]));
}
