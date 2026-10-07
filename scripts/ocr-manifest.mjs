#!/usr/bin/env node
/**
 * Dev tool: regenerate the OCR language manifest (`OCR_LANGUAGES` in shared/ocr.ts).
 *
 * Downloads each language file listed below from the pinned tessdata_fast commit (TESSDATA_BASE in
 * shared/ocr.ts), measures its size and SHA-256 and prints the manifest. With `--write` it replaces the block
 * between `// <ocr-manifest>` and `// </ocr-manifest>` in shared/ocr.ts. Files that cannot be fetched are left
 * out (and listed on stderr). Tests never run this; they check the committed manifest.
 *
 *   node scripts/ocr-manifest.mjs [--write] [--only eng,fra]
 *
 * Behind an HTTP proxy, run it with NODE_USE_ENV_PROXY=1 (Node >= 22.21) so fetch uses HTTPS_PROXY.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ocrTs = path.join(root, 'shared', 'ocr.ts');

/** Languages offered for install: [tessdata code, English name]. Edit this list, then rerun with --write. */
const LANGUAGES = [
  ['afr', 'Afrikaans'], ['sqi', 'Albanian'], ['ara', 'Arabic'], ['hye', 'Armenian'], ['eus', 'Basque'],
  ['bel', 'Belarusian'], ['ben', 'Bengali'], ['bos', 'Bosnian'], ['bul', 'Bulgarian'], ['cat', 'Catalan'],
  ['chi_sim', 'Chinese (Simplified)'], ['chi_tra', 'Chinese (Traditional)'], ['hrv', 'Croatian'], ['ces', 'Czech'],
  ['dan', 'Danish'], ['nld', 'Dutch'], ['eng', 'English'], ['est', 'Estonian'], ['fin', 'Finnish'], ['fra', 'French'],
  ['glg', 'Galician'], ['kat', 'Georgian'], ['deu', 'German'], ['ell', 'Greek'], ['heb', 'Hebrew'], ['hin', 'Hindi'],
  ['hun', 'Hungarian'], ['isl', 'Icelandic'], ['ind', 'Indonesian'], ['gle', 'Irish'], ['ita', 'Italian'],
  ['jpn', 'Japanese'], ['kor', 'Korean'], ['lav', 'Latvian'], ['lit', 'Lithuanian'], ['mkd', 'Macedonian'],
  ['msa', 'Malay'], ['nor', 'Norwegian'], ['fas', 'Persian'], ['pol', 'Polish'], ['por', 'Portuguese'],
  ['ron', 'Romanian'], ['rus', 'Russian'], ['srp', 'Serbian (Cyrillic)'], ['srp_latn', 'Serbian (Latin)'],
  ['slk', 'Slovak'], ['slv', 'Slovenian'], ['spa', 'Spanish'], ['swe', 'Swedish'], ['fil', 'Filipino'], ['tam', 'Tamil'],
  ['tha', 'Thai'], ['tur', 'Turkish'], ['ukr', 'Ukrainian'], ['urd', 'Urdu'], ['vie', 'Vietnamese'], ['cym', 'Welsh'],
];

const MAX_BYTES = 64 * 1024 * 1024;

async function tessdataBase() {
  const src = await readFile(ocrTs, 'utf8');
  const commit = /TESSDATA_COMMIT = '([0-9a-f]{40})'/.exec(src)?.[1];
  const base = /TESSDATA_BASE = `([^`]+)`/.exec(src)?.[1];
  if (!commit || !base) throw new Error('TESSDATA_COMMIT / TESSDATA_BASE not found in shared/ocr.ts');
  return base.replace('${TESSDATA_COMMIT}', commit);
}

async function measure(url) {
  const res = await fetch(url, { redirect: 'error' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of res.body) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw new Error('file too large');
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const onlyArg = args[args.indexOf('--only') + 1];
  const only = args.includes('--only') && onlyArg ? new Set(onlyArg.split(',')) : null;
  const base = await tessdataBase();
  const wanted = LANGUAGES.filter(([code]) => !only || only.has(code));
  const entries = [];
  const failed = [];
  let next = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const [code, name] = wanted[next++];
      const file = `${code}.traineddata`;
      try {
        const { bytes, sha256 } = await measure(base + file);
        entries.push({ code, name, file, bytes, sha256 });
        process.stderr.write(`ok   ${file} ${bytes}\n`);
      } catch (e) {
        failed.push(code);
        process.stderr.write(`FAIL ${file}: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const lines = entries.map((e) =>
    `  { code: '${e.code}', name: '${e.name}', file: '${e.file}', bytes: ${e.bytes}, sha256: '${e.sha256}' },`);
  const block = `// <ocr-manifest>\nexport const OCR_LANGUAGES: readonly OcrLanguageInfo[] = [\n${lines.join('\n')}\n];\n// </ocr-manifest>`;
  if (write) {
    const src = await readFile(ocrTs, 'utf8');
    const re = /\/\/ <ocr-manifest>[\s\S]*?\/\/ <\/ocr-manifest>/;
    if (!re.test(src)) throw new Error('manifest markers not found in shared/ocr.ts');
    await writeFile(ocrTs, src.replace(re, () => block));
    process.stderr.write(`wrote ${entries.length} languages to ${path.relative(root, ocrTs)}\n`);
  } else {
    process.stdout.write(block + '\n');
  }
  if (failed.length) {
    process.stderr.write(`not fetched (left out): ${failed.join(', ')}\n`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
