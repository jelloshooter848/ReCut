#!/usr/bin/env node
/**
 * Focused probe: which React components render per playhead step / per scroll step on the 2500-clip sequence,
 * at zoom-to-fit and at 1 px/frame, and how many DOM mutations land in the tracks area per playhead frame.
 *
 *   xvfb-run -a -s "-screen 0 1920x1080x24" node tests/perf/electron-probe.mjs
 */
import { launchAndBuild, makeRecorder, sleep } from './_electron-common.mjs';

const R = makeRecorder();
const H = await launchAndBuild({ tag: 'probe' });
const { page, SEQ } = H;
await H.clickTab('timeline');
const step = async (label, patchSrc) => page.evaluate(async ({ id, patchSrc, label }) => {
  const st = window.__recut.store; const P = window.__perf;
  const target = document.querySelector('.tl-tracks-content') || document.querySelector('.tl-tracks-col');
  let muts = 0; const mo = new MutationObserver((l) => { muts += l.length; }); if (target) mo.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
  P.commits.length = 0; P.hookOn = true; const N = 10; const times = [];
  for (let i = 0; i < N; i++) {
    const v = st.getState().project.sequences[id].view; const t = performance.now();
    st.getState().setView(id, patchSrc === 'playhead' ? { playhead: v.playhead + 1 } : { scroll: v.scroll + 40 / v.zoom });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); times.push(performance.now() - t);
  }
  P.hookOn = false; mo.disconnect();
  const byName = {}; let rendered = 0;
  for (const c of P.commits) { if (c.err) continue; rendered += c.rendered; for (const [k, n] of Object.entries(c.byName || {})) byName[k] = (byName[k] || 0) + n; }
  times.sort((a, b) => a - b);
  return { label, perStep: rendered / N, muts: muts / N, median: times[N >> 1], top: Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `${k}:${Math.round(n / N * 10) / 10}`).join(' ') };
}, { id: SEQ, patchSrc, label });
for (const [zl, fit] of [['zoom-to-fit', true], ['1 px/frame', false]]) {
  if (fit) await H.zoomFit(); else await H.setView({ zoom: 1, scroll: 0 });
  await H.setView({ playhead: 20 }); await sleep(2500);
  for (const [lbl, src] of [['playhead +1', 'playhead'], ['scroll +40px', 'scroll']]) {
    const o = await step(`${lbl} @ ${zl}`, src);
    R.rec('probe', `${o.label}: component renders / DOM mutations in tracks content per step`, `${Math.round(o.perStep)} / ${Math.round(o.muts)}`, '', '', null, `paint median ${Math.round(o.median)} ms; top: ${o.top}`);
  }
}
R.save('electron-probe');
await H.app.close().catch(() => {});
process.exit(0);
