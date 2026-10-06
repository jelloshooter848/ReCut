/**
 * Shared launcher for the Electron perf scripts: boots the built app under Playwright, installs the
 * instrumentation init script (long tasks, event timing, React DevTools hook with per-panel render
 * attribution, <video>/AudioContext counters), wraps main-process IPC handlers, imports the real test media
 * and builds the LARGE synthetic project in the renderer. Pure measurement plumbing; touches no source.
 */
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCRATCH = process.env.RECUT_PERF_SCRATCH || path.join(os.tmpdir(), 'recut-perf');
export const OUT = process.env.RECUT_PERF_OUT || path.join(ROOT, 'test-results', 'perf');
export const MEDIA_DIR = process.env.RECUT_PERF_MEDIA || path.join(SCRATCH, 'media');
export const LONG = process.env.RECUT_PERF_LONG_FILE || '';
export const r2 = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
export const sleep = (t) => new Promise((r) => setTimeout(r, t));
export const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] ?? 0; return { median: r2(q(0.5)), p95: r2(q(0.95)), max: r2(s[s.length - 1] ?? 0), mean: r2(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)) }; };

export function makeRecorder() {
  const results = [];
  const rec = (section, metric, value, unit = '', threshold, pass, note) => {
    const row = { section, metric, value: typeof value === 'number' ? r2(value) : value, unit, threshold, pass: pass ?? null, note };
    results.push(row);
    console.log(`${section.padEnd(10)} ${metric.padEnd(70).slice(0, 70)} ${String(row.value).padStart(12)} ${unit.padEnd(6)} ${(threshold ?? '').padEnd(14)} ${pass === undefined || pass === null ? '' : pass ? 'PASS' : 'FAIL'} ${note ?? ''}`);
  };
  const ms = (section, metric, v, threshold, note) => rec(section, metric, v, 'ms', threshold !== undefined ? `<= ${threshold} ms` : undefined, threshold !== undefined ? v <= threshold : null, note);
  const save = (name) => { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, `${name}.json`); fs.writeFileSync(f, JSON.stringify(results, null, 2)); console.log(`\n[perf] ${results.length} measurements -> ${f}`); };
  return { results, rec, ms, save };
}

export const INIT_SCRIPT = `
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
  // React DevTools hook: per commit, count component fibers that actually rendered (new fiber object + PerformedWork),
  // attributed to the layout zone panel they live in.
  // A fiber object is reused every other render (double buffering), so remember the props/state it was counted with:
  // it rendered in this commit iff PerformedWork is set and its props or state object changed since we last saw it.
  const seen = new WeakMap();
  const isComp = (f) => f.tag === 0 || f.tag === 1 || f.tag === 11 || f.tag === 14 || f.tag === 15;
  const isClipFiber = (f) => { const c = f.child; return isComp(f) && c && c.tag === 5 && c.stateNode && c.stateNode.dataset && c.stateNode.dataset.clipId !== undefined && c.stateNode.classList.contains('tl-clip'); };
  const labelOf = (el) => { const ch = el.firstElementChild; if (!ch) return 'empty'; return ch.getAttribute('data-testid') || (ch.hasAttribute('data-timeline') ? 'timeline' : (ch.className || '').split(' ').find((c) => c && c !== 'panel' && c !== 'col' && c !== 'grow') || 'unknown'); };
  const walk = (root) => {
    const out = { t: performance.now(), rendered: 0, clipRendered: 0, clipTotal: 0, fibers: 0, byPanel: {} };
    let f = root.current.child; const stack = []; const labels = []; let label = 'shell';
    while (f) {
      out.fibers++;
      const ctx = label;
      const inner = (f.tag === 5 && f.stateNode && f.stateNode.classList && f.stateNode.classList.contains('zone-panel')) ? labelOf(f.stateNode) : ctx;
      if (isComp(f)) {
        const clip = isClipFiber(f); if (clip) out.clipTotal++;
        const prevSeen = seen.get(f); if (!prevSeen || prevSeen.p !== f.memoizedProps || prevSeen.s !== f.memoizedState) { seen.set(f, { p: f.memoizedProps, s: f.memoizedState }); if (f.flags & 1) { out.rendered++; out.byPanel[inner] = (out.byPanel[inner] || 0) + 1; if (clip) out.clipRendered++; const ty = f.type && (f.type.displayName || f.type.name || (f.type.type && (f.type.type.displayName || f.type.type.name)) || (f.type.render && f.type.render.name)) || '?'; out.byName = out.byName || {}; out.byName[ty] = (out.byName[ty] || 0) + 1; } }
      }
      if (f.child) { stack.push(f); labels.push(ctx); label = inner; f = f.child; continue; }
      label = ctx;
      while (f && !f.sibling) { f = stack.pop(); label = labels.pop(); }
      if (f) f = f.sibling;
    }
    return out;
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, isDisabled: false, renderers: new Map(), on() {}, off() {}, emit() {}, sub() { return () => {}; }, checkDCE() {},
    inject() { P.hook = true; return 1; },
    onCommitFiberRoot(id, root) { if (!P.hookOn) return; try { const t = performance.now(); const o = walk(root); o.walkMs = performance.now() - t; P.commits.push(o); } catch (e) { P.commits.push({ err: String(e) }); } },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
  };
})();
`;

export const MEDIA_FILES = ['movies/Galaxy Saga 1 - A New Dawn.mp4', 'movies/Galaxy Saga 2 - Dark Tide.mp4', 'movies/Galaxy Saga 3 - Surround Finale.mp4', 'movies/Galaxy Saga 0 - HEVC Prequel.mp4', 'tv/Season 01/Station Eleven S01E01.mp4', 'tv/Season 01/Station Eleven S01E02.mp4', 'tv/Season 01/Station Eleven S01E03.mp4'];

export async function launchAndBuild({ width = 1900, height = 1050, tag = 'electron' } = {}) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  if (!fs.existsSync(path.join(MEDIA_DIR, 'movies'))) execFileSync('bash', [path.join(ROOT, 'scripts/make-test-media.sh'), MEDIA_DIR, 'full'], { stdio: 'inherit' });
  if (!fs.existsSync(path.join(ROOT, 'dist/renderer/index.html'))) throw new Error('dist/ missing: run npm run build');
  const tmp = fs.mkdtempSync(path.join(SCRATCH, `${tag}-`));
  const userData = path.join(tmp, 'userData'); const cacheDir = path.join(tmp, 'cache');
  fs.mkdirSync(userData, { recursive: true }); fs.mkdirSync(cacheDir, { recursive: true });
  const app = await electron.launch({ args: [path.join(ROOT, 'dist/electron/main.js'), '--no-sandbox'], cwd: ROOT, env: { ...process.env, RECUT_USER_DATA: userData, RECUT_CACHE_DIR: cacheDir, RECUT_DISABLE_GPU: '1' }, timeout: 90_000 });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('[renderer:pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('[renderer:error]', m.text().slice(0, 300)); });
  await page.waitForSelector('#root .layout', { timeout: 60_000 });
  await app.evaluate(({ BrowserWindow }, { width, height }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(width, height); w.center(); }, { width, height });
  await page.evaluate(() => { localStorage.removeItem('recut.layout.v1'); localStorage.removeItem('recut.shortcuts.v1'); });
  await app.context().addInitScript(INIT_SCRIPT);
  await page.reload();
  await page.waitForSelector('#root .layout', { timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.__recut) && Boolean(window.__perf));
  const ipcWrapped = await app.evaluate(({ ipcMain }) => {
    const map = ipcMain._invokeHandlers; if (!(map instanceof Map)) return false;
    const S = (globalThis.__perfIpc = { counts: {}, times: {} });
    for (const ch of ['media:thumbnail', 'media:filmstrip', 'media:waveform', 'project:autosave', 'project:autosaveJson', 'project:save', 'project:load', 'export:previewCommand', 'media:probe']) {
      const h = map.get(ch); if (!h) continue;
      map.set(ch, async (e, ...a) => { S.counts[ch] = (S.counts[ch] || 0) + 1; const t = performance.now(); try { return await h(e, ...a); } finally { (S.times[ch] ||= []).push(performance.now() - t); } });
    }
    return true;
  });
  const files = MEDIA_FILES.map((f) => path.join(MEDIA_DIR, f));
  const ids = await page.evaluate((p) => window.__recut.actions.importMediaFiles(p), files);
  await page.waitForFunction((ids) => { const m = window.__recut.store.getState().project.media; return ids.every((id) => m[id] && (m[id].probe || m[id].probeError)); }, ids, { timeout: 60_000 });
  const builderSrc = fs.readFileSync(path.join(ROOT, 'tests/perf/bigProject.mjs'), 'utf8').replace(/^export /gm, '');
  await page.evaluate(`${builderSrc}\n;window.__perfBuild = buildBigProject; window.__perfBuildLong = buildLongSequence;`);
  const built = await page.evaluate(() => {
    const st = window.__recut.store.getState();
    const base = Object.values(st.project.media).filter((m) => m.probe && m.probe.video).map((m) => ({ name: m.name, path: m.path, probe: m.probe }));
    const t = performance.now(); const out = window.__perfBuild(window.__recut.store, base, {}); out.totalMs = performance.now() - t; return out;
  });
  const SEQ = built.seqId;
  const dur = await page.evaluate((id) => { const s = window.__recut.store.getState().project.sequences[id]; let e = 0; for (const t of [...s.videoTracks, ...s.audioTracks]) for (const c of t.clips) e = Math.max(e, c.start + c.duration); return e; }, SEQ);
  const h = {
    app, page, tmp, userData, cacheDir, files, built, SEQ, ALT: built.altIds, dur, ipcWrapped,
    ipcStats: (reset = true) => app.evaluate(({ }, reset) => { const S = globalThis.__perfIpc; const out = JSON.parse(JSON.stringify(S)); if (reset) { S.counts = {}; S.times = {}; } return out; }, reset),
    metrics: () => app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ type: m.type, pid: m.pid, ws: Math.round(m.memory.workingSetSize / 1024), cpu: m.cpu.percentCPUUsage }))),
    nowPage: () => page.evaluate(() => performance.now()),
    lt: (since) => page.evaluate((since) => window.__perf.lt.filter((e) => e.t >= since), since),
    ltSummary: (list) => `${list.length} long tasks, max ${r2(Math.max(0, ...list.map((e) => e.d)))} ms, total ${r2(list.reduce((a, e) => a + e.d, 0))} ms`,
    tlWidth: () => page.evaluate(() => document.querySelector('.tl-tracks-col')?.clientWidth ?? 0),
    setView: (patch) => page.evaluate(({ id, patch }) => { window.__recut.store.getState().setView(id, patch); }, { id: SEQ, patch }),
    paintAfter: (fn, arg) => page.evaluate(async ({ src, arg }) => { const f = new Function('arg', `return (${src})(arg)`); const t0 = performance.now(); f(arg); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return performance.now() - t0; }, { src: fn.toString(), arg }),
    clickTab: async (panel) => { await page.evaluate((p) => { document.querySelector(`.zone-tab[data-panel="${p}"]`)?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); }, panel); await sleep(300); },
    toggleMaximize: async (zone) => { await page.evaluate((z) => document.querySelector(`[data-zone="${z}"] .zone-tab`)?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), zone); await sleep(600); },
    domCounts: () => page.evaluate(() => ({ all: document.querySelectorAll('.tl-tracks-content *').length, clips: document.querySelectorAll('[data-clip-id]').length, thumbs: document.querySelectorAll('.tl-thumb').length, waves: document.querySelectorAll('canvas.tl-wave').length, page: document.querySelectorAll('*').length })),
  };
  h.mainMB = async () => (await h.metrics()).find((m) => m.type === 'Browser')?.ws ?? -1;
  h.rendererMB = async () => (await h.metrics()).filter((m) => m.type === 'Tab').reduce((a, m) => a + m.ws, 0);
  h.zoomFit = async () => { const w = await h.tlWidth(); const z = Math.max(0.01, (w * 0.96) / Math.max(1, dur)); await h.setView({ zoom: z, scroll: 0 }); return z; };
  return h;
}

/** The app asks before quitting with unsaved changes, so app.close() can hang: kill the process tree instead. */
export async function closeApp(app) {
  try { await Promise.race([app.evaluate(({ app }) => app.exit(0)), sleep(3000)]); } catch { /* ignore */ }
  try { app.process().kill('SIGKILL'); } catch { /* ignore */ }
}
