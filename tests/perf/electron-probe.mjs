#!/usr/bin/env node
/**
 * Focused probe: which React components render per playhead step / per scroll step on the 2500-clip sequence,
 * at zoom-to-fit and at 1 px/frame, and how many DOM mutations land in the tracks area per playhead frame.
 *
 *   xvfb-run -a -s "-screen 0 1920x1080x24" node tests/perf/electron-probe.mjs
 */
import { launchAndBuild, makeRecorder, sleep, closeApp } from './_electron-common.mjs';

const R = makeRecorder();
const H = await launchAndBuild({ tag: 'probe' });
const { page, SEQ } = H;
await H.clickTab('timeline');
// Idle churn: how often does project.media (or the project) change identity with nobody touching the app?
{
  const idle = await page.evaluate(async () => {
    const st = window.__recut.store; let media = 0, project = 0, ui = 0; const fields = {};
    let prev = st.getState();
    const un = st.subscribe((s) => {
      if (s.project !== prev.project) project++;
      if (s.project.media !== prev.project.media) {
        media++;
        for (const id of Object.keys(s.project.media)) { const a = prev.project.media[id], b = s.project.media[id]; if (a !== b && a && b) for (const k of Object.keys(b)) if (a[k] !== b[k]) fields[k] = (fields[k] || 0) + 1; }
      }
      if (s.ui !== prev.ui) ui++;
      prev = s;
    });
    const t0 = performance.now(); const lt0 = window.__perf.lt.length;
    await new Promise((r) => setTimeout(r, 10000)); un();
    const lts = window.__perf.lt.slice(lt0);
    return { media, project, ui, fields, lt: lts.length, ltMs: Math.round(lts.reduce((a, e) => a + e.d, 0)), secs: (performance.now() - t0) / 1000 };
  });
  R.rec('probe', 'idle 10 s after build: project / project.media / ui identity changes', `${idle.project} / ${idle.media} / ${idle.ui}`, '', '== 0', idle.project === 0, `media fields changed: ${JSON.stringify(idle.fields)}; ${idle.lt} long tasks, ${idle.ltMs} ms total`);
  const jobs = await page.evaluate(() => { const j = window.__recut.store.getState().jobs; return j ? Object.values(j).map((x) => `${x.kind}:${x.status}`).reduce((a, k) => { a[k] = (a[k] || 0) + 1; return a; }, {}) : null; });
  R.rec('probe', 'jobs known to the renderer after build', JSON.stringify(jobs));
}
const step = async (label, patchSrc) => page.evaluate(async ({ id, patchSrc, label }) => {
  const st = window.__recut.store; const P = window.__perf;
  const target = document.querySelector('.tl-tracks-content') || document.querySelector('.tl-tracks-col');
  let muts = 0; const mo = new MutationObserver((l) => { muts += l.length; }); if (target) mo.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
  P.commits.length = 0; P.hookOn = true; const N = 10; const times = []; const per = []; const slices = {};
  let prevS = st.getState(); const un = st.subscribe((s2) => { for (const k of Object.keys(s2)) if (s2[k] !== prevS[k]) slices[k] = (slices[k] || 0) + 1; for (const k of Object.keys(s2.ui || {})) if (s2.ui[k] !== prevS.ui[k]) slices['ui.' + k] = (slices['ui.' + k] || 0) + 1; for (const k of Object.keys(s2.project || {})) if (s2.project[k] !== prevS.project[k]) slices['project.' + k] = (slices['project.' + k] || 0) + 1; prevS = s2; });
  for (let i = 0; i < N; i++) { const c0 = P.commits.length;
    const v = st.getState().project.sequences[id].view; const t = performance.now();
    st.getState().setView(id, patchSrc === 'playhead' ? { playhead: v.playhead + 1 } : { scroll: v.scroll + 40 / v.zoom });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); times.push(performance.now() - t);
    per.push(P.commits.slice(c0).reduce((a, c) => a + (c.rendered || 0), 0));
  }
  P.hookOn = false; mo.disconnect(); un();
  const byName = {}; let rendered = 0;
  const byPanel = {}; for (const c of P.commits) { if (c.err) continue; rendered += c.rendered; for (const [k, n] of Object.entries(c.byPanel || {})) byPanel[k] = (byPanel[k] || 0) + n; for (const [k, n] of Object.entries(c.byName || {})) byName[k] = (byName[k] || 0) + n; }
  times.sort((a, b) => a - b);
  return { label, panels: Object.entries(byPanel).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${Math.round(n / N)}`).join(' '), per: per.join(','), slices: JSON.stringify(slices), perStep: rendered / N, muts: muts / N, median: times[N >> 1], top: Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `${k}:${Math.round(n / N * 10) / 10}`).join(' ') };
}, { id: SEQ, patchSrc, label });
for (const [zl, fit] of [['zoom-to-fit', true], ['1 px/frame', false]]) {
  if (fit) await H.zoomFit(); else await H.setView({ zoom: 1, scroll: 0 });
  await H.setView({ playhead: 20 }); await sleep(2500);
  for (const [lbl, src] of [['playhead +1', 'playhead'], ['scroll +40px', 'scroll']]) {
    const o = await step(`${lbl} @ ${zl}`, src);
    R.rec('probe', `${o.label}: component renders / DOM mutations in tracks content per step`, `${Math.round(o.perStep)} / ${Math.round(o.muts)}`, '', '', null, `paint median ${Math.round(o.median)} ms; renders per step [${o.per}]; store slices changed ${o.slices}; by panel/step: ${o.panels}; top: ${o.top}`);
  }
}
R.save('electron-probe');
await closeApp(H.app);
process.exit(0);
