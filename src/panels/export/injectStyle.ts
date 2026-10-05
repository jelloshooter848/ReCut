/** Injects a scoped <style> block once per id (panels own no global stylesheet). */
const injected = new Set<string>();

export function injectStyle(id: string, css: string): void {
  if (typeof document === 'undefined' || injected.has(id)) return;
  injected.add(id);
  if (document.getElementById(id)) return;
  const el = document.createElement('style');
  el.id = id;
  el.textContent = css;
  document.head.appendChild(el);
}
