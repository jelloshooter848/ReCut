/**
 * bugs/closed/2026-10-08-quit-stuck-after-renderer-dies.md
 *
 * The main process's quit state machine (electron/quitFlow.ts): once the renderer acked ev:beforeQuit, main has no
 * fallback timer (the renderer may be showing Save / Don't Save / Cancel). A renderer that dies or hangs after the ack
 * must not leave the quit pending for ever, and a live renderer's prompt must never be quit behind.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createQuitFlow, type QuitFlow } from '../../electron/quitFlow';

const FALLBACK = 3000;

interface Harness {
  flow: QuitFlow;
  asked: number;
  quits: number;
  focus: number;
  windowAlive: boolean;
  questions: { signal: AbortSignal; answer: (quitNow: boolean) => void }[];
}

let h: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  const harness = { asked: 0, quits: 0, focus: 0, windowAlive: true, questions: [] } as unknown as Harness;
  harness.flow = createQuitFlow({
    canAsk: () => harness.windowAlive,
    ask: () => { harness.asked++; },
    quit: () => { harness.quits++; },
    focus: () => { harness.focus++; },
    confirmUnresponsive: (signal) => new Promise<boolean>((resolve) => {
      harness.questions.push({ signal, answer: resolve });
      signal.addEventListener('abort', () => resolve(false));
    }),
    fallbackMs: FALLBACK,
  });
  h = harness;
});

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('before the ack (unchanged)', () => {
  it('a request asks the renderer once and arms the fallback; a renderer that never acks is quit after it', async () => {
    h.flow.request(false);
    h.flow.request(false);
    expect(h.asked).toBe(1);
    expect(h.flow.state).toBe('asked');
    await vi.advanceTimersByTimeAsync(FALLBACK - 1);
    expect(h.quits).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.quits).toBe(1);
    expect(h.flow.confirmed).toBe(true);
  });

  it('force, or no window, quits at once without asking', () => {
    h.flow.request(true);
    expect(h.quits).toBe(1);
    expect(h.asked).toBe(0);
    const g = createQuitFlow({ canAsk: () => false, ask: () => { throw new Error('asked'); }, quit: () => { h.quits++; }, confirmUnresponsive: async () => false, fallbackMs: FALLBACK });
    g.request(false);
    expect(h.quits).toBe(2);
  });

  it('the ack drops the fallback: a renderer showing its prompt is never quit by a timer', async () => {
    h.flow.request(false);
    h.flow.ack();
    expect(h.flow.state).toBe('acked');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.quits).toBe(0);
  });

  it('cancel stands down: the next request asks again', () => {
    h.flow.request(false);
    h.flow.ack();
    h.flow.cancel();
    expect(h.flow.state).toBe('idle');
    h.flow.request(false);
    expect(h.asked).toBe(2);
    expect(h.quits).toBe(0);
  });

  it('a renderer quit(true) after the ack quits', () => {
    h.flow.request(false);
    h.flow.ack();
    h.flow.request(true);
    expect(h.quits).toBe(1);
  });
});

describe('the renderer dies or hangs after the ack', () => {
  it('render process gone after the ack: the quit finishes at once', () => {
    h.flow.request(false);
    h.flow.ack();
    h.flow.rendererGone();
    expect(h.quits).toBe(1);
    expect(h.flow.confirmed).toBe(true);
  });

  it('render process gone before the ack: no need to wait for the fallback', () => {
    h.flow.request(false);
    h.flow.rendererGone();
    expect(h.quits).toBe(1);
  });

  it('render process gone while no quit is pending: nothing happens; the next request quits at once (nobody to ask)', () => {
    h.flow.rendererGone();
    expect(h.quits).toBe(0);
    h.flow.request(false);
    expect(h.asked).toBe(0);
    expect(h.quits).toBe(1);
  });

  it('a reloaded renderer is asked again (gone, then loaded)', () => {
    h.flow.rendererGone();
    h.flow.rendererLoaded();
    h.flow.request(false);
    expect(h.asked).toBe(1);
    expect(h.quits).toBe(0);
  });

  it('a page reload while the quit is pending asks the new page (its handler is gone)', async () => {
    h.flow.request(false);
    h.flow.ack();
    h.flow.rendererLoaded();
    expect(h.asked).toBe(2);
    expect(h.flow.state).toBe('asked');
    await vi.advanceTimersByTimeAsync(FALLBACK);
    expect(h.quits).toBe(1); // the new page never acked
  });

  it('the window destroyed while pending (rendererGone): quits', () => {
    h.flow.request(false);
    h.flow.ack();
    h.windowAlive = false;
    h.flow.rendererGone();
    expect(h.quits).toBe(1);
  });

  it('unresponsive after the ack: the user is asked; Quit quits', async () => {
    h.flow.request(false);
    h.flow.ack();
    h.flow.rendererUnresponsive();
    expect(h.questions).toHaveLength(1);
    expect(h.quits).toBe(0);
    h.questions[0].answer(true);
    await flush();
    expect(h.quits).toBe(1);
  });

  it('unresponsive after the ack: Wait keeps waiting; a second quit request asks again', async () => {
    h.flow.request(false);
    h.flow.ack();
    h.flow.rendererUnresponsive();
    h.questions[0].answer(false);
    await flush();
    expect(h.quits).toBe(0);
    expect(h.flow.state).toBe('acked');
    h.flow.request(false);
    expect(h.questions).toHaveLength(2);
    h.questions[1].answer(true);
    await flush();
    expect(h.quits).toBe(1);
  });

  it('the renderer responds again: the question is withdrawn and its answer ignored', async () => {
    h.flow.request(false);
    h.flow.ack();
    h.flow.rendererUnresponsive();
    h.flow.rendererResponsive();
    expect(h.questions[0].signal.aborted).toBe(true);
    h.questions[0].answer(true); // too late
    await flush();
    expect(h.quits).toBe(0);
    // Alive again: a second request does not ask, it brings the window (and the renderer's prompt) forward.
    h.flow.request(false);
    expect(h.questions).toHaveLength(1);
    expect(h.focus).toBe(1);
  });

  it('the renderer confirms (quit(true)) or cancels while the question is up: it is withdrawn', async () => {
    h.flow.request(false);
    h.flow.ack();
    h.flow.rendererUnresponsive();
    h.flow.cancel();
    expect(h.questions[0].signal.aborted).toBe(true);
    await flush();
    expect(h.quits).toBe(0);
    h.flow.request(false);
    h.flow.ack();
    h.flow.rendererUnresponsive();
    h.flow.request(true);
    expect(h.questions[1].signal.aborted).toBe(true);
    expect(h.quits).toBe(1);
  });

  it('only one question at a time', () => {
    h.flow.request(false);
    h.flow.ack();
    h.flow.rendererUnresponsive();
    h.flow.request(false);
    h.flow.request(false);
    expect(h.questions).toHaveLength(1);
  });

  it('unresponsive with no quit pending asks nothing; a request then asks the renderer and arms the fallback', async () => {
    h.flow.rendererUnresponsive();
    expect(h.questions).toHaveLength(0);
    h.flow.request(false);
    expect(h.asked).toBe(1);
    await vi.advanceTimersByTimeAsync(FALLBACK);
    expect(h.quits).toBe(1);
  });
});

describe('a live renderer showing its prompt is never quit behind', () => {
  it('a second quit request while the prompt is up only brings the window forward, however long it waits', async () => {
    h.flow.request(false);
    h.flow.ack();
    for (let i = 0; i < 5; i++) { h.flow.request(false); await vi.advanceTimersByTimeAsync(FALLBACK * 2); }
    expect(h.quits).toBe(0);
    expect(h.asked).toBe(1);
    expect(h.focus).toBe(5);
    expect(h.questions).toHaveLength(0);
  });
});
