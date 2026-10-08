/**
 * The main process's side of quitting (bugs/closed/2026-10-08-quit-stuck-after-renderer-dies.md). Pure: Electron is
 * reached only through the deps, so the state machine is unit-tested (tests/unit/quit-flow.test.ts).
 *
 * A quit request asks the renderer first (ev:beforeQuit): it may prompt Save / Don't Save / Cancel. Until it acks,
 * a fallback timer covers a renderer that never got the request (hung or dead before the ack). Once it acked, the
 * renderer owns the quit: it confirms (quit(true)) or stands down (quitCancel), and no timer may quit behind a
 * prompt the user is reading. The renderer can still die or hang after the ack; then:
 *  - renderer process gone (crash, kill, OOM) or window destroyed: nobody is left to answer or to lose work, so the
 *    quit finishes at once (an autosave, if any, is offered on the next launch);
 *  - renderer unresponsive: the user is asked, in main, whether to quit now or wait (never decided for them: a busy
 *    renderer may come back to its prompt); the question is withdrawn when the renderer responds again;
 *  - another quit request: with the renderer alive (its prompt is up) it only brings the window forward; with the
 *    renderer unresponsive it asks again whether to quit now.
 * A request when the renderer is already gone (or there is no window) quits at once.
 */

export interface QuitFlowDeps {
  /** True when a window exists whose renderer can be asked (not destroyed). */
  canAsk(): boolean;
  /** Send ev:beforeQuit to the renderer. */
  ask(): void;
  /** Quit the app for real (app.quit()); `confirmed` is already true when it is called. */
  quit(): void;
  /** Ask the user whether to quit while the renderer does not respond: true = quit now. Closed (false) on `signal`. */
  confirmUnresponsive(signal: AbortSignal): Promise<boolean>;
  /** Bring the window forward (a repeated quit request while the renderer's prompt is up). */
  focus?(): void;
  /** How long the renderer has to ack ev:beforeQuit. */
  fallbackMs: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export type QuitState = 'idle' | 'asked' | 'acked';

export interface QuitFlow {
  /** The quit was confirmed: before-quit / window close must let it through. */
  readonly confirmed: boolean;
  readonly state: QuitState;
  /** A quit request (menu, window close, before-quit, renderer quit(force)). `force` skips the renderer. */
  request(force: boolean): void;
  /** The renderer received ev:beforeQuit and handles it (drops the fallback timer). */
  ack(): void;
  /** The renderer decided to stay open. */
  cancel(): void;
  /** The renderer process is gone (render-process-gone) or the window was destroyed. */
  rendererGone(): void;
  /** A renderer (re)loaded the page: it can be asked again. */
  rendererLoaded(): void;
  /** webContents 'unresponsive' / 'responsive'. */
  rendererUnresponsive(): void;
  rendererResponsive(): void;
}

export function createQuitFlow(deps: QuitFlowDeps): QuitFlow {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let state: QuitState = 'idle';
  let confirmed = false;
  let gone = false;
  let hung = false;
  let timer: unknown = null;
  /** The "not responding" question on screen, if any. */
  let asking: AbortController | null = null;

  const stopTimer = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  const withdrawQuestion = () => { const a = asking; asking = null; a?.abort(); };

  function finish(): void {
    confirmed = true;
    state = 'idle';
    stopTimer();
    withdrawQuestion();
    deps.quit();
  }

  function offerQuitNow(): void {
    if (asking || confirmed) return;
    const a = new AbortController();
    asking = a;
    deps.confirmUnresponsive(a.signal).then((quitNow) => {
      if (asking === a) asking = null;
      if (quitNow && !a.signal.aborted && state !== 'idle' && !confirmed) finish();
    }, () => { if (asking === a) asking = null; });
  }

  function request(force: boolean): void {
    if (force || confirmed || gone || !deps.canAsk()) { finish(); return; }
    if (state === 'asked') return; // the fallback timer runs until the renderer acks
    if (state === 'acked') {
      // The renderer owns the quit (its prompt may be up): never quit behind it while it is alive.
      if (hung) offerQuitNow(); else deps.focus?.();
      return;
    }
    state = 'asked';
    deps.ask();
    timer = setTimer(() => { timer = null; if (state === 'asked') finish(); }, deps.fallbackMs);
  }

  return {
    get confirmed() { return confirmed; },
    get state() { return state; },
    request,
    ack() {
      if (state !== 'asked') return;
      stopTimer();
      state = 'acked';
    },
    cancel() {
      stopTimer();
      withdrawQuestion();
      state = 'idle';
    },
    rendererGone() {
      gone = true;
      hung = false;
      if (state !== 'idle') finish();
    },
    rendererLoaded() {
      gone = false;
      hung = false;
      withdrawQuestion();
      // A new page has no quit handler running: ask it again.
      if (state !== 'idle' && !confirmed) { stopTimer(); state = 'idle'; request(false); }
    },
    rendererUnresponsive() {
      hung = true;
      if (state === 'acked') offerQuitNow();
    },
    rendererResponsive() {
      hung = false;
      withdrawQuestion();
    },
  };
}
