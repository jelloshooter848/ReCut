/**
 * The autosave pause gate (src/app/autosaveGate.ts): an autosave is one long task (whole-project JSON.stringify + IPC
 * send), so it waits for a pause in the user's work; a long busy stretch makes it settle for a short pause, and it
 * never waits longer than maxDeferMs.
 */
import { describe, it, expect } from 'vitest';
import { createAutosaveGate } from '../../src/app/autosaveGate';

const OPTS = { quietMs: 2000, shortQuietMs: 250, patienceMs: 15_000, maxDeferMs: 60_000 };
const make = (o: Partial<typeof OPTS> = {}) => {
  let t = 1000;
  const gate = createAutosaveGate({ ...OPTS, ...o, now: () => t });
  return { gate, advance: (ms: number) => { t += ms; } };
};
/** Activity every `step` ms for `ms`; returns whether the gate allowed the save at any ask in between. */
const busy = (g: ReturnType<typeof make>, ms: number, step = 16) => {
  let allowed = false;
  for (let e = 0; e < ms; e += step) { g.gate.activity(); g.advance(step); if (g.gate.waitMs() === 0) allowed = true; }
  return allowed;
};

describe('autosave pause gate', () => {
  it('runs at once when the user is idle', () => {
    expect(make().gate.waitMs()).toBe(0);
  });

  it('waits until quietMs after the last activity', () => {
    const { gate, advance } = make();
    gate.activity();
    advance(400);
    expect(gate.waitMs()).toBe(1600);
    advance(1600);
    expect(gate.waitMs()).toBe(0);
  });

  it('never runs during a scrub (activity every frame) shorter than the patience', () => {
    const g = make();
    expect(busy(g, 10_000)).toBe(false);
    g.advance(300);
    expect(g.gate.waitMs()).toBeGreaterThan(0); // a 300 ms pause is not enough yet
    g.advance(1700);
    expect(g.gate.waitMs()).toBe(0); // a 2 s pause is
  });

  it('after the patience, a short pause between strokes is enough (but not mid-stroke)', () => {
    const g = make();
    expect(busy(g, 20_000)).toBe(false);
    g.advance(100); // the last activity was 16 ms before the end of busy()
    expect(g.gate.waitMs()).toBe(250 - 116);
    g.advance(134);
    expect(g.gate.waitMs()).toBe(0);
  });

  it('runs anyway after maxDeferMs of continuous activity, then defers the next save afresh', () => {
    const g = make({ maxDeferMs: 30_000 });
    expect(busy(g, 29_000)).toBe(false);
    expect(busy(g, 2000)).toBe(true);
    g.gate.activity();
    expect(g.gate.waitMs()).toBe(2000);
  });

  it('asks again when patience changes the answer', () => {
    const g = make({ patienceMs: 1000 });
    g.gate.activity();
    expect(g.gate.waitMs()).toBe(1000); // quiet would need 2000, but at 1000 the short pause applies
    g.advance(1000);
    expect(g.gate.waitMs()).toBe(0); // 1 s quiet >= shortQuietMs
  });

  it('reset() drops the deferral', () => {
    const g = make();
    expect(busy(g, 20_000)).toBe(false);
    g.gate.reset();
    g.gate.activity();
    g.advance(300);
    expect(g.gate.waitMs()).toBe(1700); // back to the full quiet requirement
  });
});
