#!/usr/bin/env node
/**
 * Renderer CPU profile (CDP Profiler, sampled) of scenario loops on the 2500-clip sequence, mapped through the
 * dist sourcemaps to source file:line. Answers "where does a playhead step / scroll step / edit spend its time".
 *
 *   npm run build && xvfb-run -a -s "-screen 0 1920x1080x24" node tests/perf/electron-cpuprof.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launchAndBuild, makeRecorder, sleep, closeApp, ROOT } from './_electron-common.mjs';

const require = createRequire(import.meta.url);
const { SourceMapConsumer } = require('source-map-js');
const maps = new Map();
const mapFor = (url) => {
  const file = path.join(ROOT, 'dist/renderer/assets', String(url).split('/').pop() || '');
  if (!maps.has(file)) maps.set(file, fs.existsSync(file + '.map') ? new SourceMapConsumer(JSON.parse(fs.readFileSync(file + '.map', 'utf8'))) : null);
  return maps.get(file);
};
const where = (cf) => {
  if (!cf.url) return `(${cf.functionName || 'native'})`;
  const m = mapFor(cf.url);
  if (!m) return `${cf.functionName || '(anon)'} ${String(cf.url).split('/').pop()}`;
  const p = m.originalPositionFor({ line: cf.lineNumber + 1, column: cf.columnNumber });
  if (!p.source) return `${cf.functionName || '(anon)'} ?`;
  const src = p.source.replace(/^.*?(src|shared|node_modules)\//, '$1/');
  return `${src}:${p.line}${p.name ? ' ' + p.name : ''}`;
};
const fileOf = (w) => w.replace(/:\d+.*$/, '').replace(/^node_modules\/(\.pnpm\/)?([^/]+).*$/, 'node_modules/$2');

const R = makeRecorder();
const H = await launchAndBuild({ tag: 'cpuprof' });
const { page, app, SEQ } = H;
await H.clickTab('timeline');
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 });

async function profile(label, loop) {
  await sleep(1500);
  await cdp.send('Profiler.start');
  const t = Date.now(); await loop(); const el = Date.now() - t;
  const { profile } = await cdp.send('Profiler.stop');
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map(); const files = new Map(); let total = 0;
  profile.samples.forEach((sid, k) => {
    const d = profile.timeDeltas[k] || 0; total += d; const n = byId.get(sid); const w = where(n.callFrame);
    self.set(w, (self.get(w) || 0) + d); const f = fileOf(w); files.set(f, (files.get(f) || 0) + d);
  });
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${(100 * v / total).toFixed(1)}% ${k}`);
  console.log(`\n=== ${label} (${el} ms wall)\n-- by file\n${top(files, 14).join('\n')}\n-- by function\n${top(self, 22).join('\n')}`);
  R.rec('cpuprof', `${label}: top files by self time`, top(files, 8).join(' | '), '', '', null, `wall ${el} ms`);
  R.rec('cpuprof', `${label}: top functions by self time`, top(self, 10).join(' | '));
}
const steps = (kind, n) => page.evaluate(async ({ id, kind, n }) => {
  const st = window.__recut.store;
  for (let i = 0; i < n; i++) {
    const v = st.getState().project.sequences[id].view;
    if (kind === 'playhead') st.getState().setView(id, { playhead: v.playhead + 1 });
    else if (kind === 'scroll') st.getState().setView(id, { scroll: v.scroll + 40 / v.zoom });
    else if (kind === 'razor') st.getState().razor(id, 100 + i * 977);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }
}, { id: SEQ, kind, n });

await H.setView({ zoom: 1, scroll: 0, playhead: 20 }); await sleep(2500); await steps('playhead', 3);
await profile('20 playhead steps @ 1 px/frame (0 React renders/step)', () => steps('playhead', 20));
await profile('20 scroll steps @ 1 px/frame', () => steps('scroll', 20));
await profile('8 razor commits @ 1 px/frame', () => steps('razor', 8));
await H.zoomFit(); await sleep(2500); await steps('playhead', 3);
await profile('20 playhead steps @ zoom-to-fit', () => steps('playhead', 20));
await page.evaluate(() => window.__recut.store.getState().setPlaying?.(true));
R.save('electron-cpuprof');
await closeApp(app);
process.exit(0);
