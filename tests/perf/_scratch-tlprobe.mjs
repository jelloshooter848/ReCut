import { launchAndBuild, sleep, closeApp } from './_electron-common.mjs';
const H = await launchAndBuild({ tag: 'tlprobe' });
const { page, SEQ } = H;
await H.clickTab('timeline');
await page.evaluate(() => {
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__; const orig = hook.onCommitFiberRoot.bind(hook);
  window.__tl = { on: false, names: {} };
  const seen = new WeakMap();
  const hostOf = (f) => { let c = f; while (c && !(c.stateNode instanceof Element)) c = c.child; return c ? c.stateNode : null; };
  hook.onCommitFiberRoot = (id, root, ...rest) => {
    if (window.__tl.on) {
      const stack = [root.current];
      while (stack.length) { const f = stack.pop(); if (f.child) stack.push(f.child); if (f.sibling) stack.push(f.sibling);
        if (typeof f.type !== 'function' && typeof f.type !== 'object') continue; if (!f.type) continue;
        const ps = seen.get(f); if (ps && ps.p === f.memoizedProps && ps.s === f.memoizedState) continue; seen.set(f, { p: f.memoizedProps, s: f.memoizedState });
        if (!(f.flags & 1)) continue;
        const el = hostOf(f); if (!el || !el.closest || !el.closest('.tl-root')) continue;
        const k = (el.className && typeof el.className === 'string' ? el.className.split(' ').slice(0, 2).join('.') : el.tagName) + (el.dataset && el.dataset.playhead !== undefined ? '[playhead]' : '');
        window.__tl.names[k] = (window.__tl.names[k] || 0) + 1; }
    }
    return orig(id, root, ...rest);
  };
});
for (const [zl, fit] of [['fit', true], ['1px', false]]) {
  if (fit) await H.zoomFit(); else await H.setView({ zoom: 1, scroll: 0 });
  await H.setView({ playhead: 20 }); await sleep(2500);
  const r = await page.evaluate(async (id) => {
    const st = window.__recut.store; window.__tl.names = {}; window.__tl.on = true;
    for (let i = 0; i < 10; i++) { const v = st.getState().project.sequences[id].view; st.getState().setView(id, { playhead: v.playhead + 1 }); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }
    window.__tl.on = false; return window.__tl.names;
  }, SEQ);
  console.log(zl, JSON.stringify(r));
}
await closeApp(H);
