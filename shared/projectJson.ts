/**
 * Project file text: the layout `serializeProject` writes for manual saves (one record per line).
 *
 * A 2-space pretty print of a franchise-scale project is 2.5x the size of compact JSON and about 3x slower to
 * produce (68 MB / ~320 ms vs 27 MB / ~110 ms for 2,500 clips in 12 sequences). Compact JSON is one line, which
 * makes a project under version control undiffable. This layout sits between the two: the structure (project,
 * sequences, tracks, snapshots, subtitle tracks, media items, settings) is indented two spaces per level with one
 * field per line, and each record inside it (a clip, transition, marker, story block, cue, scene, bin, detected
 * scene) is compact JSON on its own line. It is plain JSON: any JSON reader (and every build of the app) reads it, and
 * it parses to exactly what `JSON.stringify(project)` parses to. Readers accept any JSON layout.
 *
 * `projectJsonChunks` yields between records so a caller can spread the work over several tasks
 * (src/state/mediaActions.ts) instead of blocking the renderer for the whole project.
 *
 * Pure: no DOM, no Node.
 */
import type { Project } from './model';

/**
 * How a value is laid out: null = compact JSON; 'fields' = an object with one key per line, each value laid out by
 * `fields[key]` (compact when absent); 'items' = an array or keyed record with one entry per line, each entry laid
 * out by `item`. A value of another shape than its layout expects (or with a toJSON method) is written compact.
 */
type Layout = null | { kind: 'fields'; fields: Record<string, Layout> } | { kind: 'items'; item: Layout };

const fields = (f: Record<string, Layout>): Layout => ({ kind: 'fields', fields: f });
const items = (item: Layout): Layout => ({ kind: 'items', item });
/** One compact record per line. */
const LINES = items(null);

const TRACK = fields({ clips: LINES, transitions: LINES });
const SUBTITLE_TRACK = fields({ cues: LINES });
const SEQUENCE_BODY: Record<string, Layout> = {
  videoTracks: items(TRACK), audioTracks: items(TRACK), subtitleTracks: items(SUBTITLE_TRACK), markers: LINES, storyBlocks: LINES,
};
const SNAPSHOT = fields({ data: fields(SEQUENCE_BODY) });
const SEQUENCE = fields({ ...SEQUENCE_BODY, snapshots: items(SNAPSHOT) });
const MEDIA = fields({ detectedScenes: LINES, subtitleTrackIds: null });
const PROJECT_LAYOUT = fields({
  media: items(MEDIA), bins: LINES, sequences: items(SEQUENCE), scenes: LINES, subtitleTracks: items(SUBTITLE_TRACK),
  tags: fields({}), settings: fields({}),
});

/** Records written between two yields of projectJsonChunks (a yield costs about as much as one short record). */
const RECORDS_PER_YIELD = 200;

const INDENT: string[] = [''];
function indent(depth: number): string {
  while (INDENT.length <= depth) INDENT.push(INDENT[INDENT.length - 1] + '  ');
  return INDENT[depth];
}

function isPlainContainer(v: unknown): v is object {
  return v !== null && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON !== 'function';
}

/** JSON.stringify of one value; undefined when JSON would omit it (undefined, a function, a symbol). */
function compact(v: unknown): string | undefined {
  return JSON.stringify(v);
}

interface WriteState {
  out: string[];
  /** Records written so far (yield every RECORDS_PER_YIELD). */
  records: number;
  /** Compact JSON (no whitespace at all; the same text as JSON.stringify) instead of the line layout. */
  compact: boolean;
}

/**
 * Write `v` laid out by `layout` at nesting `depth` into `st.out`, yielding every RECORDS_PER_YIELD records. The
 * text is the same whether or not the caller pauses at the yields.
 */
function* write(v: unknown, layout: Layout, depth: number, st: WriteState): Generator<void, void, void> {
  const out = st.out;
  if (layout === null || !isPlainContainer(v) || (layout.kind === 'fields' && Array.isArray(v))) {
    out.push(compact(v) ?? 'null');
    return;
  }
  const isArray = Array.isArray(v);
  const keys = isArray ? null : Object.keys(v);
  const len = isArray ? (v as unknown[]).length : keys!.length;
  const close = isArray ? ']' : '}';
  const inner = st.compact ? '' : '\n' + indent(depth + 1);
  const sep = ',' + inner;
  const colon = st.compact ? ':' : ': ';
  let prefix = (isArray ? '[' : '{') + inner;
  let empty = true;
  for (let i = 0; i < len; i++) {
    const key = isArray ? null : keys![i];
    const x = isArray ? (v as unknown[])[i] : (v as Record<string, unknown>)[key!];
    const sub: Layout = layout.kind === 'items' ? layout.item : (Object.hasOwn(layout.fields, key!) ? layout.fields[key!] : null);
    if (sub === null || !isPlainContainer(x)) {
      const s = compact(x);
      if (s === undefined && !isArray) continue; // JSON omits the key
      out.push(isArray ? prefix + (s ?? 'null') : prefix + JSON.stringify(key) + colon + s);
      if (++st.records % RECORDS_PER_YIELD === 0) yield;
    } else {
      out.push(isArray ? prefix : prefix + JSON.stringify(key) + colon);
      yield* write(x, sub, depth + 1, st);
    }
    prefix = sep;
    empty = false;
  }
  out.push(empty ? (isArray ? '[]' : '{}') : (st.compact ? '' : '\n' + indent(depth)) + close);
}

/**
 * The project text in pieces: iterate to the end, then `out.join('')` is the text. Each `next()` writes about
 * RECORDS_PER_YIELD records. `compact` gives the same text as JSON.stringify(project) (autosaves); otherwise the
 * file layout of serializeProject. Do not change the project while iterating (store projects are immutable; a
 * sequence's LiveView may move its playhead in place, which is harmless).
 */
export function projectJsonChunks(project: Project, out: string[], opts: { compact?: boolean } = {}): Generator<void, void, void> {
  return write(project, PROJECT_LAYOUT, 0, { out, records: 0, compact: opts.compact === true });
}

/** The project file text (see the file comment), in one go. */
export function formatProjectJson(project: Project): string {
  const out: string[] = [];
  const it = projectJsonChunks(project, out);
  while (!it.next().done) { /* run to the end */ }
  return out.join('');
}
