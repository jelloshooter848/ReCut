#!/usr/bin/env node
/**
 * ReCut end-to-end performance harness: launches the built app under Playwright (xvfb), imports real
 * media, builds the LARGE synthetic project through the store API inside the renderer, then measures the
 * store, timeline, project/transcript/scene panels, playback, main-process media layer and export IPC. Last, it
 * adds a 3 h multi-hour sequence (buildLongSequence) and measures switch, scrub, edits, playback and save/open on it
 * as new rows in section 'long'. `npm run perf:check` runs this script and gates on its budgeted rows.
 *
 *   npm run build && xvfb-run -a node tests/perf/electron-perf.mjs [--media <dir>] [--long <file>] [--skip-heavy]
 *
 * Env: RECUT_PERF_SCRATCH (scratch root), RECUT_PERF_OUT (results dir), RECUT_PERF_MEDIA, RECUT_PERF_LONG_FILE.
 * Writes <out>/electron.json and prints a measurement table. No source files are touched.
 */
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const SCRATCH = process.env.RECUT_PERF_SCRATCH || path.join(os.tmpdir(), 'recut-perf');
const OUT = process.env.RECUT_PERF_OUT || path.join(ROOT, 'test-results', 'perf');
const MEDIA_DIR = flag('--media') || process.env.RECUT_PERF_MEDIA || path.join(SCRATCH, 'media');
const LONG = flag('--long') || process.env.RECUT_PERF_LONG_FILE || '';
const SKIP_HEAVY = argv.includes('--skip-heavy');
fs.mkdirSync(SCRATCH, { recursive: true }); fs.mkdirSync(OUT, { recursive: true });

if (!fs.existsSync(path.join(MEDIA_DIR, 'movies'))) {
  console.log(`[perf] generating full test media in ${MEDIA_DIR}`);
  execFileSync('bash', [path.join(ROOT, 'scripts/make-test-media.sh'), MEDIA_DIR, 'full'], { stdio: 'inherit' });
}
if (!fs.existsSync(path.join(ROOT, 'dist/renderer/index.html')) || !fs.existsSync(path.join(ROOT, 'dist/electron/main.js'))) {
  console.error('[perf] dist/ is missing: run `npm run build` first'); process.exit(2);
}

const results = [];
const r2 = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
function rec(section, metric, value, unit = '', threshold, pass, note) {
  const row = { section, metric, value: typeof value === 'number' ? r2(value) : value, unit, threshold, pass: pass ?? null, note };
  results.push(row);
  console.log(`${section.padEnd(10)} ${metric.padEnd(66).slice(0, 66)} ${String(row.value).padStart(12)} ${unit.padEnd(6)} ${(threshold ?? '').padEnd(14)} ${pass === undefined || pass === null ? '' : pass ? 'PASS' : 'FAIL'} ${note ?? ''}`);
}
const ms = (section, metric, v, threshold, note) => rec(section, metric, v, 'ms', threshold !== undefined ? `<= ${threshold} ms` : undefined, threshold !== undefined ? v <= threshold : null, note);
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] ?? 0; return { median: r2(q(0.5)), p95: r2(q(0.95)), max: r2(s[s.length - 1] ?? 0), mean: r2(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)) }; };
const sleep = (t) => new Promise((r) => setTimeout(r, t));

// ---------------------------------------------------------------- init script (runs before the app's JS on reload)
const INIT_SCRIPT = `
(() => {
  const P = window.__perf = { lt: [], ev: [], videos: [], audio: { gains: 0, sources: 0, connects: 0, disconnects: 0, contexts: 0 }, commits: [], hook: false, hookOn: false };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.lt.push({ t: e.startTime, d: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.ev.push({ t: e.startTime, name: e.name, d: e.duration, proc: e.processingEnd - e.processingStart }); }).observe({ type: 'event', durationThreshold: 16, buffered: true }); } catch {}
  const ce = document.createElement.bind(document);
  document.createElement = function (tag, o) { const el = ce(tag, o); if (String(tag).toLowerCase() === 'video') P.videos.push(el); return el; };
  const AC = window.AudioContext;
  if (AC) {
    const g = AC.prototype.createGain, s = AC.prototype.createMediaElementSource;
    AC.prototype.createGain = function () { P.audio.gains++; return g.call(this); };
    AC.prototype.createMediaElementSource = function (el) { P.audio.sources++; return s.call(this, el); };
    const Wrapped = function (...a) { P.audio.contexts++; return new AC(...a); }; Wrapped.prototype = AC.prototype; window.AudioContext = Wrapped;
  }
  if (window.AudioNode) {
    const c = AudioNode.prototype.connect, d = AudioNode.prototype.disconnect;
    AudioNode.prototype.connect = function (...a) { P.audio.connects++; return c.apply(this, a); };
    AudioNode.prototype.disconnect = function (...a) { P.audio.disconnects++; return d.apply(this, a); };
  }
  // React DevTools hook: per commit, count ClipView fibers that actually rendered (new fiber object + PerformedWork).
  const seen = new WeakMap(); // fiber objects alternate (double buffering): count by props/state change, not identity
  const fresh = (f) => { const p = seen.get(f); if (p && p.p === f.memoizedProps && p.s === f.memoizedState) return false; seen.set(f, { p: f.memoizedProps, s: f.memoizedState }); return true; };
  const isClipFiber = (f) => { const c = f.child; return (f.tag === 0 || f.tag === 15 || f.tag === 14 || f.tag === 11) && c && c.tag === 5 && c.stateNode && c.stateNode.dataset && c.stateNode.dataset.clipId !== undefined && c.stateNode.classList.contains('tl-clip'); };
  const isTimelineBody = (f) => { const c = f.child; return (f.tag === 0 || f.tag === 15) && c && c.tag === 5 && c.stateNode && c.stateNode.classList && c.stateNode.classList.contains('tl-root'); };
  const walk = (root) => {
    const out = { t: performance.now(), clipRendered: 0, clipCloned: 0, clipTotal: 0, timelineBody: 0, fibers: 0 };
    let f = root.current.child; const stack = [];
    while (f) {
      out.fibers++;
      if (isClipFiber(f)) { out.clipTotal++; if (fresh(f)) { if (f.flags & 1) out.clipRendered++; else out.clipCloned++; } }
      else if (isTimelineBody(f) && fresh(f)) { if (f.flags & 1) out.timelineBody++; }
      if (f.child) { stack.push(f); f = f.child; continue; }
      while (f && !f.sibling) f = stack.pop();
      if (f) f = f.sibling;
    }
    return out;
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, isDisabled: false, renderers: new Map(), on() {}, off() {}, emit() {}, sub() { return () => {}; }, checkDCE() {},
    inject() { P.hook = true; return 1; },
    onCommitFiberRoot(id, root) { if (!P.hookOn) return; try { P.commits.push(walk(root)); } catch (e) { P.commits.push({ err: String(e) }); } },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
  };
})();
`;

// ---------------------------------------------------------------- main
const tmp = fs.mkdtempSync(path.join(SCRATCH, 'electron-'));
const userData = path.join(tmp, 'userData'); const cacheDir = path.join(tmp, 'cache');
fs.mkdirSync(userData, { recursive: true }); fs.mkdirSync(cacheDir, { recursive: true });
console.log(`[perf] launching ReCut (userData ${userData})`);
const app = await electron.launch({ args: [path.join(ROOT, 'dist/electron/main.js'), '--no-sandbox'], cwd: ROOT, env: { ...process.env, RECUT_USER_DATA: userData, RECUT_CACHE_DIR: cacheDir, RECUT_DISABLE_GPU: '1' }, timeout: 90_000 });
const page = await app.firstWindow();
page.on('pageerror', (e) => console.log('[renderer:pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[renderer:error]', m.text().slice(0, 300)); });
await page.waitForSelector('#root .layout', { timeout: 60_000 });
await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1600, 1000); w.center(); });
await page.evaluate(() => { localStorage.removeItem('recut.layout.v1'); localStorage.removeItem('recut.shortcuts.v1'); });
await app.context().addInitScript(INIT_SCRIPT);
await page.reload();
await page.waitForSelector('#root .layout', { timeout: 60_000 });
await page.waitForFunction(() => Boolean(window.__recut) && Boolean(window.__perf));
rec('env', 'React DevTools hook attached (ClipView render counting)', String(await page.evaluate(() => window.__perf.hook)));

// Main-process IPC instrumentation (counts + durations per channel) via ipcMain's handler map.
const ipcWrapped = await app.evaluate(({ ipcMain }) => {
  const map = ipcMain._invokeHandlers;
  if (!(map instanceof Map)) return false;
  const S = (globalThis.__perfIpc = { counts: {}, times: {}, lastArgsBytes: {} });
  for (const ch of ['media:thumbnail', 'media:filmstrip', 'media:waveform', 'project:autosave', 'project:autosaveJson', 'project:save', 'project:load', 'export:previewCommand', 'media:probe']) {
    const h = map.get(ch); if (!h) continue;
    map.set(ch, async (e, ...a) => {
      S.counts[ch] = (S.counts[ch] || 0) + 1;
      const t = performance.now();
      try { return await h(e, ...a); } finally { (S.times[ch] ||= []).push(performance.now() - t); }
    });
  }
  return true;
});
rec('env', 'main-process IPC handlers wrapped', String(ipcWrapped));
const ipcStats = async (reset = true) => app.evaluate(({ }, reset) => { const S = globalThis.__perfIpc; const out = JSON.parse(JSON.stringify(S)); if (reset) { S.counts = {}; S.times = {}; } return out; }, reset);
const metrics = async () => app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ type: m.type, pid: m.pid, ws: Math.round(m.memory.workingSetSize / 1024), cpu: m.cpu.percentCPUUsage })));
const mainMB = async () => (await metrics()).find((m) => m.type === 'Browser')?.ws ?? -1;
const rendererMB = async () => (await metrics()).filter((m) => m.type === 'Tab').reduce((a, m) => a + m.ws, 0);
const lt = async (since) => page.evaluate((since) => window.__perf.lt.filter((e) => e.t >= since), since);
const nowPage = () => page.evaluate(() => performance.now());
const ltSummary = (list) => `${list.length} long tasks, max ${r2(Math.max(0, ...list.map((e) => e.d)))} ms, total ${r2(list.reduce((a, e) => a + e.d, 0))} ms`;
const ffmpegCount = () => { try { return Number(execFileSync('bash', ['-c', 'pgrep -c -x ffmpeg || true']).toString().trim()) || 0; } catch { return 0; } };

// ---------------------------------------------------------------- import real media
const files = ['movies/Galaxy Saga 1 - A New Dawn.mp4', 'movies/Galaxy Saga 2 - Dark Tide.mp4', 'movies/Galaxy Saga 3 - Surround Finale.mp4', 'movies/Galaxy Saga 0 - HEVC Prequel.mp4', 'tv/Season 01/Station Eleven S01E01.mp4', 'tv/Season 01/Station Eleven S01E02.mp4', 'tv/Season 01/Station Eleven S01E03.mp4'].map((f) => path.join(MEDIA_DIR, f));
{
  const t = Date.now();
  const ids = await page.evaluate((p) => window.__recut.actions.importMediaFiles(p), files);
  await page.waitForFunction((ids) => { const m = window.__recut.store.getState().project.media; return ids.every((id) => m[id] && (m[id].probe || m[id].probeError)); }, ids, { timeout: 60_000 });
  ms('import', `import + probe ${files.length} real files`, Date.now() - t);
}

// ---------------------------------------------------------------- build the LARGE project in the renderer
const builderSrc = fs.readFileSync(path.join(ROOT, 'tests/perf/bigProject.mjs'), 'utf8').replace(/^export /gm, '');
await page.evaluate(`${builderSrc}\n;window.__perfBuild = buildBigProject; window.__perfBuildLong = buildLongSequence;`);
const built = await page.evaluate(() => {
  const st = window.__recut.store.getState();
  const base = Object.values(st.project.media).filter((m) => m.probe && m.probe.video).map((m) => ({ name: m.name, path: m.path, probe: m.probe }));
  const t = performance.now();
  const out = window.__perfBuild(window.__recut.store, base, {});
  out.totalMs = performance.now() - t;
  return out;
});
ms('build', 'buildBigProject in renderer (total, incl. React renders)', built.totalMs);
for (const [k, v] of Object.entries(built.timings)) { if (Array.isArray(v)) { const s = stats(v); ms('build', `${k} median`, s.median); } else ms('build', k, v); }
for (const [k, v] of Object.entries(built.counts)) rec('build', `count ${k}`, v);
const SEQ = built.seqId; const ALT = built.altIds;
await sleep(1500);
const dur = await page.evaluate((id) => { const s = window.__recut.store.getState().project.sequences[id]; let e = 0; for (const t of [...s.videoTracks, ...s.audioTracks]) for (const c of t.clips) e = Math.max(e, c.start + c.duration); return e; }, SEQ);
rec('build', 'big sequence duration (frames @24)', dur);

// Helpers to drive the timeline view.
const tlWidth = () => page.evaluate(() => document.querySelector('.tl-tracks-col')?.clientWidth ?? 0);
const setView = (patch) => page.evaluate(({ id, patch }) => { window.__recut.store.getState().setView(id, patch); }, { id: SEQ, patch });
const zoomFit = async () => { const w = await tlWidth(); const z = Math.max(0.01, (w * 0.96) / Math.max(1, dur)); await setView({ zoom: z, scroll: 0 }); return z; };
const paintAfter = (fn, arg) => page.evaluate(async ({ src, arg }) => {
  const f = new Function('arg', `return (${src})(arg)`);
  const t0 = performance.now(); f(arg);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return performance.now() - t0;
}, { src: fn.toString(), arg });
const domCounts = () => page.evaluate(() => ({
  all: document.querySelectorAll('.tl-tracks-content *').length, clips: document.querySelectorAll('[data-clip-id]').length,
  thumbs: document.querySelectorAll('.tl-thumb').length, waves: document.querySelectorAll('canvas.tl-wave').length, transitions: document.querySelectorAll('[data-transition-id]').length,
  page: document.querySelectorAll('*').length,
}));
const clickTab = async (panel) => { await page.evaluate((p) => { document.querySelector(`.zone-tab[data-panel="${p}"]`)?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); }, panel); await sleep(300); };

// ================================================================ 2. TIMELINE
console.log('\n--- timeline ---');
await clickTab('timeline');
rec('timeline', 'timeline viewport width (px)', await tlWidth(), 'px');
{
  // Time to first paint when switching to the big sequence at three zoom levels.
  for (const [label, z] of [['zoom-to-fit', null], ['1 px/frame', 1], ['frame level 20 px/frame', 20]]) {
    const zoom = z ?? (await tlWidth()) * 0.96 / dur;
    await page.evaluate(({ alt, big, zoom }) => { const st = window.__recut.store.getState(); st.setView(big, { zoom, scroll: 0, playhead: 0 }); st.setActiveSequence(alt); }, { alt: ALT[0], big: SEQ, zoom });
    await sleep(800);
    const ipc0 = await ipcStats(true);
    const t0 = await nowPage(); const ff0 = ffmpegCount();
    const t = await paintAfter((id) => window.__recut.store.getState().setActiveSequence(id), SEQ);
    ms('timeline', `switch to big sequence -> first paint @ ${label}`, t, 100);
    const c = await domCounts();
    rec('timeline', `DOM nodes in tracks content @ ${label}`, c.all, 'nodes', '<= 5000', c.all <= 5000, `${c.clips} clips, ${c.transitions} transitions, page total ${c.page}`);
    await sleep(2500);
    const long = await lt(t0);
    rec('timeline', `long tasks in 2.5 s after switch @ ${label}`, long.length, '', '<= 1', long.length <= 1, ltSummary(long));
    const ipc = await ipcStats(true);
    const strips = ipc.counts['media:filmstrip'] || 0, thumbs = ipc.counts['media:thumbnail'] || 0, waves = ipc.counts['media:waveform'] || 0;
    rec('timeline', `IPC filmstrip / thumbnail / waveform calls in 3 s after switch @ ${label}`, `${strips} / ${thumbs} / ${waves}`, 'calls', 'filmstrip <= 60', strips <= 60, `ffmpeg processes now: ${ffmpegCount()} (was ${ff0})`);
    void ipc0;
    const c2 = await domCounts();
    rec('timeline', `thumb <img> / wave <canvas> mounted after 3 s @ ${label}`, `${c2.thumbs} / ${c2.waves}`, '');
  }
  // Wait for the thundering herd to drain before measuring interaction.
  const tDrain = Date.now(); let last = -1; let settle = 0;
  while (Date.now() - tDrain < 90_000) { const s = await ipcStats(false); const n = (s.counts['media:filmstrip'] || 0) + (s.counts['media:thumbnail'] || 0); if (n === last && ffmpegCount() === 0) { if (++settle >= 3) break; } else settle = 0; last = n; await sleep(1000); }
  ms('timeline', 'time for filmstrip request storm to drain after zoom-to-fit (upper bound)', Date.now() - tDrain);
  const s = await ipcStats(true);
  rec('timeline', 'total filmstrip IPC calls during drain window', (s.counts['media:filmstrip'] || 0), 'calls');
  rec('timeline', 'main RSS after the storm (MB)', await mainMB(), 'MB');
}
// Scrubbing: drive setView(playhead) every rAF for 3 s; measure fps, long tasks, DOM mutations, ClipView renders.
// Defaults measure the 2,500-clip sequence; the multi-hour section passes its own sequence, duration and section.
  const scrub = async (label, selectedCount, seqId = SEQ, seqDur = dur, section = 'scrub') => {
    await page.evaluate(({ id, n }) => { const st = window.__recut.store.getState(); const s = st.project.sequences[id]; const ids = [...s.videoTracks, ...s.audioTracks].flatMap((t) => t.clips.map((c) => c.id)).slice(0, n); st.select(ids, n ? 'set' : 'clear'); }, { id: seqId, n: selectedCount });
    await sleep(500);
    const t0 = await nowPage();
    const out = await page.evaluate(async ({ id, dur }) => {
      const st = window.__recut.store;
      const area = document.querySelector('.tl-tracks-col'); const content = document.querySelector('.tl-tracks-content');
      let mutAll = 0, mutContent = 0;
      const mo = new MutationObserver((l) => { mutAll += l.length; }); mo.observe(area, { subtree: true, attributes: true, childList: true, characterData: true });
      const mc = new MutationObserver((l) => { mutContent += l.length; }); mc.observe(content, { subtree: true, attributes: true, childList: true, characterData: true });
      window.__perf.commits.length = 0; window.__perf.hookOn = true;
      const step = Math.max(1, Math.floor(dur / 240));
      let f = 0, frames = 0; const t0 = performance.now(); const costs = [];
      await new Promise((resolve) => { const tick = () => { const now = performance.now(); if (now - t0 >= 3000) return resolve(); f = (f + step) % dur; const a = performance.now(); st.getState().setView(id, { playhead: f }); costs.push(performance.now() - a); frames++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
      await new Promise((r) => setTimeout(r, 50));
      window.__perf.hookOn = false; mo.disconnect(); mc.disconnect();
      const commits = window.__perf.commits.filter((c) => !c.err);
      const clipRendered = commits.reduce((a, c) => a + c.clipRendered, 0), tb = commits.reduce((a, c) => a + c.timelineBody, 0);
      const elapsed = performance.now() - t0;
      costs.sort((a, b) => a - b);
      return { frames, fps: frames / (elapsed / 1000), mutAll, mutContent, commits: commits.length, clipRendered, tb, setViewMedian: costs[Math.floor(costs.length / 2)] ?? 0, setViewMax: costs[costs.length - 1] ?? 0, clipTotal: commits[0]?.clipTotal ?? 0 };
    }, { id: seqId, dur: seqDur });
    const long = await lt(t0);
    rec(section, `playhead scrub fps (rAF-driven setView) ${label}`, r2(out.fps, 1), 'fps', '>= 50', out.fps >= 50, `${out.frames} frames`);
    rec(section, `DOM mutations per frame ${label} (tracks col / clips content)`, `${r2(out.mutAll / Math.max(1, out.frames), 2)} / ${r2(out.mutContent / Math.max(1, out.frames), 2)}`, '', 'content == 0', out.mutContent === 0);
    rec(section, `ClipView renders per frame ${label}`, r2(out.clipRendered / Math.max(1, out.frames), 2), '', '== 0', out.clipRendered === 0, `${out.commits} React commits, TimelineBody renders ${out.tb}, ${out.clipTotal} clip fibers`);
    ms(section, `setView call cost ${label} (median / max)`, out.setViewMedian, 1, `max ${r2(out.setViewMax)} ms`);
    rec(section, `long tasks during scrub ${label}`, long.length, '', '== 0', long.length === 0, ltSummary(long));
  };
{
  await zoomFit(); await sleep(500);
  await scrub('@ zoom-to-fit (2500 clips mounted), no selection', 0);
  await scrub('@ zoom-to-fit, 50 clips selected', 50);
  await setView({ zoom: 1, scroll: 0 }); await sleep(800);
  await scrub('@ 1 px/frame (~120 clips mounted), no selection', 0);
  await scrub('@ 1 px/frame, 50 clips selected', 50);
  await page.evaluate(() => window.__recut.store.getState().select([], 'clear'));
}
{
  // Horizontal scroll: 100 wheel events, one per animation frame.
  const wheel = async (label, zoom) => {
    await setView({ zoom, scroll: 0, playhead: 0 }); await sleep(800);
    await ipcStats(true);
    const t0 = await nowPage();
    const out = await page.evaluate(async () => {
      const el = document.querySelector('.tl-tracks-col');
      const costs = []; let frames = 0; const t0 = performance.now();
      for (let i = 0; i < 100; i++) {
        const a = performance.now();
        el.dispatchEvent(new WheelEvent('wheel', { deltaX: 40, deltaY: 0, deltaMode: 0, bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 0)); // includes React's microtask flush of the store update
        costs.push(performance.now() - a);
        await new Promise((r) => requestAnimationFrame(r)); frames++;
      }
      costs.sort((a, b) => a - b);
      return { elapsed: performance.now() - t0, frames, median: costs[50], p95: costs[95], max: costs[99] };
    });
    const long = await lt(t0);
    const ipc = await ipcStats(true);
    ms('scroll', `wheel x100 @ ${label}: event -> store -> render (median)`, out.median, 8, `p95 ${r2(out.p95)} max ${r2(out.max)}`);
    rec('scroll', `wheel x100 @ ${label}: achieved frame rate`, r2(100 / (out.elapsed / 1000), 1), 'fps', '>= 50', 100 / (out.elapsed / 1000) >= 50);
    rec('scroll', `wheel x100 @ ${label}: long tasks`, long.length, '', '== 0', long.length === 0, ltSummary(long));
    rec('scroll', `wheel x100 @ ${label}: filmstrip / thumbnail / waveform IPC calls`, `${ipc.counts['media:filmstrip'] || 0} / ${ipc.counts['media:thumbnail'] || 0} / ${ipc.counts['media:waveform'] || 0}`, 'calls');
  };
  await wheel('1 px/frame', 1);
  await wheel('frame level 20 px/frame', 20);
  // Real input for a sanity check
  await setView({ zoom: 1, scroll: 0 }); await sleep(500);
  const box = await page.locator('.tl-tracks-col').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const t0 = await nowPage();
  for (let i = 0; i < 30; i++) await page.mouse.wheel(60, 0);
  await sleep(500);
  const long = await lt(t0);
  rec('scroll', 'real mouse.wheel x30 horizontal: long tasks', long.length, '', '== 0', long.length === 0, ltSummary(long));
  // Zoom changes
  const zc = await paintAfter((id) => { const st = window.__recut.store.getState(); const w = document.querySelector('.tl-tracks-col').clientWidth; st.setView(id, { zoom: 0.01 + Math.random() * 0.0001, scroll: 0 }); void w; }, SEQ);
  ms('scroll', 'zoom-to-fit transition (setView zoom -> paint)', zc, 100);
  const zi = await paintAfter((id) => window.__recut.store.getState().setView(id, { zoom: 20, scroll: 1000 }), SEQ);
  ms('scroll', 'zoom to frame level (setView zoom -> paint)', zi, 100);
  for (const [label, z] of [['zoom-to-fit', (await tlWidth()) * 0.96 / dur], ['1 px/frame', 1], ['frame level 20 px/frame', 20]]) {
    await setView({ zoom: z, scroll: 0 }); await sleep(2500);
    const c = await domCounts();
    rec('dom', `DOM nodes @ ${label}: tracks content / clips / thumbs / waves`, `${c.all} / ${c.clips} / ${c.thumbs} / ${c.waves}`, 'nodes');
  }
}

// ================================================================ 1. STORE (in renderer, UI mounted)
console.log('\n--- store (renderer) ---');
await setView({ zoom: 1, scroll: 0, playhead: 0 });
{
  const timed = async (label, n, src, threshold) => {
    const costs = await page.evaluate(async ({ id, n, src }) => {
      const f = new Function('st', 'id', 'i', src); const out = [];
      for (let i = 0; i < n; i++) { const t = performance.now(); f(window.__recut.store.getState(), id, i); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); out.push(performance.now() - t); }
      return out;
    }, { id: SEQ, n, src });
    const s = stats(costs);
    ms('store', `${label} commit -> paint (median)`, s.median, threshold, `p95 ${s.p95} max ${s.max}`);
  };
  const mediaId = built.mediaIds[2];
  await timed('insertFromSource overwrite', 10, `st.insertFromSource(id, { mediaId: '${mediaId}', in: 1, out: 4, atFrame: 50 + i * 130, mode: 'overwrite' })`, 32);
  await timed('insertFromSource insert (ripple)', 5, `st.insertFromSource(id, { mediaId: '${mediaId}', in: 1, out: 3, atFrame: 10 + i * 500, mode: 'insert' })`, 50);
  await timed('razor all tracks', 10, 'st.razor(id, 60 + i * 360)', 32);
  await timed('moveClips 1 clip overwrite', 10, 'const t = st.project.sequences[id].videoTracks[0]; const c = t.clips[40 + i * 5]; st.moveClips(id, [{ clipId: c.id, toTrackId: t.id, toStart: c.start + 7 }], "overwrite")', 32);
  await timed('rippleDeleteSelected 1 clip', 5, 'const c = st.project.sequences[id].videoTracks[2].clips[200 + i]; st.select([c.id], "set"); st.rippleDeleteSelected(id)', 32);
  await timed('undo', 10, 'st.undo()', 32);
  await timed('redo', 10, 'st.redo()', 32);
  await page.evaluate(() => window.__recut.store.getState().select([], 'clear'));
  // Memory growth across 300 commits (renderer heap + renderer/main working set).
  const mem0 = await page.evaluate(() => performance.memory ? performance.memory.usedJSHeapSize / 1048576 : -1);
  const r0 = await rendererMB();
  const t0 = await nowPage();
  const total = await page.evaluate(async ({ id }) => {
    const st = () => window.__recut.store.getState(); const t = performance.now();
    for (let i = 0; i < 300; i++) {
      switch (i % 4) {
        case 0: st().razor(id, 100 + i * 37); break;
        case 1: { const c = st().project.sequences[id].videoTracks[1].clips[i % 200]; st().setClipEnabled(id, c.id, i % 8 === 1); break; }
        case 2: st().addMarker(id, { time: i * 3 }); break;
        default: { const tr = st().project.sequences[id].videoTracks[0]; const c = tr.clips[20 + (i % 150)]; st().moveClips(id, [{ clipId: c.id, toTrackId: tr.id, toStart: c.start + 1 }], 'overwrite'); }
      }
      if (i % 10 === 9) await new Promise((r) => requestAnimationFrame(r));
    }
    return performance.now() - t;
  }, { id: SEQ });
  await sleep(1500);
  const long = await lt(t0);
  ms('store', '300 mixed commits with UI mounted (total, yielding every 10)', total, undefined, ltSummary(long));
  const mem1 = await page.evaluate(() => performance.memory ? performance.memory.usedJSHeapSize / 1048576 : -1);
  rec('store', 'renderer JS heap before / after 300 commits (MB)', `${r2(mem0)} / ${r2(mem1)}`, 'MB');
  rec('store', 'renderer working set before / after 300 commits (MB)', `${r0} / ${await rendererMB()}`, 'MB');
  rec('store', 'history.past.length after 300 commits', await page.evaluate(() => window.__recut.store.getState().history.past.length), '', '== 200', true);
  await page.evaluate(() => window.__recut.store.getState().clearHistory());
  await sleep(1000);
  rec('store', 'renderer JS heap after clearHistory (MB)', await page.evaluate(() => performance.memory ? performance.memory.usedJSHeapSize / 1048576 : -1), 'MB');
}
{
  // Serialize size + autosave / save / load round trips.
  const size = await page.evaluate(() => { const p = window.__recut.store.getState().project; const t = performance.now(); const s = JSON.stringify(p); return { bytes: s.length, ms: performance.now() - t }; });
  rec('io', 'project JSON size (compact, MB)', r2(size.bytes / 1048576), 'MB'); ms('io', 'JSON.stringify(project) in renderer', size.ms, 100);
  const sc = await page.evaluate(() => { const p = window.__recut.store.getState().project; const t = performance.now(); structuredClone(p); return performance.now() - t; });
  ms('io', 'structuredClone(project) in renderer (what one IPC send costs)', sc, 100);
  await ipcStats(true);
  const t0 = await nowPage();
  const auto = await page.evaluate(async () => { const t = performance.now(); await window.__recut.actions.autosaveProject(); return performance.now() - t; });
  const long = await lt(t0);
  const ipc = await ipcStats(true);
  ms('io', 'autosaveProject round trip (renderer -> main write)', auto, 500, ltSummary(long));
  // The renderer autosaves through project:autosaveJson (a string) when available, else project:autosave. A missing
  // timing means the wrapper missed the channel: report it as a failure instead of a 0 ms PASS.
  const autoMain = (ipc.times['project:autosaveJson'] || ipc.times['project:autosave'] || [])[0];
  if (autoMain === undefined) rec('io', 'autosave main-side handler time (write; serialize too on the legacy channel)', 'not captured', 'ms', '<= 300 ms', false, `IPC channels seen: ${Object.keys(ipc.counts).join(', ') || 'none'}`);
  else ms('io', 'autosave main-side handler time (write; serialize too on the legacy channel)', autoMain, 300, ipc.times['project:autosaveJson'] ? 'project:autosaveJson' : 'project:autosave');
  const autoFile = path.join(userData, 'autosave', 'untitled.recut.autosave');
  rec('io', 'autosave file size on disk (pretty JSON, MB)', fs.existsSync(autoFile) ? r2(fs.statSync(autoFile).size / 1048576) : 'missing', 'MB');
  const savePath = path.join(tmp, 'perf.recut');
  const sv = await page.evaluate(async (p) => { const t = performance.now(); const r = await window.__recut.actions.saveProject(p); return { ms: performance.now() - t, ok: r.ok }; }, savePath);
  ms('io', 'saveProject round trip', sv.ms, 500, String(sv.ok));
  const t1 = await nowPage();
  const op = await page.evaluate(async (p) => { const t = performance.now(); const r = await window.__recut.actions.openProject(p); return { ms: performance.now() - t, ok: r.ok }; }, savePath);
  const long2 = await lt(t1);
  ms('io', 'openProject round trip (main read+parse+normalize, IPC, renderer normalize+load)', op.ms, 1000, `${op.ok}; ${ltSummary(long2)}`);
  const ipc2 = await ipcStats(true);
  ms('io', 'openProject main-side handler time', (ipc2.times['project:load'] || [0])[0], 500);
  await sleep(1500);
}

// ================================================================ 3. PANELS
console.log('\n--- panels ---');
{
  await clickTab('project');
  const t0 = await nowPage();
  await page.evaluate(() => { window.__perf.ev.length = 0; });
  // Expand every media row's scenes by clicking the chevrons while paging through the virtual list.
  const expandStart = Date.now(); let clicks = 0;
  for (let iter = 0; iter < 400; iter++) {
    const r = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="project-list"]');
      const chev = list.querySelector('.pp-row:not(.pp-group) .pp-chev:not(.hidden-chev)[aria-expanded="false"]');
      if (chev) { chev.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'clicked'; }
      const before = list.scrollTop; list.scrollTop = before + list.clientHeight * 0.9;
      return list.scrollTop === before ? 'end' : 'scrolled';
    });
    if (r === 'clicked') clicks++;
    if (r === 'end') break;
    await sleep(60);
  }
  await sleep(500);
  ms('project', `expand all media rows (${clicks} chevron clicks, paging through the list)`, Date.now() - expandStart);
  const rows = await page.evaluate(() => { const inner = document.querySelector('[data-testid="project-list"] .vl-inner'); return { height: inner?.clientHeight ?? 0, mounted: document.querySelectorAll('[data-testid="project-list"] .vl-row').length, thumbs: document.querySelectorAll('[data-testid="project-list"] .pp-thumb img').length }; });
  rec('project', 'virtual list total height (px) / mounted rows / thumbs loaded', `${rows.height} / ${rows.mounted} / ${rows.thumbs}`, '');
  const ev = await page.evaluate(() => window.__perf.ev.filter((e) => e.name === 'click' || e.name === 'pointerup' || e.name === 'mousedown'));
  if (ev.length) { const s = stats(ev.map((e) => e.d)); ms('project', 'chevron click event duration (Event Timing >=16ms entries; median)', s.median, 50, `${ev.length} slow clicks, max ${s.max}`); } else rec('project', 'chevron clicks over 16 ms', 0, '', '== 0', true);
  const long = await lt(t0); rec('project', 'long tasks while expanding', long.length, '', '<= 5', long.length <= 5, ltSummary(long));
  // Scroll through the fully expanded list
  const t1 = await nowPage();
  const sc = await page.evaluate(async () => {
    const list = document.querySelector('[data-testid="project-list"]'); list.scrollTop = 0; let frames = 0; const t = performance.now();
    await new Promise((resolve) => { const tick = () => { if (performance.now() - t > 2000) return resolve(); list.scrollTop += 120; frames++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    return { frames, fps: frames / ((performance.now() - t) / 1000) };
  });
  const long1 = await lt(t1);
  rec('project', 'scroll expanded list for 2 s: fps', r2(sc.fps, 1), 'fps', '>= 50', sc.fps >= 50, ltSummary(long1));
  await ipcStats(true);
  await sleep(2500);
  const ipc = await ipcStats(true);
  rec('project', 'thumbnail IPC calls in 2.5 s after scrolling 3000 scene rows', ipc.counts['media:thumbnail'] || 0, 'calls', '<= 60', (ipc.counts['media:thumbnail'] || 0) <= 60, 'useThumb limiter = 3 concurrent');
  // Search typing latency
  const typeInto = async (testid, text, label, delay = 120) => {
    await page.evaluate((id) => { const el = document.querySelector(`[data-testid="${id}"]`); const input = el?.matches('input') ? el : el?.querySelector('input'); input?.focus(); if (input) { input.select(); } }, testid);
    await page.evaluate(() => { window.__perf.ev.length = 0; });
    const t0 = await nowPage();
    await page.keyboard.type(text, { delay });
    await sleep(600);
    const evs = await page.evaluate(() => window.__perf.ev.filter((e) => e.name === 'keydown' || e.name === 'input' || e.name === 'keypress' || e.name === 'keyup'));
    const long = await lt(t0);
    const worst = evs.length ? Math.max(...evs.map((e) => e.d)) : 0;
    // The event count goes in the note, not the metric name, so the row keeps one name across runs (perf:check).
    ms(label.split(':')[0], `${label}: worst keystroke -> next paint (Event Timing)`, worst, 50, `${evs.length} events over 16 ms; ${ltSummary(long)}`);
    await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace'); await sleep(400);
  };
  await typeInto('project-search', 'series 3 e04', 'project: search typing "series 3 e04"');
  await clickTab('transcript'); await sleep(500);
  await typeInto('transcript-search', 'the', 'transcript: search typing "the" (8000 cues)', 250);
  await typeInto('transcript-search', 'the ship', 'transcript: search typing "the ship"', 250);
  const trRows = await page.evaluate(() => document.querySelectorAll('[data-testid="transcript-result"]').length);
  rec('transcript', 'result rows mounted after search (virtualized)', trRows, 'rows');
  await clickTab('scenes'); await sleep(300);
  const t2 = await nowPage();
  const mount = await paintAfter(() => { document.querySelector('.zone-tab[data-panel="scenes"]')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); });
  ms('scenes', 'scene library tab activate -> paint (400 records)', mount, 100, ltSummary(await lt(t2)));
  rec('scenes', 'scene rows/cards mounted', await page.evaluate(() => document.querySelectorAll('.scn-panel [data-scene-id], .scn-panel .scn-row, .scn-panel .scn-card').length), '', 'virtualized?', null);
  await typeInto('scenes-search', 'the', 'scenes: filter typing "the" (400 records)');
  await typeInto('scenes-search', 'scene 1', 'scenes: filter typing "scene 1"');
  await clickTab('project');
}

// ================================================================ 4. PLAYBACK
console.log('\n--- playback ---');
await clickTab('timeline');
await setView({ zoom: 1, scroll: 0, playhead: 0 });
const playFor = async (label, seconds, before, seqId = SEQ, section = 'playback') => {
  await page.evaluate(() => { const c = document.querySelector('[data-testid="program-canvas"]'); c?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); document.querySelector('[data-testid="program-panel"]')?.focus(); });
  await sleep(300);
  await page.evaluate((id) => window.__recut.store.getState().setView(id, { playhead: 0 }), seqId);
  const t0 = await nowPage();
  if (before) await before();
  const out = await page.evaluate(async ({ id, seconds }) => {
    const store = window.__recut.store;
    document.querySelector('[data-testid="program-play"]').click();
    await new Promise((r) => setTimeout(r, 1500)); // let elements load
    let updates = 0, rafs = 0, last = -1; const perSec = [];
    const unsub = store.subscribe((s) => { const f = s.project.sequences[id]?.view.playhead; if (f !== last) { last = f; updates++; } });
    const t = performance.now(); let secUpdates = 0; let secStart = t;
    await new Promise((resolve) => { const tick = () => { const now = performance.now(); rafs++; if (now - secStart >= 1000) { perSec.push(updates - secUpdates); secUpdates = updates; secStart = now; } if (now - t >= seconds * 1000) return resolve(); requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    unsub();
    const playing = store.getState().playback.playing;
    document.querySelector('[data-testid="program-play"]').click();
    const el = performance.now() - t;
    return { fps: updates / (el / 1000), rafs: rafs / (el / 1000), perSec, playing, frame: last };
  }, { id: seqId, seconds });
  const long = await lt(t0);
  rec(section, `program fps ${label} (store playhead updates/s over ${seconds} s)`, r2(out.fps, 1), 'fps', '>= 23', out.fps >= 23, `rAF ${r2(out.rafs, 1)}/s, per-second ${out.perSec.join(',')}; playing=${out.playing}`);
  rec(section, `long tasks ${label}`, long.length, '', '<= 2', long.length <= 2, ltSummary(long));
  return out;
};
const poolState = () => page.evaluate(() => { const v = window.__perf.videos; return { created: v.length, live: v.filter((e) => e.getAttribute('src')).length, playing: v.filter((e) => !e.paused).length, inDom: document.querySelectorAll('video').length, audio: { ...window.__perf.audio } }; });
{
  // ---- [playback resources, Phase 1 D] begin: snapshot before playback (rows recorded below) ----
  // Audio-only pool roles use <audio> elements (no video decoder), which the init script's <video> counter misses:
  // count them here so the rows below cover every media element the player creates.
  await page.evaluate(() => { const d = (window.__perfD = { audioEls: 0 }); const ce = document.createElement; document.createElement = function (tag, o) { if (String(tag).toLowerCase() === 'audio') d.audioEls++; return ce.call(this, tag, o); }; });
  const mediaEls = async () => { const p = await poolState(); return { ...p, media: p.created + (await page.evaluate(() => window.__perfD.audioEls)) }; };
  const pd0 = await mediaEls();
  // ---- [playback resources, Phase 1 D] end ----
  await playFor('@ 1 px/frame timeline', 10);
  let p = await poolState();
  // ---- [playback resources, Phase 1 D] begin ----
  // The Program player lends pooled elements per (file, kind, slot) (src/playback/sequencePlayer.ts): 10 s of playback
  // can at most fill the shared pool once (MediaElementPool(16), src/app/media.ts), so more creations than its
  // capacity mean per-clip / per-frame churn (7,471 here before the fix).
  const pd1 = await mediaEls();
  rec('pool', 'media elements (<video> + <audio>) created during 10 s playback @ 1 px/frame', pd1.media - pd0.media, '', '<= 16 (pool capacity)', pd1.media - pd0.media <= 16, `total created ${pd1.media}`);
  // ---- [playback resources, Phase 1 D] end ----
  rec('pool', 'video elements created / live(src) / playing / in DOM after 10 s playback', `${p.created} / ${p.live} / ${p.playing} / ${p.inDom}`, '', 'live <= 16', p.live <= 16);
  rec('audio', 'AudioContexts / gains / mediaElementSources / connects / disconnects', `${p.audio.contexts} / ${p.audio.gains} / ${p.audio.sources} / ${p.audio.connects} / ${p.audio.disconnects}`, '');
  await zoomFit(); await sleep(1500);
  await playFor('@ zoom-to-fit (2500 clips mounted)', 6);
  await setView({ zoom: 1, scroll: 0 }); await sleep(500);
  // Sequence switching x20
  const t0 = await nowPage();
  const sw = await page.evaluate(async ({ big, alts }) => {
    const st = () => window.__recut.store.getState(); const costs = [];
    for (let i = 0; i < 20; i++) { const id = i % 2 ? big : alts[i % alts.length]; const t = performance.now(); st().setActiveSequence(id); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); costs.push(performance.now() - t); await new Promise((r) => setTimeout(r, 250)); }
    st().setActiveSequence(big); return costs;
  }, { big: SEQ, alts: ALT });
  const s = stats(sw); const long = await lt(t0);
  ms('switch', 'switch sequence x20 -> paint (median)', s.median, 100, `max ${s.max}; ${ltSummary(long)}`);
  await sleep(1000);
  p = await poolState();
  rec('pool', 'video elements created / live / playing after 20 sequence switches', `${p.created} / ${p.live} / ${p.playing}`, '', 'live <= 16', p.live <= 16);
  rec('audio', 'gains / sources / connects-disconnects after 20 switches', `${p.audio.gains} / ${p.audio.sources} / ${p.audio.connects - p.audio.disconnects}`, '', 'gains bounded', null, 'SequencePlayer.trackGains is keyed by trackId and never pruned');
  // ---- [playback resources, Phase 1 D] begin ----
  // Since playback (zoom-to-fit playback + 20 switches): new elements only for (file, slot) pairs not yet pooled, at
  // most one pool's worth; one MediaElementAudioSourceNode and one GainNode per new audio element (no per-clip or
  // per-track nodes), so each node count grows by at most the elements created.
  {
    const pd2 = await mediaEls();
    const dEl = pd2.media - pd1.media, dSrc = pd2.audio.sources - pd1.audio.sources, dGain = pd2.audio.gains - pd1.audio.gains;
    rec('pool', 'media elements created by zoom-to-fit playback + 20 sequence switches', dEl, '', '<= 16 (pool capacity)', dEl <= 16);
    rec('audio', 'MediaElementSources / GainNodes created by zoom-to-fit playback + 20 switches', `${dSrc} / ${dGain}`, '', '<= elements created', dSrc <= dEl && dGain <= dEl, `elements created ${dEl}`);
  }
  // ---- [playback resources, Phase 1 D] end ----
  // Maximize / restore the program zone x10
  const t1 = await nowPage();
  for (let i = 0; i < 10; i++) { await page.evaluate(() => document.querySelector('[data-zone="monitor-right"] .zone-tab')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); await sleep(300); await page.evaluate(() => document.querySelector('[data-zone="monitor-right"] .zone-tab')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); await sleep(300); }
  const long1 = await lt(t1);
  p = await poolState();
  rec('pool', 'video elements created / live after 10 maximize/restore cycles', `${p.created} / ${p.live}`, '', 'created stable', null, ltSummary(long1));
  rec('audio', 'gains / sources after 10 maximize/restore cycles', `${p.audio.gains} / ${p.audio.sources}`, '');
  await playFor('after 20 switches + 10 maximize cycles', 5);
  p = await poolState();
  rec('pool', 'video elements live / playing after that playback', `${p.live} / ${p.playing}`, '', 'live <= 16', p.live <= 16);
}

// ================================================================ 5. MAIN PROCESS via IPC
console.log('\n--- main process ---');
{
  const movie = files[0];
  rec('main', 'main process RSS baseline (MB)', await mainMB(), 'MB');
  // thumbnail miss vs hit over IPC
  const miss = await page.evaluate(async (p) => { const out = []; for (let i = 0; i < 8; i++) { const t = performance.now(); await window.recut.thumbnail({ path: p, time: 7 + i * 1.37, width: 96 }); out.push(performance.now() - t); } return out; }, movie);
  const hit = await page.evaluate(async (p) => { const out = []; for (let i = 0; i < 40; i++) { const t = performance.now(); await window.recut.thumbnail({ path: p, time: 7 + (i % 8) * 1.37, width: 96 }); out.push(performance.now() - t); } return out; }, movie);
  ms('main', 'thumbnail MISS via IPC (median of 8)', stats(miss).median, 300, `max ${stats(miss).max}`);
  ms('main', 'thumbnail HIT via IPC (median of 40)', stats(hit).median, 5, `p95 ${stats(hit).p95}`);
  const strip = await page.evaluate(async (p) => { const times = Array.from({ length: 48 }, (_, i) => 1 + i * 1.2); let t = performance.now(); await window.recut.filmstrip({ path: p, times, width: 128 }); const cold = performance.now() - t; t = performance.now(); await window.recut.filmstrip({ path: p, times, width: 128 }); return { cold, warm: performance.now() - t }; }, files[1]);
  ms('main', 'filmstrip 48 frames cold via IPC', strip.cold, 3000); ms('main', 'filmstrip 48 frames warm via IPC', strip.warm, 50);
  // 500 thumbnail requests
  const r0 = await mainMB();
  const t500 = await page.evaluate(async (files) => { const t = performance.now(); const ps = []; for (let i = 0; i < 500; i++) ps.push(window.recut.thumbnail({ path: files[i % files.length], time: 0.5 + (i * 0.113) % 55, width: 96 })); await Promise.allSettled(ps); return performance.now() - t; }, files.slice(0, 3).concat(files.slice(4)));
  ms('main', '500 thumbnail requests (6 files, distinct times) via IPC, all in flight', t500);
  rec('main', 'main RSS after 500 thumbnails (MB, delta)', `${await mainMB()} (+${(await mainMB()) - r0})`, 'MB');
  // 20 proxies of distinct files
  if (!SKIP_HEAVY) {
    const copies = [];
    for (let i = 0; i < 20; i++) { const f = path.join(tmp, `copy-${i}.mp4`); fs.copyFileSync(files[4 + (i % 3)], f); copies.push(f); }
    const ids = await page.evaluate((p) => window.__recut.actions.importMediaFiles(p), copies);
    await page.waitForFunction((ids) => { const m = window.__recut.store.getState().project.media; return ids.every((id) => m[id] && (m[id].probe || m[id].probeError)); }, ids, { timeout: 60_000 });
    const m0 = await mainMB(); const t0 = await nowPage(); const tStart = Date.now();
    await page.evaluate(async (ids) => { for (const id of ids) await window.__recut.actions.startProxy(id); }, ids);
    await page.waitForFunction(async () => { const jobs = await window.recut.listJobs(); return jobs.filter((j) => j.kind === 'proxy').length >= 20 && jobs.filter((j) => j.kind === 'proxy').every((j) => j.status === 'done' || j.status === 'failed' || j.status === 'canceled'); }, null, { timeout: 600_000, polling: 1000 });
    const long = await lt(t0);
    ms('main', '20 proxies (60 s 640x360 each, media lane concurrency 2) wall time', Date.now() - tStart, undefined, ltSummary(long) + ' in renderer (job progress -> store updates)');
    rec('main', 'main RSS after 20 proxies (MB, delta)', `${await mainMB()} (+${(await mainMB()) - m0})`, 'MB');
    const st = await page.evaluate(() => { const m = window.__recut.store.getState().project.media; return Object.values(m).filter((x) => x.proxy.status === 'ready').length; });
    rec('main', 'media with proxy ready', st, '');
  }
  // waveform of the long file
  if (LONG && fs.existsSync(LONG)) {
    const [lid] = await page.evaluate((p) => window.__recut.actions.importMediaFiles(p), [LONG]);
    await page.waitForFunction((id) => { const m = window.__recut.store.getState().project.media[id]; return m && (m.probe || m.probeError); }, lid, { timeout: 60_000 });
    const m0 = await mainMB(); let peak = m0; let ffPeak = 0;
    const poll = setInterval(async () => { try { peak = Math.max(peak, await mainMB()); } catch {} try { const out = execFileSync('bash', ['-c', "for p in $(pgrep -x ffmpeg); do awk '/VmRSS/{print $2}' /proc/$p/status 2>/dev/null; done"]).toString().trim(); for (const l of out.split('\n')) ffPeak = Math.max(ffPeak, Number(l) / 1024 || 0); } catch {} }, 500);
    const w = await page.evaluate(async (p) => { const t = performance.now(); const d = await window.recut.waveform(p); return { ms: performance.now() - t, peaks: d.peaks.length, duration: d.duration }; }, LONG);
    clearInterval(poll);
    ms('main', `waveform of ${r2(w.duration / 60)} min file via IPC (cold)`, w.ms, 60_000, `${w.peaks} peaks`);
    rec('main', 'main RSS before / peak / after waveform (MB)', `${m0} / ${peak} / ${await mainMB()}`, 'MB', 'peak - before <= 200', peak - m0 <= 200, `ffmpeg child peak ${r2(ffPeak)} MB`);
    const w2 = await page.evaluate(async (p) => { const t = performance.now(); await window.recut.waveform(p); return performance.now() - t; }, LONG);
    ms('main', 'waveform cached via IPC', w2, 100);
    // Two scene detects on the 2 h file fill the media lane: does a proxy still start?
    if (!SKIP_HEAVY) {
      await page.evaluate(async (id) => { await window.__recut.actions.startSceneDetect(id); const m = window.__recut.store.getState().project.media[id]; await window.recut.startSceneDetect({ mediaId: id + 'x', path: m.path, threshold: 0.37, duration: m.probe.duration }); }, lid);
      await sleep(1500);
      const t0 = Date.now();
      const copy = path.join(tmp, 'copy-sd.mp4'); fs.copyFileSync(files[5], copy);
      const [pid] = await page.evaluate((p) => window.__recut.actions.importMediaFiles(p), [copy]);
      await page.waitForFunction((id) => { const m = window.__recut.store.getState().project.media[id]; return m && m.probe; }, pid, { timeout: 60_000 });
      await page.evaluate((id) => window.__recut.actions.startProxy(id), pid);
      await sleep(8000);
      const jobs = await page.evaluate(() => window.recut.listJobs());
      const pj = jobs.filter((j) => j.kind === 'proxy').pop(); const sds = jobs.filter((j) => j.kind === 'sceneDetect');
      rec('main', 'proxy status 8 s after queueing behind two 2 h scene detects', pj?.status ?? 'none', '', 'running', pj?.status === 'running', `scene detects: ${sds.map((j) => `${j.status} ${Math.round(j.progress * 100)}%`).join(', ')}`);
      const missDuring = await page.evaluate(async (p) => { const out = []; for (let i = 0; i < 6; i++) { const t = performance.now(); await window.recut.thumbnail({ path: p, time: 30 + i * 1.91, width: 96 }); out.push(performance.now() - t); } return out; }, movie);
      ms('main', 'thumbnail MISS via IPC while 2 scene detects run (median)', stats(missDuring).median, 600, `idle median was ${stats(miss).median}`);
      for (const j of sds) await page.evaluate((id) => window.recut.cancelJob(id), j.id);
      await page.waitForFunction(async () => (await window.recut.listJobs()).filter((j) => j.kind === 'proxy').every((j) => j.status !== 'queued' && j.status !== 'running'), null, { timeout: 180_000, polling: 1000 }).catch(() => {});
      ms('main', 'proxy queued behind scene detects: time until done after cancel', Date.now() - t0);
    }
  }
  // Export: IPC payload + preview command for the 2500-clip sequence
  const exp = await page.evaluate(async ({ id, outDir }) => {
    const st = window.__recut.store.getState();
    const req = { sequence: st.project.sequences[id], media: st.project.media, settings: { outputDir: outDir, fileName: 'perf.mp4', width: 1920, height: 1080, fps: { num: 24, den: 1 }, videoCodec: 'libx264', qualityMode: 'crf', crf: 18, videoBitrateKbps: 8000, preset: 'medium', audioCodec: 'aac', audioBitrateKbps: 320, audioChannels: 2, sampleRate: 48000, rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false } };
    let t = performance.now(); const bytes = JSON.stringify(req).length; const strMs = performance.now() - t;
    t = performance.now(); const args = await window.recut.previewExportCommand(req); const previewMs = performance.now() - t;
    const fc = args.indexOf('-filter_complex');
    return { bytes, strMs, previewMs, argc: args.length, filterLen: fc >= 0 ? args[fc + 1].length : -1, inputs: args.filter((a) => a === '-i').length };
  }, { id: SEQ, outDir: tmp });
  rec('ipc', 'ExportRequest JSON size for 2500 clips + all media (MB)', r2(exp.bytes / 1048576), 'MB');
  ms('ipc', 'previewExportCommand round trip (IPC + buildRenderGraph in main)', exp.previewMs, 500, `${exp.inputs} inputs, filter ${exp.filterLen} chars, argc ${exp.argc}`);
  // Export job of a small real sequence while measuring thumbnail latency + proxy progress
  if (!SKIP_HEAVY) {
    const expo = await page.evaluate(async ({ outDir, movie }) => {
      const st = window.__recut.store.getState();
      const m = Object.values(st.project.media).find((x) => x.path === movie);
      const seq = { id: 'seq_perf_export', name: 'perf export', fps: { num: 24, den: 1 }, width: 1920, height: 1080, sampleRate: 48000, channels: 2, subtitleTracks: [], markers: [], storyBlocks: [], snapshots: [], createdAt: 0, modifiedAt: 0, binId: null, view: { playhead: 0, zoom: 1, scroll: 0, inPoint: null, outPoint: null },
        videoTracks: [{ id: 'v_pe', name: 'V1', kind: 'video', clips: [], transitions: [], muted: false, solo: false, locked: false, height: 64, volume: 1, patched: true }],
        audioTracks: [{ id: 'a_pe', name: 'A1', kind: 'audio', clips: [], transitions: [], muted: false, solo: false, locked: false, height: 48, volume: 1, patched: true }] };
      for (let i = 0; i < 6; i++) { const base = { mediaId: m.id, name: `c${i}`, start: i * 216, duration: 216, sourceIn: i * 9, speed: 1, linkId: null, enabled: true, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, crop: { left: 0, top: 0, right: 0, bottom: 0 } }, audio: { gain: 0, volume: 1, fadeIn: 0, fadeOut: 0, muted: false }, tags: [], characters: [], plotlines: [], locations: [], notes: '' }; seq.videoTracks[0].clips.push({ ...base, id: `pev${i}`, kind: 'video' }); seq.audioTracks[0].clips.push({ ...base, id: `pea${i}`, kind: 'audio', audioStream: m.probe.audio[0]?.index }); }
      const req = { sequence: seq, media: { [m.id]: m }, settings: { outputDir: outDir, fileName: 'perf-real.mp4', width: 1920, height: 1080, fps: { num: 24, den: 1 }, videoCodec: 'libx264', qualityMode: 'crf', crf: 20, videoBitrateKbps: 8000, preset: 'medium', audioCodec: 'aac', audioBitrateKbps: 192, audioChannels: 2, sampleRate: 48000, rangeMode: 'entire', burnSubtitles: false, exportSubtitleSidecar: false, useProxies: false } };
      return window.recut.startExport(req);
    }, { outDir: tmp, movie });
    rec('fairness', 'export job started (54 s sequence, 1080p medium)', String(expo.ok), '', undefined, undefined, expo.ok ? '' : expo.error);
    await sleep(2500);
    const missBusy = await page.evaluate(async (p) => { const out = []; for (let i = 0; i < 6; i++) { const t = performance.now(); await window.recut.thumbnail({ path: p, time: 40 + i * 1.73, width: 96 }); out.push(performance.now() - t); } return out; }, files[2]);
    ms('fairness', 'thumbnail MISS via IPC while export encodes (median)', stats(missBusy).median, 600, `idle median ${stats(miss).median} -> x${r2(stats(missBusy).median / Math.max(1, stats(miss).median), 1)}`);
    const copy2 = path.join(tmp, 'copy-exp.mp4'); fs.copyFileSync(files[6], copy2);
    const [pid2] = await page.evaluate((p) => window.__recut.actions.importMediaFiles(p), [copy2]);
    await page.waitForFunction((id) => { const m = window.__recut.store.getState().project.media[id]; return m && m.probe; }, pid2, { timeout: 60_000 });
    const tp = Date.now();
    await page.evaluate((id) => window.__recut.actions.startProxy(id), pid2);
    await page.waitForFunction((id) => { const m = window.__recut.store.getState().project.media[id]; return m && (m.proxy.status === 'ready' || m.proxy.status === 'failed'); }, pid2, { timeout: 300_000, polling: 500 });
    ms('fairness', 'proxy of a 60 s file while export encodes (queue -> ready)', Date.now() - tp, undefined, 'compare with 20-proxy run: ~wall/10 per proxy idle');
    // Autosave while playing (export still running in the background adds realism; renderer is what we watch)
    await clickTab('timeline'); await setView({ zoom: 1, scroll: 0, playhead: 0 });
    const out = await playFor('while autosave of the big project fires at t=3 s', 7, async () => { setTimeout(() => { page.evaluate(async () => { const st = window.__recut.store; st.setState({ dirty: true }); const t = performance.now(); await window.__recut.actions.autosaveProject(); window.__perfAutosaveMs = performance.now() - t; }).catch(() => {}); }, 3000); });
    const autoMs = await page.evaluate(() => window.__perfAutosaveMs ?? -1);
    ms('fairness', 'autosave round trip while playing', autoMs, 500, `per-second playhead updates: ${out.perSec.join(',')}`);
    if (expo.ok) await page.evaluate((id) => window.recut.cancelExport(id), expo.jobId);
  }
  rec('main', 'main process RSS at end (MB)', await mainMB(), 'MB');
  rec('main', 'renderer working set at end (MB)', await rendererMB(), 'MB');
  rec('main', 'renderer JS heap at end (MB)', await page.evaluate(() => performance.memory ? performance.memory.usedJSHeapSize / 1048576 : -1), 'MB');
}

// ================================================================ 6. MULTI-HOUR SEQUENCE
// Added last (buildLongSequence: 3 h @ 23.976, linked A/V, inserts, music beds, transitions, markers) so every row
// above is measured on the same project as before. New rows only, section 'long'.
console.log('\n--- multi-hour sequence ---');
{
  await clickTab('timeline');
  await page.evaluate((id) => { const st = window.__recut.store.getState(); st.setActiveSequence(id); st.select([], 'clear'); }, SEQ);
  const long = await page.evaluate(() => { const t = performance.now(); const out = window.__perfBuildLong(window.__recut.store, { hours: 3 }); out.totalMs = performance.now() - t; return out; });
  ms('long', 'buildLongSequence in renderer (3 h @ 23.976, not activated)', long.totalMs);
  for (const [k, v] of Object.entries(long.counts)) rec('long', `count ${k}`, v);
  const LSEQ = long.seqId; const ldur = long.counts.durationFrames;
  await sleep(1000);
  // Switch big -> multi-hour, time to first paint at two zoom levels.
  for (const [label, z] of [['zoom-to-fit', null], ['1 px/frame', 1]]) {
    const zoom = z ?? (await tlWidth()) * 0.96 / ldur;
    await page.evaluate(({ big, lid, zoom }) => { const st = window.__recut.store.getState(); st.setView(lid, { zoom, scroll: 0, playhead: 0 }); st.setActiveSequence(big); }, { big: SEQ, lid: LSEQ, zoom });
    await sleep(1500);
    const t0 = await nowPage();
    const t = await paintAfter((id) => window.__recut.store.getState().setActiveSequence(id), LSEQ);
    ms('long', `switch to multi-hour sequence -> first paint @ ${label}`, t, 100);
    const c = await domCounts();
    rec('long', `DOM nodes in tracks content, multi-hour @ ${label}`, c.all, 'nodes', '<= 5000', c.all <= 5000, `${c.clips} clips, ${c.transitions} transitions, page total ${c.page}`);
    await sleep(2500);
    const lg = await lt(t0);
    rec('long', `long tasks in 2.5 s after switch to multi-hour @ ${label}`, lg.length, '', '<= 1', lg.length <= 1, ltSummary(lg));
  }
  // Let thumbnail / filmstrip requests drain before measuring interaction (bounded wait).
  { const tD = Date.now(); let settle = 0; while (Date.now() - tD < 60_000) { if (ffmpegCount() === 0) { if (++settle >= 3) break; } else settle = 0; await sleep(1000); } }
  // Switch x20 between the 2,500-clip and the multi-hour sequence (both at 1 px/frame).
  await page.evaluate(({ big }) => window.__recut.store.getState().setView(big, { zoom: 1, scroll: 0 }), { big: SEQ });
  const t1 = await nowPage();
  const sw = await page.evaluate(async ({ big, lid }) => {
    const st = () => window.__recut.store.getState(); const costs = [];
    for (let i = 0; i < 20; i++) { const id = i % 2 ? lid : big; const t = performance.now(); st().setActiveSequence(id); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); if (i % 2) costs.push(performance.now() - t); await new Promise((r) => setTimeout(r, 250)); }
    return costs;
  }, { big: SEQ, lid: LSEQ });
  const sws = stats(sw);
  ms('long', 'switch to multi-hour x10 -> paint (median)', sws.median, 100, `max ${sws.max}; ${ltSummary(await lt(t1))}`);
  // Scrub (same driver as section 2) on the multi-hour sequence.
  await page.evaluate((id) => window.__recut.store.getState().setActiveSequence(id), LSEQ);
  await page.evaluate(({ id, z }) => window.__recut.store.getState().setView(id, { zoom: z, scroll: 0 }), { id: LSEQ, z: (await tlWidth()) * 0.96 / ldur });
  await sleep(1500);
  await scrub('multi-hour @ zoom-to-fit, no selection', 0, LSEQ, ldur, 'long');
  await page.evaluate((id) => window.__recut.store.getState().setView(id, { zoom: 1, scroll: 0 }), LSEQ);
  await sleep(1500);
  await scrub('multi-hour @ 1 px/frame, no selection', 0, LSEQ, ldur, 'long');
  await scrub('multi-hour @ 1 px/frame, 50 clips selected', 50, LSEQ, ldur, 'long');
  await page.evaluate(() => window.__recut.store.getState().select([], 'clear'));
  // Edit commit -> paint on the multi-hour sequence (same budgets as section 1).
  await page.evaluate((id) => window.__recut.store.getState().setView(id, { zoom: 1, scroll: 0, playhead: 0 }), LSEQ);
  await sleep(500);
  const timedLong = async (label, n, src, threshold) => {
    const costs = await page.evaluate(async ({ id, n, src }) => {
      const f = new Function('st', 'id', 'i', src); const out = [];
      for (let i = 0; i < n; i++) { const t = performance.now(); f(window.__recut.store.getState(), id, i); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); out.push(performance.now() - t); }
      return out;
    }, { id: LSEQ, n, src });
    const s = stats(costs);
    ms('long', `multi-hour ${label} commit -> paint (median)`, s.median, threshold, `p95 ${s.p95} max ${s.max}`);
  };
  const lmedia = built.mediaIds[2];
  await timedLong('insertFromSource insert (ripple)', 5, `st.insertFromSource(id, { mediaId: '${lmedia}', in: 1, out: 3, atFrame: 100 + i * 400, mode: 'insert' })`, 50);
  await timedLong('razor all tracks', 10, 'st.razor(id, 60 + i * 360)', 32);
  await timedLong('moveClips 1 clip overwrite', 10, 'const t = st.project.sequences[id].videoTracks[0]; const c = t.clips[40 + i * 5]; st.moveClips(id, [{ clipId: c.id, toTrackId: t.id, toStart: c.start + 7 }], "overwrite")', 32);
  await timedLong('undo', 10, 'st.undo()', 32);
  // Program playback on the multi-hour sequence (planFrame over ~6,000 clips every rAF).
  await playFor('multi-hour @ 1 px/frame', 6, undefined, LSEQ, 'long');
  // Save / open round trip with the multi-hour sequence in the project.
  const size = await page.evaluate(() => JSON.stringify(window.__recut.store.getState().project).length);
  rec('long', 'project JSON size incl. multi-hour (compact, MB)', r2(size / 1048576), 'MB');
  const savePath = path.join(tmp, 'perf-long.recut');
  const sv = await page.evaluate(async (p) => { const t = performance.now(); const r = await window.__recut.actions.saveProject(p); return { ms: performance.now() - t, ok: r.ok }; }, savePath);
  ms('long', 'saveProject round trip incl. multi-hour', sv.ms, 500, String(sv.ok));
  await ipcStats(true);
  const t2 = await nowPage();
  const op = await page.evaluate(async (p) => { const t = performance.now(); const r = await window.__recut.actions.openProject(p); return { ms: performance.now() - t, ok: r.ok }; }, savePath);
  const lg2 = await lt(t2);
  ms('long', 'openProject round trip incl. multi-hour', op.ms, 1000, `${op.ok}; ${ltSummary(lg2)}`);
  ms('long', 'openProject main-side handler time incl. multi-hour', ((await ipcStats(true)).times['project:load'] || [0])[0], 500);
}

fs.writeFileSync(path.join(OUT, 'electron.json'), JSON.stringify(results, null, 2));
console.log(`\n[perf] ${results.length} measurements -> ${path.join(OUT, 'electron.json')}`);
try { await Promise.race([app.evaluate(({ app }) => app.exit(0)), new Promise((r) => setTimeout(r, 3000))]); } catch {} try { app.process().kill('SIGKILL'); } catch {} // app.close() can hang on the unsaved-changes prompt
process.exit(0);
