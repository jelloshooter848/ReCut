/** Minimal XML tree and serializer for the FCPXML writer (attribute order kept, two-space indent). Pure. */

export interface XNode {
  name: string;
  attrs: [string, string | undefined][];
  /** Children, then anchored items (connected clips / storylines), then markers: FCPXML's required order. */
  kids: XNode[];
  anchors: XNode[];
  marks: XNode[];
}

export function el(name: string, attrs: [string, string | undefined][] = [], kids: XNode[] = []): XNode {
  return { name, attrs, kids, anchors: [], marks: [] };
}

// Characters XML 1.0 does not allow (C0 controls other than tab / LF / CR, lone surrogates, U+FFFE / U+FFFF).
// eslint-disable-next-line no-control-regex
const INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

export function escapeAttr(v: string): string {
  return v.replace(INVALID, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
}

export function serialize(n: XNode, depth = 0): string {
  const pad = '  '.repeat(depth);
  const attrs = n.attrs.filter(([, v]) => v !== undefined).map(([k, v]) => ` ${k}="${escapeAttr(v!)}"`).join('');
  const kids = [...n.kids, ...n.anchors, ...n.marks];
  if (!kids.length) return `${pad}<${n.name}${attrs}/>\n`;
  return `${pad}<${n.name}${attrs}>\n${kids.map((k) => serialize(k, depth + 1)).join('')}${pad}</${n.name}>\n`;
}
