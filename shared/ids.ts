let counter = 0;
export function uid(prefix = ''): string {
  counter = (counter + 1) % 1679616;
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 1679616).toString(36).padStart(4, '0');
  const c = counter.toString(36).padStart(4, '0');
  return `${prefix}${t}${r}${c}`;
}
