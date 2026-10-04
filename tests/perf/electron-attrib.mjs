#!/usr/bin/env node
/**
 * Attribution run: where does the renderer time go on a playhead step, a horizontal scroll and an edit?
 * Repeats the same micro-scenarios on the 2500-clip sequence under four layouts (default; Program monitor
 * at 1/4 resolution; timeline zone maximized = every other panel unmounted; program zone maximized) and
 * reports per-panel React render counts from the DevTools hook, long tasks and achieved frame rates.
 *
 *   npm run build && xvfb-run -a -s "-screen 0 1920x1080x24" node tests/perf/electron-attrib.mjs
 */
import { launchAndBuild, makeRecorder, sleep, stats, r2 } from './_electron-common.mjs';

const R = makeRecorder();
const H = await launchAndBuild({ tag: 'attrib' });
const { page, SEQ, dur } = H;
R.rec('env', 'React DevTools hook attached', String(await page.evaluate(() => window.__perf.hook)));
R.rec('env', 'timeline viewport width (px)', await H.tlWidth(), 'px');
await H.clickTab('timeline'); await H.setView({ zoom: 1, scroll: 0, playhead: 0 }); await sleep(2000);

const hookRun = async (label, body, arg) => page.evaluate(async ({ src, arg }) => {
  const f = new Function('arg', `return (${src})(arg)`);
  window.__perf.commits.length = 0; window.__perf.hookOn = true;
  const t0 = performance.now(); const r = await f(arg); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const el = performance.now() - t0; window.__perf.hookOn = false;
  const commits = window.__perf.commits.filter((c) => !c.err);
  const byPanel = {}; let rendered = 0, clipRendered = 0, walkMs = 0;
  for (const c of commits) { rendered += c.rendered; clipRendered += c.clipRendered; walkMs += c.walkMs || 0; for (const [k, v] of Object.entries(c.byPanel)) byPanel[k] = (byPanel[k] || 0) + v; }
  return { el, r, commits: commits.length, rendered, clipRendered, walkMs, byPanel, fibers: commits[0]?.fibers ?? 0 };
}, { src: body.toString(), arg });

const fmtPanels = (bp) => Object.entries(bp).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ');

// ---- per-action render attribution (default layout)
{
  const step = await hookRun('playhead +1', (id) => { const st = window.__recut.store.getState(); st.setView(id, { playhead: st.project.sequences[id].view.playhead + 1 }); }, SEQ);
  R.rec('attrib', 'ONE playhead step: React commits / component renders / ClipView renders', `${step.commits} / ${step.rendered} / ${step.clipRendered}`, '', 'renders <= 5', step.rendered <= 5, `by panel: ${fmtPanels(step.byPanel)}; ${step.fibers} fibers, hook walk ${r2(step.walkMs)} ms`);
  const scr = await hookRun('scroll +40px', (id) => { const st = window.__recut.store.getState(); st.setView(id, { scroll: st.project.sequences[id].view.scroll + 40 }); }, SEQ);
  R.rec('attrib', 'ONE horizontal scroll step: commits / renders / ClipView renders', `${scr.commits} / ${scr.rendered} / ${scr.clipRendered}`, '', '', null, `by panel: ${fmtPanels(scr.byPanel)}`);
  const rz = await hookRun('razor', (id) => { window.__recut.store.getState().razor(id, 1234); }, SEQ);
  R.rec('attrib', 'ONE razor commit: commits / renders / ClipView renders', `${rz.commits} / ${rz.rendered} / ${rz.clipRendered}`, '', '', null, `by panel: ${fmtPanels(rz.byPanel)}; paint after ${r2(rz.el)} ms`);
  const sel = await hookRun('select 1 clip', (id) => { const st = window.__recut.store.getState(); st.select([st.project.sequences[id].videoTracks[0].clips[0].id], 'set'); }, SEQ);
  R.rec('attrib', 'ONE clip selection: commits / renders / ClipView renders', `${sel.commits} / ${sel.rendered} / ${sel.clipRendered}`, '', '', null, `by panel: ${fmtPanels(sel.byPanel)}`);
  await page.evaluate(() => window.__recut.store.getState().select([], 'clear'));
  const undo = await hookRun('undo', () => { window.__recut.store.getState().undo(); });
  R.rec('attrib', 'ONE undo: commits / renders / ClipView renders', `${undo.commits} / ${undo.rendered} / ${undo.clipRendered}`, '', '', null, `by panel: ${fmtPanels(undo.byPanel)}; paint after ${r2(undo.el)} ms`);
}

// ---- the same scenarios under four layouts
const scrub = async (label, hook, zoomFit) => {
  if (zoomFit) await H.zoomFit(); else await H.setView({ zoom: 1, scroll: 0 });
  await H.setView({ playhead: 10 }); await sleep(1200);
  const t0 = await H.nowPage();
  const out = await page.evaluate(async ({ id, hook }) => {
    const st = window.__recut.store; window.__perf.commits.length = 0; window.__perf.hookOn = hook;
    let f = 10, frames = 0; const t = performance.now();
    await new Promise((resolve) => { const tick = () => { if (performance.now() - t >= 3000) return resolve(); f += 1; st.getState().setView(id, { playhead: f }); frames++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    const el = performance.now() - t; window.__perf.hookOn = false;
    const commits = window.__perf.commits.filter((c) => !c.err); const byPanel = {}; let rendered = 0, walk = 0;
    for (const c of commits) { rendered += c.rendered; walk += c.walkMs || 0; for (const [k, v] of Object.entries(c.byPanel)) byPanel[k] = (byPanel[k] || 0) + v; }
    return { fps: frames / (el / 1000), frames, rendered, byPanel, walk, commits: commits.length };
  }, { id: SEQ, hook });
  const long = await H.lt(t0);
  R.rec('scrub', `${label}: fps (1 frame/rAF, 3 s)`, r2(out.fps, 1), 'fps', '>= 50', out.fps >= 50, `${H.ltSummary(long)}${hook ? `; renders/frame ${r2(out.rendered / Math.max(1, out.frames), 2)} by panel ${Object.entries(out.byPanel).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${r2(v / Math.max(1, out.frames), 2)}`).join(' ')}; hook walk ${r2(out.walk / Math.max(1, out.commits), 2)} ms/commit` : ''}`);
  return out;
};
const wheel = async (label) => {
  await H.setView({ zoom: 1, scroll: 0, playhead: 0 }); await sleep(1000);
  const t0 = await H.nowPage();
  const out = await page.evaluate(async () => {
    const el = document.querySelector('.tl-tracks-col'); if (!el) return null;
    const costs = []; const t = performance.now();
    for (let i = 0; i < 50; i++) { const a = performance.now(); el.dispatchEvent(new WheelEvent('wheel', { deltaX: 40, deltaY: 0, bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 0)); costs.push(performance.now() - a); await new Promise((r) => requestAnimationFrame(r)); }
    costs.sort((a, b) => a - b); return { median: costs[25], p95: costs[47], fps: 50 / ((performance.now() - t) / 1000) };
  });
  if (!out) { R.rec('scroll', `${label}: wheel`, 'timeline not mounted'); return; }
  const long = await H.lt(t0);
  R.ms('scroll', `${label}: wheel x50 event -> render (median)`, out.median, 8, `p95 ${r2(out.p95)}, ${r2(out.fps, 1)} fps, ${H.ltSummary(long)}`);
};
const edits = async (label) => {
  const timed = async (name, n, src, threshold) => {
    const costs = await page.evaluate(async ({ id, n, src }) => { const f = new Function('st', 'id', 'i', src); const out = []; for (let i = 0; i < n; i++) { const t = performance.now(); f(window.__recut.store.getState(), id, i); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); out.push(performance.now() - t); } return out; }, { id: SEQ, n, src });
    R.ms('edit', `${label}: ${name} commit -> paint (median)`, stats(costs).median, threshold, `max ${stats(costs).max}`);
  };
  await H.setView({ zoom: 1, scroll: 0 }); await sleep(500);
  await timed('razor', 5, 'st.razor(id, 60 + i * 360 + Math.floor(Math.random() * 20))', 32);
  await timed('moveClips', 5, 'const t = st.project.sequences[id].videoTracks[0]; const c = t.clips[40 + i * 5]; st.moveClips(id, [{ clipId: c.id, toTrackId: t.id, toStart: c.start + 7 }], "overwrite")', 32);
  await timed('undo', 5, 'st.undo()', 32);
  await timed('setClipEnabled (tiny)', 5, 'const c = st.project.sequences[id].videoTracks[1].clips[i]; st.setClipEnabled(id, c.id, i % 2 === 0)', 32);
};

const layouts = [
  { name: 'default layout', setup: async () => {}, teardown: async () => {} },
  { name: 'default + playbackResolution 1/4', setup: async () => page.evaluate(() => window.__recut.store.getState().setSettings({ playbackResolution: '1/4' })), teardown: async () => page.evaluate(() => window.__recut.store.getState().setSettings({ playbackResolution: 'full' })) },
  { name: 'timeline zone maximized (other panels unmounted)', setup: async () => H.toggleMaximize('center-bottom'), teardown: async () => H.toggleMaximize('center-bottom') },
  { name: 'program zone maximized (timeline unmounted)', setup: async () => H.toggleMaximize('monitor-right'), teardown: async () => H.toggleMaximize('monitor-right') },
];
for (const L of layouts) {
  console.log(`\n--- ${L.name} ---`);
  await L.setup(); await sleep(1500);
  R.rec('layout', `${L.name}: mounted panels (zone-panel count) / DOM nodes`, `${await page.evaluate(() => document.querySelectorAll('.zone-panel').length)} / ${await page.evaluate(() => document.querySelectorAll('*').length)}`, '');
  const tlMounted = await page.evaluate(() => !!document.querySelector('.tl-tracks-col'));
  await scrub(`${L.name} @ 1 px/frame`, true, false);
  if (L.name === 'default layout') await scrub(`${L.name} @ 1 px/frame, hook OFF (instrumentation overhead check)`, false, false);
  if (tlMounted) { await scrub(`${L.name} @ zoom-to-fit (2500 clips mounted)`, true, true); await wheel(L.name); await edits(L.name); }
  else await edits(L.name);
  await L.teardown(); await sleep(1000);
}
R.rec('mem', 'renderer working set at end (MB) / JS heap (MB)', `${await H.rendererMB()} / ${r2(await page.evaluate(() => performance.memory ? performance.memory.usedJSHeapSize / 1048576 : -1))}`, 'MB');
R.save('electron-attrib');
await H.app.close().catch(() => {});
process.exit(0);
